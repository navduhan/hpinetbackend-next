function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ciContains(value) {
  return { $regex: new RegExp(escapeRegex(value), "i") };
}

function ciExact(value) {
  return { $regex: new RegExp(`^${escapeRegex(value)}$`, "i") };
}

module.exports = {
  escapeRegex,
  ciContains,
  ciExact
};
