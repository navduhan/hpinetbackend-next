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
const sequenceCache = new Map();

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
        if (id === geneId) {
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

  const fastaPath = resolveSpeciesFasta(safeSpecies);
  try {
    await fs.promises.access(fastaPath, fs.constants.R_OK);
  } catch {
    throw new HttpError(404, `FASTA file not found for species '${safeSpecies}'`);
  }

  const sequence = await readSequenceFromFasta(fastaPath, safeGene);
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
