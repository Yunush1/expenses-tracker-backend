const SiteVisit = require("../models/siteVisit");
const Group = require("../models/group");
const Expense = require("../models/expense");
const Member = require("../models/member");
const User = require("../models/user");
const Settlement = require("../models/settlement");
const config = require("../config/env");
const { localDateString, startOfLocalDay } = require("../utils/localTime");
const { normalizePath, classifySource, dayRange } = require("../utils/siteStats");
const { GROUP_STATUS } = require("../constants");

/**
 * Site visits and product usage, for the operator's admin screen.
 *
 * Two halves with different sources:
 *
 *  - **Visits** come from the frontend's own beacon (`POST /api/stats/visit`)
 *    and are stored as daily counters (models/siteVisit.js). This is what
 *    answers "how many people came to the site", including the pre-rendered
 *    marketing and blog pages.
 *  - **Usage** is read from the collections the product already has: groups
 *    created, expenses added, people joining groups, accounts created,
 *    settlements recorded. Nothing new is collected for it.
 *
 * Google Analytics keeps running alongside. This exists so the numbers that
 * matter are one admin page away, not a GA4 report away, and so they include
 * visitors whose browsers block Google's tag.
 */

const TIME_ZONE = (process.env.STATS_TZ || config.expensePeriod?.timeZone || "Asia/Kolkata").trim();

/** Hostnames that count as "inside the site" when classifying a referrer. */
const SITE_HOSTS = (() => {
  const hosts = new Set(["splitly.shop", "localhost"]);
  for (const origin of config.clientUrls || []) {
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      /* not a URL; ignore */
    }
  }
  return [...hosts];
})();

const today = (now = new Date()) => localDateString(now, TIME_ZONE);

/**
 * Count one page view.
 *
 * Three upserted `$inc`s in one round trip: the day's total, the page, and (on
 * the first view of a visit only) where the visit came from. Unordered, so one
 * failing does not stop the others, and the caller never waits on it.
 */
const recordVisit = async ({ path, ref, firstToday, firstEver }, now = new Date()) => {
  const cleanPath = normalizePath(path);
  if (!cleanPath) return false;

  const day = today(now);
  const inc = {
    views: 1,
    visitors: firstToday ? 1 : 0,
    newVisitors: firstEver ? 1 : 0,
  };

  const ops = [
    { filter: { day, dim: "total", key: "all" }, inc },
    { filter: { day, dim: "path", key: cleanPath }, inc },
  ];

  // A source belongs to the arrival, not to every page clicked afterwards.
  if (firstToday) {
    const source = classifySource(ref, SITE_HOSTS);
    if (source) ops.push({ filter: { day, dim: "source", key: source }, inc });
  }

  await SiteVisit.bulkWrite(
    ops.map(({ filter, inc: $inc }) => ({
      updateOne: { filter, update: { $inc }, upsert: true },
    })),
    { ordered: false }
  );

  return true;
};

/** `{ "YYYY-MM-DD": count }` of documents created per local day since `since`. */
const countByDay = async (Model, since, extraMatch = {}) => {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: since }, ...extraMatch } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TIME_ZONE } },
        n: { $sum: 1 },
      },
    },
  ]);
  return Object.fromEntries(rows.map((row) => [row._id, row.n]));
};

/** Top keys of one visit dimension over the range, by views. */
const topKeys = async (dim, fromDay, limit) => {
  const rows = await SiteVisit.aggregate([
    { $match: { dim, day: { $gte: fromDay } } },
    {
      $group: {
        _id: "$key",
        views: { $sum: "$views" },
        visitors: { $sum: "$visitors" },
        newVisitors: { $sum: "$newVisitors" },
      },
    },
    { $sort: { views: -1, _id: 1 } },
    { $limit: limit },
  ]);
  return rows.map(({ _id, ...rest }) => ({ key: _id, ...rest }));
};

const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] || 0), 0);

/**
 * Everything the admin "Visitors & usage" screen shows, for the last `days`
 * days including today.
 */
const overview = async ({ days = 30 } = {}, now = new Date()) => {
  const todayKey = today(now);
  const range = dayRange(todayKey, days);
  const fromDay = range[0];
  const since = startOfLocalDay(new Date(Date.parse(`${fromDay}T12:00:00Z`)), TIME_ZONE);

  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);
  const notDeletedGroup = { status: { $ne: GROUP_STATUS.DELETED } };

  const [
    visitDocs,
    topPages,
    sources,
    groupsByDay,
    expensesByDay,
    membersByDay,
    signupsByDay,
    settlementsByDay,
    totalGroups,
    totalExpenses,
    totalMembers,
    totalUsers,
    activeGroups7,
    activeGroups30,
  ] = await Promise.all([
    SiteVisit.find({ dim: "total", key: "all", day: { $gte: fromDay } }).lean(),
    topKeys("path", fromDay, 20),
    topKeys("source", fromDay, 10),
    countByDay(Group, since),
    countByDay(Expense, since, { isDeleted: { $ne: true } }),
    countByDay(Member, since),
    countByDay(User, since),
    countByDay(Settlement, since),
    Group.countDocuments(notDeletedGroup),
    Expense.countDocuments({ isDeleted: { $ne: true } }),
    Member.estimatedDocumentCount(),
    User.estimatedDocumentCount(),
    Group.countDocuments({ ...notDeletedGroup, lastActivityAt: { $gte: weekAgo } }),
    Group.countDocuments({ ...notDeletedGroup, lastActivityAt: { $gte: monthAgo } }),
  ]);

  const visitsByDay = Object.fromEntries(visitDocs.map((doc) => [doc.day, doc]));

  const series = range.map((day) => ({
    day,
    views: visitsByDay[day]?.views || 0,
    visitors: visitsByDay[day]?.visitors || 0,
    newVisitors: visitsByDay[day]?.newVisitors || 0,
    groups: groupsByDay[day] || 0,
    expenses: expensesByDay[day] || 0,
    members: membersByDay[day] || 0,
    signups: signupsByDay[day] || 0,
    settlements: settlementsByDay[day] || 0,
  }));

  const pick = (rows) => ({
    views: sum(rows, "views"),
    visitors: sum(rows, "visitors"),
    newVisitors: sum(rows, "newVisitors"),
    groups: sum(rows, "groups"),
    expenses: sum(rows, "expenses"),
    members: sum(rows, "members"),
    signups: sum(rows, "signups"),
    settlements: sum(rows, "settlements"),
  });

  return {
    timeZone: TIME_ZONE,
    days,
    from: fromDay,
    to: todayKey,
    today: pick(series.slice(-1)),
    last7: pick(series.slice(-7)),
    range: pick(series),
    series,
    topPages,
    sources,
    allTime: {
      groups: totalGroups,
      expenses: totalExpenses,
      members: totalMembers,
      accounts: totalUsers,
    },
    activeGroups: { last7: activeGroups7, last30: activeGroups30 },
  };
};

module.exports = { recordVisit, overview, TIME_ZONE };
