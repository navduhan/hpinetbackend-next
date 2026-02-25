const express = require("express");
const { mongoose } = require("../db/mongoose");

const router = express.Router();

router.get("/health", (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    mongoReadyState: mongoose.connection.readyState
  });
});

module.exports = router;
