/** Landing page copy (Spanish). */

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
  lang: { label: "Idioma", ...names },
  nav: { pollVsVote: "Encuesta y votación" },
  pollVote: {
    eyebrow: "Encuesta y votación",
    title: "Encuesta y votación",
    intro:
      "Quien la crea elige una encuesta o una votación. Una encuesta publica recuentos casi en vivo por opción después de un umbral. Una votación mantiene las opciones selladas hasta el cierre. Ambas terminan con un lote final, un plazo de impugnación y el escrutinio final.",
    poll: {
      name: "Encuesta",
      summary: "Recuentos casi en vivo por opción después del umbral.",
      gate: "Los recuentos permanecen ocultos hasta que hay 100 boletas o hasta el cierre programado, lo que ocurra primero.",
      hourly: "Después de ese umbral, los recuentos por opción se publican en cada bloque horario, 30 minutos después de que cierra la hora.",
      merge: "Una hora con menos de 10 boletas se une al bloque siguiente.",
      freeze: "Los resultados se congelan al cierre.",
      example: "Ejemplo",
      choiceA: "Opción A",
      choiceB: "Opción B",
      choiceC: "Opción C",
    },
    vote: {
      name: "Votación",
      summary: "Las opciones permanecen selladas hasta el cierre.",
      sealed: "Las opciones permanecen selladas hasta el cierre.",
      guardians: "Se descifran solo como un agregado, mediante guardianes k-of-n.",
      turnout: "La participación por hora es pública.",
      noInterim: "No hay recuentos provisionales por opción.",
      sealedLabel: "Sellado",
      turnoutLabel: "Participación",
    },
    both: {
      title: "Ambas",
      revote: "Se puede votar de nuevo hasta el cierre. Cuenta el último voto.",
      receipt: "Cada boleta tiene un recibo.",
      batch: "En el cierre se publica un lote final.",
      challenge: "Hay un plazo de impugnación antes del escrutinio final.",
    },
    flow: {
      heading: "Cómo avanza una boleta",
      caption:
        "Una encuesta publica resultados por hora después del lote. Una votación permanece sellada y solo muestra la participación. El cierre, el plazo de impugnación y el escrutinio final son comunes.",
      name: "Recorrido de la boleta en una encuesta y una votación",
      desc: "Primero se emite la boleta, luego hay un recibo y después un lote horario. Una encuesta publica resultados por hora. Una votación permanece sellada y solo muestra la participación. Después vienen el cierre, un plazo de impugnación y el escrutinio final.",
      cast: "Emitir",
      receipt: "Recibo",
      batch: "Lote horario",
      pollLane: "Encuesta",
      voteLane: "Votación",
      pollResults: "Resultados por hora",
      voteSealed: "Sellado",
      voteTurnout: "Solo participación",
      deadline: "Cierre",
      challenge: "Plazo de impugnación",
      tally: "Escrutinio final",
    },
  },
};
