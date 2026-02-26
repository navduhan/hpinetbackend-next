const SOURCE_WEIGHTS = {
  hpidb: 0.9,
  intact: 0.86,
  mint: 0.84,
  dip: 0.8,
  biogrid: 0.78,
  arabihpi: 0.72,
  string: 0.7,
  "3did": 0.86,
  iddi: 0.82,
  domine: 0.74
};

const CATEGORY_WEIGHTS = {
  consensus: { method: 0.45, source: 0.2, cross: 0.3, annotation: 0.05 },
  interolog: { method: 0.55, source: 0.28, cross: 0.12, annotation: 0.05 },
  domain: { method: 0.6, source: 0.25, cross: 0.1, annotation: 0.05 },
  go: { method: 0.72, source: 0.03, cross: 0.05, annotation: 0.2 },
  gosim: { method: 0.72, source: 0.03, cross: 0.05, annotation: 0.2 },
  phylo: { method: 0.76, source: 0.04, cross: 0.1, annotation: 0.1 },
  default: { method: 0.6, source: 0.2, cross: 0.15, annotation: 0.05 }
};

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function parseNumeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRawConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return null;
    if (v === "high") return 0.9;
    if (v === "medium" || v === "moderate") return 0.65;
    if (v === "low") return 0.35;
  }

  const n = parseNumeric(value);
  if (n === null) return null;
  if (n > 1 && n <= 100) return clamp01(n / 100);
  return clamp01(n);
}

function parseSourceList(row) {
  const sources = [];
  for (const field of ["intdb_x", "intdb"]) {
    const raw = String(row?.[field] || "");
    if (!raw) continue;
    raw.split(/[;,|]/).forEach((item) => {
      const v = item.trim();
      if (v) sources.push(v);
    });
  }
  return Array.from(new Set(sources));
}

function sourceWeight(source) {
  const k = String(source || "").toLowerCase();
  return SOURCE_WEIGHTS[k] || 0.68;
}

function average(values, fallback = 0) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return fallback;
  const sum = valid.reduce((a, b) => a + b, 0);
  return sum / valid.length;
}

function inferMethodScore(row, category) {
  const c = String(category || "").toLowerCase();
  if (c === "go" || c === "gosim" || c === "phylo") {
    const fromScore = normalizeRawConfidence(row?.Score);
    if (fromScore !== null) return fromScore;
    return normalizeRawConfidence(row?.score) || 0;
  }
  if (c === "domain") {
    const fromScore = normalizeRawConfidence(row?.Score);
    if (fromScore !== null) return fromScore;
    return normalizeRawConfidence(row?.score) || 0;
  }
  if (c === "consensus" || c === "interolog") {
    const fromConfidence = normalizeRawConfidence(row?.Confidence);
    if (fromConfidence !== null) return fromConfidence;
    const fromScore = normalizeRawConfidence(row?.Score);
    if (fromScore !== null) return fromScore;
    return 0;
  }
  return normalizeRawConfidence(row?.Score) || normalizeRawConfidence(row?.score) || 0;
}

function inferCrossMethodSupport(row, category) {
  const c = String(category || "").toLowerCase();
  if (c === "consensus") return 1;
  if (c === "interolog") return 0.35;
  if (c === "domain") return 0.3;
  if (c === "go" || c === "gosim") return 0.25;
  if (c === "phylo") return 0.25;

  const hasInterolog = Boolean(row?.Method || row?.intdb_x);
  const hasDomain = Boolean(row?.DomainA_interpro || row?.DomianA_interpro || row?.intdb);
  if (hasInterolog && hasDomain) return 0.8;
  if (hasInterolog || hasDomain) return 0.35;
  return 0.2;
}

function inferAnnotationSupport(row, category) {
  const c = String(category || "").toLowerCase();
  const hasGo = Boolean(row?.Host_GO || row?.Pathogen_GO);
  const hasDomainAnno = Boolean(row?.DomainA_interpro || row?.DomianA_interpro || row?.DomainB_interpro || row?.DomianB_interpro);
  const hasPmid = Boolean(row?.PMID);

  if (c === "go" || c === "gosim") return hasGo ? 1 : 0.35;
  if (c === "domain") return hasDomainAnno ? 0.9 : 0.5;
  if (c === "consensus") return hasDomainAnno || hasPmid ? 0.85 : 0.5;
  if (c === "interolog") return hasPmid ? 0.7 : 0.45;
  if (c === "phylo") return hasDomainAnno || hasGo ? 0.5 : 0.35;
  return 0.4;
}

function getWeights(category) {
  const c = String(category || "").toLowerCase();
  return CATEGORY_WEIGHTS[c] || CATEGORY_WEIGHTS.default;
}

function tierFromConfidence(confidence) {
  if (confidence >= 0.75) return "High";
  if (confidence >= 0.5) return "Medium";
  return "Low";
}

function methodsPresent(category) {
  const c = String(category || "").toLowerCase();
  if (c === "consensus") return ["interolog", "domain"];
  if (c === "interolog") return ["interolog"];
  if (c === "domain") return ["domain"];
  if (c === "go" || c === "gosim") return ["go_similarity"];
  if (c === "phylo") return ["phylo_profiling"];
  return [c || "unknown"];
}

function scoreRowConfidence(row, category) {
  const rawConfidence = row?.Confidence ?? row?.Score ?? row?.score ?? null;
  const methodScore = clamp01(inferMethodScore(row, category));
  const sources = parseSourceList(row);
  const sourceScore = clamp01(average(sources.map(sourceWeight), 0.65));
  const crossSupport = clamp01(inferCrossMethodSupport(row, category));
  const annotationSupport = clamp01(inferAnnotationSupport(row, category));
  const weights = getWeights(category);

  const confidence = clamp01(
    methodScore * weights.method +
      sourceScore * weights.source +
      crossSupport * weights.cross +
      annotationSupport * weights.annotation
  );
  const rounded = Number(confidence.toFixed(4));

  return {
    ...row,
    RawConfidence: rawConfidence,
    Confidence: rounded,
    ConfidenceTier: tierFromConfidence(rounded),
    ConfidenceComponents: {
      method: Number(methodScore.toFixed(4)),
      source: Number(sourceScore.toFixed(4)),
      cross: Number(crossSupport.toFixed(4)),
      annotation: Number(annotationSupport.toFixed(4))
    },
    EvidenceMethods: methodsPresent(category),
    EvidenceSources: sources
  };
}

function scoreRowsConfidence(rows, category) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.map((row) => scoreRowConfidence(row, category));
}

function getConfidenceMeta() {
  return {
    formula: "Confidence = (method x Wm) + (source x Ws) + (cross x Wx) + (annotation x Wa)",
    tierThresholds: {
      high: ">= 0.75",
      medium: ">= 0.50 and < 0.75",
      low: "< 0.50"
    },
    categoryWeights: CATEGORY_WEIGHTS,
    sourceWeights: SOURCE_WEIGHTS
  };
}

module.exports = {
  scoreRowConfidence,
  scoreRowsConfidence,
  getConfidenceMeta
};
