const { z } = require("zod");
const { paginationQuery } = require("./common");
const { ACTIVITY_TYPES } = require("../constants");

const listActivitiesQuery = paginationQuery.extend({
  type: z.nativeEnum(ACTIVITY_TYPES).optional(),
});

module.exports = { listActivitiesQuery };
