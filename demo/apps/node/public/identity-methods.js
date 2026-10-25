/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Client helpers: email, Web3, smart-card reader, civic ID, and MFA.
 */

export function isMfaChallenge(result) {
  return Boolean(result && result.mfaRequired && !result.verified);
}

export async function loginWeb3Wallet(api, { email } = {}) {
  if (!window.ethereum) {
    throw new Error("No Ethereum wallet in this browser. Use email, a smart card, or install a wallet that supports personal_sign.");
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts && accounts[0];
  if (!address) throw new Error("Wallet did not return an address.");
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
    body: { address, signature, nonce: challenge.nonce, email },
  });
}

export async function bindWeb3Wallet(api, { handle, email, acceptedTerms } = {}) {
  if (!window.ethereum) {
    throw new Error("No Web3 wallet in this browser. Install a wallet or use email / smart card / license.");
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts && accounts[0];
  if (!address) throw new Error("Wallet did not return an address.");
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
    body: { address, signature, handle, email, acceptedTerms },
  });
}

export async function bindSmartCard(api, { fingerprint, certificate, subject, issuer, handle, email, mock, acceptedTerms } = {}) {
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
      email,
      mock: mock !== false,
      acceptedTerms,
    },
  });
}

export async function loginSmartCard(api, { fingerprint, certificate, email, mock } = {}) {
  const challenge = await api("/api/auth/smart-card/challenge", {
    method: "POST",
    body: { fingerprint, certificate },
  });
  return api("/api/auth/smart-card/login", {
    method: "POST",
    body: {
      nonce: challenge.nonce,
      fingerprint: fingerprint || challenge.fingerprint,
      certificate,
      email,
      mock: mock !== false,
    },
  });
}

export async function presentSmartCard() {
  const api = typeof navigator !== "undefined" ? navigator.smartCard : null;
  if (!api) {
    return {
      available: false,
      note: "No Web Smart Card API in this browser. Use a kiosk reader that pastes a certificate fingerprint, or the mock path on a demo host.",
    };
  }
  return {
    available: true,
    note: "A smart-card API is present. This Node still hashes a certificate fingerprint; live X.509 path verification is clerk-attested.",
  };
}

export async function startEmailLogin(api, email) {
  return api("/api/auth/email/start", { method: "POST", body: { email } });
}

export async function startEmailRegister(api, { email, handle, acceptedTerms } = {}) {
  return api("/api/identity/email/start", { method: "POST", body: { email, handle, acceptedTerms } });
}

export async function bindCivicId(api, { kind, issuer, documentNumber, handle, email, mock, acceptedTerms } = {}) {
  return api("/api/identity/civic-id/verify", {
    method: "POST",
    body: {
      kind,
      issuer,
      documentNumber,
      handle,
      email,
      mock: mock !== false,
      acceptedTerms,
    },
  });
}

export async function loginCivicId(api, { kind, issuer, documentNumber, email } = {}) {
  return api("/api/auth/civic-id/login", {
    method: "POST",
    body: { kind, issuer, documentNumber, email },
  });
}

export async function provideMfaEmail(api, email) {
  return api("/api/auth/mfa/email", { method: "POST", body: { email } });
}

export async function verifyMfaCode(api, code) {
  return api("/api/auth/mfa/verify", { method: "POST", body: { code } });
}

export async function resendMfaCode(api) {
  return api("/api/auth/mfa/resend", { method: "POST", body: {} });
}

export async function registerEthAccount(api, { address, source, signature, nonce } = {}) {
  let addr = address;
  let sig = signature;
  let nce = nonce;
  if (!sig) {
    if (!window.ethereum) {
      throw new Error("No Ethereum wallet in this browser. Connect a wallet that supports personal_sign to verify an address.");
    }
    if (!addr) {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      addr = accounts && accounts[0];
    }
    if (!addr) throw new Error("Wallet did not return an address.");
    const challenge = await api("/api/identity/web3/challenge", {
      method: "POST",
      body: { address: addr },
    });
    sig = await window.ethereum.request({
      method: "personal_sign",
      params: [challenge.message, addr],
    });
    nce = challenge.nonce;
  }
  return api("/api/me/eth-accounts", {
    method: "POST",
    body: { address: addr, signature: sig, nonce: nce, source },
  });
}

export async function setActiveEthAddress(api, address) {
  return api("/api/me/eth-accounts/active", { method: "POST", body: { address } });
}

export async function listEmails(api) {
  return api("/api/me/emails");
}

export async function listPasskeys(api) {
  return api("/api/me/passkeys");
}

export async function setPrimaryEmail(api, { id, email } = {}) {
  return api("/api/me/emails/primary", { method: "POST", body: { id, email } });
}

export async function removeBoundEmail(api, id) {
  return api(`/api/me/emails/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function removePasskey(api, credentialId) {
  return api(`/api/me/passkeys/${encodeURIComponent(credentialId)}`, { method: "DELETE" });
}

export async function fetchPinKeypad(api, { purpose } = {}) {
  return api("/api/me/pin/keypad", { method: "POST", body: { purpose: purpose || "setup" } });
}

export async function setVotePin(api, { pin, currentPin, confirmPin } = {}) {
  return api("/api/me/pin", { method: "POST", body: { pin, currentPin, confirmPin } });
}

export async function verifyVotePin(api, { pin, purpose } = {}) {
  return api("/api/me/pin/verify", { method: "POST", body: { pin, purpose: purpose || "vote" } });
}

export async function forgotVotePin(api, { email } = {}) {
  if (email) return api("/api/pin/forgot", { method: "POST", body: { email } });
  return api("/api/me/pin/forgot", { method: "POST", body: {} });
}
