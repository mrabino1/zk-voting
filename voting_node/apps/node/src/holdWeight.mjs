// NOT FOR PROFIT — civic public good, not a commercial product.
// Final weight is the minimum end-of-block balance from the vote block
// through the close block. Intra-block moves, including flash loans, do
// not appear. Buying more after voting cannot raise the minimum.

function asBig(value) {
  if (typeof value === 'bigint') return value;
  return BigInt(value);
}

/**
 * @returns {Promise<{
 *   finalWeight: bigint,
 *   minBlock: bigint,
 *   touchedBlocks: bigint[],
 *   voteBalance: bigint,
 *   closeBalance: bigint,
 *   consistent: boolean,
 * }>}
 */
export async function finalWeight({ source, token, voter, voteBlock, closeBlock }) {
  const voteB = asBig(voteBlock);
  const closeB = asBig(closeBlock);
  if (closeB < voteB) {
    throw new Error('close block is before the vote block');
  }
  const rawTouched = await source.touchedBlocks(token, voter, voteB, closeB);
  const touched = [];
  for (const block of rawTouched) {
    const n = asBig(block);
    if (n > voteB && n <= closeB) touched.push(n);
  }
  touched.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const voteBalance = await source.balanceAt(token, voter, voteB);
  let min = voteBalance;
  let minBlock = voteB;
  let last = voteBalance;
  for (const block of touched) {
    const balance = await source.balanceAt(token, voter, block);
    last = balance;
    if (balance < min) {
      min = balance;
      minBlock = block;
    }
  }
  const closeBalance = await source.balanceAt(token, voter, closeB);
  const consistent = last === closeBalance;
  if (closeBalance < min) {
    min = closeBalance;
    minBlock = closeB;
  }
  return {
    finalWeight: min,
    minBlock,
    touchedBlocks: touched,
    voteBalance,
    closeBalance,
    consistent,
  };
}
