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
  // =========================
  // FOOD & GROCERIES
  // =========================
  {
    category: "FOOD",
    match: /\b(food|meal|lunch|dinner|breakfast|brunch|restaurant|cafe|coffee|chai|tea|juice|shake|snack|snacks|pizza|burger|sandwich|biryani|roll|momos|pasta|noodles|fries|ice ?cream|cake|pastry|sweet|dessert|dhaba|thali|samosa|vada|idli|dosa|poha|upma|paratha|roti|naan|rice|dal|sabzi|paneer|egg|chicken|mutton|fish|seafood|swiggy|zomato|eatclub|box8|faasos|behrouz|swish)\b/i,
  },
  {
    category: "FOOD",
    match: /\b(grocery|groceries|grocer|kirana|supermarket|mart|market|vegetable|vegetables|veggies|fruit|fruits|banana|apple|orange|potato|potatoes|aloo|onion|onions|tomato|tomatoes|tamatar|carrot|beans|peas|capsicum|cucumber|spinach|palak|cauliflower|cabbage|brinjal|eggplant|ladyfinger|okra|bhindi|garlic|ginger|lemon|lime|coriander|mint|milk|curd|yogurt|dahi|paneer|cheese|butter|ghee|bread|atta|flour|rice|wheat|dal|lentils|oil|mustard|sunflower|salt|sugar|jaggery|spices|masala|turmeric|haldi|chilli|pepper|cumin|jeera|tea|coffee|biscuits?|chips?|chocolate|eggs?|chicken|fish|mutton|bigbasket|blinkit|zepto|instamart|jiomart|dmart|reliance fresh)\b/i,
  },

  // =========================
  // TRAVEL
  // =========================
  {
    category: "TRAVEL",
    match: /\b(travel|trip|tour|vacation|holiday|flight|plane|airport|boarding|airfare|airline|indigo|vistara|air india|hotel|stay|room|airbnb|hostel|lodge|resort|cab|taxi|uber|ola|rapido|auto|rickshaw|metro|bus|train|railway|petrol|diesel|fuel|ev charging|charging station|toll|parking|fastag)\b/i,
  },

  // =========================
  // BILLS & UTILITIES
  // =========================
  {
    category: "BILLS",
    match: /\b(bill|electricity|electric|power|water|gas|lpg|cylinder|internet|wifi|broadband|fiber|mobile|phone bill|postpaid|prepaid|recharge|dth|airtel|jio|vi|bsnl|tataplay|dish tv)\b/i,
  },

  // =========================
  // RENT
  // =========================
  {
    category: "RENT",
    match: /\b(rent|house rent|flat rent|room rent|lease|deposit|maintenance|society|association|pg|hostel fee)\b/i,
  },

  // =========================
  // SHOPPING
  // =========================
  {
    category: "SHOPPING",
    match: /\b(shopping|amazon|flipkart|myntra|ajio|meesho|nykaa|ikea|clothes|dress|shirt|t-shirt|jeans|pant|trouser|kurta|saree|jacket|hoodie|shoes|slippers|sandals|watch|bag|wallet|belt|gift|jewellery|necklace|ring|earrings|perfume|mobile cover)\b/i,
  },

  // =========================
  // HEALTH
  // =========================
  {
    category: "HEALTH",
    match: /\b(medicine|medical|doctor|clinic|hospital|chemist|pharmacy|apollo|netmeds|1mg|lab|blood test|xray|mri|scan|health|vitamin|protein|supplement|tablet|capsule|syrup|injection|physiotherapy|dentist|eye test)\b/i,
  },

  // =========================
  // ENTERTAINMENT
  // =========================
  {
    category: "ENTERTAINMENT",
    match: /\b(movie|cinema|theatre|tickets?|game|gaming|playstation|xbox|steam|netflix|prime video|hotstar|spotify|concert|club|party|museum|amusement park|bowling|zoo|water park)\b/i,
  },

  // =========================
  // HOME
  // =========================
  {
    category: "HOME",
    match: /\b(cleaning|cleaner|cleaning liquid|phenyl|harpic|toilet cleaner|washroom cleaner|bathroom cleaner|floor cleaner|detergent|surf|rin|ariel|tide|comfort|bleach|mop|broom|dustbin|bucket|wiper|utensils|dishwash|vim|scrub|sponge|tissue|napkin|garbage bag|trash bag|air freshener|mosquito|good knight|hit spray|coil|candle|bulb|tube light|extension board|furniture|sofa|chair|table|bed|mattress|pillow|bedsheet|curtain)\b/i,
  },

  // =========================
  // PERSONAL CARE
  // =========================
  {
    category: "PERSONAL_CARE",
    match: /\b(shampoo|soap|body wash|face wash|face cream|cream|lotion|moisturizer|toothpaste|toothbrush|mouthwash|comb|razor|shaving|perfume|deodorant|deo|sanitary|pad|tampon|tissue|cotton|hair oil|hair gel|conditioner|lip balm|makeup|cosmetics)\b/i,
  },

  // =========================
  // EDUCATION
  // =========================
  {
    category: "EDUCATION",
    match: /\b(book|books|notebook|pen|pencil|eraser|marker|exam|course|tuition|fees|school|college|university|udemy|coursera|leetcode|interviewbit|certification)\b/i,
  },

  // =========================
  // OFFICE
  // =========================
  {
    category: "OFFICE",
    match: /\b(printer|paper|xerox|photocopy|office|stationery|laptop|keyboard|mouse|monitor|hdmi|usb|ssd|hard disk|pendrive|domain|hosting|server|aws|azure|gcp)\b/i,
  },

  // =========================
  // SUBSCRIPTIONS
  // =========================
  {
    category: "SUBSCRIPTIONS",
    match: /\b(subscription|netflix|prime|hotstar|spotify|youtube premium|chatgpt|openai|claude|gemini|perplexity|github|icloud|google one|dropbox|canva)\b/i,
  },

  // =========================
  // PETS
  // =========================
  {
    category: "PETS",
    match: /\b(dog|cat|puppy|kitten|pet|pet food|pedigree|whiskas|veterinary|vet)\b/i,
  },

  // =========================
  // BABY / KIDS
  // =========================
  {
    category: "KIDS",
    match: /\b(diapers?|pampers|baby food|formula|toys?|school bag|baby clothes|baby wipes)\b/i,
  },

  // =========================
  // FINANCE
  // =========================
  {
    category: "FINANCE",
    match: /\b(emi|loan|interest|insurance|sip|mutual fund|investment|credit card|bank charge|processing fee)\b/i,
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
