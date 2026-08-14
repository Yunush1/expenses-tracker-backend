const recurringExpenseRepository = require("../repositories/recurringExpenseRepository");
const memberRepository = require("../repositories/memberRepository");
const groupRepository = require("../repositories/groupRepository");
const expenseService = require("./expenseService");
const entitlementService = require("./entitlementService");
const policy = require("../utils/entitlementPolicy");
const recurrence = require("../utils/recurrence");
const { toMinor, toMajor } = require("../utils/money");
const { inferCategory } = require("../utils/inferCategory");
const { normalizeSplitValues } = require("../utils/splitCalculator");
const {
  SPLIT_TYPES,
  SPLIT_VALUE_UNITS,
  RECURRENCE,
  FEATURES,
  GROUP_STATUS,
  ERROR_CODES,
} = require("../constants");
const { NotFoundError, BadRequestError } = require("../errors");
const logger = require("../utils/logger");

/**
 * Recurring expenses (docs/16-TODO.md §2.2, docs/22-MONETIZATION.md §14 step 2).
 *
 * ## Idempotency is the whole feature
 *
 * Everything else here is bookkeeping. A template that produces two rents in a
 * month has silently taken money from four flatmates, and no amount of good UI
 * makes up for it. Three mechanisms stack:
 *
 * 1. **A `clientRequestId` of `rec:<templateId>:<YYYY-MM-DD>`**, which the unique
 *    partial index on `{ groupId, clientRequestId }` enforces. Two instances
 *    ticking simultaneously produce the same key, and the second write returns the
 *    first row instead of a duplicate.
 * 2. **`nextRunAt` advances only after the expense exists**, so a crash between
 *    the two leaves the date unmoved and the next tick retries — landing on the
 *    same key, which is already taken.
 * 3. **Materialisation goes through `expenseService.createExpense`**, the same
 *    function the form calls, so there is no second path that could drift from the
 *    first on splits, activity, push or the ledger mirror.
 *
 * ## Why the plan cap does not edit anybody's templates
 *
 * A group holding more templates than its plan covers keeps all of them. The ones
 * that keep *running* are the oldest N, and the rest are dormant — a fact computed
 * on the fly from creation order, never a flag written onto the row. A downgrade
 * that edited templates would need resubscribing to guess which edits to undo
 * (docs/22-MONETIZATION.md §6: templates stop materialising but are not deleted).
 */

/** How many templates one tick will process, whatever the backlog. */
const BATCH = 500;

/**
 * The furthest back a template will catch up in one go.
 *
 * Twelve monthly runs is a year, which comfortably covers any outage worth
 * catching up on. Past it the schedule is fast-forwarded without materialising,
 * because the realistic cause of a thousand due dates is not an outage — it is a
 * restored backup or a clock skew, and posting a year of expenses into a live
 * group is not recoverable by the people it lands on.
 */
const MAX_CATCH_UP = 12;

/* ------------------------------- Reading --------------------------------- */

/**
 * Stored integer split values → the unit the user typed in.
 *
 * The same conversion the expense serializer does, and it is needed twice here:
 * once to show a template in the UI, and once to hand it back to
 * `expenseService.createExpense`, which re-normalises it. Converting back rather
 * than passing the integers straight through keeps one validation path for both
 * ways an expense can be created.
 */
const splitValuesOut = (splitType, splitValues = [], currency) =>
  splitValues.map((entry) => {
    const unit = SPLIT_VALUE_UNITS[splitType];

    return {
      memberId: String(entry.memberId),
      value:
        unit === "MINOR"
          ? toMajor(entry.value, currency)
          : unit === "CENTIPERCENT"
            ? entry.value / 100
            : entry.value,
    };
  });

const toDTO = (template, { active = true, memberNameById = new Map(), currency = "INR" } = {}) => ({
  id: String(template._id),
  description: template.description,
  amountMinor: template.amountMinor,
  amount: toMajor(template.amountMinor, currency),
  currencyCode: template.currencyCode,
  paidBy: {
    id: String(template.paidBy),
    name: memberNameById.get(String(template.paidBy)) || "Unknown",
  },
  participantIds: template.participantIds.map(String),
  participantCount: template.participantIds.length,
  splitType: template.splitType,
  splitValues: splitValuesOut(template.splitType, template.splitValues, currency),
  category: template.category || null,
  notes: template.notes || "",
  frequency: template.frequency,
  dayOfMonth: template.dayOfMonth,
  weekday: template.weekday,
  nextRunAt: template.nextRunAt,
  lastRunAt: template.lastRunAt,
  runCount: template.runCount || 0,
  skippedCount: template.skippedCount || 0,
  isPaused: Boolean(template.isPaused),
  endsOn: template.endsOn || null,
  /**
   * Whether this one will actually fire.
   *
   * Derived from the group's plan and this template's position in creation order,
   * never stored — see the note at the top. A dormant template is not broken and
   * not paused: it is waiting for the group's plan to cover it again.
   */
  isActive: active && !template.isPaused,
  isDormant: !active,
  createdAt: template.createdAt,
});

/**
 * Which of a group's templates its plan currently covers.
 *
 * Oldest first, up to the cap. Creation order because it is the only ordering that
 * is stable and explicable — "the ones you set up first keep running" — where
 * anything derived from amount or name would reshuffle the moment somebody edited
 * one.
 */
const activeIdsFor = (templates, limit) =>
  new Set(templates.slice(0, Math.max(0, limit)).map((template) => String(template._id)));

const listForGroup = async (group) => {
  const [templates, entitlement, members] = await Promise.all([
    recurringExpenseRepository.findByGroup(group._id),
    entitlementService.forGroup(group._id),
    memberRepository.findByGroup(group._id),
  ]);

  const limit = policy.allowanceFor(entitlement.plan, FEATURES.RECURRING_EXPENSES);
  const active = activeIdsFor(templates, limit);
  const memberNameById = new Map(members.map((member) => [String(member._id), member.name]));

  return {
    templates: templates.map((template) =>
      toDTO(template, {
        active: active.has(String(template._id)),
        memberNameById,
        currency: group.currency,
      })
    ),
    /** Echoed so the UI can say "2 of 1 — upgrade to run them all" without maths. */
    limit,
    used: templates.length,
    canAddMore: templates.length < limit,
  };
};

/* ------------------------------- Writing --------------------------------- */

/**
 * Validate the template body the same way an expense would be.
 *
 * Deliberately reuses `normalizeSplitValues` rather than checking percentages here:
 * a template that stores a split the expense service would later reject is a
 * failure that surfaces at 3am in a job, on somebody else's rent, with nobody
 * watching. Better to refuse it at the form.
 */
const prepare = async ({ group, dto, existing = null }) => {
  const amountMinor =
    dto.amount !== undefined ? toMinor(dto.amount, group.currency) : existing.amountMinor;

  const paidBy = String(dto.paidBy || existing?.paidBy || "");

  /**
   * The payer is not required to be a participant, and that omission is
   * deliberate: one flatmate paying for a meal they did not eat is an ordinary
   * thing, and `expenseService` does not require it either.
   */
  const participantIds = (
    dto.participantIds || existing?.participantIds?.map(String) || []
  ).map(String);

  const members = await memberRepository.findByGroup(group._id);
  const known = new Set(members.filter((member) => member.isActive !== false).map((m) => String(m._id)));

  if (!known.has(paidBy)) {
    throw new BadRequestError(
      "Whoever pays this needs to be an active member of the group",
      ERROR_CODES.INVALID_PARTICIPANTS
    );
  }

  const unknown = participantIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new BadRequestError(
      "Some of these people are no longer in the group",
      ERROR_CODES.INVALID_PARTICIPANTS
    );
  }

  const splitType = dto.splitType || existing?.splitType || SPLIT_TYPES.EQUAL;

  /**
   * An edit that leaves the split alone keeps the stored values, exactly as
   * `expenseService.updateExpense` does — so changing only the amount on a 60/40
   * rent re-derives the same 60/40 instead of demanding it be retyped. The stored
   * values are already in their integer unit, so they are reused rather than
   * re-normalised.
   */
  const splitValues =
    dto.splitValues === undefined && existing && splitType === existing.splitType
      ? existing.splitValues.map((entry) => ({
          memberId: String(entry.memberId),
          value: entry.value,
        }))
      : normalizeSplitValues({
          splitType,
          splitValues: dto.splitValues,
          currency: group.currency,
        });

  return { amountMinor, paidBy, participantIds, splitType, splitValues };
};

const create = async ({ group, actor, dto }) => {
  const entitlement = await entitlementService.forGroup(group._id);
  const current = await recurringExpenseRepository.countByGroup(group._id);

  /**
   * The plan check happens before anything is written, and refuses with the count
   * and the ceiling attached so the client can draw the wall from the error rather
   * than making a second call for what it was just refused.
   */
  entitlementService.assertCapacity(entitlement, FEATURES.RECURRING_EXPENSES, current, group);

  const { amountMinor, paidBy, participantIds, splitType, splitValues } = await prepare({
    group,
    dto,
  });

  const rule = {
    frequency: dto.frequency || RECURRENCE.MONTHLY,
    dayOfMonth: dto.dayOfMonth ?? new Date().getUTCDate(),
    weekday: dto.weekday ?? new Date().getUTCDay(),
  };

  /**
   * The first run is the next matching date, which for a monthly template set up
   * on the 20th for the 1st means next month — not today.
   *
   * `startsOn` lets somebody say "from January", and is floored at today because a
   * template backdated to last year would materialise a year of expenses on its
   * first tick, which is precisely the surprise `MAX_CATCH_UP` exists to prevent.
   */
  const from = dto.startsOn && new Date(dto.startsOn) > new Date() ? new Date(dto.startsOn) : new Date();
  const nextRunAt = recurrence.firstRunOnOrAfter(rule, from);

  const template = await recurringExpenseRepository.create({
    groupId: group._id,
    description: dto.description,
    category: inferCategory(dto.description, dto.category),
    amountMinor,
    currencyCode: group.currency,
    paidBy,
    participantIds,
    splitType,
    splitValues,
    notes: dto.notes || "",
    ...rule,
    nextRunAt,
    endsOn: dto.endsOn || null,
    createdByMemberId: actor._id,
  });

  logger.info(
    `[recurring] Group ${group._id} added "${template.description}" — next ${recurrence.dateKey(nextRunAt)}`
  );

  return listForGroup(group);
};

const update = async ({ group, actor, templateId, dto }) => {
  const existing = await recurringExpenseRepository.findById(group._id, templateId);
  if (!existing) throw new NotFoundError("That recurring expense no longer exists");

  const { amountMinor, paidBy, participantIds, splitType, splitValues } = await prepare({
    group,
    dto,
    existing,
  });

  const set = {
    description: dto.description ?? existing.description,
    amountMinor,
    paidBy,
    participantIds,
    splitType,
    splitValues,
    notes: dto.notes ?? existing.notes,
    endsOn: dto.endsOn === undefined ? existing.endsOn : dto.endsOn,
  };

  // Same three states as an expense's category: absent keeps, null re-infers.
  set.category =
    dto.category === undefined
      ? existing.category || inferCategory(set.description)
      : inferCategory(set.description, dto.category);

  /**
   * Changing the schedule re-seeds `nextRunAt` from today.
   *
   * Rather than keeping the old date and applying the new rule to it, which would
   * let "the 1st, monthly" edited to "weekly on Friday" fire on a Tuesday once.
   * Re-seeding forwards also means an edit can never *retroactively* create a due
   * date that has already passed.
   */
  const scheduleChanged =
    (dto.frequency !== undefined && dto.frequency !== existing.frequency) ||
    (dto.dayOfMonth !== undefined && dto.dayOfMonth !== existing.dayOfMonth) ||
    (dto.weekday !== undefined && dto.weekday !== existing.weekday);

  if (scheduleChanged) {
    const rule = {
      frequency: dto.frequency ?? existing.frequency,
      dayOfMonth: dto.dayOfMonth ?? existing.dayOfMonth,
      weekday: dto.weekday ?? existing.weekday,
    };
    Object.assign(set, rule);
    set.nextRunAt = recurrence.firstRunOnOrAfter(rule, new Date());
  }

  if (dto.isPaused !== undefined) {
    set.isPaused = Boolean(dto.isPaused);

    /**
     * Resuming restarts from the next due date, never from where it was paused.
     *
     * A template paused in January and resumed in June should add June's rent, not
     * five months of it — pausing was a decision that those months should not be
     * charged, and resuming must not silently reverse it.
     */
    if (!set.isPaused && existing.isPaused) {
      set.nextRunAt = recurrence.firstRunOnOrAfter(
        {
          frequency: dto.frequency ?? existing.frequency,
          dayOfMonth: dto.dayOfMonth ?? existing.dayOfMonth,
          weekday: dto.weekday ?? existing.weekday,
        },
        new Date()
      );
    }
  }

  await recurringExpenseRepository.updateById(group._id, templateId, { $set: set });

  logger.info(`[recurring] Group ${group._id} updated template ${templateId} (actor ${actor._id})`);

  return listForGroup(group);
};

const remove = async ({ group, templateId }) => {
  const removed = await recurringExpenseRepository.softDelete(group._id, templateId);
  if (!removed) throw new NotFoundError("That recurring expense no longer exists");

  // Said explicitly because it is the question somebody has while clicking delete.
  logger.info(
    `[recurring] Group ${group._id} removed template ${templateId} — ` +
      `${removed.runCount || 0} expense(s) it created are untouched`
  );

  return listForGroup(group);
};

/* ---------------------------- Materialisation ---------------------------- */

/**
 * Produce one expense for one due date.
 *
 * Routed through `expenseService.createExpense` deliberately: activity, the group's
 * `lastActivityAt`, push and the personal-ledger mirror all fire unchanged, and
 * there is no second copy of the split arithmetic to drift.
 *
 * The `actor` is the member who set the template up. That is honest — somebody did
 * decide this — and it keeps `createdByMemberId` pointing at a real member, which
 * is what the edit-permission rule is built on. A synthetic "system" member would
 * be a member with no device that nobody could ever authenticate as.
 */
const materialiseOne = async ({ group, template, actor, date }) => {
  const dto = {
    description: template.description,
    amount: toMajor(template.amountMinor, group.currency),
    paidBy: String(template.paidBy),
    participantIds: template.participantIds.map(String),
    splitType: template.splitType,
    category: template.category || null,
    notes: template.notes || "",
    expenseDate: date,
    /** The idempotency key. See the note at the top of this file. */
    clientRequestId: recurrence.materialisationKey(template._id, date),
  };

  if (template.splitType !== SPLIT_TYPES.EQUAL) {
    dto.splitValues = splitValuesOut(template.splitType, template.splitValues, group.currency);
  }

  return expenseService.createExpense({ group, actor, dto });
};

/**
 * One template's due dates, materialised.
 *
 * Returns what happened rather than throwing, because this runs inside a loop over
 * every group in the system and one bad template — a payer who left, an amount
 * that no longer splits — must not stop the other four hundred.
 */
const runTemplate = async ({ template, group, entitled, now }) => {
  const { dates, nextRunAt, truncated } = recurrence.dueDates(template, {
    now,
    maxCatchUp: MAX_CATCH_UP,
  });

  if (truncated) {
    logger.warn(
      `[recurring] Template ${template._id} had more than ${MAX_CATCH_UP} due dates — ` +
        "fast-forwarding the rest rather than posting them"
    );
  }

  if (dates.length === 0) {
    // Nothing due, or the end date has passed. Either way it stops asking.
    if (recurrence.hasEnded(template, now)) {
      await recurringExpenseRepository.updateById(group._id, template._id, {
        $set: { isPaused: true },
      });
    }
    return { produced: 0, skipped: 0 };
  }

  /**
   * Not covered by the plan: advance past the due dates without producing them.
   *
   * The advance is what stops a backlog forming — see recordSkip. Nothing is
   * edited about the template itself, so the moment the group's plan covers it
   * again it simply starts running, from the next date rather than from the gap.
   */
  if (!entitled) {
    await recurringExpenseRepository.recordSkip(template._id, {
      nextRunAt,
      skippedAt: now,
      skipped: dates.length,
    });
    return { produced: 0, skipped: dates.length };
  }

  const actor = await memberRepository.findById(group._id, template.createdByMemberId);

  if (!actor) {
    /**
     * The member who set this up has been removed. Pausing rather than deleting or
     * guessing a substitute: an expense needs an author for the edit-permission
     * rule, and silently attributing eight months of rent to whoever happens to be
     * the creator would put it under a name that never agreed to it.
     */
    logger.warn(
      `[recurring] Template ${template._id} has no author left in the group — pausing it`
    );
    await recurringExpenseRepository.updateById(group._id, template._id, {
      $set: { isPaused: true },
    });
    return { produced: 0, skipped: 0 };
  }

  let produced = 0;

  for (const date of dates) {
    // eslint-disable-next-line no-await-in-loop -- ordered by date, and bounded at MAX_CATCH_UP
    const result = await materialiseOne({ group, template, actor, date });
    // A replayed key returns the original expense and reports `created: false`,
    // which is the idempotency guarantee doing its job rather than a failure.
    if (result.created) produced += 1;
  }

  /**
   * Counted by what was actually created, not by how many dates were attempted.
   *
   * They differ only when a retry replays a key whose expense already exists —
   * a crash between the write and this line. Undercounting a display figure by one
   * is the better error: the alternative claims a template produced two rents for
   * March when there is one.
   */
  await recurringExpenseRepository.recordRun(template._id, {
    nextRunAt,
    ranAt: now,
    produced,
  });

  return { produced, skipped: 0 };
};

/**
 * The job entry point: every due template, everywhere.
 *
 * Groups the batch by group so the entitlement and the cap are resolved once per
 * group rather than once per template — a flatshare with eight templates would
 * otherwise read its plan eight times in one tick.
 */
const runDue = async (now = new Date()) => {
  const due = await recurringExpenseRepository.findDue(now, BATCH);
  if (due.length === 0) return { templates: 0, produced: 0, skipped: 0 };

  const byGroup = new Map();
  for (const template of due) {
    const key = String(template.groupId);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(template);
  }

  let produced = 0;
  let skipped = 0;

  for (const [groupId, templates] of byGroup) {
    // eslint-disable-next-line no-await-in-loop -- one group at a time, bounded by BATCH
    const group = await groupRepository.findById(groupId);

    /**
     * A deleted or archived group produces nothing. Archived is explicitly
     * read-only for every member, and a scheduler that kept writing into it would
     * be the one actor able to ignore that.
     */
    if (!group || group.status !== GROUP_STATUS.ACTIVE) continue;

    // eslint-disable-next-line no-await-in-loop
    const [entitlement, all] = await Promise.all([
      entitlementService.forGroup(group._id, now),
      recurringExpenseRepository.findByGroup(group._id),
    ]);

    const limit = policy.allowanceFor(entitlement.plan, FEATURES.RECURRING_EXPENSES);
    const active = activeIdsFor(all, limit);

    for (const template of templates) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential by design; see runTemplate
        const result = await runTemplate({
          template,
          group,
          entitled: active.has(String(template._id)),
          now,
        });
        produced += result.produced;
        skipped += result.skipped;
      } catch (error) {
        /**
         * One template's failure is contained here rather than allowed to abort
         * the tick. `nextRunAt` is deliberately left where it was, so the next run
         * retries — and the idempotency key means a retry after a partial success
         * cannot double-charge.
         */
        logger.error(
          `[recurring] Template ${template._id} failed: ${error.stack || error.message}`
        );
      }
    }
  }

  if (produced > 0 || skipped > 0) {
    logger.info(
      `[recurring] ${due.length} template(s) due — ${produced} expense(s) added, ${skipped} skipped`
    );
  }

  return { templates: due.length, produced, skipped };
};

module.exports = {
  listForGroup,
  create,
  update,
  remove,
  runDue,
  runTemplate,
  MAX_CATCH_UP,
};
