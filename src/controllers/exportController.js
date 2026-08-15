const asyncHandler = require("../middlewares/asyncHandler");
const exportService = require("../services/exportService");

/**
 * The group's record as a downloadable file (docs/22-MONETIZATION.md §14 step 3).
 *
 * The one endpoint in this API that does not return the JSON envelope, because
 * what it returns is a file. `Content-Disposition: attachment` is what makes a
 * browser save it rather than render a wall of commas, and the filename in that
 * header is what it gets saved as.
 *
 * Errors still come back as JSON, through the ordinary error middleware — so a
 * refusal for a spent allowance is the same shape, with the same `details`, as
 * every other refusal, and the client can render the wall from it.
 */
exports.exportCsv = asyncHandler(async (req, res) => {
  const { type, from, to } = req.validatedQuery;

  const { filename, body, exportsLeft } = await exportService.build({
    group: req.group,
    type,
    from,
    to,
  });

  /**
   * The filename twice: `filename=` for every browser, `filename*=` for the ones
   * that honour RFC 5987 and can therefore handle a group called "Café" without
   * mangling it. Quoted, and the quotes stripped from the name itself, so a title
   * containing one cannot end the header early and inject another.
   */
  const ascii = filename.replace(/["\\]/g, "");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("Content-Length", body.length);
  /**
   * What is left of the allowance, in a header rather than the body — the body is
   * a spreadsheet and has nowhere to put it. The client reads this to say
   * "1 export left this month" without a second request.
   */
  res.setHeader("X-Exports-Left", String(exportsLeft));
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Exports-Left");

  return res.send(body);
});
