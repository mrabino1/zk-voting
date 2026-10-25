# Accessibility audit (WCAG 2.2 AA)

**NOT FOR PROFIT** — civic public good. Not a commercial product. See `/NOT_FOR_PROFIT.md`.

Product name: **Republic**. This note covers the Node SPA and the admin, back-office, and explorer shells in `apps/node/public/`.

Audit date: 2026-09-27. Standard: **WCAG 2.2 Level AA**. Automated engine: **axe-core 4.10.3** (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) in headless Chrome via `puppeteer-core`.

## Scope

| Audience | Routes |
| --- | --- |
| Public | `/`, `/public`, `/about`, `/faq`, `/signin`, `/register`, `/terms`, `/feedback`, `/receipt`, `/outcomes` |
| Registered voter | `/me`, `/register`, `/vote/:id`, `/elections/:id/results` |
| Officer / admin | `/admin`, `/back-office`, `/office`, `/explorer` |

Each route was checked in light and dark (`prefers-color-scheme`). A separate pass checked keyboard order, the language listbox, Arabic RTL chrome, and ranked-ballot names.

## What was fixed

**Contrast (1.4.3).** Kickers use `--gold-text`, darkened in light (`#3f5c0a`) and the Infisical project yellow in dark (`#e0ed34`), both at least 4.5:1 on the canvas and on cards. Muted text is `#525355` in light and `#adaeb0` in dark so small hints clear the canvas. Status text sits on its tinted background only when that pair clears 4.5:1. Chrome (banner, sidebar, footer, buttons) uses `--ink` on the surface color in both schemes. `prefers-contrast: more` resets the tokens at the end of `styles.css`, including status backgrounds, so it wins over the dark scheme.

**Names (1.3.1, 4.1.2).** Back-office aspect and ballot fields are tied to their labels with `for` / `id`. Remove controls name the thing they remove. Ranked-choice Up, Down, Add, and Remove buttons, and the “About this choice” link, include the candidate name. The sign-in email field uses `autocomplete="email"` (axe rejects `username email`).

**Definition lists (1.3.1).** Platform host stats were `dt` / `dd` inside a `div`. The grid is now a `dl`.

**Language and RTL (3.1.2, 1.3.2, 2.1.1).** Every shell loads `lang-init.js` and the catalogs. The language control is a listbox: arrows, Home, End, and Escape. Choosing Arabic sets `html[lang=ar]` and `dir=rtl`. Page bodies stay English, so `#main` is marked `lang="en"` when the chrome locale is not English. Skip link, banner, brand, footer notice, and primary nav labels follow the catalog. Spacing and table alignment use logical properties (`inset-inline-start`, `text-align: start`, `border-inline-start`, `margin-inline-end`) so Arabic does not overflow the viewport.

**Focus (2.4.1, 2.4.3, 2.4.7).** A skip link is the first control when tabbing from the top of the document. Route changes move focus to `#main` (`tabindex="-1"`). `:focus-visible` draws a 3px outline. Rank buttons are at least 2.75rem; the default control size token is 3rem.

**Locales.** All ten catalogs (`en`, `es`, `zh`, `fil`, `vi`, `ar`, `fr`, `ko`, `pt`, `hi`) have the same 850 keys, including the chrome nav strings and the admin mail / election-staff strings that eight catalogs were missing.

## What remains

- **Page bodies are still English.** Ballots, About, FAQ, admin forms, and explorer tables are not passed through `t()`. Chrome (skip, banner, brand, nav, footer notice, language names) is translated. `#main lang="en"` tells assistive tech the body language. A full catalog pass is a separate change.
- **Footer official links stay English** and are marked `lang="en"`.
- **PIN pad blocks digit, Backspace, Delete, and paste** while the pad is on screen, so a watcher cannot read a typed pattern. The on-screen keys remain keyboard operable (Tab and Enter). This is a coercion tradeoff, not a missing name or contrast failure.
- **Ranked choice can be dragged.** Up, Down, Add, and Remove buttons are the keyboard path, so dragging is not the only way to rank (WCAG 2.5.7).
- **axe `target-size` is off by default** in axe-core 4.10 even under the `wcag22aa` tag. Rank buttons and the language control were sized by hand. Inline footer links were not remeasured against 24×24 CSS pixels.
- **Focus not obscured (2.4.11)** was not given a sticky-header scroll pass beyond what axe reports on these routes. No screen reader (NVDA, VoiceOver, TalkBack) was used; the checks are axe plus keyboard and RTL in headless Chrome.
- **Officer nav “Admin”** now uses `chrome.navAdmin`. Other office strings inside forms are still English.

## CI

`npm run test:node` includes `apps/node/test/a11y.test.mjs`. CI installs Chrome when the runner does not already have it. Local equivalent:

```bash
npm run test:a11y -w apps/node
```

Set `CHROME_PATH` if Chrome is not on `PATH` as `google-chrome-stable`, `google-chrome`, `chromium`, or `chromium-browser`.
