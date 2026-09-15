/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Shared ballot / aspect helpers for the voter SPA (authoring lives in back-office).
 */

export const QUESTION_TYPE_LABELS = {
  YES_NO: "Yes / No",
  SINGLE_CHOICE: "Single choice",
  MULTI_CHOICE: "Multi choice",
  MEASURE: "Measure",
  ARTICLE: "Article",
  RANKED: "Ranked choice",
};

const TYPE_ALIASES = {
  YES_NO: "YES_NO",
  YN: "YES_NO",
  REFERENDUM: "YES_NO",
  SINGLE_CHOICE: "SINGLE_CHOICE",
  SINGLE: "SINGLE_CHOICE",
  PLURALITY: "SINGLE_CHOICE",
  OFFICE: "SINGLE_CHOICE",
  MULTI_CHOICE: "MULTI_CHOICE",
  MULTI: "MULTI_CHOICE",
  MEASURE: "MEASURE",
  ARTICLE: "ARTICLE",
  RANKED: "RANKED",
  RANKED_CHOICE: "RANKED",
  IRV: "RANKED",
  RCV: "RANKED",
};

export function canonicalQuestionType(raw) {
  const key = String(raw || "SINGLE_CHOICE")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return TYPE_ALIASES[key] || "SINGLE_CHOICE";
}

export function isRankedType(type) {
  return canonicalQuestionType(type) === "RANKED";
}

export function isRankedQuestion(question) {
  if (!question) return false;
  if (isRankedType(question.type)) return true;
  const method = String(question.ballotMethod || "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return method === "ranked_choice" || method === "ranked" || method === "irv";
}

export function isMultiSelect(question) {
  return question.type === "MULTI_CHOICE" && Number(question.maxSelections) > 1;
}

export function typeLabel(type) {
  const t = canonicalQuestionType(type);
  return QUESTION_TYPE_LABELS[t] || t;
}

export function normalizeQuestion(q, index = 0) {
  const type = canonicalQuestionType(q?.type || q?.kind);
  const options = (q?.options || q?.choices || []).map((opt, i) =>
    typeof opt === "string" || typeof opt === "number"
      ? { id: String(opt).toLowerCase().replace(/[^a-z0-9]+/g, "-") || String(i), label: String(opt) }
      : {
          id: String(opt.id ?? opt.value ?? i),
          label: opt.label || opt.name || String(opt.id ?? i),
          summary: opt.summary || opt.blurb || "",
          body: opt.body || "",
          imageUrl: opt.imageUrl || opt.image || "",
          links: Array.isArray(opt.links) ? opt.links : [],
        }
  );
  if ((type === "YES_NO" || type === "MEASURE" || type === "ARTICLE") && options.length === 0) {
    options.push({ id: "yes", label: "Yes" }, { id: "no", label: "No" });
  }
  let maxSelections = Number(q?.maxSelections ?? q?.max ?? (type === "MULTI_CHOICE" ? 2 : 1)) || 1;
  if (type === "RANKED") maxSelections = options.length || 1;
  if (type !== "MULTI_CHOICE" && type !== "RANKED") maxSelections = 1;
  return {
    id: String(q?.id ?? q?.questionId ?? q?.aspectId ?? `q${index + 1}`),
    type,
    prompt: q?.prompt || q?.title || q?.text || `Question ${index + 1}`,
    description: q?.description || q?.help || "",
    maxSelections,
    ballotMethod: q?.ballotMethod || (type === "RANKED" ? "ranked_choice" : "plurality"),
    options,
  };
}

export function questionsOf(election) {
  const raw = election?.questions || election?.aspects || election?.ballot?.questions || [];
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.map((q, i) => normalizeQuestion(q, i));
}

export function cssQuestionName(id) {
  return `q-${id}`;
}

export function collectAnswers(form, questions) {
  const answers = [];
  for (const question of questions) {
    if (isRankedQuestion(question)) {
      const list = form.querySelector(`#question-${question.id} .rank-list`);
      const ranking = list
        ? [...list.querySelectorAll(".rank-row[data-option-id]")].map((el) => String(el.dataset.optionId || "")).filter(Boolean)
        : [];
      if (!ranking.length) {
        const optionIds = [];
        const seen = new Set();
        for (let i = 0; i < question.options.length; i += 1) {
          const sel = form.querySelector(`[name="${cssQuestionName(question.id)}-rank-${i}"]`);
          const value = sel && sel.value ? String(sel.value) : "";
          if (!value || seen.has(value)) continue;
          seen.add(value);
          optionIds.push(value);
        }
        answers.push({ questionId: question.id, type: question.type, ranking: optionIds, optionIds });
        continue;
      }
      answers.push({ questionId: question.id, type: question.type, ranking, optionIds: ranking });
      continue;
    }
    if (isMultiSelect(question)) {
      const checked = [...form.querySelectorAll(`input[name="${cssQuestionName(question.id)}"]:checked`)].map(
        (el) => el.value
      );
      answers.push({ questionId: question.id, type: question.type, optionIds: checked });
    } else {
      const picked = form.querySelector(`input[name="${cssQuestionName(question.id)}"]:checked`);
      answers.push({
        questionId: question.id,
        type: question.type,
        optionIds: picked ? [picked.value] : [],
      });
    }
  }
  return answers;
}

export function buildBallotObject({ electionId, ballotSpecHash, questions, answers, markedAt }) {
  return {
    electionId: String(electionId),
    ballotSpecHash: ballotSpecHash || null,
    questions: (questions || []).map((q) => ({ id: q.id, type: q.type })),
    answers,
    markedAt: markedAt || new Date().toISOString(),
  };
}

export function labeledTally(election) {
  const tally = election?.tally;
  if (!tally) return null;
  if (Array.isArray(tally.questions) && tally.questions.length) return tally;
  const questions = questionsOf(election);
  const flat = Array.isArray(tally.counts) ? tally.counts.map((n) => Number(n)) : [];
  if (!questions.length) {
    return { ...tally, questions: [], counts: flat };
  }
  let offset = 0;
  const labeled = questions.map((q, index) => {
    if (q.type === "RANKED" || q.ballotMethod === "ranked_choice") {
      const stored = Array.isArray(tally.questions)
        ? tally.questions.find((row) => String(row.questionId || row.id) === String(q.id))
        : null;
      if (stored && (stored.tallied === true || stored.winner != null || Array.isArray(stored.rounds))) {
        const first = stored.rounds?.[0]?.counts || null;
        return {
          index,
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          tallied: true,
          tallyMethod: "irv",
          ballotMethod: "ranked_choice",
          winner: stored.winner || null,
          winnerLabel: stored.winnerLabel || stored.winner || null,
          rounds: stored.rounds || [],
          tieBroken: Boolean(stored.tieBroken),
          options: q.options.map((o) => ({ ...o, count: first ? Number(first[o.id]) || 0 : null })),
          undervotes: stored.exhausted ?? null,
        };
      }
      return {
        index,
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        tallied: false,
        tallyMethod: "irv",
        note: stored?.note || "Ranked-choice / IRV was not computed for this question.",
        options: q.options.map((o) => ({ ...o, count: null })),
        undervotes: null,
      };
    }
    const slice = flat.slice(offset, offset + q.options.length);
    offset += q.options.length;
    const sum = slice.reduce((a, b) => a + b, 0);
    const accepted = Number(election.acceptedBallots) || 0;
    return {
      index,
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      tallied: true,
      tallyMethod: "plurality",
      counts: slice,
      undervotes: q.type === "MULTI_CHOICE" ? null : Math.max(0, accepted - sum),
      options: q.options.map((o, i) => ({ ...o, count: Number(slice[i]) || 0 })),
    };
  });
  return { ...tally, counts: flat, questions: labeled };
}
