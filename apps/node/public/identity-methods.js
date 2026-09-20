/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Client helpers: bind Web3 wallet or smart-card digital ID, set the one active ETH address.
 */

import { t } from "./i18n.js";

export async function loginWeb3Wallet(api) {
  if (!window.ethereum) {
    throw new Error(t("wallet.noEthWallet"));
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts && accounts[0];
  if (!address) throw new Error(t("wallet.noAddress"));
  const challenge = await api("/api/auth/web3/challenge", {
    method: "POST",
    body: { address },
  });
  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [challenge.message, address],
  });
  return api("/api/auth/web3/login", {
    method: "POST",
    body: { address, signature, nonce: challenge.nonce },
  });
}

export async function bindWeb3Wallet(api, { handle } = {}) {
  if (!window.ethereum) {
    throw new Error(t("wallet.noWeb3Wallet"));
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts && accounts[0];
  if (!address) throw new Error(t("wallet.noAddress"));
  const challenge = await api("/api/identity/web3/challenge", {
    method: "POST",
    body: { address },
  });
  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [challenge.message, address],
  });
  return api("/api/identity/web3/verify", {
    method: "POST",
    body: { address, signature, handle },
  });
}

export async function bindSmartCard(api, { fingerprint, certificate, subject, issuer, handle, mock } = {}) {
  const challenge = await api("/api/identity/smart-card/challenge", {
    method: "POST",
    body: { fingerprint, certificate },
  });
  return api("/api/identity/smart-card/verify", {
    method: "POST",
    body: {
      nonce: challenge.nonce,
      fingerprint: fingerprint || challenge.fingerprint,
      certificate,
      subject,
      issuer,
      handle,
      mock: mock !== false,
    },
  });
}

export async function registerEthAccount(api, { address, source }) {
  return api("/api/me/eth-accounts", { method: "POST", body: { address, source } });
}

export async function setActiveEthAddress(api, address) {
  return api("/api/me/eth-accounts/active", { method: "POST", body: { address } });
}
