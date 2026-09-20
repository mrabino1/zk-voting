/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Passkey registration + identity commitment display (commitment hex only).
 */

import { bindSmartCard, bindWeb3Wallet, registerEthAccount, setActiveEthAddress } from "./identity-methods.js";
import { mountSignInPanel } from "./signin.js";
import { t } from "./i18n.js";

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
    methodTab: "passkey",
    selected: matchPre?.id || elections.find((e) => e.state <= 2)?.id || elections[0]?.id || "",
  };

  const signInHost = h("div", {
    id: "sign-in-root",
    dataset: {
      headingKey: "register.heading",
      ledeKey: "register.ledePanel",
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
        h("p", { class: "kicker", text: t("register.kicker") }),
        h("h1", { text: t("register.title") }),
        h(
          "p",
          { class: "lede" },
          t("register.lede")
        )
      ),
      h(
        "ol",
        { class: "steps" },
        h("li", {}, h("strong", { text: t("register.stepProve") }), t("register.stepProveRest")),
        h("li", {}, h("strong", { text: t("register.stepActive") }), t("register.stepActiveRest")),
        h("li", {}, h("strong", { text: t("register.stepCommit") }), t("register.stepCommitRest"))
      ),
      !wallet.hasWebAuthn()
        ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: wallet.webAuthnUnavailableMessage() }))
        : null,
      state.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })) : null,
      state.info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })) : null,
      h(
        "div",
        { class: "method-tabs", role: "tablist", "aria-label": t("register.identifyHow") },
        ...["passkey", "web3", "smart_card"].map((tab) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": state.methodTab === tab ? "true" : "false",
              text: tab === "passkey" ? t("home.passkey") : tab === "web3" ? t("register.web3Title") : t("register.tabCard"),
              onClick: () => {
                state.methodTab = tab;
                paint();
              },
            }
          )
        )
      ),
      state.methodTab === "web3"
        ? h(
            "section",
            { class: "panel", "aria-labelledby": "web3-heading" },
            h("h2", { id: "web3-heading", text: t("register.web3Title") }),
            h(
              "p",
              {
                text: t("register.web3Body"),
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
                    text: state.busy ? t("signin.waitingWallet") : t("register.connectSign"),
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
            h("h2", { id: "card-heading", text: t("register.cardTitle") }),
            h(
              "p",
              {
                text: t("register.cardBody"),
              }
            ),
            h(
              "form",
              { class: "stack", onSubmit: onBindCard },
              h(
                "label",
                { class: "field", for: "card-fp" },
                t("register.fingerprint"),
                h("input", {
                  id: "card-fp",
                  name: "fingerprint",
                  type: "text",
                  spellcheck: "false",
                  placeholder: t("register.fingerprintPlaceholder"),
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
                    text: t("register.bindCard"),
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
            h("h2", { id: "passkey-heading", text: t("register.passkeyTitle") }),
            h(
              "p",
              {
                text: rec
                  ? rec.staleWrap
                    ? t("register.passkeyStale")
                    : t("register.passkeyExisting")
                  : t("register.passkeyHelp"),
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
                t("register.authenticatorName"),
                h("span", {
                  class: "field-hint",
                  text: t("register.authenticatorHint"),
                }),
                h("input", {
                  id: "display-name",
                  name: "displayName",
                  type: "text",
                  maxlength: "64",
                  autocomplete: "username webauthn",
                  value: rec?.displayName || t("register.displayNameDefault"),
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
                    text: state.busy ? t("register.waitingAuth") : rec ? t("register.replacePasskey") : t("register.createPasskey"),
                  }
                )
              )
            )
          )
        : null,
      h(
        "section",
        { class: "panel", "aria-labelledby": "commitment-heading" },
        h("h2", { id: "commitment-heading", text: t("register.commitmentTitle") }),
        rec
          ? [
              h(
                "p",
                {
                  text: t("register.commitmentHelp"),
                }
              ),
              h("p", { class: "field-label", text: t("register.identityCommitment") }),
              h("div", { class: "commitment", id: "commitment-hex", text: rec.identityCommitment }),
              h(
                "div",
                { class: "copy-row" },
                h(
                  "button",
                  {
                    class: "btn btn-secondary",
                    type: "button",
                    onClick: () => copyText(rec.identityCommitment, t("register.copiedCommitment")),
                    text: t("register.copyCommitment"),
                  }
                )
              ),
              h("p", { class: "field-label", text: t("register.localAddress") }),
              h("div", { class: "hex", text: `${rec.address}  ·  ${rec.addressScheme}` }),
              h("p", { class: "field-hint", text: rec.productionAddressNote }),
              rec.staleWrap
                ? h(
                    "p",
                    {
                      class: "notice notice-warn",
                      text: rec.migrationNote || t("register.staleDemoWrap"),
                    }
                  )
                : rec.prfSupported
                ? h("p", { text: t("register.prfWrap") })
                : h(
                    "p",
                    {
                      class: "notice notice-warn",
                      text: rec.fallbackNote || t("register.prfFallback"),
                    }
                  ),
            ]
          : h("p", { text: t("register.createFirst") })
      ),
      h(
        "section",
        { class: "panel", "aria-labelledby": "active-eth-heading" },
        h("h2", { id: "active-eth-heading", text: t("register.activeEthTitle") }),
        h(
          "p",
          {
            text: state.identity?.activeEthAddress
              ? t("register.activeSummary", {
                  address: state.identity.activeEthAddress,
                  count: state.identity.verifiedEthAddressCount || 0,
                })
              : t("register.noActive"),
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
                  h("span", { class: "lbl", text: a.active ? t("register.activeLabel") : t("register.verifiedLabel") }),
                  h("span", { class: "hex", text: `${a.address} · ${a.source}` }),
                  a.active
                    ? null
                    : h(
                        "button",
                        {
                          class: "btn btn-secondary",
                          type: "button",
                          onClick: () => onSetActive(a.address),
                          text: t("register.makeActive"),
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
              h("p", { class: "field-hint", text: t("register.passkeyLocal", { address: rec.address }) }),
              h(
                "div",
                { class: "toolbar" },
                h("button", { class: "btn btn-secondary", type: "submit", text: t("register.verifyDevice") })
              )
            )
          : null,
        state.identity?.authMethods?.length
          ? h(
              "p",
              {
                class: "field-hint",
                text: t("register.verifiedMethods", { methods: state.identity.authMethods.map((m) => m.type).join(", ") }),
              }
            )
          : null
      ),
      h(
        "section",
        { class: "panel", "aria-labelledby": "roll-heading" },
        h("h2", { id: "roll-heading", text: t("register.rollTitle") }),
        h(
          "p",
          {
            text: t("register.rollHelp"),
          }
        ),
        source === "sample"
          ? h("p", { class: "field-hint", text: t("register.sampleList") })
          : null,
        h(
          "form",
          { class: "stack", onSubmit: onSubmitRoll },
          h(
            "label",
            { class: "field", for: "election-select" },
            t("register.election"),
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
                  text: t("register.electionOption", { title: election.title, state: st.label, cutoff: formatTime(election.cutoffTime) }),
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
                text: t("register.swear"),
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
                text: t("register.submit"),
              }
            )
          )
        )
      ),
      me?.user
        ? h(
            "section",
            {},
            h("h2", { text: t("register.nodeAccount") }),
            h("p", { text: me.status ? t("register.statusFromMe", { status: me.status }) : t("signin.signedInAs", { handle: me.user.handle || me.user.role || t("register.displayNameDefault") }) })
          )
        : null,
      rec
        ? h(
            "section",
            {},
            h("h2", { text: t("register.thisDevice") }),
            h(
              "p",
              {
                text: t("register.resetHelp"),
              }
            ),
            h(
              "button",
              {
                class: "btn btn-danger",
                type: "button",
                onClick: onReset,
                text: t("register.resetWallet"),
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
      state.error = t("register.copyFail");
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

  async function onBindWeb3(event) {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    try {
      const result = await bindWeb3Wallet(api);
      state.identity = result.identity;
      state.info = t("register.web3Bound");
      announce(t("register.web3BoundAnnounce"));
    } catch (err) {
      state.error = err.message || t("register.web3BindFail");
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onBindCard(event) {
    event.preventDefault();
    if (state.busy) return;
    const raw = event.target.fingerprint?.value?.trim();
    if (!raw) return;
    const looksPem = raw.includes("-----BEGIN");
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    try {
      const result = await bindSmartCard(api, looksPem ? { certificate: raw } : { fingerprint: raw });
      state.identity = result.identity;
      state.info = t("register.cardBound");
      announce(t("register.cardBoundAnnounce"));
    } catch (err) {
      state.error = err.message || t("register.cardFail");
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
      state.info = t("register.deviceVerified");
    } catch (err) {
      state.error = err.message || t("register.deviceVerifyFail");
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
      state.info = t("register.activeNow", { address: result.activeEthAddress });
    } catch (err) {
      state.error = err.message || t("register.activeFail");
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onCreatePasskey(event) {
    event.preventDefault();
    if (state.busy) return;
    const displayName = event.target.displayName?.value?.trim() || t("register.displayNameDefault");
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    announce(t("register.waitingAuthenticator"));
    try {
      const election = elections.find((e) => e.id === state.selected);
      const record = await wallet.registerPasskey({
        api,
        displayName,
        jurisdictionId: election?.jurisdictionId || undefined,
      });
      state.record = record;
      await refreshIdentity();
      if (record.finishError) {
        state.info = t("register.passkeyCreatedSession", { error: record.finishError });
      } else {
        state.info = t("register.passkeyCreated");
      }
      announce(t("register.passkeyCreatedShort"));
    } catch (err) {
      state.error = err.message || t("register.passkeyFail");
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
      state.error = t("register.needPasskey");
      paint();
      return;
    }
    const electionId = event.target.electionId?.value || state.selected;
    if (!electionId) {
      state.error = t("register.selectElection");
      paint();
      return;
    }
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    announce(t("register.confirmRegister"));
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
          t("register.accepted", { id: electionId, commitment: auth.identityCommitment.slice(0, 12) });
      } catch (err) {
        if (source === "sample" && err.status) {
          status = "pending";
          state.info = t("register.sampleAuthorized", { error: err.message });
        } else if (err.status) {
          throw err;
        } else {
          status = "pending";
          state.info = t("register.offlineAuthorized", { id: electionId });
        }
      }
      recordRegistration(electionId, { identityCommitment: auth.identityCommitment, status });
      announce(t("register.submitted"));
    } catch (err) {
      state.error =
        err.status === 401
          ? t("register.needSession")
          : err.message || t("register.failed");
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function onReset() {
    if (!window.confirm(t("register.resetConfirm"))) {
      return;
    }
    await wallet.resetWallet();
    state.record = null;
    state.info = t("register.walletCleared");
    announce(t("register.walletCleared"));
    paint();
  }

  paint();
}
