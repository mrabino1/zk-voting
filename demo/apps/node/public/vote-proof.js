/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * In-browser Groth16 for the vote circuit. The witness stays in this page.
 * snarkjs is loaded from this Node (`/vendor/snarkjs.min.js`), not a CDN.
 * wasm and zkey are loaded from `/zk/`, which serves `circuits/build` when
 * a dev setup has been run. Those keys are UNTRUSTED until a ceremony zkey
 * is swapped in. Missing keys fall back to a mock proof only on chain 31337.
 */

const LOCAL_DEV_CHAIN_ID = 31337;

export function mockProofAllowedForChain(chainId) {
  return Number(chainId) === LOCAL_DEV_CHAIN_ID;
}

function mockProof(publicInputs) {
  return {
    mock: true,
    accept: true,
    a: ["0", "0"],
    b: [
      ["0", "0"],
      ["0", "0"],
    ],
    c: ["0", "0"],
    publicInputs,
  };
}

async function loadSnarkjs() {
  if (globalThis.snarkjs?.groth16?.fullProve) return globalThis.snarkjs;
  if (typeof document === "undefined") return null;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/snarkjs.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("snarkjs failed to load"));
    document.head.appendChild(script);
  });
  return globalThis.snarkjs || null;
}

async function loadArtifacts() {
  const wasmUrl = "/zk/vote.wasm";
  const zkeyUrl = "/zk/vote.zkey";
  const [wasmRes, zkeyRes] = await Promise.all([fetch(wasmUrl), fetch(zkeyUrl)]);
  if (!wasmRes.ok || !zkeyRes.ok) return null;
  return {
    wasm: new Uint8Array(await wasmRes.arrayBuffer()),
    zkey: new Uint8Array(await zkeyRes.arrayBuffer()),
  };
}

/**
 * @param {{ witness?: object, publicInputs: unknown[], chainId?: number }} opts
 * witness is the snarkjs input (private values included). It is not returned.
 */
export async function proveVote({ witness, publicInputs, chainId } = {}) {
  const allowMock = mockProofAllowedForChain(chainId);
  try {
    const artifacts = witness ? await loadArtifacts() : null;
    const snarkjs = artifacts ? await loadSnarkjs() : null;
    if (artifacts && snarkjs?.groth16?.fullProve) {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, artifacts.wasm, artifacts.zkey);
      return {
        mock: false,
        a: proof.pi_a.slice(0, 2),
        b: proof.pi_b.slice(0, 2),
        c: proof.pi_c.slice(0, 2),
        publicInputs: publicSignals,
        protocol: "groth16",
      };
    }
  } catch (err) {
    if (!allowMock) {
      throw new Error(
        `VOTE_PROOF_UNAVAILABLE. In-browser Groth16 did not run (${err?.message || err}). A dev zkey is produced by circuits:smoke and is not a ceremony.`
      );
    }
  }
  if (!allowMock) {
    throw new Error(
      "VOTE_PROOF_UNAVAILABLE. This chain does not accept a mock vote proof. Run circuits:smoke and serve the dev wasm and zkey, then replace them with a ceremony Vote(20) zkey."
    );
  }
  return mockProof(publicInputs);
}
