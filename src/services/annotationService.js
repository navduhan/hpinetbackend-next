const { getAnnotationModels } = require("../models/annotationModels");
const { useDb } = require("../db/mongoose");
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

function buildPlantSnapshotKey(host, pathogen) {
  return `${String(host || "").trim().toLowerCase()}__${String(pathogen || "").trim().toLowerCase()}`;
}

function getPlantSnapshotCollection() {
  const hpinetDb = useDb("hpinetdb");
  return hpinetDb.collection("plant_snapshots");
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

async function countBySpeciesWithFallback(model, speciesValue) {
  const exactFilter = { species: ciExact(speciesValue) };
  const exactCount = await model.countDocuments(exactFilter);
  if (exactCount > 0) {
    const genes = await model.distinct("gene", exactFilter);
    return {
      annotations: exactCount,
      proteins: genes.length
    };
  }

  const containsFilter = { species: ciContains(speciesValue) };
  const containsCount = await model.countDocuments(containsFilter);
  const genes = await model.distinct("gene", containsFilter);
  return {
    annotations: containsCount,
    proteins: genes.length
  };
}

async function computePlantSnapshot({ host, pathogen }) {
  const hostSpecies = normalizeSpecies(host);
  const pathogenSpecies = normalizeSpecies(pathogen);
  if (!hostSpecies || !pathogenSpecies) {
    throw new HttpError(400, "Missing required params: host, pathogen");
  }

  const models = getAnnotationModels();
  const db = useDb("hpinetdb");
  const domainCollection = `${hostSpecies}_${pathogenSpecies}`.toLowerCase().endsWith("_domains")
    ? `${hostSpecies}_${pathogenSpecies}`.toLowerCase()
    : `${hostSpecies}_${pathogenSpecies}`.toLowerCase() + "_domains";

  const [
    hostGo,
    pathogenGo,
    hostKegg,
    pathogenKegg,
    hostInterpro,
    pathogenInterpro,
    hostLocal,
    pathogenLocal,
    hostTf,
    pathogenEffector,
    domainInteractions,
    domainHostProteins,
    domainPathogenProteins
  ] = await Promise.all([
    countBySpeciesWithFallback(models.GO.host, hostSpecies),
    countBySpeciesWithFallback(models.GO.pathogen, pathogenSpecies),
    countBySpeciesWithFallback(models.KEGG.host, hostSpecies),
    countBySpeciesWithFallback(models.KEGG.pathogen, pathogenSpecies),
    countBySpeciesWithFallback(models.Interpro.host, hostSpecies),
    countBySpeciesWithFallback(models.Interpro.pathogen, pathogenSpecies),
    countBySpeciesWithFallback(models.Local.host, hostSpecies),
    countBySpeciesWithFallback(models.Local.pathogen, pathogenSpecies),
    countBySpeciesWithFallback(models.TF.host, hostSpecies),
    countBySpeciesWithFallback(models.Effector.pathogen, pathogenSpecies),
    db.collection(domainCollection).countDocuments({}),
    db.collection(domainCollection).distinct("Host_Protein"),
    db.collection(domainCollection).distinct("Pathogen_Protein")
  ]);

  const snapshot = {
    host: hostSpecies,
    pathogen: pathogenSpecies,
    domain: {
      interactions: domainInteractions,
      hostProteins: domainHostProteins.length,
      pathogenProteins: domainPathogenProteins.length
    },
    hostCounts: {
      go: hostGo,
      kegg: hostKegg,
      interpro: hostInterpro,
      local: hostLocal,
      tf: hostTf
    },
    pathogenCounts: {
      go: pathogenGo,
      kegg: pathogenKegg,
      interpro: pathogenInterpro,
      local: pathogenLocal,
      effector: pathogenEffector
    }
  };

  return {
    key: buildPlantSnapshotKey(hostSpecies, pathogenSpecies),
    snapshot
  };
}

async function upsertPlantSnapshot({ host, pathogen }) {
  const { key, snapshot } = await computePlantSnapshot({ host, pathogen });
  const collection = getPlantSnapshotCollection();
  await collection.createIndex({ key: 1 }, { unique: true });
  await collection.updateOne(
    { key },
    {
      $set: {
        key,
        host: snapshot.host,
        pathogen: snapshot.pathogen,
        snapshot,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
  return snapshot;
}

async function getPlantSnapshot({ host, pathogen, allowLiveFallback = true }) {
  const hostSpecies = normalizeSpecies(host);
  const pathogenSpecies = normalizeSpecies(pathogen);
  if (!hostSpecies || !pathogenSpecies) {
    throw new HttpError(400, "Missing required query params: host, pathogen");
  }

  const key = buildPlantSnapshotKey(hostSpecies, pathogenSpecies);
  const collection = getPlantSnapshotCollection();
  const cached = await collection.findOne({ key }, { projection: { _id: 0, snapshot: 1 } });
  if (cached?.snapshot) {
    return cached.snapshot;
  }

  if (!allowLiveFallback) {
    throw new HttpError(404, "Snapshot not available. Rebuild plant snapshots first.");
  }

  return upsertPlantSnapshot({ host: hostSpecies, pathogen: pathogenSpecies });
}

async function rebuildPlantSnapshots({ host, pathogen }) {
  const hostSpecies = normalizeSpecies(host);
  const pathogenSpecies = normalizeSpecies(pathogen);
  const sourceDb = useDb("hpinetdb");
  const collection = getPlantSnapshotCollection();
  await collection.createIndex({ key: 1 }, { unique: true });

  const targets = [];
  if (hostSpecies && pathogenSpecies) {
    targets.push({ host: hostSpecies, pathogen: pathogenSpecies });
  } else {
    const allCollections = await sourceDb.db.listCollections({}, { nameOnly: true }).toArray();
    for (const entry of allCollections) {
      const name = String(entry?.name || "");
      if (!name.endsWith("_domains")) {
        continue;
      }
      const pair = name.slice(0, -"_domains".length);
      const splitAt = pair.indexOf("_");
      if (splitAt <= 0 || splitAt >= pair.length - 1) {
        continue;
      }
      targets.push({
        host: pair.slice(0, splitAt),
        pathogen: pair.slice(splitAt + 1)
      });
    }
  }

  const uniqueTargets = Array.from(
    new Map(targets.map((item) => [buildPlantSnapshotKey(item.host, item.pathogen), item])).values()
  );

  let updated = 0;
  const failed = [];
  for (const item of uniqueTargets) {
    try {
      await upsertPlantSnapshot(item);
      updated += 1;
    } catch (error) {
      failed.push({
        host: item.host,
        pathogen: item.pathogen,
        message: error.message
      });
    }
  }

  return {
    totalTargets: uniqueTargets.length,
    updated,
    failed
  };
}

module.exports = {
  listAnnotation,
  listEffector,
  bundleAnnotation,
  findGenesFromKeyword,
  getPlantSnapshot,
  rebuildPlantSnapshots
};
