// NOT FOR PROFIT — civic public good, not a commercial product.
// Website locale: English default; Spanish, Chinese, Tagalog, Vietnamese optional.
// Docs/contracts stay English.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  DEFAULT_LOCALE,
  HTML_LANG,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
  catalogs,
  flattenKeys,
  getLocale,
  localeTag,
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
    assert.deepEqual(SUPPORTED_LOCALES, ['en', 'es', 'zh', 'fil', 'vi']);
    assert.equal(STORAGE_KEY, 'republic_lang');
    assert.equal(getLocale(), 'en');
    assert.equal(localeTag(), 'en');
    assert.equal(t('chrome.navElections'), 'Elections');
    assert.equal(t('lang.spanish'), 'Spanish');
    assert.equal(t('lang.chinese'), 'Chinese');
    assert.equal(t('lang.tagalog'), 'Tagalog');
    assert.equal(t('lang.vietnamese'), 'Vietnamese');
  });

  test('looks up Spanish, Chinese, Tagalog, and Vietnamese and falls back to English', () => {
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
  });

  test('unsupported locale stays English', () => {
    assert.equal(setLocale('fr'), 'en');
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
    });
  });
});
