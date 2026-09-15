#!/usr/bin/env node
// NOT FOR PROFIT — civic public good, not a commercial product.
// Generic HTTP health probe for Compose / Dockerfile HEALTHCHECK.
const url = process.argv[2] || process.env.HEALTHCHECK_URL;
if (!url) {
  console.error('usage: healthcheck.mjs <url>');
  process.exit(2);
}

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) process.exit(1);
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) {
    const body = await res.json();
    if (body && body.ok === false) process.exit(1);
  }
} catch {
  process.exit(1);
}
