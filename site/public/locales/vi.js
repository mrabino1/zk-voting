/** Landing page copy (Vietnamese). */

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
  lang: { label: "Ngôn ngữ", ...names },
  nav: { pollVsVote: "Thăm dò và bỏ phiếu" },
  pollVote: {
    eyebrow: "Thăm dò và bỏ phiếu",
    title: "Thăm dò và bỏ phiếu",
    intro:
      "Người tạo chọn thăm dò hoặc bỏ phiếu. Thăm dò công bố số phiếu gần như tức thời theo từng lựa chọn sau ngưỡng. Bỏ phiếu giữ các lựa chọn niêm phong đến hạn. Cả hai kết thúc bằng một lô cuối, thời gian khiếu nại và kiểm phiếu cuối cùng.",
    poll: {
      name: "Thăm dò",
      summary: "Số phiếu gần như tức thời theo từng lựa chọn sau ngưỡng.",
      gate: "Số phiếu được giấu cho đến khi có 100 phiếu hoặc đến giờ kết thúc đã định, tùy điều nào đến trước.",
      hourly: "Sau ngưỡng đó, số phiếu theo từng lựa chọn được công bố cho mỗi khối giờ, 30 phút sau khi giờ đó khép.",
      merge: "Giờ có dưới 10 phiếu được gộp vào khối kế tiếp.",
      freeze: "Kết quả khóa lại khi đóng.",
      example: "Ví dụ",
      choiceA: "Lựa chọn A",
      choiceB: "Lựa chọn B",
      choiceC: "Lựa chọn C",
    },
    vote: {
      name: "Bỏ phiếu",
      summary: "Các lựa chọn được niêm phong đến hạn.",
      sealed: "Các lựa chọn được niêm phong đến hạn.",
      guardians: "Chúng chỉ được giải mã như một tổng, bởi những người giữ khóa k-of-n.",
      turnout: "Lượt tham gia theo giờ là công khai.",
      noInterim: "Không có số phiếu tạm thời theo từng lựa chọn.",
      sealedLabel: "Niêm phong",
      turnoutLabel: "Tham gia",
    },
    both: {
      title: "Cả hai",
      revote: "Có thể bỏ phiếu lại đến hạn. Phiếu cuối được tính.",
      receipt: "Mỗi phiếu có một biên nhận.",
      batch: "Một lô cuối được công bố vào hạn.",
      challenge: "Có thời gian khiếu nại trước kiểm phiếu cuối cùng.",
    },
    flow: {
      heading: "Một phiếu đi như thế nào",
      caption:
        "Thăm dò công bố kết quả theo giờ sau lô. Bỏ phiếu giữ niêm phong và chỉ hiện lượt tham gia. Hạn, thời gian khiếu nại và kiểm phiếu cuối cùng là chung.",
      name: "Luồng phiếu của thăm dò và bỏ phiếu",
      desc: "Phiếu được nộp, rồi có biên nhận, rồi một lô theo giờ. Thăm dò công bố kết quả theo giờ. Bỏ phiếu giữ niêm phong và chỉ hiện lượt tham gia. Sau đó là hạn, thời gian khiếu nại và kiểm phiếu cuối cùng.",
      cast: "Nộp phiếu",
      receipt: "Biên nhận",
      batch: "Lô theo giờ",
      pollLane: "Thăm dò",
      voteLane: "Bỏ phiếu",
      pollResults: "Kết quả theo giờ",
      voteSealed: "Niêm phong",
      voteTurnout: "Chỉ lượt tham gia",
      deadline: "Hạn chót",
      challenge: "Thời gian khiếu nại",
      tally: "Kiểm phiếu cuối",
    },
  },
};
