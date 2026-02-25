const { mongoose } = require("../db/mongoose");

const wheatSchema = new mongoose.Schema(
  {
    Host_Protein: String,
    Pathogen_Protein: String,
    ProteinA: String,
    ProteinB: String,
    intdb_x: String,
    Method: String,
    Type: String,
    Confidence: String,
    PMID: String
  },
  { strict: false, versionKey: false }
);

const goppiSchema = new mongoose.Schema(
  {
    Host_Protein: String,
    Pathogen_Protein: String,
    Host_GO: String,
    Pathogen_GO: String,
    score: Number
  },
  { strict: false, versionKey: false }
);

const phyloSchema = new mongoose.Schema(
  {
    Host_Protein: String,
    Pathogen_Protein: String,
    Score: Number,
    Host_Pattern: String,
    Pathogen_Pattern: String
  },
  { strict: false, versionKey: false }
);

const domainSchema = new mongoose.Schema(
  {
    Host_Protein: String,
    Pathogen_Protein: String,
    ProteinA: String,
    ProteinB: String,
    score: Number,
    DomianA_name: String,
    DomainA_desc: String,
    DomianA_interpro: String,
    DomianB_name: String,
    DomainB_desc: String,
    DomianB_interpro: String,
    intdb: String
  },
  { strict: false, versionKey: false }
);

const consensusSchema = new mongoose.Schema(
  {
    Host_Protein: String,
    Pathogen_Protein: String,
    ProteinA_x: String,
    ProteinB_x: String,
    intdb_x: String,
    Method: String,
    Type: String,
    Confidence: String,
    PMID: String,
    ProteinA_y: String,
    ProteinB_y: String,
    score: Number,
    DomianA_name: String,
    DomainA_desc: String,
    DomianA_interpro: String,
    DomianB_name: String,
    DomainB_desc: String,
    DomianB_interpro: String,
    intdb: String
  },
  { strict: false, versionKey: false }
);

module.exports = {
  wheatSchema,
  goppiSchema,
  phyloSchema,
  domainSchema,
  consensusSchema
};
