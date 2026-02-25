const env = require("../config/env");
const { useDb } = require("../db/mongoose");
const { HttpError } = require("../errors/HttpError");
const { toGeneList } = require("../utils/genes");

function assertSafeIdentifier(name, label) {
  const value = String(name || "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new HttpError(400, `Invalid ${label}: ${name}`);
  }
  return value;
}

function parseDbList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function chunk(values, size = 400) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
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

function appendRows(target, source) {
  for (const row of source) {
    target.push(row);
  }
}

function getCollectionName() {
  return `hpinet${Date.now()}results`;
}

async function persistResults(records) {
  const resultsDb = useDb("hpinet_results");
  const collectionName = getCollectionName();
  const collection = resultsDb.collection(collectionName);
  if (records.length > 0) {
    await collection.insertMany(records, { ordered: false });
  } else {
    await collection.insertOne({ result: "no results" });
  }
  return collectionName;
}

function blastQuery({ table, ident, coverage, evalue, intdb, genes }) {
  const safeTable = assertSafeIdentifier(table, "blast table");
  const params = [Number(ident || 0), Number(evalue || 0), Number(coverage || 0), String(intdb)];
  let sql = `SELECT qseqid, sseqid, intdb FROM ${safeTable} WHERE pident >= ? AND evalue <= ? AND qcovs >= ? AND intdb = ?`;

  if (genes && genes.length > 0) {
    sql += ` AND qseqid IN (${genes.map(() => "?").join(",")})`;
    params.push(...genes);
  }

  return { sql, params };
}

async function fetchBlastRowsMongo(mongoDb, options) {
  const safeTable = assertSafeIdentifier(options.table, "blast table");
  const query = {
    pident: { $gte: Number(options.ident || 0) },
    evalue: { $lte: Number(options.evalue || 0) },
    qcovs: { $gte: Number(options.coverage || 0) },
    intdb: String(options.intdb)
  };
  if (options.genes && options.genes.length > 0) {
    query.qseqid = { $in: options.genes };
  }
  return mongoDb
    .collection(safeTable)
    .find(query, { projection: { _id: 0, qseqid: 1, sseqid: 1, intdb: 1 } })
    .toArray();
}

async function fetchPpiRowsMongo(mongoDb, ppiTableName, hostSseqList, pathogenSseqList) {
  const safeTable = assertSafeIdentifier(ppiTableName, "ppi table");
  if (hostSseqList.length === 0 || pathogenSseqList.length === 0) {
    return [];
  }

  const hostChunks = chunk(hostSseqList, 300);
  const pathogenChunks = chunk(pathogenSseqList, 300);
  const rows = [];
  const collection = mongoDb.collection(safeTable);

  for (const hostChunk of hostChunks) {
    for (const pathogenChunk of pathogenChunks) {
      const query = {
        $or: [
          {
            ProteinA: { $in: hostChunk },
            ProteinB: { $in: pathogenChunk }
          },
          {
            ProteinA: { $in: pathogenChunk },
            ProteinB: { $in: hostChunk }
          }
        ]
      };
      const chunkRows = await collection
        .find(query, {
          projection: {
            _id: 0,
            ProteinA: 1,
            ProteinB: 1,
            Method: 1,
            Type: 1,
            Confidence: 1,
            PMID: 1
          }
        })
        .toArray();
      appendRows(rows, chunkRows);
    }
  }

  return dedupeRows(rows);
}

function buildSseqIndex(rows, field = "sseqid", value = "qseqid") {
  const index = new Map();
  for (const row of rows) {
    const key = row[field];
    const val = row[value];
    if (!key || !val) {
      continue;
    }
    const list = index.get(key) || [];
    list.push(val);
    index.set(key, list);
  }
  return index;
}

function buildInterologRowsForDb(interologDb, hostBlastRows, pathogenBlastRows, ppiRows) {
  const hostBySseq = buildSseqIndex(hostBlastRows);
  const pathogenBySseq = buildSseqIndex(pathogenBlastRows);
  const results = [];

  for (const ppi of ppiRows) {
    const hostFromA = hostBySseq.get(ppi.ProteinA) || [];
    const pathogenFromB = pathogenBySseq.get(ppi.ProteinB) || [];
    for (const hostProtein of hostFromA) {
      for (const pathogenProtein of pathogenFromB) {
        results.push({
          Host_Protein: hostProtein,
          Pathogen_Protein: pathogenProtein,
          ProteinA: ppi.ProteinA,
          ProteinB: ppi.ProteinB,
          intdb_x: interologDb,
          Method: ppi.Method,
          Type: ppi.Type,
          Confidence: ppi.Confidence,
          PMID: ppi.PMID
        });
      }
    }

    const hostFromB = hostBySseq.get(ppi.ProteinB) || [];
    const pathogenFromA = pathogenBySseq.get(ppi.ProteinA) || [];
    for (const hostProtein of hostFromB) {
      for (const pathogenProtein of pathogenFromA) {
        results.push({
          Host_Protein: hostProtein,
          Pathogen_Protein: pathogenProtein,
          ProteinA: ppi.ProteinA,
          ProteinB: ppi.ProteinB,
          intdb_x: interologDb,
          Method: ppi.Method,
          Type: ppi.Type,
          Confidence: ppi.Confidence,
          PMID: ppi.PMID
        });
      }
    }
  }

  return dedupeRows(results);
}

async function fetchDomainRowsMongo(mongoDb, table, idType, genes, domdbList) {
  const safeTable = assertSafeIdentifier(table, "domain table");
  const safeDomdb = domdbList.map((item) => String(item).trim().toUpperCase()).filter(Boolean);

  if (safeDomdb.length === 0) {
    return [];
  }

  const query = {
    intdb: { $in: safeDomdb }
  };
  if (genes.length > 0 && idType === "host") {
    query.Host_Protein = { $in: genes };
  } else if (genes.length > 0 && idType === "pathogen") {
    query.Pathogen_Protein = { $in: genes };
  }

  const rows = await mongoDb
    .collection(safeTable)
    .find(query, {
      projection: {
        _id: 0,
        Host_Protein: 1,
        Pathogen_Protein: 1,
        ProteinA: 1,
        ProteinB: 1,
        Score: 1,
        DomainA_name: 1,
        DomianA_desc: 1,
        DomainA_interpro: 1,
        DomainB_name: 1,
        DomianB_desc: 1,
        DomainB_interpro: 1,
        intdb: 1
      }
    })
    .toArray();

  return rows.map((row) => ({
    Host_Protein: row.Host_Protein,
    Pathogen_Protein: row.Pathogen_Protein,
    ProteinA: row.ProteinA,
    ProteinB: row.ProteinB,
    Score: row.Score,
    DomainA_name: row.DomainA_name,
    DomainA_desc: row.DomianA_desc,
    DomainA_interpro: row.DomainA_interpro,
    DomainB_name: row.DomainB_name,
    DomainB_desc: row.DomianB_desc,
    DomainB_interpro: row.DomainB_interpro,
    intdb: row.intdb
  }));
}

function mergeConsensus(interologRows, domainRows) {
  const domainByPair = new Map();
  for (const row of domainRows) {
    const key = `${row.Host_Protein}||${row.Pathogen_Protein}`;
    const list = domainByPair.get(key) || [];
    list.push(row);
    domainByPair.set(key, list);
  }

  const merged = [];
  for (const row of interologRows) {
    const key = `${row.Host_Protein}||${row.Pathogen_Protein}`;
    const matches = domainByPair.get(key) || [];
    for (const d of matches) {
      merged.push({
        Host_Protein: row.Host_Protein,
        Pathogen_Protein: row.Pathogen_Protein,
        ProteinA_x: row.ProteinA,
        ProteinB_x: row.ProteinB,
        intdb_x: row.intdb_x,
        Method: row.Method,
        Type: row.Type,
        Confidence: row.Confidence,
        PMID: row.PMID,
        ProteinA_y: d.ProteinA,
        ProteinB_y: d.ProteinB,
        score: d.Score,
        DomianA_name: d.DomainA_name,
        DomainA_desc: d.DomainA_desc,
        DomianA_interpro: d.DomainA_interpro,
        DomianB_name: d.DomainB_name,
        DomainB_desc: d.DomainB_desc,
        DomianB_interpro: d.DomainB_interpro,
        intdb: d.intdb
      });
    }
  }

  return dedupeRows(merged);
}

async function runInterologJob(payload, geneCsv) {
  const method = String(payload.category || "").toLowerCase();
  if (method !== "interolog" && method !== "consensus") {
    throw new HttpError(400, `Unsupported category for JS port: ${payload.category}`);
  }

  const hostTable = assertSafeIdentifier(String(payload.hspecies || "").toLowerCase(), "host table");
  const pathogenTable = assertSafeIdentifier(String(payload.pspecies || ""), "pathogen table");
  const idType = String(payload.ids || "").toLowerCase();
  const genes = toGeneList(geneCsv);
  const hostGenes = idType === "host" ? genes : [];
  const pathogenGenes = idType === "pathogen" ? genes : [];
  const intdbList = parseDbList(payload.intdb).map((item) => item.toLowerCase());
  const domdbList = parseDbList(payload.domdb);

  if (intdbList.length === 0) {
    throw new HttpError(400, "At least one interolog DB is required");
  }

  const mongoDb = useDb(env.INTEROLOG_MONGO_DB);

  try {
    const allInterologRows = [];

    for (const intdb of intdbList) {
      const interologDb = assertSafeIdentifier(intdb, "interolog db");
      const hostBlastRows = await fetchBlastRowsMongo(mongoDb, {
        table: hostTable,
        ident: payload.hi,
        coverage: payload.hc,
        evalue: payload.he,
        intdb: interologDb,
        genes: hostGenes
      });
      const pathogenBlastRows = await fetchBlastRowsMongo(mongoDb, {
        table: pathogenTable,
        ident: payload.pi,
        coverage: payload.pc,
        evalue: payload.pe,
        intdb: interologDb,
        genes: pathogenGenes
      });

      if (hostBlastRows.length === 0 || pathogenBlastRows.length === 0) {
        continue;
      }

      const ppiTable = `${interologDb}s`;
      const hostSseq = Array.from(new Set(hostBlastRows.map((row) => row.sseqid).filter(Boolean)));
      const pathogenSseq = Array.from(new Set(pathogenBlastRows.map((row) => row.sseqid).filter(Boolean)));
      const ppiRows = await fetchPpiRowsMongo(mongoDb, ppiTable, hostSseq, pathogenSseq);

      if (ppiRows.length === 0) {
        continue;
      }

      appendRows(allInterologRows, buildInterologRowsForDb(interologDb, hostBlastRows, pathogenBlastRows, ppiRows));
    }

    const interologRows = dedupeRows(allInterologRows);
    if (method === "interolog") {
      return persistResults(interologRows);
    }

    const hostSpecies = String(payload.hspecies || "")
      .replace(/^interolog_/i, "")
      .trim()
      .toLowerCase();
    const pathogenSpecies = String(payload.pspecies || "")
      .replace(/^interolog_/i, "")
      .trim()
      .toLowerCase();
    const domainTable = assertSafeIdentifier(`${hostSpecies}_${pathogenSpecies}_domains`, "consensus domain table");
    const domainRows = await fetchDomainRowsMongo(mongoDb, domainTable, idType, genes, domdbList);
    const consensusRows = mergeConsensus(interologRows, domainRows);
    return persistResults(consensusRows);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, "JS interolog job failed", error.message || String(error));
  }
}

module.exports = {
  runInterologJob
};
