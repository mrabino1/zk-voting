// NOT FOR PROFIT — civic public good, not a commercial product.
// Retry a request that landed on the standby container during a rolling update.

export function standbyDelayMs(response, attempt) {
  const header = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("retry-after")
    : null;
  const retryAfter = Number(header);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 5000);
  return Math.min(400 * 2 ** attempt, 2000);
}

function isStandbyResponse(response) {
  if (!response || response.status !== 503) return false;
  const mode = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('x-zk-voting-mode')
    : null;
  return String(mode || '').toLowerCase() === 'standby';
}

export async function fetchWithStandbyRetry(url, options = {}, fetchImpl = globalThis.fetch) {
  let waitAttempt = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetchImpl(url, options);
    if (!isStandbyResponse(response) || attempt === 4) return response;
    const delay = standbyDelayMs(response, waitAttempt);
    waitAttempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("maintenance handover");
}
