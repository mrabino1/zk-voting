/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Public /feedback form. The message is emailed to the platform operator.
 * It is not a ballot and it is not stored on this page after send.
 */

import { applyDocumentLang, getLocale, onLocaleChange, t } from "./i18n.js";

const CODE_KEYS = {
  FEEDBACK_OWNERSHIP_REQUIRED: "feedback.errOwnership",
  FEEDBACK_CATEGORY: "feedback.errCategory",
  FEEDBACK_MESSAGE: "feedback.errMessage",
  FEEDBACK_MESSAGE_LENGTH: "feedback.errMessageLength",
  FEEDBACK_EMAIL: "feedback.errEmail",
  FEEDBACK_NAME: "feedback.errName",
  FEEDBACK_TOO_FAST: "feedback.errTooFast",
  FEEDBACK_RATE_LIMIT: "feedback.errRate",
  FEEDBACK_NOT_CONFIGURED: "feedback.errUnavailable",
  FEEDBACK_SES_UNAVAILABLE: "feedback.errUnavailable",
  FEEDBACK_BODY: "feedback.errBody",
  HONEYPOT: "feedback.errGeneric",
};

function fieldError(id, message) {
  return { id, message };
}

export async function renderFeedback(main, ctx) {
  const { h, api, announce, setTitle, me } = ctx;
  const startedAt = Date.now();
  let status = null;
  let loadError = "";
  try {
    status = await api("/api/feedback");
  } catch (err) {
    loadError = err.message || t("feedback.errGeneric");
  }

  const max = Number(status?.maxMessageChars || 4000);
  let errors = [];
  let info = "";
  let busy = false;
  let values = { name: "", email: "", category: "", message: "", ownership: false, website: "" };

  function markLocalized() {
    main.dataset.pageLang = "locale";
    if (getLocale() !== "en") applyDocumentLang();
    else main.removeAttribute("lang");
  }

  function readForm() {
    const form = main.querySelector("#feedback-form");
    if (!form) return;
    const data = new FormData(form);
    values = {
      name: String(data.get("name") || ""),
      email: String(data.get("email") || ""),
      category: String(data.get("category") || ""),
      message: String(data.get("message") || ""),
      ownership: data.get("ownershipAccepted") === "on" || data.get("ownershipAccepted") === "true",
      website: String(data.get("website") || ""),
    };
  }

  function clientErrors() {
    const found = [];
    if (!values.ownership) found.push(fieldError("feedback-ownership", t("feedback.errOwnership")));
    if (!values.category) found.push(fieldError("feedback-category", t("feedback.errCategory")));
    const message = values.message.trim();
    if (!message) found.push(fieldError("feedback-message", t("feedback.errMessage")));
    else if (message.length > max) found.push(fieldError("feedback-message", t("feedback.errMessageLength")));
    if (values.name.trim().length > 80) found.push(fieldError("feedback-name", t("feedback.errName")));
    if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
      found.push(fieldError("feedback-email", t("feedback.errEmail")));
    }
    return found;
  }

  function describedBy(id, hintId) {
    const bad = errors.some((item) => item.id === id);
    return bad ? `${hintId} ${id}-error` : hintId;
  }

  function paint() {
    setTitle(t("feedback.title"));
    const operator = Boolean(me?.user && (me.user.role === "platform_admin" || me.user.role === "platform_super_admin"));
    const warning = status?.operatorWarning && operator ? status.operatorWarning : "";
    const unavailable = status && status.deliveryConfigured === false;
    main.replaceChildren(
      h(
        "div",
        { class: "page-head" },
        h("p", { class: "kicker", "data-i18n": "feedback.kicker", text: t("feedback.kicker") }),
        h("h1", { id: "feedback-heading", "data-i18n": "feedback.title", text: t("feedback.title") }),
        h("p", { class: "lede", "data-i18n": "feedback.lede", text: t("feedback.lede") })
      ),
      loadError
        ? h("div", { class: "notice notice-error", role: "alert" }, h("p", { text: loadError }))
        : null,
      warning
        ? h(
            "div",
            { class: "notice notice-warn", role: "alert" },
            h("p", { "data-i18n": "feedback.operatorWarning", text: t("feedback.operatorWarning") })
          )
        : null,
      unavailable
        ? h(
            "div",
            { class: "notice notice-warn", role: "status" },
            h("p", { "data-i18n": "feedback.unavailableNotice", text: t("feedback.unavailableNotice") })
          )
        : null,
      info
        ? h(
            "div",
            { class: "notice notice-ok", role: "status", tabindex: "-1", id: "feedback-success" },
            h("p", { "data-i18n": "feedback.success", text: t("feedback.success") })
          )
        : null,
      errors.length
        ? h(
            "div",
            {
              class: "notice notice-error feedback-errors",
              role: "alert",
              tabindex: "-1",
              id: "feedback-errors",
              "aria-labelledby": "feedback-errors-title",
            },
            h("h2", { id: "feedback-errors-title", "data-i18n": "feedback.errorsTitle", text: t("feedback.errorsTitle") }),
            h(
              "ul",
              {},
              ...errors.map((item) =>
                h("li", {}, h("a", { href: `#${item.id}`, text: item.message }))
              )
            )
          )
        : null,
      h(
        "form",
        { class: "panel stack", id: "feedback-form", novalidate: true, "aria-labelledby": "feedback-heading", onSubmit: onSubmit },
        h(
          "div",
          { class: "feedback-hp", inert: true },
          h("label", { for: "feedback-website", text: t("feedback.honeypot") }),
          h("input", {
            id: "feedback-website",
            name: "website",
            type: "text",
            tabindex: "-1",
            autocomplete: "off",
            value: "",
          })
        ),
        labeled("feedback-name", "feedback.name", "feedback.nameHint", "text", {
          name: "name",
          autocomplete: "name",
          maxlength: "80",
          value: values.name,
        }),
        labeled("feedback-email", "feedback.email", "feedback.emailHint", "email", {
          name: "email",
          autocomplete: "email",
          maxlength: "254",
          value: values.email,
        }),
        h(
          "div",
          {},
          h("label", { class: "field", for: "feedback-category", "data-i18n": "feedback.category", text: t("feedback.category") }),
          h(
            "select",
            {
              id: "feedback-category",
              name: "category",
              required: true,
              "aria-required": "true",
              "aria-invalid": errors.some((item) => item.id === "feedback-category") ? "true" : "false",
              "aria-describedby": describedBy("feedback-category", "feedback-category-hint"),
            },
            h("option", { value: "", text: t("feedback.categoryPlaceholder") }),
            ...["general", "accessibility", "privacy", "defect", "suggestion", "other"].map((key) => {
              const labelKey = {
                general: "feedback.categoryGeneral",
                accessibility: "feedback.categoryAccessibility",
                privacy: "feedback.categoryPrivacy",
                defect: "feedback.categoryDefect",
                suggestion: "feedback.categorySuggestion",
                other: "feedback.categoryOther",
              }[key];
              return h("option", { value: key, selected: values.category === key, text: t(labelKey) });
            })
          ),
          h("span", { class: "field-hint", id: "feedback-category-hint", text: t("feedback.requiredMark") }),
          inlineError("feedback-category")
        ),
        h(
          "div",
          {},
          h("label", { class: "field", for: "feedback-message", "data-i18n": "feedback.message", text: t("feedback.message") }),
          h("textarea", {
            id: "feedback-message",
            name: "message",
            required: true,
            "aria-required": "true",
            rows: "8",
            maxlength: String(max),
            "aria-invalid": errors.some((item) => item.id === "feedback-message") ? "true" : "false",
            "aria-describedby": describedBy("feedback-message", "feedback-message-hint"),
            text: values.message,
          }),
          h("span", {
            class: "field-hint",
            id: "feedback-message-hint",
            text: t("feedback.messageHint", { max: String(max) }),
          }),
          inlineError("feedback-message")
        ),
        h(
          "div",
          { class: "check-row" },
          h("input", {
            type: "checkbox",
            id: "feedback-ownership",
            name: "ownershipAccepted",
            value: "true",
            required: true,
            "aria-required": "true",
            checked: values.ownership ? true : undefined,
            "aria-invalid": errors.some((item) => item.id === "feedback-ownership") ? "true" : "false",
            "aria-describedby": describedBy("feedback-ownership", "feedback-ownership-hint"),
          }),
          h("label", { for: "feedback-ownership", "data-i18n": "feedback.ownership", text: t("feedback.ownership") })
        ),
        h(
          "p",
          { class: "field-hint", id: "feedback-ownership-hint" },
          h("span", { "data-i18n": "feedback.ownershipHint", text: t("feedback.ownershipHint") }),
          " ",
          h("a", { href: "/terms", "data-nav": "", "data-i18n": "feedback.termsLink", text: t("feedback.termsLink") })
        ),
        inlineError("feedback-ownership"),
        h(
          "div",
          { class: "toolbar" },
          h("button", {
            class: "btn",
            type: "submit",
            disabled: busy,
            "data-i18n": "feedback.submit",
            text: busy ? t("feedback.submitting") : t("feedback.submit"),
          })
        )
      )
    );
    markLocalized();
    if (errors.length) main.querySelector("#feedback-errors")?.focus();
    else if (info) main.querySelector("#feedback-success")?.focus();
  }

  function labeled(id, labelKey, hintKey, type, attrs) {
    const bad = errors.some((item) => item.id === id);
    return h(
      "div",
      {},
      h("label", { class: "field", for: id, "data-i18n": labelKey, text: t(labelKey) }),
      h("input", {
        id,
        type,
        "aria-invalid": bad ? "true" : "false",
        "aria-describedby": describedBy(id, `${id}-hint`),
        ...attrs,
      }),
      h("span", { class: "field-hint", id: `${id}-hint`, "data-i18n": hintKey, text: t(hintKey) }),
      inlineError(id)
    );
  }

  function inlineError(id) {
    const hit = errors.find((item) => item.id === id);
    if (!hit) return null;
    return h("span", { class: "field-error", id: `${id}-error`, text: hit.message });
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    readForm();
    errors = clientErrors();
    info = "";
    if (errors.length) {
      paint();
      announce(t("feedback.errorsTitle"));
      return;
    }
    busy = true;
    paint();
    try {
      await api("/api/feedback", {
        method: "POST",
        body: {
          name: values.name.trim(),
          email: values.email.trim(),
          category: values.category,
          message: values.message.trim(),
          ownershipAccepted: true,
          startedAt,
          website: values.website,
        },
      });
      values = { name: "", email: "", category: "", message: "", ownership: false, website: "" };
      info = t("feedback.success");
      errors = [];
      announce(info);
    } catch (err) {
      const code = err.data?.code;
      const key = CODE_KEYS[code];
      const message = key ? t(key) : t("feedback.errGeneric");
      const id =
        code === "FEEDBACK_OWNERSHIP_REQUIRED"
          ? "feedback-ownership"
          : code === "FEEDBACK_CATEGORY"
            ? "feedback-category"
            : code === "FEEDBACK_EMAIL"
              ? "feedback-email"
              : code === "FEEDBACK_NAME"
                ? "feedback-name"
                : "feedback-message";
      errors = [fieldError(id, message)];
      if (code === "FEEDBACK_NOT_CONFIGURED" || code === "FEEDBACK_SES_UNAVAILABLE") {
        status = { ...(status || {}), deliveryConfigured: false, operatorWarning: err.data?.operatorWarning || status?.operatorWarning };
      }
      announce(message);
    } finally {
      busy = false;
      paint();
    }
  }

  paint();
  const stop = onLocaleChange(() => {
    readForm();
    paint();
  });
  const observer = new MutationObserver(() => {
    if (!main.querySelector("#feedback-form") && !main.querySelector("#feedback-heading")) {
      stop();
      observer.disconnect();
    }
  });
  observer.observe(main, { childList: true });
}
