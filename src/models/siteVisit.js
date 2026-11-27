const mongoose = require("mongoose");

/**
 * Daily visit counters for the public site: one document per
 * (day, dimension, key), incremented in place.
 *
 * Counters, not events, on purpose. Nothing here can identify a visitor: no IP,
 * no device id, no user agent, no cookie, no full referrer. A "visitor" is
 * counted when the browser itself says this is its first view of the day (a
 * date it keeps in localStorage), and a "new visitor" when it has never been
 * here before. The server stores only the totals, so there is no per-person
 * record to leak, export or delete.
 *
 *  - dim "total":  key "all", the whole site for the day
 *  - dim "path":   key a cleaned path such as "/blog/split-groceries" or "/g/:code"
 *  - dim "source": key one of search / social / ai / direct / app / other
 *
 * `day` is a `YYYY-MM-DD` string in the site's time zone (Asia/Kolkata by
 * default), so a day here is the same day the operator means when they say
 * "today", and string order is date order for range queries.
 */
const siteVisitSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    dim: { type: String, required: true, enum: ["total", "path", "source"] },
    key: { type: String, required: true, maxlength: 120 },
    views: { type: Number, default: 0 },
    visitors: { type: Number, default: 0 },
    newVisitors: { type: Number, default: 0 },
  },
  { timestamps: false, versionKey: false }
);

siteVisitSchema.index({ day: 1, dim: 1, key: 1 }, { unique: true });
siteVisitSchema.index({ dim: 1, day: 1 });

module.exports = mongoose.model("SiteVisit", siteVisitSchema);
