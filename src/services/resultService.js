const { useDb, getOrCreateModel } = require("../db/mongoose");
const { HttpError } = require("../errors/HttpError");
const { parsePaging } = require("../utils/pagination");
const { toGeneList, toGeneCsv } = require("../utils/genes");
const { findGenesFromKeyword } = require("./annotationService");
const { scoreRowsConfidence } = require("../utils/confidence");
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

function asNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const DOMAIN_CACHE_TTL_MS = asPositiveInt(process.env.DOMAIN_CACHE_TTL_MS, 30000);
const DOMAIN_CACHE_MAX_ENTRIES = asPositiveInt(process.env.DOMAIN_CACHE_MAX_ENTRIES, 1000);
const RESULT_CACHE_TTL_MS = asPositiveInt(process.env.RESULT_CACHE_TTL_MS, 15000);
const RESULT_CACHE_MAX_ENTRIES = asPositiveInt(process.env.RESULT_CACHE_MAX_ENTRIES, 300);
const domainCache = new Map();
const resultCache = new Map();

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

function getResultCacheEntry(key) {
  const entry = resultCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setResultCacheEntry(key, value) {
  if (resultCache.has(key)) {
    resultCache.delete(key);
  }
  resultCache.set(key, {
    value,
    expiresAt: Date.now() + RESULT_CACHE_TTL_MS
  });

  while (resultCache.size > RESULT_CACHE_MAX_ENTRIES) {
    const oldestKey = resultCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    resultCache.delete(oldestKey);
  }
}

function getCategorySchema(category) {
  if (category === "interolog") return wheatSchema;
  if (category === "consensus") return consensusSchema;
  if (category === "gosim" || category === "go") return goppiSchema;
  if (category === "phylo") return phyloSchema;
  throw new HttpError(400, `Invalid category: ${category}`);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildQuickSearchClause(q, fields) {
  const keyword = String(q || "").trim();
  if (!keyword) {
    return null;
  }
  const regex = new RegExp(escapeRegex(keyword), "i");
  return {
    $or: fields.map((field) => ({ [field]: regex }))
  };
}

function withQuickSearch(baseQuery, q, fields) {
  const clause = buildQuickSearchClause(q, fields);
  if (!clause) {
    return baseQuery;
  }
  if (!baseQuery || Object.keys(baseQuery).length === 0) {
    return clause;
  }
  return {
    $and: [baseQuery, clause]
  };
}

function getResultSearchFields(category) {
  if (category === "go" || category === "gosim") {
    return ["Host_Protein", "Pathogen_Protein", "Host_GO", "Pathogen_GO"];
  }
  if (category === "phylo") {
    return ["Host_Protein", "Pathogen_Protein", "Host_Pattern", "Pathogen_Pattern"];
  }
  return ["Host_Protein", "Pathogen_Protein", "ProteinA", "ProteinB", "intdb_x", "intdb", "Method", "Type", "PMID"];
}

function getProjectionFields(category) {
  const c = String(category || "").toLowerCase();
  if (c === "go" || c === "gosim") {
    return {
      Host_Protein: 1,
      Pathogen_Protein: 1,
      Host_GO: 1,
      Pathogen_GO: 1,
      Score: 1,
      score: 1,
      Confidence: 1
    };
  }
  if (c === "phylo") {
    return {
      Host_Protein: 1,
      Pathogen_Protein: 1,
      Score: 1,
      score: 1,
      Confidence: 1,
      Host_Pattern: 1,
      Pathogen_Pattern: 1
    };
  }
  if (c === "domain") {
    return {
      Host_Protein: 1,
      Pathogen_Protein: 1,
      ProteinA: 1,
      ProteinB: 1,
      Score: 1,
      score: 1,
      Confidence: 1,
      intdb: 1,
      DomainA_name: 1,
      DomianA_name: 1,
      DomainA_interpro: 1,
      DomianA_interpro: 1,
      DomainB_name: 1,
      DomianB_name: 1,
      DomainB_interpro: 1,
      DomianB_interpro: 1
    };
  }
  if (c === "consensus") {
    return {
      Host_Protein: 1,
      Pathogen_Protein: 1,
      ProteinA: 1,
      ProteinB: 1,
      Method: 1,
      Type: 1,
      Confidence: 1,
      Score: 1,
      score: 1,
      PMID: 1,
      intdb_x: 1,
      intdb: 1,
      DomainA_name: 1,
      DomianA_name: 1,
      DomainA_interpro: 1,
      DomianA_interpro: 1,
      DomainB_name: 1,
      DomianB_name: 1,
      DomainB_interpro: 1,
      DomianB_interpro: 1
    };
  }
  return {
    Host_Protein: 1,
    Pathogen_Protein: 1,
    ProteinA: 1,
    ProteinB: 1,
    Method: 1,
    Type: 1,
    Confidence: 1,
    Score: 1,
    score: 1,
    PMID: 1,
    intdb_x: 1,
    intdb: 1
  };
}

function getResultModel(resultId, category) {
  if (!resultId) {
    throw new HttpError(400, "Missing required query param: results");
  }
  const schema = getCategorySchema(category);
  const db = useDb("hpinet_results");
  return getOrCreateModel(db, resultId, schema);
}

function inferCategoryFromRows(rows, fallback = "interolog") {
  if (!Array.isArray(rows) || rows.length === 0) {
    return fallback;
  }
  const row = rows[0] || {};
  if ("Host_GO" in row || "Pathogen_GO" in row) return "go";
  if ("Host_Pattern" in row || "Pathogen_Pattern" in row) return "phylo";
  if ("DomianA_interpro" in row || "DomainA_interpro" in row || "intdb" in row) {
    if ("intdb_x" in row || "Method" in row) return "consensus";
    return "domain";
  }
  if ("intdb_x" in row || "Method" in row || "PMID" in row) return "interolog";
  return fallback;
}

async function getResults({ resultId, category, page, size, q }) {
  const cacheKey = JSON.stringify({ type: "results", resultId, category, page, size, q: String(q || "") });
  const cached = getResultCacheEntry(cacheKey);
  if (cached) {
    return cached;
  }

  const model = getResultModel(resultId, category);
  const query = withQuickSearch({}, q, getResultSearchFields(category));
  const projection = getProjectionFields(category);
  const { pageSize, skip } = parsePaging(page, size, { defaultSize: 1000, maxSize: 10000 });
  const [rawResults, total, host, pathogen] = await Promise.all([
    model.find(query, projection).limit(pageSize).skip(skip).lean().exec(),
    model.countDocuments(query),
    model.distinct("Host_Protein", query),
    model.distinct("Pathogen_Protein", query)
  ]);
  const results = scoreRowsConfidence(rawResults, category);
  const response = {
    results,
    total,
    hostcount: host.length,
    pathogencount: pathogen.length
  };
  setResultCacheEntry(cacheKey, response);
  return response;
}

async function getNetwork({ resultId, category, limit, offset, sort }) {
  if (!resultId) {
    throw new HttpError(400, "Missing required query param: results");
  }

  const safeLimit = Math.min(asPositiveInt(limit, 5000), 10000);
  const safeOffset = asNonNegativeInt(offset, 0);
  const safeSort = String(sort || "confidence_desc").toLowerCase();
  const sortSpec = safeSort === "recent"
    ? { _id: -1 }
    : { Confidence: -1, Score: -1, score: -1, _id: -1 };

  const cacheKey = JSON.stringify({
    type: "network",
    resultId,
    category: String(category || ""),
    limit: safeLimit,
    offset: safeOffset,
    sort: safeSort
  });
  const cached = getResultCacheEntry(cacheKey);
  if (cached) {
    return cached;
  }

  const db = useDb("hpinet_results");
  const model = getOrCreateModel(db, resultId, wheatSchema);
  const [rawResults, total] = await Promise.all([
    model
      .find({}, getProjectionFields(category || "interolog"))
      .sort(sortSpec)
      .skip(safeOffset)
      .limit(safeLimit)
      .lean()
      .exec(),
    model.countDocuments({})
  ]);
  const resolvedCategory = inferCategoryFromRows(rawResults, category || "interolog");
  const results = scoreRowsConfidence(rawResults, resolvedCategory);
  const hostSet = new Set(results.map((row) => row.Host_Protein).filter(Boolean));
  const pathogenSet = new Set(results.map((row) => row.Pathogen_Protein).filter(Boolean));
  const returned = results.length;
  const hasMore = safeOffset + returned < total;
  const response = {
    results,
    total,
    returned,
    offset: safeOffset,
    limit: safeLimit,
    hasMore,
    nextOffset: hasMore ? safeOffset + returned : null,
    hostcount: hostSet.size,
    pathogencount: pathogenSet.size
  };
  setResultCacheEntry(cacheKey, response);
  return response;
}

async function downloadResults({ resultId, category }) {
  if (!resultId) {
    throw new HttpError(400, "Missing required query param: results");
  }
  const db = useDb("hpinet_results");
  const model = getOrCreateModel(db, resultId, wheatSchema);
  const rawResults = await model.find({}, getProjectionFields(category || "interolog")).lean().exec();
  const resolvedCategory = inferCategoryFromRows(rawResults, category || "interolog");
  const results = scoreRowsConfidence(rawResults, resolvedCategory);
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
  return withQuickSearch(query, body.q, [
    "Host_Protein",
    "Pathogen_Protein",
    "ProteinA",
    "ProteinB",
    "DomainA_name",
    "DomianA_desc",
    "DomainB_name",
    "DomianB_desc",
    "intdb"
  ]);
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

  const [rawResults, summary] = await Promise.all([
    model.find(query).limit(pageSize).skip(skip).lean().exec(),
    summaryPromise
  ]);
  const results = scoreRowsConfidence(rawResults, "domain");

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
