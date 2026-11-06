// NOT FOR PROFIT — civic public good, not a commercial product.
// Build the delegated-power snapshot for one Ethereum block.
// The node only reads. It does not delegate and it does not submit to the L2.

import { HttpError } from './http.mjs';
import { SNAPSHOT_DEPTH, SNAPSHOT_SCHEME, buildSnapshotTree, fieldToHex } from './snapshotTree.mjs';

export async function buildVoteSnapshot(source, token, { snapshotBlock, startBlock }) {
  let mode;
  try {
    mode = await source.clockMode(token);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'token has no block-number vote checkpoints', { code: 'TOKEN_UNSUPPORTED' });
  }
  if (!String(mode).includes('mode=blocknumber')) {
    throw new HttpError(400, 'token checkpoints must use Ethereum block numbers', { code: 'TOKEN_UNSUPPORTED' });
  }
  const block = await source.getBlock(snapshotBlock);
  const rows = await source.votingPowerAt(token, snapshotBlock, startBlock);
  let tree;
  try {
    tree = buildSnapshotTree(rows);
  } catch (err) {
    throw new HttpError(400, err.message, { code: err.code || 'SNAPSHOT_TOO_LARGE' });
  }
  if (tree.depth !== SNAPSHOT_DEPTH) {
    throw new HttpError(500, 'snapshot depth mismatch', { code: 'SNAPSHOT_MISMATCH' });
  }
  return {
    snapshotBlock: Number(block.number),
    snapshotBlockHash: block.hash,
    snapshotRoot: fieldToHex(tree.root),
    snapshotScheme: SNAPSHOT_SCHEME,
    snapshotDepth: tree.depth,
    snapshotLeafCount: rows.length,
    snapshotLeaves: rows.map((row) => ({
      address: row.address,
      weight: String(row.weight),
      delegators: Number(row.delegators || 0),
    })),
    clockMode: String(mode),
  };
}
