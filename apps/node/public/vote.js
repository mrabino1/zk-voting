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

import { t } from "./i18n.js";

export function sampleQuestions() {
  return [
    {
      id: "q-ordinance",
      type: "YES_NO",
      prompt: t("sample.ordinancePrompt"),
      description: t("sample.ordinanceDesc"),
      options: [
        { id: "yes", label: t("ballot.yes"), summary: t("sample.yesSummary") },
        { id: "no", label: t("ballot.no"), summary: t("sample.noSummary") },
      ],
    },
    {
      id: "q-council",
      type: "MULTI_CHOICE",
      prompt: t("sample.councilPrompt"),
      description: t("sample.councilDesc"),
      maxSelections: 2,
      options: [
        {
          id: "cand-rivera",
          label: "Alex Rivera",
          summary: t("sample.riveraSummary"),
          body: t("sample.riveraBody"),
          links: [{ label: t("sample.campaignSite"), url: "https://example.org/rivera" }],
        },
        { id: "cand-chen", label: "Morgan Chen", summary: t("sample.chenSummary") },
        { id: "cand-okonkwo", label: "Sam Okonkwo", summary: t("sample.okonkwoSummary") },
        { id: "cand-berg", label: "Jordan Berg", summary: t("sample.bergSummary") },
      ],
    },
  ];
}

/** @deprecated Prefer sampleQuestions() so copy follows the active locale. */
export const SAMPLE_QUESTIONS = sampleQuestions();

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
    sampleQuestions: sampleQs,
  } = ctx;

  const [{ election, source }, me, publicRecord] = await Promise.all([
    loadElection(electionId),
    loadMe(),
    wallet.getPublicRecord().catch(() => null),
  ]);

  if (!election) {
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: t("common.electionNotFound") }), h("p", { text: t("common.noElectionOnNode", { id: electionId }) })),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.backToElections") }))
    );
    return;
  }

  const questions =
    source === "sample" ? questionsOf({ questions: election.questions?.length ? election.questions : sampleQs ? sampleQs() : sampleQuestions() }) : questionsOf(election);
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
        source === "sample" ? h("span", { class: "status-pill status-created", text: t("vote.sampleBallot") }) : null
      ),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: t("vote.electionId") }), h("span", { class: "hex", style: { padding: "0.2rem 0.4rem" }, text: String(election.id) })),
        election.shortCode
          ? h(
              "li",
              {},
              h("span", { class: "lbl", text: t("vote.shortLink") }),
              h("a", { href: `/v/${encodeURIComponent(election.shortCode)}`, "data-nav": "", text: `/v/${election.shortCode}` })
            )
          : null,
        election.onChainElectionId
          ? h("li", {}, h("span", { class: "lbl", text: t("vote.onChainId") }), h("span", { text: String(election.onChainElectionId) }))
          : null,
        h("li", {}, h("span", { class: "lbl", text: t("vote.opens") }), h("span", { text: formatTime(election.startTime) })),
        h("li", {}, h("span", { class: "lbl", text: t("vote.cutoff") }), h("span", { text: formatTime(election.cutoffTime) })),
        h(
          "li",
          {},
          h("span", { class: "lbl", text: t("vote.aspects") }),
          h("span", { text: questions.length ? t("vote.aspectsCount", { count: questions.length }) : t("vote.nonePublished") })
        ),
        election.ballotSpecHash
          ? h("li", {}, h("span", { class: "lbl", text: t("vote.ballotSpec") }), h("span", { class: "hex", style: { padding: "0.2rem 0.4rem" }, text: election.ballotSpecHash }))
          : null,
        election.tallyPubKey
          ? h("li", {}, h("span", { class: "lbl", text: t("vote.tallyEncryptionLabel") }), h("span", { text: t("vote.tallyEncryption") }))
          : null
      ),
      h(
        "p",
        {
          text: election.tallyPubKey ? t("vote.envelopeHelpTally") : t("vote.envelopeHelp"),
        }
      ),
      h(
        "p",
        {},
        h("a", {
          href: `/elections/${encodeURIComponent(election.id)}/info`,
          "data-nav": "",
          text: t("vote.readInfo"),
        }),
        " · ",
        h("a", { href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: t("vote.electionResults") })
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
          h("span", { class: "visually-hidden", text: t("vote.rankFor", { label: opt.label }) }),
          h(
            "select",
            {
              "aria-label": t("vote.rankFor", { label: opt.label }),
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
            text: t("vote.up"),
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
            text: t("vote.down"),
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
            text: t("vote.remove"),
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
        text: t("vote.rankedHelp"),
      }),
      rankedIds.length
        ? h(
            "ol",
            { class: "rank-list", "aria-label": t("vote.yourRanking") },
            ...rankedIds.map((id, i) => rankRow(optionById(question, id) || { id, label: id }, i, rankedIds.length))
          )
        : h("p", { class: "field-hint", text: t("vote.noneRanked") }),
      unranked.length
        ? h(
            "div",
            { class: "unranked-list" },
            h("p", { class: "field-hint", text: t("vote.notRanked") }),
            ...unranked.map((opt) =>
              h(
                "div",
                { class: "rank-row unranked" },
                h(
                  "label",
                  { class: "rank-number" },
                  h("span", { class: "visually-hidden", text: t("vote.assignRank", { label: opt.label }) }),
                  h(
                    "select",
                    {
                      "aria-label": t("vote.rankFor", { label: opt.label }),
                      onChange: (ev) => applyRankNumber(opt.id, ev.target.value),
                    },
                    h("option", { value: "", text: t("common.dash") }),
                    ...Array.from({ length: n }, (_, i) => h("option", { value: String(i + 1), text: String(i + 1) }))
                  )
                ),
                h("span", { class: "rank-label", text: opt.label }),
                h("button", {
                  type: "button",
                  class: "btn btn-secondary rank-btn",
                  text: t("vote.addNext"),
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
        h("span", { class: "aspect-kicker", text: t("vote.questionKicker", { index: index + 1, total: questions.length, type: typeLabel(question.type) }) }),
        h("span", { class: "aspect-prompt", text: question.prompt })
      ),
      question.description ? h("p", { class: "field-hint", text: question.description }) : null,
      ranked
        ? rankedField(question, index)
        : h("p", { class: "field-hint", text: multi ? t("vote.selectUpTo", { count: question.maxSelections }) : t("vote.selectOne") }),
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
                      text: t("vote.about"),
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
      announce(t("vote.maxOptions", { count: question.maxSelections }));
    }
  }

  function paint() {
    const closed = election.state >= 3;
    const notOpen = election.state !== 2;
    const children = [header()];
    if (state.error) children.push(h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: state.error })));
    if (state.info) children.push(h("div", { class: "notice notice-ok", role: "status" }, h("p", { text: state.info })));

    if (state.receipt && (state.step === "receipt" || election.state === 2)) {
      children.push(renderReceipt(state.receipt, h));
      children.push(
        h(
          "p",
          { class: "cluster" },
          h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.returnElections") }),
          h("a", { class: "btn btn-secondary", href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: t("vote.results") })
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
            text: publicRecord?.staleWrap ? t("vote.staleWrap") : t("vote.noPasskey"),
          }),
          h("a", { class: "btn", href: `/register?election=${encodeURIComponent(election.id)}`, "data-nav": "", text: t("vote.goRegister") })
        )
      );
    }

    if (closed) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn", role: "status" },
          h("p", { text: t("vote.pollsClosed") }),
          h("a", { class: "btn", href: `/elections/${encodeURIComponent(election.id)}/results`, "data-nav": "", text: t("vote.certifiedResults") })
        )
      );
    } else if (notOpen) {
      children.push(
        h(
          "div",
          { class: "notice notice-warn", role: "status" },
          h("p", {
            text: election.state === 1 ? t("vote.rollFrozen") : t("vote.notOpen"),
          })
        )
      );
    }

    if (me?.elections?.[election.id]?.status) {
      children.push(h("p", { text: t("vote.nodeStatus", { status: me.elections[election.id].status }) }));
    }

    if (!questions.length) {
      children.push(
        h(
          "div",
          { class: "notice notice-error", role: "alert" },
          h("p", { text: t("vote.noQuestions") })
        )
      );
      fill(root, ...children);
      return;
    }

    children.push(
      h(
        "form",
        { class: "ballot", id: "ballot-form", autocomplete: "off", onSubmit: onSubmit },
        h("h2", { text: t("vote.officialBallot", { count: questions.length }) }),
        ...questions.map((q, i) => questionField(q, i)),
        h(
          "label",
          { class: "choice", for: "swear" },
          h("input", { id: "swear", name: "swear", type: "checkbox", required: true }),
          h(
            "span",
            {
              text: t("vote.swear"),
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
              disabled: Boolean(state.busy || !publicRecord || publicRecord.staleWrap),
              "aria-busy": state.busy ? "true" : "false",
              text: state.busy ? t("vote.waitingRelay") : t("vote.submit"),
            }
          ),
          h("a", { class: "btn btn-secondary", href: "/", "data-nav": "", text: t("common.cancel") })
        )
      )
    );

    fill(root, ...children);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.busy) return;
    if (!publicRecord || publicRecord.staleWrap) {
      state.error = publicRecord?.staleWrap ? t("vote.resetWrap") : t("vote.registerFirst");
      paint();
      return;
    }
    const form = event.target;
    const answers = collectAnswers(form, questions);
    const blank = answers.every((a) => (a.ranking ? a.ranking.length === 0 : (a.optionIds || []).length === 0));
    if (blank && !window.confirm(t("vote.undervoteConfirm"))) return;
    if (election.state !== 2) {
      if (!window.confirm(t("vote.notOpenConfirm"))) return;
    }

    state.busy = true;
    state.error = "";
    state.info = "";
    state.answersPreview = answers;
    paint();
    announce(t("vote.confirmPasskey"));

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
      const body = {
        electionId: String(election.id),
        identityCommitment: auth.identityCommitment,
        address: auth.address,
        addressScheme: auth.addressScheme,
        credentialId: auth.credentialId,
        nullifier: auth.nullifier,
        ballotHash: auth.ballotHash,
        encryptedBallot: auth.encryptedBallot,
        answers,
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
          publicInputs,
        },
      };

      let accepted = false;
      let message = "";
      let res = null;
      try {
        res = await api(`/api/elections/${encodeURIComponent(election.id)}/vote`, {
          method: "POST",
          body,
        });
        accepted = res?.accepted !== false;
        message = res?.message || t("vote.accepted");
      } catch (err) {
        if (source === "sample" && err.status >= 400) {
          accepted = true;
          message = t("vote.sampleAccept", { error: err.message });
        } else if (err.status >= 400) {
          throw err;
        } else {
          accepted = true;
          message = t("vote.offlineAccept");
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
      announce(t("vote.submitted"));
    } catch (err) {
      state.error = err.message || t("vote.rejected");
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
    h("h2", { id: "receipt-heading", text: t("vote.receiptTitle") }),
    h(
      "p",
      {
        text: t("vote.receiptHelp"),
      }
    ),
    receipt.message ? h("p", { text: receipt.message }) : null,
    h(
      "ul",
      { class: "meta-list" },
      h("li", {}, h("span", { class: "lbl", text: t("vote.recorded") }), h("span", { text: receipt.at || t("common.dash") })),
      h("li", {}, h("span", { class: "lbl", text: t("vote.ballotHash") }), h("span", { class: "hex", text: receipt.ballotHash || t("common.dash") })),
      h("li", {}, h("span", { class: "lbl", text: t("vote.nullifier") }), h("span", { class: "hex", text: receipt.nullifier || t("common.dash") })),
      h("li", {}, h("span", { class: "lbl", text: t("vote.userOpHash") }), h("span", { class: "hex", text: receipt.userOpHash || t("common.dash") }))
    )
  );
}
