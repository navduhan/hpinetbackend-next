const { HttpError } = require("../errors/HttpError");

function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  const req = _req;
  if (status >= 500) {
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${status}`,
      err.stack || err.message || err
    );
  }
  const payload = {
    error: err.message || "Internal server error"
  };
  if (err.details !== undefined) {
    payload.details = err.details;
  }
  res.status(status).json(payload);
}

module.exports = {
  notFoundHandler,
  errorHandler
};
