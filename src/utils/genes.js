function toGeneList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,\t]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toGeneCsv(value) {
  return toGeneList(value).join(",");
}

module.exports = {
  toGeneList,
  toGeneCsv
};
