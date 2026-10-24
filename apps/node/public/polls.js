/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * ERC-20 weighted signal polls. Holding the token is the only credential.
 * No ZK-Voting account, passkey, PIN, or identity bind.
 */

import { t } from "./i18n.js";

function banner(h) {
  return h(
    "p",
    { class: "poll-signal", role: "note", "data-testid": "poll-signal" },
    h("strong", { text: t("polls.signal") }),
    " · ",
    t("polls.nfpFooter")
  );
}

function formatUnits(raw, decimals) {
  let n;
  try {
    n = BigInt(raw ?? "0");
  } catch {
    return String(raw ?? "0");
  }
  const d = Number(decimals || 0);
  if (!Number.isInteger(d) || d <= 0) return n.toString();
  const base = 10n ** BigInt(d);
  const whole = n / base;
  const frac = (n % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function weightLabel(raw, poll) {
  const shown = formatUnits(raw, poll?.decimals);
  const symbol = poll?.tokenSymbol ? ` ${poll.tokenSymbol}` : "";
  return `${shown}${symbol} (${raw} ${t("polls.baseUnits")})`;
}

function sharePercent(weight, total) {
  let w;
  let sum;
  try {
    w = BigInt(weight || "0");
    sum = BigInt(total || "0");
  } catch {
    return 0;
  }
  if (sum <= 0n) return 0;
  const bps = (w * 10000n) / sum;
  return Number(bps) / 100;
}

function optionLabel(poll, id) {
  const row = (poll?.options || []).find((o) => o.id === id);
  if (row) return row.id === "abstain" ? t("polls.abstain") : row.label;
  return id === "abstain" ? t("polls.abstain") : String(id);
}

function typeLabel(poll) {
  return poll?.pollType === "ranked_irv" ? t("polls.typeIrv") : t("polls.typePlurality");
}

function metaList(h, ctx, poll) {
  return h(
    "ul",
    { class: "meta-list" },
    h("li", {}, `${t("polls.state")}: ${poll.state}`),
    h("li", {}, `${t("polls.token")}: ${poll.tokenSymbol || ""} ${poll.token}`),
    h("li", {}, `${t("polls.chain")}: ${poll.tokenChainId}`),
    h("li", {}, `${typeLabel(poll)}`),
    h(
      "li",
      {},
      `${t("polls.window")}: ${ctx.formatTime(poll.startTime)} – ${ctx.formatTime(poll.cutoffTime)}`
    )
  );
}

async function connectWallet() {
  const eth = globalThis.ethereum;
  if (!eth || typeof eth.request !== "function") {
    const err = new Error(t("polls.noWallet"));
    err.code = "NO_WALLET";
    throw err;
  }
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : null;
  if (!address) throw new Error(t("polls.noWallet"));
  return address;
}

function rankList(h, poll, order, redraw) {
  function move(from, to) {
    if (to < 0 || to >= order.length || from === to) return;
    const [row] = order.splice(from, 1);
    order.splice(to, 0, row);
    redraw();
  }
  return h(
    "ol",
    { class: "rank-list" },
    ...order.map((id, index) =>
      h(
        "li",
        {
          class: "rank-row",
          draggable: "true",
          onDragstart: (ev) => {
            ev.dataTransfer.setData("text/plain", String(index));
            ev.dataTransfer.effectAllowed = "move";
          },
          onDragover: (ev) => ev.preventDefault(),
          onDrop: (ev) => {
            ev.preventDefault();
            const from = Number(ev.dataTransfer.getData("text/plain"));
            if (Number.isInteger(from)) move(from, index);
          },
        },
        h("span", { class: "rank-handle", "aria-hidden": "true", text: "⋮⋮" }),
        h("span", { class: "rank-label", text: `${index + 1}. ${optionLabel(poll, id)}` }),
        h(
          "span",
          { class: "rank-move" },
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: t("polls.up"),
            disabled: index === 0,
            onClick: () => move(index, index - 1),
          }),
          h("button", {
            type: "button",
            class: "btn btn-secondary rank-btn",
            text: t("polls.down"),
            disabled: index === order.length - 1,
            onClick: () => move(index, index + 1),
          })
        )
      )
    )
  );
}

function receiptView(h, receipt) {
  return h(
    "section",
    { class: "panel", "data-testid": "poll-receipt" },
    h("h2", { text: t("polls.receiptTitle") }),
    h("p", { text: t("polls.receiptNote") }),
    h(
      "ul",
      { class: "meta-list" },
      h("li", {}, receipt.voter || ""),
      h("li", {}, `${t("polls.provisional")}: ${receipt.provisionalWeight}`),
      h("li", {}, `voteBlock ${receipt.voteBlock}`),
      h("li", {}, receipt.ballotDigest || "")
    )
  );
}

function lookupPanel(h, ctx, poll, host) {
  const input = h("input", {
    id: "poll-lookup-address",
    name: "address",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "0x…",
  });
  const out = h("div", { "data-testid": "poll-lookup-result" });
  host.append(
    h("h2", { text: t("polls.lookup") }),
    h(
      "form",
      {
        class: "form-grid",
        onSubmit: async (ev) => {
          ev.preventDefault();
          out.replaceChildren(h("p", { text: t("common.loading") }));
          try {
            const data = await ctx.api(
              `/api/polls/${encodeURIComponent(poll.id)}/weight?address=${encodeURIComponent(input.value.trim())}`
            );
            const lines = [
              data.voted ? t("polls.voted") : t("polls.notVoted"),
            ];
            if (data.currentBalance != null) {
              lines.push(`${t("polls.provisional")}: ${weightLabel(data.currentBalance, poll)}`);
            }
            if (data.provisionalWeight != null) {
              lines.push(`${t("polls.provisional")}: ${weightLabel(data.provisionalWeight, poll)}`);
            }
            if (data.finalWeight != null) {
              lines.push(`${t("polls.finalWeight")}: ${weightLabel(data.finalWeight, poll)}`);
            }
            if (data.reduced) lines.push(t("polls.reduced"));
            if (data.status === "withdrawn_by_transfer") lines.push(t("polls.withdrawnStatus"));
            if (data.voted && !data.disclosed) lines.push(t("polls.sealed"));
            if (data.choices) {
              lines.push(data.choices.map((id) => optionLabel(poll, id)).join(" → "));
            }
            out.replaceChildren(...lines.map((line) => h("p", { text: line })));
          } catch (err) {
            out.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
          }
        },
      },
      h("label", { class: "field-label", for: "poll-lookup-address", text: t("polls.address") }),
      input,
      h("button", { class: "btn", type: "submit", text: t("polls.lookupSubmit") })
    ),
    out
  );
}

export async function renderPollsIndex(main, ctx) {
  ctx.setTitle(t("polls.listTitle"));
  const data = await ctx.api("/api/polls");
  const polls = Array.isArray(data.polls) ? data.polls : [];
  main.replaceChildren(
    hPage(ctx.h, [
      banner(ctx.h),
      ctx.h("header", { class: "page-head" }, ctx.h("h1", { text: t("polls.listTitle") }), ctx.h("p", { class: "lede", text: t("polls.listLede") })),
      ctx.h("p", { class: "notice", text: t("polls.custody") }),
      polls.length
        ? ctx.h(
            "div",
            { class: "card-grid", "data-testid": "polls-list" },
            ...polls.map((poll) =>
              ctx.h(
                "article",
                { class: "election-card" },
                ctx.h("h2", { text: poll.title }),
                ctx.h("p", { text: `${poll.state} · ${typeLabel(poll)} · ${poll.tokenSymbol || poll.token}` }),
                ctx.h(
                  "p",
                  {},
                  ctx.h("a", {
                    class: "btn",
                    href: `/polls/${encodeURIComponent(poll.id)}`,
                    "data-nav": "",
                    text: t("polls.openPoll"),
                  })
                )
              )
            )
          )
        : ctx.h("p", { text: t("polls.empty") })
    ])
  );
}

function hPage(h, children) {
  return h("div", { class: "poll-page" }, ...children);
}

export async function renderPollDetail(main, ctx) {
  const { h } = ctx;
  const poll = await ctx.api(`/api/polls/${encodeURIComponent(ctx.route.params.id)}`);
  ctx.setTitle(poll.title || t("polls.listTitle"));
  main.replaceChildren(
    hPage(h, [
      banner(h),
      h("p", {}, h("a", { href: "/polls", "data-nav": "", text: t("polls.back") })),
      h("header", { class: "page-head" }, h("h1", { text: poll.title }), h("p", { class: "lede", text: t("polls.listLede") })),
      metaList(h, ctx, poll),
      h("p", { class: "notice", text: t("polls.hold") }),
      h("p", { class: "notice", text: poll.custodyNote || t("polls.custody") }),
      h("p", { class: "notice", text: t("polls.privacy") }),
      h(
        "p",
        { class: "cluster" },
        poll.state === "OPEN"
          ? h("a", {
              class: "btn",
              href: `/polls/${encodeURIComponent(poll.id)}/vote`,
              "data-nav": "",
              text: t("polls.voteLink"),
            })
          : null,
        h("a", {
          class: "btn btn-secondary",
          href: `/polls/${encodeURIComponent(poll.id)}/results`,
          "data-nav": "",
          text: t("polls.resultsLink"),
        })
      ),
    ])
  );
}

export async function renderPollVote(main, ctx) {
  const { h } = ctx;
  const poll = await ctx.api(`/api/polls/${encodeURIComponent(ctx.route.params.id)}`);
  ctx.setTitle(poll.title || t("polls.voteLink"));
  const order = (poll.options || []).map((o) => o.id);
  let selected = poll.pollType === "plurality" ? order[0] : null;
  let address = "";
  let weightText = "";
  const status = h("div", { "data-testid": "poll-vote-status" });
  const ballotMount = h("div", { id: "poll-ballot" });
  const weightLine = h("p", { "data-testid": "poll-provisional", text: "" });

  function paintBallot() {
    if (poll.pollType === "ranked_irv") {
      ballotMount.replaceChildren(h("p", { text: t("polls.rankHint") }), rankList(h, poll, order, paintBallot));
      return;
    }
    ballotMount.replaceChildren(
      h(
        "fieldset",
        {},
        h("legend", { text: poll.title }),
        ...(poll.options || []).map((opt) =>
          h(
            "label",
            { class: "choice" },
            h("input", {
              type: "radio",
              name: "poll-choice",
              value: opt.id,
              checked: selected === opt.id,
              onChange: () => {
                selected = opt.id;
              },
            }),
            h("span", { text: optionLabel(poll, opt.id) })
          )
        )
      )
    );
  }

  async function refreshWeight() {
    if (!address) {
      weightLine.textContent = "";
      return;
    }
    try {
      const data = await ctx.api(
        `/api/polls/${encodeURIComponent(poll.id)}/weight?address=${encodeURIComponent(address)}`
      );
      weightText = data.currentBalance != null ? weightLabel(data.currentBalance, poll) : "—";
      weightLine.textContent = `${t("polls.provisional")}: ${weightText}`;
    } catch (err) {
      weightLine.textContent = err.message;
    }
  }

  function choices() {
    if (poll.pollType === "ranked_irv") return [...order];
    return selected ? [selected] : [];
  }

  paintBallot();
  const lookupHost = h("section", { class: "panel" });
  lookupPanel(h, ctx, poll, lookupHost);

  main.replaceChildren(
    hPage(h, [
      banner(h),
      h("p", {}, h("a", { href: `/polls/${encodeURIComponent(poll.id)}`, "data-nav": "", text: poll.title })),
      h("header", { class: "page-head" }, h("h1", { text: t("polls.voteLink") })),
      h("p", { class: "notice", "data-testid": "poll-hold", text: t("polls.hold") }),
      h("p", { class: "notice", "data-testid": "poll-custody", text: poll.custodyNote || t("polls.custody") }),
      h("p", { class: "notice", "data-testid": "poll-privacy", text: t("polls.privacy") }),
      h(
        "p",
        {},
        h("button", {
          type: "button",
          class: "btn",
          "data-testid": "poll-connect",
          text: t("polls.connect"),
          onClick: async () => {
            try {
              address = await connectWallet();
              status.replaceChildren(h("p", { text: t("polls.connected", { address }) }));
              await refreshWeight();
            } catch (err) {
              status.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
            }
          },
        })
      ),
      status,
      weightLine,
      ballotMount,
      h("button", {
        type: "button",
        class: "btn",
        "data-testid": "poll-sign",
        text: t("polls.sign"),
        disabled: poll.state !== "OPEN",
        onClick: async () => {
          status.replaceChildren(h("p", { text: t("common.loading") }));
          try {
            if (!address) address = await connectWallet();
            const picked = choices();
            if (!picked.length) throw new Error(t("polls.sign"));
            const typed = await ctx.api(
              `/api/polls/${encodeURIComponent(poll.id)}/typed-data?address=${encodeURIComponent(address)}&choices=${encodeURIComponent(picked.join(","))}`
            );
            const eth = globalThis.ethereum;
            if (!eth) throw new Error(t("polls.noWallet"));
            const sig = await eth.request({
              method: "eth_signTypedData_v4",
              params: [address, JSON.stringify(typed.typedData)],
            });
            const cast = await ctx.api(`/api/polls/${encodeURIComponent(poll.id)}/ballots`, {
              method: "POST",
              body: {
                voter: address,
                choices: picked,
                sig,
                issuedAt: typed.issuedAt,
              },
            });
            status.replaceChildren(receiptView(h, cast.receipt || {}));
          } catch (err) {
            status.replaceChildren(h("p", { class: "notice notice-error", role: "alert", text: err.message }));
          }
        },
      }),
      lookupHost,
    ])
  );
}

function flagBadges(h, result) {
  const flags = result.flags || [];
  const badges = [];
  if (flags.includes("QUORUM_NOT_MET")) badges.push(t("polls.quorumMiss"));
  if (flags.includes("THRESHOLD_NOT_MET")) badges.push(t("polls.thresholdMiss"));
  if (flags.includes("TIE") || result.outcome === "TIE") badges.push(t("polls.tie"));
  if (result.outcome === "NO_BALLOTS") badges.push(t("polls.noBallots"));
  if (!badges.length && result.outcome) badges.push(result.outcome);
  return h(
    "p",
    { class: "cluster" },
    ...badges.map((text) => h("span", { class: "status-pill", text }))
  );
}

function countBars(h, poll, counts) {
  const entries = Object.entries(counts || {});
  let total = 0n;
  for (const [, weight] of entries) {
    try {
      total += BigInt(weight || "0");
    } catch {
      /* display only */
    }
  }
  return h(
    "ul",
    { class: "poll-bars", "data-testid": "poll-bars" },
    ...entries.map(([id, weight]) => {
      const pct = sharePercent(weight, total);
      return h(
        "li",
        {},
        h("span", { class: "poll-bar-label", text: `${optionLabel(poll, id)} · ${weightLabel(weight, poll)}` }),
        h(
          "div",
          { class: "poll-bar", role: "presentation" },
          h("span", { style: { width: `${pct}%` } })
        )
      );
    })
  );
}

export async function renderPollResults(main, ctx) {
  const { h } = ctx;
  const id = ctx.route.params.id;
  const [poll, result] = await Promise.all([
    ctx.api(`/api/polls/${encodeURIComponent(id)}`),
    ctx.api(`/api/polls/${encodeURIComponent(id)}/results`),
  ]);
  ctx.setTitle(poll.title || t("polls.resultsLink"));
  const body = [banner(h), h("p", {}, h("a", { href: `/polls/${encodeURIComponent(id)}`, "data-nav": "", text: poll.title }))];
  if (!result.official) {
    body.push(
      h("header", { class: "page-head" }, h("h1", { text: t("polls.resultsLink") })),
      h("p", { class: "notice", "data-testid": "poll-unofficial", text: result.note || t("polls.unofficial") })
    );
  } else {
    const turnout = result.turnoutBps != null ? `${Number(result.turnoutBps) / 100}%` : "—";
    body.push(
      h("header", { class: "page-head" }, h("h1", { text: poll.title }), h("p", { text: t("polls.resultsLink") })),
      flagBadges(h, result),
      h(
        "ul",
        { class: "meta-list" },
        h("li", {}, `${t("polls.outcome")}: ${result.outcome}`),
        h("li", {}, `${t("polls.winner")}: ${result.winner ? optionLabel(poll, result.winner) : "—"}`),
        h("li", {}, `${t("polls.participation")}: ${weightLabel(result.participation, poll)}`),
        h("li", {}, `${t("polls.withdrawn")}: ${weightLabel(result.withdrawnWeight, poll)}`),
        h("li", {}, `${t("polls.turnout")}: ${turnout}`)
      ),
      countBars(h, poll, result.counts),
      result.irvRounds
        ? h(
            "section",
            {},
            h("h2", { text: t("polls.rounds") }),
            ...result.irvRounds.map((round) =>
              h(
                "article",
                { class: "panel" },
                h("h3", { text: t("polls.round", { n: round.round }) }),
                round.eliminated
                  ? h("p", { text: `${t("polls.eliminated")}: ${optionLabel(poll, round.eliminated)}` })
                  : null,
                countBars(h, poll, round.counts)
              )
            )
          )
        : null,
      h(
        "p",
        {},
        h("a", {
          href: `/api/polls/${encodeURIComponent(id)}/outcome.pdf`,
          text: "PDF",
        }),
        " · ",
        h("a", {
          href: `/api/polls/${encodeURIComponent(id)}/artifacts`,
          text: "auditor",
        })
      )
    );
  }
  main.replaceChildren(hPage(h, body));
}
