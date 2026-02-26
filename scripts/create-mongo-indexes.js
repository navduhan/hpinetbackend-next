#!/usr/bin/env node
const { connectMongo, mongoose, useDb } = require("../src/db/mongoose");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipResults: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    if (token === "--skip-results") args.skipResults = true;
  }
  return args;
}

async function ensureIndex(collection, spec, options, report, dryRun) {
  const name = collection.collectionName;
  if (dryRun) {
    report.push({ collection: name, spec, options, action: "plan" });
    return;
  }
  const result = await collection.createIndex(spec, options);
  report.push({ collection: name, spec, options, action: "created", result });
}

async function createHpinetDbIndexes({ dryRun, report }) {
  const db = useDb("hpinetdb");
  const collections = await db.db.listCollections({}, { nameOnly: true }).toArray();
  const names = collections.map((entry) => String(entry.name || ""));

  const annotationCollections = [
    "go_hosts",
    "go_pathogens",
    "kegg_hosts",
    "kegg_pathogens",
    "interpro_hosts",
    "interpro_pathogens",
    "local_hosts",
    "local_pathogens",
    "tf_hosts",
    "effector_pathogens"
  ];

  for (const name of annotationCollections) {
    if (!names.includes(name)) continue;
    const collection = db.collection(name);
    await ensureIndex(collection, { gene: 1 }, { name: "gene_1" }, report, dryRun);
    await ensureIndex(collection, { species: 1, gene: 1 }, { name: "species_1_gene_1" }, report, dryRun);
  }

  if (names.includes("go_terms_v2")) {
    const collection = db.collection("go_terms_v2");
    await ensureIndex(collection, { id: 1 }, { name: "id_1", sparse: true }, report, dryRun);
    await ensureIndex(collection, { name: 1 }, { name: "name_1", sparse: true }, report, dryRun);
  }

  if (names.includes("plant_snapshots")) {
    const collection = db.collection("plant_snapshots");
    await ensureIndex(collection, { key: 1 }, { name: "key_1", unique: true }, report, dryRun);
    await ensureIndex(collection, { host: 1, pathogen: 1 }, { name: "host_1_pathogen_1" }, report, dryRun);
  }

  for (const name of names) {
    if (name.endsWith("_domains")) {
      const collection = db.collection(name);
      await ensureIndex(collection, { Host_Protein: 1 }, { name: "Host_Protein_1" }, report, dryRun);
      await ensureIndex(collection, { Pathogen_Protein: 1 }, { name: "Pathogen_Protein_1" }, report, dryRun);
      await ensureIndex(collection, { intdb: 1 }, { name: "intdb_1" }, report, dryRun);
      await ensureIndex(
        collection,
        { Host_Protein: 1, Pathogen_Protein: 1, intdb: 1 },
        { name: "Host_Protein_1_Pathogen_Protein_1_intdb_1" },
        report,
        dryRun
      );
    }

    if (name.startsWith("interolog_")) {
      const collection = db.collection(name);
      await ensureIndex(collection, { qseqid: 1 }, { name: "qseqid_1" }, report, dryRun);
      await ensureIndex(collection, { sseqid: 1 }, { name: "sseqid_1" }, report, dryRun);
      await ensureIndex(collection, { intdb: 1 }, { name: "intdb_1" }, report, dryRun);
      await ensureIndex(collection, { qseqid: 1, intdb: 1 }, { name: "qseqid_1_intdb_1" }, report, dryRun);
    }
  }
}

async function createHpinetResultsIndexes({ dryRun, report }) {
  const db = useDb("hpinet_results");
  const collections = await db.db.listCollections({}, { nameOnly: true }).toArray();
  for (const entry of collections) {
    const name = String(entry.name || "");
    if (!/^hpinet\d{10,16}results$/.test(name)) {
      continue;
    }
    const collection = db.collection(name);
    await ensureIndex(collection, { Host_Protein: 1 }, { name: "Host_Protein_1" }, report, dryRun);
    await ensureIndex(collection, { Pathogen_Protein: 1 }, { name: "Pathogen_Protein_1" }, report, dryRun);
    await ensureIndex(collection, { Confidence: -1 }, { name: "Confidence_-1" }, report, dryRun);
    await ensureIndex(collection, { intdb_x: 1 }, { name: "intdb_x_1", sparse: true }, report, dryRun);
    await ensureIndex(collection, { intdb: 1 }, { name: "intdb_1", sparse: true }, report, dryRun);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const report = [];
  await connectMongo();
  await createHpinetDbIndexes({ dryRun: args.dryRun, report });
  if (!args.skipResults) {
    await createHpinetResultsIndexes({ dryRun: args.dryRun, report });
  }
  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        skipResults: args.skipResults,
        totalActions: report.length,
        actions: report
      },
      null,
      2
    )
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Failed to create indexes:", error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
