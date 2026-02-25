#!/usr/bin/env node
const { connectMongo, mongoose } = require("../src/db/mongoose");
const { rebuildPlantSnapshots } = require("../src/services/annotationService");

function parseArgs(argv) {
  const args = { host: "", pathogen: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--host" && argv[i + 1]) {
      args.host = argv[i + 1];
      i += 1;
    } else if (token === "--pathogen" && argv[i + 1]) {
      args.pathogen = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const { host, pathogen } = parseArgs(process.argv);
  await connectMongo();
  const result = await rebuildPlantSnapshots({ host, pathogen });
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Failed to build plant snapshots:", error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore disconnect errors on failure path
  }
  process.exit(1);
});

