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
  assert.match(region, /100 voters have cast their first ballot/);
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
  assert.match(html, /data-brand>ZK-Voting</);
});

test('display name is filled from the branding helper', () => {
  assert.equal(brandName(), DEFAULT_BRAND_NAME);
  const html = pageHtml();
  assert.ok(html.includes(`<span data-brand>${DEFAULT_BRAND_NAME}</span>`));
  assert.match(html, /<meta name="brand-name" content="ZK-Voting">/);
  const branded = translateMarkup(html, 'en', 'Civic Desk');
  assert.match(branded, /data-brand>Civic Desk</);
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
  assert.match(lookup(dicts.en, 'how.s5body'), /stay as published/);
  assert.match(lookup(dicts.en, 'how.s5body'), /Anyone can check that the published totals match the accepted ballots/);
  assert.match(html, /once 100 voters have cast their first ballot or the poll ends/);
  assert.match(html, /once 100 voters have cast their first ballot or the scheduled end arrives, whichever comes first/);
  assert.match(html, /Counts stay hidden until 100 voters have cast their first ballot, or until the scheduled end, whichever comes first/);
  assert.doesNotMatch(html, /100 first ballots/);
  assert.doesNotMatch(lookup(dicts.en, 'hero.lead'), /100 first ballots/);
  assert.doesNotMatch(lookup(dicts.en, 'how.s4body'), /100 first ballots/);
  assert.doesNotMatch(lookup(dicts.en, 'pollVote.poll.gate'), /100 first ballots/);
  assert.match(html, /A poll's published hourly blocks stay as published/);
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
  en: { turnout: /\bturnout\b/i, gate: /\b(?:first 100 ballots|100 first ballots)\b/i, tied: /\b(?:100 voters have cast their first ballot|the gate|a gate|delayed)\b/i },
  es: { turnout: /participaci[oó]n/i, gate: /primeras 100 boletas/i, tied: /100 votantes|umbral|diferido/i },
  fr: { turnout: /participation/i, gate: /100 premiers bulletins/i, tied: /100 votants|diff[eé]r[eé]|seuil/i },
  pt: { turnout: /participa[cç][aã]o/i, gate: /primeiras 100 c[eé]dulas/i, tied: /100 eleitores|atrasad|limiar|barreira/i },
  zh: { turnout: /投票率/, gate: /最先的 100/, tied: /100 名投票人|门槛|延迟/ },
  ar: { turnout: /إقبال/, gate: /أول 100/, tied: /100 ناخب|عتبة|مؤج/ },
  ko: { turnout: /투표율/, gate: /처음 100장/, tied: /100명|문턱|지연/ },
  hi: { turnout: /उपस्थिति/, gate: /पहले 100 मत/, tied: /100 मतदाता|द्वार|विलंब/ },
  vi: { turnout: /tỷ lệ đi/i, gate: /100 phiếu đầu/i, tied: /100 cử tri|cửa|trễ/i },
  fil: { turnout: /pagdalo/i, gate: /unang 100 balota/i, tied: /100 botante|tarangkahan|antala/i },
};

function sentencesOf(value) {
  return value.split(/[.!?。！？।۔]+/).map((part) => part.trim()).filter(Boolean);
}

test('turnout is public every hour and is not tied to the poll gate', () => {
  const html = pageHtml();
  const dicts = catalogs();
  for (const key of ['hero.lead', 'why.publicBody', 'who.clubsBody', 'who.auditorsBody']) {
    assert.match(lookup(dicts.en, key), new RegExp(BOTH_TURNOUT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(lookup(dicts.en, 'why.coerceBody'), new RegExp(POLL_TURNOUT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /Turnout is public every hour for both kinds\./);
  assert.match(html, /Turnout is public every hour, as in a poll\./);
  assert.match(lookup(dicts.en, 'hero.lead'), /Individual choices are not published\./);
  assert.match(lookup(dicts.en, 'hero.lead'), /Zero-knowledge proofs are designed to show that only eligible people voted/);
  assert.match(lookup(dicts.en, 'hero.lead'), /\(tests currently use a mock verifier\)/);
  assert.doesNotMatch(lookup(dicts.en, 'hero.lead'), /Nobody's choice is ever published/);
  assert.match(html, /Individual choices are not published\./);
  assert.match(html, /tests currently use a mock verifier/);
  assert.doesNotMatch(html, /Nobody's choice is ever published/);
  assert.equal(lookup(dicts.en, 'hero.title'), 'Ballots built so nobody can read them.');
  assert.match(lookup(dicts.en, 'why.privateBody'), /designed so they don't show how you voted/);
  assert.match(lookup(dicts.en, 'vision.l2p2'), /\(with the mock verifier in tests, this check is not yet enforced\)/);
  assert.match(html, /Ballots built so nobody can read them/);
  assert.match(html, /designed so they don't show how you voted/);
  assert.match(html, /with the mock verifier in tests, this check is not yet enforced/);
  assert.match(lookup(dicts.en, 'pollVote.vote.guardians'), /The design gives the operator no key share\./);
  assert.match(html, /The design gives the operator no key share\./);
  assert.doesNotMatch(html, /The operator holds no key/);
  assert.equal(
    lookup(dicts.es, 'pollVote.poll.gate'),
    'Los recuentos permanecen ocultos hasta que 100 votantes hayan emitido su primera boleta, o hasta el cierre programado, lo que ocurra primero.',
  );
  assert.equal(
    lookup(dicts.fr, 'pollVote.poll.gate'),
    "Les totaux restent cachés jusqu'à ce que 100 votants aient déposé leur premier bulletin, ou jusqu'à la fin prévue, selon ce qui arrive en premier.",
  );
  assert.equal(
    lookup(dicts.pt, 'pollVote.poll.gate'),
    'As contagens ficam ocultas até que 100 eleitores tenham enviado sua primeira cédula, ou até o fim programado, o que ocorrer primeiro.',
  );
  assert.equal(
    lookup(dicts.ar, 'pollVote.poll.gate'),
    'تبقى الأعداد مخفية حتى يُدلي 100 ناخب بأوراقهم الأولى، أو حتى النهاية المجدولة، أيهما أسبق.',
  );
  assert.equal(
    lookup(dicts.es, 'pollVote.poll.freeze').split('. ').pop(),
    'Los votos cambiados aparecen solo en el escrutinio final.',
  );
  assert.equal(
    lookup(dicts.fr, 'pollVote.poll.freeze').split('. ').pop(),
    "Les nouveaux votes (changements de vote) n'apparaissent que dans le décompte final.",
  );
  assert.equal(
    lookup(dicts.pt, 'pollVote.poll.freeze').split('. ').pop(),
    'Os votos alterados só aparecem na apuração final.',
  );
  const marks = {
    es: ['La participación es pública cada hora para ambos tipos.', 'verificador simulado', 'Las opciones individuales no se publican.', 'El diseño no da al operador ninguna parte de la clave.', '100 votantes hayan emitido su primera boleta'],
    fr: ['La participation est publique chaque heure pour les deux types.', 'vérificateur fictif', 'Les choix individuels ne sont pas publiés.', "La conception ne donne à l'opérateur aucune part de clé.", 'leur premier bulletin'],
    pt: ['A participação é pública a cada hora para os dois tipos.', 'verificador simulado', 'As escolhas individuais não são publicadas.', 'O desenho não dá ao operador nenhuma parte da chave.', '100 eleitores tenham enviado sua primeira cédula'],
    zh: ['两种的投票率每小时都公开。', '模拟验证器', '不公布个人的选择。', '设计不向运营者提供密钥份额。', '100 名投票人各自投出第一张选票'],
    ar: ['الإقبال علني كل ساعة لكلا النوعين.', 'مُحققًا وهميًا', 'لا تُنشر الخيارات الفردية.', 'لا يمنح التصميم المشغّل أي حصة من المفتاح.', '100 ناخب بأوراقهم الأولى'],
    ko: ['두 종류 모두 투표율은 매시간 공개됩니다.', '모의 검증기', '개인의 선택은 공개되지 않습니다.', '설계는 운영자에게 키 지분을 주지 않습니다.', '100명의 유권자가 각자의 첫 투표용지를'],
    hi: ['दोनों प्रकारों में उपस्थिति हर घंटे सार्वजनिक है।', 'नकली सत्यापक', 'व्यक्तिगत विकल्प प्रकाशित नहीं होते।', 'डिज़ाइन संचालक को कोई कुंजी-हिस्सा नहीं देता।', '100 मतदाता'],
    vi: ['Tỷ lệ đi bỏ phiếu được công khai mỗi giờ cho cả hai loại.', 'bộ xác minh giả', 'Các lựa chọn cá nhân không được công bố.', 'Thiết kế không trao cho người vận hành phần khóa nào.', '100 cử tri đã bỏ phiếu đầu tiên của mình'],
    fil: ['Hayagan ang pagdalo kada oras para sa parehong uri.', 'kunwang tagapagpatunay', 'Hindi inilalathala ang mga indibidwal na pagpipilian.', 'Hindi binibigyan ng disenyo ang operator ng bahagi ng susi.', '100 botante ng kanilang unang balota'],
  };
  for (const [code, phrases] of Object.entries(marks)) {
    const lead = lookup(dicts[code], 'hero.lead');
    const guardians = lookup(dicts[code], 'pollVote.vote.guardians');
    assert.match(lead, new RegExp(phrases[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(lead, new RegExp(phrases[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(lead, new RegExp(phrases[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(guardians, new RegExp(phrases[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(lookup(dicts[code], 'why.publicBody'), new RegExp(phrases[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const voters = new RegExp(phrases[4].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const key of ['hero.lead', 'why.publicBody', 'why.coerceBody', 'who.clubsBody', 'who.auditorsBody', 'how.s4body', 'pollVote.poll.gate']) {
      assert.match(lookup(dicts[code], key), voters, `${code} ${key}`);
    }
  }
  for (const code of LOCALE_CODES) {
    const rules = TURNOUT_GATE[code];
    for (const key of flattenKeys(dicts[code])) {
      for (const sentence of sentencesOf(lookup(dicts[code], key))) {
        assert.doesNotMatch(
          sentence,
          rules.gate,
          `${code} ${key} counts the first 100 ballots, not 100 voters' first ballots: ${sentence}`,
        );
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
