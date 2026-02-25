const { mongoose, useDb } = require("../db/mongoose");

const GO_SCHEMA = new mongoose.Schema(
  {
    gene: String,
    term: String,
    description: String,
    definition: String,
    evidence: String,
    ontology: String,
    species: String
  },
  { strict: false, versionKey: false }
);

const KEGG_SCHEMA = new mongoose.Schema(
  {
    gene: String,
    pathway: String,
    description: String,
    species: String
  },
  { strict: false, versionKey: false }
);

const INTERPRO_SCHEMA = new mongoose.Schema(
  {
    gene: String,
    length: Number,
    interpro_id: String,
    sourcedb: String,
    domain: String,
    domain_description: String,
    score: Number,
    species: String
  },
  { strict: false, versionKey: false }
);

const LOCAL_SCHEMA = new mongoose.Schema(
  {
    gene: String,
    location: String,
    species: String
  },
  { strict: false, versionKey: false }
);

const TF_SCHEMA = new mongoose.Schema(
  {
    gene: String,
    tf_family: String,
    species: String
  },
  { strict: false, versionKey: false }
);

const EFFECTOR_SCHEMA = new mongoose.Schema(
  {
    gene: String,
    length: Number,
    description: String,
    type: String,
    species: String
  },
  { strict: false, versionKey: false }
);

function getAnnotationModels() {
  const db = useDb("hpinetdb");
  return {
    GO: {
      host: db.models.go_hosts || db.model("go_hosts", GO_SCHEMA),
      pathogen: db.models.go_pathogens || db.model("go_pathogens", GO_SCHEMA)
    },
    KEGG: {
      host: db.models.kegg_hosts || db.model("kegg_hosts", KEGG_SCHEMA),
      pathogen: db.models.kegg_pathogens || db.model("kegg_pathogens", KEGG_SCHEMA)
    },
    Interpro: {
      host: db.models.interpro_hosts || db.model("interpro_hosts", INTERPRO_SCHEMA),
      pathogen: db.models.interpro_pathogens || db.model("interpro_pathogens", INTERPRO_SCHEMA)
    },
    Local: {
      host: db.models.local_hosts || db.model("local_hosts", LOCAL_SCHEMA),
      pathogen: db.models.local_pathogens || db.model("local_pathogens", LOCAL_SCHEMA)
    },
    TF: {
      host: db.models.tf_hosts || db.model("tf_hosts", TF_SCHEMA)
    },
    Effector: {
      pathogen: db.models.effector_pathogens || db.model("effector_pathogens", EFFECTOR_SCHEMA)
    }
  };
}

module.exports = {
  getAnnotationModels
};
