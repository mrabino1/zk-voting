/**
 * Marks the FAQ section that is open and closes the phone menu after a choice.
 * The page still switches without this script: CSS shows the targeted article.
 */

const pages = [...document.querySelectorAll(".docs-page")].map((el) => el.id);

function openPageId() {
  const hash = location.hash.replace(/^#/, "");
  if (pages.includes(hash)) return hash;
  const target = hash ? document.getElementById(hash) : null;
  const page = target && target.closest ? target.closest(".docs-page") : null;
  return page ? page.id : pages[0];
}

function sync() {
  const id = openPageId();
  for (const link of document.querySelectorAll(".docs-nav a[href^='#']")) {
    if (link.getAttribute("href") === `#${id}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const current = document.querySelector(".docs-nav a[aria-current='page']");
  const nav = current && current.closest(".docs-nav");
  if (!current || !nav) return;
  const navRect = nav.getBoundingClientRect();
  const linkRect = current.getBoundingClientRect();
  if (linkRect.top < navRect.top) nav.scrollTop -= navRect.top - linkRect.top;
  else if (linkRect.bottom > navRect.bottom) nav.scrollTop += linkRect.bottom - navRect.bottom;
}

function closeDrawer() {
  const drawer = document.querySelector(".docs-drawer");
  if (!drawer) return;
  if (window.matchMedia("(max-width: 900px)").matches) drawer.open = false;
}

window.addEventListener("hashchange", () => {
  sync();
  closeDrawer();
});

const drawer = document.querySelector(".docs-drawer");
if (drawer && window.matchMedia("(max-width: 900px)").matches) drawer.open = false;

sync();
