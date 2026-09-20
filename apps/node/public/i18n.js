/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Website locale (English default). Optional Spanish, Chinese, Tagalog, and
 * Vietnamese — ACS ranks 2–5 for languages spoken at home in the United States.
 * Same shape as DealPunchList: fallback en, persist only in localStorage
 * (no navigator sniff). Smart-contract code and operator documentation stay English.
 */

import en from "./locales/en.js";
import es from "./locales/es.js";
import zh from "./locales/zh.js";
import fil from "./locales/fil.js";
import vi from "./locales/vi.js";

export const DEFAULT_LOCALE = "en";
export const STORAGE_KEY = "republic_lang";
export const LOCALE_EVENT = "republic:locale";

/** BCP-47 tags written to html[lang] and Intl.DateTimeFormat. */
export const HTML_LANG = {
  en: "en",
  es: "es",
  zh: "zh-Hans",
  fil: "fil",
  vi: "vi",
};

export const SUPPORTED_LOCALES = ["en", "es", "zh", "fil", "vi"];

const CATALOGS = { en, es, zh, fil, vi };
const NAME_KEYS = {
  en: "lang.english",
  es: "lang.spanish",
  zh: "lang.chinese",
  fil: "lang.tagalog",
  vi: "lang.vietnamese",
};

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

export function localeTag(locale = getLocale()) {
  const code = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  return HTML_LANG[code] || HTML_LANG[DEFAULT_LOCALE];
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
  document.documentElement.lang = localeTag(locale);
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

function flagChinese() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 30 20");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="30" height="20" fill="#DE2910"/>
    <polygon fill="#FFDE00" points="5,1.6 5.88,4.28 8.7,4.28 6.41,5.94 7.29,8.62 5,6.96 2.71,8.62 3.59,5.94 1.3,4.28 4.12,4.28"/>
    <polygon fill="#FFDE00" points="10.15,1.55 10.48,2.55 11.55,2.55 10.69,3.17 11.02,4.17 10.15,3.55 9.28,4.17 9.61,3.17 8.75,2.55 9.82,2.55"/>
    <polygon fill="#FFDE00" points="12.35,3.55 12.68,4.55 13.75,4.55 12.89,5.17 13.22,6.17 12.35,5.55 11.48,6.17 11.81,5.17 10.95,4.55 12.02,4.55"/>
    <polygon fill="#FFDE00" points="12.35,6.55 12.68,7.55 13.75,7.55 12.89,8.17 13.22,9.17 12.35,8.55 11.48,9.17 11.81,8.17 10.95,7.55 12.02,7.55"/>
    <polygon fill="#FFDE00" points="10.15,8.45 10.48,9.45 11.55,9.45 10.69,10.07 11.02,11.07 10.15,10.45 9.28,11.07 9.61,10.07 8.75,9.45 9.82,9.45"/>
  `;
  return svg;
}

function flagTagalog() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="19" height="5" fill="#0038A8"/>
    <rect y="5" width="19" height="5" fill="#CE1126"/>
    <polygon points="0,0 7.4,5 0,10" fill="#FFFFFF"/>
    <circle cx="2.55" cy="5" r="1.15" fill="#FCD116"/>
    <circle cx="1.15" cy="2.4" r="0.42" fill="#FCD116"/>
    <circle cx="1.15" cy="7.6" r="0.42" fill="#FCD116"/>
    <circle cx="5.05" cy="5" r="0.42" fill="#FCD116"/>
  `;
  return svg;
}

function flagVietnamese() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="19" height="10" fill="#DA251D"/>
    <polygon fill="#FFCD00" points="9.5,1.35 10.58,4.55 13.95,4.55 11.22,6.52 12.3,9.72 9.5,7.75 6.7,9.72 7.78,6.52 5.05,4.55 8.42,4.55"/>
  `;
  return svg;
}

const FLAG_FNS = {
  en: flagEnglish,
  es: flagSpanish,
  zh: flagChinese,
  fil: flagTagalog,
  vi: flagVietnamese,
};

function flagButton(locale, label, flag) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lang-flag";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  btn.setAttribute("aria-pressed", getLocale() === locale ? "true" : "false");
  btn.dataset.testid = `language-flag-${locale}`;
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
    ...SUPPORTED_LOCALES.map((code) => flagButton(code, t(NAME_KEYS[code]), FLAG_FNS[code]))
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
  HTML_LANG,
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
