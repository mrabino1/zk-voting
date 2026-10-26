// NOT FOR PROFIT — civic public good, not a commercial product.
// Postgres persistence for the Node's app state.
//
// The Node keeps its working set in memory (Store.data, Explorer.chain), as it
// always has. When DATABASE_URL is set, that state is persisted to Postgres
// instead of DATA_DIR JSON files, so a container without a volume keeps its
// data across restarts and redeploys. Each top-level collection is stored as
// rows (one row per array element or map entry), and persist() writes only
// the rows that changed since the last save, inside one transaction.
//
// Without DATABASE_URL the JSON files in DATA_DIR remain the backend (dev
// fallback).

import os from 'node:os';

import pg from 'pg';

const { Pool } = pg;

/** Ordered, idempotent schema migrations. Never edit one that has shipped; append. */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'app state documents, writer fence, secrets',
    sql: `
      CREATE TABLE IF NOT EXISTS zkv_collections (
        ns          text        NOT NULL,
        name        text        NOT NULL,
        kind        text        NOT NULL CHECK (kind IN ('array', 'map', 'value')),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (ns, name)
      );
      CREATE TABLE IF NOT EXISTS zkv_rows (
        ns          text        NOT NULL,
        collection  text        NOT NULL,
        key         text        NOT NULL,
        pos         integer     NOT NULL DEFAULT 0,
        doc         jsonb       NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (ns, collection, key)
      );
      CREATE INDEX IF NOT EXISTS zkv_rows_order ON zkv_rows (ns, collection, pos);
      CREATE TABLE IF NOT EXISTS zkv_writer (
        ns          text        PRIMARY KEY,
        epoch       bigint      NOT NULL DEFAULT 0,
        owner       text,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS zkv_secrets (
        name        text        PRIMARY KEY,
        value       text        NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS zkv_imports (
        source      text        PRIMARY KEY,
        detail      jsonb,
        imported_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

const pools = new Map();
const migrated = new Map();

export function resolveDatabaseUrl(config = {}) {
  return String(config.databaseUrl || '').trim();
}

export function usingPostgres(config = {}) {
  return Boolean(resolveDatabaseUrl(config));
}

/** Redact credentials for logs: postgres://user:***@host:port/db */
export function describeDatabaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return `${u.protocol}//${u.username ? `${u.username}${u.password ? ':***' : ''}@` : ''}${u.host}${u.pathname}`;
  } catch {
    return 'postgres (unparsed DATABASE_URL)';
  }
}

function sslFor(url) {
  const mode = (() => {
    try {
      return new URL(url).searchParams.get('sslmode') || process.env.PGSSLMODE || '';
    } catch {
      return process.env.PGSSLMODE || '';
    }
  })();
  if (!mode || mode === 'disable' || mode === 'allow' || mode === 'prefer') return undefined;
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export function getPool(config) {
  const url = resolveDatabaseUrl(config);
  if (!url) throw new Error('DATABASE_URL is not set');
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
      ssl: sslFor(url),
      application_name: 'zk-voting-node',
    });
    pool.on('error', (err) => {
      console.warn(`[zk-voting] postgres pool error: ${err.message || err}`);
    });
    pools.set(url, pool);
  }
  return pool;
}

export async function closePools() {
  const all = [...pools.values()];
  pools.clear();
  migrated.clear();
  await Promise.allSettled(all.map((p) => p.end()));
}

/** Apply pending migrations once per URL per process. Safe to run on every boot and from several containers. */
export async function migrate(config, { quiet = false } = {}) {
  const url = resolveDatabaseUrl(config);
  if (migrated.has(url)) return migrated.get(url);
  const run = (async () => {
    const pool = getPool(config);
    const client = await pool.connect();
    try {
      // Serialize concurrent boots (rolling deploys) on one advisory lock.
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['zk-voting:migrations']);
      await client.query(`
        CREATE TABLE IF NOT EXISTS zkv_schema_migrations (
          version     integer     PRIMARY KEY,
          name        text        NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query('SELECT version FROM zkv_schema_migrations');
      const done = new Set(rows.map((r) => Number(r.version)));
      const applied = [];
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO zkv_schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
          await client.query('COMMIT');
          applied.push(m.version);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      if (applied.length && !quiet) {
        console.info(`[zk-voting] postgres migrations applied: ${applied.join(', ')}`);
      }
      return { applied, current: Math.max(0, ...MIGRATIONS.map((m) => m.version)) };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['zk-voting:migrations']);
      } finally {
        client.release();
      }
    }
  })();
  migrated.set(url, run);
  try {
    return await run;
  } catch (err) {
    migrated.delete(url);
    throw err;
  }
}

/** For /health. Never throws. */
export async function pingDatabase(config, timeoutMs = 2000) {
  if (!usingPostgres(config)) return { backend: 'json', ok: true };
  const started = Date.now();
  try {
    const pool = getPool(config);
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.()),
    ]);
    return { backend: 'postgres', ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { backend: 'postgres', ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Persist a JSON document (an object of top-level collections) as rows.
 * Arrays → one row per element (key = index). Keys listed in `mapKeys` whose
 * value is an object → one row per entry. Everything else → one 'value' row.
 */
export class PgDocument {
  constructor(config, ns, { mapKeys = [], coarseTimes = [] } = {}) {
    this.config = config;
    this.ns = ns;
    this.mapKeys = new Set(mapKeys);
    // Collections whose row / collection `updated_at` is truncated to the hour,
    // so the database cannot be used to join a ballot row to the second it
    // arrived (and from there to a session or a log line).
    this.coarseTimes = new Set(coarseTimes);
    this.cache = new Map(); // name -> { kind, rows: Map<key, json> }
    this.epoch = 0;
    this._write = Promise.resolve();
  }

  get pool() {
    return getPool(this.config);
  }

  /** Returns the stored document, or null if this namespace has no rows yet. */
  async load() {
    const cols = await this.pool.query('SELECT name, kind FROM zkv_collections WHERE ns = $1', [this.ns]);
    if (cols.rows.length === 0) return null;
    const rows = await this.pool.query(
      'SELECT collection, key, doc FROM zkv_rows WHERE ns = $1 ORDER BY collection, pos, key',
      [this.ns],
    );
    const byCol = new Map();
    for (const r of rows.rows) {
      if (!byCol.has(r.collection)) byCol.set(r.collection, []);
      byCol.get(r.collection).push(r);
    }
    const doc = {};
    this.cache.clear();
    for (const { name, kind } of cols.rows) {
      const list = byCol.get(name) || [];
      const cached = new Map();
      if (kind === 'array') {
        doc[name] = list.map((r) => r.doc);
      } else if (kind === 'map') {
        doc[name] = {};
        for (const r of list) doc[name][r.key] = r.doc;
      } else {
        doc[name] = list.length ? list[0].doc : null;
      }
      for (const r of list) cached.set(r.key, JSON.stringify(r.doc));
      this.cache.set(name, { kind, rows: cached });
    }
    return doc;
  }

  async isEmpty() {
    const { rows } = await this.pool.query('SELECT 1 FROM zkv_collections WHERE ns = $1 LIMIT 1', [this.ns]);
    return rows.length === 0;
  }

  /** Take the writer fence: bump the epoch so an older container's saves are refused. */
  async claimWriter(owner) {
    const { rows } = await this.pool.query(
      `INSERT INTO zkv_writer (ns, epoch, owner, updated_at) VALUES ($1, 1, $2, now())
       ON CONFLICT (ns) DO UPDATE SET epoch = zkv_writer.epoch + 1, owner = EXCLUDED.owner, updated_at = now()
       RETURNING epoch`,
      [this.ns, owner || `${os.hostname()}:${process.pid}`],
    );
    this.epoch = Number(rows[0].epoch);
    return this.epoch;
  }

  _plan(doc) {
    const ops = { upserts: [], deletes: [], collections: [], dropCollections: [] };
    const next = new Map();
    for (const [name, value] of Object.entries(doc)) {
      if (value === undefined) continue;
      let kind;
      const rows = new Map();
      if (Array.isArray(value)) {
        kind = 'array';
        value.forEach((item, i) => rows.set(String(i), JSON.stringify(item ?? null)));
      } else if (this.mapKeys.has(name) && isPlainObject(value)) {
        kind = 'map';
        for (const [k, v] of Object.entries(value)) rows.set(k, JSON.stringify(v ?? null));
      } else {
        kind = 'value';
        rows.set('0', JSON.stringify(value ?? null));
      }
      next.set(name, { kind, rows });
      const prev = this.cache.get(name);
      if (!prev || prev.kind !== kind) ops.collections.push({ name, kind });
      const prevRows = prev && prev.kind === kind ? prev.rows : new Map();
      let pos = 0;
      for (const [k, json] of rows) {
        if (prevRows.get(k) !== json) ops.upserts.push({ collection: name, key: k, pos, json });
        pos += 1;
      }
      for (const k of prevRows.keys()) if (!rows.has(k)) ops.deletes.push({ collection: name, key: k });
      if (prev && prev.kind !== kind) {
        for (const k of prev.rows.keys()) if (!rows.has(k)) ops.deletes.push({ collection: name, key: k });
      }
    }
    for (const name of this.cache.keys()) if (!next.has(name)) ops.dropCollections.push(name);
    return { ops, next };
  }

  /** Save the changed rows. Serialized; resolves when committed. */
  save(doc, { fenced = true } = {}) {
    const run = async () => {
      const { ops, next } = this._plan(doc);
      if (!ops.upserts.length && !ops.deletes.length && !ops.collections.length && !ops.dropCollections.length) return;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (fenced && this.epoch) {
          const { rows } = await client.query('SELECT epoch FROM zkv_writer WHERE ns = $1 FOR UPDATE', [this.ns]);
          const current = rows.length ? Number(rows[0].epoch) : 0;
          if (current !== this.epoch) {
            const err = new Error(`stale writer fence for ${this.ns}: db epoch ${current}, ours ${this.epoch}`);
            err.code = 'STALE_FENCE';
            throw err;
          }
        }
        for (const c of ops.collections) {
          await client.query(
            `INSERT INTO zkv_collections (ns, name, kind, updated_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (ns, name) DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()`,
            [this.ns, c.name, c.kind],
          );
        }
        for (const name of ops.dropCollections) {
          await client.query('DELETE FROM zkv_rows WHERE ns = $1 AND collection = $2', [this.ns, name]);
          await client.query('DELETE FROM zkv_collections WHERE ns = $1 AND name = $2', [this.ns, name]);
        }
        // Batch deletes per collection.
        const delBy = new Map();
        for (const d of ops.deletes) {
          if (!delBy.has(d.collection)) delBy.set(d.collection, []);
          delBy.get(d.collection).push(d.key);
        }
        for (const [collection, keys] of delBy) {
          await client.query('DELETE FROM zkv_rows WHERE ns = $1 AND collection = $2 AND key = ANY($3::text[])', [
            this.ns,
            collection,
            keys,
          ]);
        }
        // Batch upserts (500 rows per statement).
        for (let i = 0; i < ops.upserts.length; i += 500) {
          const chunk = ops.upserts.slice(i, i + 500);
          const params = [this.ns];
          const values = chunk.map((u, j) => {
            params.push(u.collection, u.key, u.pos, u.json, this.coarseTimes.has(u.collection));
            const b = 2 + j * 5;
            return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}::jsonb, CASE WHEN $${b + 4}::boolean THEN date_trunc('hour', now()) ELSE now() END)`;
          });
          await client.query(
            `INSERT INTO zkv_rows (ns, collection, key, pos, doc, updated_at) VALUES ${values.join(', ')}
             ON CONFLICT (ns, collection, key) DO UPDATE SET pos = EXCLUDED.pos, doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
            params,
          );
        }
        const touched = new Set([...ops.upserts.map((u) => u.collection), ...ops.deletes.map((d) => d.collection)]);
        if (touched.size) {
          await client.query(
            `UPDATE zkv_collections SET updated_at = CASE WHEN name = ANY($3::text[]) THEN date_trunc('hour', now()) ELSE now() END
             WHERE ns = $1 AND name = ANY($2::text[])`,
            [this.ns, [...touched], [...this.coarseTimes]],
          );
        }
        await client.query('COMMIT');
        this.cache = next;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection already gone */
        }
        throw err;
      } finally {
        client.release();
      }
    };
    const p = this._write.then(run, run);
    this._write = p.catch(() => {});
    return p;
  }
}

export async function readSecret(config, name) {
  const { rows } = await getPool(config).query('SELECT value FROM zkv_secrets WHERE name = $1', [name]);
  return rows.length ? rows[0].value : null;
}

/** Insert if absent; returns the stored value (an existing one wins). */
export async function putSecretIfAbsent(config, name, value) {
  await getPool(config).query('INSERT INTO zkv_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
    name,
    value,
  ]);
  return readSecret(config, name);
}

export async function recordImport(config, source, detail) {
  await getPool(config).query(
    'INSERT INTO zkv_imports (source, detail) VALUES ($1, $2::jsonb) ON CONFLICT (source) DO NOTHING',
    [source, JSON.stringify(detail || {})],
  );
}
