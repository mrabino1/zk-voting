// NOT FOR PROFIT — civic public good, not a commercial product.
// Classified attic errors. Never prune on these; sequencer hot path is separate.

export function isEnospc(err) {
  if (!err) return false;
  if (err.code === 'ENOSPC') return true;
  return /ENOSPC|no space left/i.test(String(err.message || ''));
}

export function isTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'TIMEOUT' || err.code === 'ABORT_ERR') return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /timeout|timed out|aborted/i.test(String(err.message || ''));
}

export function archiveError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'code') continue;
    err[k] = v;
  }
  return err;
}

export function wrapEnospc(err, what) {
  if (!isEnospc(err)) return err;
  return archiveError(
    'ENOSPC',
    `ENOSPC ${what}: local disk is full; hour aborted, local copies left intact`,
    { cause: err },
  );
}

export function classifyStoreError(err, stage, key) {
  if (!err) return archiveError('ARCHIVE_FAILED', `${stage} failed for ${key}`);
  if (err.code && ['ENOSPC', 'TIMEOUT', 'AUTH', 'PUT_FAILED', 'GET_VERIFY_FAILED', 'TRUNCATED', 'HASH_MISMATCH', 'LOCAL_BITROT', 'MANIFEST_PUT_FAILED', 'ARCHIVE_LOCK_HELD'].includes(err.code)) {
    return err;
  }
  if (isEnospc(err)) return wrapEnospc(err, `${stage} ${key}`);
  if (isTimeoutError(err)) {
    return archiveError('TIMEOUT', `${stage} timeout for ${key}: ${err.message}`, { key, cause: err });
  }
  const msg = String(err.message || err);
  if (/HTTP 401|HTTP 403|AccessDenied|InvalidAccessKey|SignatureDoesNotMatch/i.test(msg)) {
    return archiveError('AUTH', `${stage} auth failed for ${key}: ${msg}`, { key, cause: err });
  }
  if (stage === 'PUT' && /HTTP 5\d\d/.test(msg)) {
    return archiveError('PUT_FAILED', `${stage} failed for ${key}: ${msg}`, { key, cause: err });
  }
  if (stage === 'PUT') {
    return archiveError('PUT_FAILED', `${stage} failed for ${key}: ${msg}`, { key, cause: err });
  }
  if (stage === 'GET' || stage === 'VERIFY') {
    return archiveError('GET_VERIFY_FAILED', `${stage} failed for ${key}: ${msg}`, { key, cause: err });
  }
  if (stage === 'MANIFEST') {
    return archiveError('MANIFEST_PUT_FAILED', `${stage} failed for ${key}: ${msg}`, { key, cause: err });
  }
  return archiveError(err.code || 'ARCHIVE_FAILED', msg, { key, cause: err });
}
