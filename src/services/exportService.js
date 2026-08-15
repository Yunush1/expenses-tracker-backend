const expenseRepository = require("../repositories/expenseRepository");
const settlementRepository = require("../repositories/settlementRepository");
const memberRepository = require("../repositories/memberRepository");
const entitlementService = require("./entitlementService");
const csv = require("../utils/csv");
const { toMajor } = require("../utils/money");
const { FEATURES } = require("../constants");
const logger = require("../utils/logger");

/**
 * The group's record, as a file (docs/22-MONETIZATION.md §14 step 3).
 *
 * ## Why the server builds it and not the browser
 *
 * The sheet export is client-side and correctly so — the browser already holds
 * every cell. Here it holds one month, because the expense screen is pinned to one
 * (docs/14-PERIODS.md), and the export people actually want is the *whole*
 * history: the year they lived together, handed to an accountant or a spreadsheet.
 *
 * There is a second reason and it is the harder one: this is a metered feature, so
 * the allowance has to be claimed somewhere a client cannot decline to call.
 *
 * ## What is in it
 *
 * One row per expense, with **a column per member** holding that member's share.
 * That shape is the point: it opens in Excel, each member's column sums to what
 * they owed, and the row total matches the amount — so the file answers "who owed
 * what, on which line" without anybody re-deriving a split. A flat list of
 * expenses with no shares would be a worse copy of what the screen already shows.
 *
 * Settlements are a separate export rather than extra rows, because they are a
 * different shape — two parties and no split — and mixing them into one sheet
 * would give every settlement a row of empty share columns.
 *
 * ## What it is not
 *
 * Not a PDF. §3 lists "CSV / PDF" and this is the CSV half: it is the format
 * money data is actually consumed in, and it needs no dependency, no layout and no
 * font. A PDF settlement summary is a real thing to want and is deliberately not
 * built here — it is a document, not an export, and it should be designed rather
 * than emitted.
 */

const TYPES = Object.freeze({ EXPENSES: "expenses", SETTLEMENTS: "settlements" });

/** `2026-08-14`, from a Date. Whole days, matching every other date in the API. */
const day = (date) => (date ? new Date(date).toISOString().slice(0, 10) : "");

/**
 * One row per expense; one column per member.
 *
 * Members are listed in join order and **include inactive ones**, because an
 * expense from March still has a share belonging to somebody who left in June, and
 * a column-less share would silently drop money out of a row that has to add up.
 */
const expenseRows = (expenses, members, currency) => {
  const nameById = new Map(members.map((member) => [String(member._id), member.name]));

  const headers = [
    "Date",
    "Description",
    "Category",
    "Paid by",
    `Amount (${currency})`,
    ...members.map((member) => `${member.name} (${currency})`),
    "Split",
    "Notes",
    "Added by",
    "Receipt",
  ];

  const rows = expenses.map((expense) => {
    const shareByMember = new Map(
      expense.shares.map((share) => [String(share.memberId), share.amountMinor])
    );

    return [
      csv.cell(day(expense.expenseDate)),
      csv.cell(expense.description),
      csv.cell(expense.category || ""),
      csv.cell(nameById.get(String(expense.paidBy)) || "Unknown"),
      csv.number(toMajor(expense.amountMinor, currency)),
      /**
       * An empty cell for someone who was not in this split, not a zero.
       *
       * A zero says "they owed nothing on this line", which is a claim; empty says
       * "they were not part of it", which is the truth. It also keeps a column's
       * average honest, and spreadsheets sum both identically.
       */
      ...members.map((member) => {
        const minor = shareByMember.get(String(member._id));
        return minor === undefined ? "" : csv.number(toMajor(minor, currency));
      }),
      csv.cell(expense.splitType),
      csv.cell(expense.notes || ""),
      csv.cell(nameById.get(String(expense.createdByMemberId)) || ""),
      csv.cell(expense.attachments?.[0] || ""),
    ];
  });

  return { headers, rows };
};

const settlementRows = (settlements, members, currency) => {
  const nameById = new Map(members.map((member) => [String(member._id), member.name]));

  const headers = [
    "Date",
    "From",
    "To",
    `Amount (${currency})`,
    "Method",
    "Note",
    "Recorded by",
  ];

  const rows = settlements.map((settlement) => [
    csv.cell(day(settlement.settledAt)),
    csv.cell(nameById.get(String(settlement.fromMemberId)) || "Unknown"),
    csv.cell(nameById.get(String(settlement.toMemberId)) || "Unknown"),
    csv.number(toMajor(settlement.amountMinor, currency)),
    csv.cell(settlement.method || ""),
    csv.cell(settlement.note || ""),
    csv.cell(nameById.get(String(settlement.recordedByMemberId)) || ""),
  ]);

  return { headers, rows };
};

/**
 * Build the file, claiming one export from the group's allowance.
 *
 * The claim comes first and the refund covers everything after it, for the same
 * reason receipt scanning works that way: somebody who got no file must not have
 * paid for one. Unlike a scan there is no provider here, so the only realistic
 * failure is the database — which makes the refund cheap and the guarantee free.
 */
const build = async ({ group, type = TYPES.EXPENSES, from, to }) => {
  const entitlement = await entitlementService.consume(group, FEATURES.EXPORT);

  try {
    const members = await memberRepository.findByGroup(group._id);
    const currency = group.currency;

    const { headers, rows, label } =
      type === TYPES.SETTLEMENTS
        ? {
            ...settlementRows(
              await settlementRepository.listAllByGroup(group._id, { from, to }),
              members,
              currency
            ),
            label: "settlements",
          }
        : {
            ...expenseRows(
              await expenseRepository.listAllByGroup(group._id, { from, to }),
              members,
              currency
            ),
            label: "expenses",
          };

    /**
     * The range in the filename, so two exports of one group do not overwrite each
     * other in a downloads folder — which is exactly what happens when somebody
     * pulls January and then February to compare them.
     */
    const range = from || to ? ` ${day(from) || "start"} to ${day(to) || "now"}` : "";

    logger.info(`[export] Group ${group._id} exported ${rows.length} ${label}`);

    return {
      filename: csv.safeFilename(`${group.name} ${label}${range}`, "csv"),
      body: csv.toCsvBuffer(headers, rows),
      rowCount: rows.length,
      exportsLeft: entitlement.remaining,
    };
  } catch (error) {
    await entitlementService.refund(group, FEATURES.EXPORT);
    throw error;
  }
};

module.exports = { build, TYPES, expenseRows, settlementRows };
