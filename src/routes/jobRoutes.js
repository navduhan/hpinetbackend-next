const express = require("express");
const { asyncHandler } = require("../middleware/asyncHandler");
const { toGeneCsv } = require("../utils/genes");
const { HttpError } = require("../errors/HttpError");
const { findGenesFromKeyword } = require("../services/annotationService");
const { runInterologJob } = require("../services/interologService");
const { runPhyloJob } = require("../services/phyloService");
const { runGoSimJob } = require("../services/goSimService");

const router = express.Router();

router.post(
  "/ppi",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    let geneCsv = "";

    if (body.searchType === "keyword" && body.keyword) {
      const species = body.ids === "host" ? body.host : body.pathogen;
      const genes = await findGenesFromKeyword({
        anotType: body.anotType,
        ids: body.ids,
        species,
        keyword: body.keyword
      });
      geneCsv = genes.join(",");
    } else {
      geneCsv = toGeneCsv(body.genes);
    }

    if (body.category !== "interolog" && body.category !== "consensus") {
      throw new HttpError(
        400,
        "Unsupported /api/ppi category. Supported values: interolog, consensus"
      );
    }

    const resultId = await runInterologJob(body, geneCsv);
    res.json(resultId);
  })
);

router.post(
  "/goppi",
  asyncHandler(async (req, res) => {
    const resultId = await runGoSimJob(req.body || {});
    res.json(resultId);
  })
);

router.post(
  "/phyloppi",
  asyncHandler(async (req, res) => {
    const resultId = await runPhyloJob(req.body || {});
    res.json(resultId);
  })
);

module.exports = router;
