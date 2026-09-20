// NOT FOR PROFIT — civic public good, not a commercial product.
// Path-style S3 API for AWS S3 and Cloudflare R2, plus file:// / memory:// test sinks.
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Buffer(data) {
  return createHash('sha256').update(data).digest();
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso.slice(0, 15) + 'Z', day: iso.slice(0, 8) };
}

function uriEncode(value, encodeSlash) {
  let out = encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!encodeSlash) out = out.replace(/%2F/gi, '/');
  return out;
}

function canonicalPath(pathname) {
  const parts = String(pathname || '/').split('/');
  return parts.map((p) => uriEncode(p, true)).join('/') || '/';
}

function signingKey(secret, day, region, service) {
  const kDate = hmac(`AWS4${secret}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export function parseFileEndpoint(endpoint) {
  const s = String(endpoint || '').trim();
  if (s.startsWith('file://')) {
    const rest = s.slice('file://'.length);
    return path.resolve(rest.startsWith('/') ? rest : rest || '.');
  }
  if (s.startsWith('file:')) return path.resolve(s.slice('file:'.length));
  throw new Error(`not a file:// endpoint: ${endpoint}`);
}

function safeJoin(root, ...parts) {
  const resolved = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('path escapes store root');
  }
  return resolved;
}

export function createMemoryStore(seed = []) {
  const objects = new Map();
  for (const [key, body] of seed) objects.set(key, Buffer.from(body));
  return {
    kind: 'memory',
    objects,
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async get(key) {
      const buf = objects.get(key);
      return buf ? Buffer.from(buf) : null;
    },
    async head(key) {
      return objects.has(key) ? { bytes: objects.get(key).length } : null;
    },
    async list(prefix) {
      const p = String(prefix || '');
      return [...objects.keys()].filter((k) => k.startsWith(p)).sort();
    },
  };
}

export function createFileStore(endpoint, bucket) {
  const root = safeJoin(parseFileEndpoint(endpoint), bucket || 'l2-archive');
  fs.mkdirSync(root, { recursive: true });
  function objectPath(key) {
    const rel = String(key).replace(/^\/+/, '');
    return safeJoin(root, ...rel.split('/'));
  }
  return {
    kind: 'file',
    root,
    async put(key, body) {
      const dest = objectPath(key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dest);
    },
    async get(key) {
      const dest = objectPath(key);
      if (!fs.existsSync(dest)) return null;
      return fs.readFileSync(dest);
    },
    async head(key) {
      const dest = objectPath(key);
      if (!fs.existsSync(dest)) return null;
      return { bytes: fs.statSync(dest).size };
    },
    async list(prefix) {
      const out = [];
      const walk = (dir, rel) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          const child = rel ? `${rel}/${name}` : name;
          if (fs.statSync(full).isDirectory()) walk(full, child);
          else if (child.startsWith(prefix || '')) out.push(child);
        }
      };
      walk(root, '');
      return out.sort();
    },
  };
}

function endpointHost(endpoint, region) {
  const raw = String(endpoint || '').trim().replace(/\/+$/, '');
  if (raw) return new URL(raw.includes('://') ? raw : `https://${raw}`);
  const host = region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${region}.amazonaws.com`;
  return new URL(`https://${host}`);
}

export function createS3Store(cfg) {
  const bucket = cfg.bucket;
  const region = cfg.region || 'us-east-1';
  const base = endpointHost(cfg.endpoint, region);
  const accessKeyId = cfg.accessKeyId;
  const secretAccessKey = cfg.secretAccessKey;

  async function signedFetch(method, key, { body, query } = {}) {
    const payload = body ? Buffer.from(body) : Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const { amz, day } = amzDate();
    const objectPath = key
      ? `/${bucket}/${String(key).replace(/^\/+/, '')}`
      : `/${bucket}`;
    const url = new URL(base.origin + canonicalPath(objectPath));
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    const queryString = [...url.searchParams.entries()]
      .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
      .sort()
      .join('&');
    const host = url.host;
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      method,
      canonicalPath(url.pathname),
      queryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amz,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const sig = hmac(signingKey(secretAccessKey, day, region, 's3'), stringToSign).toString('hex');
    const headers = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amz,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    };
    if (method === 'PUT' || method === 'POST') {
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = String(payload.length);
    }
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : payload,
      signal: AbortSignal.timeout(60_000),
    });
    return res;
  }

  return {
    kind: 's3',
    async put(key, body) {
      const res = await signedFetch('PUT', key, { body });
      if (res.status !== 200 && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
    },
    async get(key) {
      const res = await signedFetch('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`S3 GET ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
    async head(key) {
      const res = await signedFetch('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 HEAD ${key} failed: HTTP ${res.status}`);
      const len = res.headers.get('content-length');
      return { bytes: len != null ? Number(len) : undefined };
    },
    async list(prefix) {
      const keys = [];
      let token = '';
      for (let i = 0; i < 100; i++) {
        const query = { 'list-type': '2', prefix: prefix || '', 'max-keys': '1000' };
        if (token) query['continuation-token'] = token;
        const res = await signedFetch('GET', '', { query });
        const xml = await res.text();
        if (!res.ok) throw new Error(`S3 LIST failed: HTTP ${res.status} ${xml.slice(0, 200)}`);
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          keys.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
        if (!truncated) break;
        token = next ? next[1] : '';
        if (!token) break;
      }
      return keys;
    },
  };
}

export function createObjectStore(cfg) {
  const endpoint = String(cfg.endpoint || '').trim();
  if (endpoint.startsWith('memory:')) return createMemoryStore();
  if (endpoint.startsWith('file:')) return createFileStore(endpoint, cfg.bucket);
  return createS3Store(cfg);
}

export async function putAndVerify(store, key, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const expected = sha256Hex(buf);
  await store.put(key, buf);
  const got = await store.get(key);
  if (!got) throw new Error(`upload verify failed: ${key} missing after PUT`);
  const actual = sha256Hex(got);
  if (actual !== expected) {
    throw new Error(`upload verify failed: ${key} sha256 ${actual} != ${expected}`);
  }
  return { key, sha256: expected, bytes: buf.length };
}
