/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Website locale (English default, Spanish optional). Same shape as DealPunchList:
 * supportedLngs en/es, fallback en, persist only in localStorage (no navigator sniff).
 * Smart-contract code and operator documentation stay English.
 */

import en from "./locales/en.js";
import es from "./locales/es.js";

export const SUPPORTED_LOCALES = ["en", "es"];
export const DEFAULT_LOCALE = "en";
export const STORAGE_KEY = "republic_lang";
export const LOCALE_EVENT = "republic:locale";

const CATALOGS = { en, es };

let currentLocale = DEFAULT_LOCALE;
const listeners = new Set();

export function isSupportedLocale(code) {
  return typeof code === "string" && SUPPORTED_LOCALES.includes(code);
}

function readStoredLocale() {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_LOCALE;
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSupportedLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

currentLocale = readStoredLocale();

function lookup(dict, key) {
  if (!dict || !key) return undefined;
  const parts = String(key).split(".");
  let cur = dict;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    vars[name] == null ? match : String(vars[name])
  );
}

export function getLocale() {
  return isSupportedLocale(currentLocale) ? currentLocale : DEFAULT_LOCALE;
}

export function localeTag() {
  return getLocale() === "es" ? "es" : "en";
}

export function t(key, vars) {
  const locale = getLocale();
  let template;
  if (vars && vars.count === 1) {
    template = lookup(CATALOGS[locale], `${key}_one`) || lookup(CATALOGS.en, `${key}_one`);
  }
  if (template == null) {
    template = lookup(CATALOGS[locale], key) || lookup(CATALOGS.en, key);
  }
  if (template == null) return key;
  return interpolate(template, vars);
}

export function applyDocumentLang(locale = getLocale()) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
}

const ATTR_MAP = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-alt", "alt"],
  ["data-i18n-content", "content"],
];

export function applyStatic(root) {
  if (typeof document === "undefined") return;
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = t(key);
  });
  scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (!key) return;
    el.innerHTML = t(key);
  });
  for (const [dataAttr, attr] of ATTR_MAP) {
    scope.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
      const key = el.getAttribute(dataAttr);
      if (key) el.setAttribute(attr, t(key));
    });
  }
}

export function onLocaleChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist(locale) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}

function notify(locale) {
  applyDocumentLang(locale);
  applyStatic();
  mountLanguageSwitcher();
  for (const fn of listeners) {
    try {
      fn(locale);
    } catch {
      /* listener errors must not break switching */
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: { locale } }));
  }
}

export function setLocale(code) {
  const next = isSupportedLocale(code) ? code : DEFAULT_LOCALE;
  if (next === currentLocale) {
    persist(next);
    applyDocumentLang(next);
    mountLanguageSwitcher();
    return next;
  }
  currentLocale = next;
  persist(next);
  notify(next);
  return next;
}

export function flattenKeys(dict, prefix = "") {
  const keys = [];
  if (!dict || typeof dict !== "object") return keys;
  for (const [name, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (value && typeof value === "object") keys.push(...flattenKeys(value, path));
    else if (typeof value === "string") keys.push(path);
  }
  return keys;
}

export function catalogs() {
  return CATALOGS;
}

function flagEnglish() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="19" height="10" fill="#B22234"/>
    <rect y="1" width="19" height="1" fill="#FFFFFF"/>
    <rect y="3" width="19" height="1" fill="#FFFFFF"/>
    <rect y="5" width="19" height="1" fill="#FFFFFF"/>
    <rect y="7" width="19" height="1" fill="#FFFFFF"/>
    <rect y="9" width="19" height="1" fill="#FFFFFF"/>
    <rect width="8" height="5.385" fill="#3C3B6E"/>
    <circle cx="0.9" cy="0.9" r="0.35" fill="#FFFFFF"/>
    <circle cx="3.8" cy="0.9" r="0.35" fill="#FFFFFF"/>
    <circle cx="6.7" cy="0.9" r="0.35" fill="#FFFFFF"/>
    <circle cx="0.9" cy="2.5" r="0.35" fill="#FFFFFF"/>
    <circle cx="3.8" cy="2.5" r="0.35" fill="#FFFFFF"/>
    <circle cx="6.7" cy="2.5" r="0.35" fill="#FFFFFF"/>
    <circle cx="0.9" cy="4.1" r="0.35" fill="#FFFFFF"/>
    <circle cx="3.8" cy="4.1" r="0.35" fill="#FFFFFF"/>
    <circle cx="6.7" cy="4.1" r="0.35" fill="#FFFFFF"/>
  `;
  return svg;
}

function flagSpanish() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const uid = `lang${Math.random().toString(36).slice(2, 8)}`;
  const spain = `flag-clip-spain-${uid}`;
  const mexico = `flag-clip-mexico-${uid}`;
  svg.innerHTML = `
    <defs>
      <clipPath id="${spain}"><polygon points="0,0 19,0 0,10"/></clipPath>
      <clipPath id="${mexico}"><polygon points="19,0 19,10 0,10"/></clipPath>
    </defs>
    <g clip-path="url(#${spain})">
      <rect width="19" height="10" fill="#AA151B"/>
      <rect y="2.5" width="19" height="5" fill="#F1BF00"/>
    </g>
    <g clip-path="url(#${mexico})">
      <rect width="6.333" height="10" fill="#006847"/>
      <rect x="6.333" width="6.334" height="10" fill="#FFFFFF"/>
      <rect x="12.667" width="6.333" height="10" fill="#CE1126"/>
    </g>
    <line x1="19" y1="0" x2="0" y2="10" stroke="rgba(0,0,0,0.35)" stroke-width="0.35"/>
  `;
  return svg;
}

function flagButton(locale, label, flag) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lang-flag";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  btn.setAttribute("aria-pressed", getLocale() === locale ? "true" : "false");
  btn.dataset.testid = `language-flag-${label.toLowerCase()}`;
  btn.dataset.locale = locale;
  btn.append(flag());
  btn.addEventListener("click", () => {
    setLocale(locale);
  });
  return btn;
}

export function mountLanguageSwitcher(root) {
  if (typeof document === "undefined") return null;
  const host = root || document.getElementById("lang-switcher");
  if (!host) return null;
  host.classList.add("lang-switcher");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", t("lang.group"));
  host.replaceChildren(
    flagButton("en", t("lang.english"), flagEnglish),
    flagButton("es", t("lang.spanish"), flagSpanish)
  );
  return host;
}

export function bootI18n() {
  currentLocale = readStoredLocale();
  applyDocumentLang(currentLocale);
  applyStatic();
  mountLanguageSwitcher();
}

export function resetLocaleForTests(locale = DEFAULT_LOCALE) {
  currentLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
}

export const RepublicI18n = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  STORAGE_KEY,
  LOCALE_EVENT,
  t,
  getLocale,
  setLocale,
  localeTag,
  applyStatic,
  applyDocumentLang,
  mountLanguageSwitcher,
  onLocaleChange,
  bootI18n,
  flattenKeys,
  catalogs,
  isSupportedLocale,
};

if (typeof window !== "undefined") {
  window.RepublicI18n = RepublicI18n;
  applyDocumentLang(currentLocale);
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootI18n, { once: true });
    } else {
      bootI18n();
    }
  }
}
