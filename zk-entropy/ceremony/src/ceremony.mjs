/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Ceremony state machine: draft -> open -> closed.
 *
 * state_0 = H(GENESIS || salt), state_i = H(STEP || state_{i-1} || contribution_i),
 * output = H(FINAL || state_n || n). While open, the public transcript lists
 * contribution hashes and timestamps only. On close the raw contributions are
 * revealed so anyone can recompute the chain (zk-entropy verify-transcript).
 * Nothing about a contributor (IP, name, account) is stored.
 */
import {
  VERSION,
  ceremonyGenesis,
  ceremonyHashedBody,
  ceremonyOutput,
  ceremonyStep,
  contributionHashOf,
  makeEntropyString,
  randomBytes,
  toHex,
  transcriptHashOf,
} from "../../src/index.js";

const HEX64 = /^[0-9a-f]{64}$/;

export class CeremonyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createCeremony(store, config) {
  const iso = () => new Date(config.now()).toISOString();

  async function init() {
    const existing = await store.getMeta("ceremony");
    if (existing) return existing;
    const salt = toHex(randomBytes(32));
    const c = {
      version: VERSION,
      title: config.defaults.title,
      status: config.defaults.autoOpen ? "open" : "draft",
      salt,
      genesis: await ceremonyGenesis(salt),
      createdAt: iso(),
      openedAt: config.defaults.autoOpen ? iso() : null,
      closedAt: null,
      closeReason: null,
      minContributions: config.defaults.minContributions,
      closeAt: config.defaults.closeAt,
      closeAfterCount: config.defaults.closeAfterCount,
    };
    if (await store.setMetaIfAbsent("ceremony", c)) {
      await store.setMetaIfAbsent("head", { state: c.genesis, count: 0 });
      return c;
    }
    return store.getMeta("ceremony");
  }

  const get = async () => (await store.getMeta("ceremony")) || init();
  const head = async () => (await store.getMeta("head")) || { state: (await get()).genesis, count: 0 };

  function closeDue(c, count, now = config.now()) {
    if (c.status !== "open" || count < 1) return null;
    if (c.closeAfterCount && count >= c.closeAfterCount) return "count";
    if (count >= config.maxContributions) return "max";
    if (c.closeAt && now >= Date.parse(c.closeAt) && count >= c.minContributions) return "deadline";
    return null;
  }

  async function publicState() {
    const c = await get();
    const h = await head();
    const final = c.status === "closed" ? await store.getMeta("final") : null;
    const list = await store.listContributions();
    return {
      version: c.version,
      title: c.title,
      status: c.status,
      count: h.count,
      minContributions: c.minContributions,
      closeAt: c.closeAt,
      closeAfterCount: c.closeAfterCount,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      closeReason: c.closeReason,
      lastContributionHash: list.at(-1)?.contributionHash ?? null,
      final: final ? { entropyString: final.entropyString, output: final.output, transcriptHash: final.transcriptHash } : null,
    };
  }

  async function transcript() {
    const c = await get();
    const list = await store.listContributions();
    if (c.status === "closed") {
      const final = await store.getMeta("final");
      return { ...final, status: "closed" };
    }
    return {
      version: c.version,
      kind: "ceremony",
      status: c.status,
      title: c.title,
      salt: c.salt,
      genesis: c.genesis,
      openedAt: c.openedAt,
      note: "Raw contributions and the chain state are revealed when the ceremony closes.",
      contributions: list.map((r) => ({ index: r.index, at: r.at, contributionHash: r.contributionHash, clientTranscriptHash: r.clientTranscriptHash })),
    };
  }

  async function contribute({ contribution, clientTranscriptHash }) {
    const hex = String(contribution ?? "").trim().toLowerCase();
    if (!HEX64.test(hex)) throw new CeremonyError(400, "BAD_CONTRIBUTION", "contribution must be 64 hex characters (32 bytes)");
    if (/^(.)\1{63}$/.test(hex)) throw new CeremonyError(400, "BAD_CONTRIBUTION", "contribution looks like a constant, not randomness");
    const cth = clientTranscriptHash == null || clientTranscriptHash === "" ? null : String(clientTranscriptHash).toLowerCase();
    if (cth !== null && !HEX64.test(cth)) throw new CeremonyError(400, "BAD_TRANSCRIPT_HASH", "clientTranscriptHash must be 64 hex characters");
    const contributionHash = await contributionHashOf(hex);
    let out;
    try {
      out = await store.append(async (h0) => {
        const c = await get();
        if (c.status !== "open") throw new CeremonyError(409, "NOT_OPEN", c.status === "closed" ? "the ceremony is closed" : "the ceremony is not open yet");
        const h = h0 || { state: c.genesis, count: 0 };
        if (closeDue(c, h.count)) throw new CeremonyError(409, "NOT_OPEN", "the ceremony is closing");
        const stateAfter = await ceremonyStep(h.state, hex);
        const index = h.count + 1;
        return { row: { index, at: iso(), contribution: hex, contributionHash, clientTranscriptHash: cth, stateAfter }, head: { state: stateAfter, count: index } };
      });
    } catch (err) {
      if (err.code === "DUPLICATE" || /UNIQUE|duplicate key/i.test(err.message)) throw new CeremonyError(409, "DUPLICATE", "this contribution was already submitted");
      throw err;
    }
    await maybeAutoClose();
    return { index: out.row.index, at: out.row.at, contributionHash };
  }

  async function updateSettings(patch) {
    return store.updateMeta("ceremony", async (c) => {
      if (c.status === "closed") throw new CeremonyError(409, "CLOSED", "the ceremony is closed");
      const next = { ...c };
      if (patch.title !== undefined) {
        const t = String(patch.title).trim();
        if (!t || t.length > 120) throw new CeremonyError(400, "BAD_TITLE", "title must be 1 to 120 characters");
        next.title = t;
      }
      if (patch.minContributions !== undefined) {
        const n = Number(patch.minContributions);
        if (!Number.isInteger(n) || n < 1 || n > 1e6) throw new CeremonyError(400, "BAD_MIN", "minimum contributions must be an integer from 1");
        next.minContributions = n;
      }
      if (patch.closeAt !== undefined) {
        if (patch.closeAt === null || patch.closeAt === "") next.closeAt = null;
        else {
          const t = Date.parse(patch.closeAt);
          if (Number.isNaN(t)) throw new CeremonyError(400, "BAD_DEADLINE", "deadline must be an ISO 8601 date-time");
          next.closeAt = new Date(t).toISOString();
        }
      }
      if (patch.closeAfterCount !== undefined) {
        if (patch.closeAfterCount === null || patch.closeAfterCount === "" || Number(patch.closeAfterCount) === 0) next.closeAfterCount = null;
        else {
          const n = Number(patch.closeAfterCount);
          if (!Number.isInteger(n) || n < 1) throw new CeremonyError(400, "BAD_CLOSE_AFTER", "close-after count must be a positive integer");
          next.closeAfterCount = n;
        }
      }
      return next;
    });
  }

  async function open() {
    return store.updateMeta("ceremony", async (c) => {
      if (c.status === "open") return c;
      if (c.status === "closed") throw new CeremonyError(409, "CLOSED", "a closed ceremony cannot reopen");
      return { ...c, status: "open", openedAt: iso() };
    });
  }

  async function close({ reason = "manual", force = false } = {}) {
    return store.withLock(async () => {
      const c = await get();
      if (c.status === "closed") return store.getMeta("final");
      if (c.status !== "open") throw new CeremonyError(409, "NOT_OPEN", "only an open ceremony can close");
      const h = await head();
      if (h.count < 1) throw new CeremonyError(409, "NO_CONTRIBUTIONS", "a ceremony needs at least one contribution to close");
      if (reason === "manual" && !force && h.count < c.minContributions) {
        throw new CeremonyError(409, "BELOW_MINIMUM", `only ${h.count} of the ${c.minContributions} required contributions; pass force to close anyway`);
      }
      const list = await store.listContributions();
      const closedAt = iso();
      const output = await ceremonyOutput(h.state, h.count);
      const t = {
        version: c.version,
        kind: "ceremony",
        title: c.title,
        salt: c.salt,
        genesis: c.genesis,
        openedAt: c.openedAt,
        closedAt,
        closeReason: reason,
        contributions: list.map((r) => ({ index: r.index, at: r.at, contribution: r.contribution, contributionHash: r.contributionHash, clientTranscriptHash: r.clientTranscriptHash })),
        finalState: h.state,
        output,
      };
      t.transcriptHash = await transcriptHashOf(ceremonyHashedBody(t));
      t.entropyString = await makeEntropyString("ceremony", output, t.transcriptHash);
      await store.setMeta("final", t);
      await store.setMeta("ceremony", { ...c, status: "closed", closedAt, closeReason: reason });
      return t;
    });
  }

  async function maybeAutoClose() {
    const c = await get();
    const h = await head();
    const reason = closeDue(c, h.count);
    if (reason) await close({ reason });
    return reason;
  }

  return { init, get, publicState, transcript, contribute, updateSettings, open, close, maybeAutoClose };
}
