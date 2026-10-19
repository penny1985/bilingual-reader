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

test('normalizes Chrome mixed-script output to Taiwan Traditional before caching', async () => {
  const literalUrl = 'https://example.com/软件?q=用户';
  const raw = `软件、硬件、服务器、网络、视频、内存、用户、数据集。\n軟件、服務器、網絡、視頻、內存、用戶、數據集。不會删除；日期 2026-05-12，金额 1,250，质量为 5 kg。${literalUrl}`;
  const expected = `軟體、硬體、伺服器、網路、影片、記憶體、使用者、資料集。\n軟體、伺服器、網路、影片、記憶體、使用者、資料集。不會刪除；日期 2026-05-12，金額 1,250，質量為 5 kg。${literalUrl}`;
  let calls = 0;
  const translator = new LocalTranslator({ create: async () => ({ translate: async () => { calls++; return raw; } }) });
  await translator.prepare('en', 'zh-Hant');
  assert.equal(await translator.translate('Technical settings.', 'en', 'zh-Hant'), expected);
  assert.equal(await translator.translate('Technical settings.', 'en', 'zh-Hant'), expected);
  assert.equal(calls, 1);
  assert.deepEqual([...translator.cache.values()], [expected]);
});

test('leaves other target languages unchanged instead of applying Chinese conversion', async () => {
  const raw = '软件、数据；质量 5 kg。';
  const translator = new LocalTranslator({ create: async () => ({ translate: async () => raw }) });
  await translator.prepare('en', 'ja');
  assert.equal(await translator.translate('A Japanese quotation.', 'en', 'ja'), raw);
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
