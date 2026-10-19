import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTranslator, splitText, normalizeLanguage } from '../extension/engine.js';

test('normalizes source scripts and rejects unknown languages', () => {
  assert.equal(normalizeLanguage('en_US'), 'en');
  assert.equal(normalizeLanguage('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLanguage('zh-Hant-HK'), 'zh-Hant');
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('und'), null);
});

test('splits long text without dropping text or breaking surrogate pairs', () => {
  const text = ('A sentence with punctuation! Then another sentence.\n' + '一個字😀'.repeat(300)).repeat(8);
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1800);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
});

test('deduplicates initialization; caches by pair; cancelled work never calls the model', async () => {
  let creates = 0;
  const calls = [];
  const engine = new LocalTranslator({ create: async options => {
    creates++;
    return { translate: async text => { calls.push([options.sourceLanguage, text]); return `譯文 ${text}`; } };
  } });
  await Promise.all([engine.prepare('en', 'zh-Hant'), engine.prepare('en', 'zh-Hant')]);
  assert.equal(creates, 1);
  assert.equal(await engine.translate('Hello', 'en', 'zh-Hant'), '譯文 Hello');
  assert.equal(await engine.translate('Hello', 'en', 'zh-Hant'), '譯文 Hello');
  assert.equal(calls.length, 1);
  await assert.rejects(engine.translate('Cancelled', 'en', 'zh-Hant', () => false), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  await engine.prepare('ja', 'zh-Hant');
  await engine.translate('Hello', 'ja', 'zh-Hant');
  assert.equal(calls.length, 2);
  engine.clearCache();
  await engine.translate('Hello', 'en', 'zh-Hant');
  assert.equal(calls.length, 3);
});

test('only one model request executes at a time and failures do not stop the queue', async () => {
  let active = 0;
  let maximum = 0;
  const engine = new LocalTranslator({ create: async () => ({ translate: async text => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (text === 'bad') throw new Error('Bad input');
    return `譯文 ${text}`;
  } }) });
  await engine.prepare('en', 'zh-Hant');
  const outcomes = await Promise.allSettled(['one', 'bad', 'two'].map(text => engine.translate(text, 'en', 'zh-Hant')));
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(maximum, 1);
});

test('a session cancelled while a translation runs discards its output', async () => {
  let current = true;
  let finish;
  const engine = new LocalTranslator({ create: async () => ({ translate: () => new Promise(resolve => { finish = resolve; }) }) });
  await engine.prepare('en', 'zh-Hant');
  const result = engine.translate('A long request', 'en', 'zh-Hant', () => current);
  await new Promise(resolve => setTimeout(resolve, 0));
  current = false;
  finish('不該顯示的結果');
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(engine.cache.size, 0);
});
