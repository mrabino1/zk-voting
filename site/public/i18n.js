/**
 * Locale for the public landing page.
 * English is the default. The same ten languages as the Node UI are included.
 * The choice is stored in localStorage. Arabic sets the document to right-to-left.
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

const CATALOGS = { en, es, zh, fil, vi, ar, fr, ko, pt, hi };
const FLOW_LANE_SHIFT = 236;

export function catalogs() {
  return CATALOGS;
}

export function isLocale(code) {
  return typeof code === "string" && LOCALE_CODES.includes(code);
}

export function sectionDirection(locale) {
  return locale === "ar" ? "rtl" : "ltr";
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
  const template = lookup(CATALOGS[code], key) ?? lookup(CATALOGS.en, key) ?? key;
  return interpolate(template, { brand });
}

function fillElements(html, attr, render) {
  const re = new RegExp(`<([a-zA-Z0-9:-]+)(\\s[^>]*\\b${attr}="([^"]+)"[^>]*)>([\\s\\S]*?)<\\/\\1>`, "g");
  return html.replace(re, (_full, tag, attrs, key) => `<${tag}${attrs}>${render(key)}</${tag}>`);
}

/** Replace data-i18n leaves and data-brand slots. Used by the render test. */
export function translateMarkup(html, locale, brand = DEFAULT_BRAND_NAME) {
  let out = fillElements(String(html), "data-i18n-html", (key) => safeHtml(translate(locale, key, brand)));
  out = fillElements(out, "data-i18n", (key) => escapeText(translate(locale, key, brand)));
  out = out.replace(/<([a-zA-Z0-9:-]+)(\s[^>]*\bdata-i18n-content="([^"]+)"[^>]*)>/g, (_full, tag, attrs, key) => {
    const value = escapeAttr(translate(locale, key, brand));
    const next = /\bcontent="/.test(attrs)
      ? attrs.replace(/\bcontent="[^"]*"/, `content="${value}"`)
      : `${attrs} content="${value}"`;
    return `<${tag}${next}>`;
  });
  out = out.replace(/<([a-zA-Z0-9:-]+)(\s[^>]*\bdata-i18n-aria-label="([^"]+)"[^>]*)>/g, (_full, tag, attrs, key) => {
    const value = escapeAttr(translate(locale, key, brand));
    const next = /\baria-label="/.test(attrs)
      ? attrs.replace(/\baria-label="[^"]*"/, `aria-label="${value}"`)
      : `${attrs} aria-label="${value}"`;
    return `<${tag}${next}>`;
  });
  return out.replace(
    /(<[^>]*\sdata-brand(?=[\s>=])[^>]*>)([\s\S]*?)(<\/[^>]+>)/g,
    (_match, open, _body, close) => `${open}${escapeText(brand)}${close}`
  );
}

function readStored() {
  try {
    if (typeof localStorage === "undefined") return "en";
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : "en";
  } catch {
    return "en";
  }
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
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = brand;
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
  const select = document.getElementById("lang-switcher");
  if (select) {
    for (const opt of select.options) {
      opt.textContent = translate(code, `lang.${opt.value}`, brand);
    }
    select.value = code;
  }
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
    const select = document.getElementById("lang-switcher");
    if (select && select.dataset.bound !== "1") {
      select.dataset.bound = "1";
      select.addEventListener("change", () => setLocale(select.value));
    }
    setLocale(readStored());
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

boot();
