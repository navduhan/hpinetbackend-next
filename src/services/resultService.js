const { useDb, getOrCreateModel } = require("../db/mongoose");
const { HttpError } = require("../errors/HttpError");
const { parsePaging } = require("../utils/pagination");
const { toGeneList, toGeneCsv } = require("../utils/genes");
const { findGenesFromKeyword } = require("./annotationService");
const {
  wheatSchema,
  goppiSchema,
  phyloSchema,
  domainSchema,
  consensusSchema
} = require("../models/resultSchemas");

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const DOMAIN_CACHE_TTL_MS = asPositiveInt(process.env.DOMAIN_CACHE_TTL_MS, 30000);
const DOMAIN_CACHE_MAX_ENTRIES = asPositiveInt(process.env.DOMAIN_CACHE_MAX_ENTRIES, 1000);
const domainCache = new Map();

function getCacheEntry(key) {
  const entry = domainCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    domainCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCacheEntry(key, value) {
  if (domainCache.has(key)) {
    domainCache.delete(key);
  }
  domainCache.set(key, {
    value,
    expiresAt: Date.now() + DOMAIN_CACHE_TTL_MS
  });

  while (domainCache.size > DOMAIN_CACHE_MAX_ENTRIES) {
    const oldestKey = domainCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    domainCache.delete(oldestKey);
  }
}

function getCategorySchema(category) {
  if (category === "interolog") return wheatSchema;
  if (category === "consensus") return consensusSchema;
  if (category === "gosim" || category === "go") return goppiSchema;
  if (category === "phylo") return phyloSchema;
  throw new HttpError(400, `Invalid category: ${category}`);
}

function getResultModel(resultId, category) {
  if (!resultId) {
    throw new HttpError(400, "Missing required query param: results");
  }
  const schema = getCategorySchema(category);
  const db = useDb("hpinet_results");
  return getOrCreateModel(db, resultId, schema);
}

async function getResults({ resultId, category, page, size }) {
  const model = getResultModel(resultId, category);
  const { pageSize, skip } = parsePaging(page, size, { defaultSize: 1000, maxSize: 10000 });
  const [results, total, host, pathogen] = await Promise.all([
    model.find({}).limit(pageSize).skip(skip).lean().exec(),
    model.countDocuments({}),
    model.distinct("Host_Protein"),
    model.distinct("Pathogen_Protein")
  ]);
  return {
    results,
    total,
    hostcount: host.length,
    pathogencount: pathogen.length
  };
}

async function getNetwork({ resultId }) {
  if (!resultId) {
    throw new HttpError(400, "Missing required query param: results");
  }
  const db = useDb("hpinet_results");
  const model = getOrCreateModel(db, resultId, wheatSchema);
  const [results, total, host, pathogen] = await Promise.all([
    model.find({}).lean().exec(),
    model.countDocuments({}),
    model.distinct("Host_Protein"),
    model.distinct("Pathogen_Protein")
  ]);
  return {
    results,
    total,
    hostcount: host.length,
    pathogencount: pathogen.length
  };
}

async function downloadResults({ resultId }) {
  if (!resultId) {
    throw new HttpError(400, "Missing required query param: results");
  }
  const db = useDb("hpinet_results");
  const model = getOrCreateModel(db, resultId, wheatSchema);
  const results = await model.find({}).lean().exec();
  return { results };
}

function getDomainModel(speciesKey) {
  if (!speciesKey) {
    throw new HttpError(400, "Missing required body field: species");
  }
  const normalized = String(speciesKey).toLowerCase();
  const table = normalized.endsWith("_domains") ? normalized : `${normalized}_domains`;
  const db = useDb("hpinetdb");
  return getOrCreateModel(db, table, domainSchema);
}

function buildDomainBaseQuery(body) {
  const query = {};
  const intdb = Array.isArray(body.intdb)
    ? body.intdb.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (intdb.length > 0) {
    query.intdb = { $in: intdb };
  }
  return query;
}

function buildDomainQuerySignature({ model, body, query, genes }) {
  return JSON.stringify({
    collection: model.collection.name,
    species: String(body.species || "").toLowerCase(),
    idt: String(body.idt || "").toLowerCase(),
    searchType: String(body.searchType || ""),
    keyword: String(body.keyword || ""),
    anotType: String(body.anotType || ""),
    ids: String(body.ids || ""),
    host: String(body.host || ""),
    pathogen: String(body.pathogen || ""),
    intdb: Array.isArray(body.intdb) ? [...body.intdb].map((item) => String(item || "")).sort() : [],
    genes: [...genes].sort(),
    query
  });
}

async function getDomainDownload(body) {
  const model = getDomainModel(body.species);
  const query = buildDomainBaseQuery(body);
  const genes = toGeneList(body.genes);
  if (genes.length > 0) {
    if (body.idt === "host") {
      query.Host_Protein = { $in: genes };
    } else if (body.idt === "pathogen") {
      query.Pathogen_Protein = { $in: genes };
    }
  }
  const results = await model.find(query).lean().exec();
  return { results };
}

async function resolveDomainGenes(body) {
  if (body.searchType !== "keyword") {
    return toGeneList(body.genes);
  }
  const species = body.ids === "host" ? body.host : body.pathogen;
  return findGenesFromKeyword({
    anotType: body.anotType,
    ids: body.ids,
    species,
    keyword: body.keyword
  });
}

async function getDomainResults(body) {
  const model = getDomainModel(body.species);
  const resultsDb = useDb("hpinet_results");
  const { pageSize, skip } = parsePaging(body.page, body.size, { defaultSize: 10, maxSize: 1000 });
  const query = buildDomainBaseQuery(body);
  const genes = await resolveDomainGenes(body);
  if (genes.length > 0 || Boolean(body.keyword)) {
    if (body.idt === "host") {
      query.Host_Protein = { $in: genes };
    } else if (body.idt === "pathogen") {
      query.Pathogen_Protein = { $in: genes };
    }
  }

  const signature = buildDomainQuerySignature({ model, body, query, genes });
  const summaryKey = `domain-summary|${signature}`;
  const pageKey = `domain-page|${signature}|${skip}|${pageSize}`;

  const cachedPage = getCacheEntry(pageKey);
  if (cachedPage) {
    return cachedPage;
  }

  const cachedSummary = getCacheEntry(summaryKey);
  const summaryPromise = cachedSummary
    ? Promise.resolve(cachedSummary)
    : Promise.all([
        model.countDocuments(query),
        model.distinct("Host_Protein", query),
        model.distinct("Pathogen_Protein", query)
      ]).then(([total, host, pathogen]) => {
        const summary = {
          total,
          hostcount: host.length,
          pathogencount: pathogen.length
        };
        setCacheEntry(summaryKey, summary);
        return summary;
      });

  const [results, summary] = await Promise.all([
    model.find(query).limit(pageSize).skip(skip).lean().exec(),
    summaryPromise
  ]);

  const tableName = `hpinet${Date.now()}results`;
  const collection = resultsDb.collection(tableName);
  if (results.length > 0) {
    await collection.insertMany(results);
  }

  const response = {
    results,
    total: summary.total,
    hostcount: summary.hostcount,
    pathogencount: summary.pathogencount,
    resultid: tableName,
    genes: toGeneCsv(genes)
  };
  setCacheEntry(pageKey, response);
  return response;
}

module.exports = {
  getResults,
  getNetwork,
  downloadResults,
  getDomainResults,
  getDomainDownload
};
