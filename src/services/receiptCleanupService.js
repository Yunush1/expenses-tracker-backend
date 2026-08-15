const Expense = require("../models/expense");
const receiptStorage = require("../utils/receiptStorage");
const logger = require("../utils/logger");

/**
 * Deletes scanned receipt photos that nothing points at.
 *
 * ## What it actually collects
 *
 * Abandoned scans. Somebody photographs a receipt, looks at the lines, decides not
 * to add them, and closes the form — the file is written and referenced by
 * nothing. Those are invisible to every screen in the app and would otherwise fill
 * a disk quietly, which is the worst way to run out of one.
 *
 * ## What it must never collect
 *
 * A photo attached to a real expense, however old. That image is part of a
 * financial record people settle money on, and deleting it after ninety days would
 * silently remove the evidence behind a line somebody is disputing. Retention here
 * bounds *litter*, not history — which is the same rule the rest of this codebase
 * follows: downgrades, deletions and expiries take features, never the ledger.
 *
 * So the query is the safety mechanism, and it is deliberately the widest possible
 * one: every attachment on every expense in the database, deleted rows included. A
 * soft-deleted expense can be restored by an operator, and its photo has to still
 * be there if it is.
 */

/** Every stored filename any expense refers to. */
const referencedNames = async () => {
  const rows = await Expense.find({ attachments: { $exists: true, $ne: [] } })
    .select("attachments")
    .lean();

  const names = new Set();

  for (const row of rows) {
    for (const url of row.attachments || []) {
      const name = receiptStorage.nameFromUrl(url);
      if (name) names.add(name);
    }
  }

  return names;
};

/**
 * One pass. Never throws — it runs on a timer beside other work, and a failure to
 * tidy up must not stop anything else on that tick.
 */
const run = async () => {
  if (!receiptStorage.isEnabled()) return { deleted: 0, kept: 0 };

  try {
    const referenced = await referencedNames();
    const result = await receiptStorage.sweep(referenced);

    if (result.deleted > 0) {
      logger.info(`[receipts] Swept ${result.deleted} unused photo(s), kept ${result.kept}`);
    }

    return result;
  } catch (error) {
    logger.warn(`[receipts] Sweep failed: ${error.message}`);
    return { deleted: 0, kept: 0 };
  }
};

module.exports = { run, referencedNames };
