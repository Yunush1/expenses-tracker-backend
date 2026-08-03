/**
 * One-off migration: `member.deviceId` (scalar) → `member.deviceIds[]`.
 *
 * The app works either way — memberRepository.findByDevice reads both — so this is
 * not urgent, but running it lets the legacy field and its index be dropped later.
 *
 *   npm run migrate:devices              # report what would change
 *   npm run migrate:devices -- --apply   # actually write
 *
 * Idempotent: re-running it after a successful pass finds nothing to do.
 */
require("dotenv").config({ path: `.env.${process.env.NODE_ENV || "development"}` });

const mongoose = require("mongoose");
const Member = require("../src/models/member");

const APPLY = process.argv.includes("--apply");

const run = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error("MONGO_URI is not set — check your .env file.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  // Only documents that still carry a legacy value not already in the array.
  const pending = await Member.find({
    deviceId: { $ne: null, $exists: true },
  }).lean();

  const needsWork = pending.filter(
    (member) => member.deviceId && !(member.deviceIds || []).includes(member.deviceId)
  );

  const alreadyCopied = pending.length - needsWork.length;

  console.log(`${pending.length} member(s) still hold a legacy deviceId`);
  console.log(`  ${needsWork.length} need the value copied into deviceIds[]`);
  console.log(`  ${alreadyCopied} already copied — the legacy field is just leftover\n`);

  if (!APPLY) {
    for (const member of needsWork.slice(0, 20)) {
      console.log(`  would copy  ${member.name.padEnd(20)} ${member.deviceId}`);
    }
    if (needsWork.length > 20) console.log(`  … and ${needsWork.length - 20} more`);
    console.log("\nRe-run with --apply to write these changes.");
    await mongoose.disconnect();
    return;
  }

  let copied = 0;
  for (const member of needsWork) {
    await Member.updateOne({ _id: member._id }, { $addToSet: { deviceIds: member.deviceId } });
    copied += 1;
  }

  // Cleared only after the copy, so an interrupted run can safely be repeated.
  const cleared = await Member.updateMany(
    { deviceId: { $ne: null, $exists: true } },
    { $unset: { deviceId: "" } }
  );

  console.log(`Copied ${copied} device id(s).`);
  console.log(`Cleared the legacy field on ${cleared.modifiedCount} member(s).`);

  const remaining = await Member.countDocuments({ deviceId: { $ne: null, $exists: true } });
  console.log(remaining === 0 ? "\nDone — nothing left on the legacy field." : `\n${remaining} left.`);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("\nMigration failed:", error.message);
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
