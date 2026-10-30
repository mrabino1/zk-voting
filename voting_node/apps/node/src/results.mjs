// NOT FOR PROFIT — civic public good, not a commercial product.
// Certified election results from a posted tally. Plurality only (no IRV).
// Public option counts exist after tally; never invent unofficial choice totals.

import { presentTally } from './ballot.mjs';
import { electionState, publicElection } from './electionState.mjs';
import { electionTypeName, electionTypeOf, sealedResultsBody } from './electionType.mjs';
import { electionDisclosurePolicy } from './store.mjs';

const RANKED_TYPES = new Set(['RANKED', 'IRV', 'RCV', 'RANKED_CHOICE']);

const STATUS_BY_STATE = {
  0: 'created',
  1: 'roll_frozen',
  2: 'open',
  3: 'awaiting_tally',
  4: 'tallied',
};

export const POLL_RESULTS_NOTE =
  'Official results publish after the poll closes. There is no live provisional tally.';

/** Token polls never publish a running tally. Official counts exist only after close. */
export function tokenPollResultsDto(result, { tallied, pollId, state } = {}) {
  if (!tallied || !result) {
    return {
      nfp: true,
      binding: false,
      official: false,
      signal: 'Signal only · non-binding · NOT FOR PROFIT',
      pollId: pollId || null,
      state: state || null,
      note: POLL_RESULTS_NOTE,
      counts: null,
    };
  }
  return {
    ...result,
    official: true,
    nfp: true,
    binding: false,
    signal: result.signal || 'Signal only · non-binding · NOT FOR PROFIT',
  };
}

export const EMPTY_RESULT_MESSAGES = {
  created:
    'This election is not open yet. Certified option counts appear after a tally is posted.',
  roll_frozen:
    'The roll is frozen. Voting has not opened. Certified option counts appear after a tally is posted.',
  open: 'Voting is open. Option counts are not published until a certified tally is posted. Public turnout is the last hourly snapshot, not a live precinct tick.',
  awaiting_tally: 'Polls are closed. A certified tally has not been posted yet.',
  closed: 'Polls are closed. A certified tally has not been posted yet.',
};

export function isRankedType(type) {
  return RANKED_TYPES.has(String(type || '').toUpperCase().replace(/[\s-]+/g, '_'));
}

export function optionSlotCount(questions) {
  if (!Array.isArray(questions) || !questions.length) return 0;
  return questions.reduce((n, q) => n + Math.max(q.options?.length || 0, 1), 0);
}

export function seatsForQuestion(question) {
  const raw = Number(question?.maxSelections ?? question?.max ?? question?.seats);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return 1;
}

export function sliceOptionCounts(questions, counts) {
  const list = Array.isArray(questions) ? questions : [];
  const nums = Array.isArray(counts) ? counts.map((n) => Number(n)) : null;
  let offset = 0;
  return list.map((question, qi) => {
    const options =
      Array.isArray(question.options) && question.options.length
        ? question.options
        : [{ id: `o${qi + 1}`, label: 'Option' }];
    const width = Math.max(options.length, 1);
    const slice = nums ? nums.slice(offset, offset + width) : null;
    offset += width;
    return { question, options, counts: slice };
  });
}

function namesList(rows) {
  if (!rows.length) return '';
  if (rows.length === 1) return rows[0].label;
  if (rows.length === 2) return `${rows[0].label} and ${rows[1].label}`;
  return `${rows
    .slice(0, -1)
    .map((o) => o.label)
    .join(', ')}, and ${rows[rows.length - 1].label}`;
}

export function pluralityOutcome(options, seats = 1) {
  const k = Math.max(1, Number(seats) || 1);
  const rows = (options || []).map((o) => ({
    id: String(o.id),
    label: String(o.label),
    count: Number(o.count) || 0,
  }));
  const max = rows.reduce((m, o) => Math.max(m, o.count), 0);
  if (max <= 0) {
    return {
      status: 'no_votes',
      method: 'plurality',
      seats: k,
      winner: null,
      winners: [],
      tied: [],
      note: 'No votes were counted for any option.',
    };
  }

  if (k === 1) {
    const tied = rows.filter((o) => o.count === max);
    if (tied.length > 1) {
      return {
        status: 'tie',
        method: 'plurality',
        seats: k,
        winner: null,
        winners: [],
        tied,
        note: `Tie between ${namesList(tied)} with ${max} vote${max === 1 ? '' : 's'} each.`,
      };
    }
    return {
      status: 'winner',
      method: 'plurality',
      seats: k,
      winner: tied[0],
      winners: tied,
      tied: [],
      note: `${tied[0].label} wins with ${tied[0].count} vote${tied[0].count === 1 ? '' : 's'}.`,
    };
  }

  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const cutoffCount = sorted[Math.min(k, sorted.length) - 1]?.count ?? 0;
  const elected = rows.filter((o) => o.count > cutoffCount);
  const atCutoff = rows.filter((o) => o.count === cutoffCount && cutoffCount > 0);
  const remaining = k - elected.length;
  if (atCutoff.length <= remaining) {
    const winners = [...elected, ...atCutoff];
    return {
      status: 'winner',
      method: 'plurality',
      seats: k,
      winner: winners.length === 1 ? winners[0] : null,
      winners,
      tied: [],
      note:
        winners.length === 1
          ? `${winners[0].label} wins with ${winners[0].count} vote${winners[0].count === 1 ? '' : 's'}.`
          : `Plurality winners (${winners.length} of ${k} seats): ${namesList(winners)}.`,
    };
  }
  return {
    status: 'tie',
    method: 'plurality',
    seats: k,
    winner: null,
    winners: elected,
    tied: atCutoff,
    note: elected.length
      ? `${namesList(elected)} elected. Tie for the remaining seat${remaining === 1 ? '' : 's'} between ${namesList(atCutoff)} (${cutoffCount} votes).`
      : `Tie for ${k} seat${k === 1 ? '' : 's'} between ${namesList(atCutoff)} with ${cutoffCount} votes each.`,
  };
}

function normalizeOptions(question) {
  if (Array.isArray(question.options) && question.options.length) {
    return question.options.map((opt, i) => ({
      id: String(opt.id || `o${i + 1}`),
      label: String(opt.label || opt.name || opt.id || `Option ${i + 1}`),
    }));
  }
  const type = String(question.type || '').toUpperCase();
  if (type === 'YES_NO' || !type) {
    return [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }
  return [];
}

export function questionResult(question, optionCounts, { available, labeled } = {}) {
  const type = String(question.type || 'YES_NO');
  const ranked = isRankedType(type) || labeled?.tallyMethod === 'irv' || labeled?.ballotMethod === 'ranked_choice';
  const seats = seatsForQuestion(question);
  const irvReady = Boolean(ranked && labeled && labeled.tallied !== false && (labeled.winner != null || Array.isArray(labeled.rounds)));
  const meta = normalizeOptions(question);
  const countsFromLabeled =
    irvReady && Array.isArray(labeled.options)
      ? labeled.options.map((o) => (o.count == null ? null : Number(o.count) || 0))
      : optionCounts;
  const options = meta.map((opt, i) => {
    const count =
      available && Array.isArray(countsFromLabeled) && countsFromLabeled[i] != null
        ? Number(countsFromLabeled[i]) || 0
        : available && Array.isArray(optionCounts)
          ? Number(optionCounts[i]) || 0
          : null;
    return { ...opt, count, share: null };
  });
  const totalVotes = available ? options.reduce((n, o) => n + (Number(o.count) || 0), 0) : null;
  if (available && totalVotes > 0) {
    for (const o of options) o.share = Number(o.count) / totalVotes;
  }

  const base = {
    id: String(question.id || ''),
    type,
    prompt: String(question.prompt || question.title || ''),
    seats,
    method: ranked ? (irvReady ? 'irv' : 'ranked_choice_not_computed') : 'plurality',
    totalVotes,
    options,
    rounds: irvReady ? labeled.rounds || [] : undefined,
    tieBroken: irvReady ? Boolean(labeled.tieBroken) : undefined,
    undervotes: labeled?.undervotes ?? null,
  };

  if (!available) {
    return { ...base, outcome: null };
  }
  if (ranked && irvReady) {
    const winnerId = labeled.winner != null ? String(labeled.winner) : null;
    const winnerOpt = winnerId ? options.find((o) => String(o.id) === winnerId) : null;
    const winner = winnerOpt
      ? { id: winnerOpt.id, label: labeled.winnerLabel || winnerOpt.label, count: winnerOpt.count }
      : winnerId
        ? { id: winnerId, label: labeled.winnerLabel || winnerId, count: null }
        : null;
    return {
      ...base,
      outcome: {
        status: winner ? 'winner' : 'not_computed',
        method: 'irv',
        seats,
        winner,
        winners: winner ? [winner] : [],
        tied: [],
        rounds: labeled.rounds || [],
        tieBroken: Boolean(labeled.tieBroken),
        note: winner
          ? `${winner.label} wins by instant-runoff.${labeled.tieBroken ? ' A first-place tie was broken by lexicographic option id.' : ''}`
          : 'Ranked-choice / IRV was posted without a winner.',
      },
    };
  }
  if (ranked) {
    return {
      ...base,
      outcome: {
        status: 'not_computed',
        method: 'ranked_choice_not_computed',
        seats,
        winner: null,
        winners: [],
        tied: [],
        note: labeled?.note || 'Ranked-choice / IRV winner is not computed on this page. Option counts are shown when a tally exists; they are not an IRV result.',
      },
    };
  }
  return {
    ...base,
    outcome: pluralityOutcome(
      options.map((o) => ({ id: o.id, label: o.label, count: o.count })),
      seats,
    ),
  };
}

export function buildResults(election, extra = {}) {
  const now = extra.now ?? Math.floor(Date.now() / 1000);
  const publishedAcceptedBallots = extra.publishedAcceptedBallots;
  const state = electionState(election, now);
  const status = STATUS_BY_STATE[state] || 'created';
  const available = Boolean(election?.tally && (Array.isArray(election.tally.counts) || Array.isArray(election.tally.questions)));
  const slices = sliceOptionCounts(election?.questions || [], available ? election.tally.counts : null);
  const labeledTally = presentTally(election, election.acceptedBallots);
  const questions = slices.map(({ question, counts }) => {
    const labeled = labeledTally?.questions?.find((row) => String(row.id) === String(question.id));
    return questionResult(question, counts, { available, labeled });
  });
  return {
    available,
    status,
    method: 'plurality',
    emptyReason: available ? null : status,
    message: available
      ? 'Certified plurality results from the posted tally. Individual choices are never shown. Explorer vote rows still follow hourly disclosure.'
      : EMPTY_RESULT_MESSAGES[status] || EMPTY_RESULT_MESSAGES.awaiting_tally,
    questions,
    tallyPostedAt: election?.tally?.postedAt || null,
    certifiedBallots: available
      ? election.tally.counts.reduce((n, c) => n + (Number(c) || 0), 0)
      : null,
    publishedAcceptedBallots:
      typeof publishedAcceptedBallots === 'number' ? publishedAcceptedBallots : null,
  };
}

export function presentResults(election, deps, opts = {}) {
  const now = opts.now ?? deps.config.nowFn();
  const policy = electionDisclosurePolicy(election, deps.config, now);
  if (policy.resultsSealed) {
    const publishedAcceptedBallots = deps.store.publishedAcceptedBallots(
      election.id,
      now,
      policy.intervalSeconds,
      policy,
    );
    const dto = publicElection(election, now, {
      intervalSeconds: policy.intervalSeconds,
      delaySeconds: policy.delaySeconds,
      minBlockVotes: policy.minBlockVotes,
      publishedAcceptedBallots,
      resultsSealed: true,
    });
    const seal = sealedResultsBody(election, now);
    return {
      ...dto,
      ...seal,
      electionId: String(election.id),
      acceptedBallots: publishedAcceptedBallots,
      tally: null,
      results: {
        available: false,
        sealed: true,
        status: 'sealed',
        method: election.ballotMethod || 'plurality',
        emptyReason: 'sealed',
        message: seal.message,
        questions: (election.questions || []).map((question) => ({
          id: question.id,
          type: question.type,
          prompt: question.prompt,
          options: (question.options || []).map((option) => ({
            id: option.id,
            label: option.label,
          })),
          outcome: null,
        })),
        tallyPostedAt: null,
        certifiedBallots: null,
        publishedAcceptedBallots,
      },
      explorerPath: `/explorer#/election/${encodeURIComponent(String(election.id))}`,
    };
  }
  const publishedAcceptedBallots = deps.store.publishedAcceptedBallots(
    election.id,
    now,
    policy.intervalSeconds,
    policy,
  );
  const dto = publicElection(election, now, {
    intervalSeconds: policy.intervalSeconds,
    delaySeconds: policy.delaySeconds,
    resultsMinVotes: policy.minVotes,
    minBlockVotes: policy.minBlockVotes,
    publishedAcceptedBallots,
    resultsSealed: false,
  });
  return {
    ...dto,
    electionId: String(election.id),
    electionType: electionTypeOf(election),
    electionTypeName: electionTypeName(election),
    resultsSealed: false,
    results: buildResults(election, { now, publishedAcceptedBallots }),
    explorerPath: `/explorer#/election/${encodeURIComponent(String(election.id))}`,
  };
}
