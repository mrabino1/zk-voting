// NOT FOR PROFIT — civic public good, not a commercial product.
// Website locale: English default; ACS US home-language ranks 2–10 optional.
// Docs/contracts stay English.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { ALLOW_REVOTE_CHAIN_CONFIGURED, getConfig } from '../src/config.mjs';
import {
  DEFAULT_LOCALE,
  HTML_LANG,
  RTL_LOCALES,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
  catalogs,
  flattenKeys,
  getLocale,
  localeTag,
  receiptHelpKey,
  resetLocaleForTests,
  setLocale,
  t,
} from '../public/i18n.js';

describe('website i18n', () => {
  beforeEach(() => {
    resetLocaleForTests(DEFAULT_LOCALE);
  });

  test('defaults to English and lists ACS top US home languages', () => {
    assert.equal(DEFAULT_LOCALE, 'en');
    assert.deepEqual(SUPPORTED_LOCALES, [
      'en',
      'es',
      'zh',
      'fil',
      'vi',
      'ar',
      'fr',
      'ko',
      'pt',
      'hi',
    ]);
    assert.deepEqual(RTL_LOCALES, ['ar']);
    assert.equal(STORAGE_KEY, 'zk_voting_lang');
    assert.equal(getLocale(), 'en');
    assert.equal(localeTag(), 'en');
    assert.equal(t('chrome.navElections'), 'Elections');
    assert.equal(t('lang.spanish'), 'Spanish');
    assert.equal(t('lang.chinese'), 'Chinese');
    assert.equal(t('lang.tagalog'), 'Tagalog');
    assert.equal(t('lang.vietnamese'), 'Vietnamese');
    assert.equal(t('lang.arabic'), 'Arabic');
    assert.equal(t('lang.french'), 'French');
    assert.equal(t('lang.korean'), 'Korean');
    assert.equal(t('lang.portuguese'), 'Portuguese');
    assert.equal(t('lang.hindi'), 'Hindi');
    assert.equal(t('lang.choose'), 'Choose language');
  });

  test('looks up each optional locale and falls back to English', () => {
    resetLocaleForTests('es');
    assert.equal(getLocale(), 'es');
    assert.equal(localeTag(), 'es');
    assert.equal(t('chrome.navElections'), 'Elecciones');
    assert.equal(t('home.markBallot'), 'Marcar boleta');

    resetLocaleForTests('zh');
    assert.equal(getLocale(), 'zh');
    assert.equal(localeTag(), 'zh-Hans');
    assert.equal(t('chrome.navElections'), '选举');
    assert.equal(t('home.markBallot'), '填写选票');

    resetLocaleForTests('fil');
    assert.equal(getLocale(), 'fil');
    assert.equal(localeTag(), 'fil');
    assert.equal(t('chrome.navElections'), 'Mga halalan');
    assert.equal(t('home.markBallot'), 'Markahan ang balota');

    resetLocaleForTests('vi');
    assert.equal(getLocale(), 'vi');
    assert.equal(localeTag(), 'vi');
    assert.equal(t('chrome.navElections'), 'Bầu cử');
    assert.equal(t('home.markBallot'), 'Đánh phiếu');

    resetLocaleForTests('ar');
    assert.equal(getLocale(), 'ar');
    assert.equal(localeTag(), 'ar');
    assert.equal(t('chrome.navElections'), 'الانتخابات');
    assert.equal(t('home.markBallot'), 'تعبئة ورقة الاقتراع');

    resetLocaleForTests('fr');
    assert.equal(getLocale(), 'fr');
    assert.equal(localeTag(), 'fr');
    assert.equal(t('chrome.navElections'), 'Élections');
    assert.equal(t('home.markBallot'), 'Remplir le bulletin');

    resetLocaleForTests('ko');
    assert.equal(getLocale(), 'ko');
    assert.equal(localeTag(), 'ko');
    assert.equal(t('chrome.navElections'), '선거');
    assert.equal(t('home.markBallot'), '투표용지 작성');

    resetLocaleForTests('pt');
    assert.equal(getLocale(), 'pt');
    assert.equal(localeTag(), 'pt-BR');
    assert.equal(t('chrome.navElections'), 'Eleições');
    assert.equal(t('home.markBallot'), 'Marcar cédula');

    resetLocaleForTests('hi');
    assert.equal(getLocale(), 'hi');
    assert.equal(localeTag(), 'hi');
    assert.equal(t('chrome.navElections'), 'चुनाव');
    assert.equal(t('home.markBallot'), 'मतपत्र भरें');

    assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
  });

  test('all locale catalogs have the same keys', () => {
    const dicts = catalogs();
    const enKeys = flattenKeys(dicts.en).sort();
    assert.ok(enKeys.length > 200);
    for (const code of SUPPORTED_LOCALES) {
      const keys = flattenKeys(dicts[code]).sort();
      const missing = enKeys.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !enKeys.includes(key));
      assert.deepEqual(missing, [], `${code} missing English keys`);
      assert.deepEqual(extra, [], `${code} has extra keys`);
    }
  });

  test('interpolates vars and uses _one for count 1', () => {
    resetLocaleForTests('en');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Official ballot · 1 question');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Official ballot · 2 questions');
    resetLocaleForTests('es');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Boleta oficial · 1 pregunta');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Boleta oficial · 2 preguntas');
    resetLocaleForTests('zh');
    assert.equal(t('vote.officialBallot', { count: 1 }), '正式选票 · 1 题');
    assert.equal(t('vote.officialBallot', { count: 2 }), '正式选票 · 2 题');
    resetLocaleForTests('fil');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Opisyal na balota · 1 tanong');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Opisyal na balota · 2 tanong');
    resetLocaleForTests('vi');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Phiếu chính thức · 1 câu');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Phiếu chính thức · 2 câu');
    resetLocaleForTests('ar');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'ورقة اقتراع رسمية · 1 سؤال');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'ورقة اقتراع رسمية · 2 أسئلة');
    resetLocaleForTests('fr');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Bulletin officiel · 1 question');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Bulletin officiel · 2 questions');
    resetLocaleForTests('ko');
    assert.equal(t('vote.officialBallot', { count: 1 }), '공식 투표용지 · 1문항');
    assert.equal(t('vote.officialBallot', { count: 2 }), '공식 투표용지 · 2문항');
    resetLocaleForTests('pt');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Cédula oficial · 1 pergunta');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Cédula oficial · 2 perguntas');
    resetLocaleForTests('hi');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'आधिकारिक मतपत्र · 1 प्रश्न');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'आधिकारिक मतपत्र · 2 प्रश्न');
  });

  test('receipt help follows ALLOW_REVOTE in every locale', () => {
    const once = {
      en: 'You may vote only once; a second ballot from you is rejected.',
      es: 'Solo puede votar una vez; una segunda boleta de usted es rechazada.',
      zh: '您只能投票一次；您的第二张选票会被拒绝。',
      fil: 'Maaari kang bumoto nang isang beses lamang; tinatanggihan ang pangalawang balota mula sa iyo.',
      vi: 'Bạn chỉ được bỏ phiếu một lần; phiếu thứ hai của bạn bị từ chối.',
      ar: 'يمكنك التصويت مرة واحدة فقط؛ تُرفض ورقة ثانية منك.',
      fr: 'Vous ne pouvez voter qu’une fois ; un second bulletin de votre part est rejeté.',
      ko: '한 번만 투표할 수 있으며, 당신이 낸 두 번째 투표용지는 거부됩니다.',
      pt: 'Você pode votar apenas uma vez; uma segunda cédula sua é rejeitada.',
      hi: 'आप केवल एक बार मत दे सकते हैं; आपका दूसरा मतपत्र अस्वीकार किया जाता है।',
    };
    const revote = {
      en: 'may re-vote until the deadline, with the last vote counting',
      es: 'puede volver a votar hasta la fecha límite, y cuenta el último voto',
      zh: '截止前可以重新投票，最后一次投票计入',
      fil: 'maaaring bumoto muli hanggang sa deadline; ang huling boto ang binibilang',
      vi: 'có thể bỏ phiếu lại cho đến hạn chót; phiếu cuối cùng được tính',
      ar: 'يمكنه إعادة التصويت حتى الموعد النهائي، ويُحتسب آخر تصويت',
      fr: 'peut revoter jusqu’à la date limite ; le dernier vote compte',
      ko: '마감 전까지 다시 투표할 수 있고, 마지막 투표가 집계됩니다',
      pt: 'pode votar de novo até o prazo; o último voto é o que conta',
      hi: 'समय सीमा तक फिर मत दे सकता है; अंतिम मत गिना जाता है',
    };
    assert.equal(receiptHelpKey(false), 'vote.receiptHelp');
    assert.equal(receiptHelpKey(undefined), 'vote.receiptHelp');
    assert.equal(receiptHelpKey(true), 'vote.receiptHelpRevote');
    assert.equal(getConfig({}).allowRevote, false);
    assert.equal(receiptHelpKey(getConfig({}).allowRevote), 'vote.receiptHelp');
    assert.equal(receiptHelpKey(getConfig({ allowRevote: true }).allowRevote), 'vote.receiptHelpRevote');
    assert.throws(
      () => getConfig({ allowRevote: true, chainRpc: 'http://127.0.0.1:8545' }),
      new RegExp(ALLOW_REVOTE_CHAIN_CONFIGURED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    const dicts = catalogs();
    for (const code of SUPPORTED_LOCALES) {
      resetLocaleForTests(code);
      const single = dicts[code].vote.receiptHelp;
      const again = dicts[code].vote.receiptHelpRevote;
      assert.equal(t(receiptHelpKey(false)), single);
      assert.equal(t(receiptHelpKey(true)), again);
      assert.equal(single.includes(once[code]), true, code);
      assert.equal(again.includes(revote[code]), true, code);
      assert.equal(single.includes(revote[code]), false, code);
      assert.equal(again.includes(once[code]), false, code);
    }
  });

  test('unsupported locale stays English', () => {
    assert.equal(setLocale('ja'), 'en');
    assert.equal(getLocale(), 'en');
    assert.equal(t('chrome.navRegister'), 'Register');
  });

  test('html lang tags match BCP-47 website locales', () => {
    assert.deepEqual(HTML_LANG, {
      en: 'en',
      es: 'es',
      zh: 'zh-Hans',
      fil: 'fil',
      vi: 'vi',
      ar: 'ar',
      fr: 'fr',
      ko: 'ko',
      pt: 'pt-BR',
      hi: 'hi',
    });
  });
});
