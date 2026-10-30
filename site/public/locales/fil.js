/** Landing page copy (Tagalog / Filipino). */

const names = {
  en: "English",
  es: "Español",
  zh: "中文",
  fil: "Filipino",
  vi: "Tiếng Việt",
  ar: "العربية",
  fr: "Français",
  ko: "한국어",
  pt: "Português",
  hi: "हिन्दी",
};

export default {
  lang: { label: "Wika", ...names },
  nav: { pollVsVote: "Opinyon at boto" },
  pollVote: {
    eyebrow: "Opinyon at boto",
    title: "Opinyon at boto",
    intro:
      "Ang gumagawa ang pumipili ng opinyon o boto. Ang opinyon ay naglalathala ng halos agarang bilang ayon sa pagpipilian pagkatapos ng hangganan. Ang boto ay nananatiling selyado ang mga pagpipilian hanggang sa takda. Magkapareho ang wakas: isang huling pangkat, panahon ng pagtutol, at huling bilangan.",
    poll: {
      name: "Opinyon",
      summary: "Halos agarang bilang ayon sa pagpipilian pagkatapos ng hangganan.",
      gate: "Nakatago ang mga bilang hanggang may 100 balota o hanggang sa nakatakdang wakas, alinman ang mauna.",
      hourly: "Pagkatapos ng hangganang iyon, inilalathala ang bilang ayon sa pagpipilian sa bawat blokeng oras, 30 minuto pagkatapos magsara ang oras.",
      merge: "Ang oras na wala pang 10 balota ay isinasama sa susunod na bloke.",
      freeze: "Titigil ang pagbabago ng mga resulta sa pagsasara.",
      example: "Halimbawa",
      choiceA: "Pagpipilian A",
      choiceB: "Pagpipilian B",
      choiceC: "Pagpipilian C",
    },
    vote: {
      name: "Boto",
      summary: "Nananatiling selyado ang mga pagpipilian hanggang sa takda.",
      sealed: "Nananatiling selyado ang mga pagpipilian hanggang sa takda.",
      guardians: "Binubuksan lang ang mga ito bilang kabuuan, ng mga tagapag-ingat ng susi na k-of-n.",
      turnout: "Hayag ang paglahok kada oras.",
      noInterim: "Walang pansamantalang bilang ayon sa pagpipilian.",
      sealedLabel: "Selyado",
      turnoutLabel: "Paglahok",
    },
    both: {
      title: "Pareho",
      revote: "Maaaring bumoto muli hanggang sa takda. Ang huling boto ang bilang.",
      receipt: "May resibo ang bawat balota.",
      batch: "May isang huling pangkat na inilalathala sa takda.",
      challenge: "May panahon ng pagtutol bago ang huling bilangan.",
    },
    flow: {
      heading: "Paano gumagalaw ang isang balota",
      caption:
        "Naglalathala ang opinyon ng resulta kada oras pagkatapos ng pangkat. Nananatiling selyado ang boto at paglahok lang ang ipinapakita. Iisa ang takda, ang panahon ng pagtutol, at ang huling bilangan.",
      name: "Daloy ng balota para sa opinyon at boto",
      desc: "Inihuhulog ang balota, saka may resibo, saka pangkat kada oras. Naglalathala ang opinyon ng resulta kada oras. Nananatiling selyado ang boto at paglahok lang ang ipinapakita. Kasunod ang takda, ang panahon ng pagtutol, at ang huling bilangan.",
      cast: "Ihulog",
      receipt: "Resibo",
      batch: "Pangkat kada oras",
      pollLane: "Opinyon",
      voteLane: "Boto",
      pollResults: "Resulta kada oras",
      voteSealed: "Selyado",
      voteTurnout: "Paglahok lang",
      deadline: "Takda",
      challenge: "Panahon ng pagtutol",
      tally: "Huling bilangan",
    },
  },
};
