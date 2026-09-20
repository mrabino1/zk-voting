/* NOT FOR PROFIT — civic public good, not a commercial product.
 * Early html[lang] so the document language matches the saved website locale
 * before modules run. Default remains English. Docs and contracts stay English.
 */
(function () {
  try {
    var stored = window.localStorage.getItem("republic_lang");
    if (stored === "es" || stored === "en") {
      document.documentElement.lang = stored;
    }
  } catch (_err) {
    /* private mode / blocked storage — stay on html lang="en" */
  }
})();
