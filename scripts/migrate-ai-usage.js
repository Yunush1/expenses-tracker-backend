/**
 * Widen the AI meter's unique index to include `feature`
 * (docs/22-MONETIZATION.md §14 step 5).
 *
 *   node scripts/migrate-ai-usage.js
 *
 * ## Why this needs a script at all
 *
 * Mongoose creates the new index on its own, but it will **not** drop the old one.
 * The old index is `{ day, model }` unique, and with it still in place the second
 * *feature* to run on one model on one day violates it — so Ria's answer is
 * recorded and the expense draft that follows it silently is not.
 *
 * The failure is quiet by design: `aiUsageService.record` never throws, because a
 * meter that can break a user's request is worse than a meter with a gap. That
 * makes this the kind of migration nobody notices skipping, which is exactly why
 * it prints what it did.
 *
 * Safe to run repeatedly, and safe to run before the app has ever started.
 */
require("../src/config/env");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const AiUsage = require("../src/models/aiUsage");

const OLD_INDEX = "day_1_model_1";

(async () => {
  await connectDB();

  const collection = AiUsage.collection;
  const before = await collection.indexes();

  console.log("--- indexes before ---");
  for (const index of before) console.log(`  ${index.name}${index.unique ? " (unique)" : ""}`);

  if (before.some((index) => index.name === OLD_INDEX)) {
    await collection.dropIndex(OLD_INDEX);
    console.log(`\n  dropped ${OLD_INDEX}`);
  } else {
    console.log(`\n  ${OLD_INDEX} is already gone — nothing to drop`);
  }

  // Builds `{ day, model, feature }` from the schema, if it is not there yet.
  await AiUsage.syncIndexes();

  /**
   * Rows written before `feature` existed have no such field, and a unique index
   * treats a missing key as null — so two of them on the same day and model would
   * collide with each other. Naming them explicitly costs one update and removes
   * the ambiguity.
   */
  const unlabelled = await collection.updateMany(
    { feature: { $exists: false } },
    { $set: { feature: "unknown" } }
  );

  if (unlabelled.modifiedCount > 0) {
    console.log(`  labelled ${unlabelled.modifiedCount} pre-existing bucket(s) as "unknown"`);
  }

  console.log("\n--- indexes after ---");
  for (const index of await collection.indexes()) {
    console.log(`  ${index.name}${index.unique ? " (unique)" : ""}`);
  }

  console.log("\n  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
