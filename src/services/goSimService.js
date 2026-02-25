const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const readline = require("node:readline");
const env = require("../config/env");
const { HttpError } = require("../errors/HttpError");
const { useDb } = require("../db/mongoose");
const { toGeneList } = require("../utils/genes");

const WANG_WEIGHTS = {
  is_a: 0.8,
  part_of: 0.6
};

let graphPromise = null;

function round3(value) {
  return Number(value.toFixed(3));
}

function normalizeSpecies(value) {
  return String(value || "").trim().toLowerCase();
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureNode(map, key) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  return map.get(key);
}

function addUniqueEdge(list, edge) {
  if (!list.some((item) => item.id === edge.id && item.type === edge.type)) {
    list.push(edge);
  }
}

async function isReadableFile(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function downloadFileWithRedirect(url, destination, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const tempFile = `${destination}.download`;
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const request = client.get(parsed, (response) => {
      const status = response.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) {
          reject(new Error(`Redirect without location from ${url}`));
          return;
        }
        if (maxRedirects <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        const nextUrl = new URL(location, parsed).toString();
        downloadFileWithRedirect(nextUrl, destination, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`Unexpected HTTP ${status} while downloading ${url}`));
        return;
      }

      const out = fs.createWriteStream(tempFile);
      response.pipe(out);

      out.on("finish", async () => {
        out.close(async () => {
          try {
            await fs.promises.rename(tempFile, destination);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });

      out.on("error", async (error) => {
        response.destroy();
        await fs.promises.unlink(tempFile).catch(() => {});
        reject(error);
      });
    });

    request.on("error", async (error) => {
      await fs.promises.unlink(`${destination}.download`).catch(() => {});
      reject(error);
    });
  });
}

async function ensureGoOboFile(oboPath) {
  if (await isReadableFile(oboPath)) {
    return;
  }

  if (!env.GO_AUTO_DOWNLOAD_OBO) {
    throw new HttpError(500, `Missing GO OBO file at ${oboPath}. Set GO_OBO_PATH or enable GO_AUTO_DOWNLOAD_OBO.`);
  }

  await fs.promises.mkdir(path.dirname(oboPath), { recursive: true });
  try {
    await downloadFileWithRedirect(env.GO_OBO_URL, oboPath);
  } catch (error) {
    throw new HttpError(
      500,
      `Failed to auto-download GO OBO from ${env.GO_OBO_URL}`,
      error.message || String(error)
    );
  }

  if (!(await isReadableFile(oboPath))) {
    throw new HttpError(500, `GO OBO download completed but file is unreadable: ${oboPath}`);
  }
}

function parseTermBlock(lines) {
  const term = {
    id: "",
    name: "",
    namespace: "",
    obsolete: false,
    altIds: [],
    relationships: []
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const sep = line.indexOf(": ");
    if (sep < 0) {
      continue;
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    if (key === "id") {
      term.id = value.trim();
    } else if (key === "name") {
      term.name = value.trim();
    } else if (key === "namespace") {
      term.namespace = value.trim();
    } else if (key === "is_obsolete") {
      term.obsolete = value.trim() === "true";
    } else if (key === "alt_id") {
      term.altIds.push(value.trim());
    } else if (key === "is_a") {
      const goid = value.split("!")[0].trim();
      if (goid) {
        term.relationships.push({ type: "is_a", id: goid });
      }
    } else if (key === "relationship") {
      const lhs = value.split("!")[0].trim();
      const parts = lhs.split(/\s+/);
      if (parts.length >= 2) {
        term.relationships.push({ type: parts[0], id: parts[1] });
      }
    }
  }

  if (!term.id || !term.name || !term.namespace) {
    return null;
  }
  if (term.obsolete) {
    return null;
  }
  return term;
}

async function loadGoGraph(oboPath) {
  await ensureGoOboFile(oboPath);

  const nodes = new Set();
  const parents = new Map();
  const children = new Map();
  const altIds = new Map();

  let blockType = null;
  let blockLines = [];

  const stream = fs.createReadStream(oboPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  function flushBlock() {
    if (blockType !== "Term") {
      return;
    }
    const term = parseTermBlock(blockLines);
    if (!term) {
      return;
    }

    nodes.add(term.id);
    ensureNode(parents, term.id);
    ensureNode(children, term.id);

    for (const altId of term.altIds) {
      altIds.set(altId, term.id);
    }

    for (const rel of term.relationships) {
      nodes.add(rel.id);
      ensureNode(parents, rel.id);
      ensureNode(children, rel.id);
      addUniqueEdge(ensureNode(parents, term.id), { id: rel.id, type: rel.type });
      if (!children.get(rel.id).includes(term.id)) {
        children.get(rel.id).push(term.id);
      }
    }
  }

  for await (const lineRaw of rl) {
    const line = lineRaw.trimEnd();
    if (!line) {
      continue;
    }
    const blockMatch = line.match(/^\[([A-Za-z_]+)\]$/);
    if (blockMatch) {
      flushBlock();
      blockType = blockMatch[1];
      blockLines = [];
      continue;
    }
    if (blockType) {
      blockLines.push(line);
    }
  }
  flushBlock();

  if (nodes.size < 2) {
    throw new HttpError(500, "GO graph parsing failed: graph is too small");
  }

  return {
    nodes,
    parents,
    children,
    altIds,
    totalNodes: nodes.size,
    ancestorCache: new Map(),
    descendantCache: new Map(),
    lowerBoundCache: new Map(),
    sValueCache: new Map(),
    pathCache: new Map()
  };
}

function resolveTerm(graph, term) {
  const value = String(term || "").trim();
  if (!value) {
    return "";
  }
  const canonical = graph.altIds.get(value) || value;
  return graph.nodes.has(canonical) ? canonical : "";
}

function getAncestors(graph, term) {
  const canonical = resolveTerm(graph, term);
  if (!canonical) {
    return new Set();
  }
  if (graph.ancestorCache.has(canonical)) {
    return graph.ancestorCache.get(canonical);
  }

  const visited = new Set();
  const stack = [...(graph.parents.get(canonical) || []).map((rel) => rel.id)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const rel of graph.parents.get(current) || []) {
      stack.push(rel.id);
    }
  }

  graph.ancestorCache.set(canonical, visited);
  return visited;
}

function getDescendants(graph, term) {
  const canonical = resolveTerm(graph, term);
  if (!canonical) {
    return new Set();
  }
  if (graph.descendantCache.has(canonical)) {
    return graph.descendantCache.get(canonical);
  }

  const visited = new Set();
  const stack = [...(graph.children.get(canonical) || [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const child of graph.children.get(current) || []) {
      stack.push(child);
    }
  }

  graph.descendantCache.set(canonical, visited);
  return visited;
}

function lowerBound(graph, term) {
  const canonical = resolveTerm(graph, term);
  if (!canonical) {
    return null;
  }
  if (graph.lowerBoundCache.has(canonical)) {
    return graph.lowerBoundCache.get(canonical);
  }
  const lb = getDescendants(graph, canonical).size + 1;
  graph.lowerBoundCache.set(canonical, lb);
  return lb;
}

function informationContent(graph, term) {
  const lb = lowerBound(graph, term);
  if (!lb || graph.totalNodes <= 0) {
    return null;
  }
  const freq = lb / graph.totalNodes;
  return round3(-1 * Math.log2(freq));
}

function lowestCommonAncestor(graph, term1, term2) {
  const t1 = resolveTerm(graph, term1);
  const t2 = resolveTerm(graph, term2);
  if (!t1 || !t2) {
    return null;
  }
  const a1 = getAncestors(graph, t1);
  const a2 = getAncestors(graph, t2);
  const common = [];
  if (a1.has(t2)) {
    common.push(t2);
  }
  if (a2.has(t1)) {
    common.push(t1);
  }
  common.push(...[...a1].filter((x) => a2.has(x)));
  if (t1 === t2) {
    common.push(t1);
  }
  if (common.length === 0) {
    return null;
  }
  let best = common[0];
  let bestLb = lowerBound(graph, best) || Number.MAX_SAFE_INTEGER;
  for (let i = 1; i < common.length; i += 1) {
    const candidate = common[i];
    const lb = lowerBound(graph, candidate) || Number.MAX_SAFE_INTEGER;
    if (lb < bestLb) {
      best = candidate;
      bestLb = lb;
    }
  }
  return best;
}

function resnik(graph, term1, term2) {
  const mica = lowestCommonAncestor(graph, term1, term2);
  if (!mica) {
    return null;
  }
  return informationContent(graph, mica);
}

function lin(graph, term1, term2) {
  const ic1 = informationContent(graph, term1);
  const ic2 = informationContent(graph, term2);
  const icLca = resnik(graph, term1, term2);
  if (ic1 === null || ic2 === null || icLca === null) {
    return null;
  }
  const denom = ic1 + ic2;
  if (denom === 0) {
    return null;
  }
  return round3((2 * icLca) / denom);
}

function sValues(graph, term) {
  const canonical = resolveTerm(graph, term);
  if (!canonical) {
    return null;
  }
  if (graph.sValueCache.has(canonical)) {
    return graph.sValueCache.get(canonical);
  }

  const sv = new Map([[canonical, 1]]);
  const visited = new Set();
  let level = new Set([canonical]);

  while (level.size > 0) {
    const nextLevel = new Set();
    for (const node of level) {
      for (const rel of graph.parents.get(node) || []) {
        const parent = rel.id;
        const wf = WANG_WEIGHTS[rel.type] || 0;
        if (wf <= 0) {
          continue;
        }
        const weight = (sv.get(node) || 0) * wf;
        if (weight <= 0) {
          continue;
        }
        const prev = sv.get(parent);
        if (prev === undefined || weight > prev) {
          sv.set(parent, weight);
        }
        if (!visited.has(parent)) {
          nextLevel.add(parent);
        }
      }
    }
    for (const node of level) {
      visited.add(node);
    }
    level = nextLevel;
  }

  const rounded = new Map();
  for (const [k, v] of sv.entries()) {
    rounded.set(k, round3(v));
  }
  graph.sValueCache.set(canonical, rounded);
  return rounded;
}

function wang(graph, term1, term2) {
  const sa = sValues(graph, term1);
  const sb = sValues(graph, term2);
  if (!sa || !sb) {
    return null;
  }
  let sva = 0;
  let svb = 0;
  for (const value of sa.values()) {
    sva += value;
  }
  for (const value of sb.values()) {
    svb += value;
  }
  if (sva + svb <= 0) {
    return null;
  }
  let cv = 0;
  for (const [k, v] of sa.entries()) {
    if (sb.has(k)) {
      cv += v + sb.get(k);
    }
  }
  return round3(cv / (sva + svb));
}

function shortestPathLength(graph, source, target) {
  const src = resolveTerm(graph, source);
  const dst = resolveTerm(graph, target);
  if (!src || !dst) {
    return null;
  }
  if (src === dst) {
    return 0;
  }
  const cacheKey = `${src}->${dst}`;
  if (graph.pathCache.has(cacheKey)) {
    return graph.pathCache.get(cacheKey);
  }

  const queue = [{ node: src, dist: 0 }];
  const visited = new Set([src]);
  let result = null;

  for (let i = 0; i < queue.length; i += 1) {
    const { node, dist } = queue[i];
    for (const child of graph.children.get(node) || []) {
      if (child === dst) {
        result = dist + 1;
        break;
      }
      if (!visited.has(child)) {
        visited.add(child);
        queue.push({ node: child, dist: dist + 1 });
      }
    }
    if (result !== null) {
      break;
    }
  }

  graph.pathCache.set(cacheKey, result);
  return result;
}

function pekar(graph, term1, term2) {
  const mica = lowestCommonAncestor(graph, term1, term2);
  if (!mica) {
    return null;
  }

  const ac = shortestPathLength(graph, mica, term1);
  const bc = shortestPathLength(graph, mica, term2);
  if (ac === null || bc === null) {
    return null;
  }

  const ancestors = getAncestors(graph, mica);
  let root = mica;
  let rootLb = lowerBound(graph, mica) || 0;
  for (const candidate of ancestors) {
    const lb = lowerBound(graph, candidate) || 0;
    if (lb > rootLb) {
      root = candidate;
      rootLb = lb;
    }
  }

  const rootc = shortestPathLength(graph, root, mica);
  if (rootc === null) {
    return null;
  }
  const denom = ac + bc + rootc;
  if (denom === 0) {
    return null;
  }
  return round3(rootc / denom);
}

function getMethodFn(method) {
  const normalized = String(method || "").trim().toLowerCase();
  const methodMap = {
    wang,
    resnik,
    lin,
    pekar,
    lowest_common_ancestor: resnik
  };
  return methodMap[normalized] || null;
}

function getScoreFn(score) {
  const normalized = String(score || "").trim().toLowerCase();
  if (normalized === "max") {
    return function simMax(terms1, terms2, simMethod, graph) {
      const sims = [];
      for (const t1 of terms1) {
        for (const t2 of terms2) {
          const sim = simMethod(graph, t1, t2);
          if (sim !== null && sim !== undefined) {
            sims.push(sim);
          }
        }
      }
      if (sims.length === 0) {
        return null;
      }
      return round3(Math.max(...sims));
    };
  }
  if (normalized === "avg") {
    return function simAvg(terms1, terms2, simMethod, graph) {
      const sims = [];
      for (const t1 of terms1) {
        for (const t2 of terms2) {
          const sim = simMethod(graph, t1, t2);
          if (sim !== null && sim !== undefined) {
            sims.push(sim);
          }
        }
      }
      if (sims.length === 0) {
        return null;
      }
      const sum = sims.reduce((acc, value) => acc + value, 0);
      return round3(sum / sims.length);
    };
  }
  if (normalized === "bma") {
    return function simBma(terms1, terms2, simMethod, graph) {
      const sims = [];
      for (const t1 of terms1) {
        const row = [];
        for (const t2 of terms2) {
          const sim = simMethod(graph, t1, t2);
          if (sim !== null && sim !== undefined) {
            row.push(sim);
          }
        }
        if (row.length > 0) {
          sims.push(Math.max(...row));
        }
      }
      for (const t2 of terms2) {
        const row = [];
        for (const t1 of terms1) {
          const sim = simMethod(graph, t1, t2);
          if (sim !== null && sim !== undefined) {
            row.push(sim);
          }
        }
        if (row.length > 0) {
          sims.push(Math.max(...row));
        }
      }
      if (sims.length === 0) {
        return null;
      }
      const sum = sims.reduce((acc, value) => acc + value, 0);
      return round3(sum / sims.length);
    };
  }
  return null;
}

async function getGoGraph() {
  if (graphPromise) {
    return graphPromise;
  }
  graphPromise = loadGoGraph(env.GO_OBO_PATH).catch((error) => {
    graphPromise = null;
    throw error;
  });
  return graphPromise;
}

function chooseGoCollection(db) {
  const explicit = String(env.GO_MONGO_COLLECTION || "").trim();
  if (explicit) {
    return explicit;
  }
  return "go_terms_v2";
}

function toTermsArray(row) {
  if (Array.isArray(row.terms) && row.terms.length > 0) {
    return row.terms.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(row.term || "")
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function fetchSpeciesGeneTerms({ collection, species, sptype, genes }) {
  if (genes.length === 0) {
    return new Map();
  }

  const baseQuery = {
    species,
    gene: { $in: genes }
  };

  let rows = await collection
    .find({ ...baseQuery, sptype }, { projection: { gene: 1, term: 1, terms: 1 } })
    .toArray();

  if (rows.length === 0) {
    rows = await collection
      .find(baseQuery, { projection: { gene: 1, term: 1, terms: 1 } })
      .toArray();
  }

  const map = new Map();
  for (const row of rows) {
    const gene = String(row.gene || "").trim();
    if (!gene) {
      continue;
    }
    map.set(gene, {
      gene,
      term: String(row.term || ""),
      terms: toTermsArray(row)
    });
  }
  return map;
}

async function persistGoResults(records) {
  const resultsDb = useDb("hpinet_results");
  const name = `hpinet${Date.now()}results`;
  const collection = resultsDb.collection(name);
  if (records.length > 0) {
    await collection.insertMany(records, { ordered: false });
  } else {
    await collection.insertOne({ result: "no results" });
  }
  return name;
}

async function runGoSimJob(payload) {
  const methodName = String(payload.method || "").trim().toLowerCase();
  const scoreName = String(payload.score || "").trim().toLowerCase();
  const threshold = parseNumber(payload.threshold, 0);

  const hostSpecies = normalizeSpecies(payload.hspecies);
  const pathogenSpecies = normalizeSpecies(payload.pspecies);
  if (!hostSpecies || !pathogenSpecies) {
    throw new HttpError(400, "Missing required fields: hspecies, pspecies");
  }

  const methodFn = getMethodFn(methodName);
  if (!methodFn) {
    throw new HttpError(400, "Unsupported GO method. Supported: wang, resnik, lin, pekar, lowest_common_ancestor");
  }
  const scoreFn = getScoreFn(scoreName);
  if (!scoreFn) {
    throw new HttpError(400, "Unsupported GO score strategy. Supported: max, avg, bma");
  }

  const hostGenes = toGeneList(payload.host_genes);
  const pathogenGenes = toGeneList(payload.pathogen_genes);
  if (hostGenes.length === 0 || pathogenGenes.length === 0) {
    return persistGoResults([]);
  }

  const hpinetDb = useDb("hpinetdb");
  const goCollection = hpinetDb.collection(chooseGoCollection(hpinetDb));
  const [hostMap, pathogenMap, graph] = await Promise.all([
    fetchSpeciesGeneTerms({
      collection: goCollection,
      species: hostSpecies,
      sptype: "host",
      genes: hostGenes
    }),
    fetchSpeciesGeneTerms({
      collection: goCollection,
      species: pathogenSpecies,
      sptype: "pathogen",
      genes: pathogenGenes
    }),
    getGoGraph()
  ]);

  if (hostMap.size === 0 || pathogenMap.size === 0) {
    return persistGoResults([]);
  }

  const results = [];
  for (const hostRow of hostMap.values()) {
    if (!hostRow.terms || hostRow.terms.length === 0) {
      continue;
    }
    for (const pathogenRow of pathogenMap.values()) {
      if (!pathogenRow.terms || pathogenRow.terms.length === 0) {
        continue;
      }
      const score = scoreFn(hostRow.terms, pathogenRow.terms, methodFn, graph);
      if (score === null || score === undefined || score < threshold) {
        continue;
      }
      results.push({
        Host_Protein: hostRow.gene,
        Pathogen_Protein: pathogenRow.gene,
        Host_GO: hostRow.terms.join(" | "),
        Pathogen_GO: pathogenRow.terms.join(" | "),
        Score: score,
        score
      });
    }
  }

  return persistGoResults(results);
}

module.exports = {
  runGoSimJob
};
