/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Website locale (English default). Optional locales follow ACS home-language
 * rank in the United States after English: Spanish, Chinese, Tagalog, Vietnamese,
 * Arabic, French, Korean, Portuguese, Hindi. Fallback is English. Persist only
 * in localStorage (no navigator sniff). Smart-contract code and
 * operator documentation stay English.
 */

import { brandName, escapeBrandHtml } from "./brand.js";
import en from "./locales/en.js";
import es from "./locales/es.js";
import zh from "./locales/zh.js";
import fil from "./locales/fil.js";
import vi from "./locales/vi.js";
import ar from "./locales/ar.js";
import fr from "./locales/fr.js";
import ko from "./locales/ko.js";
import pt from "./locales/pt.js";
import hi from "./locales/hi.js";

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
  ar: "ar",
  fr: "fr",
  ko: "ko",
  pt: "pt-BR",
  hi: "hi",
};

export const SUPPORTED_LOCALES = ["en", "es", "zh", "fil", "vi", "ar", "fr", "ko", "pt", "hi"];
export const RTL_LOCALES = ["ar"];

const CATALOGS = { en, es, zh, fil, vi, ar, fr, ko, pt, hi };
const NAME_KEYS = {
  en: "lang.english",
  es: "lang.spanish",
  zh: "lang.chinese",
  fil: "lang.tagalog",
  vi: "lang.vietnamese",
  ar: "lang.arabic",
  fr: "lang.french",
  ko: "lang.korean",
  pt: "lang.portuguese",
  hi: "lang.hindi",
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
  // `{brand}` is the product name from site admin; callers may override it.
  return interpolate(template, { brand: brandName(), ...(vars || {}) });
}

export function applyDocumentLang(locale = getLocale()) {
  if (typeof document === "undefined") return;
  const code = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  document.documentElement.lang = localeTag(code);
  document.documentElement.dir = RTL_LOCALES.includes(code) ? "rtl" : "ltr";
  // Route bodies are still English. Mark them so a screen reader does not
  // pronounce that copy with the chrome language. Header and footer use t().
  const main = document.getElementById("main");
  if (main) {
    if (code === DEFAULT_LOCALE) main.removeAttribute("lang");
    else main.setAttribute("lang", DEFAULT_LOCALE);
  }
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
    el.innerHTML = t(key, { brand: escapeBrandHtml(brandName()) });
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

function flagArabic() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="19" height="3.34" fill="#CE1126"/>
    <rect y="3.33" width="19" height="3.34" fill="#FFFFFF"/>
    <rect y="6.66" width="19" height="3.34" fill="#000000"/>
  `;
  return svg;
}

function flagFrench() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const uid = `lang${Math.random().toString(36).slice(2, 8)}`;
  const france = `flag-clip-france-${uid}`;
  const canada = `flag-clip-canada-${uid}`;
  svg.innerHTML = `
    <defs>
      <clipPath id="${france}"><polygon points="0,0 19,0 0,10"/></clipPath>
      <clipPath id="${canada}"><polygon points="19,0 19,10 0,10"/></clipPath>
    </defs>
    <g clip-path="url(#${france})">
      <rect width="6.333" height="10" fill="#002395"/>
      <rect x="6.333" width="6.334" height="10" fill="#FFFFFF"/>
      <rect x="12.667" width="6.333" height="10" fill="#ED2939"/>
    </g>
    <g clip-path="url(#${canada})">
      <rect width="19" height="10" fill="#FF0000"/>
      <rect x="4.75" width="9.5" height="10" fill="#FFFFFF"/>
      <polygon fill="#FF0000" points="9.5,2.2 10.15,4.15 12.3,4.15 10.55,5.35 11.2,7.3 9.5,6.1 7.8,7.3 8.45,5.35 6.7,4.15 8.85,4.15"/>
    </g>
    <line x1="19" y1="0" x2="0" y2="10" stroke="rgba(0,0,0,0.35)" stroke-width="0.35"/>
  `;
  return svg;
}

function flagKorean() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="19" height="10" fill="#FFFFFF"/>
    <circle cx="9.5" cy="5" r="2.35" fill="#CD2E3A"/>
    <path d="M9.5 5 A2.35 2.35 0 0 0 9.5 9.7 A2.35 2.35 0 0 0 9.5 5" fill="#0047A0"/>
    <circle cx="9.5" cy="6.175" r="1.175" fill="#0047A0"/>
    <circle cx="9.5" cy="3.825" r="1.175" fill="#CD2E3A"/>
  `;
  return svg;
}

function flagPortuguese() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const uid = `lang${Math.random().toString(36).slice(2, 8)}`;
  const brazil = `flag-clip-brazil-${uid}`;
  const portugal = `flag-clip-portugal-${uid}`;
  svg.innerHTML = `
    <defs>
      <clipPath id="${brazil}"><polygon points="0,0 19,0 0,10"/></clipPath>
      <clipPath id="${portugal}"><polygon points="19,0 19,10 0,10"/></clipPath>
    </defs>
    <g clip-path="url(#${brazil})">
      <rect width="19" height="10" fill="#009B3A"/>
      <polygon points="9.5,1.4 16.4,5 9.5,8.6 2.6,5" fill="#FEDD00"/>
      <circle cx="9.5" cy="5" r="1.35" fill="#002776"/>
    </g>
    <g clip-path="url(#${portugal})">
      <rect width="7.6" height="10" fill="#006600"/>
      <rect x="7.6" width="11.4" height="10" fill="#FF0000"/>
      <circle cx="7.6" cy="5" r="1.45" fill="#FFD700"/>
    </g>
    <line x1="19" y1="0" x2="0" y2="10" stroke="rgba(0,0,0,0.35)" stroke-width="0.35"/>
  `;
  return svg;
}

function flagHindi() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 19 10");
  svg.setAttribute("class", "lang-flag-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `
    <rect width="19" height="3.34" fill="#FF9933"/>
    <rect y="3.33" width="19" height="3.34" fill="#FFFFFF"/>
    <rect y="6.66" width="19" height="3.34" fill="#138808"/>
    <circle cx="9.5" cy="5" r="1.15" fill="none" stroke="#000088" stroke-width="0.28"/>
    <circle cx="9.5" cy="5" r="0.22" fill="#000088"/>
  `;
  return svg;
}

const FLAG_FNS = {
  en: flagEnglish,
  es: flagSpanish,
  zh: flagChinese,
  fil: flagTagalog,
  vi: flagVietnamese,
  ar: flagArabic,
  fr: flagFrench,
  ko: flagKorean,
  pt: flagPortuguese,
  hi: flagHindi,
};

function flagGlyph(locale) {
  const make = FLAG_FNS[locale] || flagEnglish;
  return make();
}

let switcherDismissBound = false;

function bindSwitcherDismiss() {
  if (switcherDismissBound || typeof document === "undefined") return;
  switcherDismissBound = true;
  document.addEventListener("click", () => {
    document.querySelectorAll(".lang-menu").forEach((menu) => {
      menu.hidden = true;
    });
    document.querySelectorAll(".lang-toggle").forEach((btn) => {
      btn.setAttribute("aria-expanded", "false");
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = [...document.querySelectorAll(".lang-toggle")].filter(
      (btn) => btn.getAttribute("aria-expanded") === "true",
    );
    if (!open.length) return;
    document.querySelectorAll(".lang-menu").forEach((menu) => {
      menu.hidden = true;
    });
    for (const btn of open) {
      btn.setAttribute("aria-expanded", "false");
    }
    const active = document.activeElement;
    const inside = active && active.closest && active.closest(".lang-switcher");
    if (inside) open[0].focus();
  });
}

function optionButton(locale) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lang-option";
  btn.setAttribute("role", "option");
  btn.tabIndex = -1;
  btn.setAttribute("aria-selected", getLocale() === locale ? "true" : "false");
  btn.dataset.testid = `language-option-${locale}`;
  btn.dataset.locale = locale;
  const mark = document.createElement("span");
  mark.className = "lang-option-flag";
  mark.append(flagGlyph(locale));
  const name = document.createElement("span");
  name.className = "lang-option-name";
  name.textContent = t(NAME_KEYS[locale]);
  btn.append(mark, name);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    setLocale(locale);
    document.querySelector(".lang-toggle")?.focus();
  });
  return btn;
}

function moveLangOption(menu, delta) {
  const items = [...menu.querySelectorAll(".lang-option")];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  let next = current;
  if (delta === "home") next = 0;
  else if (delta === "end") next = items.length - 1;
  else next = current < 0 ? 0 : (current + delta + items.length) % items.length;
  for (const item of items) item.tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
}

export function mountLanguageSwitcher(root) {
  if (typeof document === "undefined") return null;
  const host = root || document.getElementById("lang-switcher");
  if (!host) return null;
  bindSwitcherDismiss();
  const locale = getLocale();
  host.classList.add("lang-switcher");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", t("lang.group"));

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "lang-toggle";
  toggle.setAttribute("aria-label", `${t("lang.choose")}, ${t(NAME_KEYS[locale])}`);
  toggle.setAttribute("aria-haspopup", "listbox");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "lang-menu");
  toggle.dataset.testid = "language-toggle";
  const currentFlag = document.createElement("span");
  currentFlag.className = "lang-toggle-flag";
  currentFlag.append(flagGlyph(locale));
  toggle.append(currentFlag);

  const menu = document.createElement("div");
  menu.id = "lang-menu";
  menu.className = "lang-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", t("lang.group"));
  menu.append(...SUPPORTED_LOCALES.map((code) => optionButton(code)));

  function openMenu() {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const selected = menu.querySelector('[aria-selected="true"]') || menu.querySelector(".lang-option");
    for (const item of menu.querySelectorAll(".lang-option")) item.tabIndex = item === selected ? 0 : -1;
    selected?.focus();
  }

  function closeMenu(focusToggle) {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (focusToggle) toggle.focus();
  }

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu(false);
  });

  menu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveLangOption(menu, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveLangOption(menu, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveLangOption(menu, "home");
    } else if (event.key === "End") {
      event.preventDefault();
      moveLangOption(menu, "end");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  });

  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  host.replaceChildren(toggle, menu);
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
  RTL_LOCALES,
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
