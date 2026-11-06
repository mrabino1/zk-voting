// NOT FOR PROFIT — weighted plurality, IRV, quorum, and threshold.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { computeIrv } from '../src/irv.mjs';
import { evaluateWeightedPoll, integerSquareRoot, tallyWeightedPlurality } from '../src/weightedTally.mjs';

describe('weighted tally', () => {
  test('plurality and IRV match hand fixtures, including values above 2^53', () => {
    const huge = 2n ** 53n + 17n;
    const six = 1_500_000n;
    const plurality = tallyWeightedPlurality(
      ['a', 'b', 'abstain'],
      [
        { choices: ['a'], weight: huge },
        { choices: ['b'], weight: six },
        { choices: ['abstain'], weight: 6n },
      ],
    );
    assert.equal(plurality.winner, 'a');
    assert.equal(plurality.counts.a, huge);
    assert.equal(plurality.counts.b, six);
    assert.equal(plurality.tie, false);

    const irv = evaluateWeightedPoll({
      pollType: 'ranked_irv',
      optionIds: ['a', 'b', 'c', 'abstain'],
      ballots: [
        { choices: ['a', 'b'], weight: 10n },
        { choices: ['b', 'c'], weight: 6n },
        { choices: ['c', 'a'], weight: 5n },
        { choices: ['abstain'], weight: 4n },
      ],
      quorum: null,
      passThresholdBps: null,
      totalSupply: 100n,
    });
    assert.equal(irv.winner, 'a');
    assert.equal(irv.participation, 25n);
    assert.equal(irv.irv.rounds[0].counts.c, 5n);
    assert.equal(irv.irv.rounds[1].counts.a, 15n);
    assert.equal(irv.outcome, 'WINNER');
  });

  test('weight-1 IRV matches unweighted computeIrv', () => {
    const ballots = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'b'],
    ];
    const plain = computeIrv(['a', 'b', 'c'], ballots);
    const weighted = evaluateWeightedPoll({
      pollType: 'ranked_irv',
      optionIds: ['a', 'b', 'c'],
      ballots: ballots.map((choices) => ({ choices, weight: 1n })),
      quorum: null,
      passThresholdBps: null,
      totalSupply: 10n,
    });
    assert.equal(weighted.winner, plain.winner);
  });

  test('quorum and threshold flags sit on the exact boundary', () => {
    const base = {
      pollType: 'plurality',
      optionIds: ['a', 'b', 'abstain'],
      quorum: { mode: 'absolute', value: '100' },
      passThresholdBps: 5000,
      totalSupply: 1000n,
    };
    const met = evaluateWeightedPoll({
      ...base,
      ballots: [
        { choices: ['a'], weight: 50n },
        { choices: ['b'], weight: 50n },
      ],
    });
    assert.equal(met.flags.includes('QUORUM_NOT_MET'), false);
    assert.equal(met.flags.includes('TIE'), true);
    assert.equal(met.outcome, 'TIE');

    const under = evaluateWeightedPoll({
      ...base,
      ballots: [
        { choices: ['a'], weight: 50n },
        { choices: ['b'], weight: 49n },
      ],
    });
    assert.ok(under.flags.includes('QUORUM_NOT_MET'));
    assert.equal(under.outcome, 'QUORUM_NOT_MET');

    const bps = evaluateWeightedPoll({
      pollType: 'plurality',
      optionIds: ['a', 'b'],
      ballots: [
        { choices: ['a'], weight: 400n },
        { choices: ['b'], weight: 0n },
      ],
      quorum: { mode: 'bps_of_supply', value: '4000' },
      passThresholdBps: 5000,
      totalSupply: 1000n,
    });
    assert.equal(bps.flags.includes('QUORUM_NOT_MET'), false);
    assert.equal(bps.outcome, 'WINNER');

    const bpsUnder = evaluateWeightedPoll({
      ...bps,
      ballots: [{ choices: ['a'], weight: 399n }],
      quorum: { mode: 'bps_of_supply', value: '4000' },
      passThresholdBps: null,
      pollType: 'plurality',
      optionIds: ['a', 'b'],
      totalSupply: 1000n,
    });
    assert.ok(bpsUnder.flags.includes('QUORUM_NOT_MET'));

    const threshold = evaluateWeightedPoll({
      pollType: 'plurality',
      optionIds: ['a', 'b'],
      ballots: [
        { choices: ['a'], weight: 50n },
        { choices: ['b'], weight: 50n },
      ],
      quorum: null,
      passThresholdBps: 5001,
      totalSupply: 1000n,
    });
    assert.equal(threshold.outcome, 'TIE');

    const justUnder = evaluateWeightedPoll({
      pollType: 'plurality',
      optionIds: ['a', 'b'],
      ballots: [
        { choices: ['a'], weight: 49n },
        { choices: ['b'], weight: 51n },
      ],
      quorum: null,
      passThresholdBps: 5000,
      totalSupply: 1000n,
    });
    assert.equal(justUnder.winner, 'b');
    assert.equal(justUnder.flags.includes('THRESHOLD_NOT_MET'), false);

    const miss = evaluateWeightedPoll({
      pollType: 'plurality',
      optionIds: ['a', 'b'],
      ballots: [
        { choices: ['a'], weight: 49n },
        { choices: ['b'], weight: 51n },
      ],
      quorum: null,
      passThresholdBps: 5200,
      totalSupply: 1000n,
    });
    assert.ok(miss.flags.includes('THRESHOLD_NOT_MET'));
    assert.equal(miss.outcome, 'THRESHOLD_NOT_MET');
  });

  test('integer square root is exact for squares and floors the rest', () => {
    assert.equal(integerSquareRoot(0n), 0n);
    assert.equal(integerSquareRoot(1n), 1n);
    assert.equal(integerSquareRoot(2n), 1n);
    assert.equal(integerSquareRoot(9n), 3n);
    assert.equal(integerSquareRoot(10n), 3n);
    const huge = 10n ** 40n + 17n;
    const root = integerSquareRoot(huge);
    assert.ok(root * root <= huge);
    assert.ok((root + 1n) * (root + 1n) > huge);
  });

  test('quadratic counting uses the square root and keeps gross participation', () => {
    const math = evaluateWeightedPoll({
      pollType: 'plurality',
      optionIds: ['yes', 'no', 'abstain'],
      ballots: [
        { choices: ['yes'], weight: 81n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['no'], weight: 1n },
        { choices: ['abstain'], weight: 16n },
      ],
      quorum: null,
      passThresholdBps: null,
      totalSupply: 200n,
      weighting: 'quadratic',
      decisionRule: 'simple_majority',
    });
    assert.equal(math.participation, 81n + 10n + 16n);
    assert.equal(math.counts.yes, 9n);
    assert.equal(math.counts.no, 10n);
    assert.equal(math.counts.abstain, 4n);
    assert.equal(math.grossCounts.yes, 81n);
    assert.equal(math.winner, 'no');
    assert.equal(math.outcome, 'WINNER');

    const scaled = evaluateWeightedPoll({
      pollType: 'plurality',
      optionIds: ['yes', 'no'],
      ballots: [
        { choices: ['yes'], weight: 81n * 10n ** 18n },
        { choices: ['no'], weight: 100n * 10n ** 18n },
      ],
      quorum: null,
      passThresholdBps: null,
      totalSupply: 200n * 10n ** 18n,
      weighting: 'quadratic',
      decisionRule: 'simple_majority',
      decimals: 18,
    });
    assert.equal(scaled.counts.yes, 9n);
    assert.equal(scaled.counts.no, 10n);
    assert.equal(scaled.grossCounts.yes, 81n * 10n ** 18n);
    assert.equal(scaled.participation, 181n * 10n ** 18n);
    assert.equal(scaled.winner, 'no');
  });

  test('simple majority withholds a winner who only leads', () => {
    const base = {
      pollType: 'plurality',
      optionIds: ['a', 'b', 'c', 'abstain'],
      quorum: null,
      passThresholdBps: null,
      totalSupply: 100n,
      ballots: [
        { choices: ['a'], weight: 40n },
        { choices: ['b'], weight: 35n },
        { choices: ['c'], weight: 25n },
      ],
    };
    const strict = evaluateWeightedPoll({ ...base, decisionRule: 'simple_majority' });
    assert.equal(strict.outcome, 'NO_MAJORITY');
    assert.equal(strict.winner, null);
    assert.equal(strict.leader, 'a');
    assert.ok(strict.flags.includes('NO_MAJORITY'));

    const most = evaluateWeightedPoll(base);
    assert.equal(most.outcome, 'WINNER');
    assert.equal(most.winner, 'a');

    const clear = evaluateWeightedPoll({
      ...base,
      decisionRule: 'simple_majority',
      ballots: [
        { choices: ['a'], weight: 60n },
        { choices: ['b'], weight: 30n },
        { choices: ['c'], weight: 10n },
      ],
    });
    assert.equal(clear.winner, 'a');
    assert.equal(clear.outcome, 'WINNER');
  });

  test('weight modules do not use floating point', () => {
    const files = ['weightedTally.mjs', 'holdWeight.mjs'];
    for (const file of files) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      assert.equal(/\bparseFloat\b|\btoFixed\b|\bMath\./.test(src), false, file);
      assert.equal(/\d+\.\d+/.test(src), false, file);
    }
  });
});
