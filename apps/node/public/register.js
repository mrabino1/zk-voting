/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Passkey registration + identity commitment display (commitment hex only).
 */

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
    route,
  } = ctx;

  const [{ elections, source }, me, publicRecord] = await Promise.all([
    loadElections(),
    loadMe(),
    wallet.getPublicRecord().catch(() => null),
  ]);

  const preselect = route.query.get("election") || "";
  const state = {
    busy: false,
    error: "",
    info: "",
    record: publicRecord,
    selected: preselect && elections.some((e) => e.id === preselect) ? preselect : elections.find((e) => e.state <= 2)?.id || elections[0]?.id || "",
  };

  const root = h("div", { class: "register-page" });
  main.replaceChildren(root);

  function paint() {
    const rec = state.record;
    fill(root,
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", text: "Intake" }),
        h("h1", { text: "Register with a device passkey" }),
        h(
          "p",
          { class: "lede" },
          "Republic does not show a recovery phrase. Your device holds a WebAuthn credential. When the authenticator supports PRF, that secret wraps a 32-byte key in IndexedDB. Only the identity commitment hex is fit to put on the public roll."
        )
      ),
      h(
        "ol",
        { class: "steps" },
        h("li", {}, h("strong", { text: "Create a passkey" }), " with resident key and user verification."),
        h("li", {}, h("strong", { text: "Record the commitment" }), " — copy the hex, never a trapdoor."),
        h("li", {}, h("strong", { text: "Submit to an election roll" }), " via the Node registrar relay.")
      ),
      !wallet.hasWebAuthn()
        ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: wallet.webAuthnUnavailableMessage() }))
        : null,
      state.error ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })) : null,
      state.info ? h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })) : null,
      h(
        "section",
        { class: "panel", "aria-labelledby": "passkey-heading" },
        h("h2", { id: "passkey-heading", text: "1. Device passkey" }),
        h(
          "p",
          {
            text: rec
              ? "A passkey wallet is already stored on this browser profile. Creating another one replaces the wrapped seed on this device."
              : "Use the platform authenticator (Touch ID, Windows Hello, a hardware key). You will be asked to verify it is you.",
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
      ),
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
              rec.prfSupported
                ? h("p", { text: "PRF wrap: this authenticator returned a PRF output. The seed is AES-GCM wrapped from HKDF-SHA256(PRF)." })
                : h(
                    "p",
                    {
                      class: "notice notice-warn",
                      text: rec.fallbackNote || "PRF was not available. Fallback wrap is weaker than production PRF.",
                    }
                  ),
            ]
          : h("p", { text: "Create a passkey to derive the commitment. The trapdoor never appears on this screen." })
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
                text: "Resetting removes the wrapped seed from IndexedDB. It cannot print the seed because the seed is never kept in plaintext. A new passkey is required afterwards.",
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

  async function onCreatePasskey(event) {
    event.preventDefault();
    if (state.busy) return;
    const displayName = event.target.displayName?.value?.trim() || "voter";
    state.busy = true;
    state.error = "";
    state.info = "";
    paint();
    announce("Waiting for the authenticator.");
    try {
      const record = await wallet.registerPasskey({ api, displayName });
      state.record = record;
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
