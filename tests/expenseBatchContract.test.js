const test = require("node:test");
const assert = require("node:assert/strict");

const { createExpenseBatchSchema } = require("../src/validators/expenseValidators");
const { LIMITS, SPLIT_TYPES } = require("../src/constants");

/**
 * The batch endpoint's contract, checked against the exact shape the client sends.
 *
 * This is the seam most likely to drift: the multi-item form builds its payload by
 * hand, and a renamed field would fail at runtime as a generic validation error
 * rather than anywhere useful. Copied from MultiExpenseForm.submit().
 */

const MEMBER_A = "652f8a1b2c3d4e5f6a7b8ca0";
const MEMBER_B = "652f8a1b2c3d4e5f6a7b8ca1";

/** Exactly what the form posts. */
const clientPayload = (overrides = {}) => ({
  paidBy: MEMBER_A,
  expenseDate: "2026-08-04T09:30:00.000Z",
  items: [
    {
      description: "Groceries",
      amount: 566,
      participantIds: [MEMBER_A, MEMBER_B],
      clientRequestId: "0b3bb1d3-034b-4352-9023-ad779e1ad146",
    },
    {
      description: "Chai",
      amount: 55,
      participantIds: [MEMBER_A],
      clientRequestId: "6c1e2d3a-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    },
  ],
  ...overrides,
});

test("the payload the multi-item form builds is accepted as-is", () => {
  const parsed = createExpenseBatchSchema.parse(clientPayload());

  assert.equal(parsed.paidBy, MEMBER_A);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].description, "Groceries");
  assert.equal(parsed.items[0].amount, 566);
  assert.deepEqual(parsed.items[0].participantIds, [MEMBER_A, MEMBER_B]);
});

test("split type defaults to equal per item, so the form need not send it", () => {
  const parsed = createExpenseBatchSchema.parse(clientPayload());

  assert.equal(parsed.items[0].splitType, SPLIT_TYPES.EQUAL);
  assert.equal(parsed.items[0].notes, "");
});

test("an item may carry its own unequal split", () => {
  const parsed = createExpenseBatchSchema.parse(
    clientPayload({
      items: [
        {
          description: "Suite",
          amount: 900,
          participantIds: [MEMBER_A, MEMBER_B],
          splitType: SPLIT_TYPES.SHARES,
          splitValues: [
            { memberId: MEMBER_A, value: 2 },
            { memberId: MEMBER_B, value: 1 },
          ],
          clientRequestId: "aaa",
        },
      ],
    })
  );

  assert.equal(parsed.items[0].splitType, SPLIT_TYPES.SHARES);
  assert.equal(parsed.items[0].splitValues.length, 2);
});

test("amounts arrive as numbers or as the strings a form input produces", () => {
  const parsed = createExpenseBatchSchema.parse(
    clientPayload({
      items: [
        {
          description: "Cab",
          amount: "249.50",
          participantIds: [MEMBER_A],
          clientRequestId: "bbb",
        },
      ],
    })
  );

  assert.equal(parsed.items[0].amount, 249.5);
});

test("an empty batch is refused rather than silently doing nothing", () => {
  assert.throws(() => createExpenseBatchSchema.parse(clientPayload({ items: [] })));
});

test("the batch is bounded", () => {
  const item = {
    description: "Item",
    amount: 1,
    participantIds: [MEMBER_A],
  };

  const atLimit = clientPayload({ items: Array.from({ length: LIMITS.MAX_BATCH_ITEMS }, () => item) });
  const overLimit = clientPayload({
    items: Array.from({ length: LIMITS.MAX_BATCH_ITEMS + 1 }, () => item),
  });

  assert.doesNotThrow(() => createExpenseBatchSchema.parse(atLimit));
  assert.throws(() => createExpenseBatchSchema.parse(overLimit));
});

test("each item is validated, not just the first", () => {
  const payload = clientPayload();
  payload.items[1].amount = -5;

  assert.throws(() => createExpenseBatchSchema.parse(payload));
});

test("an item with no participants is refused", () => {
  const payload = clientPayload();
  payload.items[0].participantIds = [];

  assert.throws(() => createExpenseBatchSchema.parse(payload));
});

test("a future date is refused, as it is for a single expense", () => {
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  assert.throws(() => createExpenseBatchSchema.parse(clientPayload({ expenseDate: nextYear })));
});

test("the payer is required — it is what the mode exists to state once", () => {
  const payload = clientPayload();
  delete payload.paidBy;

  assert.throws(() => createExpenseBatchSchema.parse(payload));
});

test("per-item idempotency keys survive parsing", () => {
  // A retried batch must dedupe item by item, so the keys have to reach the service.
  const parsed = createExpenseBatchSchema.parse(clientPayload());

  assert.equal(parsed.items[0].clientRequestId, "0b3bb1d3-034b-4352-9023-ad779e1ad146");
  assert.notEqual(parsed.items[0].clientRequestId, parsed.items[1].clientRequestId);
});
