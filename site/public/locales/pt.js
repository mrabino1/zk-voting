/** Landing page copy (Portuguese, Brazil). */

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
  nav: { pollVsVote: "Enquete e votação" },
  pollVote: {
    eyebrow: "Enquete e votação",
    title: "Enquete e votação",
    intro:
      "Quem cria escolhe uma enquete ou uma votação. Uma enquete publica totais quase ao vivo por opção depois de um limite. Uma votação mantém as opções seladas até o prazo. As duas terminam com um lote final, uma janela de impugnação e a apuração final.",
    poll: {
      name: "Enquete",
      summary: "Totais quase ao vivo por opção depois do limite.",
      gate: "Os totais ficam ocultos até haver 100 cédulas ou até o fim programado, o que ocorrer primeiro.",
      hourly: "Depois desse limite, os totais por opção saem em cada bloco horário, 30 minutos após o fim da hora.",
      merge: "Uma hora com menos de 10 cédulas segue para o bloco seguinte.",
      freeze: "Os resultados congelam no encerramento.",
      example: "Exemplo",
      choiceA: "Opção A",
      choiceB: "Opção B",
      choiceC: "Opção C",
    },
    vote: {
      name: "Votação",
      summary: "As opções ficam seladas até o prazo.",
      sealed: "As opções ficam seladas até o prazo.",
      guardians: "Elas só são decifradas como um agregado, por guardiões k-of-n.",
      turnout: "O comparecimento horário é público.",
      noInterim: "Não há totais provisórios por opção.",
      sealedLabel: "Selado",
      turnoutLabel: "Comparecimento",
    },
    both: {
      title: "Ambos",
      revote: "É possível votar de novo até o prazo. Vale o último voto.",
      receipt: "Cada cédula tem um recibo.",
      batch: "Um lote final é publicado no prazo.",
      challenge: "Uma janela de impugnação vem antes da apuração final.",
    },
    flow: {
      heading: "Como uma cédula avança",
      caption:
        "Uma enquete publica resultados por hora depois do lote. Uma votação fica selada e mostra só o comparecimento. O prazo, a janela de impugnação e a apuração final são comuns.",
      name: "Percurso da cédula em uma enquete e uma votação",
      desc: "A cédula é lançada, depois há um recibo e um lote horário. Uma enquete publica resultados por hora. Uma votação fica selada e mostra só o comparecimento. Em seguida vêm o prazo, uma janela de impugnação e a apuração final.",
      cast: "Lançar",
      receipt: "Recibo",
      batch: "Lote horário",
      pollLane: "Enquete",
      voteLane: "Votação",
      pollResults: "Resultados por hora",
      voteSealed: "Selado",
      voteTurnout: "Só comparecimento",
      deadline: "Prazo",
      challenge: "Janela de impugnação",
      tally: "Apuração final",
    },
  },
};
