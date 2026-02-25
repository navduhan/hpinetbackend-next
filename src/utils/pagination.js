function parsePaging(page, size, options = {}) {
  const defaultSize = options.defaultSize ?? 10;
  const maxSize = options.maxSize ?? 1000;

  const rawPage = Number(page);
  const rawSize = Number(size);

  let pageIndex = 0;
  if (Number.isFinite(rawPage)) {
    if (rawPage <= 1 && rawPage >= 0) {
      pageIndex = 0;
    } else if (rawPage > 1) {
      pageIndex = Math.floor(rawPage - 1);
    }
  }

  const pageSize = Number.isFinite(rawSize) && rawSize > 0
    ? Math.min(Math.floor(rawSize), maxSize)
    : defaultSize;

  return {
    pageIndex,
    pageSize,
    skip: pageIndex * pageSize
  };
}

module.exports = { parsePaging };
