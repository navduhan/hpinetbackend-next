const { getAnnotationModels } = require("../models/annotationModels");
const { HttpError } = require("../errors/HttpError");
const { parsePaging } = require("../utils/pagination");
const { ciContains, ciExact } = require("../utils/regex");

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const CACHE_TTL_MS = asPositiveInt(process.env.ANNOTATION_CACHE_TTL_MS, 30000);
const CACHE_MAX_ENTRIES = asPositiveInt(process.env.ANNOTATION_CACHE_MAX_ENTRIES, 2000);
const queryCache = new Map();

function getCache(key) {
  const cached = queryCache.get(key);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    queryCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function setCache(key, value) {
  if (queryCache.has(key)) {
    queryCache.delete(key);
  }
  queryCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  while (queryCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = queryCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    queryCache.delete(oldestKey);
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveModel(type, sptype) {
  const models = getAnnotationModels();
  const typeMap = {
    go: models.GO,
    kegg: models.KEGG,
    interpro: models.Interpro,
    local: models.Local,
    tf: models.TF
  };
  const group = typeMap[type];
  if (!group) {
    throw new HttpError(400, `Unsupported annotation type: ${type}`);
  }
  const supportedTypes = Object.keys(group);
  const defaultType = supportedTypes.includes("pathogen")
    ? "pathogen"
    : supportedTypes[0];
  const selectedType = (sptype || defaultType).toLowerCase();
  const model = group[selectedType];
  if (!model) {
    throw new HttpError(400, `Invalid sptype '${selectedType}' for type '${type}'`);
  }
  return model;
}

function normalizeSpecies(species) {
  return String(species || "").trim();
}

async function fetchListWithCache({ model, filter, speciesKey, strategy, pageSize, skip }) {
  const collection = model.collection.name;
  const scope = `${collection}|${strategy}|${speciesKey.toLowerCase()}`;
  const dataKey = `${scope}|list|${skip}|${pageSize}`;
  const countKey = `${scope}|count`;

  const cachedData = getCache(dataKey);
  const cachedCount = getCache(countKey);
  if (cachedData && cachedCount !== undefined) {
    return { data: cachedData, total: cachedCount };
  }

  const countPromise = cachedCount !== undefined
    ? Promise.resolve(cachedCount)
    : model.countDocuments(filter);
  const dataPromise = cachedData
    ? Promise.resolve(cachedData)
    : model.find(filter).limit(pageSize).skip(skip).lean().exec();

  const [data, total] = await Promise.all([dataPromise, countPromise]);
  setCache(dataKey, data);
  setCache(countKey, total);

  return { data, total };
}

async function listBySpecies({ model, species, pageSize, skip }) {
  const speciesValue = normalizeSpecies(species);
  const exact = await fetchListWithCache({
    model,
    filter: { species: ciExact(speciesValue) },
    speciesKey: speciesValue,
    strategy: "exact",
    pageSize,
    skip
  });

  if (exact.total > 0) {
    return exact;
  }

  return fetchListWithCache({
    model,
    filter: { species: ciContains(speciesValue) },
    speciesKey: speciesValue,
    strategy: "contains",
    pageSize,
    skip
  });
}

async function listAnnotation({ type, species, sptype, page, size }) {
  const speciesValue = normalizeSpecies(species);
  if (!speciesValue) {
    throw new HttpError(400, "Missing required query param: species");
  }
  const model = resolveModel(type, sptype);
  const { pageSize, skip } = parsePaging(page, size, { defaultSize: 10, maxSize: 1000 });
  return listBySpecies({
    model,
    species: speciesValue,
    pageSize,
    skip
  });
}

async function listEffector({ species, page, size }) {
  const speciesValue = normalizeSpecies(species);
  if (!speciesValue) {
    throw new HttpError(400, "Missing required query param: species");
  }
  const models = getAnnotationModels();
  const { pageSize, skip } = parsePaging(page, size, { defaultSize: 10, maxSize: 1000 });
  return listBySpecies({
    model: models.Effector.pathogen,
    species: speciesValue,
    pageSize,
    skip
  });
}

async function bundleAnnotation({ host, pathogen, hid, pid }) {
  if (!host || !pathogen || !hid || !pid) {
    throw new HttpError(400, "Missing required query params: host, pathogen, hid, pid");
  }
  const models = getAnnotationModels();
  const hostFilter = { species: ciContains(host), gene: ciExact(hid) };
  const pathogenFilter = { species: ciContains(pathogen), gene: ciExact(pid) };

  const [
    hgo,
    pgo,
    hkegg,
    pkegg,
    hlocal,
    plocal,
    hint,
    pint,
    htf,
    peff
  ] = await Promise.all([
    models.GO.host.find(hostFilter).lean().exec(),
    models.GO.pathogen.find(pathogenFilter).lean().exec(),
    models.KEGG.host.find(hostFilter).lean().exec(),
    models.KEGG.pathogen.find(pathogenFilter).lean().exec(),
    models.Local.host.find(hostFilter).lean().exec(),
    models.Local.pathogen.find(pathogenFilter).lean().exec(),
    models.Interpro.host.find(hostFilter).lean().exec(),
    models.Interpro.pathogen.find(pathogenFilter).lean().exec(),
    models.TF.host.find(hostFilter).lean().exec(),
    models.Effector.pathogen.find(pathogenFilter).lean().exec()
  ]);

  return {
    hgo: dedupeRows(hgo),
    pgo: dedupeRows(pgo),
    hkegg: dedupeRows(hkegg),
    pkegg: dedupeRows(pkegg),
    hlocal: dedupeRows(hlocal),
    plocal: dedupeRows(plocal),
    hint: dedupeRows(hint),
    pint: dedupeRows(pint),
    htf: dedupeRows(htf),
    peff: dedupeRows(peff)
  };
}

async function findGenesFromKeyword({ anotType, ids, species, keyword }) {
  if (!keyword) {
    return [];
  }
  const models = getAnnotationModels();
  const speciesFilter = { species: ciContains(species || "") };
  const contains = (field) => ({ [field]: ciContains(keyword) });

  let model;
  let filter;

  if (anotType === "go") {
    model = models.GO[ids];
    filter = {
      ...speciesFilter,
      $or: [contains("gene"), contains("term"), contains("description"), contains("definition"), contains("evidence"), contains("ontology")]
    };
  } else if (anotType === "local") {
    model = models.Local[ids];
    filter = { ...speciesFilter, $or: [contains("gene"), contains("location")] };
  } else if (anotType === "pathway" || anotType === "kegg") {
    model = models.KEGG[ids];
    filter = { ...speciesFilter, $or: [contains("gene"), contains("pathway"), contains("description")] };
  } else if (anotType === "tf") {
    model = models.TF[ids];
    filter = { ...speciesFilter, $or: [contains("gene"), contains("tf_family")] };
  } else if (anotType === "interpro") {
    model = models.Interpro[ids];
    filter = {
      ...speciesFilter,
      $or: [contains("gene"), contains("interpro_id"), contains("sourcedb"), contains("domain"), contains("domain_description")]
    };
    const numeric = parseInt(keyword, 10);
    if (Number.isFinite(numeric)) {
      filter.$or.push({ length: numeric });
    }
  } else if (anotType === "virulence") {
    model = models.Effector[ids];
    filter = { ...speciesFilter, $or: [contains("gene"), contains("description"), contains("type")] };
  } else {
    return [];
  }

  if (!model) {
    return [];
  }

  const rows = await model.find(filter).select("gene").lean().exec();
  return Array.from(new Set(rows.map((row) => row.gene).filter(Boolean)));
}

module.exports = {
  listAnnotation,
  listEffector,
  bundleAnnotation,
  findGenesFromKeyword
};
