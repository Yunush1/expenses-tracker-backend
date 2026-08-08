const LedgerEntry = require("../models/ledgerEntry");
const User = require("../models/user");
const Member = require("../models/member");
const Group = require("../models/group");
const Expense = require("../models/expense");
const ledgerService = require("./ledgerService");
const pointsService = require("./pointsService");
const config = require("../config/env");
const { inferCategory } = require("../utils/inferCategory");
const { LEDGER_ENTRY_TYPES } = require("../constants");
const logger = require("../utils/logger");

/**
 * Group expenses, reflected into the payer's personal ledger
 * (docs/08-PERSONAL-LEDGER.md §12).
 *
 * ## What gets written, and why it is not the amount on the expense
 *
 * The mirrored figure is the person's **own share**, never the total they paid.
 * Pay ₹1,000 for a dinner split four ways and ₹250 is what you spent; the other
 * ₹750 is money owed back to you, which the group balance sheet already tracks.
 * Writing ₹1,000 into a personal spending record would make "what did I spend
 * this month" depend on whose turn it was to hold the card.
 *
 * Someone who paid but is not a participant — covering a bill they had no part
 * in — has spent nothing, and gets no row.
 *
 * ## Why the two ledgers still do not merge
 *
 * Doc 08 §2 keeps personal and group money apart, and that still holds: nothing
 * here touches a group balance, and a mirrored row can never affect what anyone
 * owes. This is a *copy for reporting*, marked as such, flowing one way only.
 * The `source` field is what keeps a total that spans both from counting the same
 * rupee twice.
 *
 * ## Silent, by design
 *
 * Nothing here records an activity or sends a notification, and that is a
 * requirement rather than an omission. The group expense has **already** notified
 * everyone who needs to know; a second alert telling you about a row created by
 * your own action, in your own private ledger, is pure noise — and notification
 * noise is not free. Push permission is revoked at the browser, for the whole
 * origin, so the alert nobody wanted costs the ones they did want too
 * (docs/07-NOTIFICATIONS.md §9).
 *
 * Concretely: this writes through the model rather than `ledgerService.createEntry`
 * and never touches `activityService`, so there is no path from here to
 * `pushService`. Keep it that way.
 *
 * ## Everything here is best effort
 *
 * A failure to mirror must never fail the expense. Groups work without accounts;
 * this is a convenience for the subset of people who have one, and it cannot be
 * allowed to make adding an expense less reliable for everyone else.
 */

const isEnabled = () => config.ledger.mirrorGroupExpenses;

/** This member's own share of an expense, in minor units. Zero if not a participant. */
const shareOf = (expense, memberId) => {
  const share = (expense.shares || []).find(
    (entry) => String(entry.memberId) === String(memberId)
  );
  return share?.amountMinor || 0;
};

/**
 * Mirror one expense into the actor's ledger.
 *
 * Scoped to the person who **created** the expense, not to every participant.
 * Writing into other people's private ledgers because they appeared in a split
 * somebody else typed is a surprising amount of reach for a convenience feature —
 * and there is no way for them to have consented to it. The person adding the
 * expense is at least acting.
 */
const mirrorExpense = async ({ group, actor, expense }) => {
  try {
    if (!isEnabled()) return null;

    const userId = await resolveOwner(actor);
    if (!userId) return null; // Not signed in here, or ambiguous — see below.

    const ledger = await ledgerService.getOrCreate(userId);
    return await writeMirror({ ledgerId: ledger._id, group, expense, memberId: actor._id });
  } catch (err) {
    logger.warn(`[ledger] Could not mirror a group expense: ${err.message}`);
    return null;
  }
};

/**
 * Which account owns this member's activity — and **null when that is not a
 * single answer**.
 *
 * A `deviceId` names a browser, and browsers get shared. If two accounts have
 * signed in here, "whose expense is this?" has no safe answer: the group route
 * carries no token, so nothing proves which of them is at the keyboard right now.
 * Guessing writes one person's spending into another person's private ledger,
 * with no notification and no way for them to discover it — the same leak that
 * `authService.linkDevice` refuses to allow for group memberships, for the same
 * reason (docs/09-AUTH.md §1).
 *
 * So ambiguity means no mirror. The cost is real and worth naming: one person
 * with two Google accounts on one browser gets nothing, and there is no way to
 * tell them apart from two flatmates sharing a laptop. The backfill offers an
 * explicit override for exactly that case, because an operator can know what the
 * server cannot.
 */
const resolveOwner = async (member) => {
  const deviceIds = (member?.deviceIds || []).filter(Boolean);
  if (member?.deviceId) deviceIds.push(member.deviceId);
  if (deviceIds.length === 0) return null;

  // Two is enough to know it is ambiguous; no need to count the rest.
  const claimants = await User.find({ deviceIds: { $in: deviceIds } })
    .select("_id")
    .limit(2)
    .lean();

  if (claimants.length !== 1) {
    if (claimants.length > 1) {
      logger.warn("[ledger] Skipped a mirror: this browser is shared by more than one account");
    }
    return null;
  }

  return claimants[0]._id;
};

/**
 * The write itself, shared by the live hook and the backfill.
 *
 * Deliberately not behind the feature flag: an operator running the backfill has
 * asked for these rows explicitly, and the flag governs whether new expenses
 * mirror automatically — a different question.
 */
const writeMirror = async ({ ledgerId, group, expense, memberId }) => {
  try {
    const amountMinor = shareOf(expense, memberId);
    if (amountMinor <= 0) return null; // Paid for others, consumed nothing.

    /**
     * Written through the model rather than `ledgerService.createEntry`, on
     * purpose: that path awards points, and the group expense that triggered this
     * has already awarded its own `ACTIVE_DAY`. Going through it would pay twice
     * for one action — the exact thing docs/11-REWARDS.md §2 exists to prevent.
     */
    return await LedgerEntry.create({
      ledgerId,
      type: LEDGER_ENTRY_TYPES.SPEND,
      amountMinor,
      currencyCode: expense.currencyCode || group.currency,
      description: expense.description,
      /**
       * Inferred from the description, because nothing populates `category` on a
       * group expense. Without it every mirrored row would land uncategorised and
       * "what did I spend on food this month" would answer only for the entries
       * someone typed by hand — which is a wrong number, not a partial one.
       */
      category: inferCategory(expense.description, expense.category),
      occurredAt: expense.expenseDate || new Date(),
      source: "GROUP_EXPENSE",
      sourceExpenseId: expense._id,
      sourceGroupId: group._id,
      sourceGroupName: group.name,
      sourceMemberId: memberId,
      version: 0,
    });
  } catch (err) {
    // A duplicate key means it is already mirrored — a retried submit, or a
    // backfill run twice. Both are the uniqueness guarantee working.
    if (err?.code !== 11000) {
      logger.warn(`[ledger] Could not write a mirror: ${err.message}`);
    }
    return null;
  }
};

/**
 * Keep a mirror in step with an edited expense.
 *
 * The share can change without the amount changing at all — adding a participant
 * to a ₹1,000 bill moves one person's share from ₹333 to ₹250 — so this always
 * recomputes rather than comparing totals.
 *
 * A share that has fallen to zero (removed from the split) soft-deletes the row
 * instead of leaving a ₹0 entry behind.
 */
const syncMirror = async (expense) => {
  try {
    if (!isEnabled()) return null;

    // Several people could each hold a mirror of the same expense, so this is a
    // list — one per ledger, each recomputed against its own member.
    const mirrors = await LedgerEntry.find({
      sourceExpenseId: expense._id,
      isDeleted: false,
    });

    for (const mirror of mirrors) {
      const amountMinor = shareOf(expense, mirror.sourceMemberId);

      /**
       * Removed from the split entirely. Soft-deleted rather than left as a ₹0
       * row, which would read as "I spent nothing on this" instead of "this is no
       * longer mine".
       */
      if (amountMinor <= 0) {
        mirror.isDeleted = true;
        mirror.deletedAt = new Date();
        await mirror.save();
        continue;
      }

      mirror.amountMinor = amountMinor;
      mirror.description = expense.description;
      // Re-inferred, because the description is what it was inferred from — an
      // edit from "Auto" to "Dinner" should not leave the row filed under travel.
      mirror.category = inferCategory(expense.description, expense.category);
      mirror.occurredAt = expense.expenseDate || mirror.occurredAt;
      mirror.version += 1;
      await mirror.save();
    }

    return mirrors.length;
  } catch (err) {
    logger.warn(`[ledger] Could not sync a mirrored expense: ${err.message}`);
    return null;
  }
};

/**
 * Remove the mirror when the group expense is deleted.
 *
 * Soft, like every other deletion here, so the row stays auditable — and so a
 * personal ledger never silently loses history because somebody else tidied up a
 * group.
 */
const removeMirror = async (expenseId) => {
  try {
    if (!isEnabled()) return null;

    return await LedgerEntry.updateMany(
      { sourceExpenseId: expenseId, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
  } catch (err) {
    logger.warn(`[ledger] Could not remove a mirrored expense: ${err.message}`);
    return null;
  }
};

/**
 * Mirror the group expenses an account already had, before this existed.
 *
 * ## Why this is a script and not a sign-in hook
 *
 * The tempting version runs on first sign-in, so history "just appears". It is
 * the wrong shape: it writes an unbounded amount of data into someone's private
 * ledger as a side effect of logging in, on the latency path of the request that
 * does it, with no way to preview or undo. A one-off backfill an operator runs
 * deliberately — with a dry run first — is the honest version of the same thing.
 *
 * ## What it selects
 *
 * The same rule the live hook uses (§12): expenses this person **created**, in
 * groups where one of their devices is a member. Not every expense they merely
 * appear in — see `mirrorExpense` for why that reach is not taken.
 *
 * Idempotent. The unique index on `{ ledgerId, sourceExpenseId }` means running
 * it twice writes nothing the second time, so it is safe to re-run after a
 * partial failure.
 */
const backfillForUser = async (user, { since = null, dryRun = false, allowShared = false } = {}) => {
  const result = {
    email: user.email || String(user._id),
    examined: 0,
    written: 0,
    skipped: 0,
    ambiguous: 0,
  };

  let deviceIds = (user.deviceIds || []).filter(Boolean);
  if (deviceIds.length === 0) return result;

  /**
   * Drop browsers another account has also signed in on.
   *
   * Without this the backfill hands the *same* expense to every account that has
   * touched the machine — which is how a flatmate ends up with a copy of your
   * spending. `allowShared` exists for the one case a human can resolve and the
   * server cannot: the same person with two accounts.
   */
  if (!allowShared) {
    const shared = await User.find({
      _id: { $ne: user._id },
      deviceIds: { $in: deviceIds },
    })
      .select("deviceIds")
      .lean();

    if (shared.length > 0) {
      const contested = new Set(shared.flatMap((other) => other.deviceIds || []));
      const before = deviceIds.length;
      deviceIds = deviceIds.filter((id) => !contested.has(id));
      result.ambiguous = before - deviceIds.length;
    }
  }

  if (deviceIds.length === 0) return result;

  // Which member rows this account's browsers correspond to, across all groups.
  const members = await Member.find({ deviceIds: { $in: deviceIds } })
    .select("_id groupId")
    .lean();
  if (members.length === 0) return result;

  const memberIds = members.map((member) => member._id);
  const groupIds = [...new Set(members.map((member) => String(member.groupId)))];

  const query = {
    createdByMemberId: { $in: memberIds },
    isDeleted: { $ne: true },
  };
  if (since) query.expenseDate = { $gte: since };

  const expenses = await Expense.find(query).lean();
  if (expenses.length === 0) return result;

  const groups = await Group.find({ _id: { $in: groupIds } })
    .select("_id name currency")
    .lean();
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const memberByGroup = new Map(members.map((member) => [String(member.groupId), member._id]));

  // Everything already mirrored, fetched once rather than probed per expense.
  const ledger = await ledgerService.getOrCreate(user._id);
  const existing = await LedgerEntry.find({
    ledgerId: ledger._id,
    sourceExpenseId: { $in: expenses.map((expense) => expense._id) },
  })
    .select("sourceExpenseId")
    .lean();
  const alreadyMirrored = new Set(existing.map((row) => String(row.sourceExpenseId)));

  for (const expense of expenses) {
    result.examined += 1;

    if (alreadyMirrored.has(String(expense._id))) {
      result.skipped += 1;
      continue;
    }

    const group = groupById.get(String(expense.groupId));
    const memberId = memberByGroup.get(String(expense.groupId));
    if (!group || !memberId) {
      result.skipped += 1;
      continue;
    }

    // No share means they paid for other people and consumed nothing.
    if (shareOf(expense, memberId) <= 0) {
      result.skipped += 1;
      continue;
    }

    if (dryRun) {
      result.written += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- ordered, and small by nature
    const written = await writeMirror({ ledgerId: ledger._id, group, expense, memberId });
    if (written) result.written += 1;
    else result.skipped += 1;
  }

  return result;
};

/**
 * One member's past expenses into one account's ledger, on linking.
 *
 * ## Why this is allowed to run on a request when `backfillForUser` is not
 *
 * The note above `backfillForUser` argues against a sign-in hook, and that
 * argument still stands — every word of it is about a backfill that fires *as a
 * side effect of logging in*, over an unbounded set of groups, with nothing
 * asked and nothing shown. This is a different thing on all three counts:
 *
 *  - **Asked for.** It runs only when someone confirms "yes, that member is me"
 *    (docs/17-MEMBER-IDENTITY.md §6). Signing in alone still does nothing.
 *  - **Bounded.** One member, in one group, capped at `MAX` rows. Not "every
 *    group any browser of mine has ever touched".
 *  - **Unambiguous.** `member.userId` was set by the person themselves, so there
 *    is no device heuristic to get wrong — which is the entire reason
 *    `backfillForUser` needs `allowShared` and this does not.
 *
 * It is still kept off the response path by its caller, because the linking
 * request should not wait on it.
 *
 * Idempotent, by the unique index on `{ ledgerId, sourceExpenseId }` — relinking
 * the same member writes nothing the second time.
 */
const MAX_BACKFILL_ROWS = 500;

const backfillForMember = async (member, userId) => {
  const result = { examined: 0, written: 0, skipped: 0, capped: false };

  if (!isEnabled()) return result;

  const group = await Group.findById(member.groupId).select("_id name currency").lean();
  if (!group) return result;

  const expenses = await Expense.find({
    groupId: member.groupId,
    createdByMemberId: member._id,
    isDeleted: { $ne: true },
  })
    .sort({ expenseDate: -1 })
    // One over the cap, so a full page can be told from an exactly-full one.
    .limit(MAX_BACKFILL_ROWS + 1)
    .lean();

  if (expenses.length > MAX_BACKFILL_ROWS) {
    result.capped = true;
    expenses.length = MAX_BACKFILL_ROWS;
  }
  if (expenses.length === 0) return result;

  const ledger = await ledgerService.getOrCreate(userId);
  const existing = await LedgerEntry.find({
    ledgerId: ledger._id,
    sourceExpenseId: { $in: expenses.map((expense) => expense._id) },
  })
    .select("sourceExpenseId")
    .lean();
  const alreadyMirrored = new Set(existing.map((row) => String(row.sourceExpenseId)));

  for (const expense of expenses) {
    result.examined += 1;

    // Already there, or they paid for others and consumed nothing themselves.
    if (alreadyMirrored.has(String(expense._id)) || shareOf(expense, member._id) <= 0) {
      result.skipped += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- ordered, and bounded by MAX
    const written = await writeMirror({
      ledgerId: ledger._id,
      group,
      expense,
      memberId: member._id,
    });
    if (written) result.written += 1;
    else result.skipped += 1;
  }

  return result;
};

/** Every account that has ever signed in on a browser. */
const backfillAll = async ({ since = null, dryRun = false, allowShared = false } = {}) => {
  const users = await User.find({ "deviceIds.0": { $exists: true } })
    .select("_id email deviceIds")
    .lean();

  const results = [];
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose: this is
    // a maintenance job, and it should not compete with live traffic for the pool
    results.push(await backfillForUser(user, { since, dryRun, allowShared }));
  }

  return results;
};

/**
 * Remove mirrors that cannot be attributed to a single account.
 *
 * The repair for a backfill run before the shared-browser rule existed: it finds
 * expenses sitting in more than one ledger and clears them, rather than guessing
 * which copy is the real one. Hard-deleted rather than soft: these rows should
 * never have existed, so leaving tombstones of somebody else's spending in a
 * private ledger would preserve exactly what is being removed.
 */
const removeAmbiguousMirrors = async ({ dryRun = false } = {}) => {
  const duplicated = await LedgerEntry.aggregate([
    { $match: { source: "GROUP_EXPENSE" } },
    { $group: { _id: "$sourceExpenseId", ledgers: { $addToSet: "$ledgerId" } } },
    { $match: { "ledgers.1": { $exists: true } } },
  ]);

  const expenseIds = duplicated.map((row) => row._id);
  if (expenseIds.length === 0) return { expenses: 0, rows: 0 };

  const rows = await LedgerEntry.countDocuments({
    source: "GROUP_EXPENSE",
    sourceExpenseId: { $in: expenseIds },
  });

  if (!dryRun) {
    await LedgerEntry.deleteMany({
      source: "GROUP_EXPENSE",
      sourceExpenseId: { $in: expenseIds },
    });
  }

  return { expenses: expenseIds.length, rows };
};

/**
 * Fill in categories on mirrors written before inference existed.
 *
 * Only touches rows with no category, so it cannot overwrite a label someone set
 * by hand — and re-running it is a no-op once every row has one.
 */
const recategoriseMirrors = async ({ dryRun = false } = {}) => {
  const rows = await LedgerEntry.find({
    source: "GROUP_EXPENSE",
    isDeleted: false,
    $or: [{ category: "" }, { category: null }, { category: { $exists: false } }],
  })
    .select("_id description")
    .lean();

  let updated = 0;

  for (const row of rows) {
    const category = inferCategory(row.description);
    if (!category) continue; // Nothing recognisable; leave it blank rather than guess OTHER.

    updated += 1;
    // eslint-disable-next-line no-await-in-loop -- a one-off repair, small by nature
    if (!dryRun) await LedgerEntry.updateOne({ _id: row._id }, { $set: { category } });
  }

  return { examined: rows.length, updated };
};

module.exports = {
  mirrorExpense,
  syncMirror,
  removeMirror,
  recategoriseMirrors,
  backfillForUser,
  backfillForMember,
  backfillAll,
  removeAmbiguousMirrors,
  resolveOwner,
  isEnabled,
  shareOf,
};
