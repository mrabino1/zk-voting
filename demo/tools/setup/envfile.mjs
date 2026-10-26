// NOT FOR PROFIT — civic public good, not a commercial product.
// Minimal .env reader/writer for the guided setup (./setup.sh).
//
// updateEnvText keeps every comment and unrelated line as it is, replaces the
// first uncommented KEY= line for each key it is given, and appends keys that
// are missing under one marker block. Running it twice with the same values
// gives the same bytes (idempotent).

export const ADDED_MARKER = '# --- added by ./setup.sh ---';

const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  let v = raw.trim();
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    if (end > 0) return v.slice(1, end).replace(/\\(["\\$])/g, '$1');
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end > 0) return v.slice(1, end);
  }
  const hash = v.search(/\s#/);
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

/** Parse dotenv text into a Map of key -> value (first uncommented wins). */
export function parseEnvText(text) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(KEY_RE);
    if (m && !out.has(m[1])) out.set(m[1], unquote(m[2]));
  }
  return out;
}

/**
 * Quote a value for a .env line that docker compose, the Node app and
 * system_actions.sh all read the same way. Throws (without the value) for
 * characters no common dotenv reader agrees on.
 */
export function formatEnvValue(key, value) {
  const v = String(value ?? '');
  if (/[\r\n\0]/.test(v)) throw new Error(`${key}: line breaks are not allowed`);
  if (v.includes('#')) throw new Error(`${key}: "#" is not allowed (percent-encode it as %23 in a URL)`);
  if (/^[A-Za-z0-9_.,:/@%+=?&~-]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!/["$\\`]/.test(v)) return `"${v}"`;
  throw new Error(`${key}: mixes quote characters that cannot be stored safely`);
}

/** Apply { KEY: value } updates to dotenv text. Values are strings. */
export function updateEnvText(text, updates) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.length ? src.replace(/(\r?\n)$/, '').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates).map(([k, v]) => [k, formatEnvValue(k, v)]));
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const m = lines[i].match(KEY_RE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    if (pending.has(m[1])) {
      lines[i] = `${m[1]}=${pending.get(m[1])}`;
      pending.delete(m[1]);
    }
  }
  if (pending.size) {
    let at = lines.indexOf(ADDED_MARKER);
    if (at < 0) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(ADDED_MARKER);
      at = lines.length - 1;
    }
    // Insert after the last line of the marker block (block ends at a blank line).
    let end = at + 1;
    while (end < lines.length && lines[end].trim() !== '') end++;
    const add = [...pending].map(([k, v]) => `${k}=${v}`);
    lines.splice(end, 0, ...add);
  }
  return lines.join(eol) + eol;
}
