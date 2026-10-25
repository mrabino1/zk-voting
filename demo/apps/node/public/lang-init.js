/* NOT FOR PROFIT — civic public good, not a commercial product.
 * Early html[lang] so the document language matches the saved website locale
 * before modules run. Default remains English. Docs and contracts stay English.
 */
(function () {
  try {
    var stored = window.localStorage.getItem("zk_voting_lang");
    var tags = {
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
    if (tags[stored]) {
      document.documentElement.lang = tags[stored];
      document.documentElement.dir = stored === "ar" ? "rtl" : "ltr";
    }
  } catch (_err) {
    /* private mode / blocked storage — stay on html lang="en" */
  }
})();
