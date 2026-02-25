# HPInet Backend Next

Modernized backend rewrite in a new folder (`hpinetbackend-next`) with API-compatible routes.

## Goals

- Keep existing `/api/*` endpoint compatibility.
- Improve correctness with strict input validation and safer query building.
- Improve speed with shared pagination helpers, `lean()` reads, and reduced duplicated logic.
- Replace legacy compute pipelines with JS-native services incrementally.

## Run

1. Copy `.env.example` to `.env`
2. Install dependencies:
   - `npm install`
3. Start dev server:
   - `npm run dev`
4. Start production mode:
   - `npm start`

Default port is `3816` to avoid clashing with legacy backend.

## Compatibility

Implemented compatible routes:

- `POST /api/ppi`
- `POST /api/goppi`
- `POST /api/phyloppi`
- `GET /api/results/`
- `GET /api/network/`
- `GET /api/download/`
- `POST /api/domain_results/`
- `POST /api/domain_download/`
- `GET /api/go/`
- `GET /api/kegg/`
- `GET /api/interpro/`
- `GET /api/local/`
- `GET /api/tf/`
- `GET /api/effector/`
- `GET /api/annotation/`

Health check:

- `GET /health`

Compatibility alias for frontend proxy:

- `/hpinetbackend/api/*` maps to the same handlers as `/api/*`

## JS-Native Status

- `/api/ppi` is implemented in Node.js for `interolog` and `consensus` categories.
- `/api/phyloppi` is implemented in Node.js.
- `/api/goppi` is implemented in Node.js (Mongo-backed GO annotations + local GO OBO graph).

Set these in `.env` for JS-native `/api/ppi`:

- `BLAST_DB` (SQLite blast DB path)
- `PPI_SQLITE_PATH` (SQLite PPI DB path)
- `DOMAIN_SQLITE_PATH` (SQLite domain DB path)

Optional Mongo-backed test path for `/api/ppi` (`interolog` + `consensus`):

- `INTEROLOG_USE_MONGO=true`
- `INTEROLOG_MONGO_DB=hpinetdb`

Sample migration script for wheat/utritici:

- `npm run migrate:consensus-sample -- --host wheat --pathogen utritici --intdb biogrid --drop`

GO SQLite to Mongo migration:

- `npm run migrate:go-sqlite -- --drop`
- `npm run migrate:go-sqlite -- --species wheat,tindica --drop`

The GO migration writes normalized documents into `hpinetdb.go_terms_v2` by default:

- `species`, `sptype`, `gene`
- `term` (raw pipe-delimited string), `terms` (normalized unique GO term array)
- `term_count`, `source_table`, `source_index`

Indexes created:

- `{ species: 1, gene: 1 }` unique
- `{ species: 1, sptype: 1 }`
- `{ species: 1, terms: 1 }`

JS phylo runtime settings (`/api/phyloppi`):

- `PHYLO_ROOT` (path containing `data/`, `dbs/`, and pool files)
- `DIAMOND_BIN` (path to `diamond` executable)
- `PHYLO_THREADS` (threads used by DIAMOND)

JS GO runtime settings (`/api/goppi`):

- `GO_AUTO_DOWNLOAD_OBO` (default: `true`)
- `GO_OBO_URL` (default: `https://purl.obolibrary.org/obo/go/go-basic.obo`)
- `GO_OBO_PATH` (path to `go-basic.obo`)
- `GO_MONGO_COLLECTION` (default: `go_terms_v2`)
