// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly L2 attic offload. Object storage is not the live sequencer filesystem.
import path from 'node:path';

import { loadConfig, parseBool } from '../sequencer/state.mjs';
import { DEFAULT_HOT_WINDOW_HOURS } from './hours.mjs';

export const NO_STORE_REASON =
  'no object store configured (ARCHIVE_S3_BUCKET is empty and no file:// sink); refusing to prune local data';

export function loadArchiveConfig({ env = process.env, l2Config } = {}) {
  const l2 = l2Config || loadConfig();
  const endpoint = String(env.ARCHIVE_S3_ENDPOINT || '').trim();
  const enabled = parseBool(env.ARCHIVE_ENABLED, true);
  const compress = parseBool(env.ARCHIVE_COMPRESS, true);
  const hotWindowHours = Math.max(
    1,
    Math.floor(Number(env.ARCHIVE_HOT_WINDOW_HOURS || DEFAULT_HOT_WINDOW_HOURS) || DEFAULT_HOT_WINDOW_HOURS),
  );
  const fileMode = endpoint.startsWith('file:');
  const memoryMode = endpoint.startsWith('memory:');
  const bucket = String(env.ARCHIVE_S3_BUCKET || (fileMode || memoryMode ? 'l2-archive' : '')).trim();
  const nodeDataDir = String(env.ARCHIVE_NODE_DATA_DIR || env.DATA_DIR || '').trim();
  const explorerSnapshot = parseBool(env.ARCHIVE_EXPLORER_SNAPSHOT, false);
  let explorerFile = String(env.ARCHIVE_EXPLORER_FILE || '').trim();
  if (!explorerFile && explorerSnapshot && nodeDataDir) {
    explorerFile = path.join(nodeDataDir, 'l2-chain.json');
  }
  return {
    enabled,
    compress,
    l2,
    chainId: Number(l2.chainId),
    dataDir: l2.dataDir,
    disclosureIntervalSeconds: l2.disclosureIntervalSeconds,
    hotWindowHours,
    bucket,
    endpoint,
    region: String(env.ARCHIVE_S3_REGION || env.AWS_REGION || (endpoint ? 'auto' : 'us-east-1')).trim() || 'us-east-1',
    accessKeyId: String(env.ARCHIVE_S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.ARCHIVE_S3_SECRET_ACCESS_KEY || '').trim(),
    explorerSnapshot,
    explorerFile,
    intervalSeconds: Math.max(60, Number(env.ARCHIVE_INTERVAL_SECONDS || 3600) || 3600),
    fileMode,
    memoryMode,
    minFreeBytes: Math.max(0, Number(env.ARCHIVE_MIN_FREE_BYTES || 8 * 1024 * 1024) || 0),
    timeoutMs: Math.max(1_000, Number(env.ARCHIVE_S3_TIMEOUT_MS || 60_000) || 60_000),
  };
}

export function assertArchiveReady(cfg) {
  if (!cfg.enabled) return { ok: true, skipped: true, reason: 'ARCHIVE_ENABLED=0' };
  // Default-on must not delete the hot path when nobody configured a sink.
  // A file:// endpoint is a real sink even if the bucket env var is empty
  // (loadArchiveConfig fills a default bucket name for that mode).
  if (!cfg.bucket && !cfg.fileMode) {
    return { ok: true, skipped: true, reason: NO_STORE_REASON, warn: true };
  }
  if (!cfg.fileMode && !cfg.memoryMode && !cfg.endpoint && !cfg.accessKeyId) {
    // AWS with instance-role style empty keys is allowed; unsigned requests will fail at PUT.
    return { ok: true, skipped: false };
  }
  if (!cfg.fileMode && !cfg.memoryMode && cfg.accessKeyId && !cfg.secretAccessKey) {
    return { ok: false, skipped: true, reason: 'ARCHIVE_S3_SECRET_ACCESS_KEY is required when an access key is set' };
  }
  return { ok: true, skipped: false };
}
