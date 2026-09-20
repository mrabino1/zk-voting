/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Voter-facing supporting information: punch-list of options, then a mini page
 * per candidate / measure choice (read-only). Choice is never recorded here.
 */

import { t } from "./i18n.js";

function publicOption(raw, index = 0) {
  if (typeof raw === "string" || typeof raw === "number") {
    return { id: `o${index + 1}`, label: String(raw), summary: "", body: "", imageUrl: "", links: [] };
  }
  const obj = raw && typeof raw === "object" ? raw : {};
  const links = Array.isArray(obj.links)
    ? obj.links
        .map((link, i) =>
          typeof link === "string"
            ? { label: t("info.linkN", { n: i + 1 }), url: link }
            : { label: String(link.label || link.title || link.url || ""), url: String(link.url || link.href || "") }
        )
        .filter((link) => /^https?:\/\//i.test(link.url))
    : [];
  const imageUrl = String(obj.imageUrl || obj.image || "");
  return {
    id: String(obj.id ?? obj.value ?? `o${index + 1}`),
    label: String(obj.label || obj.name || t("info.optionFallback", { n: index + 1 })),
    summary: String(obj.summary || obj.blurb || ""),
    body: String(obj.body || obj.description || obj.text || ""),
    imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : "",
    links,
  };
}

function publicQuestions(election) {
  const list = Array.isArray(election?.questions) ? election.questions : [];
  return list.map((q, i) => {
    const type = String(q.type || q.kind || "SINGLE_CHOICE").toUpperCase();
    let options = (q.options || q.choices || []).map((opt, j) => publicOption(opt, j));
    if (type === "YES_NO" && options.length === 0) {
      options = [publicOption({ id: "yes", label: t("ballot.yes") }, 0), publicOption({ id: "no", label: t("ballot.no") }, 1)];
    }
    return {
      id: String(q.id ?? q.questionId ?? `q${i + 1}`),
      type,
      prompt: q.prompt || q.title || q.text || t("info.questionFallback", { n: i + 1 }),
      options,
    };
  });
}

function findQuestion(questions, questionId) {
  const key = String(questionId);
  return questions.find((q, i) => q.id === key || String(i) === key || `q${i + 1}` === key) || null;
}

function findOption(question, optionId) {
  const list = question?.options || [];
  const key = String(optionId);
  return list.find((o, i) => o.id === key || String(i) === key || `o${i + 1}` === key) || null;
}

function optionHasInfo(opt) {
  return Boolean((opt.summary || "").trim() || (opt.body || "").trim() || opt.imageUrl || (opt.links || []).length);
}

function paragraphs(text, h) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  return raw.split(/\n{2,}/).map((block) => h("p", { class: "option-body-p", text: block }));
}

async function loadInfo(api, electionId) {
  try {
    const data = await api(`/api/elections/${encodeURIComponent(electionId)}/info`);
    if (data?.id != null || data?.questions) return { info: data, source: "api" };
  } catch {
    /* fall through to election payload */
  }
  return { info: null, source: "missing" };
}

function crumb(h, election, extra) {
  return h(
    "nav",
    { class: "crumbs", "aria-label": t("info.breadcrumb") },
    h("a", { href: "/", "data-nav": "", text: t("info.elections") }),
    h("span", { "aria-hidden": "true", text: " / " }),
    h("a", { href: `/elections/${encodeURIComponent(election.id)}/info`, "data-nav": "", text: election.title || t("chrome.titleInfo") }),
    extra
      ? [
          h("span", { "aria-hidden": "true", text: " / " }),
          h("span", { text: extra }),
        ]
      : null
  );
}

function header(h, election, formatTime, electionStateInfo, source, lede) {
  const st = electionStateInfo(election.state);
  return h(
    "div",
    { class: "page-head" },
    h("p", { class: "kicker", text: election.jurisdiction || election.jurisdictionId || t("sample.jurisdictionFallback") }),
    h("h1", { text: election.title || t("chrome.titleInfo") }),
    h(
      "p",
      { class: "cluster" },
      h("span", { class: `status-pill ${st.className}`, text: st.label }),
      source === "sample" ? h("span", { class: "status-pill status-created", text: t("info.sample") }) : null
    ),
    h("p", { class: "lede", text: lede }),
    h(
      "ul",
      { class: "meta-list" },
      h("li", {}, h("span", { class: "lbl", text: t("info.electionId") }), h("span", { text: String(election.id) })),
      election.startTime
        ? h("li", {}, h("span", { class: "lbl", text: t("info.opens") }), h("span", { text: formatTime(election.startTime) }))
        : null,
      election.cutoffTime
        ? h("li", {}, h("span", { class: "lbl", text: t("info.cutoff") }), h("span", { text: formatTime(election.cutoffTime) }))
        : null
    )
  );
}

export async function renderElectionInfo(main, ctx) {
  const { h, api, loadElection, formatTime, electionStateInfo, electionId, sampleQuestions } = ctx;
  const [{ election, source }, infoBundle] = await Promise.all([loadElection(electionId), loadInfo(api, electionId)]);
  if (!election) {
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: t("common.electionNotFound") })),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.backToElections") }))
    );
    return;
  }
  const info = infoBundle.info;
  const questionsRaw = info?.questions?.length ? info : election;
  const questions = publicQuestions(questionsRaw);
  const qs = questions.length ? questions : publicQuestions({ questions: sampleQuestions ? sampleQuestions() : [] });

  main.replaceChildren(
    crumb(h, election),
    header(
      h,
      election,
      formatTime,
      electionStateInfo,
      source,
      t("info.lede")
    ),
    qs.length === 0
      ? h("div", { class: "notice notice-warn" }, h("p", { text: t("info.noQuestions") }))
      : h(
          "ol",
          { class: "punch-list" },
          ...qs.map((question) =>
            h(
              "li",
              { class: "punch-section" },
              h("h2", { text: question.prompt }),
              h("p", { class: "field-hint", text: question.type.replace(/_/g, " ") }),
              h(
                "ul",
                { class: "punch-options" },
                ...question.options.map((opt) =>
                  h(
                    "li",
                    { class: "punch-item" },
                    h(
                      "div",
                      { class: "punch-item-body" },
                      h("h3", { text: opt.label }),
                      optionHasInfo(opt)
                        ? h("span", { class: "status-pill status-open", text: t("info.detailsPublished") })
                        : h("span", { class: "status-pill status-created", text: t("info.nameOnly") }),
                      opt.summary ? h("p", { text: opt.summary }) : null,
                      h(
                        "div",
                        { class: "cluster" },
                        h("a", {
                          class: "btn",
                          href: `/elections/${encodeURIComponent(election.id)}/info/${encodeURIComponent(question.id)}/${encodeURIComponent(opt.id)}`,
                          "data-nav": "",
                          text: t("info.openInfo"),
                        }),
                        ...(opt.links || []).slice(0, 2).map((link) =>
                          h("a", {
                            class: "btn btn-secondary",
                            href: link.url,
                            target: "_blank",
                            rel: "noopener noreferrer",
                            text: link.label || t("info.externalPage"),
                          })
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        ),
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: t("info.goBallot") }),
      h("a", { class: "btn btn-secondary", href: "/", "data-nav": "", text: t("common.allElections") })
    )
  );
}

export async function renderOptionInfo(main, ctx) {
  const { h, api, loadElection, formatTime, electionStateInfo, electionId, questionId, optionId } = ctx;
  const [{ election, source }, infoBundle] = await Promise.all([loadElection(electionId), loadInfo(api, electionId)]);
  if (!election) {
    main.replaceChildren(
      h("div", { class: "page-head" }, h("h1", { text: t("common.electionNotFound") })),
      h("p", {}, h("a", { class: "btn", href: "/", "data-nav": "", text: t("common.backToElections") }))
    );
    return;
  }

  let question;
  let option;
  try {
    const mini = await api(
      `/api/elections/${encodeURIComponent(electionId)}/info/${encodeURIComponent(questionId)}/${encodeURIComponent(optionId)}`
    );
    if (mini?.option) {
      question = mini.question;
      option = publicOption(mini.option);
    }
  } catch {
    /* use list payload */
  }
  if (!question || !option) {
    const questions = infoBundle.info?.questions?.length ? publicQuestions(infoBundle.info) : publicQuestions(election);
    question = findQuestion(questions, questionId);
    option = findOption(question, optionId);
  }

  if (!question || !option) {
    main.replaceChildren(
      crumb(h, election),
      h("div", { class: "page-head" }, h("h1", { text: t("info.optionMissing") }), h("p", { text: t("info.optionMissingBody") })),
      h("p", {}, h("a", { class: "btn", href: `/elections/${encodeURIComponent(election.id)}/info`, "data-nav": "", text: t("info.backList") }))
    );
    return;
  }

  main.replaceChildren(
    crumb(h, election, option.label),
    header(
      h,
      election,
      formatTime,
      electionStateInfo,
      source,
      question.prompt
    ),
    h(
      "article",
      { class: "option-mini panel" },
      option.imageUrl
        ? h("img", {
            class: "option-portrait",
            src: option.imageUrl,
            alt: "",
            onError: (ev) => {
              ev.target.hidden = true;
            },
          })
        : null,
      h("p", { class: "kicker", text: t("info.supporting") }),
      h("h2", { text: option.label }),
      option.summary ? h("p", { class: "lede", text: option.summary }) : null,
      option.body
        ? h("div", { class: "option-body" }, ...paragraphs(option.body, h))
        : h("p", { class: "field-hint", text: t("info.noStatement") }),
      option.links?.length
        ? h(
            "section",
            { "aria-labelledby": "ext-links" },
            h("h3", { id: "ext-links", text: t("info.external") }),
            h(
              "ul",
              { class: "ext-links" },
              ...option.links.map((link) =>
                h(
                  "li",
                  {},
                  h("a", {
                    href: link.url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    text: link.label || link.url,
                  })
                )
              )
            )
          )
        : null
    ),
    h(
      "div",
      { class: "toolbar" },
      h("a", { class: "btn btn-secondary", href: `/elections/${encodeURIComponent(election.id)}/info`, "data-nav": "", text: t("info.allOptions") }),
      h("a", { class: "btn", href: `/vote/${encodeURIComponent(election.id)}`, "data-nav": "", text: t("info.goBallot") })
    )
  );
}

export { publicQuestions, publicOption };
