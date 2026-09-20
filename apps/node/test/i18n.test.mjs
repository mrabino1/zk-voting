// NOT FOR PROFIT — civic public good, not a commercial product.
// Website locale: English default, Spanish optional. Docs/contracts stay English.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  DEFAULT_LOCALE,
  STORAGE_KEY,
  SUPPORTED_LOCALES,
  catalogs,
  flattenKeys,
  getLocale,
  resetLocaleForTests,
  setLocale,
  t,
} from '../public/i18n.js';

describe('website i18n', () => {
  beforeEach(() => {
    resetLocaleForTests(DEFAULT_LOCALE);
  });

  test('defaults to English and supports Spanish', () => {
    assert.equal(DEFAULT_LOCALE, 'en');
    assert.deepEqual(SUPPORTED_LOCALES, ['en', 'es']);
    assert.equal(STORAGE_KEY, 'republic_lang');
    assert.equal(getLocale(), 'en');
    assert.equal(t('chrome.navElections'), 'Elections');
    assert.equal(t('lang.spanish'), 'Spanish');
  });

  test('looks up Spanish copy and falls back to English', () => {
    resetLocaleForTests('es');
    assert.equal(getLocale(), 'es');
    assert.equal(t('chrome.navElections'), 'Elecciones');
    assert.equal(t('home.markBallot'), 'Marcar boleta');
    assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
  });

  test('English and Spanish catalogs have the same keys', () => {
    const { en, es } = catalogs();
    const enKeys = flattenKeys(en).sort();
    const esKeys = flattenKeys(es).sort();
    const missingInEs = enKeys.filter((key) => !esKeys.includes(key));
    const extraInEs = esKeys.filter((key) => !enKeys.includes(key));
    assert.deepEqual(missingInEs, []);
    assert.deepEqual(extraInEs, []);
    assert.ok(enKeys.length > 200);
  });

  test('interpolates vars and uses _one for count 1', () => {
    resetLocaleForTests('en');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Official ballot · 1 question');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Official ballot · 2 questions');
    resetLocaleForTests('es');
    assert.equal(t('vote.officialBallot', { count: 1 }), 'Boleta oficial · 1 pregunta');
    assert.equal(t('vote.officialBallot', { count: 2 }), 'Boleta oficial · 2 preguntas');
  });

  test('unsupported locale stays English', () => {
    assert.equal(setLocale('fr'), 'en');
    assert.equal(getLocale(), 'en');
    assert.equal(t('chrome.navRegister'), 'Register');
  });
});
