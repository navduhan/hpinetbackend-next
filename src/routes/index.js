const express = require("express");
const annotationRoutes = require("./annotationRoutes");
const jobRoutes = require("./jobRoutes");
const resultRoutes = require("./resultRoutes");

const router = express.Router();

router.use(annotationRoutes);
router.use(jobRoutes);
router.use(resultRoutes);

module.exports = router;
