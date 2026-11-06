/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * A deployment is one mode or the other. ERC-20 polls read a single token
 * address from VOTING_TOKEN_ADDRESS. A civic deployment has no ERC-20.
 */

export function deploymentMode(config) {
  if (!config || !config.pollsEnabled) return "civic";
  if (config.pollsReady && config.votingToken && config.votingToken.configured) return "erc20";
  return "erc20-unconfigured";
}

export function deploymentSummary(config) {
  const mode = deploymentMode(config);
  if (mode === "civic") {
    return {
      mode,
      title: "Civic elections",
      body: "This deployment has no ERC-20. Create jurisdictions here, then elections, the roll, and the tally in the back office.",
    };
  }
  if (mode === "erc20-unconfigured") {
    const reason = config?.votingToken?.reason || "unset";
    return {
      mode,
      title: "ERC-20 polls",
      body: `POLLS_ENABLED is on, but this deployment has no usable token (${reason}). Set VOTING_TOKEN_ADDRESS to one ERC-20 on Ethereum mainnet. There is no civic roll on this deployment.`,
    };
  }
  const token = config.votingToken;
  return {
    mode,
    title: "ERC-20 polls",
    body: `This deployment is ERC-20 polls on one token, ${token.address} on chain ${token.chainId}, from VOTING_TOKEN_ADDRESS. A jurisdiction below only labels a poll. It is not a voter roll.`,
  };
}
