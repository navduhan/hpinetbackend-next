const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const env = require("../config/env");
const { HttpError } = require("../errors/HttpError");
const { useDb } = require("../db/mongoose");
const { toGeneList } = require("../utils/genes");

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePoolName(value) {
  return String(value || "").trim();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getBlastCacheRoot() {
  const configured = String(process.env.PHYLO_BLAST_CACHE_ROOT || "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(env.PHYLO_ROOT, "blast_cache");
}

function getFastaMapPath() {
  const configured = String(process.env.PHYLO_FASTA_MAP_PATH || "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(env.PHYLO_ROOT, "fasta-map.json");
}

async function loadFastaMap() {
  const file = getFastaMapPath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return new Map();
    }
    const map = new Map();
    Object.entries(parsed).forEach(([key, value]) => {
      const k = String(key || "").trim().toLowerCase();
      const v = String(value || "").trim();
      if (k && v) {
        map.set(k, v);
      }
    });
    return map;
  } catch {
    return new Map();
  }
}

function mappedFastaPath(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (path.isAbsolute(input)) return input;
  return path.join(env.PHYLO_ROOT, "data", input);
}

async function resolveSpeciesFasta(species) {
  const normalized = String(species || "").trim();
  const map = await loadFastaMap();
  const mapped = mappedFastaPath(map.get(normalized.toLowerCase()));
  const direct = path.join(env.PHYLO_ROOT, "data", `${normalized}.fa`);
  const lower = path.join(env.PHYLO_ROOT, "data", `${normalized.toLowerCase()}.fa`);
  const candidates = [mapped, direct, lower].filter(Boolean);
  for (const item of candidates) {
    if (await pathExists(item)) {
      return item;
    }
  }

  const target = `${normalized.toLowerCase()}.fa`;
  try {
    const files = await fs.readdir(path.join(env.PHYLO_ROOT, "data"), { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.toLowerCase() === target) {
        return path.join(env.PHYLO_ROOT, "data", file.name);
      }
    }
  } catch {
    // keep fallthrough to clear HttpError
  }
  throw new HttpError(404, `FASTA file not found for species '${normalized}'`);
}

async function resolveCachedBlastFile({ cacheRoot, genomePool, species, dbName, index }) {
  const pool = normalizePoolName(genomePool);
  const candidates = [
    path.join(cacheRoot, pool, species, `${dbName}.tsv`),
    path.join(cacheRoot, pool, species, `${dbName}.txt`),
    path.join(cacheRoot, pool, species, `${dbName}.blast.tsv`),
    path.join(cacheRoot, pool, species, `${dbName}.blast.txt`),
    path.join(cacheRoot, pool, species, `${species}_blast_${index}.tsv`),
    path.join(cacheRoot, pool, species, `${species}_blast_${index}.txt`),
    path.join(cacheRoot, pool, `${species}_blast_${index}.tsv`),
    path.join(cacheRoot, pool, `${species}_blast_${index}.txt`)
  ];
  for (const file of candidates) {
    if (await pathExists(file)) {
      return file;
    }
  }
  return null;
}

function resolvePoolConfig(genomePool) {
  const pool = normalizePoolName(genomePool);
  if (pool === "UP82") {
    return {
      poolFileCandidates: [path.join(env.PHYLO_ROOT, "modelPool.txt")],
      poolFolder: path.join(env.PHYLO_ROOT, "dbs", "phyloModelSC")
    };
  }
  if (pool === "BC18") {
    return {
      poolFileCandidates: [path.join(env.PHYLO_ROOT, "bioconductorPool.txt")],
      poolFolder: path.join(env.PHYLO_ROOT, "dbs", "phyloBioconductor")
    };
  }
  if (pool === "protphylo490") {
    return {
      poolFileCandidates: [
        path.join(env.PHYLO_ROOT, "phylomodelPool.txt"),
        path.join(path.dirname(env.PHYLO_ROOT), "phylomodelPool.txt")
      ],
      poolFolder: path.join(env.PHYLO_ROOT, "dbs", "protPhylo")
    };
  }
  throw new HttpError(400, `Unsupported phylo pool: ${pool}`);
}

async function firstExistingPath(candidates, label) {
  for (const file of candidates) {
    try {
      await fs.access(file);
      return file;
    } catch {
      // continue
    }
  }
  throw new HttpError(500, `Missing ${label}: ${candidates.join(", ")}`);
}

async function loadPoolEntries(poolFile) {
  const content = await fs.readFile(poolFile, "utf-8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function loadSelectedFastaRecords(fastaPath, geneIds) {
  const wanted = new Set(geneIds);
  if (wanted.size === 0) {
    return [];
  }
  const content = await fs.readFile(fastaPath, "utf-8");
  const lines = content.split(/\r?\n/);

  const records = [];
  let currentId = "";
  let currentSeq = [];

  function flush() {
    if (!currentId) {
      return;
    }
    if (wanted.has(currentId)) {
      records.push({
        id: currentId,
        seq: currentSeq.join("")
      });
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      currentId = line.slice(1).trim().split(/\s+/)[0] || "";
      currentSeq = [];
      continue;
    }
    currentSeq.push(line);
  }
  flush();
  return records;
}

async function writeFasta(filePath, records) {
  const chunks = [];
  for (const record of records) {
    chunks.push(`>${record.id}\n${record.seq}\n`);
  }
  await fs.writeFile(filePath, chunks.join(""), "utf-8");
}

function runDiamondBlast({ dbPath, queryFasta, evalue, outputFile }) {
  return new Promise((resolve, reject) => {
    const args = [
      "blastp",
      "--db",
      dbPath,
      "-q",
      queryFasta,
      "--evalue",
      String(evalue),
      "--out",
      outputFile,
      "--outfmt",
      "6",
      "qseqid",
      "sseqid",
      "pident",
      "evalue",
      "bitscore",
      "qcovhsp",
      "-k",
      "1",
      "--threads",
      String(env.PHYLO_THREADS)
    ];

    const child = spawn(env.DIAMOND_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new HttpError(500, "Failed to start DIAMOND", error.message));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const msg = String(stderr || "").trim();
        if (msg.includes("older version of Diamond and is incompatible")) {
          reject(new HttpError(500, "DIAMOND DB compatibility error", `Rebuild .dmnd for '${dbPath}' with current DIAMOND. ${msg}`));
          return;
        }
        if (msg.includes("not compiled with support for BLAST databases")) {
          reject(new HttpError(500, "DIAMOND build missing BLAST-DB support", `${msg}. Use .dmnd databases generated by 'diamond makedb'.`));
          return;
        }
        reject(new HttpError(500, "DIAMOND blast failed", msg || `Exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function buildPresenceSet(blastFile, identityCutoff, coverageCutoff) {
  const content = await fs.readFile(blastFile, "utf-8").catch((error) => {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const seen = new Set();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 6) {
      continue;
    }
    const qseqid = parts[0];
    const pident = asNumber(parts[2], 0);
    const qcovhsp = asNumber(parts[5], 0);
    if (pident > identityCutoff && qcovhsp > coverageCutoff) {
      seen.add(qseqid);
    }
  }
  return seen;
}

function appendPattern(patternMap, geneIds, presentSet) {
  for (let i = 0; i < geneIds.length; i += 1) {
    const geneId = geneIds[i];
    patternMap[i] += presentSet.has(geneId) ? "1" : "0";
  }
}

function levenshteinDistance(a, b) {
  if (a === b) {
    return 0;
  }
  if (a.length === b.length) {
    let distance = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        distance += 1;
      }
    }
    return distance;
  }

  const n = a.length;
  const m = b.length;
  const prev = new Array(m + 1);
  const curr = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= m; j += 1) {
      prev[j] = curr[j];
    }
  }

  return prev[m];
}

async function persistPhyloResults(records) {
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

function buildPairwiseScores({
  hostGeneIds,
  pathogenGeneIds,
  hostPatterns,
  pathogenPatterns,
  threshold,
  genomeNumber,
  nullPattern
}) {
  const rows = [];
  for (let h = 0; h < hostGeneIds.length; h += 1) {
    if (hostPatterns[h] === nullPattern) {
      continue;
    }
    for (let p = 0; p < pathogenGeneIds.length; p += 1) {
      const distance = levenshteinDistance(hostPatterns[h], pathogenPatterns[p]);
      const score = (genomeNumber - distance) / genomeNumber;
      if (score >= threshold) {
        rows.push({
          Host_Protein: hostGeneIds[h],
          Pathogen_Protein: pathogenGeneIds[p],
          Score: score,
          Host_Pattern: hostPatterns[h],
          Pathogen_Pattern: pathogenPatterns[p]
        });
      }
    }
  }
  return rows;
}

async function runPhyloJob(payload) {
  const host = String(payload.hspecies || "").trim();
  const pathogen = String(payload.pspecies || "").trim();
  if (!host || !pathogen) {
    throw new HttpError(400, "Missing required fields: hspecies, pspecies");
  }

  const genomePool = payload.method || payload.genomePool;
  const threshold = asNumber(payload.threshold, 0);
  const hi = asNumber(payload.hi, 0);
  const hc = asNumber(payload.hc, 0);
  const he = asNumber(payload.he, 0);
  const pi = asNumber(payload.pi, 0);
  const pc = asNumber(payload.pc, 0);
  const pe = asNumber(payload.pe, 0);

  const hostGenes = toGeneList(payload.host_genes);
  const pathogenGenes = toGeneList(payload.pathogen_genes);
  if (hostGenes.length === 0 || pathogenGenes.length === 0) {
    return persistPhyloResults([]);
  }

  const poolConfig = resolvePoolConfig(genomePool);
  const poolFile = await firstExistingPath(poolConfig.poolFileCandidates, "phylo pool file");
  const poolList = await loadPoolEntries(poolFile);
  const genomeNumber = poolList.length;
  if (genomeNumber < 2) {
    throw new HttpError(500, `Invalid phylo pool '${genomePool}': expected at least 2 genomes`);
  }

  const hostFasta = await resolveSpeciesFasta(host);
  const pathogenFasta = await resolveSpeciesFasta(pathogen);

  const hostRecords = await loadSelectedFastaRecords(hostFasta, hostGenes);
  const pathogenRecords = await loadSelectedFastaRecords(pathogenFasta, pathogenGenes);
  if (hostRecords.length === 0 || pathogenRecords.length === 0) {
    return persistPhyloResults([]);
  }

  const hostGeneIds = hostRecords.map((item) => item.id);
  const pathogenGeneIds = pathogenRecords.map((item) => item.id);
  const hostPatterns = Object.fromEntries(hostGeneIds.map((_, idx) => [idx, ""]));
  const pathogenPatterns = Object.fromEntries(pathogenGeneIds.map((_, idx) => [idx, ""]));

  const blastCacheRoot = getBlastCacheRoot();
  let tempDir = "";
  let hostTempFasta = "";
  let pathogenTempFasta = "";

  async function ensureTempInputs() {
    if (tempDir) {
      return;
    }
    await fs.mkdir(env.PHYLO_TMP_ROOT, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(env.PHYLO_TMP_ROOT, "job-"));
    hostTempFasta = path.join(tempDir, `${host}_temp.fa`);
    pathogenTempFasta = path.join(tempDir, `${pathogen}_temp.fa`);
    await writeFasta(hostTempFasta, hostRecords);
    await writeFasta(pathogenTempFasta, pathogenRecords);
  }

  try {
    for (let i = 1; i < genomeNumber; i += 1) {
      const dbName = poolList[i];
      const dbPath = path.join(poolConfig.poolFolder, dbName);
      const dmndPath = `${dbPath}.dmnd`;
      if (!(await pathExists(dmndPath))) {
        throw new HttpError(500, "Missing DIAMOND database", `Expected file not found: ${dmndPath}`);
      }
      const hostCachedBlast = await resolveCachedBlastFile({
        cacheRoot: blastCacheRoot,
        genomePool,
        species: host,
        dbName,
        index: i
      });
      const pathogenCachedBlast = await resolveCachedBlastFile({
        cacheRoot: blastCacheRoot,
        genomePool,
        species: pathogen,
        dbName,
        index: i
      });

      let hostBlastFile = hostCachedBlast;
      let pathogenBlastFile = pathogenCachedBlast;
      if (!hostBlastFile || !pathogenBlastFile) {
        await ensureTempInputs();
      }
      if (!hostBlastFile) {
        hostBlastFile = path.join(tempDir, `${host}_blast_${i}.txt`);
        await runDiamondBlast({
          dbPath,
          queryFasta: hostTempFasta,
          evalue: he,
          outputFile: hostBlastFile
        });
      }
      if (!pathogenBlastFile) {
        pathogenBlastFile = path.join(tempDir, `${pathogen}_blast_${i}.txt`);
        await runDiamondBlast({
          dbPath,
          queryFasta: pathogenTempFasta,
          evalue: pe,
          outputFile: pathogenBlastFile
        });
      }

      const hostPresent = await buildPresenceSet(hostBlastFile, hi, hc);
      const pathogenPresent = await buildPresenceSet(pathogenBlastFile, pi, pc);
      appendPattern(hostPatterns, hostGeneIds, hostPresent);
      appendPattern(pathogenPatterns, pathogenGeneIds, pathogenPresent);
    }

    const nullPattern = "0".repeat(genomeNumber - 1);
    const rows = buildPairwiseScores({
      hostGeneIds,
      pathogenGeneIds,
      hostPatterns,
      pathogenPatterns,
      threshold,
      genomeNumber,
      nullPattern
    });

    return persistPhyloResults(rows);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, "JS phylo job failed", error.message || String(error));
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  runPhyloJob
};
