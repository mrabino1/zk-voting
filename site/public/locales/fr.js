/** Landing page copy (French). */

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
  lang: { label: "Langue", ...names },
  nav: { pollVsVote: "Sondage et scrutin" },
  pollVote: {
    eyebrow: "Sondage et scrutin",
    title: "Sondage et scrutin",
    intro:
      "La personne qui l'ouvre choisit un sondage ou un scrutin. Un sondage publie des totaux presque en direct par choix après un seuil. Un scrutin garde les choix scellés jusqu'à l'échéance. Les deux se terminent par un lot final, un délai de contestation et le décompte final.",
    poll: {
      name: "Sondage",
      summary: "Totaux presque en direct par choix après le seuil.",
      gate: "Les totaux restent cachés jusqu'à 100 bulletins ou jusqu'à la fin prévue, selon ce qui arrive en premier.",
      hourly: "Après ce seuil, les totaux par choix paraissent pour chaque bloc horaire, 30 minutes après la fin de l'heure.",
      merge: "Une heure de moins de 10 bulletins est fusionnée dans le bloc suivant.",
      freeze: "Les résultats se figent à la clôture.",
      example: "Exemple",
      choiceA: "Choix A",
      choiceB: "Choix B",
      choiceC: "Choix C",
    },
    vote: {
      name: "Scrutin",
      summary: "Les choix restent scellés jusqu'à l'échéance.",
      sealed: "Les choix restent scellés jusqu'à l'échéance.",
      guardians: "Ils ne sont déchiffrés qu'en total agrégé, par des gardiens k-of-n.",
      turnout: "La participation horaire est publique.",
      noInterim: "Il n'y a pas de totaux provisoires par choix.",
      sealedLabel: "Scellé",
      turnoutLabel: "Participation",
    },
    both: {
      title: "Les deux",
      revote: "On peut voter de nouveau jusqu'à l'échéance. Le dernier vote compte.",
      receipt: "Chaque bulletin a un reçu.",
      batch: "Un lot final est publié à l'échéance.",
      challenge: "Un délai de contestation précède le décompte final.",
    },
    flow: {
      heading: "Le parcours d'un bulletin",
      caption:
        "Un sondage publie des résultats horaires après le lot. Un scrutin reste scellé et ne montre que la participation. L'échéance, le délai de contestation et le décompte final sont communs.",
      name: "Parcours du bulletin pour un sondage et un scrutin",
      desc: "On dépose le bulletin, puis un reçu, puis un lot horaire. Un sondage publie des résultats horaires. Un scrutin reste scellé et ne montre que la participation. Viennent ensuite l'échéance, un délai de contestation et le décompte final.",
      cast: "Dépôt",
      receipt: "Reçu",
      batch: "Lot horaire",
      pollLane: "Sondage",
      voteLane: "Scrutin",
      pollResults: "Résultats horaires",
      voteSealed: "Scellé",
      voteTurnout: "Participation seule",
      deadline: "Échéance",
      challenge: "Délai de contestation",
      tally: "Décompte final",
    },
  },
};
