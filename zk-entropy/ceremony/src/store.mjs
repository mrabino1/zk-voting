/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Ceremony persistence: SQLite file on a volume (default) or Postgres when
 * DATABASE_URL is set. Both expose the same small async interface.
 *
 * Appends are serialized twice: an in-process mutex, and a DB transaction
 * (SQLite BEGIN IMMEDIATE, Postgres SELECT ... FOR UPDATE on the head row),
 * so two contributions can never chain off the same parent.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ceremony_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS ceremony_contributions (
     idx INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     contribution TEXT NOT NULL,
     contribution_hash TEXT NOT NULL UNIQUE,
     client_transcript_hash TEXT,
     state_after TEXT NOT NULL
   )`,
];

function mutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

function rowOut(r) {
  return {
    index: Number(r.idx),
    at: r.at,
    contribution: r.contribution,
    contributionHash: r.contribution_hash,
    clientTranscriptHash: r.client_transcript_hash ?? null,
    stateAfter: r.state_after,
  };
}

export async function openSqliteStore(file) {
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  for (const s of SCHEMA) db.exec(s);
  const lock = mutex();
  const getMeta = db.prepare("SELECT value FROM ceremony_meta WHERE key = ?");
  const putMeta = db.prepare("INSERT INTO ceremony_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const addMeta = db.prepare("INSERT INTO ceremony_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
  const insert = db.prepare(
    "INSERT INTO ceremony_contributions (idx, at, contribution, contribution_hash, client_transcript_hash, state_after) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const hasHash = db.prepare("SELECT 1 AS x FROM ceremony_contributions WHERE contribution_hash = ?");
  const list = db.prepare("SELECT * FROM ceremony_contributions ORDER BY idx");
  const read = (key) => {
    const r = getMeta.get(key);
    return r ? JSON.parse(r.value) : null;
  };
  return {
    kind: "sqlite",
    async ping() {
      db.prepare("SELECT 1").get();
      return true;
    },
    async getMeta(key) {
      return read(key);
    },
    async setMeta(key, value) {
      putMeta.run(key, JSON.stringify(value));
    },
    async setMetaIfAbsent(key, value) {
      return lock(async () => addMeta.run(key, JSON.stringify(value)).changes === 1);
    },
    /** Read-modify-write of one meta key under the lock. */
    async updateMeta(key, fn) {
      return lock(async () => {
        const next = await fn(read(key));
        if (next !== undefined) putMeta.run(key, JSON.stringify(next));
        return next;
      });
    },
    /**
     * prepare(head) -> { row, head, meta? } runs with the head locked.
     * It may throw to refuse. The row and new head are written atomically.
     */
    async append(prepare) {
      return lock(async () => {
        const head = read("head");
        const out = await prepare(head);
        if (hasHash.get(out.row.contributionHash)) {
          const e = new Error("duplicate contribution");
          e.code = "DUPLICATE";
          throw e;
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          const r = out.row;
          insert.run(r.index, r.at, r.contribution, r.contributionHash, r.clientTranscriptHash ?? null, r.stateAfter);
          putMeta.run("head", JSON.stringify(out.head));
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return out;
      });
    },
    async listContributions() {
      return list.all().map(rowOut);
    },
    async withLock(fn) {
      return lock(fn);
    },
    async close() {
      db.close();
    },
  };
}

export async function openPostgresStore(url) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  for (const s of SCHEMA) await pool.query(s);
  const lock = mutex();
  const read = async (q, key) => {
    const r = await q.query("SELECT value FROM ceremony_meta WHERE key = $1", [key]);
    return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
  };
  const put = (q, key, value) =>
    q.query("INSERT INTO ceremony_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
  // Make sure the head row exists so FOR UPDATE has something to lock.
  await pool.query("INSERT INTO ceremony_meta (key, value) VALUES ('head_lock', '0') ON CONFLICT (key) DO NOTHING");
  return {
    kind: "postgres",
    async ping() {
      await pool.query("SELECT 1");
      return true;
    },
    async getMeta(key) {
      return read(pool, key);
    },
    async setMeta(key, value) {
      await put(pool, key, value);
    },
    async setMetaIfAbsent(key, value) {
      const r = await pool.query("INSERT INTO ceremony_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(value)]);
      return r.rowCount === 1;
    },
    async updateMeta(key, fn) {
      return lock(() =>
        tx(async (c) => {
          await c.query("SELECT value FROM ceremony_meta WHERE key = 'head_lock' FOR UPDATE");
          const next = await fn(await read(c, key));
          if (next !== undefined) await put(c, key, next);
          return next;
        })
      );
    },
    async append(prepare) {
      return lock(() =>
        tx(async (c) => {
          await c.query("SELECT value FROM ceremony_meta WHERE key = 'head_lock' FOR UPDATE");
          const out = await prepare(await read(c, "head"));
          const dup = await c.query("SELECT 1 FROM ceremony_contributions WHERE contribution_hash = $1", [out.row.contributionHash]);
          if (dup.rowCount) {
            const e = new Error("duplicate contribution");
            e.code = "DUPLICATE";
            throw e;
          }
          const r = out.row;
          await c.query(
            "INSERT INTO ceremony_contributions (idx, at, contribution, contribution_hash, client_transcript_hash, state_after) VALUES ($1, $2, $3, $4, $5, $6)",
            [r.index, r.at, r.contribution, r.contributionHash, r.clientTranscriptHash ?? null, r.stateAfter]
          );
          await put(c, "head", out.head);
          return out;
        })
      );
    },
    async listContributions() {
      const r = await pool.query("SELECT * FROM ceremony_contributions ORDER BY idx");
      return r.rows.map(rowOut);
    },
    async withLock(fn) {
      return lock(() =>
        tx(async (c) => {
          await c.query("SELECT value FROM ceremony_meta WHERE key = 'head_lock' FOR UPDATE");
          return fn();
        })
      );
    },
    async close() {
      await pool.end();
    },
  };
}

export async function openStore(config) {
  if (config.databaseUrl) return openPostgresStore(config.databaseUrl);
  return openSqliteStore(config.sqliteFile);
}
