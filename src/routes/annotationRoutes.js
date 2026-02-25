const express = require("express");
const { asyncHandler } = require("../middleware/asyncHandler");
const {
  listAnnotation,
  listEffector,
  bundleAnnotation
} = require("../services/annotationService");

const router = express.Router();

router.get(
  "/go/",
  asyncHandler(async (req, res) => {
    const data = await listAnnotation({
      type: "go",
      species: req.query.species,
      sptype: req.query.sptype,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/kegg/",
  asyncHandler(async (req, res) => {
    const data = await listAnnotation({
      type: "kegg",
      species: req.query.species,
      sptype: req.query.sptype,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/interpro/",
  asyncHandler(async (req, res) => {
    const data = await listAnnotation({
      type: "interpro",
      species: req.query.species,
      sptype: req.query.sptype,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/local/",
  asyncHandler(async (req, res) => {
    const data = await listAnnotation({
      type: "local",
      species: req.query.species,
      sptype: req.query.sptype,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/tf/",
  asyncHandler(async (req, res) => {
    const data = await listAnnotation({
      type: "tf",
      species: req.query.species,
      sptype: req.query.sptype,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/effector/",
  asyncHandler(async (req, res) => {
    const data = await listEffector({
      species: req.query.species,
      page: req.query.page,
      size: req.query.size
    });
    res.json(data);
  })
);

router.get(
  "/annotation/",
  asyncHandler(async (req, res) => {
    const data = await bundleAnnotation({
      host: req.query.host,
      pathogen: req.query.pathogen,
      hid: req.query.hid,
      pid: req.query.pid
    });
    res.json(data);
  })
);

module.exports = router;
