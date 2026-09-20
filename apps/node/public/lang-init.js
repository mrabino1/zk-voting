/* NOT FOR PROFIT — civic public good, not a commercial product.
 * Early html[lang] so the document language matches the saved website locale
 * before modules run. Default remains English. Docs and contracts stay English.
 */
(function () {
  try {
    var stored = window.localStorage.getItem("republic_lang");
    var tags = { en: "en", es: "es", zh: "zh-Hans", fil: "fil", vi: "vi" };
    if (tags[stored]) document.documentElement.lang = tags[stored];
  } catch (_err) {
    /* private mode / blocked storage — stay on html lang="en" */
  }
})();
