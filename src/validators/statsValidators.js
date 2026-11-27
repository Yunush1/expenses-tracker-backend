const { z } = require("zod");

/**
 * One page view from the site's own beacon.
 *
 * `ref` is the referring hostname only; the frontend strips the rest. The two
 * flags are the browser's own "first view today" / "first view ever" answers
 * (see models/siteVisit.js for why that is all the server keeps).
 */
const visitBody = z.object({
  path: z.string().trim().min(1).max(300),
  ref: z.string().trim().max(253).optional().default(""),
  firstToday: z.boolean().optional().default(false),
  firstEver: z.boolean().optional().default(false),
});

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

module.exports = { visitBody, overviewQuery };
