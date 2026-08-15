/**
 * Receipt scanning, as the group pays for it
 * (docs/10-AI-ASSISTANT.md §4.2, docs/22-MONETIZATION.md §14 step 7).
 *
 *   node scripts/check-receipt.js              # the metering, with a stubbed model
 *   node scripts/check-receipt.js path/to.jpg  # …and one real call to the provider
 *
 * Parsing is covered by tests/receiptScan.test.js without a database. What is
 * checked here is the money: that a scan is claimed exactly once, that the group
 * gets it back when the provider fails, and that running out stops the shortcut
 * and nothing else.
 *
 * The model is stubbed by default on purpose. Every real call to a vision model
 * costs roughly ₹2 (docs/10 §7), and a smoke script nobody hesitates to run is
 * worth more than one that bills the operator for running it.
 */
require("../src/config/env");

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const groupService = require("../src/services/groupService");
const entitlementService = require("../src/services/entitlementService");
const aiProvider = require("../src/services/ai/aiProvider");
const receiptScan = require("../src/services/ai/receiptScan");
const receiptService = require("../src/services/receiptService");
const config = require("../src/config/env");
const Group = require("../src/models/group");
const Member = require("../src/models/member");
const Activity = require("../src/models/activity");
const Entitlement = require("../src/models/entitlement");
const FeatureUsage = require("../src/models/featureUsage");
const { FEATURES, ERROR_CODES } = require("../src/constants");

const check = (label, actual, want) =>
  console.log(
    `  ${actual === want ? "PASS" : "FAIL"}  ${label}${actual === want ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`
  );

const refusalCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code || "THREW";
  }
};

/** A 1×1 JPEG, big enough to pass the size floor. Never actually decoded here. */
const stubImage = `data:image/jpeg;base64,${"A".repeat(4000)}`;

/** What the group has used of its scan allowance this month. */
const usedScans = async (groupId) => {
  const bucket = await FeatureUsage.findOne({
    groupId,
    feature: FEATURES.RECEIPT_SCAN,
    period: entitlementService.periodKey(),
  });
  return bucket?.used || 0;
};

/**
 * Put the meter back to a known number.
 *
 * Needed because the free allowance is genuinely small — three a month — and this
 * script exercises more cases than a free group has scans. Setting the meter
 * directly rather than granting a plan keeps each section testing the free tier,
 * which is the one every group is on.
 */
const setScans = (groupId, used) =>
  FeatureUsage.updateOne(
    { groupId, feature: FEATURES.RECEIPT_SCAN, period: entitlementService.periodKey() },
    { $set: { used } },
    { upsert: true }
  );

(async () => {
  await connectDB();

  const realImagePath = process.argv[2];
  const stamp = Date.now();

  const created = await groupService.createGroup({
    name: "Flat 302",
    currency: "INR",
    creatorName: "Aman",
    deviceId: `receipt-${stamp}`,
  });

  const group = await Group.findById(created.group.id);

  /**
   * The provider is replaced rather than mocked at the network layer, so the
   * service, the entitlement claim and the refund path are all the real ones.
   */
  const realComplete = aiProvider.complete;
  const realVisionConfigured = aiProvider.isVisionConfigured;
  let stubbedReply = JSON.stringify({
    isReceipt: true,
    merchant: "Big Bazaar",
    date: new Date().toISOString().slice(0, 10),
    currencyCode: "INR",
    total: "450.00",
    items: [
      { description: "Milk 1L", amount: "60.00" },
      { description: "Bread", amount: "40.00" },
      { description: "Rice 5kg", amount: "350.00" },
    ],
    unresolved: [],
  });
  let shouldFail = false;

  aiProvider.isVisionConfigured = () => true;
  aiProvider.complete = async () => {
    if (shouldFail) throw new Error("provider exploded");
    return stubbedReply;
  };

  console.log("--- validation happens before anything is charged for ---");
  const notAnImage = await refusalCode(() =>
    receiptService.scan({ group, image: "data:application/pdf;base64,AAAA" })
  );
  check("a PDF is refused", notAnImage, ERROR_CODES.VALIDATION_ERROR);
  check("and it cost nothing", await usedScans(group._id), 0);

  const huge = await refusalCode(() =>
    receiptService.scan({
      group,
      image: `data:image/jpeg;base64,${"A".repeat(config.ai.maxImageBytes * 2)}`,
    })
  );
  check("an oversized photo is refused", huge, ERROR_CODES.VALIDATION_ERROR);
  check("and it cost nothing either", await usedScans(group._id), 0);

  console.log("\n--- a good scan costs exactly one ---");
  const result = await receiptService.scan({ group, image: stubImage });
  check("it read the receipt", result.isReceipt, true);
  check("three lines", result.items.length, 3);
  check("amounts are in minor units too", result.items[0].amountMinor, 6000);
  check("and categorised like a typed expense", result.items[0].category, "FOOD");
  check("the lines add up to the printed total", result.balances, true);
  check("one scan used", await usedScans(group._id), 1);
  check(
    "and the response says what is left",
    result.scansLeft,
    config.entitlement.free.receiptScans - 1
  );

  console.log("\n--- a mismatch against the total is reported, never balanced ---");
  stubbedReply = JSON.stringify({
    isReceipt: true,
    total: "500.00",
    items: [{ description: "Milk", amount: "60.00" }],
    unresolved: ["the second line was too faint"],
  });

  const mismatch = await receiptService.scan({ group, image: stubImage });
  check("the mismatch is flagged", mismatch.balances, false);
  check("by exactly the difference", mismatch.differenceMinor, 44000);
  check("no balancing line was invented", mismatch.items.length, 1);
  check("and what it could not read is named", mismatch.unresolved.length > 0, true);

  console.log("\n--- an unreadable amount is dropped, never turned into a zero ---");
  stubbedReply = JSON.stringify({
    isReceipt: true,
    total: null,
    items: [
      { description: "Milk", amount: "60.00" },
      { description: "Smudged line", amount: "??" },
      { description: "Discount", amount: "-40.00" },
    ],
    unresolved: [],
  });

  const partial = await receiptService.scan({ group, image: stubImage });
  check("only the readable line survives", partial.items.length, 1);
  check("no zero-amount rows", partial.items.every((item) => item.amountMinor > 0), true);
  check("and the drops are explained", partial.unresolved.length > 0, true);

  console.log("\n--- a photo that is not a receipt still costs a scan ---");
  // The model was called and the bill for it is real. A free retry on "not a
  // receipt" is a free vision call for anybody who wants one.
  await setScans(group._id, 0);
  stubbedReply = JSON.stringify({ isReceipt: false });
  const before = await usedScans(group._id);
  const notReceipt = await receiptService.scan({ group, image: stubImage });
  check("it says so plainly", notReceipt.isReceipt, false);
  check("and it was charged", await usedScans(group._id), before + 1);

  console.log("\n--- THE POINT: a provider failure hands the scan back ---");
  await setScans(group._id, 0);
  shouldFail = true;
  const beforeFailure = await usedScans(group._id);
  const failed = await refusalCode(() => receiptService.scan({ group, image: stubImage }));
  check("the caller is told, in words that offer a way through", failed, ERROR_CODES.FEATURE_UNAVAILABLE);
  check("and the group was not charged", await usedScans(group._id), beforeFailure);
  shouldFail = false;

  console.log("\n--- running out stops the shortcut and nothing else ---");
  await setScans(group._id, config.entitlement.free.receiptScans);

  const exhausted = await refusalCode(() => receiptService.scan({ group, image: stubImage }));
  check("the wall appears", exhausted, ERROR_CODES.FEATURE_LIMIT_REACHED);

  // The rule that matters more than the wall: the ledger is untouched by it.
  const stillWorks = await groupService.getSummary(group, await Member.findOne({ groupId: group._id }));
  check("the group still works", Boolean(stillWorks.group), true);
  check("and it knows scanning is spent", stillWorks.entitlement.features.receiptScan, false);

  console.log("\n--- a plan brings it back ---");
  await entitlementService.grant({ group, days: 30 });
  const withPlan = await entitlementService.forGroup(group._id);
  check("scanning is available again", withPlan.features[FEATURES.RECEIPT_SCAN], true);
  check(
    "with the paid allowance, less what was used",
    withPlan.limits.receiptScansLeft,
    config.entitlement.paid.receiptScans - config.entitlement.free.receiptScans
  );

  console.log("\n--- an unconfigured server offers nothing rather than failing ---");
  aiProvider.isVisionConfigured = () => false;
  const off = await refusalCode(() => receiptService.scan({ group, image: stubImage }));
  check("503, not a crash", off, ERROR_CODES.FEATURE_UNAVAILABLE);
  aiProvider.isVisionConfigured = () => true;

  /* --------------------------- One real call ---------------------------- */

  if (realImagePath) {
    console.log("\n--- a real photograph, through the real provider ---");
    aiProvider.complete = realComplete;
    aiProvider.isVisionConfigured = realVisionConfigured;

    if (!aiProvider.isVisionConfigured()) {
      console.log("  SKIP  AI_VISION_MODEL is not set");
    } else {
      const bytes = fs.readFileSync(path.resolve(realImagePath));
      const mime = realImagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

      const invalid = receiptScan.validateImage(dataUrl);
      if (invalid) {
        console.log(`  FAIL  ${invalid}`);
      } else {
        const real = await receiptScan.scanReceipt({ dataUrl, currency: "INR" });
        console.log(`  merchant: ${real.merchant} · date: ${real.date} · total: ${real.total}`);
        for (const item of real.items) console.log(`    ${item.description} — ${item.amount}`);
        if (real.unresolved.length > 0) console.log(`  unresolved: ${real.unresolved.join("; ")}`);
        check("it read something", real.items.length > 0, true);
      }
    }
  } else {
    console.log("\n  (pass a photo path to make one real provider call)");
  }

  console.log("\n--- cleanup ---");
  aiProvider.complete = realComplete;
  aiProvider.isVisionConfigured = realVisionConfigured;

  await FeatureUsage.deleteMany({ groupId: group._id });
  await Entitlement.deleteMany({ groupId: group._id });
  await Activity.deleteMany({ groupId: group._id });
  await Member.deleteMany({ groupId: group._id });
  await Group.deleteOne({ _id: group._id });
  console.log("  done");
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("FAILED:", e.stack || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
