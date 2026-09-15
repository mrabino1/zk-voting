/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Ballot UI: yes/no + multi-choice, passkey authorize, relay to /api/elections/:id/vote.
 * After accept, do not print the selected options.
 */

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
  {
    id: "q-mayor",
    type: "RANKED",
    ballotMethod: "ranked_choice",
    prompt: "Mayor — rank candidates in order of preference.",
    description: "1 is your first choice. You may leave names unranked. Instant-runoff (IRV) eliminates last place until a majority.",
    options: [
      { id: "cand-nguyen", label: "Priya Nguyen" },
      { id: "cand-hassan", label: "Omar Hassan" },
      { id: "cand-vale", label: "Riley Vale" },
    ],
  },
];

function normalizeQuestion(q, index = 0, electionMethod = "plurality") {
  const type = String(q.type || q.kind || "SINGLE_CHOICE").toUpperCase().replace(/[\s-]+/g, "_");
  const mapped = type === "RANKED_CHOICE" || type === "IRV" || type === "RCV" ? "RANKED" : type;
  const options = (q.options || q.choices || []).map((opt, i) => {
    if (typeof opt === "string") return { id: String(i), label: opt, summary: "", body: "", imageUrl: "", links: [] };
    return {
      id: String(opt.id ?? opt.value ?? i),
      label: opt.label || opt.name || String(opt.id ?? i),
      summary: opt.summary || opt.blurb || "",
      body: opt.body || "",
      imageUrl: opt.imageUrl || "",
      links: Array.isArray(opt.links) ? opt.links : [],
    };
  });
  if (mapped === "YES_NO" && options.length === 0) {
    options.push(
      { id: "yes", label: "Yes", summary: "", body: "", imageUrl: "", links: [] },
      { id: "no", label: "No", summary: "", body: "", imageUrl: "", links: [] }
    );
  }
  const explicit = q.ballotMethod ? String(q.ballotMethod).toLowerCase().replace(/[\s-]+/g, "_") : "";
  let ballotMethod = "plurality";
  if (explicit === "ranked_choice" || explicit === "ranked" || explicit === "irv") ballotMethod = "ranked_choice";
  else if (explicit === "plurality" || explicit === "fptp") ballotMethod = "plurality";
  else if (mapped === "RANKED") ballotMethod = "ranked_choice";
  else if (mapped === "SINGLE_CHOICE" || mapped === "MEASURE" || mapped === "ARTICLE") ballotMethod = electionMethod;
  return {
    id: String(q.id ?? q.questionId ?? `q${index}`),
    type: mapped,
    ballotMethod,
    prompt: q.prompt || q.title || q.text || `Question ${index + 1}`,
    description: q.description || q.help || "",
    maxSelections: Number(q.maxSelections ?? q.max ?? (mapped === "MULTI_CHOICE" ? 2 : 1)) || 1,
    options,
  };
}

function questionsOf(election, fallback) {
  const method = String(election?.ballotMethod || "plurality").toLowerCase().replace(/[\s-]+/g, "_");
  const electionMethod = method === "ranked_choice" || method === "ranked" || method === "irv" ? "ranked_choice" : "plurality";
  const q = election?.questions;
  if (Array.isArray(q) && q.length) return q.map((item, i) => normalizeQuestion(item, i, electionMethod));
  return fallback.map((item, i) => normalizeQuestion(item, i, electionMethod));
}

function isRankedQuestion(question) {
  return question.ballotMethod === "ranked_choice" || question.type === "RANKED";
}

function collectAnswers(form, questions, rankingState) {
  const answers = [];
  for (const question of questions) {
    if (isRankedQuestion(question)) {
      const ranking = [...(rankingState.get(question.id) || [])];
      answers.push({
        questionId: question.id,
        type: question.type,
        ballotMethod: "ranked_choice",
        ranking,
      });
      continue;
    }
    if (question.type === "MULTI_CHOICE" && question.maxSelections > 1) {
      const checked = [...form.querySelectorAll(`input[name="${cssName(question.id)}"]:checked`)].map((el) => el.value);
      answers.push({ questionId: question.id, type: question.type, optionIds: checked });
    } else {
      const picked = form.querySelector(`input[name="${cssName(question.id)}"]:checked`);
      answers.push({
        questionId: question.id,
        type: question.type,
        optionIds: picked ? [picked.value] : [],
      });
    }
  }
  return answers;
}

function cssName(id) {
  return `q-${id}`;
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

  const questions = questionsOf(election, sampleQs || SAMPLE_QUESTIONS);
  const rankingState = new Map();
  for (const question of questions) {
    if (isRankedQuestion(question)) rankingState.set(question.id, []);
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
        source === "sample" ? h("span", { class: "status-pill status-created", text: "Sample ballot" }) : null
      ),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, h("span", { class: "lbl", text: "Election id" }), h("span", { text: String(election.id) })),
        h("li", {}, h("span", { class: "lbl", text: "Opens" }), h("span", { text: formatTime(election.startTime) })),
        h("li", {}, h("span", { class: "lbl", text: "Cutoff" }), h("span", { text: formatTime(election.cutoffTime) })),
        election.ballotSpecHash
          ? h("li", {}, h("span", { class: "lbl", text: "Ballot spec" }), h("span", { class: "hex", style: { padding: "0.2rem 0.4rem" }, text: election.ballotSpecHash }))
          : null,
        h(
          "li",
          {},
          h("span", { class: "lbl", text: "Ballot method" }),
          h(
            "span",
            {
              text: questions.some(isRankedQuestion)
                ? "Ranked choice (IRV) on ranked questions; plurality elsewhere"
                : "Plurality (first past the post)",
            }
          )
        )
      ),
      h(
        "p",
        {
          text: "Your selections stay on this form until you submit. After the relay accepts the ballot, this page will not show how you voted.",
        }
      ),
      h(
        "p",
        {},
        h("a", {
          href: `/elections/${encodeURIComponent(election.id)}/info`,
          "data-nav": "",
          text: "Read candidate and measure information (does not record a vote)",
        })
      )
    );
  }

  function optionById(question, id) {
    return question.options.find((o) => String(o.id) === String(id));
  }

  function setRanking(question, next) {
    rankingState.set(question.id, next);
    const mount = document.getElementById(`question-${question.id}`);
    if (mount) mount.replaceWith(questionField(question));
  }

  function rankedField(question) {
    const rankedIds = rankingState.get(question.id) || [];
    const rankedSet = new Set(rankedIds);
    const unranked = question.options.filter((o) => !rankedSet.has(o.id));
    const n = question.options.length;

    function applyRankNumber(optionId, rankValue) {
      const current = (rankingState.get(question.id) || []).filter((id) => id !== optionId);
      if (!rankValue) {
        setRanking(question, current);
        return;
      }
      const rank = Math.max(1, Math.min(n, Number(rankValue)));
      current.splice(rank - 1, 0, optionId);
      setRanking(question, current);
    }

    function rankRow(opt, index, total) {
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
            setRanking(question, list);
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
              value: String(index + 1),
              onChange: (ev) => applyRankNumber(opt.id, ev.target.value),
            },
            ...Array.from({ length: total }, (_, i) =>
              h("option", { value: String(i + 1), text: String(i + 1), selected: i === index })
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
            disabled: index === 0,
            onClick: () => {
              const list = [...(rankingState.get(question.id) || [])];
              if (index <= 0) return;
              [list[index - 1], list[index]] = [list[index], list[index - 1]];
              setRanking(question, list);
            },
          }),
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: "Down",
            disabled: index === total - 1,
            onClick: () => {
              const list = [...(rankingState.get(question.id) || [])];
              if (index >= list.length - 1) return;
              [list[index + 1], list[index]] = [list[index], list[index + 1]];
              setRanking(question, list);
            },
          }),
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: "Remove",
            onClick: () => setRanking(question, (rankingState.get(question.id) || []).filter((id) => id !== opt.id)),
          })
        )
      );
    }

    return h(
      "fieldset",
      { class: "question ranked-question", id: `question-${question.id}` },
      h("legend", { text: question.prompt }),
      question.description ? h("p", { class: "field-hint", text: question.description }) : null,
      h("p", {
        class: "field-hint",
        text: "Rank in order of preference (1 = first choice). Drag to reorder, use rank numbers, or move names from the unranked list. Leaving a name unranked is an undervote on that candidate.",
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
                  onClick: () => setRanking(question, [...(rankingState.get(question.id) || []), opt.id]),
                })
              )
            )
          )
        : null
    );
  }

  function questionField(question) {
    if (isRankedQuestion(question)) return rankedField(question);
    const multi = question.type === "MULTI_CHOICE" && question.maxSelections > 1;
    const inputType = multi ? "checkbox" : "radio";
    return h(
      "fieldset",
      { class: "question", id: `question-${question.id}` },
      h("legend", { text: question.prompt }),
      question.description ? h("p", { class: "field-hint", text: question.description }) : null,
      h("p", { class: "field-hint", text: multi ? `Select up to ${question.maxSelections}.` : "Select one." }),
      h(
        "div",
        { class: "choice-list", role: "group", "aria-label": question.prompt },
        ...question.options.map((opt) =>
          h(
            "div",
            { class: "choice-row" },
            h(
              "label",
              { class: "choice", for: `${cssName(question.id)}-${opt.id}` },
              h("input", {
                id: `${cssName(question.id)}-${opt.id}`,
                name: cssName(question.id),
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
            h("a", {
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
    if (!(question.type === "MULTI_CHOICE" && question.maxSelections > 1)) return;
    const form = event.target.form;
    const boxes = [...form.querySelectorAll(`input[name="${cssName(question.id)}"]`)];
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
      children.push(h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: "Return to elections" })));
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
          h("p", { text: "Polls are closed for this election. You can review the questions; the Node will not accept a new ballot." })
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
                ? "The roll is frozen. Voting has not opened. You may review the sample questions."
                : "This election is not open. Registration may still be available.",
          })
        )
      );
    }

    if (me?.elections?.[election.id]?.status) {
      children.push(h("p", { text: `Node status for you: ${me.elections[election.id].status}.` }));
    }

    children.push(
      h(
        "form",
        { class: "ballot", id: "ballot-form", autocomplete: "off", onSubmit: onSubmit },
        h("h2", { text: "Official ballot" }),
        ...questions.map(questionField),
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
    const answers = collectAnswers(form, questions, rankingState);
    const blank = answers.every((a) => (a.ranking ? a.ranking.length === 0 : a.optionIds.length === 0));
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

    const ballotObject = {
      electionId: String(election.id),
      ballotSpecHash: election.ballotSpecHash || null,
      ballotMethod: election.ballotMethod || (questions.some(isRankedQuestion) ? "ranked_choice" : "plurality"),
      questions: questions.map((q) => ({ id: q.id, type: q.type, ballotMethod: q.ballotMethod })),
      answers,
      markedAt: new Date().toISOString(),
    };
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
        answers,
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
