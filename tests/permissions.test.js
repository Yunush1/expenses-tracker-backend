const test = require("node:test");
const assert = require("node:assert/strict");

const { assertCanModify } = require("../src/services/expenseService");
const { ERROR_CODES } = require("../src/constants");

/**
 * The rule that stops one member quietly rewriting another's expense — someone logs
 * ₹100 of groceries and it becomes ₹70, moving both their balances.
 *
 * Possession of the invite link makes you a member. It does not make you the author.
 */

const AUTHOR = "aaa1";
const OTHER = "bbb2";

const expense = { createdByMemberId: AUTHOR, description: "Milk and groceries" };

const member = (id, { isCreator = false } = {}) => ({ _id: id, isCreator, name: `M-${id}` });

test("the author can change their own expense", () => {
  assert.doesNotThrow(() => assertCanModify(expense, member(AUTHOR)));
});

test("another member cannot change it", () => {
  assert.throws(() => assertCanModify(expense, member(OTHER)), {
    code: ERROR_CODES.EXPENSE_OWNER_ONLY,
    statusCode: 403,
  });
});

test("the refusal says who to ask rather than just refusing", () => {
  assert.throws(
    () => assertCanModify(expense, member(OTHER)),
    (error) => {
      assert.match(error.message, /added this expense/i);
      assert.match(error.message, /group creator/i);
      return true;
    }
  );
});

test("the group creator can moderate anyone's expense", () => {
  // Otherwise an expense whose author lost their device could never be corrected.
  assert.doesNotThrow(() => assertCanModify(expense, member(OTHER, { isCreator: true })));
});

test("ids are compared as strings, not by reference", () => {
  // Mongoose hands back ObjectIds; a === comparison would silently deny the author.
  const objectIdish = { toString: () => AUTHOR };

  assert.doesNotThrow(() =>
    assertCanModify({ createdByMemberId: objectIdish }, { _id: AUTHOR, isCreator: false })
  );
  assert.doesNotThrow(() =>
    assertCanModify({ createdByMemberId: AUTHOR }, { _id: objectIdish, isCreator: false })
  );
});

test("an expense with no recorded author is creator-only", () => {
  // Nobody can claim authorship of it, so only the moderator can touch it.
  const orphan = { createdByMemberId: null };

  assert.throws(() => assertCanModify(orphan, member(OTHER)), {
    code: ERROR_CODES.EXPENSE_OWNER_ONLY,
  });
  assert.doesNotThrow(() => assertCanModify(orphan, member(OTHER, { isCreator: true })));
});
