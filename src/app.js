const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const morgan = require("morgan");
const { CORS_ENABLED } = require("./config/env");
const { corsOptions } = require("./config/cors");
const apiRoutes = require("./routes");
const healthRoutes = require("./routes/healthRoutes");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

function createApp() {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(compression());
  app.use(morgan("dev"));

  if (CORS_ENABLED) {
    app.use(cors(corsOptions()));
    app.options("*", cors(corsOptions()));
  }

  app.use(express.urlencoded({ extended: true, limit: "5mb" }));
  app.use(express.json({ limit: "5mb" }));

  app.use(healthRoutes);
  app.use("/api", apiRoutes);
  app.use("/hpinetbackend/api", apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
