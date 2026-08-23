/**
 * One-off migration: hand back the join codes held by deleted groups.
 *
 *   npm run joincode:release              # report what would change
 *   npm run joincode:release -- --apply   # actually write
 *
 * ## What went wrong
 *
 * A deleted group kept its short code, and that made the code both invisible and
 * unusable at the same time. `lookupByJoinCode` refuses a group that is not
 * ACTIVE, so typing the code found nothing; the unique index on `{ joinCode: 1 }`
 * covers every group whatever its status, so creating a new group with it failed
 * on `E11000` — surfacing as a bare "That record already exists" 409 naming no
 * field, moments after the app had implied the code was free.
 *
 * The symptom people actually hit: delete "Flat 4B" with the code ROOM405, try to
 * make it again with ROOM405, and be told both that no such code exists and that
 * it is taken.
 *
 * `groupService.deleteGroup` now clears the code as part of deleting, so this only
 * has to catch the rows written before that. Nothing but the code is touched — the
 * invite code, the members, the expenses and the status all stay exactly as they
 * are, because a deleted group is still recoverable by an operator and this is not
 * that.
 *
 * Idempotent: a second run finds nothing to do.
 */
require("dotenv").config({ path: `.env.${process.env.NODE_ENV || "development"}` });

const mongoose = require("mongoose");
const Group = require("../src/models/group");
const { GROUP_STATUS } = require("../src/constants");

const APPLY = process.argv.includes("--apply");

const run = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error("MONGO_URI is not set — check your .env file.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const stuck = await Group.find({
    status: GROUP_STATUS.DELETED,
    joinCode: { $type: "string" },
  })
    .select("_id name joinCode updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  if (stuck.length === 0) {
    console.log("No deleted group is holding a join code. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`${stuck.length} deleted group(s) still hold a join code:\n`);
  for (const group of stuck.slice(0, 30)) {
    console.log(`  ${String(group.joinCode).padEnd(14)} ${group.name}`);
  }
  if (stuck.length > 30) console.log(`  … and ${stuck.length - 30} more`);

  /**
   * Two deleted groups can legitimately hold the same code once this has run
   * before — null is not unique-constrained — but two *live* ones cannot, and a
   * code released here may already have been taken by an active group in the
   * meantime. Reported rather than resolved: releasing is still correct, and the
   * active group keeps what it has.
   */
  const codes = stuck.map((group) => group.joinCode);
  const contested = await Group.find({
    joinCode: { $in: codes },
    status: { $ne: GROUP_STATUS.DELETED },
  })
    .select("joinCode name")
    .lean();

  if (contested.length > 0) {
    console.log(`\n  note: ${contested.length} of these are also held by a live group —`);
    console.log("  releasing the deleted one changes nothing for it.");
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to release them.");
    await mongoose.disconnect();
    return;
  }

  const result = await Group.updateMany(
    { status: GROUP_STATUS.DELETED, joinCode: { $type: "string" } },
    { $set: { joinCode: null } }
  );

  console.log(`\nReleased ${result.modifiedCount} join code(s).`);

  const remaining = await Group.countDocuments({
    status: GROUP_STATUS.DELETED,
    joinCode: { $type: "string" },
  });
  console.log(remaining === 0 ? "All clear." : `${remaining} still held — re-run to see why.`);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
