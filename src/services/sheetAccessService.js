const mongoose = require("mongoose");

const Sheet = require("../models/sheet");
const SheetGrant = require("../models/sheetGrant");
const SheetAccessRequest = require("../models/sheetAccessRequest");
const User = require("../models/user");
const mailService = require("./mailService");
const logger = require("../utils/logger");
const {
  ERROR_CODES,
  LIMITS,
  SHEET_ACCESS_SOURCE,
  SHEET_GRANTABLE_ROLES,
  SHEET_REQUEST_STATUS,
  SHEET_ROLES,
  SHEET_ROLE_RANK,
  SHEET_VISIBILITY,
} = require("../constants");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require("../errors");

/**
 * Who may do what with a sheet (docs/20-EXPENSE-SHEETS.md §4–6).
 *
 * Every authorisation decision in the sheets feature is made here and nowhere
 * else. `sheetService` never inspects a grant, a visibility or a role — it calls
 * `requireAccess` and is handed a resolved role. One file to read when asking
 * "who can see this?", and one file to change when the answer changes.
 */

const id = (value) => (value ? String(value) : null);

const atLeast = (role, minimum) =>
  Boolean(role) && SHEET_ROLE_RANK[role] >= SHEET_ROLE_RANK[minimum];

/**
 * The address this account has actually proved it holds — or null.
 *
 * The `emailVerified` gate is the security property of the whole sharing model;
 * models/sheetGrant.js explains at length why it is required here while being
 * explicitly *not* a gate for the personal ledger. In short: there the address
 * proves nothing and grants nothing, here it is the credential itself.
 *
 * Google sign-in arrives verified by construction. Password sign-up does not,
 * until the link is clicked — which is why the caller distinguishes "no grant"
 * from "a grant you cannot claim yet" and tells the person to verify.
 */
const verifiedEmailOf = (user) =>
  user && user.emailVerified && user.email ? user.email.trim().toLowerCase() : null;

/**
 * Find the grant that applies to this account, binding it on first use.
 *
 * Two lookups, in a fixed order that is itself the rule:
 *
 *   1. **By `userId`** — a grant already bound to this account. Always wins, and
 *      is the only thing consulted once binding has happened. This is what makes
 *      access survive an email change, and what stops a recycled corporate
 *      address inheriting the previous holder's permissions.
 *   2. **By verified email, among unbound grants only** — the invitation waiting
 *      for someone who had not opened the sheet yet. Binding it is the first and
 *      last time the address is used to decide anything.
 *
 * The bind is a conditional update (`userId: null` in the filter), so two
 * simultaneous first-opens cannot both claim it: one wins, the other re-reads and
 * finds it already bound to the same account, which is the same outcome.
 */
const findGrantFor = async (sheetId, user) => {
  if (!user) return null;

  const bound = await SheetGrant.findOne({ sheetId, userId: user._id });
  if (bound) return bound;

  const email = verifiedEmailOf(user);
  if (!email) return null;

  const claimed = await SheetGrant.findOneAndUpdate(
    { sheetId, email, userId: null },
    { $set: { userId: user._id, acceptedAt: new Date() } },
    { new: true }
  );

  if (claimed) {
    logger.info(`[SheetsAccessService] Grant on ${id(sheetId)} bound to ${id(user._id)} via ${email}`);
  }

  return claimed;
};

/**
 * Resolve what this caller may do — without throwing.
 *
 * Returns `{ role, source }`, where a null role means no access. Separated from
 * `requireAccess` because two callers need the *fact* rather than the exception:
 * the sheet list, which asks about many sheets at once, and the 403 path, which
 * has to decide between "you need access" and "verify your email first".
 */
const resolveAccess = async (sheet, user) => {
  if (user && id(sheet.ownerUserId) === id(user._id)) {
    return { role: SHEET_ROLES.OWNER, source: SHEET_ACCESS_SOURCE.OWNER, grant: null };
  }

  const grant = await findGrantFor(sheet._id, user);
  if (grant) return { role: grant.role, source: SHEET_ACCESS_SOURCE.GRANT, grant };

  /**
   * Public is checked **last**, so an explicit grant always wins over it.
   *
   * The order matters in one direction only, and it is the direction that
   * matters: a sheet that is public-for-viewing but grants someone EDITOR must
   * give that person EDITOR. Checking public first would silently demote every
   * named editor the moment the link was opened up.
   */
  if (sheet.visibility === SHEET_VISIBILITY.PUBLIC) {
    return { role: sheet.publicRole, source: SHEET_ACCESS_SOURCE.PUBLIC, grant: null };
  }

  return { role: null, source: null, grant: null };
};

/** The sheet itself, by share code. Throws 404 for a code that names nothing. */
const getSheetByShareCode = async (shareCode) => {
  const sheet = await Sheet.findOne({ shareCode, isDeleted: false });
  if (!sheet) {
    throw new NotFoundError("That sheet doesn't exist, or it was deleted.", ERROR_CODES.SHEET_NOT_FOUND);
  }
  return sheet;
};

/**
 * The gate every sheet route passes through.
 *
 * ## Why a denial is a 403 that says what the sheet is
 *
 * The error carries the sheet's title and owner. That is a deliberate, bounded
 * disclosure to someone who already holds the link — and it is what makes the
 * request-access screen possible: "Riya's *Q3 expenses* — ask for access" is a
 * usable dead end, while a bare 404 is a bug report. It leaks a title and a name,
 * never a number, a row or a member list. See models/sheetAccessRequest.js.
 *
 * ## The three ways this refuses, and why they are different errors
 *
 * - **Not signed in** → 401, so the client shows a sign-in prompt. Retrying after
 *   signing in is the fix.
 * - **Signed in, unverified email, and an invitation exists for that address** →
 *   `SHEET_EMAIL_UNVERIFIED`. They are one click away; sending them to "request
 *   access" would produce a request for permission they have already been given.
 * - **Signed in, genuinely no access** → `SHEET_ACCESS_DENIED`, which is the cue
 *   to offer the request flow.
 */
const requireAccess = async (shareCode, user, minimumRole = SHEET_ROLES.VIEWER) => {
  const sheet = await getSheetByShareCode(shareCode);
  const { role, source, grant } = await resolveAccess(sheet, user);

  if (atLeast(role, minimumRole)) return { sheet, role, source, grant };

  /**
   * Has read access, asked for more. A distinct error because retrying is
   * pointless and signing in again would not help — the client should show a
   * read-only grid rather than a wall.
   */
  if (role) {
    throw new ForbiddenError(
      minimumRole === SHEET_ROLES.OWNER
        ? "Only the owner can change sharing or delete this sheet."
        : "You have view-only access to this sheet.",
      minimumRole === SHEET_ROLES.OWNER ? ERROR_CODES.SHEET_OWNER_ONLY : ERROR_CODES.SHEET_EDITOR_ONLY
    );
  }

  const denial = new ForbiddenError(
    "You don't have access to this sheet yet.",
    ERROR_CODES.SHEET_ACCESS_DENIED
  );

  if (user) {
    // An invitation is sitting there unclaimed only because the address is
    // unproved. Say exactly that — it is the one refusal with a one-click fix.
    const address = (user.email || "").trim().toLowerCase();
    if (address && !user.emailVerified) {
      const waiting = await SheetGrant.exists({ sheetId: sheet._id, email: address, userId: null });
      if (waiting) {
        throw new ForbiddenError(
          `This sheet was shared with ${address}, but that address isn't verified yet. ` +
          "Verify it and reload to open the sheet.",
          ERROR_CODES.SHEET_EMAIL_UNVERIFIED
        );
      }
    }
  }

  /**
   * Attached to the error so the client can render the request-access screen
   * from the 403 itself, rather than making a second call for a sheet it has
   * just been told it cannot read. `ApiError.details` is emitted verbatim by the
   * error middleware — see there for what is safe to put in it.
   */
  denial.details = { sheet: await previewOf(sheet, user) };
  throw denial;
};

/**
 * The little that someone without access is shown: what the sheet is called, who
 * owns it, and whether they have already asked.
 *
 * Nothing derived from the contents — not the row count, not the column names,
 * not when it was last edited. Those would let a determined caller watch a
 * private sheet's activity through the door.
 */
const previewOf = async (sheet, user) => {
  const owner = await User.findById(sheet.ownerUserId).select("displayName email").lean();

  const pending = user
    ? await SheetAccessRequest.findOne({
      sheetId: sheet._id,
      userId: user._id,
      status: SHEET_REQUEST_STATUS.PENDING,
    }).lean()
    : null;

  return {
    title: sheet.title,
    shareCode: sheet.shareCode,
    ownerName: owner?.displayName || "",
    /**
     * The owner's address is shown so the person can chase them outside the app,
     * which is very often the fastest route. It is disclosed to someone holding
     * the link only, and it is the address they would have received the
     * invitation from anyway.
     */
    ownerEmail: owner?.email || "",
    requestPending: Boolean(pending),
    requestedAt: pending?.createdAt || null,
  };
};

/* -------------------------------- Sharing -------------------------------- */

/**
 * Share with an address, or change what an already-shared address may do.
 *
 * Upsert rather than insert-or-fail: typing an address that is already on the
 * list means "make it this role", which is what the UI's role dropdown does
 * anyway. Two grants for one person has no correct interpretation
 * (models/sheetGrant.js), so there is no path here that creates one.
 */
const share = async (shareCode, user, { email, role, message }) => {
  const { sheet } = await requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const address = email.trim().toLowerCase();

  /**
   * The owner cannot be demoted to a grant on their own sheet.
   *
   * Without this, an owner sharing with their own address would create a VIEWER
   * grant — harmless today, because ownership is checked first and wins, but it
   * would show up in the share list as "you (viewer)", which reads like a lock-out
   * that has not happened. Refusing is clearer than silently ignoring.
   */
  const owner = await User.findById(sheet.ownerUserId).select("email displayName").lean();
  if (owner?.email && owner.email.trim().toLowerCase() === address) {
    throw new BadRequestError("You already own this sheet.", ERROR_CODES.SHEET_ALREADY_SHARED);
  }

  const existing = await SheetGrant.findOne({ sheetId: sheet._id, email: address });

  if (!existing) {
    const count = await SheetGrant.countDocuments({ sheetId: sheet._id });
    if (count >= LIMITS.SHEET_MAX_GRANTS) {
      throw new ConflictError(
        `A sheet can be shared with at most ${LIMITS.SHEET_MAX_GRANTS} people.`,
        ERROR_CODES.SHEET_LIMIT_REACHED
      );
    }
  }

  const grant = await SheetGrant.findOneAndUpdate(
    { sheetId: sheet._id, email: address },
    {
      $set: { role },
      $setOnInsert: { invitedByUserId: user._id, sheetId: sheet._id, email: address },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  /**
   * The grant is committed before the email is attempted, and the send's result
   * is reported rather than acted on — see mailService for why nothing here is
   * allowed to fail because SMTP did.
   */
  const notified = await mailService.sendSheetInvite({
    to: address,
    sheetTitle: sheet.title,
    shareCode: sheet.shareCode,
    inviterName: user.displayName || owner?.displayName || "",
    role,
    message,
  });

  if (notified) {
    await SheetGrant.updateOne({ _id: grant._id }, { $set: { notifiedAt: new Date() } });
    grant.notifiedAt = new Date();
  }

  await touch(sheet._id);

  return { grant, notified, emailConfigured: mailService.isMailEnabled() };
};

const listAccess = async (shareCode, user) => {
  const { sheet } = await requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const [grants, requests, owner] = await Promise.all([
    SheetGrant.find({ sheetId: sheet._id }).sort({ createdAt: 1 }).lean(),
    SheetAccessRequest.find({ sheetId: sheet._id, status: SHEET_REQUEST_STATUS.PENDING })
      .sort({ createdAt: -1 })
      .lean(),
    User.findById(sheet.ownerUserId).select("displayName email photoURL").lean(),
  ]);

  return { sheet, grants, requests, owner, emailConfigured: mailService.isMailEnabled() };
};

const updateGrantRole = async (shareCode, user, grantId, role) => {
  const { sheet } = await requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const grant = await SheetGrant.findOneAndUpdate(
    { _id: grantId, sheetId: sheet._id },
    { $set: { role } },
    { new: true }
  );

  if (!grant) throw new NotFoundError("That person isn't on this sheet.", ERROR_CODES.SHEET_NOT_FOUND);

  await touch(sheet._id);

  // A demotion from editor to viewer takes effect on their open tab, rather than
  // leaving them typing into a grid whose next save comes back 403.
  require("../realtime/sheetEvents").accessChanged(sheet);

  return grant;
};

/**
 * Remove someone.
 *
 * A hard delete, unlike almost everything else in this codebase. A revoked
 * permission that lingers as a soft-deleted row is a permission that one careless
 * query brings back — and "we removed them but they could still see it" is the
 * failure that makes an access-control feature worthless. Nothing downstream
 * references a grant, so there is nothing to strand.
 */
const revokeGrant = async (shareCode, user, grantId) => {
  const { sheet } = await requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const grant = await SheetGrant.findOneAndDelete({ _id: grantId, sheetId: sheet._id });
  if (!grant) throw new NotFoundError("That person isn't on this sheet.", ERROR_CODES.SHEET_NOT_FOUND);

  await touch(sheet._id);

  /**
   * If they are connected right now, disconnect them from the sheet.
   *
   * Deleting the row stops the *next* request, but a socket that already joined
   * keeps its room membership and would carry on receiving every edit until they
   * happened to reload. Requiring a reload for a revocation to take effect is the
   * "we removed them but they could still see it" failure this whole feature is
   * supposed to prevent — see models/sheetGrant.js on why revocation is a hard
   * delete for exactly the same reason.
   *
   * Required lazily: sheetService already requires this module, so a top-level
   * import here would close a cycle through realtime/sheetEvents.
   */
  require("../realtime/sheetEvents").accessChanged(sheet);

  return { removedEmail: grant.email };
};

/* ---------------------------- Access requests ---------------------------- */

/**
 * "Let me in."
 *
 * Idempotent by design: asking twice returns the existing pending request rather
 * than creating a second one or erroring. The unique partial index makes that
 * true even under a double-tap, and the alternative — an error — would be a
 * confusing thing to show someone whose only crime was pressing the button again.
 */
const requestAccess = async (shareCode, user, { message, role }) => {
  const sheet = await getSheetByShareCode(shareCode);

  const { role: existingRole } = await resolveAccess(sheet, user);
  if (existingRole) {
    throw new BadRequestError("You already have access to this sheet.", ERROR_CODES.SHEET_ALREADY_SHARED);
  }

  const existing = await SheetAccessRequest.findOne({
    sheetId: sheet._id,
    userId: user._id,
    status: SHEET_REQUEST_STATUS.PENDING,
  });
  if (existing) return { request: existing, alreadyPending: true, notified: false };

  const expiresAt = new Date(Date.now() + LIMITS.SHEET_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);

  let request;
  try {
    request = await SheetAccessRequest.create({
      sheetId: sheet._id,
      userId: user._id,
      // Snapshotted deliberately — models/sheetAccessRequest.js explains why the
      // owner must decide on the values that were true when they were shown.
      email: (user.email || "").trim().toLowerCase(),
      name: user.displayName || "",
      message: message || "",
      requestedRole: role,
      expiresAt,
    });
  } catch (error) {
    // Lost a race with a concurrent identical request. The index did its job;
    // return the winner rather than surfacing a duplicate-key error to someone
    // who simply tapped twice.
    if (error?.code === 11000) {
      const winner = await SheetAccessRequest.findOne({
        sheetId: sheet._id,
        userId: user._id,
        status: SHEET_REQUEST_STATUS.PENDING,
      });
      if (winner) return { request: winner, alreadyPending: true, notified: false };
    }
    throw error;
  }

  // If the owner has the sheet open, the queue appears without a reload.
  require("../realtime/sheetEvents").accessRequested(sheet);

  const owner = await User.findById(sheet.ownerUserId).select("email displayName").lean();
  const notified = owner?.email
    ? await mailService.sendAccessRequest({
      to: owner.email,
      sheetTitle: sheet.title,
      shareCode: sheet.shareCode,
      requesterName: user.displayName || "",
      requesterEmail: user.email || "",
      message: message || "",
      role,
    })
    : false;

  return { request, alreadyPending: false, notified };
};

/**
 * Approve, and grant in the same call.
 *
 * The two are one action from the owner's point of view, and splitting them would
 * leave a window where a request reads "approved" while the person still cannot
 * open the sheet. The grant is written first for that reason: if the status
 * update failed afterwards the worst case is a stale pending request next to
 * working access, which is recoverable and visible. The reverse would be an
 * approval that granted nothing.
 */
const decideRequest = async (shareCode, user, requestId, { approve, role }) => {
  const { sheet } = await requireAccess(shareCode, user, SHEET_ROLES.OWNER);

  const request = await SheetAccessRequest.findOne({ _id: requestId, sheetId: sheet._id });
  if (!request) {
    throw new NotFoundError("That request no longer exists.", ERROR_CODES.SHEET_REQUEST_NOT_FOUND);
  }
  if (request.status !== SHEET_REQUEST_STATUS.PENDING) {
    throw new ConflictError(
      "That request was already answered.",
      ERROR_CODES.SHEET_REQUEST_ALREADY_DECIDED
    );
  }

  const grantedRole = approve ? role || request.requestedRole : null;

  if (approve) {
    await SheetGrant.findOneAndUpdate(
      { sheetId: sheet._id, email: request.email },
      {
        $set: {
          role: grantedRole,
          // Bound immediately: unlike an invitation typed by an owner, the
          // account here is known — they are the one who asked, from a signed-in
          // session. There is no address to wait on.
          userId: request.userId,
          acceptedAt: new Date(),
        },
        $setOnInsert: {
          sheetId: sheet._id,
          email: request.email,
          invitedByUserId: user._id,
          fromRequest: true,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  request.status = approve ? SHEET_REQUEST_STATUS.APPROVED : SHEET_REQUEST_STATUS.DECLINED;
  request.decidedByUserId = user._id;
  request.decidedAt = new Date();
  request.grantedRole = grantedRole;
  await request.save();

  if (request.email) {
    const notify = approve
      ? mailService.sendAccessApproved({
        to: request.email,
        sheetTitle: sheet.title,
        shareCode: sheet.shareCode,
        role: grantedRole,
        ownerName: user.displayName || "",
      })
      : mailService.sendAccessDeclined({ to: request.email, sheetTitle: sheet.title });

    // Not awaited into the response's critical path beyond this: the decision is
    // already committed, and mailService never rejects.
    await notify;
  }

  await touch(sheet._id);

  return { request, grantedRole };
};

/** Withdraw your own request. Only the person who asked may do this. */
const cancelRequest = async (shareCode, user) => {
  const sheet = await getSheetByShareCode(shareCode);

  const request = await SheetAccessRequest.findOneAndUpdate(
    { sheetId: sheet._id, userId: user._id, status: SHEET_REQUEST_STATUS.PENDING },
    { $set: { status: SHEET_REQUEST_STATUS.CANCELLED, decidedAt: new Date() } },
    { new: true }
  );

  if (!request) {
    throw new NotFoundError("You don't have a pending request for this sheet.", ERROR_CODES.SHEET_REQUEST_NOT_FOUND);
  }

  return request;
};

/**
 * Bump `lastActivityAt` so the sheet list sorts by "recently touched".
 *
 * Fire-and-forget on purpose: it is a sort key for a list, and failing a user's
 * edit because a denormalised timestamp could not be written would be absurd.
 */
const touch = (sheetId) =>
  Sheet.updateOne({ _id: sheetId }, { $set: { lastActivityAt: new Date() } }).catch((error) =>
    logger.warn(`[sheets] Could not touch ${id(sheetId)}: ${error.message}`)
  );

/**
 * Every sheet this account can reach: the ones it owns, plus the ones bound to
 * it by a grant.
 *
 * Unbound invitations are **not** included, and that is not an oversight. A grant
 * binds on first open (`findGrantFor`), and until then the server has no account
 * to attribute it to — only an address. Listing by unverified email would be the
 * same trust failure the binding rule exists to prevent, and listing by verified
 * email would silently bind every waiting invitation the first time someone
 * loaded their sheet list. The invitation email carries the link; opening it once
 * is what puts the sheet in this list.
 */
const listAccessibleSheets = async (user) => {
  const grants = await SheetGrant.find({ userId: user._id }).select("sheetId role").lean();
  const sharedIds = grants.map((grant) => grant.sheetId);
  const roleBySheetId = new Map(grants.map((grant) => [id(grant.sheetId), grant.role]));

  const sheets = await Sheet.find({
    isDeleted: false,
    $or: [{ ownerUserId: user._id }, { _id: { $in: sharedIds } }],
  })
    .sort({ lastActivityAt: -1 })
    .limit(200)
    .lean();

  return sheets.map((sheet) => ({
    sheet,
    role: id(sheet.ownerUserId) === id(user._id) ? SHEET_ROLES.OWNER : roleBySheetId.get(id(sheet._id)),
  }));
};

/** Owners see a badge when somebody is waiting. One query for the whole list. */
const pendingRequestCounts = async (sheetIds) => {
  if (sheetIds.length === 0) return new Map();

  const rows = await SheetAccessRequest.aggregate([
    {
      $match: {
        sheetId: { $in: sheetIds.map((value) => new mongoose.Types.ObjectId(String(value))) },
        status: SHEET_REQUEST_STATUS.PENDING,
      },
    },
    { $group: { _id: "$sheetId", count: { $sum: 1 } } },
  ]);

  return new Map(rows.map((row) => [id(row._id), row.count]));
};

module.exports = {
  atLeast,
  resolveAccess,
  requireAccess,
  getSheetByShareCode,
  previewOf,
  share,
  listAccess,
  updateGrantRole,
  revokeGrant,
  requestAccess,
  decideRequest,
  cancelRequest,
  listAccessibleSheets,
  pendingRequestCounts,
  touch,
  SHEET_GRANTABLE_ROLES,
};
