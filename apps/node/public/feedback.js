/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Public /feedback form. Copy comes from the locale catalog.
 */

import { getLocale, localeTag, onLocaleChange, t } from "./i18n.js";

const CATEGORY_KEYS = {
  general: "feedback.categoryGeneral",
  accessibility: "feedback.categoryAccessibility",
  privacy: "feedback.categoryPrivacy",
  defect: "feedback.categoryDefect",
  suggestion: "feedback.categorySuggestion",
};

let stopLocale = null;

function fieldError(errors, id) {
  return (errors || []).find((item) => item.id === id) || null;
}

export function renderFeedback(main, ctx) {
  const { h, api, announce } = ctx;
  if (stopLocale) stopLocale();

  const startedAt = Date.now();
  const draft = {
    name: "",
    replyTo: "",
    category: "",
    message: "",
    assignmentAccepted: false,
    website: "",
  };
  let meta = null;
  let loadError = "";
  let errors = [];
  let summary = "";
  let busy = false;
  let done = false;

  function readDraft(form) {
    if (!form) return;
    draft.name = form.elements.name?.value || "";
    draft.replyTo = form.elements.replyTo?.value || "";
    draft.category = form.elements.category?.value || "";
    draft.message = form.elements.message?.value || "";
    draft.assignmentAccepted = Boolean(form.elements.assignmentAccepted?.checked);
    draft.website = form.elements.website?.value || "";
  }

  function localErrors() {
    const next = [];
    if (!draft.category) {
      next.push({ id: "feedback-category", message: t("feedback.required") });
    }
    if (!String(draft.message || "").trim()) {
      next.push({ id: "feedback-message", message: t("feedback.required") });
    }
    if (!draft.assignmentAccepted) {
      next.push({ id: "feedback-assignment", message: t("feedback.assignmentLabel") });
    }
    return next;
  }

  function applyServerError(err) {
    const data = err?.data || {};
    const code = data.code || "";
    if (err?.status === 429 || code === "RATE_LIMITED") {
      const minutes = Number(data.minutes) || 60;
      summary = t("feedback.retryIn", { count: minutes, minutes });
      errors = [];
      return;
    }
    if (code === "FEEDBACK_UNAVAILABLE" || err?.status === 503) {
      summary = t("feedback.unavailable");
      errors = [];
      return;
    }
    if (code === "TOO_FAST") {
      summary = t("feedback.tooFast");
      errors = [];
      return;
    }
    if (code === "PAYLOAD_TOO_LARGE") {
      summary = t("feedback.tooLarge");
      errors = [{ id: "feedback-message", message: t("feedback.tooLarge") }];
      return;
    }
    if (code === "HONEYPOT") {
      summary = t("feedback.rejected");
      errors = [];
      return;
    }
    const serverFields = Array.isArray(data.fields) ? data.fields : [];
    if (serverFields.length) {
      summary = t("feedback.errorSummary");
      errors = serverFields.map((item) => ({
        id: item.id,
        message: item.message || t("feedback.required"),
      }));
      return;
    }
    summary = data.error || err?.message || t("feedback.rejected");
    errors = [];
  }

  function paint() {
    const lang = localeTag(getLocale());
    const inboxOff = meta && meta.inboxConfigured === false;
    const nameErr = fieldError(errors, "feedback-name");
    const emailErr = fieldError(errors, "feedback-email");
    const categoryErr = fieldError(errors, "feedback-category");
    const messageErr = fieldError(errors, "feedback-message");
    const assignErr = fieldError(errors, "feedback-assignment");
    const described = (id, hintId, err) => [hintId, err ? `${id}-error` : ""].filter(Boolean).join(" ");

    main.replaceChildren(
      h(
        "div",
        { class: "page-head", lang },
        h("p", { class: "kicker", text: t("feedback.kicker") }),
        h("h1", { text: t("feedback.title") }),
        h("p", { class: "lede", text: t("feedback.lede") }),
      ),
      done
        ? h(
            "div",
            { class: "notice notice-ok", role: "status", lang },
            h("p", { text: t("feedback.success") }),
          )
        : h(
            "form",
            {
              class: "panel feedback-form",
              id: "feedback-form",
              lang,
              novalidate: true,
              onsubmit: async (event) => {
                event.preventDefault();
                readDraft(event.currentTarget);
                const clientErrors = localErrors();
                if (clientErrors.length) {
                  errors = clientErrors;
                  summary = t("feedback.errorSummary");
                  announce(summary);
                  paint();
                  return;
                }
                busy = true;
                errors = [];
                summary = "";
                paint();
                try {
                  await api("/api/feedback", {
                    method: "POST",
                    body: {
                      name: draft.name,
                      replyTo: draft.replyTo,
                      category: draft.category,
                      message: draft.message,
                      assignmentAccepted: draft.assignmentAccepted,
                      website: draft.website,
                      startedAt,
                    },
                  });
                  done = true;
                  errors = [];
                  summary = "";
                  announce(t("feedback.success"));
                } catch (err) {
                  applyServerError(err);
                  announce(summary || t("feedback.rejected"));
                } finally {
                  busy = false;
                  paint();
                }
              },
            },
            summary
              ? h(
                  "div",
                  {
                    class: "notice notice-error",
                    id: "feedback-errors",
                    role: "alert",
                    tabindex: "-1",
                  },
                  h("p", { id: "feedback-errors-title", text: summary }),
                  errors.length
                    ? h(
                        "ul",
                        {},
                        ...errors.map((item) =>
                          h(
                            "li",
                            {},
                            h("a", { href: `#${item.id}`, text: item.message }),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
            inboxOff
              ? h(
                  "div",
                  { class: "notice notice-warn", role: "status" },
                  h("p", { text: t("feedback.unavailable") }),
                )
              : null,
            loadError ? h("p", { class: "notice notice-error", role: "alert", text: loadError }) : null,
            h(
              "div",
              { class: "hp-field", "aria-hidden": "true" },
              h("label", { for: "feedback-website", text: "Website" }),
              h("input", {
                id: "feedback-website",
                name: "website",
                type: "text",
                tabindex: "-1",
                autocomplete: "off",
                value: draft.website,
              }),
            ),
            h(
              "label",
              { class: "field", for: "feedback-name" },
              t("feedback.nameLabel"),
              h("input", {
                id: "feedback-name",
                name: "name",
                type: "text",
                autocomplete: "name",
                maxlength: "120",
                value: draft.name,
                "aria-invalid": nameErr ? "true" : "false",
                "aria-describedby": nameErr ? "feedback-name-error" : null,
              }),
              nameErr ? h("span", { class: "field-error", id: "feedback-name-error", text: nameErr.message }) : null,
            ),
            h(
              "label",
              { class: "field", for: "feedback-email" },
              t("feedback.emailLabel"),
              h("span", { class: "field-hint", id: "feedback-email-hint", text: t("feedback.emailHint") }),
              h("input", {
                id: "feedback-email",
                name: "replyTo",
                type: "email",
                autocomplete: "email",
                value: draft.replyTo,
                "aria-invalid": emailErr ? "true" : "false",
                "aria-describedby": described("feedback-email", "feedback-email-hint", emailErr),
              }),
              emailErr ? h("span", { class: "field-error", id: "feedback-email-error", text: emailErr.message }) : null,
            ),
            h(
              "label",
              { class: "field", for: "feedback-category" },
              t("feedback.categoryLabel"),
              h(
                "select",
                {
                  id: "feedback-category",
                  name: "category",
                  required: true,
                  "aria-invalid": categoryErr ? "true" : "false",
                  "aria-describedby": categoryErr ? "feedback-category-error" : null,
                },
                h("option", { value: "", text: t("feedback.categoryPlaceholder") }),
                ...Object.entries(CATEGORY_KEYS).map(([value, key]) =>
                  h("option", { value, selected: draft.category === value, text: t(key) }),
                ),
              ),
              categoryErr
                ? h("span", { class: "field-error", id: "feedback-category-error", text: categoryErr.message })
                : null,
            ),
            h(
              "label",
              { class: "field", for: "feedback-message" },
              t("feedback.messageLabel"),
              h("span", { class: "field-hint", id: "feedback-message-hint", text: t("feedback.messageHint") }),
              h("textarea", {
                id: "feedback-message",
                name: "message",
                required: true,
                rows: "8",
                maxlength: "4000",
                value: draft.message,
                "aria-invalid": messageErr ? "true" : "false",
                "aria-describedby": described("feedback-message", "feedback-message-hint", messageErr),
              }),
              messageErr
                ? h("span", { class: "field-error", id: "feedback-message-error", text: messageErr.message })
                : null,
            ),
            h(
              "div",
              { class: "check-row" },
              h("input", {
                id: "feedback-assignment",
                name: "assignmentAccepted",
                type: "checkbox",
                required: true,
                checked: draft.assignmentAccepted,
                "aria-invalid": assignErr ? "true" : "false",
                "aria-describedby": "feedback-assignment-hint",
              }),
              h(
                "label",
                { for: "feedback-assignment" },
                t("feedback.assignmentLabel"),
                h("span", { class: "field-hint", id: "feedback-assignment-hint", text: t("feedback.assignmentHint") }),
                " ",
                h("a", { href: "/terms", "data-nav": "", text: t("feedback.termsLink") }),
              ),
            ),
            assignErr
              ? h("p", { class: "field-error", id: "feedback-assignment-error", text: assignErr.message })
              : null,
            h(
              "div",
              { class: "toolbar" },
              h("button", {
                class: "btn",
                type: "submit",
                disabled: busy || inboxOff,
                text: busy ? t("feedback.submitting") : t("feedback.submit"),
              }),
            ),
          ),
    );
    document.title = `${t("feedback.title")} — Republic`;
    const summaryNode = main.querySelector("#feedback-errors");
    if (summaryNode) summaryNode.focus();
  }

  stopLocale = onLocaleChange(() => {
    if (!main.isConnected) {
      stopLocale();
      stopLocale = null;
      return;
    }
    readDraft(main.querySelector("#feedback-form"));
    paint();
  });

  paint();
  api("/api/feedback")
    .then((data) => {
      meta = data;
      if (data && data.inboxConfigured === false) announce(t("feedback.unavailable"));
      readDraft(main.querySelector("#feedback-form"));
      paint();
    })
    .catch((err) => {
      loadError = err.message || t("feedback.rejected");
      readDraft(main.querySelector("#feedback-form"));
      paint();
    });
}
