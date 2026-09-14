/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Ballot UI: every aspect on one envelope. After accept, do not print selections.
 */

import {
  buildBallotObject,
  collectAnswers,
  cssQuestionName,
  isMultiSelect,
  isRankedType,
  questionsOf,
  typeLabel,
} from "./ballot.js";

export const SAMPLE_QUESTIONS = [
  {
    id: "q-ordinance",
    type: "YES_NO",
    prompt: "Shall Ordinance 2026-14, extending public library hours on Sundays, be adopted?",
    description: "A Yes vote adopts the ordinance. A No vote rejects it. You may undervote only if you intend to leave this question blank.",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
  {
    id: "q-council",
    type: "MULTI_CHOICE",
    prompt: "City Council, at-large — choose up to two candidates.",
    description: "Select one or two names. Selecting none is an undervote on this aspect.",
    maxSelections: 2,
    options: [
      { id: "cand-rivera", label: "Alex Rivera" },
      { id: "cand-chen", label: "Morgan Chen" },
      { id: "cand-okonkwo", label: "Sam Okonkwo" },
      { id: "cand-berg", label: "Jordan Berg" },
    ],
  },
];

export async function renderVote(main, ctx) {
  const {
    h,
    api,
    fill,
    announce,
    wallet,
    loadElection,
    loadMe,
    readVoterStore,
    recordVoteReceipt,
    formatTime,
    electionStateInfo,
    electionId,
    SAMPLE_QUESTIONS: sampleQs,
  } = ctx;

  const [{ election, source }, me, publicRecord] = await Promise.all([
    loadElection(electionId),
    loadMe(),
    wallet.getPublicRecord().catch(() => null),
  ]);

  if (!election) {
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: "Election not found" }), h("p", { text: `No election ${electionId} on this Node.` })),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: "Back to elections" }))
    );
    return;
  }

  const questions =
    source === "sample" ? questionsOf({ questions: election.questions?.length ? election.questions : sampleQs || SAMPLE_QUESTIONS }) : questionsOf(election);
  const store = readVoterStore();
  const prior = store.votes[String(election.id)];
  const st = electionStateInfo(election.state);
  const state = {
    busy: false,
    error: "",
    info: "",
    step: prior ? "receipt" : "ballot",
    receipt: prior || null,
    answersPreview: null,
  };

  const root = h("div", { class: "ballot-page" });
  main.replaceChildren(root);

  function header() {
    return h(
      "div",
      { class: "page-head" },
      h("p", { class: "kicker", text: election.jurisdiction }),
      h("h1", { text: election.title }),
      h(
        "p",
        { class: "cluster" },
        h("span", { class: `status-pill ${st.className}`, text: st.label }),
        source === "sample" ? h("span", { class: "status-pill status-created", text: "Sample ballot" }) : null
      ),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Election id" }), h("span", { text: String(election.id) })),
        h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(election.startTime) })),
        h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) })),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Aspects" }),
          h("span", { text: questions.length ? `${questions.length} question${questions.length === 1 ? "" : "s"} on this ballot` : "None published" })
        ),
        election.ballotSpecHash
          ? h("li", {}, h("span", { class: "lbl", text: "Ballot spec" }), h("span", { class: "hex", style: { padding: "0.2rem 0.4rem" }, text: election.ballotSpecHash }))
          : null
      ),
      h(
        "p",
        {
          text: "Mark every question. One envelope covers the whole ballot. Your selections stay on this form until you submit. After the relay accepts the ballot, this page will not show how you voted.",
        }
      )
    );
  }

  function rankedField(question) {
    return h(
      "div",
      { class: "rank-list" },
      h(
        "p",
        {
          class: "field-hint",
          text: "Ranked-choice / IRV is not tallied on this Node. Your ranking is still sealed in the ballot envelope.",
        }
      ),
      ...question.options.map((_, i) =>
        h(
          "label",
          { class: "field-label rank-slot", for: `${cssQuestionName(question.id)}-rank-${i}` },
          h("span", { text: `Choice ${i + 1}` }),
          h(
            "select",
            { id: `${cssQuestionName(question.id)}-rank-${i}`, name: `${cssQuestionName(question.id)}-rank-${i}` },
            h("option", { value: "", text: "—" }),
            ...question.options.map((opt) => h("option", { value: opt.id, text: opt.label }))
          )
        )
      )
    );
  }

  function questionField(question, index) {
    const multi = isMultiSelect(question);
    const ranked = isRankedType(question.type);
    const inputType = multi ? "checkbox" : "radio";
    return h(
      "fieldset",
      { class: "question", id: `question-${question.id}` },
      h(
        "legend",
        {},
        h("span", { class: "aspect-kicker", text: `Question ${index + 1} of ${questions.length} · ${typeLabel(question.type)}` }),
        h("span", { class: "aspect-prompt", text: question.prompt })
      ),
      question.description ? h("p", { class: "field-hint", text: question.description }) : null,
      ranked
        ? rankedField(question)
        : h("p", { class: "field-hint", text: multi ? `Select up to ${question.maxSelections}.` : "Select one. Leaving this blank is an undervote." }),
      ranked
        ? null
        : h(
            "div",
            { class: "choice-list", role: "group", "aria-label": question.prompt },
            ...question.options.map((opt) =>
              h(
                "label",
                { class: "choice", for: `${cssQuestionName(question.id)}-${opt.id}` },
                h("input", {
                  id: `${cssQuestionName(question.id)}-${opt.id}`,
                  name: cssQuestionName(question.id),
                  type: inputType,
                  value: opt.id,
                  onChange: (ev) => enforceMax(ev, question),
                }),
                h("span", { text: opt.label })
              )
            )
          )
    );
  }

  function enforceMax(event, question) {
    if (!isMultiSelect(question)) return;
    const form = event.target.form;
    const boxes = [...form.querySelectorAll(`input[name="${cssQuestionName(question.id)}"]`)];
    const checked = boxes.filter((b) => b.checked);
    if (checked.length > question.maxSelections) {
      event.target.checked = false;
      announce(`You may choose at most ${question.maxSelections} options.`);
    }
  }

  function paint() {
    const closed = election.state >= 3;
    const notOpen = election.state !== 2;
    const children = [header()];
    if (state.error) children.push(h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })));
    if (state.info) children.push(h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })));

    if (state.step === "receipt" && state.receipt) {
      children.push(renderReceipt(state.receipt, h));
      children.push(
        h(
          "p",
          { class: "cluster" },
          h("a", { class: "btn", href: "/", "data-nav": "", text: "Return to elections" }),
          election.state >= 3
            ? h("a", { class: "btn btn-secondary", href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: "View results" })
            : null
        )
      );
      fill(root, ...children);
      return;
    }

    if (!publicRecord) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn" },
          h("p", { text: "This device does not have a Republic passkey yet. Register first, then return to the ballot." }),
          h("a", { class: "btn", href: `/register?election=${encodeURIComponent(election.id)}`, "data-nav": "", text: "Go to registration" })
        )
      );
    }

    if (closed) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn", role: "status" },
          h("p", { text: "Polls are closed for this election. You can review the questions; the Node will not accept a new ballot." }),
          h("a", { class: "btn btn-secondary", href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: "Certified results" })
        )
      );
    } else if (notOpen) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn", role: "status" },
          h("p", {
            text:
              election.state === 1
                ? "The roll is frozen. Voting has not opened. You may review the questions."
                : "This election is not open. Registration may still be available.",
          })
        )
      );
    }

    if (me?.elections?.[election.id]?.status) {
      children.push(h("p", { text: `Node status for you: ${me.elections[election.id].status}.` }));
    }

    if (!questions.length) {
      children.push(
        h(
          "div",
          { class: "notice notice-error", role: "alert" },
          h("p", { text: "This election has no published questions. The clerk must author at least one aspect." })
        )
      );
      fill(root, ...children);
      return;
    }

    children.push(
      h(
        "form",
        { class: "ballot", id: "ballot-form", autocomplete: "off", onSubmit: onSubmit },
        h("h2", { text: `Official ballot · ${questions.length} question${questions.length === 1 ? "" : "s"}` }),
        ...questions.map((q, i) => questionField(q, i)),
        h(
          "label",
          { class: "choice", for: "swear" },
          h("input", { id: "swear", name: "swear", type: "checkbox", required: true }),
          h(
            "span",
            {
              text: "I am eligible to mark this ballot, I am not submitting it under coercion that I wish to report to the clerk, and I understand the receipt will not list my choices.",
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
              disabled: Boolean(state.busy || !publicRecord),
              "aria-busy": state.busy ? "true" : "false",
              text: state.busy ? "Waiting for passkey / relay…" : "Submit ballot with passkey",
            }
          ),
          h("a", { class: "btn btn-secondary", href: "/", "data-nav": "", text: "Cancel" })
        )
      )
    );

    fill(root, ...children);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!publicRecord) {
      state.error = "Register a passkey on this device before voting.";
      paint();
      return;
    }
    const form = event.target;
    const answers = collectAnswers(form, questions);
    const blank = answers.every((a) => a.optionIds.length === 0);
    if (blank && !window.confirm("Every question is blank. Submit an undervote?")) return;
    if (election.state !== 2) {
      if (!window.confirm("This election is not open. Try to relay anyway? The Node should reject the vote.")) return;
    }

    state.busy = true;
    state.error = "";
    state.info = "";
    state.answersPreview = answers;
    paint();
    announce("Confirm your passkey. Your choices will not appear on the receipt.");

    const ballotObject = buildBallotObject({
      electionId: election.id,
      ballotSpecHash: election.ballotSpecHash || null,
      questions,
      answers,
    });
    const ballotBytes = new TextEncoder().encode(JSON.stringify(ballotObject));

    try {
      const auth = await wallet.authorizeBallot({ electionId: election.id, ballotBytes });
      const dummyRoot = election.eligibleRoot || "0x" + "00".repeat(32);
      const body = {
        electionId: String(election.id),
        identityCommitment: auth.identityCommitment,
        address: auth.address,
        addressScheme: auth.addressScheme,
        credentialId: auth.credentialId,
        nullifier: auth.nullifier,
        ballotHash: auth.ballotHash,
        encryptedBallot: auth.encryptedBallot,
        signature: auth.signature,
        userOpHash: auth.userOpHash,
        userOp: {
          sender: auth.address,
          nonce: "0x0",
          signature: auth.signature,
          callData: "submitVote",
        },
        proof: {
          mock: true,
          a: ["0x0", "0x0"],
          b: [
            ["0x0", "0x0"],
            ["0x0", "0x0"],
          ],
          c: ["0x0", "0x0"],
          publicInputs: [dummyRoot, auth.nullifier, auth.ballotHash, String(election.id)],
        },
      };

      let accepted = false;
      let message = "";
      try {
        const res = await api(`/api/elections/${encodeURIComponent(election.id)}/vote`, {
          method: "POST",
          body,
        });
        accepted = res?.accepted !== false;
        message = res?.message || "The Node accepted the ballot for relay.";
      } catch (err) {
        if (source === "sample" && err.status >= 400) {
          accepted = true;
          message = `Passkey signature stored locally. The Node has no matching live election (${err.message}). This receipt does not list your choices.`;
        } else if (err.status >= 400) {
          throw err;
        } else {
          accepted = true;
          message =
            "Passkey signature stored. The Node /api/elections/:id/vote endpoint did not respond; this device kept a local receipt without listing your choices.";
        }
      }

      const receipt = {
        at: new Date().toISOString(),
        ballotHash: auth.ballotHash,
        nullifier: auth.nullifier,
        userOpHash: auth.userOpHash,
        accepted,
        message,
      };
      recordVoteReceipt(election.id, receipt);
      state.receipt = receipt;
      state.step = "receipt";
      state.info = "";
      state.answersPreview = null;
      announce("Ballot submitted. Receipt does not include your choices.");
    } catch (err) {
      state.error = err.message || "The relay rejected this ballot.";
      announce(state.error);
    } finally {
      state.busy = false;
      paint();
    }
  }

  paint();
}

function renderReceipt(receipt, h) {
  return h(
    "section",
    { class: "receipt", "aria-labelledby": "receipt-heading" },
    h("h2", { id: "receipt-heading", text: "Ballot receipt" }),
    h(
      "p",
      {
        text: "This is not a proof of how you voted. Keep the hashes. Public explorer rows wait until the hour that contained this ballot closes, so leaving a voting office cannot be matched to a live jurisdiction tick. Anyone who demands to see your choice should be directed to the clerk’s coercion-resistance instructions.",
      }
    ),
    receipt.message ? h("p", { text: receipt.message }) : null,
    h(
      "ul",
      { class: "meta-list" },
      h("li", {}, h("span", { class: "lbl", text: "Recorded" }), h("span", { text: receipt.at || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "Ballot hash" }), h("span", { class: "hex", text: receipt.ballotHash || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "Nullifier" }), h("span", { class: "hex", text: receipt.nullifier || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "UserOp hash" }), h("span", { class: "hex", text: receipt.userOpHash || "—" }))
    )
  );
}
