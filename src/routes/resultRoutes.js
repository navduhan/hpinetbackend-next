const express = require("express");
const { asyncHandler } = require("../middleware/asyncHandler");
const {
  getResults,
  getNetwork,
  downloadResults,
  getDomainResults,
  getDomainDownload
} = require("../services/resultService");

const router = express.Router();

router.get(
  "/results/",
  asyncHandler(async (req, res) => {
    const data = await getResults({
      resultId: req.query.results,
      category: req.query.category,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/network/",
  asyncHandler(async (req, res) => {
    const data = await getNetwork({ resultId: req.query.results });
    res.json(data);
  })
);

router.get(
  "/download/",
  asyncHandler(async (req, res) => {
    const data = await downloadResults({ resultId: req.query.results });
    res.json(data);
  })
);

router.post(
  "/domain_results/",
  asyncHandler(async (req, res) => {
    const data = await getDomainResults(req.body || {});
    res.json(data);
  })
);

router.post(
  "/domain_download/",
  asyncHandler(async (req, res) => {
    const data = await getDomainDownload(req.body || {});
    res.json(data);
  })
);

module.exports = router;
