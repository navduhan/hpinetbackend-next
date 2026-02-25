const express = require("express");
const { asyncHandler } = require("../middleware/asyncHandler");
const { toGeneCsv } = require("../utils/genes");
const { HttpError } = require("../errors/HttpError");
const { findGenesFromKeyword } = require("../services/annotationService");
const { runInterologJob } = require("../services/interologService");
const { runPhyloJob } = require("../services/phyloService");
const { runGoSimJob } = require("../services/goSimService");
const { toGeneList } = require("../utils/genes");

const router = express.Router();

function summarizePhyloPayload(body) {
  return {
    category: body?.category,
    hspecies: body?.hspecies,
    pspecies: body?.pspecies,
    method: body?.method,
    threshold: body?.threshold,
    hi: body?.hi,
    hc: body?.hc,
    he: body?.he,
    pi: body?.pi,
    pc: body?.pc,
    pe: body?.pe,
    hostGenesCount: toGeneList(body?.host_genes).length,
    pathogenGenesCount: toGeneList(body?.pathogen_genes).length
  };
}

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
    const body = req.body || {};
    try {
      const resultId = await runPhyloJob(body);
      res.json(resultId);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] /api/phyloppi failed`,
        summarizePhyloPayload(body),
        {
          message: error.message,
          details: error.details,
          stack: error.stack
        }
      );
      throw error;
    }
  })
);

module.exports = router;
