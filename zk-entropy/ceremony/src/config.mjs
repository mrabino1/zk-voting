/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Ceremony service configuration (environment variables; see README).
 */
import path from "node:path";

const flag = (v, dflt) => (v == null || v === "" ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, dflt) => {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
};

export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? "/data";
  const closeAt = overrides.closeAt ?? env.CEREMONY_CLOSE_AT ?? "";
  if (closeAt && Number.isNaN(Date.parse(closeAt))) throw new Error("CEREMONY_CLOSE_AT must be an ISO 8601 date-time");
  return {
    port: int(overrides.port ?? env.PORT, 8080),
    host: overrides.host ?? env.HOST ?? "0.0.0.0",
    dataDir,
    sqliteFile: overrides.sqliteFile ?? env.SQLITE_FILE ?? path.join(dataDir, "ceremony.sqlite"),
    databaseUrl: overrides.databaseUrl ?? env.DATABASE_URL ?? "",
    adminToken: String(overrides.adminToken ?? env.ADMIN_TOKEN ?? "").trim(),
    setupToken: String(overrides.setupToken ?? env.SETUP_TOKEN ?? "").trim(),
    publicUrl: String(overrides.publicUrl ?? env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    trustProxy: flag(overrides.trustProxy ?? env.TRUST_PROXY, true),
    defaults: {
      title: String(overrides.title ?? env.CEREMONY_TITLE ?? "zk-voting entropy ceremony").slice(0, 120),
      minContributions: int(overrides.minContributions ?? env.CEREMONY_MIN_CONTRIBUTIONS, 2),
      closeAt: closeAt ? new Date(closeAt).toISOString() : null,
      closeAfterCount: int(overrides.closeAfterCount ?? env.CEREMONY_CLOSE_AFTER, 0) || null,
      autoOpen: flag(overrides.autoOpen ?? env.CEREMONY_AUTO_OPEN, false),
    },
    maxContributions: int(overrides.maxContributions ?? env.CEREMONY_MAX_CONTRIBUTIONS, 100000),
    ratePerMinute: int(overrides.ratePerMinute ?? env.RATE_LIMIT_PER_MINUTE, 6),
    autoCloseIntervalMs: int(overrides.autoCloseIntervalMs ?? env.AUTO_CLOSE_INTERVAL_MS, 15000),
    sessionHours: int(overrides.sessionHours ?? env.ADMIN_SESSION_HOURS, 12),
    now: overrides.now ?? (() => Date.now()),
  };
}
