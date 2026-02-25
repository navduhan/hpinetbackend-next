#!/usr/bin/env node
const { connectMongo, mongoose, useDb } = require("../src/db/mongoose");

function parseArgs(argv) {
  const args = {
    days: 30,
    dryRun: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--days" && argv[i + 1]) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.days = Math.floor(value);
      }
      i += 1;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

function extractTimestampFromCollectionName(name) {
  const match = /^hpinet(\d{10,16})results$/.exec(String(name || ""));
  if (!match) {
    return null;
  }
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) {
    return null;
  }
  // Support both seconds and milliseconds in case of legacy names.
  return raw < 1e12 ? raw * 1000 : raw;
}

async function cleanupOldResults({ days, dryRun }) {
  const resultsDb = useDb("hpinet_results");
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  const collections = await resultsDb.listCollections({}, { nameOnly: true }).toArray();
  const candidates = [];
  for (const item of collections) {
    const name = String(item?.name || "");
    const createdAt = extractTimestampFromCollectionName(name);
    if (!createdAt) {
      continue;
    }
    if (createdAt < cutoff) {
      candidates.push({
        name,
        createdAt,
        createdAtIso: new Date(createdAt).toISOString()
      });
    }
  }

  if (!dryRun) {
    for (const item of candidates) {
      await resultsDb.dropCollection(item.name);
    }
  }

  return {
    days,
    dryRun,
    cutoffIso: new Date(cutoff).toISOString(),
    scannedCollections: collections.length,
    matchedCollections: candidates.length,
    droppedCollections: dryRun ? 0 : candidates.length,
    collections: candidates
  };
}

async function main() {
  const args = parseArgs(process.argv);
  await connectMongo();
  const report = await cleanupOldResults(args);
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Failed to cleanup old results:", error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore disconnect errors on failure
  }
  process.exit(1);
});

