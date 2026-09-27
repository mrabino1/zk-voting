/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Ballot UI: every aspect on one envelope. After accept, do not print selections.
 */

import { openingIndexFromAnswers } from "./tally-crypto.js";
import {
  buildBallotObject,
  collectAnswers,
  cssQuestionName,
  isMultiSelect,
  isRankedQuestion,
  isRankedType,
  questionsOf,
  typeLabel,
} from "./ballot.js";
import { copyText, rememberProof } from "./receipt.js";
import { renderPinPad, STANDARD_PAD } from "./pin-pad.js";
import { verifyVotePin } from "./identity-methods.js";

function tallyEncryptionBlurb(election) {
  const ceremony = election.tallyCeremony;
  const t = ceremony?.threshold;
  const n = ceremony?.guardians;
  if (t > 1 && n >= t) {
    return `P-256 ECIES to a ${t}-of-${n} Feldman guardian key (NON-PRODUCTION). Homomorphic aggregation and a mixnet are not decided.`;
  }
  return "P-256 ECIES to the election tally pubkey (NON-PRODUCTION).";
}

export const SAMPLE_QUESTIONS = [
  {
    id: "q-ordinance",
    type: "YES_NO",
    prompt: "Shall Ordinance 2026-14, extending public library hours on Sundays, be adopted?",
    description: "A Yes vote adopts the ordinance. A No vote rejects it. You may undervote only if you intend to leave this question blank.",
    options: [
      { id: "yes", label: "Yes", summary: "Adopt the ordinance." },
      { id: "no", label: "No", summary: "Reject the ordinance." },
    ],
  },
  {
    id: "q-council",
    type: "MULTI_CHOICE",
    prompt: "City Council, at-large — choose up to two candidates.",
    description: "Select one or two names. Selecting none is an undervote on this aspect.",
    maxSelections: 2,
    options: [
      {
        id: "cand-rivera",
        label: "Alex Rivera",
        summary: "Neighborhood organizer.",
        body: "Alex Rivera organizes tenant unions in Northbridge.",
        links: [{ label: "Campaign site", url: "https://example.org/rivera" }],
      },
      { id: "cand-chen", label: "Morgan Chen", summary: "Civil engineer." },
      { id: "cand-okonkwo", label: "Sam Okonkwo", summary: "School teacher." },
      { id: "cand-berg", label: "Jordan Berg", summary: "Small-business owner." },
    ],
  },
];

const ZERO_ROOT = "0x" + "00".repeat(32);

/**
 * Mock Groth16 public instance. Same order as `@zk-voting/proof-helpers`
 * `serializePublicInputs` and `IBallotInbox.submitVote`:
 * `[eligibleRoot, disqRoot, nullifier, ballotHash, electionId]`.
 */
export function mockVotePublicInputs({ eligibleRoot, disqRoot, nullifier, ballotHash, electionId }) {
  return [
    eligibleRoot || ZERO_ROOT,
    disqRoot || ZERO_ROOT,
    nullifier,
    ballotHash,
    String(electionId),
  ];
}

/**
 * Relay envelope only. Choice stays inside `encryptedBallot`. The leaf, wallet,
 * credential id, and plaintext `answers` are not fields of this POST.
 */
export function buildVoteRequestBody({
  electionId,
  nullifier,
  ballotHash,
  encryptedBallot,
  pinToken,
  userOpHash,
  proof,
}) {
  const body = {
    electionId: electionId == null || electionId === "" ? undefined : String(electionId),
    nullifier,
    ballotHash,
    encryptedBallot,
    userOpHash,
    proof,
  };
  if (pinToken) body.pinToken = pinToken;
  return body;
}

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
    chainElectionId,
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
  const rankingState = new Map();
  for (const q of questions) {
    if (isRankedQuestion(q)) rankingState.set(q.id, []);
  }
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
    pendingAnswers: null,
    pinDigits: "",
    pinKeypad: null,
    pinToken: null,
    emailTo: "",
    emailBusy: false,
    downloadBusy: false,
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
        h("li", {}, h("span", { class: "lbl", text: "Election id" }), h("span", { class: "hex", style: { padding: "0.2rem 0.4rem" }, text: String(election.id) })),
        election.shortCode
          ? h(
              "li",
              {},
              h("span", { class: "lbl", text: "Short link" }),
              h("a", { href: `/v/${encodeURIComponent(election.shortCode)}`, "data-nav": "", text: `/v/${election.shortCode}` })
            )
          : null,
        election.onChainElectionId
          ? h("li", {}, h("span", { class: "lbl", text: "On-chain id" }), h("span", { text: String(election.onChainElectionId) }))
          : null,
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
          : null,
        election.tallyPubKey
          ? h("li", {}, h("span", { class: "lbl", text: "Tally encryption" }), h("span", { text: tallyEncryptionBlurb(election) }))
          : null
      ),
      h(
        "p",
        {
          text:
            state.step === "receipt"
              ? "Your ballot was accepted. The receipt below cannot prove how you voted."
              : election.tallyPubKey
                ? "Mark every question. One envelope covers the whole ballot. Your selections stay on this form until you submit. The posted envelope is encrypted to the guardian tally public key. Opening it after cutoff takes t verified partial decryptions (NON-PRODUCTION). After the Node accepts a ballot, that nullifier is spent — you cannot vote again. The receipt cannot prove how you voted."
                : "Mark every question. One envelope covers the whole ballot. You may change your mind on this form until you submit. After the Node accepts a ballot, that nullifier is spent — you cannot vote again. Double voting is impossible. The receipt cannot prove how you voted.",
        }
      ),
      h(
        "p",
        {},
        h("a", {
          href: `/elections/${encodeURIComponent(election.id)}/info`,
          "data-nav": "",
          text: "Read candidate and measure information (does not record a vote)",
        }),
        " · ",
        h("a", { href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: "Election results" })
      )
    );
  }

  function optionById(question, id) {
    return (question.options || []).find((o) => String(o.id) === String(id));
  }

  function setRanking(question, next, index) {
    rankingState.set(question.id, next);
    const mount = document.getElementById(`question-${question.id}`);
    if (mount) mount.replaceWith(questionField(question, index));
  }

  function rankedField(question, index) {
    const rankedIds = rankingState.get(question.id) || [];
    const rankedSet = new Set(rankedIds);
    const unranked = question.options.filter((o) => !rankedSet.has(o.id));
    const n = question.options.length;

    function applyRankNumber(optionId, rankValue) {
      const current = (rankingState.get(question.id) || []).filter((id) => id !== optionId);
      if (!rankValue) {
        setRanking(question, current, index);
        return;
      }
      const rank = Math.max(1, Math.min(n, Number(rankValue)));
      current.splice(rank - 1, 0, optionId);
      setRanking(question, current, index);
    }

    function rankRow(opt, rankIndex, total) {
      return h(
        "li",
        {
          class: "rank-row",
          draggable: "true",
          "data-option-id": opt.id,
          onDragstart: (ev) => {
            ev.dataTransfer.setData("text/plain", opt.id);
            ev.dataTransfer.effectAllowed = "move";
          },
          onDragover: (ev) => {
            ev.preventDefault();
          },
          onDrop: (ev) => {
            ev.preventDefault();
            const from = ev.dataTransfer.getData("text/plain");
            if (!from || from === opt.id) return;
            const list = [...(rankingState.get(question.id) || [])];
            const fromIdx = list.indexOf(from);
            if (fromIdx >= 0) list.splice(fromIdx, 1);
            const insertAt = list.indexOf(opt.id);
            if (insertAt < 0) list.push(from);
            else list.splice(insertAt, 0, from);
            setRanking(question, list, index);
          },
        },
        h("span", { class: "rank-handle", "aria-hidden": "true", text: "⋮⋮" }),
        h(
          "label",
          { class: "rank-number" },
          h("span", { class: "visually-hidden", text: `Rank for ${opt.label}` }),
          h(
            "select",
            {
              "aria-label": `Rank for ${opt.label}`,
              value: String(rankIndex + 1),
              onChange: (ev) => applyRankNumber(opt.id, ev.target.value),
            },
            ...Array.from({ length: total }, (_, i) =>
              h("option", { value: String(i + 1), text: String(i + 1), selected: i === rankIndex })
            )
          )
        ),
        h("span", { class: "rank-label", text: opt.label }),
        h(
          "span",
          { class: "rank-move" },
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: "Up",
            disabled: rankIndex === 0,
            onClick: () => {
              const list = [...(rankingState.get(question.id) || [])];
              if (rankIndex <= 0) return;
              [list[rankIndex - 1], list[rankIndex]] = [list[rankIndex], list[rankIndex - 1]];
              setRanking(question, list, index);
            },
          }),
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: "Down",
            disabled: rankIndex === total - 1,
            onClick: () => {
              const list = [...(rankingState.get(question.id) || [])];
              if (rankIndex >= list.length - 1) return;
              [list[rankIndex + 1], list[rankIndex]] = [list[rankIndex], list[rankIndex + 1]];
              setRanking(question, list, index);
            },
          }),
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: "Remove",
            onClick: () =>
              setRanking(
                question,
                (rankingState.get(question.id) || []).filter((id) => id !== opt.id),
                index
              ),
          })
        )
      );
    }

    return h(
      "div",
      { class: "rank-list-wrap" },
      h("p", {
        class: "field-hint",
        text: "Rank in order of preference (1 = first choice). Drag to reorder, use rank numbers, or move names from the unranked list. Leaving a name unranked is an undervote on that candidate. Instant-runoff (IRV) eliminates last place until a majority.",
      }),
      rankedIds.length
        ? h(
            "ol",
            { class: "rank-list", "aria-label": "Your ranking" },
            ...rankedIds.map((id, i) => rankRow(optionById(question, id) || { id, label: id }, i, rankedIds.length))
          )
        : h("p", { class: "field-hint", text: "No candidates ranked yet." }),
      unranked.length
        ? h(
            "div",
            { class: "unranked-list" },
            h("p", { class: "field-hint", text: "Not ranked" }),
            ...unranked.map((opt) =>
              h(
                "div",
                { class: "rank-row unranked" },
                h(
                  "label",
                  { class: "rank-number" },
                  h("span", { class: "visually-hidden", text: `Assign rank for ${opt.label}` }),
                  h(
                    "select",
                    {
                      "aria-label": `Rank for ${opt.label}`,
                      onChange: (ev) => applyRankNumber(opt.id, ev.target.value),
                    },
                    h("option", { value: "", text: "—" }),
                    ...Array.from({ length: n }, (_, i) => h("option", { value: String(i + 1), text: String(i + 1) }))
                  )
                ),
                h("span", { class: "rank-label", text: opt.label }),
                h("button", {
                  type: "button",
                  class: "btn btn-secondary rank-btn",
                  text: "Add next",
                  onClick: () => setRanking(question, [...(rankingState.get(question.id) || []), opt.id], index),
                })
              )
            )
          )
        : null
    );
  }

  function questionField(question, index) {
    const multi = isMultiSelect(question);
    const ranked = isRankedQuestion(question) || isRankedType(question.type);
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
        ? rankedField(question, index)
        : h("p", { class: "field-hint", text: multi ? `Select up to ${question.maxSelections}.` : "Select one. Leaving this blank is an undervote." }),
      ranked
        ? null
        : h(
            "div",
            { class: "choice-list", role: "group", "aria-label": question.prompt },
            ...question.options.map((opt) =>
              h(
                "div",
                { class: "choice-row" },
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
                  h(
                    "span",
                    { class: "choice-copy" },
                    h("span", { text: opt.label }),
                    opt.summary ? h("span", { class: "field-hint", text: opt.summary }) : null
                  )
                ),
                source === "sample"
                  ? null
                  : h("a", {
                      class: "choice-info",
                      href: `/elections/${encodeURIComponent(election.id)}/info/${encodeURIComponent(question.id)}/${encodeURIComponent(opt.id)}`,
                      "data-nav": "",
                      text: "About",
                    })
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

  function signedIn() {
    return Boolean(me?.user);
  }

  function identityOf() {
    return me?.identity || me?.user?.identity || null;
  }

  function pinBound() {
    const id = identityOf();
    return Boolean(id?.pinBound || me?.user?.pinBound);
  }

  function needsVotePin() {
    return signedIn();
  }

  function renderPinStep() {
    if (!state.pinKeypad && !state.busy) {
      state.busy = true;
      api("/api/me/pin/keypad", { method: "POST", body: { purpose: "vote" } })
        .then((issued) => {
          state.pinKeypad = issued;
        })
        .catch((err) => {
          state.error = err.message || "Could not load the vote keypad.";
        })
        .finally(() => {
          state.busy = false;
          paint();
        });
    }
    return h(
      "section",
      { class: "panel pin-panel", "aria-labelledby": "vote-pin-final-heading" },
      h("h2", { id: "vote-pin-final-heading", text: "Enter your vote PIN" }),
      h("p", {
        text: "Tap your PIN on this scrambled phone keypad. Keyboard typing is disabled so a watcher cannot copy a keystroke pattern. Then confirm your passkey. The receipt will not list your choices.",
      }),
      renderPinPad(h, {
        layout: state.pinKeypad?.layout || STANDARD_PAD,
        scramble: true,
        value: state.pinDigits,
        disabled: Boolean(state.busy || !state.pinKeypad),
        labelledBy: "vote-pin-final-heading",
        confirmText: state.busy ? "Checking PIN…" : "Confirm PIN and continue",
        onChange: (next) => {
          state.pinDigits = next;
          paint();
        },
        onConfirm: (pin) => submitPinThenBallot(pin),
      }),
      h(
        "p",
        { class: "cluster" },
        h("button", {
          type: "button",
          class: "btn btn-secondary",
          text: "Back to ballot",
          onClick: () => {
            state.step = "ballot";
            state.pinDigits = "";
            paint();
          },
        }),
        h("a", { href: "/register", "data-nav": "", text: "Forgot PIN" })
      )
    );
  }

  async function submitPinThenBallot(pin) {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    paint();
    try {
      const verified = await verifyVotePin(api, { pin, purpose: "vote" });
      state.pinToken = verified.pinToken;
      state.pinDigits = "";
      await submitBallot(state.pendingAnswers);
    } catch (err) {
      state.error = err.message || "PIN is incorrect.";
      announce(state.error);
      state.busy = false;
      paint();
    }
  }

  function paint() {
    const closed = election.state >= 3;
    const notOpen = election.state !== 2;
    const children = [header()];
    if (state.error) children.push(h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })));
    if (state.info) children.push(h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })));

    if (state.step === "pin") {
      children.push(renderPinStep());
      fill(root, ...children);
      return;
    }

    if (state.receipt && (state.step === "receipt" || election.state === 2)) {
      children.push(renderReceipt(state, { h, api, announce, election, paint }));
      children.push(
        h(
          "p",
          { class: "cluster" },
          h("a", { class: "btn", href: "/", "data-nav": "", text: "Return to elections" }),
          h("a", { class: "btn btn-secondary", href: `/receipt`, "data-nav": "", text: "Check this proof" }),
          h("a", { class: "btn btn-secondary", href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: "Results" })
        )
      );
      fill(root, ...children);
      return;
    }

    if (!publicRecord || publicRecord.staleWrap) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn" },
          h("p", {
            text: publicRecord?.staleWrap
              ? "This device has a v1 passkey wrap that derived the vote identity from the account seed. Reset it on the register page and create a new passkey before voting."
              : "This device does not have a Republic passkey yet. Register first, then return to the ballot.",
          }),
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
          h("a", { class: "btn", href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: "Certified results" })
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

    if (source !== "sample" && !signedIn()) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn" },
          h("p", { text: "Sign in and set a vote PIN before finalizing a live ballot. Sample ballots can still be marked on this device." }),
          h("a", { class: "btn", href: "/signin", "data-nav": "", text: "Sign in" })
        )
      );
    } else if (signedIn() && !pinBound()) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn" },
          h("p", { text: "Set a vote PIN on Identify yourself before submitting this ballot. You will tap it on a scrambled keypad at finalization." }),
          h("a", { class: "btn", href: "/register", "data-nav": "", text: "Set vote PIN" })
        )
      );
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
              disabled: Boolean(
                state.busy ||
                  publicRecord?.staleWrap ||
                  (signedIn() && !pinBound()) ||
                  (source !== "sample" && !signedIn())
              ),
              "aria-busy": state.busy ? "true" : "false",
              text: signedIn() ? "Continue to vote PIN" : state.busy ? "Waiting for passkey / relay…" : "Submit ballot with passkey",
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
    const form = event.target;
    const answers = collectAnswers(form, questions);
    const blank = answers.every((a) => (a.ranking ? a.ranking.length === 0 : (a.optionIds || []).length === 0));
    if (blank && !window.confirm("Every question is blank. Submit an undervote?")) return;
    if (election.state !== 2) {
      if (!window.confirm("This election is not open. Try to relay anyway? The Node should reject the vote.")) return;
    }

    if (source !== "sample" && !signedIn()) {
      state.error = "Sign in and enter your vote PIN before submitting a live ballot.";
      paint();
      return;
    }
    if (signedIn() && !pinBound()) {
      state.error = "Set a vote PIN on Identify yourself before submitting this ballot.";
      paint();
      return;
    }

    // PIN is the last keypad step before the passkey ceremony.
    if (needsVotePin() && !state.pinToken) {
      state.pendingAnswers = answers;
      state.step = "pin";
      state.pinDigits = "";
      state.pinKeypad = null;
      paint();
      return;
    }

    if (!publicRecord || publicRecord.staleWrap) {
      state.error = publicRecord?.staleWrap
        ? "Reset the v1 passkey wrap on the register page, then create a new passkey."
        : "Register a passkey on this device before voting.";
      paint();
      return;
    }

    await submitBallot(answers);
  }

  async function submitBallot(answers) {
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
    const choiceIndex = openingIndexFromAnswers(answers, questions);
    const tallyPubKey = election.tallyPubKey || election.tallyCeremony?.publicKey || null;

    try {
      const auth = await wallet.authorizeBallot({
        electionId: election.id,
        ballotBytes,
        tallyPubKey,
        choiceIndex: tallyPubKey ? choiceIndex : undefined,
      });
      const onChainId = chainElectionId ? chainElectionId(election) : String(election.onChainElectionId ?? election.id);
      const publicInputs = mockVotePublicInputs({
        eligibleRoot: election.eligibleRoot,
        disqRoot: election.disqualificationRoot,
        nullifier: auth.nullifier,
        ballotHash: auth.ballotHash,
        electionId: onChainId,
      });
      const body = buildVoteRequestBody({
        electionId: String(election.id),
        nullifier: auth.nullifier,
        ballotHash: auth.ballotHash,
        encryptedBallot: auth.encryptedBallot,
        pinToken: state.pinToken || undefined,
        userOpHash: auth.userOpHash,
        proof: {
          mock: true,
          a: ["0x0", "0x0"],
          b: [
            ["0x0", "0x0"],
            ["0x0", "0x0"],
          ],
          c: ["0x0", "0x0"],
          publicInputs,
        },
      });

      let accepted = false;
      let message = "";
      let res = null;
      try {
        res = await api(`/api/elections/${encodeURIComponent(election.id)}/vote`, {
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

      const serverReceipt = res?.receipt && typeof res.receipt === "object" ? res.receipt : {};
      const receipt = {
        at: serverReceipt.acceptedAtIso || new Date().toISOString(),
        ballotHash: serverReceipt.ballotHash || auth.ballotHash,
        nullifier: serverReceipt.nullifier || auth.nullifier,
        userOpHash: serverReceipt.userOpHash || auth.userOpHash,
        token: serverReceipt.token || null,
        proofText: serverReceipt.proofText || null,
        published: serverReceipt.published,
        nextPublishAt: serverReceipt.nextPublishAt,
        pdfSha256: serverReceipt.pdfSha256 || null,
        pdfProtected: serverReceipt.pdfProtected !== false,
        pdfModify: false,
        integrity: serverReceipt.integrity || null,
        accepted,
        message,
        receiptsProveChoice: false,
      };
      recordVoteReceipt(election.id, receipt);
      if (receipt.proofText) rememberProof(receipt.proofText);
      state.receipt = receipt;
      state.step = "receipt";
      state.info = "";
      state.answersPreview = null;
      state.pendingAnswers = null;
      state.pinToken = null;
      state.pinDigits = "";
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

function renderReceipt(state, { h, api, announce, election, paint }) {
  const receipt = state.receipt || {};
  const proof =
    receipt.proofText ||
    [
      "-----BEGIN REPUBLIC VOTE RECEIPT-----",
      "schema: republic.receipt.v1",
      election?.id ? `electionId: ${election.id}` : null,
      receipt.nullifier ? `nullifier: ${receipt.nullifier}` : null,
      receipt.ballotHash ? `ballotHash: ${receipt.ballotHash}` : null,
      receipt.userOpHash ? `userOpHash: ${receipt.userOpHash}` : null,
      receipt.token ? `token: ${receipt.token}` : null,
      "-----END REPUBLIC VOTE RECEIPT-----",
    ]
      .filter(Boolean)
      .join("\n");

  async function onEmail(event) {
    event.preventDefault();
    if (state.emailBusy) return;
    if (!receipt.token) {
      state.error = "This device only has a local receipt. The Node token is required to email a PDF copy.";
      announce(state.error);
      paintFromReceipt();
      return;
    }
    state.emailBusy = true;
    state.error = "";
    paintFromReceipt();
    try {
      const res = await api("/api/receipts/email", {
        method: "POST",
        body: { token: receipt.token, proof, email: state.emailTo || undefined },
      });
      state.info = res?.toHint
        ? `Receipt emailed to ${res.toHint}. The message and locked PDF do not list your choices.`
        : "Receipt emailed. The message and locked PDF do not list your choices.";
      announce(state.info);
    } catch (err) {
      state.error = err.message || "Could not email this receipt.";
      announce(state.error);
    } finally {
      state.emailBusy = false;
      paintFromReceipt();
    }
  }

  async function onDownload() {
    if (state.downloadBusy) return;
    if (!receipt.token) {
      state.error = "This device only has a local receipt. The Node token is required to download the PDF.";
      announce(state.error);
      paintFromReceipt();
      return;
    }
    state.downloadBusy = true;
    state.error = "";
    paintFromReceipt();
    try {
      const res = await fetch("/api/receipts/pdf", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/pdf", "Content-Type": "application/json" },
        body: JSON.stringify({ token: receipt.token, proof }),
      });
      if (!res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        throw new Error(data?.error || res.statusText || "PDF download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "republic-vote-receipt.pdf";
      a.click();
      URL.revokeObjectURL(url);
      const sha = res.headers.get("x-pdf-sha256");
      if (sha) receipt.pdfSha256 = sha;
      announce("Locked PDF downloaded. It cannot be edited and does not list your choices.");
    } catch (err) {
      state.error = err.message || "Could not download the PDF.";
      announce(state.error);
    } finally {
      state.downloadBusy = false;
      paintFromReceipt();
    }
  }

  function paintFromReceipt() {
    paint?.();
  }

  return h(
    "section",
    { class: "receipt", "aria-labelledby": "receipt-heading" },
    h("h2", { id: "receipt-heading", text: "Ballot receipt" }),
    h(
      "p",
      {
        text: "This receipt cannot prove how you voted. It lists only hashes. It does not include your marked options, ciphertext opening, or trapdoor. You may vote only once; a second ballot for the same nullifier is rejected. Double voting is impossible. Public explorer rows wait until the hour that contained this ballot closes.",
      }
    ),
    h("p", {
      class: "field-hint",
      text: "The PDF is encrypted and locked against modification. Printing and copying are allowed; editing is not. A changed file will not match the SHA-256 the Node recorded.",
    }),
    receipt.message ? h("p", { text: receipt.message }) : null,
    h(
      "ul",
      { class: "meta-list" },
      h("li", {}, h("span", { class: "lbl", text: "Recorded" }), h("span", { text: receipt.at || receipt.acceptedAtIso || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "Ballot hash" }), h("span", { class: "hex", text: receipt.ballotHash || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "Nullifier" }), h("span", { class: "hex", text: receipt.nullifier || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "UserOp hash" }), h("span", { class: "hex", text: receipt.userOpHash || "—" })),
      h("li", {}, h("span", { class: "lbl", text: "PDF" }), h("span", { text: "Locked against modification" })),
      receipt.pdfSha256
        ? h("li", {}, h("span", { class: "lbl", text: "PDF SHA-256" }), h("span", { class: "hex", text: receipt.pdfSha256 }))
        : null,
      receipt.published === false
        ? h("li", {}, h("span", { class: "lbl", text: "Public proof" }), h("span", { text: "Pending hour close" }))
        : receipt.published
          ? h("li", {}, h("span", { class: "lbl", text: "Public proof" }), h("span", { text: "Disclosed" }))
          : null
    ),
    h("label", { class: "field", for: "receipt-proof-copy" }, "Copy-paste proof"),
    h("textarea", {
      id: "receipt-proof-copy",
      class: "proof-paste",
      readOnly: true,
      rows: 10,
      value: proof,
    }),
    h(
      "div",
      { class: "cluster" },
      h("button", {
        class: "btn",
        type: "button",
        text: "Copy proof",
        onClick: () => {
          rememberProof(proof);
          return copyText(proof, announce);
        },
      }),
      h("button", {
        class: "btn btn-secondary",
        type: "button",
        disabled: state.downloadBusy || !receipt.token,
        text: state.downloadBusy ? "Preparing locked PDF…" : "Download locked PDF",
        onClick: onDownload,
      }),
      h("a", {
        class: "btn btn-secondary",
        href: "/receipt",
        "data-nav": "",
        text: "Open receipt check",
        onClick: () => rememberProof(proof),
      })
    ),
    h(
      "form",
      { class: "stack receipt-email-form", onSubmit: onEmail },
      h("h3", { text: "Email this receipt" }),
      h("p", {
        class: "field-hint",
        text: "The email body and the attached PDF are the same evidence: hashes only. The PDF is encrypted so it cannot be edited. They do not list a candidate or an option. If you are signed in with email, you can leave the address blank.",
      }),
      h(
        "label",
        { class: "field", for: "receipt-email" },
        "Email address",
        h("input", {
          id: "receipt-email",
          name: "email",
          type: "email",
          autocomplete: "email",
          value: state.emailTo,
          onInput: (event) => {
            state.emailTo = event.target.value;
          },
        })
      ),
      h("button", {
        class: "btn",
        type: "submit",
        disabled: state.emailBusy || !receipt.token,
        text: state.emailBusy ? "Sending…" : "Email me the receipt",
      })
    )
  );
}
