import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDERS, CloudTranslator } from '../extension/ai-engine.js';

const base = { text: 'The museum opens at nine.', sourceLanguage: 'en', provider: 'gemini', apiKey: 'test-key-not-real', sessionId: 'session-1' };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const gemini = (translation = '博物館九點開門。', extra = {}) => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ translation }) }] }, ...extra }] }));
const deepseek = (translation = '博物館九點開門。', extra = {}) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translation }) }, ...extra }] }));
const engine = fetch => new CloudTranslator({ fetch, minIntervalMs: 0 });

test('Gemini sends first-party HTTPS request, header key and untrusted source JSON', async () => {
  let captured;
  const translator = engine(async (url, options) => { captured = { url, ...options, body: JSON.parse(options.body) }; return gemini(); });
  assert.equal(await translator.translate(base), '博物館九點開門。');
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(captured.headers['x-goog-api-key'], base.apiKey);
  assert.ok(!captured.url.includes(base.apiKey));
  assert.ok(!JSON.stringify(captured.body).includes(base.apiKey));
  assert.equal(captured.credentials, 'omit');
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.cache, 'no-store');
  assert.match(captured.body.systemInstruction.parts[0].text, /untrusted webpage text/);
  assert.match(captured.body.systemInstruction.parts[0].text, /negation, conditions/);
  assert.match(captured.body.systemInstruction.parts[0].text, /sarcasm/);
  assert.equal(JSON.parse(captured.body.contents[0].parts[0].text).source_text, base.text);
  assert.equal(captured.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(captured.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
});

test('DeepSeek uses its current model, header key and disabled thinking', async () => {
  let captured;
  const translator = engine(async (url, options) => { captured = { url, ...options, body: JSON.parse(options.body) }; return deepseek(); });
  assert.equal(await translator.translate({ ...base, provider: 'deepseek' }), '博物館九點開門。');
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.headers.Authorization, `Bearer ${base.apiKey}`);
  assert.equal(captured.body.model, AI_PROVIDERS.deepseek.defaultModel);
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });
  assert.deepEqual(captured.body.response_format, { type: 'json_object' });
  assert.equal(JSON.parse(captured.body.messages[1].content).source_text, base.text);
});

test('rejects unsupported endpoint/model/target and invalid keys without any fetch', async () => {
  let requests = 0;
  const translator = engine(async () => { requests++; return gemini(); });
  for (const input of [{ provider: 'custom', endpoint: 'https://example.com' }, { provider: '__proto__' }, { model: 'bad-model' }, { targetLanguage: 'en' }, { apiKey: '' }, { apiKey: 'bad\nkey' }, { text: 'x'.repeat(16001) }]) {
    await assert.rejects(translator.translate({ ...base, ...input }), { name: 'CloudTranslationError' });
  }
  assert.equal(requests, 0);
});

test('splits long source without dropping whitespace or splitting surrogate pairs', async () => {
  const sources = [];
  const translator = engine(async (url, options) => {
    const source = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).source_text;
    sources.push(source);
    return gemini(`第 ${sources.length} 段`);
  });
  const text = ('Example sentence.\n😀'.repeat(700)).slice(0, 15000);
  await translator.translate({ ...base, text });
  assert.ok(sources.length > 1);
  assert.equal(sources.join(''), text);
  assert.ok(sources.every(source => source.length <= 6000 && !/[\uD800-\uDBFF]$/u.test(source)));
});

test('rejects truncated, blocked, malformed and oversized output; no partial cache', async () => {
  const responses = [
    gemini('譯文', { finishReason: 'MAX_TOKENS' }),
    gemini('譯文', { finishReason: 'SAFETY' }),
    new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not JSON' }] } }] })),
    new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ translation: '譯文', unwanted: true }) }] } }] })),
    gemini('x'.repeat(70000)),
    deepseek('譯文', { finish_reason: 'length' }),
    new Response('not-json'),
    new Response('{}', { headers: { 'content-length': '300001' } })
  ];
  for (let index = 0; index < responses.length; index++) {
    const translator = engine(async () => responses[index]);
    await assert.rejects(translator.translate({ ...base, provider: index === 5 ? 'deepseek' : 'gemini' }), { name: 'CloudTranslationError' });
    assert.equal(translator.cache.size, 0);
  }
});

test('thought parts are not shown and generated markup remains plain text', async () => {
  const expected = '<img src=x onerror=alert(1)>';
  const translator = engine(async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: 'Internal thoughts must not be rendered.' },
    { text: JSON.stringify({ translation: expected }) }
  ] } }] })));
  assert.equal(await translator.translate(base), expected);
});

test('HTTP and network errors never echo server details or the API key and never retry', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [402, 'balance'], [429, 'quota'], [404, 'model'], [400, 'request'], [503, 'service']]) {
    let requests = 0;
    const translator = engine(async () => { requests++; return new Response(`secret ${base.apiKey}`, { status }); });
    await assert.rejects(translator.translate(base), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(base.apiKey));
      assert.ok(!error.message.includes('secret'));
      return true;
    });
    assert.equal(requests, 1);
  }
  const translator = engine(async () => { throw new Error(`network issue: ${base.apiKey}`); });
  await assert.rejects(translator.translate(base), error => error.code === 'network' && !error.message.includes(base.apiKey));
});

test('memory cache isolates provider, model, language, source text and hashed key identity', async () => {
  let requests = 0;
  const translator = engine(async url => { requests++; return url.includes('deepseek.com') ? deepseek() : gemini(); });
  await translator.translate(base);
  await translator.translate({ ...base, sessionId: 'another-session' });
  assert.equal(requests, 1);
  await translator.translate({ ...base, apiKey: 'different-test-key' });
  await translator.translate({ ...base, model: 'gemini-3.5-flash-lite' });
  await translator.translate({ ...base, sourceLanguage: 'ja' });
  await translator.translate({ ...base, provider: 'deepseek' });
  await translator.translate({ ...base, text: 'A different source.' });
  assert.equal(requests, 6);
  for (const key of translator.cache.keys()) {
    assert.match(key, /^[a-f0-9]{64}$/u);
    assert.ok(!key.includes(base.apiKey));
    assert.ok(!key.includes(base.text));
  }
  translator.clearCache();
  await translator.translate(base);
  assert.equal(requests, 7);
});

test('serializes network requests and recovers after a failure without paid retries', async () => {
  let active = 0, maximum = 0, requests = 0;
  const translator = engine(async () => {
    requests++; active++; maximum = Math.max(maximum, active);
    await pause(5); active--;
    if (requests === 2) return new Response('', { status: 429 });
    return gemini();
  });
  const results = await Promise.allSettled(['one', 'two', 'three'].map(text => translator.translate({ ...base, text })));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(requests, 3);
  assert.equal(maximum, 1);
});

test('paces default Gemini models for Free-tier limits and preserves explicit overrides', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  for (const [provider, model, override, interval] of [
    ['gemini', 'gemini-3.8-flash', undefined, 13000],
    ['gemini', 'gemini-3.5-flash-lite', undefined, 4300],
    ['deepseek', 'deepseek-flash', undefined, 1200],
    ['gemini', 'gemini-3.8-flash', 0, 0],
    ['gemini', 'gemini-3.5-flash-lite', 2000, 2000]
  ]) {
    const translator = new CloudTranslator({ minIntervalMs: override });
    const job = { controller: new AbortController() };
    const config = { provider, model };
    const startedAt = Date.now();
    await translator.waitForTurn(job, config);
    assert.equal(translator.nextStartAt, startedAt + interval);
    if (!interval) continue;
    let ready = false;
    const nextTurn = translator.waitForTurn(job, config).then(() => { ready = true; });
    context.mock.timers.tick(interval - 1);
    await Promise.resolve();
    assert.equal(ready, false, `${model} must wait for its full interval`);
    context.mock.timers.tick(1);
    await nextTurn;
    assert.equal(Date.now() - startedAt, interval);
    assert.equal(translator.nextStartAt, startedAt + interval * 2);
  }
});

test('cancelling a session aborts active fetch, discards late results and cancels its queue', async () => {
  let resolveFetch, started;
  const isStarted = new Promise(resolve => { started = resolve; });
  let requests = 0, signal;
  const translator = engine(async (url, options) => { requests++; signal = options.signal; started(); return new Promise(resolve => { resolveFetch = resolve; }); });
  const current = translator.translate(base);
  const queued = translator.translate({ ...base, text: 'Queued source.' });
  const observed = Promise.allSettled([current, queued]);
  await isStarted;
  translator.cancelSession(base.sessionId);
  assert.equal(signal.aborted, true);
  resolveFetch(gemini('不應出現的譯文'));
  const results = await observed;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(requests, 1);
  assert.equal(translator.cache.size, 0);
  translator.fetch = async () => gemini();
  assert.equal(await translator.translate({ ...base, sessionId: 'fresh-session' }), '博物館九點開門。');
});

test('isCurrent cancellation before or between chunks prevents additional cloud requests', async () => {
  let current = false, requests = 0;
  const translator = engine(async () => { requests++; current = false; return gemini(); });
  await assert.rejects(translator.translate({ ...base, isCurrent: async () => current }), { name: 'AbortError' });
  assert.equal(requests, 0);
  current = true;
  await assert.rejects(translator.translate({ ...base, text: 'x'.repeat(13000), isCurrent: () => current }), { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.equal(translator.cache.size, 0);
});

test('external abort and cancelAll stop active or paced work', async () => {
  const external = new AbortController();
  const translator = new CloudTranslator({ fetch: async () => gemini(), minIntervalMs: 10000 });
  await translator.translate(base);
  const paced = translator.translate({ ...base, text: 'Another source.', signal: external.signal });
  const pacedObserved = assert.rejects(paced, { name: 'AbortError' });
  await pause(10);
  external.abort();
  await pacedObserved;
  const all = translator.translate({ ...base, text: 'Third source.', sessionId: 'third' });
  const allObserved = assert.rejects(all, { name: 'AbortError' });
  await pause(10);
  translator.cancelAll();
  await allObserved;
});

test('timeout aborts a non-cooperating fetch and the queue remains usable', async () => {
  let signal;
  const translator = new CloudTranslator({ timeoutMs: 10, minIntervalMs: 0, fetch: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(translator.translate(base), { code: 'timeout' });
  assert.equal(signal.aborted, true);
  translator.fetch = async () => gemini();
  assert.equal(await translator.translate(base), '博物館九點開門。');
});

test('testConnection sends only the fixed neutral sample and returns a translated preview', async () => {
  let source;
  const translator = engine(async (url, options) => { source = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).source_text; return gemini(); });
  const result = await translator.testConnection({ provider: 'gemini', apiKey: base.apiKey, text: 'PRIVATE PAGE SHOULD NOT BE SENT' });
  assert.deepEqual(result, { ok: true, translation: '博物館九點開門。' });
  assert.equal(source, 'The museum opens at nine. Admission is free on Sundays.');
});
