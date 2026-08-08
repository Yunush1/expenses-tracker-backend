const ledgerRepository = require("../repositories/ledgerRepository");
const memberRepository = require("../repositories/memberRepository");
const groupRepository = require("../repositories/groupRepository");
const Member = require("../models/member");
const LedgerEntry = require("../models/ledgerEntry");
const pointsService = require("./pointsService");
const { toMinor, assertMinor, formatMinor } = require("../utils/money");
const { buildPage, decodeCursor } = require("../utils/cursor");
const { NotFoundError, BadRequestError, ConflictError } = require("../errors");
const {
  LEDGER_ENTRY_TYPES,
  LEDGER_CLAIM_STATUS,
  ERROR_CODES,
  LIMITS,
  DEFAULT_CURRENCY,
  POINT_EVENT_TYPES,
} = require("../constants");

/**
 * The personal ledger (docs/08-PERSONAL-LEDGER.md).
 *
 * Two rules govern everything here, and both are inherited rather than invented:
 *
 *  1. **Money is integer minor units, end to end** (docs/05-ALGORITHMS.md §1).
 *     Nothing in this file performs float arithmetic on an amount.
 *  2. **Outstanding is derived, never stored.** A stored total is a total that
 *     can drift from the rows beneath it, and a reconciliation bug in a ledger
 *     about money is indefensible. It is recomputed on every read, exactly as
 *     group balances are.
 */

const DEBT_TYPES = new Set([LEDGER_ENTRY_TYPES.LENT, LEDGER_ENTRY_TYPES.BORROWED]);

/** `principal − Σ repayments`. The only definition of what is still owed. */
const outstandingOf = (entry) => {
  if (entry.type === LEDGER_ENTRY_TYPES.SPEND) return 0;
  const repaid = (entry.repayments || []).reduce((sum, r) => sum + r.amountMinor, 0);
  return entry.amountMinor - repaid;
};

const toEntryDTO = (entry) => ({
  id: String(entry._id),
  type: entry.type,
  amountMinor: entry.amountMinor,
  outstandingMinor: outstandingOf(entry),
  currencyCode: entry.currencyCode,
  description: entry.description,
  counterpartyName: entry.counterpartyName,
  category: entry.category || null,
  occurredAt: entry.occurredAt,
  dueAt: entry.dueAt,
  settledAt: entry.settledAt,
  notes: entry.notes,
  version: entry.version,
  /**
   * Where the row came from. A mirrored group expense is not fully the owner's to
   * edit — it follows the group — and a personal ledger that grows rows nobody
   * typed, with no indication why, is a bug report waiting to happen.
   */
  source: entry.source || "MANUAL",
  fromGroup: entry.sourceGroupName || null,
  counterpartyMemberId: entry.counterpartyMemberId ? String(entry.counterpartyMemberId) : null,
  /**
   * What the other side did with it — null when no claim was ever made, which is
   * every entry naming someone who has no account. Never `toUserId`: the owner
   * has no business learning another person's account id from their own ledger.
   */
  claimStatus: entry.claim?.status || null,
  groupId: entry.sourceGroupId ? String(entry.sourceGroupId) : null,
  repayments: (entry.repayments || []).map((r) => ({
    id: String(r._id),
    amountMinor: r.amountMinor,
    paidAt: r.paidAt,
    note: r.note,
  })),
});

/**
 * Fetch this user's ledger, creating it on first use.
 *
 * Created lazily rather than at sign-up: an account that never opens the ledger
 * should not leave an empty row behind, and the first read is a perfectly good
 * moment to make one.
 */
const getOrCreate = async (userId) => {
  const existing = await ledgerRepository.findByUser(userId);
  if (existing) return existing;

  try {
    return await ledgerRepository.createForUser(userId, DEFAULT_CURRENCY);
  } catch (err) {
    // Two concurrent first-reads race on the unique index; the loser re-reads.
    if (err?.code === 11000) return ledgerRepository.findByUser(userId);
    throw err;
  }
};

const startOfMonth = (date = new Date()) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const getSummary = async (userId) => {
  const ledger = await getOrCreate(userId);

  const [totals, categories] = await Promise.all([
    ledgerRepository.totals(ledger._id, { spendSince: startOfMonth() }),
    ledgerRepository.spendByCategory(ledger._id, startOfMonth()),
  ]);

  return {
    ledger: { id: String(ledger._id), currency: ledger.currency },
    /**
     * Deliberately three separate figures, never netted into one.
     *
     * "You are up ₹400" is false comfort when it means someone owes you ₹1,400
     * and you owe someone else ₹1,000 — those are two different conversations
     * with two different people, and one of them may never pay
     * (docs/08-PERSONAL-LEDGER.md §5).
     */
    totals,
    spendByCategory: categories.map((row) => ({
      category: row._id || "OTHER",
      totalMinor: row.totalMinor,
      count: row.count,
    })),
  };
};

const listEntries = async (
  userId,
  { cursor, limit = LIMITS.DEFAULT_PAGE_SIZE, type, settled, source } = {}
) => {
  const ledger = await getOrCreate(userId);

  const rows = await ledgerRepository.listEntries(ledger._id, {
    cursor: decodeCursor(cursor),
    limit,
    type,
    settled,
    source,
  });

  const page = buildPage(rows, limit);
  return {
    items: page.items.map(toEntryDTO),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

/**
 * A `SPEND` has no counterparty and no due date; a debt has both available. These
 * are stripped rather than rejected, so a client that sends a stale field gets a
 * clean record instead of a validation error about something the user cannot see.
 */
const normalizeForType = (type, dto) => {
  if (type === LEDGER_ENTRY_TYPES.SPEND) {
    return { counterpartyName: "", dueAt: null, counterpartyMemberId: null };
  }
  return {
    counterpartyName: dto.counterpartyName?.trim() || "",
    dueAt: dto.dueAt || null,
  };
};

/**
 * Everyone this account could name as a counterparty (docs/17-MEMBER-IDENTITY.md §7).
 *
 * The set is "members of groups I am in", which is only answerable now that
 * `member.userId` is populated — before linking existed, group membership was
 * knowable from a device and the ledger was knowable from an account, and
 * nothing joined the two.
 *
 * Scoping it to shared groups is the whole safety property: a picker over every
 * member on the platform would let anyone address a financial claim at a
 * stranger. `userId` is never returned — the client needs to know that a claim
 * *can* be delivered, not who to.
 */
const listContacts = async (userId) => {
  const mine = await memberRepository.findAllByUserId(userId);
  if (mine.length === 0) return { groups: [] };

  const myMemberIds = new Set(mine.map((member) => String(member._id)));
  const groupIds = [...new Set(mine.map((member) => String(member.groupId)))];

  const [groups, members] = await Promise.all([
    groupRepository.findByIds(groupIds),
    memberRepository.findActiveInGroups(groupIds),
  ]);

  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const byGroup = new Map();

  for (const member of members) {
    // Not yourself: a loan to yourself is not a thing, and seeing your own name
    // in the list reads as a bug.
    if (myMemberIds.has(String(member._id))) continue;

    const key = String(member.groupId);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push({
      id: String(member._id),
      name: member.name,
      // Whether accepting is even possible for them. Shown as "will be notified"
      // rather than as anything about their account.
      reachable: Boolean(member.userId),
    });
  }

  return {
    groups: [...byGroup.entries()]
      .map(([groupId, list]) => ({
        groupId,
        groupName: groupById.get(groupId)?.name || "Group",
        members: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((group) => group.members.length > 0)
      .sort((a, b) => a.groupName.localeCompare(b.groupName)),
  };
};

/**
 * Turn a chosen member into a deliverable claim.
 *
 * Refuses a member from a group the owner is not in — the picker already scopes
 * this, but the picker is a client and the server does not take a client's word
 * for who it is allowed to address.
 *
 * A member with no linked account is still a perfectly good counterparty: the
 * entry records who it is about, and if they link later the reference is already
 * correct. It simply has no claim attached, because there is nobody to deliver
 * it to yet.
 */
const resolveCounterparty = async (userId, memberId) => {
  const mine = await memberRepository.findAllByUserId(userId);
  const myGroupIds = new Set(mine.map((member) => String(member.groupId)));

  const member = await Member.findById(memberId).select("_id groupId name userId").lean();

  if (!member || !myGroupIds.has(String(member.groupId))) {
    throw new BadRequestError(
      "You can only choose someone from a group you're in.",
      ERROR_CODES.VALIDATION_ERROR
    );
  }

  if (mine.some((row) => String(row._id) === String(member._id))) {
    throw new BadRequestError("That's you.", ERROR_CODES.VALIDATION_ERROR);
  }

  return member;
};

const createEntry = async (userId, dto) => {
  const ledger = await getOrCreate(userId);
  const type = dto.type;

  const amountMinor = toMinor(dto.amount, ledger.currency);
  assertMinor(amountMinor, "Amount");

  /**
   * A chosen member becomes a reference, and — when they have an account — a
   * pending claim (docs/17-MEMBER-IDENTITY.md §7).
   *
   * The name is copied from the member rather than trusted from the client, so
   * the row says who was actually chosen. It is then frozen: renaming a member
   * later must not silently rewrite what a past loan said.
   */
  let counterparty = null;
  if (dto.counterpartyMemberId && type !== LEDGER_ENTRY_TYPES.SPEND) {
    counterparty = await resolveCounterparty(userId, dto.counterpartyMemberId);
  }

  const claim = counterparty?.userId
    ? {
        status: LEDGER_CLAIM_STATUS.PENDING,
        toUserId: counterparty.userId,
        respondedAt: null,
        counterpartEntryId: null,
      }
    : undefined;

  const entry = await ledgerRepository.createEntry({
    ledgerId: ledger._id,
    type,
    amountMinor,
    currencyCode: ledger.currency,
    description: dto.description,
    category: dto.category || "",
    occurredAt: dto.occurredAt || new Date(),
    notes: dto.notes || "",
    version: 0,
    ...normalizeForType(type, dto),
    ...(counterparty
      ? { counterpartyMemberId: counterparty._id, counterpartyName: counterparty.name }
      : {}),
    ...(claim ? { claim } : {}),
  });

  await ledgerRepository.touchActivity(ledger._id);

  /**
   * Points, best effort and not awaited — the entry is saved either way.
   *
   * `ACTIVE_DAY` rather than one per entry: adding a fifth spend today earns
   * nothing more than the first, because paying per row is an incentive to
   * create rows (docs/11-REWARDS.md §2).
   */
  awardEntryPoints(userId, entry).catch(() => {});

  return toEntryDTO(entry);
};

/** Earning that follows from creating a ledger entry. Never throws. */
const awardEntryPoints = async (userId, entry) => {
  const first = await pointsService.award(userId, POINT_EVENT_TYPES.FIRST_LEDGER_ENTRY, {
    entryId: String(entry._id),
  });

  const daily = await pointsService.award(userId, POINT_EVENT_TYPES.ACTIVE_DAY, {
    source: "ledger",
    entryId: String(entry._id),
  });

  if (daily) await pointsService.awardStreakMilestones(userId);
  return { first, daily };
};

const updateEntry = async (userId, entryId, dto) => {
  const ledger = await getOrCreate(userId);
  const entry = await ledgerRepository.findEntry(ledger._id, entryId);
  if (!entry) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  /**
   * A mirrored group expense is not editable here.
   *
   * Not to protect the group — nothing in this file can reach a group balance —
   * but because the edit would not survive. The mirror is recomputed whenever the
   * expense changes, so a corrected amount would silently revert the next time
   * anyone touched it in the group, which is worse than refusing. Deleting is
   * still allowed: it is their ledger, and a deleted mirror stays deleted.
   */
  if (entry.source === "GROUP_EXPENSE") {
    throw new BadRequestError(
      `This came from "${entry.sourceGroupName || "a group"}" — edit it there and it will update here.`,
      ERROR_CODES.LEDGER_ENTRY_NOT_EDITABLE
    );
  }

  /**
   * Optimistic concurrency, as expenses have. Two tabs open on the same entry is
   * an ordinary thing to do, and the second save should be told it is stale
   * rather than silently overwrite the first.
   */
  if (entry.version !== dto.version) {
    throw new ConflictError(
      "This entry changed since you opened it. Reload and try again.",
      ERROR_CODES.VERSION_CONFLICT
    );
  }

  /**
   * Changing what the entry is.
   *
   * Three cases, and they are not symmetrical:
   *
   * **debt → debt** (LENT ↔ BORROWED). Free. The repayments still mean money
   * moving; only the direction changes, and "I thought they owed me, actually I
   * owed them" is a normal correction.
   *
   * **debt → SPEND**, with repayments recorded. **Refused.** A `SPEND` has no
   * outstanding balance, so those rows would stop meaning anything — and silently
   * discarding a record of money that changed hands is precisely what this ledger
   * exists not to do. Removing the repayments first is one extra step and makes
   * the loss the user's decision rather than a side effect.
   *
   * **SPEND → debt**. Needs somebody to owe. A debt with no counterparty is not a
   * debt, and every reminder and settle-up flow downstream assumes a name.
   */
  if (dto.type !== undefined && dto.type !== entry.type) {
    const wasDebt = DEBT_TYPES.has(entry.type);
    const willBeDebt = DEBT_TYPES.has(dto.type);

    if (wasDebt && !willBeDebt && (entry.repayments || []).length > 0) {
      throw new BadRequestError(
        "This has repayments recorded against it. Remove them first, then change it to a spend.",
        ERROR_CODES.REPAYMENT_EXCEEDS_PRINCIPAL
      );
    }

    const counterparty = (dto.counterpartyName ?? entry.counterpartyName ?? "").trim();
    if (!wasDebt && willBeDebt && !counterparty) {
      throw new BadRequestError(
        "Who is this with? A loan needs the other person's name.",
        ERROR_CODES.VALIDATION_ERROR
      );
    }

    entry.type = dto.type;

    if (!willBeDebt) {
      /**
       * Becoming a spend. Everything that only makes sense for a debt is cleared
       * rather than left behind — a stale `dueAt` would keep the reminder sweep
       * chasing money nobody owes (docs/08-PERSONAL-LEDGER.md §6).
       */
      entry.counterpartyName = "";
      entry.dueAt = null;
      entry.settledAt = null;
      entry.reminderCount = 0;
      entry.lastRemindedOn = "";
    } else {
      entry.counterpartyName = counterparty;
    }
  }

  if (dto.amount !== undefined) {
    const amountMinor = toMinor(dto.amount, ledger.currency);
    /**
     * The principal cannot drop below what has already been repaid — that would
     * make the outstanding balance negative, which is not a state the ledger has
     * a meaning for.
     */
    const repaid = entry.amountMinor - outstandingOf(entry);
    if (amountMinor < repaid) {
      throw new BadRequestError(
        "That is less than what has already been repaid against this entry.",
        ERROR_CODES.REPAYMENT_EXCEEDS_PRINCIPAL
      );
    }
    entry.amountMinor = amountMinor;
  }

  if (dto.description !== undefined) entry.description = dto.description;
  if (dto.category !== undefined) entry.category = dto.category || "";
  if (dto.occurredAt !== undefined) entry.occurredAt = dto.occurredAt;
  if (dto.notes !== undefined) entry.notes = dto.notes;

  if (dto.counterpartyName !== undefined && DEBT_TYPES.has(entry.type)) {
    entry.counterpartyName = dto.counterpartyName.trim();
  }
  if (dto.dueAt !== undefined && DEBT_TYPES.has(entry.type)) {
    entry.dueAt = dto.dueAt;
  }

  // The principal may have changed; re-derive whether this is now settled.
  entry.settledAt = outstandingOf(entry) <= 0 && DEBT_TYPES.has(entry.type) ? entry.settledAt || new Date() : null;
  entry.version += 1;

  await entry.save();
  await ledgerRepository.touchActivity(ledger._id);
  return toEntryDTO(entry);
};

const deleteEntry = async (userId, entryId) => {
  const ledger = await getOrCreate(userId);
  const removed = await ledgerRepository.softDeleteEntry(ledger._id, entryId);
  if (!removed) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  await ledgerRepository.touchActivity(ledger._id);
  return { id: String(removed._id), deleted: true };
};

/**
 * Record money coming back (or going out) against a debt.
 *
 * The overshoot is **rejected, not clamped**. Clamping would silently absorb a
 * typo — someone entering 4000 instead of 400 would see the loan close and never
 * learn why the numbers stopped making sense.
 */
const addRepayment = async (userId, entryId, dto) => {
  const ledger = await getOrCreate(userId);
  const entry = await ledgerRepository.findEntry(ledger._id, entryId);
  if (!entry) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  if (!DEBT_TYPES.has(entry.type)) {
    throw new BadRequestError(
      "Only money lent or borrowed can be repaid — a spend is already gone.",
      ERROR_CODES.NOT_A_DEBT
    );
  }

  const amountMinor = toMinor(dto.amount, entry.currencyCode);
  assertMinor(amountMinor, "Repayment");

  const outstanding = outstandingOf(entry);
  if (amountMinor > outstanding) {
    throw new BadRequestError(
      `That is more than the ${formatMinor(outstanding, entry.currencyCode)} still outstanding.`,
      ERROR_CODES.REPAYMENT_EXCEEDS_PRINCIPAL
    );
  }

  entry.repayments.push({
    amountMinor,
    paidAt: dto.paidAt || new Date(),
    note: dto.note || "",
  });

  // Settled is derived from the rows, then recorded — never set independently.
  const nowSettled = outstandingOf(entry) === 0;
  if (nowSettled) entry.settledAt = new Date();
  entry.version += 1;

  await entry.save();
  await ledgerRepository.touchActivity(ledger._id);

  /**
   * Points only when the debt actually closes, not for every part payment.
   * Rewarding each instalment would pay someone to record ₹1,000 as a hundred
   * ₹10 repayments — the same per-row incentive §2 rules out for expenses.
   */
  if (nowSettled) {
    pointsService
      .award(userId, POINT_EVENT_TYPES.LEDGER_REPAID, { entryId: String(entry._id) })
      .catch(() => {});
  }

  return toEntryDTO(entry);
};

/**
 * Undo a repayment. This is also how a settled entry is reopened — by removing
 * the row that closed it, so the flag can never disagree with the arithmetic.
 */
const removeRepayment = async (userId, entryId, repaymentId) => {
  const ledger = await getOrCreate(userId);
  const entry = await ledgerRepository.findEntry(ledger._id, entryId);
  if (!entry) throw new NotFoundError("Entry not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  const repayment = entry.repayments.id(repaymentId);
  if (!repayment) throw new NotFoundError("Repayment not found", ERROR_CODES.LEDGER_ENTRY_NOT_FOUND);

  repayment.deleteOne();
  if (outstandingOf(entry) > 0) entry.settledAt = null;
  entry.version += 1;

  await entry.save();
  await ledgerRepository.touchActivity(ledger._id);
  return toEntryDTO(entry);
};

/** The mirror of a LENT claim, and vice versa. */
const OPPOSITE = {
  [LEDGER_ENTRY_TYPES.LENT]: LEDGER_ENTRY_TYPES.BORROWED,
  [LEDGER_ENTRY_TYPES.BORROWED]: LEDGER_ENTRY_TYPES.LENT,
};

/** Claims addressed to this account and not yet answered. */
const listIncomingClaims = async (userId) => {
  const entries = await LedgerEntry.find({
    "claim.toUserId": userId,
    "claim.status": LEDGER_CLAIM_STATUS.PENDING,
    isDeleted: { $ne: true },
  })
    .sort({ occurredAt: -1 })
    .limit(50)
    .lean();

  // Who is asserting it. Read from the member row the claimant chose *from* —
  // their own name in the shared group — because an email address would expose
  // more about them than the group already does.
  const claimantIds = entries.map((entry) => entry.counterpartyMemberId).filter(Boolean);
  const claimantMembers = await Member.find({ _id: { $in: claimantIds } })
    .select("_id groupId")
    .lean();
  const groupIdByMember = new Map(
    claimantMembers.map((member) => [String(member._id), String(member.groupId)])
  );

  const groups = await groupRepository.findByIds([...new Set(groupIdByMember.values())]);
  const groupNameById = new Map(groups.map((group) => [String(group._id), group.name]));

  return {
    claims: entries.map((entry) => ({
      id: String(entry._id),
      // Flipped: their LENT is the recipient's BORROWED.
      type: OPPOSITE[entry.type] || entry.type,
      amountMinor: entry.amountMinor,
      currencyCode: entry.currencyCode,
      description: entry.description,
      occurredAt: entry.occurredAt,
      dueAt: entry.dueAt,
      fromGroup: groupNameById.get(groupIdByMember.get(String(entry.counterpartyMemberId))) || null,
    })),
  };
};

/**
 * Answer a claim (docs/17-MEMBER-IDENTITY.md §7).
 *
 * Accepting writes the counterpart entry into the recipient's own ledger and
 * links the two. Declining records the refusal and writes nothing — the
 * claimant's row stays exactly as it was, because a disagreement about money is
 * a real state and deleting one side of it would be the app taking a position.
 *
 * The status guard is in the query, so two taps on Accept cannot create two
 * counterpart entries.
 */
const respondToClaim = async (userId, entryId, accept) => {
  const claimEntry = await LedgerEntry.findOneAndUpdate(
    {
      _id: entryId,
      "claim.toUserId": userId,
      "claim.status": LEDGER_CLAIM_STATUS.PENDING,
      isDeleted: { $ne: true },
    },
    {
      $set: {
        "claim.status": accept ? LEDGER_CLAIM_STATUS.ACCEPTED : LEDGER_CLAIM_STATUS.DECLINED,
        "claim.respondedAt": new Date(),
      },
    },
    { new: true }
  );

  if (!claimEntry) {
    throw new NotFoundError(
      "That request is no longer waiting for an answer.",
      ERROR_CODES.LEDGER_ENTRY_NOT_FOUND
    );
  }

  if (!accept) return { accepted: false, entry: null };

  const ledger = await getOrCreate(userId);

  const counterpart = await ledgerRepository.createEntry({
    ledgerId: ledger._id,
    type: OPPOSITE[claimEntry.type] || LEDGER_ENTRY_TYPES.BORROWED,
    amountMinor: claimEntry.amountMinor,
    currencyCode: claimEntry.currencyCode,
    description: claimEntry.description,
    counterpartyName: claimEntry.counterpartyName || "",
    category: claimEntry.category || "",
    occurredAt: claimEntry.occurredAt,
    dueAt: claimEntry.dueAt || null,
    notes: "",
    version: 0,
  });

  claimEntry.claim.counterpartEntryId = counterpart._id;
  await claimEntry.save();

  await ledgerRepository.touchActivity(ledger._id);

  return { accepted: true, entry: toEntryDTO(counterpart) };
};

module.exports = {
  getOrCreate,
  getSummary,
  listEntries,
  listContacts,
  listIncomingClaims,
  respondToClaim,
  createEntry,
  updateEntry,
  deleteEntry,
  addRepayment,
  removeRepayment,
  outstandingOf,
  toEntryDTO,
};
