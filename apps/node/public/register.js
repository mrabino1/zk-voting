/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Passkey registration + identity commitment display (commitment hex only).
 */

import { bindCivicId, bindSmartCard, bindWeb3Wallet, isMfaChallenge, provideMfaEmail, registerEthAccount, setActiveEthAddress, startEmailRegister, verifyMfaCode } from "./identity-methods.js";
import { mountSignInPanel } from "./signin.js";

export async function renderRegister(main, ctx) {
  const {
    h,
    api,
    fill,
    announce,
    wallet,
    loadElections,
    loadMe,
    recordRegistration,
    formatTime,
    electionStateInfo,
    electionRefEquals,
    route,
  } = ctx;

  const [{ elections, source }, me, publicRecord] = await Promise.all([
    loadElections(),
    loadMe(),
    wallet.getPublicRecord().catch(() => null),
  ]);

  const preselect = route.query.get("election") || "";
  const matchPre = electionRefEquals
    ? elections.find((e) => electionRefEquals(e, preselect))
    : elections.find((e) => e.id === preselect);
  const state = {
    busy: false,
    error: "",
    info: "",
    record: publicRecord,
    identity: me?.identity || me?.me?.identity || null,
    methodTab: "email",
    mfa: null,
    selected: matchPre?.id || elections.find((e) => e.state <= 2)?.id || elections[0]?.id || "",
    acceptedTerms: false,
  };

  const signInHost = h("div", {
    id: "sign-in-root",
    dataset: {
      heading: "Already registered? Sign in",
      lede: "Use email, a bound Ethereum wallet, a smart-card reader, a driver’s license / passport, or a passkey. First-time registration is below. Every path still uses an email one-time code.",
    },
  });
  const root = h("div", { class: "register-page" });
  main.replaceChildren(signInHost, root);
  mountSignInPanel(signInHost);

  function paint() {
    const rec = state.record;
    fill(root,
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", text: "Intake" }),
        h("h1", { text: "Identify yourself" }),
        h(
          "p",
          { class: "lede" },
          "A person is unique. You may verify email, a Web3 wallet, a smart-card reader, a driver’s license or passport, and a passkey. Several Ethereum addresses can be internally verified; only one is active. The public roll still stores an identity commitment, never your name, never a document number, and never the active address as the Merkle leaf."
        )
      ),
      h(
        "ol",
        { class: "steps" },
        h("li", {}, h("strong", { text: "Prove who you are" }), " with email, Ethereum, a smart-card reader, or a driver’s license / passport."),
        h("li", {}, h("strong", { text: "Keep one active Ethereum address" }), " — more can be verified internally."),
        h("li", {}, h("strong", { text: "Submit a commitment" }), " to an election roll — never a name, never the wallet as the leaf.")
      ),
      !wallet.hasWebAuthn()
        ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: wallet.webAuthnUnavailableMessage() }))
        : null,
      state.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })) : null,
      state.info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })) : null,
      h(
        "section",
        { class: "panel terms-agree", "aria-labelledby": "terms-agree-heading" },
        h("h2", { id: "terms-agree-heading", text: "Terms of Use" }),
        h(
          "p",
          {
            text: "First-time registration records the SHA-256 of the current Terms PDF on your person and emails you that PDF through AWS SES when configured.",
          }
        ),
        h(
          "label",
          { class: "check-row", for: "reg-accepted-terms" },
          h("input", {
            id: "reg-accepted-terms",
            name: "acceptedTerms",
            type: "checkbox",
            checked: state.acceptedTerms,
            onChange: (event) => {
              state.acceptedTerms = Boolean(event.target.checked);
            },
          }),
          h(
            "span",
            {},
            "I agree to the ",
            h("a", { href: "/terms", "data-nav": "", text: "Terms of Use" }),
            " (PDF SHA-256 is stored on this person)."
          )
        )
      ),
      state.mfa
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "reg-mfa-heading" },
            h("h2", { id: "reg-mfa-heading", text: "Email verification code" }),
            h("p", {
              text: state.mfa.needsEmail
                ? "Enter the email that will receive your sign-in code (AWS SES)."
                : `Enter the 6-digit code sent to ${state.mfa.emailHint || "your email"}.`,
            }),
            state.mfa.needsEmail
              ? h(
                  "form",
                  { class: "stack", onSubmit: onMfaEmail },
                  h(
                    "label",
                    { class: "field", for: "reg-mfa-email" },
                    "Email",
                    h("input", { id: "reg-mfa-email", name: "email", type: "email", required: true })
                  ),
                  h("div", { class: "toolbar" }, h("button", { class: "btn", type: "submit", text: "Send code" }))
                )
              : h(
                  "form",
                  { class: "stack", onSubmit: onMfaVerify },
                  h(
                    "label",
                    { class: "field", for: "reg-mfa-code" },
                    "One-time code",
                    h("input", {
                      id: "reg-mfa-code",
                      name: "code",
                      class: "otp-input",
                      inputmode: "numeric",
                      maxlength: "6",
                      required: true,
                    })
                  ),
                  h("div", { class: "toolbar" }, h("button", { class: "btn", type: "submit", text: "Verify code" }))
                )
          )
        : null,
      h(
        "div",
        { class: "method-tabs", role: "tablist", "aria-label": "How you identify" },
        ...["email", "web3", "smart_card", "civic_id", "passkey"].map((tab) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": state.methodTab === tab ? "true" : "false",
              text:
                tab === "email"
                  ? "Email"
                  : tab === "web3"
                    ? "Web3 wallet"
                    : tab === "smart_card"
                      ? "Smart card"
                      : tab === "civic_id"
                        ? "License / passport"
                        : "Passkey",
              onClick: () => {
                state.methodTab = tab;
                paint();
              },
            }
          )
        )
      ),
      state.methodTab === "email"
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "email-heading" },
            h("h2", { id: "email-heading", text: "Email username" }),
            h(
              "p",
              {
                text: "Your username is an email address. Republic sends a 6-digit sign-in code through AWS SES. That is the MFA step for every other method as well.",
              }
            ),
            h(
              "form",
              { class: "stack", onSubmit: onBindEmail },
              h(
                "label",
                { class: "field", for: "reg-email" },
                "Email",
                h("input", {
                  id: "reg-email",
                  name: "email",
                  type: "email",
                  autocomplete: "email",
                  required: true,
                })
              ),
              h(
                "label",
                { class: "field", for: "reg-email-handle" },
                "Public handle (optional)",
                h("input", {
                  id: "reg-email-handle",
                  name: "handle",
                  type: "text",
                  autocomplete: "username",
                })
              ),
              h(
                "div",
                { class: "toolbar" },
                h(
                  "button",
                  {
                    class: "btn",
                    type: "submit",
                    disabled: Boolean(state.busy),
                    text: state.busy ? "Sending code…" : "Email me a code",
                  }
                )
              )
            )
          )
        : null,
      state.methodTab === "civic_id"
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "civic-heading" },
            h("h2", { id: "civic-heading", text: "Driver’s license or passport" }),
            h(
              "p",
              {
                text: "Socially certified photo ID. The Node stores a hash of the document type, issuing jurisdiction, and number — never the image and never the number itself. This desk is not a court-ready identity-verification product.",
              }
            ),
            h(
              "form",
              { class: "stack", onSubmit: onBindCivic },
              h(
                "label",
                { class: "field", for: "civic-kind" },
                "Document",
                h(
                  "select",
                  { id: "civic-kind", name: "kind", required: true },
                  h("option", { value: "drivers_license", text: "Driver’s license" }),
                  h("option", { value: "passport", text: "Passport" })
                )
              ),
              h(
                "label",
                { class: "field", for: "civic-issuer" },
                "Issuing jurisdiction (for example US-CA)",
                h("input", { id: "civic-issuer", name: "issuer", type: "text", required: true })
              ),
              h(
                "label",
                { class: "field", for: "civic-number" },
                "Document number (hashed, not stored)",
                h("input", {
                  id: "civic-number",
                  name: "documentNumber",
                  type: "password",
                  autocomplete: "off",
                  required: true,
                })
              ),
              h(
                "label",
                { class: "field", for: "civic-email" },
                "Email for MFA",
                h("input", { id: "civic-email", name: "email", type: "email", autocomplete: "email" })
              ),
              h(
                "div",
                { class: "toolbar" },
                h(
                  "button",
                  {
                    class: "btn",
                    type: "submit",
                    disabled: Boolean(state.busy),
                    text: "Bind ID and send email code",
                  }
                )
              )
            )
          )
        : null,
      state.methodTab === "web3"
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "web3-heading" },
            h("h2", { id: "web3-heading", text: "Web3 wallet" }),
            h(
              "p",
              {
                text: "Sign a Republic binding message. The address is uniquely yours. After the signature, email MFA still runs.",
              }
            ),
            h(
              "form",
              { class: "stack", onSubmit: onBindWeb3 },
              h(
                "div",
                { class: "toolbar" },
                h(
                  "button",
                  {
                    class: "btn",
                    type: "submit",
                    disabled: Boolean(state.busy),
                    text: state.busy ? "Waiting for wallet…" : "Connect and sign",
                  }
                )
              )
            )
          )
        : null,
      state.methodTab === "smart_card"
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "card-heading" },
            h("h2", { id: "card-heading", text: "Smart card digital ID" }),
            h(
              "p",
              {
                text: "PIV, CAC, or national eID at a reader. A clerk can also attest a card at the desk. This Node demo accepts a certificate fingerprint (kiosk / mock path), then email MFA.",
              }
            ),
            h(
              "form",
              { class: "stack", onSubmit: onBindCard },
              h(
                "label",
                { class: "field", for: "card-fp" },
                "Certificate fingerprint or PEM",
                h("input", {
                  id: "card-fp",
                  name: "fingerprint",
                  type: "text",
                  spellcheck: "false",
                  placeholder: "0x… or paste PEM",
                  required: true,
                })
              ),
              h(
                "div",
                { class: "toolbar" },
                h(
                  "button",
                  {
                    class: "btn",
                    type: "submit",
                    disabled: Boolean(state.busy),
                    text: "Bind smart card",
                  }
                )
              )
            )
          )
        : null,
      state.methodTab === "passkey"
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "passkey-heading" },
            h("h2", { id: "passkey-heading", text: "1. Device passkey" }),
            h(
              "p",
              {
                text: rec
                  ? rec.staleWrap
                    ? "This browser still has a v1 passkey wrap. v1 derived the vote identity from the account seed (weaker than the spec). Reset it, then create a new passkey so account and identity use separate PRF domains."
                    : "A passkey wallet is already stored on this browser profile. Creating another one replaces the wrapped seed on this device."
                  : "Use the platform authenticator (Touch ID, Windows Hello, a hardware key). You will be asked to verify it is you. The account key and the vote identity are derived under separate PRF domains.",
              }
            ),
            h(
              "form",
              {
                class: "stack",
                onSubmit: onCreatePasskey,
              },
              h(
                "label",
                { class: "field", for: "display-name" },
                "Name for this authenticator (not placed on chain)",
                h("span", {
                  class: "field-hint",
                  text: "Shown only to your device. The roll stores a commitment, not this label.",
                }),
                h("input", {
                  id: "display-name",
                  name: "displayName",
                  type: "text",
                  maxlength: "64",
                  autocomplete: "username webauthn",
                  value: rec?.displayName || "voter",
                })
              ),
              h(
                "div",
                { class: "toolbar" },
                h(
                  "button",
                  {
                    class: "btn",
                    type: "submit",
                    disabled: Boolean(state.busy || !wallet.hasWebAuthn()),
                    "aria-busy": state.busy ? "true" : "false",
                    text: state.busy ? "Waiting for authenticator…" : rec ? "Replace passkey on this device" : "Create passkey",
                  }
                )
              )
            )
          )
        : null,
      h(
        "section",
        { class: "panel", "aria-labelledby": "commitment-heading" },
        h("h2", { id: "commitment-heading", text: "2. Identity commitment" }),
        rec
          ? [
              h(
                "p",
                {
                  text: "This hex is what a registrar inserts into the election Merkle tree. It is not your wallet address and it is not a ballot.",
                }
              ),
              h("p", { class: "field-label", text: "Identity commitment" }),
              h("div", { class: "commitment", id: "commitment-hex", text: rec.identityCommitment }),
              h(
                "div",
                { class: "copy-row" },
                h(
                  "button",
                  {
                    class: "btn btn-secondary",
                    type: "button",
                    onClick: () => copyText(rec.identityCommitment, "Identity commitment copied."),
                    text: "Copy commitment",
                  }
                )
              ),
              h("p", { class: "field-label", text: "Republic local address" }),
              h("div", { class: "hex", text: `${rec.address}  ·  ${rec.addressScheme}` }),
              h("p", { class: "field-hint", text: rec.productionAddressNote }),
              rec.staleWrap
                ? h(
                    "p",
                    {
                      class: "notice notice-warn",
                      text: rec.migrationNote || "This wrap is from an older demo. Reset the device wallet and create a new passkey.",
                    }
                  )
                : rec.prfSupported
                ? h("p", { text: "PRF wrap: account material uses salt republic:account:v1; the ZK trapdoor uses salt republic:identity:v1. They are not the same bytes." })
                : h(
                    "p",
                    {
                      class: "notice notice-warn",
                      text: rec.fallbackNote || "PRF was not available. Fallback wrap is weaker than production PRF. The trapdoor still uses a separate HKDF domain from the account seed.",
                    }
                  ),
            ]
          : h("p", { text: "Create a passkey to derive the commitment. The trapdoor never appears on this screen." })
      ),
      h(
        "section",
        { class: "panel", "aria-labelledby": "active-eth-heading" },
        h("h2", { id: "active-eth-heading", text: "Active Ethereum address" }),
        h(
          "p",
          {
            text: state.identity?.activeEthAddress
              ? `Active: ${state.identity.activeEthAddress}. ${state.identity.verifiedEthAddressCount || 0} address(es) verified internally.`
              : "No active Ethereum address yet. Bind a wallet or register the passkey-derived address. Only one can be active.",
          }
        ),
        state.identity?.ethAccounts?.length
          ? h(
              "ul",
              { class: "meta-list" },
              ...state.identity.ethAccounts.map((a) =>
                h(
                  "li",
                  {},
                  h("span", { class: "lbl", text: a.active ? "Active" : "Verified" }),
                  h("span", { class: "hex", text: `${a.address} · ${a.source}` }),
                  a.active
                    ? null
                    : h(
                        "button",
                        {
                          class: "btn btn-secondary",
                          type: "button",
                          onClick: () => onSetActive(a.address),
                          text: "Make active",
                        }
                      )
                )
              )
            )
          : null,
        rec
          ? h(
              "form",
              { class: "stack", onSubmit: onRegisterLocalAddress },
              h("p", { class: "field-hint", text: `Passkey local address on this device: ${rec.address}` }),
              h(
                "div",
                { class: "toolbar" },
                h("button", { class: "btn btn-secondary", type: "submit", text: "Verify this device address" })
              )
            )
          : null,
        state.identity?.authMethods?.length
          ? h(
              "p",
              {
                class: "field-hint",
                text: `Verified methods: ${state.identity.authMethods.map((m) => m.type).join(", ")}.`,
              }
            )
          : null
      ),
      h(
        "section",
        { class: "panel", "aria-labelledby": "roll-heading" },
        h("h2", { id: "roll-heading", text: "3. Submit to an election roll" }),
        h(
          "p",
          {
            text: "POST /api/elections/:id/register after the passkey exists. The Node (or a clerk) posts the commitment, not your name.",
          }
        ),
        source === "sample"
          ? h("p", { class: "field-hint", text: "Election list is the sample calendar until the Node API responds." })
          : null,
        h(
          "form",
          { class: "stack", onSubmit: onSubmitRoll },
          h(
            "label",
            { class: "field", for: "election-select" },
            "Election",
            h(
              "select",
              {
                id: "election-select",
                name: "electionId",
                required: true,
                onChange: (ev) => {
                  state.selected = ev.target.value;
                },
              },
              ...elections.map((election) => {
                const st = electionStateInfo(election.state);
                const opt = h("option", {
                  value: election.id,
                  text: `${election.title} — ${st.label} — cutoff ${formatTime(election.cutoffTime)}`,
                });
                if (election.id === state.selected) opt.selected = true;
                if (election.state > 2) opt.disabled = true;
                return opt;
              })
            )
          ),
          h(
            "label",
            { class: "choice", for: "attest" },
            h("input", { id: "attest", name: "attest", type: "checkbox", required: true }),
            h(
              "span",
              {
                text: "I am registering for this election, I understand the clerk may still require documents, and I know this screen will never show a seed phrase or my trapdoor.",
              }
            )
          ),
          h(
            "div",
            { class: "toolbar" },
            h(
              "button",
              {
                class: "btn",
                type: "submit",
                disabled: Boolean(state.busy || !rec),
                text: "Submit registration (passkey + relay)",
              }
            )
          )
        )
      ),
      me?.user
        ? h(
            "section",
            {},
            h("h2", { text: "Node account" }),
            h("p", { text: me.status ? `Status from /api/me: ${me.status}` : `Signed in as ${me.user.handle || me.user.role || "voter"}.` })
          )
        : null,
      rec
        ? h(
            "section",
            {},
            h("h2", { text: "This device" }),
            h(
              "p",
              {
                text: "Resetting removes the wrapped seed from IndexedDB (wallet record v2). It cannot print the seed because the seed is never kept in plaintext. A new passkey is required afterwards. v1 wraps cannot be migrated; reset is the demo upgrade path.",
              }
            ),
            h(
              "button",
              {
                class: "btn btn-danger",
                type: "button",
                onClick: onReset,
                text: "Reset this device’s passkey wallet",
              }
            )
          )
        : null
    );
  }

  async function copyText(value, okMessage) {
    try {
      await navigator.clipboard.writeText(value);
      announce(okMessage);
      state.info = okMessage;
      state.error = "";
      paint();
    } catch {
      state.error = "Could not copy. Select the hex and copy it manually.";
      paint();
    }
  }

  async function refreshIdentity() {
    try {
      const data = await api("/api/me/identity");
      state.identity = data.identity;
    } catch {
      try {
        const meData = await loadMe();
        state.identity = meData?.identity || meData?.me?.identity || null;
      } catch {
        /* stay */
      }
    }
  }

  async function applyAuthResult(result, okMessage) {
    if (isMfaChallenge(result)) {
      state.mfa = result;
      state.info = result.message || okMessage;
      return;
    }
    state.mfa = null;
    state.identity = result.identity;
    state.info = okMessage;
  }

  function requireTerms() {
    if (state.acceptedTerms) return true;
    state.error = "You must accept the Terms of Use to create an account.";
    paint();
    announce(state.error);
    return false;
  }

  async function onBindEmail(event) {
    event.preventDefault();
    if (state.busy) return;
    const email = event.target.email?.value?.trim();
    const handle = event.target.handle?.value?.trim();
    if (!requireTerms()) return;
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    try {
      const result = await startEmailRegister(api, { email, handle, acceptedTerms: true });
      await applyAuthResult(result, "Check your email for a 6-digit code.");
      announce(state.info);
    } catch (err) {
      state.error = err.message || "Email registration failed.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onBindCivic(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!requireTerms()) return;
    const kind = event.target.kind?.value;
    const issuer = event.target.issuer?.value?.trim();
    const documentNumber = event.target.documentNumber?.value;
    const email = event.target.email?.value?.trim();
    event.target.documentNumber.value = "";
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    try {
      const result = await bindCivicId(api, { kind, issuer, documentNumber, email, acceptedTerms: true });
      await applyAuthResult(result, "License or passport hashed and bound. Complete the email code.");
      announce(state.info);
    } catch (err) {
      state.error = err.message || "Civic ID bind failed.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onMfaEmail(event) {
    event.preventDefault();
    const email = event.target.email?.value?.trim();
    state.busy = true;
    state.error = "";
    try {
      const result = await provideMfaEmail(api, email);
      await applyAuthResult(result, "Code sent.");
    } catch (err) {
      state.error = err.message || "Could not send code.";
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onMfaVerify(event) {
    event.preventDefault();
    const code = event.target.code?.value?.trim();
    state.busy = true;
    state.error = "";
    try {
      const result = await verifyMfaCode(api, code);
      state.mfa = null;
      state.identity = result.identity;
      state.info = `Signed in as ${result.user?.handle || "registered"}.`;
      announce(state.info);
    } catch (err) {
      state.error = err.message || "Invalid code.";
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onBindWeb3(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!requireTerms()) return;
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    try {
      const result = await bindWeb3Wallet(api, { acceptedTerms: true });
      await applyAuthResult(
        result,
        "Web3 wallet bound to this person. It is verified internally. If it is your first address it is now active.",
      );
      announce("Web3 wallet bound.");
    } catch (err) {
      state.error = err.message || "Web3 bind failed.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onBindCard(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!requireTerms()) return;
    const raw = event.target.fingerprint?.value?.trim();
    if (!raw) return;
    const looksPem = raw.includes("-----BEGIN");
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    try {
      const result = await bindSmartCard(api, looksPem ? { certificate: raw, acceptedTerms: true } : { fingerprint: raw, acceptedTerms: true });
      await applyAuthResult(result, "Smart-card digital ID bound to this person.");
      announce("Smart card bound.");
    } catch (err) {
      state.error = err.message || "Smart-card bind failed.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onRegisterLocalAddress(event) {
    event.preventDefault();
    if (!state.record?.address) return;
    state.busy = true;
    state.error = "";
    try {
      const result = await registerEthAccount(api, { address: state.record.address, source: "passkey" });
      state.identity = result.identity;
      state.info = "Device address verified internally.";
    } catch (err) {
      state.error = err.message || "Could not verify device address. Sign in first.";
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onSetActive(address) {
    state.busy = true;
    state.error = "";
    try {
      const result = await setActiveEthAddress(api, address);
      state.identity = result.identity;
      state.info = `Active Ethereum address is now ${result.activeEthAddress}.`;
    } catch (err) {
      state.error = err.message || "Could not set active address.";
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onCreatePasskey(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!requireTerms()) return;
    const displayName = event.target.displayName?.value?.trim() || "voter";
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    announce("Waiting for the authenticator.");
    try {
      const election = elections.find((e) => e.id === state.selected);
      const record = await wallet.registerPasskey({
        api,
        displayName,
        jurisdictionId: election?.jurisdictionId || undefined,
        acceptedTerms: true,
      });
      state.record = record;
      await refreshIdentity();
      if (record.finishError) {
        state.info = "Passkey created on this device. The Node did not finish the session: " + record.finishError;
      } else {
        state.info = "Passkey created. Identity commitment is ready. The trapdoor is not displayed.";
      }
      announce("Passkey created. Commitment ready.");
    } catch (err) {
      state.error = err.message || "Passkey creation failed.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onSubmitRoll(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!state.record) {
      state.error = "Create a passkey before submitting to the roll.";
      paint();
      return;
    }
    const electionId = event.target.electionId?.value || state.selected;
    if (!electionId) {
      state.error = "Select an election.";
      paint();
      return;
    }
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    announce("Confirm the passkey to authorize registration.");
    try {
      const auth = await wallet.authorizeBallot({ electionId, ballotBytes: null });
      const body = {
        identityCommitment: auth.identityCommitment,
        address: auth.address,
        addressScheme: auth.addressScheme,
        credentialId: auth.credentialId,
        signature: auth.signature,
        userOpHash: auth.userOpHash,
        userOp: {
          sender: auth.address,
          nonce: "0x0",
          signature: auth.signature,
          callData: "register",
        },
      };
      let status = "registered";
      try {
        const res = await api(`/api/elections/${encodeURIComponent(electionId)}/register`, {
          method: "POST",
          body,
        });
        status = res?.status || res?.state || "registered";
        state.info =
          res?.message ||
          `Registration accepted by the Node for election ${electionId}. Commitment ${auth.identityCommitment.slice(0, 12)}… was relayed.`;
      } catch (err) {
        if (source === "sample" && err.status) {
          status = "pending";
          state.info = `Passkey authorized. The Node has no live roll for this sample election (${err.message}). A local receipt was stored; the trapdoor is not shown.`;
        } else if (err.status) {
          throw err;
        } else {
          status = "pending";
          state.info = `Passkey authorized locally. The Node at /api/elections/${electionId}/register did not respond, so this device stored a local receipt only.`;
        }
      }
      recordRegistration(electionId, { identityCommitment: auth.identityCommitment, status });
      announce("Registration submitted.");
    } catch (err) {
      state.error =
        err.status === 401
          ? "The Node needs a session cookie. Create the passkey again so /api/auth/passkey/register/finish can run, then submit to the roll."
          : err.message || "Registration failed.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onReset() {
    if (!window.confirm("Remove the wrapped passkey wallet from this browser? This cannot show a seed phrase because none exists.")) {
      return;
    }
    await wallet.resetWallet();
    state.record = null;
    state.info = "Device wallet cleared.";
    announce("Device wallet cleared.");
    paint();
  }

  paint();
}
