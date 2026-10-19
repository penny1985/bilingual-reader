import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSourceLanguage } from '../extension/source-language.js';

const englishSample = 'This English article explains how the telescope observes distant stars.';

function fakeClock() {
  let callback;
  const clock = {
    delay: null,
    cleared: false,
    scheduleTimeout(fn, delay) { callback = fn; clock.delay = delay; return 42; },
    cancelTimeout(id) { assert.equal(id, 42); clock.cleared = true; },
    expire() { assert.ok(callback); callback(); }
  };
  return clock;
}

test('declared English and Traditional Chinese skip Chrome detection, even on inactive tabs', async () => {
  let detectionCalls = 0;
  const options = {
    detectLanguage: () => { detectionCalls++; return new Promise(() => {}); },
    scheduleTimeout: () => assert.fail('metadata must not schedule a timeout')
  };
  assert.equal(await detectSourceLanguage({ ...options, lang: 'en-US' }), 'en');
  assert.equal(await detectSourceLanguage({ ...options, lang: 'zh-Hant' }), 'zh-Hant');
  assert.equal(await detectSourceLanguage({ ...options, lang: 'zh-TW' }), 'zh-Hant');
  assert.equal(detectionCalls, 0);
});

test('valid host override wins over HTML and never waits for Chrome', async () => {
  assert.equal(await detectSourceLanguage({
    override: 'ja', lang: 'en',
    detectLanguage: () => assert.fail('override must skip Chrome')
  }), 'ja');
  assert.equal(await detectSourceLanguage({ override: 'zh-Hant', lang: 'en' }), 'zh-Hant');
  assert.equal(await detectSourceLanguage({ override: 'auto', lang: 'fr' }), 'fr');
  assert.equal(await detectSourceLanguage({ override: 'unsupported', lang: 'de' }), 'de');
});

test('never-resolving Chrome detection times out and uses the English sample', async () => {
  const clock = fakeClock();
  const result = detectSourceLanguage({
    lang: 'und', sample: englishSample,
    detectLanguage: () => new Promise(() => {}), ...clock
  });
  assert.equal(clock.delay, 1500);
  clock.expire();
  assert.equal(await result, 'en');
  assert.equal(clock.cleared, true);
});

test('responsive Chrome detection retains non-English and Traditional Chinese languages', async () => {
  for (const [raw, expected] of [['ja-JP', 'ja'], ['zh-TW', 'zh-Hant'], ['zh-CN', 'zh']]) {
    const clock = fakeClock();
    assert.equal(await detectSourceLanguage({
      lang: '', sample: englishSample, detectLanguage: async () => raw, ...clock
    }), expected);
    assert.equal(clock.cleared, true);
  }
});

test('detection failures and unsupported results use only the existing conservative sample fallback', async () => {
  for (const detectLanguage of [async () => { throw new Error('Unavailable'); }, () => { throw new Error('Synchronous failure'); }, async () => 'unsupported']) {
    const clock = fakeClock();
    assert.equal(await detectSourceLanguage({ sample: englishSample, detectLanguage, ...clock }), 'en');
    assert.equal(clock.cleared, true);
  }
  assert.equal(await detectSourceLanguage({ lang: 'unsupported', sample: '少量英文 abc，無法判斷來源語言。' }), null);
  assert.equal(await detectSourceLanguage({ sample: 'Short' }), null);
  assert.equal(await detectSourceLanguage({ sample: '' }), null);
});
