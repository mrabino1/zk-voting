/** Landing page copy (Korean). */

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
  lang: { label: "언어", ...names },
  nav: { pollVsVote: "여론조사 대 투표" },
  pollVote: {
    eyebrow: "여론조사 대 투표",
    title: "여론조사 대 투표",
    intro:
      "개설한 사람이 여론조사 또는 투표를 고릅니다. 여론조사는 기준을 넘긴 뒤 선택별 득표를 거의 실시간으로 공개합니다. 투표는 마감까지 선택지를 봉인합니다. 둘 다 최종 묶음, 이의 제기 기간, 최종 개표로 끝납니다.",
    poll: {
      name: "여론조사",
      summary: "기준 이후 선택별 득표가 거의 실시간으로 공개됩니다.",
      gate: "득표는 투표용지 100장이 모이거나 예정된 종료 시각이 될 때까지, 먼저 오는 쪽까지 숨겨집니다.",
      hourly: "그 기준 이후, 선택별 득표는 한 시간 블록마다 그 시간이 끝난 뒤 30분에 공개됩니다.",
      merge: "투표용지가 10장 미만인 시간은 다음 블록으로 합쳐집니다.",
      freeze: "마감 때 결과가 고정됩니다.",
      example: "예시",
      choiceA: "선택지 A",
      choiceB: "선택지 B",
      choiceC: "선택지 C",
    },
    vote: {
      name: "투표",
      summary: "선택지는 마감까지 봉인됩니다.",
      sealed: "선택지는 마감까지 봉인됩니다.",
      guardians: "합계로만 복호화되며, k-of-n 키 관리자가 필요합니다.",
      turnout: "시간별 투표율은 공개됩니다.",
      noInterim: "중간 선택별 득표는 없습니다.",
      sealedLabel: "봉인",
      turnoutLabel: "투표율",
    },
    both: {
      title: "둘 다",
      revote: "마감 전까지 다시 투표할 수 있습니다. 마지막 투표가 집계됩니다.",
      receipt: "모든 투표용지에는 영수증이 있습니다.",
      batch: "마감 때 최종 묶음이 공개됩니다.",
      challenge: "최종 개표 전에 이의 제기 기간이 있습니다.",
    },
    flow: {
      heading: "투표용지가 이동하는 과정",
      caption:
        "여론조사는 묶음 뒤에 시간별 결과를 공개합니다. 투표는 봉인된 채 투표율만 보여 줍니다. 마감, 이의 제기 기간, 최종 개표는 같습니다.",
      name: "여론조사와 투표의 투표용지 흐름",
      desc: "투표용지를 제출하고, 영수증을 받은 다음, 시간별 묶음으로 모입니다. 여론조사는 시간별 결과를 공개합니다. 투표는 봉인된 채 투표율만 보여 줍니다. 그다음 마감, 이의 제기 기간, 최종 개표가 있습니다.",
      cast: "제출",
      receipt: "영수증",
      batch: "시간별 묶음",
      pollLane: "여론조사",
      voteLane: "투표",
      pollResults: "시간별 결과",
      voteSealed: "봉인",
      voteTurnout: "투표율만",
      deadline: "마감",
      challenge: "이의 제기 기간",
      tally: "최종 개표",
    },
  },
};
