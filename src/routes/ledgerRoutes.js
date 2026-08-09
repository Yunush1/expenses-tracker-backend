const express = require("express");

const ledgerController = require("../controllers/ledgerController");
const requireAuth = require("../middlewares/requireAuth");
const validate = require("../middlewares/validate");
const { writeLimiter } = require("../middlewares/rateLimiter");
const {
  createEntrySchema,
  updateEntrySchema,
  addRepaymentSchema,
  listEntriesQuery,
  entryParams,
  repaymentParams,
} = require("../validators/ledgerValidators");

const router = express.Router();

/**
 * The personal ledger — the only part of this API that requires an account
 * (docs/09-AUTH.md §1).
 *
 * `requireAuth` is applied to the whole router rather than per route, because a
 * ledger route that forgets it would expose one person's private records to
 * anyone. Applying it once at the mount makes "did I remember?" unanswerable in
 * the wrong direction.
 *
 * No `:ledgerId` anywhere: the owner is the verified token, so there is nothing
 * in the path to tamper with.
 */
router.use(requireAuth);

router.get("/", ledgerController.getSummary);

/**
 * Declared before "/entries/:id" so neither is shadowed by the other.
 *
 * Contacts are members of groups this account belongs to — the picker that
 * replaces typing a name (docs/17-MEMBER-IDENTITY.md §7).
 */
router.get("/contacts", ledgerController.listContacts);

/**
 * Code lookup. Behind `writeLimiter` despite being a GET: it is the one endpoint
 * that answers questions about *other* accounts, so it is the one worth
 * rate-limiting against someone walking the code space.
 */
router.get("/lookup", writeLimiter, ledgerController.lookupCode);

router.get("/claims", ledgerController.listClaims);
router.post(
  "/claims/:id/accept",
  writeLimiter,
  validate(entryParams, "params"),
  ledgerController.acceptClaim
);
router.post(
  "/claims/:id/decline",
  writeLimiter,
  validate(entryParams, "params"),
  ledgerController.declineClaim
);

router.get("/entries", validate(listEntriesQuery, "query"), ledgerController.listEntries);

router.post("/entries", writeLimiter, validate(createEntrySchema), ledgerController.createEntry);

router.patch(
  "/entries/:id",
  writeLimiter,
  validate(entryParams, "params"),
  validate(updateEntrySchema),
  ledgerController.updateEntry
);

router.delete(
  "/entries/:id",
  writeLimiter,
  validate(entryParams, "params"),
  ledgerController.deleteEntry
);

router.post(
  "/entries/:id/repayments",
  writeLimiter,
  validate(entryParams, "params"),
  validate(addRepaymentSchema),
  ledgerController.addRepayment
);

router.delete(
  "/entries/:id/repayments/:repaymentId",
  writeLimiter,
  validate(repaymentParams, "params"),
  ledgerController.removeRepayment
);

module.exports = router;
