const { CORS_ALLOWED_ORIGINS } = require("./env");

function parseAllowedOrigins() {
  if (!CORS_ALLOWED_ORIGINS || CORS_ALLOWED_ORIGINS === "*") {
    return "*";
  }
  return CORS_ALLOWED_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

function corsOptions() {
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins === "*") {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
  };
}

module.exports = { corsOptions };
