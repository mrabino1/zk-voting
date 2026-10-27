/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * First-run setup steps 3 and 4 (plugged into setup.js via ctx.setupExtraSteps):
 *   3. Is there a public entropy ceremony? If so, its host.
 *   4. Setup entropy: paste the closed ceremony's output, generate local
 *      entropy in this tab now, or skip for now.
 * The saved value is offered on the trusted-setup contribution page (/ceremony)
 * to the super admin. ZK_ENTROPY / ENTROPY_CEREMONY_URL in the environment win.
 */

import { EntropyPool, attachCollectors, parseEntropyString } from "./vendor/zk-entropy.js";

const LOCAL_TARGET = 128;

function ceremonyStep(ctx) {
  const { h, state, isSuper, run, api, stepBadge } = ctx;
  const s = state.status;
  const e = s?.entropy || { ceremony: {} };
  const c = e.ceremony || {};
  const locked = !isSuper() || s?.setupComplete;
  const done = c.source !== "none";
  if (state.ceremonyChoice == null) {
    state.ceremonyChoice = c.enabled === true ? "yes" : c.enabled === false ? "no" : null;
    state.ceremonyHost = c.url ? c.url.replace(/^https:\/\//, "") : "";
  }
  const head = h("h2", { id: "setup-ceremony-h" }, stepBadge(3, done), " Entropy ceremony");
  if (c.source === "env") {
    return h(
      "section",
      { class: "panel setup-step is-done", "aria-labelledby": "setup-ceremony-h" },
      head,
      h("p", {}, "The ceremony host is fixed by the environment (", h("code", { text: "ENTROPY_CEREMONY_URL" }), "): ", h("a", { href: c.url, target: "_blank", rel: "noopener", text: c.url }), ".")
    );
  }
  const save = (event) => {
    event.preventDefault();
    run(async () => {
      if (!state.ceremonyChoice) throw new Error("Choose whether there is a public entropy ceremony.");
      const enabled = state.ceremonyChoice === "yes";
      state.status = await api("/api/setup/ceremony", { method: "PUT", body: { enabled, url: enabled ? state.ceremonyHost : undefined } });
      state.info = enabled ? `Ceremony host ${state.status.entropy.ceremony.url} saved.` : "Saved: no public ceremony.";
    });
  };
  const radio = (value, label, hint) =>
    h(
      "label",
      { class: "choice", for: `setup-ceremony-${value}` },
      h("input", {
        id: `setup-ceremony-${value}`,
        type: "radio",
        name: "ceremony",
        value,
        checked: state.ceremonyChoice === value,
        onChange: () => {
          state.ceremonyChoice = value;
          ctx.paint();
        },
      }),
      h("span", {}, label, hint ? h("span", { class: "muted", text: ` ${hint}` }) : null)
    );
  return h(
    "section",
    { class: `panel setup-step${done ? " is-done" : ""}`, "aria-labelledby": "setup-ceremony-h" },
    head,
    h("p", {
      text: "A public entropy ceremony lets many people add randomness before you run the trusted setup, so no one person controls it. It runs as its own small service (zk-entropy/ceremony). You can also skip it and use entropy from this browser.",
    }),
    c.url ? h("p", {}, "Current: ", h("a", { href: c.url, target: "_blank", rel: "noopener", text: c.url })) : null,
    locked
      ? h("p", { class: "field-hint", text: s?.setupComplete ? "Setup is finished." : "Create the super admin first." })
      : h(
          "form",
          { class: "stack", onSubmit: save },
          h(
            "fieldset",
            { class: "choice-list" },
            h("legend", { class: "field-label", text: "Is there a public entropy ceremony?" }),
            radio("yes", "Yes", "(I run one, or will)"),
            radio("no", "No", "(use this browser's entropy, or skip)")
          ),
          state.ceremonyChoice === "yes"
            ? h(
                "label",
                { class: "field", for: "setup-ceremony-host" },
                h("span", { class: "field-label", text: "Ceremony host" }),
                h("input", {
                  id: "setup-ceremony-host",
                  value: state.ceremonyHost,
                  placeholder: "ceremony.example.org",
                  autocomplete: "url",
                  spellcheck: "false",
                  required: true,
                  "aria-describedby": "setup-ceremony-host-hint",
                  onInput: (ev) => {
                    state.ceremonyHost = ev.target.value;
                  },
                }),
                h("span", { class: "field-hint", id: "setup-ceremony-host-hint", text: "Hostname or https URL of the ceremony (its CNAME), for example ceremony.zk-voting.org." })
              )
            : null,
          h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: "Save" }))
        )
  );
}

function entropyStep(ctx) {
  const { h, state, isSuper, run, api, stepBadge, paint } = ctx;
  const s = state.status;
  const e = s?.entropy || { ceremony: {} };
  const hasCeremony = e.ceremony?.enabled === true;
  const locked = !isSuper() || s?.setupComplete;
  const done = e.source !== "none";
  const head = h("h2", { id: "setup-entropy-h" }, stepBadge(4, done), " Setup entropy");
  if (e.fixed) {
    return h(
      "section",
      { class: "panel setup-step is-done", "aria-labelledby": "setup-entropy-h" },
      head,
      h("p", {}, "Entropy is fixed by the environment (", h("code", { text: "ZK_ENTROPY" }), `, ${e.outputSource} source). Transcript hash `, h("span", { class: "mono", text: e.transcriptHash || "—" }), ".")
    );
  }
  const options = hasCeremony
    ? [
        ["ceremony", "The ceremony is closed: paste its final output"],
        ["local", "Not closed yet: generate entropy in this browser now"],
        ["skip", "Skip for now"],
      ]
    : [
        ["local", "Generate entropy in this browser now"],
        ["skip", "Skip for now"],
      ];
  if (!state.entropyChoice || !options.some(([v]) => v === state.entropyChoice)) {
    state.entropyChoice = e.set && options.some(([v]) => v === e.mode) ? e.mode : options[0][0];
  }
  const current = e.set
    ? h("p", {}, `Saved: ${e.mode === "ceremony" ? "ceremony output" : "local entropy"}. Transcript hash `, h("span", { class: "mono", text: e.transcriptHash }), ". The value is offered to you on the trusted-setup contribution page.")
    : e.source === "setup"
      ? h("p", { text: "Saved: skipped. You can add entropy when you contribute to the trusted setup." })
      : null;
  if (locked) {
    return h(
      "section",
      { class: `panel setup-step${done ? " is-done" : ""}`, "aria-labelledby": "setup-entropy-h" },
      head,
      current,
      h("p", { class: "field-hint", text: s?.setupComplete ? "Setup is finished." : "Create the super admin first." })
    );
  }

  let body = null;
  if (state.entropyChoice === "ceremony") {
    const status = h("p", { class: "field-hint", id: "setup-entropy-paste-hint", "aria-live": "polite", text: state.pasteNote || "Copy it from the ceremony's home page once it is closed. Starts with zke1:ceremony:" });
    body = h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", for: "setup-entropy-paste", text: "Ceremony output" }),
      h("textarea", {
        id: "setup-entropy-paste",
        rows: "3",
        spellcheck: "false",
        autocomplete: "off",
        "aria-describedby": "setup-entropy-paste-hint",
        value: state.pasteValue || "",
        onInput: async (ev) => {
          state.pasteValue = ev.target.value;
          const p = state.pasteValue.trim() ? await parseEntropyString(state.pasteValue) : null;
          state.pasteNote = !p ? "" : p.ok ? (p.source === "ceremony" ? "Checksum OK." : "That is a local entropy string, not a ceremony output.") : p.error;
          status.textContent = state.pasteNote;
          ev.target.setAttribute("aria-invalid", p && (!p.ok || p.source !== "ceremony") ? "true" : "false");
        },
      }),
      status,
      e.ceremony?.url ? h("p", { class: "field-hint" }, "Ceremony: ", h("a", { href: e.ceremony.url, target: "_blank", rel: "noopener", text: e.ceremony.url })) : null
    );
  } else if (state.entropyChoice === "local") {
    if (!state.entropyPool) {
      state.entropyPool = new EntropyPool();
      state.entropyEvents = 0;
    }
    if (state.entropyDetach) state.entropyDetach();
    const progress = h("progress", { id: "setup-entropy-progress", max: String(LOCAL_TARGET), value: String(Math.min(LOCAL_TARGET, state.entropyEvents)) });
    const pct = h("span", { text: `${Math.min(100, Math.round((state.entropyEvents / LOCAL_TARGET) * 100))}%` });
    const pad = h("div", { class: "entropy-pad", id: "setup-entropy-pad", tabindex: "0", role: "group", "aria-label": "Entropy pad", text: "Move your pointer or finger here, or focus this box and type anything." });
    state.entropyDetach = attachCollectors(pad, state.entropyPool, {
      onEvent: () => {
        state.entropyEvents += 1;
        progress.value = Math.min(LOCAL_TARGET, state.entropyEvents);
        pct.textContent = `${Math.min(100, Math.round((state.entropyEvents / LOCAL_TARGET) * 100))}%`;
      },
    });
    body = h(
      "div",
      { class: "stack" },
      h("p", { class: "field-hint", text: "This browser's secure random generator and timing jitter are always mixed in; movement and typing add more. Only the mixed 32-byte result is saved." }),
      pad,
      h("p", { class: "entropy-meter" }, h("label", { for: "setup-entropy-progress", text: "Collected " }), progress, " ", pct)
    );
  }

  const save = (event) => {
    event.preventDefault();
    run(async () => {
      let value;
      if (state.entropyChoice === "ceremony") {
        const p = await parseEntropyString(state.pasteValue || "");
        if (!p.ok) throw new Error(`Ceremony output rejected: ${p.error}.`);
        if (p.source !== "ceremony") throw new Error("That is a local entropy string, not a ceremony output.");
        value = state.pasteValue.trim();
      } else if (state.entropyChoice === "local") {
        if (state.entropyDetach) state.entropyDetach();
        const res = await state.entropyPool.finalize({ source: "local" });
        res.output.fill(0);
        value = res.entropyString;
        state.entropyPool = null;
      }
      state.status = await api("/api/setup/entropy", { method: "PUT", body: { mode: state.entropyChoice, value } });
      state.pasteValue = "";
      state.pasteNote = "";
      state.info = state.entropyChoice === "skip" ? "Entropy skipped for now." : "Setup entropy saved.";
    });
  };

  return h(
    "section",
    { class: `panel setup-step${done ? " is-done" : ""}`, "aria-labelledby": "setup-entropy-h" },
    head,
    h("p", { text: "This randomness seeds your contribution to the trusted setup. It is mixed with fresh randomness again when you contribute, so it never weakens it." }),
    current,
    h(
      "form",
      { class: "stack", onSubmit: save },
      h(
        "fieldset",
        { class: "choice-list" },
        h("legend", { class: "field-label", text: "Entropy source" }),
        ...options.map(([value, label]) =>
          h(
            "label",
            { class: "choice", for: `setup-entropy-${value}` },
            h("input", {
              id: `setup-entropy-${value}`,
              type: "radio",
              name: "entropyMode",
              value,
              checked: state.entropyChoice === value,
              onChange: () => {
                state.entropyChoice = value;
                paint();
              },
            }),
            h("span", { text: label })
          )
        )
      ),
      body,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", disabled: state.busy, text: state.entropyChoice === "skip" ? "Skip" : "Save entropy" }))
    )
  );
}

export const entropySetupSteps = [ceremonyStep, entropyStep];
