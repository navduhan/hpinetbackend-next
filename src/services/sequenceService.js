const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const env = require("../config/env");
const { HttpError } = require("../errors/HttpError");

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const CACHE_TTL_MS = asPositiveInt(process.env.SEQUENCE_CACHE_TTL_MS, 10 * 60 * 1000);
const CACHE_MAX_ENTRIES = asPositiveInt(process.env.SEQUENCE_CACHE_MAX_ENTRIES, 5000);
const FASTA_MAP_CACHE_TTL_MS = asPositiveInt(process.env.SEQUENCE_FASTA_MAP_CACHE_TTL_MS, 60 * 1000);
const sequenceCache = new Map();
let fastaMapCache = {
  loadedAt: 0,
  mapPath: "",
  map: new Map()
};

function getCache(key) {
  const entry = sequenceCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sequenceCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  if (sequenceCache.has(key)) {
    sequenceCache.delete(key);
  }
  sequenceCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  while (sequenceCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = sequenceCache.keys().next().value;
    if (!oldestKey) break;
    sequenceCache.delete(oldestKey);
  }
}

function parseFastaId(headerLine) {
  return String(headerLine || "")
    .replace(/^>/, "")
    .trim()
    .split(/\s+/)[0];
}

function ensureSafeSpeciesId(species) {
  const value = String(species || "").trim();
  if (!value) {
    throw new HttpError(400, "Missing required field: species");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new HttpError(400, "Invalid species identifier");
  }
  return value;
}

function ensureGeneId(gene) {
  const value = String(gene || "").trim();
  if (!value) {
    throw new HttpError(400, "Missing required field: gene");
  }
  return value;
}

function resolveSpeciesFasta(speciesId) {
  return path.join(env.PHYLO_ROOT, "data", `${speciesId}.fa`);
}

function resolveMappedFastaPath(mappedValue) {
  const value = String(mappedValue || "").trim();
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.join(env.PHYLO_ROOT, "data", value);
}

function getFastaMapPath() {
  const configured = String(process.env.PHYLO_FASTA_MAP_PATH || "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(env.PHYLO_ROOT, "fasta-map.json");
}

async function loadFastaMap() {
  const mapPath = getFastaMapPath();
  const now = Date.now();
  if (
    fastaMapCache.mapPath === mapPath &&
    now - fastaMapCache.loadedAt < FASTA_MAP_CACHE_TTL_MS
  ) {
    return fastaMapCache.map;
  }

  try {
    const raw = await fs.promises.readFile(mapPath, "utf-8");
    const parsed = JSON.parse(raw);
    const map = new Map();
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        const normKey = String(key || "").trim().toLowerCase();
        const normValue = String(value || "").trim();
        if (normKey && normValue) {
          map.set(normKey, normValue);
        }
      }
    }
    fastaMapCache = {
      loadedAt: now,
      mapPath,
      map
    };
    return map;
  } catch {
    fastaMapCache = {
      loadedAt: now,
      mapPath,
      map: new Map()
    };
    return fastaMapCache.map;
  }
}

async function buildSpeciesFastaCandidates(speciesId) {
  const seen = new Set();
  const candidates = [];
  const add = (value) => {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(key);
  };

  const map = await loadFastaMap();
  const mapValue = map.get(String(speciesId).toLowerCase());
  const mappedPath = resolveMappedFastaPath(mapValue);
  if (mappedPath) {
    add(mappedPath);
  }

  add(resolveSpeciesFasta(speciesId));
  add(resolveSpeciesFasta(String(speciesId).toLowerCase()));
  return candidates;
}

async function firstReadableFile(paths) {
  for (const file of paths) {
    try {
      await fs.promises.access(file, fs.constants.R_OK);
      return file;
    } catch {
      // try next
    }
  }
  return null;
}

async function findCaseInsensitiveSpeciesFasta(speciesId) {
  const dataDir = path.join(env.PHYLO_ROOT, "data");
  const targetName = `${String(speciesId || "").trim().toLowerCase()}.fa`;
  if (!targetName || targetName === ".fa") {
    return null;
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.toLowerCase() === targetName) {
      return path.join(dataDir, entry.name);
    }
  }
  return null;
}

function matchesGeneId(headerId, targetGene) {
  if (headerId === targetGene) {
    return true;
  }
  const targetBase = String(targetGene).split(".")[0];
  const headerBase = String(headerId).split(".")[0];
  return Boolean(targetBase) && targetBase === headerBase;
}

async function readSequenceFromFasta(fastaPath, geneId) {
  const stream = fs.createReadStream(fastaPath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let found = false;
  let seqParts = [];

  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.startsWith(">")) {
        const id = parseFastaId(line);
        if (found) {
          break;
        }
        if (matchesGeneId(id, geneId)) {
          found = true;
          seqParts = [];
        }
        continue;
      }
      if (found) {
        seqParts.push(line.trim());
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const sequence = seqParts.join("");
  if (!found || !sequence) {
    throw new HttpError(404, `Sequence not found for gene '${geneId}'`);
  }
  return sequence;
}

async function getSequence({ species, gene }) {
  const safeSpecies = ensureSafeSpeciesId(species);
  const safeGene = ensureGeneId(gene);
  const cacheKey = `${safeSpecies}|${safeGene}`;
  const cached = getCache(cacheKey);
  if (cached) {
    return cached;
  }

  const candidates = await buildSpeciesFastaCandidates(safeSpecies);
  const directPath = await firstReadableFile(candidates);
  const fallbackPath = directPath || (await findCaseInsensitiveSpeciesFasta(safeSpecies));
  if (!fallbackPath) {
    throw new HttpError(404, `FASTA file not found for species '${safeSpecies}'`);
  }

  const sequence = await readSequenceFromFasta(fallbackPath, safeGene);
  const payload = {
    species: safeSpecies,
    gene: safeGene,
    length: sequence.length,
    sequence,
    fasta: `>${safeGene}\n${sequence}`
  };
  setCache(cacheKey, payload);
  return payload;
}

async function getSequencePair({ host, hid, pathogen, pid }) {
  if (!host || !hid || !pathogen || !pid) {
    throw new HttpError(400, "Missing required query params: host, hid, pathogen, pid");
  }
  const [hostResult, pathogenResult] = await Promise.all([
    getSequence({ species: host, gene: hid }),
    getSequence({ species: pathogen, gene: pid })
  ]);
  return {
    host: hostResult,
    pathogen: pathogenResult
  };
}

module.exports = {
  getSequence,
  getSequencePair
};
