const mongoose = require("mongoose");
const { DEFAULT_CURRENCY } = require("../constants");

/**
 * One person's private book (docs/08-PERSONAL-LEDGER.md).
 *
 * ## Why this is not a group
 *
 * A group's settlement engine guarantees `Σ net balances = 0` and clearing in
 * ≤ N−1 transfers, and it can only do that because every divided rupee has a
 * payer and participants who are all members of that group. A personal loan has
 * one party inside the system and one outside it — feed it into a group and the
 * sum stops being zero, silently, for everyone in it. So this is a separate
 * collection with no path back into group balances.
 *
 * ## Why the owner is a user and not a device
 *
 * A group survives a cleared browser cache because somebody else still holds the
 * invite link. A personal ledger has nobody — which is why it is the one object
 * in this app that requires an account (docs/09-AUTH.md §1). Everything else
 * still works signed out.
 */
const ledgerSchema = new mongoose.Schema(
  {
    /**
     * Unique: one ledger per account. Naming them would imply a picker, and there
     * is nothing to pick between.
     */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    currency: {
      type: String,
      default: DEFAULT_CURRENCY,
      uppercase: true,
      trim: true,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ledger", ledgerSchema);
