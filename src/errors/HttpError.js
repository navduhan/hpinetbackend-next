class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status || 500;
    this.details = details;
  }
}

module.exports = { HttpError };
