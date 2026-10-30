// NOT FOR PROFIT — civic public good, not a commercial product.
// Poll vs Vote section on the public landing page: structure, accessible
// name, and the same ten locales as the Node UI.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../public/i18n.js';
import { DEFAULT_BRAND_NAME, brandName } from '../../../../site/public/brand.js';
import {
  HTML_LANG,
  LOCALE_CODES,
  catalogs,
  flattenKeys,
  flowLaneTransform,
  lookup,
  safeHtml,
  sectionDirection,
  translate,
  translateMarkup,
} from '../../../../site/public/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const siteDir = join(root, 'site/public');
const pagePath = join(siteDir, 'index.html');
const cssPath = join(siteDir, 'styles.css');

const BANNED = new RegExp("zk" + "-?" + "vote" + "|" + "zk" + "voting" + "|" + "re" + "public" + "|" + "\\bcertified\\b", "i");

function pageHtml() {
  return readFileSync(pagePath, 'utf8');
}

function regionOf(html) {
  const start = html.indexOf('id="poll-vs-vote"');
  const end = html.indexOf('<ol class="steps"');
  assert.ok(start > 0 && end > start, 'poll vs vote region sits above the steps');
  return html.slice(start, end);
}

function accessibleName(html) {
  const open = html.match(/<svg\b[^>]*\bid="ballot-flow"[^>]*>/);
  assert.ok(open, 'flow svg');
  assert.match(open[0], /\brole="img"/);
  assert.match(open[0], /\baria-labelledby="flow-title flow-desc"/);
  const parts = ['flow-title', 'flow-desc'].map((id) => {
    const re = new RegExp(`<([a-zA-Z0-9:-]+)\\b[^>]*\\bid="${id}"[^>]*>([^<]*)</\\1>`);
    const found = html.match(re);
    assert.ok(found, `accessible name part #${id}`);
    return found[2].trim();
  });
  return parts.join(' ').replace(/\s+/g, ' ');
}

test('renders the poll vs vote section, both columns, and the named flow graphic', () => {
  const html = translateMarkup(pageHtml(), 'en');
  const region = regionOf(html);
  assert.match(region, /id="poll-vs-vote"/);
  assert.match(region, /id="poll-column"/);
  assert.match(region, /id="vote-column"/);
  assert.match(region, /class="ballot-compare"/);
  assert.ok(region.indexOf('id="poll-column"') < region.indexOf('id="vote-column"'));
  const name = accessibleName(region);
  assert.match(name, /Ballot flow for a poll and a vote/);
  assert.match(name, /final tally/i);
  assert.doesNotMatch(name, /certified/i);
  assert.doesNotMatch(region, BANNED);
  assert.match(region, /k-of-n guardians/);
  assert.match(region, /100 distinct voters have cast a ballot/);
  assert.doesNotMatch(region, /100 first ballots/);
  assert.match(region, /30-minute delay/);
  assert.match(region, /30 minutes delayed/);
  assert.match(region, /fewer than 10 ballots/);
  assert.match(region, /at least 10/);
  assert.match(region, /challenge window/i);
  assert.match(region, /longer than zero/);
  assert.match(region, /re-vote/);
  assert.match(region, /including a re-vote/);
  assert.match(region, /no padding/);
  assert.match(region, /supplementary batch/);
  assert.match(region, /Published hourly blocks never change/);
  assert.doesNotMatch(region, /almost-live/);
  assert.doesNotMatch(region, /Results freeze/);
  assert.doesNotMatch(region, /data-i18n="pollVote\.vote\.turnout"/);
  assert.match(region, /data-i18n="pollVote\.both\.turnout"/);
});

test('Spanish render keeps both columns and translates the accessible name', () => {
  const html = translateMarkup(pageHtml(), 'es');
  const region = regionOf(html);
  const poll = region.split('id="vote-column"')[0];
  const vote = region.split('id="vote-column"')[1];
  assert.match(poll, />Encuesta</);
  assert.match(vote, />Votación</);
  const name = accessibleName(region);
  assert.match(name, /encuesta/i);
  assert.match(name, /escrutinio final/i);
  assert.doesNotMatch(name, /Ballot flow/);
  assert.match(html, /data-brand><span class="brand-zk">ZK<\/span><span class="brand-rest">-Voting<\/span>/);
});

test('display name is filled from the branding helper', () => {
  assert.equal(brandName(), DEFAULT_BRAND_NAME);
  const html = pageHtml();
  assert.match(html, /<span class="wordmark" title="ZK-Voting"><span data-brand>/);
  assert.match(html, /<meta name="brand-name" content="ZK-Voting">/);
  const branded = translateMarkup(html, 'en', 'Civic Desk');
  assert.match(branded, /data-brand>[^<]*(?:<span[^>]*>)?Civic Desk/);
  assert.match(branded, /aria-label="Civic Desk on GitHub"/);
  assert.match(branded, /<title[^>]*>Civic Desk: private ballots/);
  assert.doesNotMatch(regionOf(branded), /ZK-Voting/);
  assert.doesNotMatch(html, /ZK Voting/);
  assert.match(html, /ZK-Voting/);
});

test('poll vs vote copy covers the same keys in all 10 locales', () => {
  assert.deepEqual([...LOCALE_CODES], [...SUPPORTED_LOCALES]);
  assert.equal(LOCALE_CODES.length, 10);
  assert.equal(HTML_LANG.ar, 'ar');
  assert.equal(HTML_LANG.zh, 'zh-Hans');
  assert.equal(HTML_LANG.pt, 'pt-BR');
  assert.equal(sectionDirection('ar'), 'rtl');
  assert.equal(sectionDirection('en'), 'ltr');
  assert.equal(sectionDirection('he'), 'ltr');

  const dicts = catalogs();
  const enKeys = flattenKeys(dicts.en).sort();
  assert.ok(enKeys.length >= 170);
  const html = pageHtml();
  const used = [];
  for (const attr of ['data-i18n', 'data-i18n-html', 'data-i18n-content', 'data-i18n-aria-label']) {
    used.push(...[...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]));
  }
  assert.ok(used.length >= 160);
  for (const key of used) {
    assert.equal(typeof lookup(dicts.en, key), 'string', `missing ${key}`);
  }
  const usedSet = new Set(used);
  for (const key of enKeys) {
    if (key.startsWith('lang.') && key !== 'lang.label') continue;
    assert.ok(usedSet.has(key), `landing page does not use ${key}`);
  }
  assert.equal(lookup(dicts.en, 'pollVote.vote.turnout'), undefined);
  assert.match(lookup(dicts.en, 'pollVote.both.turnout'), /no padding/);
  assert.match(lookup(dicts.en, 'pollVote.both.batch'), /supplementary batch/);
  assert.match(lookup(dicts.en, 'pollVote.both.receipt'), /including a re-vote/);
  assert.match(lookup(dicts.en, 'pollVote.both.challenge'), /longer than zero/);
  assert.match(lookup(dicts.en, 'pollVote.poll.freeze'), /Published hourly blocks never change/);
  assert.match(lookup(dicts.en, 'pollVote.poll.merge'), /at least 10/);
  assert.match(lookup(dicts.en, 'how.s5body'), /stay as first published/);
  assert.match(lookup(dicts.en, 'how.s5body'), /Anyone can check that the published totals match the accepted ballots/);
  assert.match(html, /once 100 distinct voters have cast a ballot or the scheduled end, whichever comes first/);
  assert.match(html, /Counts stay hidden until 100 distinct voters have cast a ballot, or the scheduled end, whichever comes first/);
  assert.doesNotMatch(html, /or the poll ends/);
  assert.doesNotMatch(html, /100 first ballots/);
  assert.doesNotMatch(lookup(dicts.en, 'hero.lead'), /100 first ballots/);
  assert.doesNotMatch(lookup(dicts.en, 'how.s4body'), /100 first ballots/);
  assert.doesNotMatch(lookup(dicts.en, 'pollVote.poll.gate'), /100 first ballots/);
  assert.match(html, /A poll.s published hourly blocks are designed to stay as first published/);
  assert.match(html, /data-i18n="nav\.pollVsVote"/);
  assert.equal(lookup(dicts.en, 'nav.pollVsVote'), 'Poll vs Vote');
  assert.doesNotMatch(html, /class="ballot-visual" dir="ltr"/);
  assert.match(html, /id="flow-poll-lane"/);
  assert.match(html, /id="flow-vote-lane"/);
  assert.deepEqual(flowLaneTransform('rtl'), { poll: 'translate(236 0)', vote: 'translate(-236 0)' });
  assert.deepEqual(flowLaneTransform('ltr'), { poll: '', vote: '' });
  assert.equal(safeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(safeHtml('A <span class="accent">b</span><br>c'), 'A <span class="accent">b</span><br>c');
  assert.match(translate('es', 'meta.title', 'Civic Desk'), /Civic Desk/);
  assert.match(translate('ar', 'hero.title'), /[\u0600-\u06FF]/);

  for (const code of LOCALE_CODES) {
    const keys = flattenKeys(dicts[code]).sort();
    assert.deepEqual(keys, enKeys, `${code} key set`);
    for (const key of enKeys) {
      const value = lookup(dicts[code], key);
      assert.equal(typeof value, 'string');
      assert.ok(value.trim().length > 0, `${code} ${key} empty`);
      assert.doesNotMatch(value, BANNED, `${code} ${key}`);
      assert.doesNotMatch(value, /https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}/i, `${code} ${key}`);
      if (code === 'en') continue;
      if (key.startsWith('lang.') && key !== 'lang.label') continue;
      assert.notEqual(value, lookup(dicts.en, key), `${code} ${key} is an English copy`);
    }
  }

  assert.match(lookup(dicts.ar, 'pollVote.poll.name'), /[\u0600-\u06FF]/);
  assert.match(lookup(dicts.zh, 'pollVote.poll.name'), /[\u4e00-\u9fff]/);
  assert.match(lookup(dicts.ko, 'pollVote.poll.name'), /[\uac00-\ud7af]/);
  assert.match(lookup(dicts.hi, 'pollVote.poll.name'), /[\u0900-\u097F]/);
});

const BOTH_TURNOUT =
  'Turnout is public every hour for both kinds. A poll also publishes per-choice counts on a 30-minute-delayed hourly schedule once 100 voters have cast their first ballot or the poll ends.';
const POLL_TURNOUT = 'Turnout is public every hour, as in a poll.';

const TURNOUT_GATE = {
  en: { turnout: /\bturnout\b/i, gate: /\b(?:first 100 ballots|100 first ballots)\b/i, tied: /100 distinct voters/i },
  es: { turnout: /participaci[oó]n/i, gate: /primeras 100 boletas/i, tied: /100 votantes distintos/i },
  fr: { turnout: /participation/i, gate: /100 premiers bulletins/i, tied: /100 votants distincts/i },
  pt: { turnout: /comparecimento/i, gate: /primeiras 100 c[eé]dulas/i, tied: /100 eleitores distintos/i },
  zh: { turnout: /投票率/, gate: /最先的 100/, tied: /100 位不同的投票人/ },
  ar: { turnout: /نسبة المشاركة/, gate: /أول 100/, tied: /100 ناخب مختلف/ },
  ko: { turnout: /투표율/, gate: /처음 100장/, tied: /서로 다른 투표자 100명/ },
  hi: { turnout: /मतदान प्रतिशत/, gate: /पहले 100 मत/, tied: /100 अलग-अलग मतदाता/ },
  vi: { turnout: /Tỷ lệ tham gia/, gate: /100 phiếu đầu/i, tied: /100 cử tri khác nhau/ },
  fil: { turnout: /\bturnout\b/i, gate: /unang 100 balota/i, tied: /100 magkakaibang botante/i },
};

function sentencesOf(value) {
  return value.split(/[.!?。！？।۔]+/).map((part) => part.trim()).filter(Boolean);
}

test('turnout, re-voting and privacy copy match the agreed wording', () => {
  const html = pageHtml();
  const dicts = catalogs();
  const voterKeys = ['hero.lead', 'why.publicBody', 'why.coerceBody', 'who.clubsBody', 'who.auditorsBody', 'how.s4body', 'pollVote.poll.gate'];
  for (const key of ['hero.lead', 'why.publicBody', 'who.clubsBody', 'who.auditorsBody']) {
    assert.match(lookup(dicts.en, key), /Turnout is published on a delayed hourly schedule for both kinds\./);
    assert.match(lookup(dicts.en, key), /once 100 distinct voters have cast a ballot or the scheduled end, whichever comes first/);
  }
  for (const key of ['why.oneBody', 'how.s3body', 'pollVote.both.revote']) {
    assert.match(lookup(dicts.en, key), /The operator decides at creation whether re-voting is allowed, and that setting can't be changed afterward\./);
    assert.match(lookup(dicts.en, key), /If not, a second ballot is rejected\./);
  }
  assert.match(lookup(dicts.en, 'hero.lead'), /That setting can't be changed afterward\./);
  assert.match(lookup(dicts.en, 'hero.lead'), /Individual choices are designed not to be published\./);
  assert.match(lookup(dicts.en, 'hero.lead'), /\(tests currently use a mock verifier\)/);
  assert.match(lookup(dicts.en, 'why.privateBody'), /designed so they don't show how you voted/);
  assert.match(lookup(dicts.en, 'vision.l2p2'), /with the mock verifier in tests, this check is not yet enforced/);
  assert.match(html, /designed so they don't show how you voted/);
  assert.match(html, /with the mock verifier in tests, this check is not yet enforced/);
  assert.equal(lookup(dicts.en, 'hero.title'), 'Ballots designed so nobody can read them.');
  assert.match(html, /Ballots designed so nobody can read them/);
  assert.match(lookup(dicts.en, 'pollVote.vote.guardians'), /The design gives the operator no key share\./);
  assert.match(lookup(dicts.en, 'pollVote.vote.keyL2'), /public key posted on the L2/);
  assert.match(lookup(dicts.en, 'pollVote.vote.shamir'), /Shamir/);
  assert.match(html, /data-i18n="pollVote.vote.keyL2"/);
  assert.match(html, /data-i18n="pollVote.vote.shamir"/);
  const keyL2At = html.indexOf('data-i18n="pollVote.vote.keyL2"');
  const shamirAt = html.indexOf('data-i18n="pollVote.vote.shamir"');
  assert.ok(keyL2At !== -1 && shamirAt !== -1 && keyL2At < shamirAt);
  for (const banned of [/Nobody's choice is ever published/, /can't show how you voted/, /Individual choices are not published/, /Turnout is public every hour/, /or the poll ends/, /locked until the election ends/]) {
    assert.doesNotMatch(html, banned);
  }
  const marks = {
    en: { voters: /100 distinct voters/, end: /or the scheduled end, whichever comes first/, locked: /that setting can't be changed afterward/i, l2p2: /mock verifier in tests/, privateBody: /designed so they don't show how you voted/ },
    es: { voters: /100 votantes distintos/, end: /o el final previsto, lo que ocurra primero/, locked: /no se puede cambiar después/, l2p2: /verificador simulado/, privateBody: /no mostrar cómo votaste/ },
    fr: { voters: /100 votants distincts/, end: /ou la fin prévue, selon ce qui arrive en premier/, locked: /ne peut plus être modifié par la suite/, l2p2: /vérificateur fictif/, privateBody: /ne pas révéler votre vote/ },
    pt: { voters: /100 eleitores distintos/, end: /ou o fim previsto, o que vier primeiro/, locked: /não pode ser alterada depois/, l2p2: /verificador simulado/, privateBody: /não mostrar como você votou/ },
    zh: { voters: /100 位不同的投票人/, end: /或预定结束时（以先到者为准）/, locked: /该设置之后不能更改/, l2p2: /模拟验证器/, privateBody: /不显示你如何投票/ },
    ar: { voters: /100 ناخب مختلف/, end: /أو النهاية المقررة، أيهما أسبق/, locked: /لا يمكن تغيير هذا الإعداد بعد ذلك/, l2p2: /المُحقق الوهمي/, privateBody: /لا تُظهر كيف صوّتّ/ },
    ko: { voters: /서로 다른 투표자 100명/, end: /예정된 종료\(먼저 오는 쪽\)/, locked: /이후에는 바꿀 수 없습니다/, l2p2: /모의 검증기/, privateBody: /어떻게 투표했는지/ },
    hi: { voters: /100 अलग-अलग मतदाता/, end: /या तय समाप्ति, जो पहले हो/, locked: /बाद में नहीं बदली जा सकती/, l2p2: /नकली सत्यापक/, privateBody: /आपने कैसे वोट किया/ },
    vi: { voters: /100 cử tri khác nhau/, end: /hoặc thời điểm kết thúc dự kiến, tùy điều nào đến trước/, locked: /không thể thay đổi sau đó/, l2p2: /xác minh giả/, privateBody: /bạn đã bầu thế nào/ },
    fil: { voters: /100 magkakaibang botante/, end: /o ang nakatakdang pagtatapos, alinman ang mauna/, locked: /Hindi na mababago ang setting na iyon pagkatapos|hindi na mababago ang setting na iyon pagkatapos/, l2p2: /kunwang tagapagpatunay/, privateBody: /kung paano ka bumoto/ },
  };
  for (const code of LOCALE_CODES) {
    const mark = marks[code];
    for (const key of voterKeys) {
      assert.match(lookup(dicts[code], key), mark.voters, `${code} ${key}`);
      assert.match(lookup(dicts[code], key), mark.end, `${code} ${key}`);
    }
    for (const key of ['hero.lead', 'why.oneBody', 'how.s3body', 'pollVote.both.revote']) {
      assert.match(lookup(dicts[code], key), mark.locked, `${code} ${key}`);
    }
    assert.match(lookup(dicts[code], 'vision.l2p2'), mark.l2p2, `${code} vision.l2p2`);
    assert.match(lookup(dicts[code], 'why.privateBody'), mark.privateBody, `${code} why.privateBody`);
    assert.match(lookup(dicts.en, 'why.coerceBody'), /Turnout is published on a delayed hourly schedule, as in a poll\./);
    const rules = TURNOUT_GATE[code];
    for (const key of flattenKeys(dicts[code])) {
      for (const sentence of sentencesOf(lookup(dicts[code], key))) {
        assert.doesNotMatch(sentence, rules.gate, `${code} ${key} counts the first 100 ballots: ${sentence}`);
        assert.ok(
          !(rules.turnout.test(sentence) && rules.tied.test(sentence)),
          `${code} ${key} ties turnout to the gate: ${sentence}`,
        );
      }
    }
  }
});

test('comparison stacks on a narrow screen and motion can be reduced', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.match(css, /\.ballot-compare\{[^}]*grid-template-columns:1fr 1fr/);
  assert.match(css, /@media \(max-width:960px\)\{\s*\.ballot-compare\{grid-template-columns:1fr\}/);
  assert.match(css, /@media \(max-width:640px\)\{[^}]*\.both-grid\{grid-template-columns:1fr\}/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.flow-edge\{animation:none !important/);
  assert.match(css, /\.lang-label select:focus-visible\{outline:2px solid var\(--accent2\);outline-offset:2px\}/);
  assert.match(css, /\.mini-ballot text\{direction:ltr;unicode-bidi:isolate\}/);
  assert.match(css, /\.vz-svg text\{[^}]*direction:ltr;unicode-bidi:isolate\}/);
});
