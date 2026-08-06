/**
 * Backfill: mirror group expenses people added *before* the feature existed
 * (docs/08-PERSONAL-LEDGER.md §12).
 *
 *   npm run mirror:backfill:dry            # show what would happen, write nothing
 *   npm run mirror:backfill                # do it
 *   node scripts/backfill-mirrors.js --email=someone@example.com
 *   node scripts/backfill-mirrors.js --since=2026-01-01
 *
 * Idempotent: the unique index on { ledgerId, sourceExpenseId } means a second
 * run writes nothing, so it is safe to re-run after a partial failure.
 *
 * Dry run first. This writes into people's private ledgers, and "I can see how
 * many rows before committing to them" is worth one extra command.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const ledgerMirrorService = require("../src/services/ledgerMirrorService");
const User = require("../src/models/user");
const config = require("../src/config/env");

const arg = (name) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const dryRun = process.argv.includes("--dry");
/**
 * Mirror expenses from browsers more than one account has signed in on.
 *
 * Off by default because the server cannot tell "one person, two Google
 * accounts" from "two flatmates, one laptop", and the second case means copying
 * somebody's spending into a stranger's private ledger. An operator can know
 * which it is; that is the only reason this flag exists.
 */
const allowShared = process.argv.includes("--allow-shared");
/** Repair a run made before the rule above existed. */
const repair = process.argv.includes("--repair-ambiguous");
const email = arg("email");
const sinceRaw = arg("since");
const since = sinceRaw ? new Date(sinceRaw) : null;

(async () => {
  if (sinceRaw && Number.isNaN(since.getTime())) {
    console.error(`--since="${sinceRaw}" is not a date. Use YYYY-MM-DD.`);
    process.exit(1);
  }

  await connectDB();

  console.log(dryRun ? "\nDRY RUN — nothing will be written\n" : "\nWriting mirrors\n");
  if (since) console.log(`Only expenses on or after ${since.toISOString().slice(0, 10)}\n`);

  /**
   * Worth saying out loud. The backfill writes rows the live hook would then be
   * responsible for keeping in step — and with the flag off, an edit in the group
   * would no longer update them. Backfilled history that silently stops tracking
   * is worse than no history.
   */
  if (!ledgerMirrorService.isEnabled()) {
    console.log(
      "WARNING: LEDGER_MIRROR_GROUP_EXPENSES is false, so new expenses are not\n" +
      "         being mirrored and these rows will not be kept in step with edits.\n"
    );
  }

  if (repair) {
    const removed = await ledgerMirrorService.removeAmbiguousMirrors({ dryRun });
    console.log(
      `  ${removed.rows} row(s) across ${removed.expenses} expense(s) sit in more than one\n` +
      `  ledger and cannot be attributed — ${dryRun ? "would be removed" : "removed"}.\n`
    );
    if (!dryRun && removed.rows > 0) {
      console.log("  Re-run the backfill to rewrite the ones that are unambiguous.\n");
    }
    await mongoose.disconnect();
    return;
  }

  if (allowShared) {
    console.log(
      "  --allow-shared: browsers used by more than one account are included.\n" +
      "  Only correct if those accounts belong to the same person.\n"
    );
  }

  let results;

  if (email) {
    const user = await User.findOne({ email: email.toLowerCase() })
      .select("_id email deviceIds")
      .lean();

    if (!user) {
      console.error(`No account with the email ${email}`);
      await mongoose.disconnect();
      process.exit(1);
    }

    results = [await ledgerMirrorService.backfillForUser(user, { since, dryRun, allowShared })];
  } else {
    results = await ledgerMirrorService.backfillAll({ since, dryRun, allowShared });
  }

  const touched = results.filter((row) => row.examined > 0 || row.ambiguous > 0);

  for (const row of touched) {
    console.log(
      `  ${row.email.padEnd(32)} ${String(row.written).padStart(4)} ${
        dryRun ? "would be written" : "written"
      }, ${row.skipped} skipped of ${row.examined} examined` +
      (row.ambiguous > 0 ? `  (${row.ambiguous} shared browser(s) excluded)` : "")
    );
  }

  const ambiguous = results.reduce((sum, row) => sum + row.ambiguous, 0);
  if (ambiguous > 0 && !allowShared) {
    console.log(
      `\n  ${ambiguous} browser(s) were skipped because more than one account has\n` +
      "  signed in on them. If those accounts are the same person, re-run with\n" +
      "  --allow-shared."
    );
  }

  const totals = results.reduce(
    (sum, row) => ({
      written: sum.written + row.written,
      skipped: sum.skipped + row.skipped,
      examined: sum.examined + row.examined,
    }),
    { written: 0, skipped: 0, examined: 0 }
  );

  console.log(
    `\n${results.length} account(s), ${touched.length} with group expenses.\n` +
    `${totals.examined} expenses examined, ${totals.written} ${
      dryRun ? "would be mirrored" : "mirrored"
    }, ${totals.skipped} skipped (already mirrored, or no share).\n`
  );

  if (dryRun && totals.written > 0) {
    console.log("Re-run without --dry to write them.\n");
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("FAILED:", err.stack || err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
