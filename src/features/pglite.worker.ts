import { PGlite } from "@electric-sql/pglite";
import { worker } from "@electric-sql/pglite/worker";
import { vector } from "@electric-sql/pglite/vector";
import { pg_ivm } from "@electric-sql/pglite/pg_ivm";
import { pg_uuidv7 } from "@electric-sql/pglite/pg_uuidv7";
import { pgtap } from "@electric-sql/pglite/pgtap";

// Import contrib extensions
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { auto_explain } from "@electric-sql/pglite/contrib/auto_explain";
import { bloom } from "@electric-sql/pglite/contrib/bloom";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { cube } from "@electric-sql/pglite/contrib/cube";
import { earthdistance } from "@electric-sql/pglite/contrib/earthdistance";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { isn } from "@electric-sql/pglite/contrib/isn";
import { lo } from "@electric-sql/pglite/contrib/lo";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { seg } from "@electric-sql/pglite/contrib/seg";
import { tablefunc } from "@electric-sql/pglite/contrib/tablefunc";
import { tcn } from "@electric-sql/pglite/contrib/tcn";
import { tsm_system_rows } from "@electric-sql/pglite/contrib/tsm_system_rows";
import { tsm_system_time } from "@electric-sql/pglite/contrib/tsm_system_time";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

void worker({
  async init(options) {
    const db = await PGlite.create({
      dataDir: options.dataDir,
      extensions: {
        vector,
        pg_ivm,
        pg_uuidv7,
        pgtap,
        amcheck,
        auto_explain,
        bloom,
        btree_gin,
        btree_gist,
        citext,
        cube,
        earthdistance,
        fuzzystrmatch,
        hstore,
        isn,
        lo,
        ltree,
        pg_trgm,
        seg,
        tablefunc,
        tcn,
        tsm_system_rows,
        tsm_system_time,
        uuid_ossp,
      },
    });

    return db;
  },
});
