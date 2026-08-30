/**
 * Smoke test for `/s/<code>` short links (services/shareLinkService.js).
 *
 * Creates a link, proves the same payload deduplicates to the same code, resolves
 * it back, checks a bad code refuses with the right error code, then deletes what
 * it made. Run with `npm run share:check`.
 */
const mongoose = require("mongoose");

const { connectDB } = require("../src/config/db");
const ShareLink = require("../src/models/shareLink");
const shareLinkService = require("../src/services/shareLinkService");
const { ERROR_CODES, SHARE_LINK_KINDS } = require("../src/constants");

const assert = (label, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) process.exitCode = 1;
};

(async () => {
  await connectDB();

  // A payload no real calculation will produce, so a rerun cannot collide with
  // anything a person made.
  const payload = `zzcheck${Date.now()}`;
  const kind = SHARE_LINK_KINDS.GROUP_EXPENSE_CALCULATOR;

  try {
    const first = await shareLinkService.create({ kind, payload });
    assert("creates a code", typeof first.code === "string" && first.code.length === 7);
    assert("the code is alphanumeric", /^[0-9A-Za-z]+$/.test(first.code));
    assert("the first create is not a reuse", first.reused === false);

    const second = await shareLinkService.create({ kind, payload });
    assert("the same payload returns the same code", second.code === first.code);
    assert("and reports itself as a reuse", second.reused === true);

    const resolved = await shareLinkService.resolve(first.code);
    assert("resolves back to the payload", resolved.payload === payload);
    assert("and to the right kind", resolved.kind === kind);

    const other = await shareLinkService.create({ kind, payload: `${payload}x` });
    assert("a different payload gets a different code", other.code !== first.code);

    const row = await ShareLink.findOne({ code: first.code }).lean();
    assert("counts the open", row.hits === 1);
    assert("stores an expiry", row.expiresAt > new Date());
    assert("stores no device or account", !("deviceId" in row) && !("userId" in row));

    let refusal = null;
    await shareLinkService.resolve("zzzzzzz").catch((error) => {
      refusal = error;
    });
    assert("an unknown code is a 404", refusal?.statusCode === 404);
    assert("with SHARE_LINK_NOT_FOUND", refusal?.code === ERROR_CODES.SHARE_LINK_NOT_FOUND);

    await ShareLink.deleteMany({ code: { $in: [first.code, other.code] } });
    assert("cleans up after itself", (await ShareLink.countDocuments({ code: first.code })) === 0);
  } finally {
    await mongoose.disconnect();
  }
})();
