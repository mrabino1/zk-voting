/**
 * Locale for the Poll vs Vote section on the public landing page.
 * English is the default. The same ten languages as the Node UI are included.
 * The choice is stored in localStorage. The rest of this page stays English.
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

export function catalogs() {
  return CATALOGS;
}

export function isLocale(code) {
  return typeof code === "string" && LOCALE_CODES.includes(code);
}

export function sectionDirection(locale) {
  return locale === "ar" ? "rtl" : "ltr";
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

export function translate(locale, key, brand = DEFAULT_BRAND_NAME) {
  const code = isLocale(locale) ? locale : "en";
  const template = lookup(CATALOGS[code], key) ?? lookup(CATALOGS.en, key) ?? key;
  return interpolate(template, { brand });
}

/** Replace data-i18n leaves and data-brand slots. Used by the render test. */
export function translateMarkup(html, locale, brand = DEFAULT_BRAND_NAME) {
  const withCopy = String(html).replace(
    /data-i18n="([^"]+)"([^>]*>)([\s\S]*?)(<\/[a-zA-Z0-9:-]+>)/g,
    (_match, key, after, _body, close) => `data-i18n="${key}"${after}${escapeText(translate(locale, key, brand))}${close}`
  );
  return withCopy
    .replace(
      /(<[^>]*\sdata-brand\b[^>]*>)([\s\S]*?)(<\/[^>]+>)/g,
      (_match, open, _body, close) => `${open}${escapeText(brand)}${close}`
    )
    .replace(/data-brand-suffix="([^"]*)"([^>]*aria-label=")[^"]*"/g, (_match, suffix, mid) => {
      return `data-brand-suffix="${suffix}"${mid}${escapeText(brand + suffix)}"`;
    });
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

function apply(locale) {
  const code = isLocale(locale) ? locale : "en";
  const brand = brandName();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = translate(code, key, brand);
  });
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = brand;
  });
  document.querySelectorAll("[data-brand-suffix]").forEach((el) => {
    el.setAttribute("aria-label", brand + el.getAttribute("data-brand-suffix"));
  });
  const region = document.getElementById("poll-vs-vote");
  if (region) {
    region.dir = sectionDirection(code);
    region.lang = HTML_LANG[code] || "en";
  }
  const flow = document.getElementById("ballot-flow");
  if (flow) flow.setAttribute("direction", sectionDirection(code));
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
