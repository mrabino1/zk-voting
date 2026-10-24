// NOT FOR PROFIT — civic public good, not a commercial product.
// Parse snarkjs log output and check ceremony inputs.
//
// Ported from circuits/scripts/ceremony.mjs (stripSnarkjsLog,
// parseVerifiedContributions, parseCircuitHash, assertBeaconParams,
// assertParticipantName). The Docker image ships only apps/node, so the Node
// server carries its own copy. Keep the two in step. The CLI is the reference.

export function stripSnarkjsLog(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\[(DEBUG|INFO|WARN|ERROR)\]\s+snarkJS:\s*/g, '');
}

function wordsToHex(block) {
  const hex = String(block).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 128) {
    throw new Error(`expected a 64-byte snarkjs hash, got ${hex.length / 2} bytes`);
  }
  return hex;
}

const HASH_BLOCK = '((?:[ \\t]*[0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8}\\n){4})';

export function parseCircuitHash(text) {
  const clean = stripSnarkjsLog(text);
  const re = new RegExp(`Circuit [Hh]ash:\\s*\\n${HASH_BLOCK}`, 'g');
  let match;
  let last = null;
  while ((match = re.exec(clean))) last = match[1];
  return last ? wordsToHex(last) : null;
}

/**
 * Contributions listed by `snarkjs zkey verify` (or verifyFromR1cs with a
 * capturing logger), oldest first. Throws unless snarkjs printed "ZKey Ok!".
 */
export function parseVerifiedContributions(text) {
  const clean = stripSnarkjsLog(text);
  if (!/ZKey Ok!/.test(clean)) {
    throw new Error('snarkjs verify did not report ZKey Ok!');
  }
  const found = [];
  for (const section of clean.split(/-{5,}/)) {
    const match = section.match(
      new RegExp(`contribution #(\\d+)(?: ([^\\n:]+))?:\\s*\\n${HASH_BLOCK}`, 'i'),
    );
    if (!match) continue;
    const beaconHash = section.match(/Beacon generator:\s*([0-9a-fA-F]+)/);
    const iterations = section.match(/Beacon iterations Exp:\s*(\d+)/);
    found.push({
      index: Number(match[1]),
      name: (match[2] || '').trim(),
      hash: wordsToHex(match[3]),
      beacon: beaconHash
        ? { hash: beaconHash[1].toLowerCase(), iterations: iterations ? Number(iterations[1]) : null }
        : null,
    });
  }
  found.sort((a, b) => a.index - b.index);
  for (let i = 0; i < found.length; i++) {
    if (found[i].index !== i + 1) {
      throw new Error(`snarkjs contribution index gap at #${found[i].index}`);
    }
  }
  return found;
}

export function assertBeaconParams(hash, iterations) {
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]+$/.test(hash) || hash.length % 2 !== 0) {
    throw new Error('beacon hash must be an even-length hexadecimal string');
  }
  const bytes = hash.length / 2;
  if (bytes < 1 || bytes >= 256) {
    throw new Error('beacon hash must be 1 to 255 bytes');
  }
  const n = Number(iterations);
  if (!Number.isInteger(n) || n < 10 || n > 63) {
    throw new Error('beacon iterations exponent must be an integer from 10 to 63');
  }
  return { hash: hash.toLowerCase(), iterations: n };
}

export function assertParticipantName(name) {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name) ||
    name.endsWith(' ') ||
    name.includes('  ')
  ) {
    throw new Error(
      'participant name must be 1-64 characters: letters, digits, space, dot, underscore, or hyphen',
    );
  }
  return name;
}

/** A snarkjs logger that keeps every line so the caller can parse it. */
export function captureLogger() {
  const lines = [];
  const push = (level) => (...args) => {
    lines.push(level === 'info' ? args.join(' ') : `[${level.toUpperCase()}] ${args.join(' ')}`);
  };
  return {
    logger: {
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      debug: () => {},
    },
    text: () => `${lines.join('\n')}\n`,
    reset: () => {
      lines.length = 0;
    },
  };
}
