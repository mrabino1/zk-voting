/**
 * Locale for the public landing page.
 * The language list matches the Node UI: English, then the ACS US home-language
 * ranks after English. A saved choice in localStorage wins. Otherwise the first
 * supported browser language is used. Otherwise English.
 * Arabic is the Node UI's only right-to-left language, so it sets dir=rtl.
 */

import { DEFAULT_BRAND_NAME, brandName } from "./brand.js";
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
import faqEn from "./locales/faq/en.js";
import faqEs from "./locales/faq/es.js";
import faqZh from "./locales/faq/zh.js";
import faqFil from "./locales/faq/fil.js";
import faqVi from "./locales/faq/vi.js";
import faqAr from "./locales/faq/ar.js";
import faqFr from "./locales/faq/fr.js";
import faqKo from "./locales/faq/ko.js";
import faqPt from "./locales/faq/pt.js";
import faqHi from "./locales/faq/hi.js";

export const LOCALE_CODES = Object.freeze(["en", "es", "zh", "fil", "vi", "ar", "fr", "ko", "pt", "hi"]);
export const HTML_LANG = Object.freeze({
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
});
export const STORAGE_KEY = "site_lang";
/** Same right-to-left set as the Node UI. */
export const RTL_LOCALES = Object.freeze(["ar"]);
/** Open Graph locale tags for the same list. */
export const OG_LOCALE = Object.freeze({
  en: "en_US",
  es: "es_ES",
  zh: "zh_CN",
  fil: "fil_PH",
  vi: "vi_VN",
  ar: "ar_AR",
  fr: "fr_FR",
  ko: "ko_KR",
  pt: "pt_BR",
  hi: "hi_IN",
});

/** Primary language subtags from navigator.languages. Tagalog is both fil and tl. */
const NAVIGATOR_PREFIXES = Object.freeze({
  en: ["en"],
  es: ["es"],
  zh: ["zh"],
  fil: ["fil", "tl"],
  vi: ["vi"],
  ar: ["ar"],
  fr: ["fr"],
  ko: ["ko"],
  pt: ["pt"],
  hi: ["hi"],
});

const CATALOGS = { en, es, zh, fil, vi, ar, fr, ko, pt, hi };
/** FAQ pages are a second catalog so landing-page key parity stays on index.html. */
const FAQ_CATALOGS = {
  en: faqEn,
  es: faqEs,
  zh: faqZh,
  fil: faqFil,
  vi: faqVi,
  ar: faqAr,
  fr: faqFr,
  ko: faqKo,
  pt: faqPt,
  hi: faqHi,
};

function lookupCatalog(code, key) {
  return lookup(CATALOGS[code], key) ?? lookup(FAQ_CATALOGS[code], key);
}
const FLOW_LANE_SHIFT = 236;

export function catalogs() {
  return CATALOGS;
}

export function isLocale(code) {
  return typeof code === "string" && LOCALE_CODES.includes(code);
}

export function sectionDirection(locale) {
  return RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}

/**
 * First supported language in a navigator.languages-style list.
 * An empty or unknown list falls back to English.
 */
export function matchNavigatorLocale(languages) {
  const list = Array.isArray(languages) ? languages : [];
  for (const tag of list) {
    const norm = String(tag ?? "").trim().toLowerCase().replace(/_/g, "-");
    if (!norm) continue;
    const base = norm.split("-")[0];
    for (const code of LOCALE_CODES) {
      if (NAVIGATOR_PREFIXES[code].includes(base)) return code;
    }
  }
  return "en";
}

/** A saved supported choice wins. Otherwise detect. Otherwise English. */
export function initialLocale(stored, languages) {
  if (isLocale(stored)) return stored;
  return matchNavigatorLocale(languages);
}

/** Swap the poll and vote lanes so the poll lane leads from the right in Arabic. */
export function flowLaneTransform(dir) {
  if (dir === "rtl") {
    return { poll: `translate(${FLOW_LANE_SHIFT} 0)`, vote: `translate(${-FLOW_LANE_SHIFT} 0)` };
  }
  return { poll: "", vote: "" };
}

export function lookup(dict, key) {
  if (!dict || !key) return undefined;
  let cur = dict;
  for (const part of String(key).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
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

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] == null ? match : String(vars[name])));
}

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** Same split as splitBrandWordmark in the node branding module. */
function splitBrandWordmark(name) {
  const value = String(name ?? "");
  const match = /^(zk)(?=$|[\s\u2010-\u2015-])/i.exec(value);
  if (!match) return null;
  return { lead: value.slice(0, match[1].length), rest: value.slice(match[1].length) };
}

function brandWordmarkMarkup(name) {
  const value = String(name ?? "");
  const split = splitBrandWordmark(value);
  if (!split) return `<span class="brand-name-text">${escapeText(value)}</span>`;
  let html = `<span class="brand-zk">${escapeText(split.lead)}</span>`;
  if (split.rest) html += `<span class="brand-rest">${escapeText(split.rest)}</span>`;
  return html;
}

function paintBrandWordmark(el, name) {
  const value = String(name ?? "");
  const split = splitBrandWordmark(value);
  el.replaceChildren();
  if (!split) {
    const text = document.createElement("span");
    text.className = "brand-name-text";
    text.textContent = value;
    el.append(text);
  } else {
    const lead = document.createElement("span");
    lead.className = "brand-zk";
    lead.textContent = split.lead;
    el.append(lead);
    if (split.rest) {
      const rest = document.createElement("span");
      rest.className = "brand-rest";
      rest.textContent = split.rest;
      el.append(rest);
    }
  }
  const wordmark = el.closest(".wordmark");
  if (wordmark) wordmark.setAttribute("title", value);
}

function matchingClose(html, tag, from) {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");
  let depth = 1;
  let i = from;
  while (i < html.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) return -1;
    if (open && open.index < close.index) {
      depth += 1;
      i = open.index + 1;
      continue;
    }
    depth -= 1;
    i = close.index + close[0].length;
    if (depth === 0) return i;
  }
  return -1;
}

function replaceDataBrand(html, brand) {
  const markup = brandWordmarkMarkup(brand);
  const re = /<([a-zA-Z0-9:-]+)(\s[^>]*\bdata-brand(?=[\s>=])[^>]*)>/g;
  let out = "";
  let last = 0;
  let match;
  while ((match = re.exec(html))) {
    const end = matchingClose(html, match[1], re.lastIndex);
    if (end < 0) break;
    out += html.slice(last, match.index);
    out += `<${match[1]}${match[2]}>${markup}</${match[1]}>`;
    last = end;
    re.lastIndex = end;
  }
  return out + html.slice(last);
}

function refreshWordmarkTitle(html, brand) {
  const value = escapeAttr(brand);
  return html.replace(/<([a-zA-Z0-9:-]+)([^>]*\bclass="[^"]*\bwordmark\b[^"]*"[^>]*)>/g, (_full, tag, attrs) => {
    const next = /\btitle="[^"]*"/.test(attrs)
      ? attrs.replace(/\btitle="[^"]*"/, `title="${value}"`)
      : `${attrs} title="${value}"`;
    return `<${tag}${next}>`;
  });
}

/** Allow only br, accent spans, code, and strong. Everything else is escaped text. */
export function safeHtml(template) {
  const re = /<br\s*\/?>|<span class="accent">([\s\S]*?)<\/span>|<code>([\s\S]*?)<\/code>|<strong>([\s\S]*?)<\/strong>/g;
  const src = String(template);
  let out = "";
  let last = 0;
  for (const match of src.matchAll(re)) {
    out += escapeText(src.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("<br")) out += "<br>";
    else if (token.startsWith("<span")) out += `<span class="accent">${escapeText(match[1])}</span>`;
    else if (token.startsWith("<code")) out += `<code dir="ltr">${escapeText(match[2])}</code>`;
    else out += `<strong>${escapeText(match[3])}</strong>`;
    last = match.index + token.length;
  }
  out += escapeText(src.slice(last));
  return out;
}

export function translate(locale, key, brand = DEFAULT_BRAND_NAME) {
  const code = isLocale(locale) ? locale : "en";
  const template = lookupCatalog(code, key) ?? lookupCatalog("en", key) ?? key;
  return interpolate(template, { brand });
}

function fillElements(html, attr, render) {
  const re = new RegExp(`<([a-zA-Z0-9:-]+)(\\s[^>]*\\b${attr}="([^"]+)"[^>]*)>([\\s\\S]*?)<\\/\\1>`, "g");
  return html.replace(re, (_full, tag, attrs, key) => `<${tag}${attrs}>${render(key)}</${tag}>`);
}

function withHtmlLocale(html, locale) {
  const code = isLocale(locale) ? locale : "en";
  const lang = HTML_LANG[code] || "en";
  const dir = sectionDirection(code);
  return String(html).replace(/<html\b([^>]*)>/i, (_full, attrs) => {
    let next = attrs;
    if (/\blang="[^"]*"/.test(next)) next = next.replace(/\blang="[^"]*"/, `lang="${lang}"`);
    else next = ` lang="${lang}"${next}`;
    if (/\bdir="[^"]*"/.test(next)) next = next.replace(/\bdir="[^"]*"/, `dir="${dir}"`);
    else next = ` dir="${dir}"${next}`;
    return `<html${next}>`;
  });
}

function withTranslatedAttr(html, dataAttr, attr, locale, brand) {
  const re = new RegExp(`<([a-zA-Z0-9:-]+)(\\s[^>]*\\b${dataAttr}="([^"]+)"[^>]*)>`, "g");
  const attrRe = new RegExp(`(^|\\s)${attr}="[^"]*"`);
  return html.replace(re, (_full, tag, attrs, key) => {
    const value = escapeAttr(translate(locale, key, brand));
    const next = attrRe.test(attrs) ? attrs.replace(attrRe, `$1${attr}="${value}"`) : `${attrs} ${attr}="${value}"`;
    return `<${tag}${next}>`;
  });
}

function withLiteralContent(html, marker, value) {
  const re = new RegExp(`<([a-zA-Z0-9:-]+)(\\s[^>]*\\b${marker}\\b[^>]*)>`, "g");
  const escaped = escapeAttr(value);
  const attrRe = /(^|\s)content="[^"]*"/;
  return html.replace(re, (_full, tag, attrs) => {
    const next = attrRe.test(attrs) ? attrs.replace(attrRe, `$1content="${escaped}"`) : `${attrs} content="${escaped}"`;
    return `<${tag}${next}>`;
  });
}

/** Replace data-i18n leaves and data-brand slots. Used by the render test. */
export function translateMarkup(html, locale, brand = DEFAULT_BRAND_NAME) {
  const code = isLocale(locale) ? locale : "en";
  let out = withHtmlLocale(html, code);
  out = fillElements(out, "data-i18n-html", (key) => safeHtml(translate(code, key, brand)));
  out = fillElements(out, "data-i18n", (key) => escapeText(translate(code, key, brand)));
  out = withTranslatedAttr(out, "data-i18n-content", "content", code, brand);
  out = withTranslatedAttr(out, "data-i18n-aria-label", "aria-label", code, brand);
  out = withTranslatedAttr(out, "data-i18n-alt", "alt", code, brand);
  out = withLiteralContent(out, "data-brand-content", brand);
  out = withLiteralContent(out, "data-og-current", OG_LOCALE[code] || "en_US");
  return refreshWordmarkTitle(replaceDataBrand(out, brand), brand);
}

function readStored() {
  try {
    if (typeof localStorage === "undefined") return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function browserLanguages() {
  if (typeof navigator === "undefined") return [];
  const list = navigator.languages;
  if (list && typeof list.length === "number" && list.length > 0) return Array.from(list);
  return navigator.language ? [navigator.language] : [];
}

function setTransform(el, value) {
  if (!el) return;
  if (value) el.setAttribute("transform", value);
  else el.removeAttribute("transform");
}

function apply(locale) {
  const code = isLocale(locale) ? locale : "en";
  const brand = brandName();
  const dir = sectionDirection(code);
  document.documentElement.lang = HTML_LANG[code] || "en";
  document.documentElement.dir = dir;
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (key) el.innerHTML = safeHtml(translate(code, key, brand));
  });
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = translate(code, key, brand);
  });
  document.querySelectorAll("[data-i18n-content]").forEach((el) => {
    const key = el.getAttribute("data-i18n-content");
    if (key) el.setAttribute("content", translate(code, key, brand));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria-label");
    if (key) el.setAttribute("aria-label", translate(code, key, brand));
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    const key = el.getAttribute("data-i18n-alt");
    if (key) el.setAttribute("alt", translate(code, key, brand));
  });
  document.querySelectorAll("[data-brand-content]").forEach((el) => {
    el.setAttribute("content", brand);
  });
  document.querySelectorAll("[data-og-current]").forEach((el) => {
    el.setAttribute("content", OG_LOCALE[code] || "en_US");
  });
  document.querySelectorAll("[data-brand]").forEach((el) => {
    paintBrandWordmark(el, brand);
  });
  const region = document.getElementById("poll-vs-vote");
  if (region) {
    region.dir = dir;
    region.lang = HTML_LANG[code] || "en";
  }
  document.querySelectorAll(".ballot-visual").forEach((el) => {
    el.dir = dir;
  });
  const flow = document.getElementById("ballot-flow");
  if (flow) {
    flow.setAttribute("direction", dir);
    const lanes = flowLaneTransform(dir);
    setTransform(flow.querySelector("#flow-poll-lane"), lanes.poll);
    setTransform(flow.querySelector("#flow-vote-lane"), lanes.vote);
  }
  document.querySelectorAll("select[data-lang-switcher]").forEach((select) => {
    for (const opt of select.options) {
      opt.textContent = translate(code, `lang.${opt.value}`, brand);
    }
    select.value = code;
  });
}

export function setLocale(code) {
  const next = isLocale(code) ? code : "en";
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore quota and private-mode failures */
  }
  if (typeof document !== "undefined") apply(next);
  return next;
}

function boot() {
  if (typeof document === "undefined") return;
  const start = () => {
    document.querySelectorAll("select[data-lang-switcher]").forEach((select) => {
      if (select.dataset.bound === "1") return;
      select.dataset.bound = "1";
      select.addEventListener("change", () => setLocale(select.value));
    });
    // Detect on first visit. Persist only after an explicit choice.
    apply(initialLocale(readStored(), browserLanguages()));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

boot();
