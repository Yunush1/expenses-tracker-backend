/** Shared enums, limits and error codes. Single source of truth for both layers. */

// The only import here, and only for the referral levels — which are deliberately
// operator-tunable, so they cannot be literals in this file. config/env pulls in
// nothing from here, so there is no cycle.
const config = require("../config/env");

const GROUP_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
  DELETED: "DELETED",
});

const SPLIT_TYPES = Object.freeze({
  EQUAL: "EQUAL",
  EXACT: "EXACT",
  PERCENTAGE: "PERCENTAGE",
  SHARES: "SHARES",
});

/**
 * Every split type except EQUAL needs a per-participant input value. It is stored
 * as an INTEGER whose unit depends on the split type, so the no-floats rule
 * (docs/05-ALGORITHMS.md §1) holds for split inputs too:
 *
 *   EXACT       minor units      — ₹250.50 is stored as 25050
 *   PERCENTAGE  hundredths of a percent — 33.33% is stored as 3333
 *   SHARES      whole weights    — "2 shares" is stored as 2
 */
const SPLIT_VALUE_UNITS = Object.freeze({
  [SPLIT_TYPES.EXACT]: "MINOR",
  [SPLIT_TYPES.PERCENTAGE]: "CENTIPERCENT",
  [SPLIT_TYPES.SHARES]: "WEIGHT",
});

const SETTLEMENT_METHODS = Object.freeze({
  MANUAL: "MANUAL",
  // Reserved for the payments phase.
  UPI: "UPI",
  CASH: "CASH",
  CARD: "CARD",
});

const ACTIVITY_TYPES = Object.freeze({
  GROUP_CREATED: "GROUP_CREATED",
  GROUP_UPDATED: "GROUP_UPDATED",
  GROUP_ARCHIVED: "GROUP_ARCHIVED",
  MEMBER_JOINED: "MEMBER_JOINED",
  MEMBER_ADDED: "MEMBER_ADDED",
  MEMBER_RENAMED: "MEMBER_RENAMED",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  MEMBER_MERGED: "MEMBER_MERGED",
  DEVICE_LINKED: "DEVICE_LINKED",
  EXPENSE_ADDED: "EXPENSE_ADDED",
  EXPENSE_UPDATED: "EXPENSE_UPDATED",
  EXPENSE_DELETED: "EXPENSE_DELETED",
  SETTLEMENT_RECORDED: "SETTLEMENT_RECORDED",
});

/**
 * The three things a personal ledger entry can be (docs/08-PERSONAL-LEDGER.md §1).
 *
 * `SPEND` never settles — it is a record of money gone, not a debt. The other two
 * are the same transaction seen from opposite ends, and are kept as distinct types
 * rather than one signed amount because "who owes whom" is the question the ledger
 * exists to answer, and a sign is a poor way to ask it.
 */
const LEDGER_ENTRY_TYPES = Object.freeze({
  SPEND: "SPEND",
  LENT: "LENT",
  BORROWED: "BORROWED",
});

/** Small and fixed. A free-text category field becomes forty spellings of "food". */
const LEDGER_CATEGORIES = Object.freeze([
  "FOOD",
  "TRAVEL",
  "SHOPPING",
  "BILLS",
  "HEALTH",
  "ENTERTAINMENT",
  "RENT",
  "OTHER",
]);

/**
 * Reward point events (docs/11-REWARDS.md).
 *
 * Note what is absent: nothing per-expense. Points are awarded for logging on a
 * *day*, not for each row — paying per row is a standing incentive to create
 * rows, and in a shared group that silently distorts what everyone else owes.
 */
const BASE_POINT_EVENT_TYPES = {
  /** At least one expense or ledger entry today. Once daily, however many. */
  ACTIVE_DAY: "ACTIVE_DAY",
  /** Closed a debt — the loop that actually matters. */
  SETTLEMENT: "SETTLEMENT",
  LEDGER_REPAID: "LEDGER_REPAID",
  STREAK_3: "STREAK_3",
  STREAK_7: "STREAK_7",
  STREAK_14: "STREAK_14",
  STREAK_30: "STREAK_30",
  FIRST_GROUP: "FIRST_GROUP",
  FIRST_LEDGER_ENTRY: "FIRST_LEDGER_ENTRY",
  NOTIFICATIONS_ENABLED: "NOTIFICATIONS_ENABLED",
  /** A brand new account's opening balance, so Ria works on day one. */
  WELCOME_BONUS: "WELCOME_BONUS",
  /** The invitee's half of a referral — for arriving through someone's link. */
  REFERRAL_JOINED: "REFERRAL_JOINED",
  /** Negative. The only sink in v1. */
  SPEND_AI_QUESTION: "SPEND_AI_QUESTION",
};

/**
 * `REFERRAL_L1`, `REFERRAL_L2`, … one per configured level.
 *
 * Generated rather than written out because the depth is an operator setting: a
 * fixed list of three would silently ignore a fourth level, and the mismatch
 * would only show up as referrals quietly not paying. `REFERRAL_LEVELS=50`
 * yields a flat one-level scheme and no `REFERRAL_L2` type ever exists.
 */
const REFERRAL_LEVEL_TYPES = Object.freeze(
  config.referral.levels.map((_, index) => `REFERRAL_L${index + 1}`)
);

const POINT_EVENT_TYPES = Object.freeze({
  ...BASE_POINT_EVENT_TYPES,
  ...Object.fromEntries(REFERRAL_LEVEL_TYPES.map((type) => [type, type])),
});

/** Point values and how often each may be earned. Amounts of money never feature. */
const POINT_RULES = Object.freeze({
  [POINT_EVENT_TYPES.ACTIVE_DAY]: { points: 10, perDay: 1 },
  [POINT_EVENT_TYPES.SETTLEMENT]: { points: 15, perDay: 2 },
  [POINT_EVENT_TYPES.LEDGER_REPAID]: { points: 15, perDay: 2 },
  [POINT_EVENT_TYPES.STREAK_3]: { points: 20, once: true },
  [POINT_EVENT_TYPES.STREAK_7]: { points: 50, once: true },
  [POINT_EVENT_TYPES.STREAK_14]: { points: 100, once: true },
  [POINT_EVENT_TYPES.STREAK_30]: { points: 250, once: true },
  [POINT_EVENT_TYPES.FIRST_GROUP]: { points: 25, once: true },
  [POINT_EVENT_TYPES.FIRST_LEDGER_ENTRY]: { points: 25, once: true },
  [POINT_EVENT_TYPES.NOTIFICATIONS_ENABLED]: { points: 25, once: true },
  [POINT_EVENT_TYPES.WELCOME_BONUS]: { points: config.referral.welcomeBonus, once: true },
  [POINT_EVENT_TYPES.REFERRAL_JOINED]: { points: config.referral.joinBonus, once: true },

  /**
   * One rule per configured level.
   *
   * `uncapped` because these must not be metered by `DAILY_EARN_CAP`: someone who
   * logs an expense, settles a debt and then has two friends join should not find
   * the friends silently worthless because the day's ordinary allowance was
   * already spent. They are bounded instead by `perDay` — a tighter, more
   * targeted limit, since this is the rule most worth attacking.
   *
   * `key: "subject"` marks the dedupe as per-*referred-person* rather than
   * per-day: the same friend qualifying can never pay out twice, however long
   * ago they joined.
   */
  ...Object.fromEntries(
    REFERRAL_LEVEL_TYPES.map((type, index) => [
      type,
      {
        points: config.referral.levels[index],
        perDay: config.referral.dailyCap,
        uncapped: true,
        key: "subject",
      },
    ])
  ),
});

const POINTS = Object.freeze({
  /**
   * Ceiling on ordinary earning per day, independent of the individual rules —
   * so a rule added carelessly later cannot uncap the economy. Streak milestones
   * are exempt: they are once-ever and already bounded.
   */
  DAILY_EARN_CAP: 60,
  /** One Ria question beyond the free daily quota. */
  AI_QUESTION_COST: 10,
  /**
   * The same question, for an account still inside its first `AI_NEW_USER_DAYS`.
   *
   * Half price, because a new account has the welcome bonus and no earning
   * history: at full price the bonus buys five questions, at half it buys ten —
   * enough to find out whether the assistant is worth the daily habit that earns
   * more. Nothing here is time-limited *after* that; the price simply returns to
   * normal once the account is no longer new (docs/10-AI-ASSISTANT.md §5).
   */
  AI_QUESTION_COST_NEW: 5,
  STREAK_MILESTONES: Object.freeze([
    { days: 3, type: POINT_EVENT_TYPES.STREAK_3 },
    { days: 7, type: POINT_EVENT_TYPES.STREAK_7 },
    { days: 14, type: POINT_EVENT_TYPES.STREAK_14 },
    { days: 30, type: POINT_EVENT_TYPES.STREAK_30 },
  ]),
});

const BALANCE_STATUS = Object.freeze({
  RECEIVE: "RECEIVE",
  OWE: "OWE",
  SETTLED: "SETTLED",
});

const LIMITS = Object.freeze({
  MAX_MEMBERS_PER_GROUP: 50,
  /** One person, several browsers. Bounded so a shared device cannot accumulate forever. */
  MAX_DEVICES_PER_MEMBER: 8,
  /** Typed by hand, so short — kept safe by a 10 minute TTL, single use and a try limit. */
  LINK_CODE_LENGTH: 6,
  LINK_CODE_TTL_MS: 10 * 60 * 1000,
  LINK_CODE_MAX_ATTEMPTS: 5,
  MAX_PARTICIPANTS: 50,
  MAX_AMOUNT_MAJOR: 10_000_000,
  MAX_PAGE_SIZE: 50,
  /** One receipt's worth of lines. Bounded so a batch stays a single quick write. */
  MAX_BATCH_ITEMS: 20,
  DEFAULT_PAGE_SIZE: 20,
  INVITE_CODE_LENGTH: 16,
  /**
   * The short code people read out or type in, as opposed to the 16-char invite
   * code that lives in a URL. 8 symbols from a 25-letter alphabet is ~37 bits —
   * far less than the link's 96, which is why it is optional, revocable, and the
   * only thing behind the strict lookup limiter. See docs/02-HLD.md §3.4.
   */
  JOIN_CODE_LENGTH: 8,
  JOIN_CODE_MIN: 6,
  JOIN_CODE_MAX: 12,
  GROUP_NAME_MAX: 80,
  GROUP_DESC_MAX: 500,
  MEMBER_NAME_MAX: 50,
  EXPENSE_DESC_MAX: 140,
  /** Personal ledger. Descriptions are terser than a group expense's — nobody else has to understand them. */
  LEDGER_DESC_MAX: 140,
  LEDGER_NOTE_MAX: 500,
  /** A name typed by hand, never a member reference — see docs/08-PERSONAL-LEDGER.md §2. */
  LEDGER_COUNTERPARTY_MAX: 60,
  /** A loan between friends, not an instalment plan. Bounds an embedded array. */
  MAX_REPAYMENTS_PER_ENTRY: 50,
  EXPENSE_NOTES_MAX: 500,
  SETTLEMENT_NOTE_MAX: 280,
  /** Percentages carry 2 decimals, so 100% is 10 000 centipercent. */
  PERCENT_TOTAL_CENTI: 10_000,
  /**
   * Caps `amountMinor * weight` well inside Number.MAX_SAFE_INTEGER: the largest
   * expense is 1e9 minor units and 50 participants at weight 1000 total 50 000,
   * so the widest product is 1e9 × 1000 = 1e12 — three orders of magnitude clear.
   */
  MAX_SHARE_WEIGHT: 1000,
});

const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** No token, a malformed one, or one this server cannot verify. */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /**
   * Its own code, separate from UNAUTHENTICATED, because the client's response
   * differs: an expired token is refreshed and the request retried, whereas an
   * invalid one means sign in again. Firebase tokens last an hour, so this is a
   * routine event rather than an error — see docs/09-AUTH.md §3.
   */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** The account was disabled, or its sessions were revoked. */
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  /** Firebase is not configured on this deployment; ledger routes cannot serve. */
  FEATURE_UNAVAILABLE: "FEATURE_UNAVAILABLE",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_ID: "INVALID_ID",
  INVALID_PARTICIPANTS: "INVALID_PARTICIPANTS",
  INVALID_SPLIT: "INVALID_SPLIT",
  SELF_SETTLEMENT: "SELF_SETTLEMENT",
  NOT_A_MEMBER: "NOT_A_MEMBER",
  CREATOR_ONLY: "CREATOR_ONLY",
  EXPENSE_OWNER_ONLY: "EXPENSE_OWNER_ONLY",
  INVALID_LINK_CODE: "INVALID_LINK_CODE",
  INVALID_JOIN_CODE: "INVALID_JOIN_CODE",
  JOIN_CODE_TAKEN: "JOIN_CODE_TAKEN",
  DEVICE_LIMIT_REACHED: "DEVICE_LIMIT_REACHED",
  INVALID_MERGE: "INVALID_MERGE",
  GROUP_NOT_FOUND: "GROUP_NOT_FOUND",
  MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
  EXPENSE_NOT_FOUND: "EXPENSE_NOT_FOUND",
  GROUP_ARCHIVED: "GROUP_ARCHIVED",
  GROUP_DELETED: "GROUP_DELETED",
  MEMBER_HAS_ACTIVITY: "MEMBER_HAS_ACTIVITY",
  LEDGER_ENTRY_NOT_FOUND: "LEDGER_ENTRY_NOT_FOUND",
  /** Mirrored from a group expense — edit it there, or the change gets reverted. */
  LEDGER_ENTRY_NOT_EDITABLE: "LEDGER_ENTRY_NOT_EDITABLE",
  /** A repayment that would exceed what is owed — rejected, never clamped. */
  REPAYMENT_EXCEEDS_PRINCIPAL: "REPAYMENT_EXCEEDS_PRINCIPAL",
  /** Repayments only make sense on a debt; a SPEND has nothing to repay. */
  NOT_A_DEBT: "NOT_A_DEBT",
  MEMBER_LIMIT_REACHED: "MEMBER_LIMIT_REACHED",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  DUPLICATE: "DUPLICATE",
  RATE_LIMITED: "RATE_LIMITED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const DEFAULT_CURRENCY = "INR";

module.exports = {
  GROUP_STATUS,
  LEDGER_ENTRY_TYPES,
  LEDGER_CATEGORIES,
  POINT_EVENT_TYPES,
  POINT_RULES,
  POINTS,
  REFERRAL_LEVEL_TYPES,
  SPLIT_TYPES,
  SPLIT_VALUE_UNITS,
  SETTLEMENT_METHODS,
  ACTIVITY_TYPES,
  BALANCE_STATUS,
  LIMITS,
  ERROR_CODES,
  DEFAULT_CURRENCY,
};
