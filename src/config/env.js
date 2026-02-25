const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config();

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() !== "false";
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const projectRoot = path.resolve(__dirname, "..", "..");

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: asNumber(process.env.PORT, 3816),
  MONGODB_URI: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/default",
  INTEROLOG_MONGO_DB: process.env.INTEROLOG_MONGO_DB || "hpinetdb",
  CORS_ENABLED: asBoolean(process.env.CORS_ENABLED, true),
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || "*").trim(),
  REQUEST_TIMEOUT_MS: asNumber(process.env.REQUEST_TIMEOUT_MS, 600000),
  GO_AUTO_DOWNLOAD_OBO: asBoolean(process.env.GO_AUTO_DOWNLOAD_OBO, true),
  GO_OBO_URL: process.env.GO_OBO_URL || "https://purl.obolibrary.org/obo/go/go-basic.obo",
  GO_OBO_PATH: path.resolve(projectRoot, process.env.GO_OBO_PATH || path.join("..", "data", "go-basic.obo")),
  GO_MONGO_COLLECTION: process.env.GO_MONGO_COLLECTION || "go_terms_v2",
  PHYLO_ROOT: path.resolve(projectRoot, process.env.PHYLO_ROOT || path.join("data", "phylo")),
  PHYLO_TMP_ROOT: path.resolve(projectRoot, process.env.PHYLO_TMP_ROOT || path.join("tmp", "phylo-jobs")),
  DIAMOND_BIN: process.env.DIAMOND_BIN || "/opt/miniconda3/envs/ml-gpu/bin/diamond",
  PHYLO_THREADS: asNumber(process.env.PHYLO_THREADS, 6)
};
