const { LEDGER_CATEGORIES } = require("../constants");

/**
 * Guess a ledger category from what someone typed.
 *
 * ## Why guessing is the right call here
 *
 * `Expense.category` exists but nothing populates it — there is no picker in the
 * expense form, and adding one would tax every entry with a decision most people
 * do not want to make (the PRD targets an expense added in under 15 seconds).
 *
 * That leaves mirrored group expenses landing in the personal ledger uncategorised
 * while manually-typed entries have one, which makes "what did I spend on food"
 * quietly wrong — it would answer only for the half of someone's spending they
 * typed by hand. Inferring from the description costs nothing and makes the two
 * halves comparable.
 *
 * ## What a wrong guess costs
 *
 * A train fare filed under "travel" when it was a work trip. Nothing structural:
 * the category is a label for grouping, never an input to a balance, a split or a
 * settlement. The entry stays editable, and an explicit category always wins.
 *
 * The rules mirror `frontend/src/utils/expenseIcon.js`, which has used the same
 * keywords to pick a glyph since before this existed. Two copies of a word list is
 * a real cost; the alternative is a shared package for ten regexes, and the
 * frontend copy also carries colours that mean nothing on a server.
 */

/**
 * Order matters: the first match wins, so narrower groups sit above broader ones —
 * "flight" before "travel", or a plane ticket becomes a taxi.
 */
const RULES = [
  { category: "TRAVEL", match: /\b(flight|plane|air ?fare|airline|indigo|boarding)\b/i },
  { category: "TRAVEL", match: /\b(hotel|stay|room|airbnb|hostel|lodge|resort)\b/i },
  {
    category: "FOOD",
    match: /\b(grocer\w*|supermarket|kirana|vegetab\w*|fruits?|milk|market|bigbasket|blinkit|zepto)\b/i,
  },
  {
    category: "FOOD",
    match:
      /\b(food|lunch|dinner|breakfast|brunch|restaurant|cafe|coffee|chai|tea|snacks?|pizza|burger|swiggy|zomato|dhaba|biryani|pav|bhaji|thali|samosa)\b/i,
  },
  {
    category: "TRAVEL",
    match:
      /\b(travel\w*|cab|taxi|uber|ola|auto|rickshaw|bus|train|metro|petrol|diesel|fuel|toll|parking)\b/i,
  },
  {
    category: "BILLS",
    match: /\b(bill|electric\w*|water|gas|internet|wifi|broadband|recharge|mobile|dth)\b/i,
  },
  { category: "RENT", match: /\b(rent|deposit|maintenance|society)\b/i },
  { category: "SHOPPING", match: /\b(shopping|clothes|amazon|flipkart|myntra|shoes|gift)\b/i },
  {
    category: "HEALTH",
    match: /\b(medicine|medical|doctor|pharmacy|hospital|chemist|health)\b/i,
  },
  {
    category: "ENTERTAINMENT",
    match: /\b(movie|cinema|tickets?|game|party|club|concert|museum|entry)\b/i,
  },
];

const VALID = new Set(LEDGER_CATEGORIES);

/**
 * @param description   free text — an expense's description
 * @param explicit      a category already on the record, which always wins
 * @returns one of LEDGER_CATEGORIES, or "" when nothing matched
 */
const inferCategory = (description, explicit = null) => {
  if (explicit && VALID.has(String(explicit).toUpperCase())) {
    return String(explicit).toUpperCase();
  }

  const text = String(description || "");
  if (!text.trim()) return "";

  const hit = RULES.find((rule) => rule.match.test(text));

  /**
   * No match returns empty rather than `OTHER`. "Uncategorised" and "explicitly
   * other" are different claims, and a spend-by-category breakdown that files
   * every unrecognised word under OTHER makes that bucket the largest one on the
   * screen while meaning nothing.
   */
  return hit ? hit.category : "";
};

module.exports = { inferCategory, RULES };
