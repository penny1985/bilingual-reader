import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const autoSource = await readFile(new URL('../extension/auto.js', import.meta.url), 'utf8');
const backgroundSource = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const success = (id = 'session-1') => ({ ok: true, enabled: true, sessionId: id, sourceLanguage: 'en', targetLanguage: 'zh-Hant' });
const settle = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };

function clock() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async advance(duration) {
      const end = now + duration;
      for (;;) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        tasks.delete(due[0]);
        due[1].callback();
        await settle();
      }
      now = end;
      await settle();
    }
  };
}

async function autoHarness({ respond = () => success(), info = { lang: 'en', sample: 'An English article about planets and their moons.' } } = {}) {
  const timers = clock();
  const listeners = [];
  const events = new Map();
  const observers = [];
  const calls = [];
  const starts = [];
  let restores = 0;
  let currentInfo = info;
  const location = { href: 'https://example.test/article/one', hostname: 'example.test', protocol: 'https:' };
  const window = { addEventListener(name, listener) { events.set(name, listener); } };
  window.top = window;
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(_node, options) { this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  const context = vm.createContext({
    window, location, document: { documentElement: {} }, MutationObserver, ...timers,
    chrome: { runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage(message, callback) {
        calls.push(message);
        Promise.resolve(respond(message, calls.length)).then(callback);
      }
    } },
    __BT_READER_CONTROL__: {
      info: () => ({ ...currentInfo }), restore() { restores++; }, start(message) { starts.push(message); }
    }
  });
  vm.runInContext(autoSource, context);
  await settle();
  return {
    calls, starts, timers, observers, location,
    get restores() { return restores; },
    info(value) { currentInfo = value; },
    async message(message) { for (const listener of listeners) listener(message, {}, () => {}); await settle(); },
    async navigate(url, notify = true) {
      location.href = url;
      if (notify) for (const listener of listeners) listener({ type: 'BT_RECONFIGURE', reason: 'navigation', pageUrl: url.split('#')[0] }, {}, () => {});
      await settle();
    },
    event(name, event = {}) { events.get(name)?.(event); },
    mutate(type) {
      for (const observer of observers) {
        if (observer.active && (type === 'lang' ? observer.options.attributeFilter?.includes('lang') : observer.options.childList)) observer.callback([]);
      }
    },
    pause() { context.__BT_READER_AUTO_CONTROL__.pause(); }
  };
}

function eventTarget() {
  const listeners = [];
  return { addListener(listener) { listeners.push(listener); }, emit(...args) { for (const listener of listeners) listener(...args); }, listeners };
}

async function backgroundHarness(detectSourceLanguage = async () => 'en') {
  const local = { enabled: true, preparedSources: ['en'], blockedHosts: [], style: 'line', sourceOverrides: {}, aiEngine: 'local', aiProviders: {}, aiConsent: false, aiRevision: '0' };
  const session = {};
  const sent = [];
  const cancelled = [];
  const messages = eventTarget();
  const updated = eventTarget();
  const removed = eventTarget();
  let url = 'https://example.test/article/one';
  let sequence = 0;
  let heldSessionRead = null;
  function storage(data) {
    return {
      setAccessLevel: async () => {},
      get: async keys => {
        if (data === session && typeof keys === 'string' && heldSessionRead) {
          const held = heldSessionRead; heldSessionRead = null; await held;
        }
        if (keys === null) return { ...data };
        if (typeof keys === 'string') return { [keys]: data[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, data[key]]));
        return { ...keys, ...data };
      },
      set: async values => { Object.assign(data, values); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    };
  }
  const chrome = {
    runtime: { id: 'extension-id', onMessage: messages, onInstalled: eventTarget(), getManifest: () => ({ version: 'test' }), getContexts: async () => [], getURL: path => `chrome-extension://extension-id/${path}` },
    storage: { local: storage(local), session: storage(session), onChanged: eventTarget() },
    tabs: { onUpdated: updated, onRemoved: removed, get: async () => ({ id: 7, url }), query: async () => [], sendMessage: async (tabId, message) => { sent.push({ tabId, ...message }); } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
  class CloudTranslator {
    cancelSession(id) { cancelled.push(id); }
    cancelAll() {}
  }
  vm.runInNewContext(backgroundSource, { chrome, detectSourceLanguage, AI_PROVIDERS: {}, CloudTranslator, URL, crypto: { randomUUID: () => `id-${++sequence}` }, setTimeout, clearTimeout });
  await settle();
  return {
    local, session, sent, cancelled,
    holdNextSessionRead() { let release; heldSessionRead = new Promise(resolve => { release = resolve; }); return release; },
    setUrl(next) { url = next; },
    async update(next) { url = next; updated.emit(7, { url: next }); await settle(); },
    async configure(senderUrl = url, claimedPageUrl) {
      return new Promise(resolve => messages.emit({ type: 'BT_AUTO_CONFIG', info: {}, ...(claimedPageUrl === undefined ? {} : { pageUrl: claimedPageUrl }) }, { id: 'extension-id', tab: { id: 7 }, frameId: 0, documentId: 'document-a', url: senderUrl }, resolve));
    }
  };
}

test('SPA path/query changes restart after debounce and invalidate the old content immediately', async () => {
  const page = await autoHarness({ respond: (_message, count) => success(`session-${count}`) });
  assert.equal(page.starts.length, 1);
  await page.navigate('https://example.test/article/two');
  assert.equal(page.restores, 1, 'cancel the old reader before waiting for route configuration');
  assert.equal(page.calls.length, 1);
  await page.timers.advance(120);
  assert.equal(page.starts.at(-1).sessionId, 'session-2');
  assert.equal(page.calls.at(-1).pageUrl, 'https://example.test/article/two');
  await page.navigate('https://example.test/article/two?chapter=3');
  await page.timers.advance(120);
  assert.equal(page.starts.at(-1).sessionId, 'session-3');
});

test('Chrome history pushState/replaceState/back-forward notifications ignore anchor-only changes', async () => {
  const background = await backgroundHarness();
  const initial = await background.configure();
  assert.equal(initial.enabled, true);
  await background.update('https://example.test/article/one#section');
  assert.equal(background.sent.length, 0);
  assert.equal(background.session['bt:session:7'].id, initial.sessionId);
  await background.update('https://example.test/article/two');
  await background.update('https://example.test/article/two?sort=new');
  await background.update('https://example.test/article/one');
  assert.deepEqual(background.sent.map(item => item.pageUrl), [
    'https://example.test/article/two', 'https://example.test/article/two?sort=new', 'https://example.test/article/one'
  ]);
  assert.ok(background.sent.every(item => item.reason === 'navigation'));
  assert.ok(background.cancelled.includes(initial.sessionId));
});

test('back-forward popstate recovers even before the browser notification; hash anchors keep the session', async () => {
  const page = await autoHarness();
  await page.navigate('https://example.test/article/one#notes');
  page.event('popstate');
  await page.timers.advance(120);
  assert.equal(page.calls.length, 1);
  await page.navigate('https://example.test/article/older', false);
  page.event('popstate');
  await page.timers.advance(120);
  assert.equal(page.calls.length, 2);
  await page.message({ type: 'BT_RECONFIGURE', reason: 'navigation', pageUrl: page.location.href });
  await page.timers.advance(120);
  assert.equal(page.calls.length, 2, 'duplicate browser/popstate notification is harmless');
});

test('configuration from a previous route cannot recreate a session after asynchronous detection', async () => {
  let resolveDetection;
  const background = await backgroundHarness(() => new Promise(resolve => { resolveDetection = resolve; }));
  const configuring = background.configure();
  await settle();
  assert.equal(typeof resolveDetection, 'function');
  await background.update('https://example.test/article/two');
  resolveDetection('en');
  const stale = await configuring;
  assert.equal(stale.cancelled, true);
  assert.equal(background.session['bt:session:7'], undefined);
  const outdated = await background.configure('https://example.test/article/one');
  assert.equal(outdated.cancelled, true);
});

test('a previous route config response never starts its reader on the new route', async () => {
  let oldResponse;
  const page = await autoHarness({ respond: (_message, count) => count === 1 ? new Promise(resolve => { oldResponse = resolve; }) : success('new-route') });
  await page.navigate('https://example.test/article/two');
  oldResponse(success('old-route'));
  await settle();
  assert.equal(page.starts.length, 0);
  await page.timers.advance(120);
  assert.equal(page.starts.length, 1);
  assert.equal(page.starts[0].sessionId, 'new-route');
});

test('declared language changes reconfigure an active or initially Traditional Chinese document', async () => {
  const page = await autoHarness({ info: { lang: 'zh-Hant', sample: '這是繁體中文文章。' }, respond: (_message, count) => count === 1 ? { ok: true, enabled: false, sourceLanguage: 'zh-Hant' } : success() });
  page.info({ lang: 'en', sample: 'English content is now visible on this same page.' });
  page.mutate('lang');
  await page.timers.advance(120);
  assert.equal(page.starts.length, 1);
  assert.equal(page.calls[1].info.lang, 'en');
  page.info({ lang: 'ja', sample: '日本語の文章です。' });
  page.mutate('lang');
  await page.timers.advance(120);
  assert.equal(page.calls[2].info.lang, 'ja');
});

test('initial empty shell retries when content arrives, including hydration during pending detection', async () => {
  const empty = { lang: '', sample: '' };
  const hydrated = { lang: '', sample: 'An English article has loaded after its initial application shell.' };
  const page = await autoHarness({ info: empty, respond: (_message, count) => count === 1 ? { ok: true, enabled: false, needsLanguage: true } : success() });
  assert.equal(page.starts.length, 0);
  page.info(hydrated);
  page.mutate('childList');
  await page.timers.advance(270);
  assert.equal(page.starts.length, 1);
  assert.ok(page.observers.filter(item => item.options.childList).every(item => !item.active));

  let response;
  const pending = await autoHarness({ info: empty, respond: (_message, count) => count === 1 ? new Promise(resolve => { response = resolve; }) : success() });
  pending.info(hydrated);
  response({ ok: true, enabled: false, needsLanguage: true });
  await settle();
  await pending.timers.advance(120);
  assert.equal(pending.starts.length, 1);
});

test('unknown-language recovery stops after four changed samples or twenty seconds', async () => {
  const page = await autoHarness({ info: { lang: '', sample: '' }, respond: () => ({ ok: true, enabled: false, needsLanguage: true }) });
  for (let index = 0; index < 8; index++) {
    page.info({ lang: '', sample: `Ambiguous sample ${index}` });
    page.mutate('childList');
    await page.timers.advance(270);
  }
  assert.equal(page.calls.length, 5);
  const timeout = await autoHarness({ respond: () => ({ ok: true, enabled: false, needsLanguage: true }) });
  await timeout.timers.advance(20001);
  timeout.info({ lang: '', sample: 'New article after the bounded recovery deadline.' });
  timeout.mutate('childList');
  await timeout.timers.advance(270);
  assert.equal(timeout.calls.length, 1);
});

test('setup/errors never install hydration retries, and disable/blocked hosts/manual pause stay quiet', async () => {
  for (const response of [{ ok: true, enabled: false, needsSetup: true }, { ok: false, error: 'quota' }, { ok: true, enabled: false, disabled: true }]) {
    const page = await autoHarness({ respond: () => response });
    page.info({ lang: 'en', sample: 'This article content changed while translation was unavailable.' });
    page.mutate('childList');
    page.mutate('lang');
    await page.timers.advance(21000);
    assert.equal(page.calls.length, 1);
  }
  for (const mode of ['pause', 'disabled', 'blocked', 'engine']) {
    const page = await autoHarness();
    if (mode === 'pause') page.pause();
    if (mode === 'disabled') await page.message({ type: 'BT_SETTINGS_CHANGED', changes: { enabled: { newValue: false } } });
    if (mode === 'blocked') await page.message({ type: 'BT_SETTINGS_CHANGED', changes: { blockedHosts: { newValue: ['example.test'] } } });
    if (mode === 'engine') await page.message({ type: 'BT_ENGINE_CHANGED' });
    await page.navigate('https://example.test/article/two');
    page.mutate('lang');
    page.event('pageshow', { persisted: true });
    await page.message({ type: 'BT_RECONFIGURE', reason: 'settings' });
    await page.timers.advance(21000);
    assert.equal(page.calls.length, 1, mode);
    await page.message({ type: 'BT_RECONFIGURE', reason: 'manual' });
    await page.timers.advance(120);
    assert.equal(page.calls.length, 2, `${mode} permits an explicit manual retry`);
  }
});

test('pagehide discards pending configuration; persisted pageshow restores only an unpaused document', async () => {
  let response;
  const page = await autoHarness({ respond: (_message, count) => count === 1 ? new Promise(resolve => { response = resolve; }) : success() });
  page.event('pagehide');
  response(success('stale-page'));
  await settle();
  assert.equal(page.starts.length, 0);
  page.event('pageshow', { persisted: true });
  await page.timers.advance(120);
  assert.equal(page.starts.length, 1);
});


test('repeating the same declared language does not clear translations or create a new session', async () => {
  const page = await autoHarness();
  page.mutate('lang');
  await page.timers.advance(120);
  assert.equal(page.calls.length, 1);
  assert.equal(page.restores, 0);
  page.info({ lang: ' EN ', sample: 'An English article about planets and their moons.' });
  page.mutate('lang');
  await page.timers.advance(120);
  assert.equal(page.calls.length, 1);
  page.info({ lang: 'ja', sample: '日本語の文章です。' });
  page.mutate('lang');
  await page.timers.advance(120);
  assert.equal(page.calls.length, 2);
  assert.equal(page.restores, 1);
});


test('a delayed old-route storage callback cannot cancel the latest session after rapid A to B to A navigation', async () => {
  const background = await backgroundHarness();
  await background.configure();
  const releaseOldRead = background.holdNextSessionRead();
  await background.update('https://example.test/article/two');
  await background.update('https://example.test/article/one');
  const latest = await background.configure();
  assert.equal(latest.enabled, true);
  assert.equal(background.session['bt:session:7'].id, latest.sessionId);
  releaseOldRead();
  await settle();
  assert.equal(background.session['bt:session:7'].id, latest.sessionId);
  assert.equal(background.cancelled.includes(latest.sessionId), false);
});


test('SPA configuration binds the browser-verified route when Chrome sender.url stays at the original document URL', async () => {
  const background = await backgroundHarness();
  const original = 'https://example.test/article/one';
  await background.configure(original);
  const next = 'https://example.test/article/two?chapter=3';
  await background.update(next);
  const response = await background.configure(original, next + '#notes');
  assert.equal(response.enabled, true);
  assert.equal(background.session['bt:session:7'].pageUrl, next);
  assert.equal(background.session['bt:session:7'].documentId, 'document-a');
});

test('foreign-origin, non-web and stale claimed routes cannot cancel the valid current session', async () => {
  const background = await backgroundHarness();
  const original = 'https://example.test/article/one';
  const initial = await background.configure(original);
  for (const claimed of ['https://elsewhere.test/article/one', 'chrome://settings/', 'https://example.test/article/stale']) {
    const response = await background.configure(original, claimed);
    assert.equal(response.cancelled, true);
    assert.equal(background.session['bt:session:7'].id, initial.sessionId);
    assert.equal(background.cancelled.includes(initial.sessionId), false);
  }
  background.setUrl('https://elsewhere.test/article/one');
  const wrongOrigin = await background.configure(original, 'https://elsewhere.test/article/one');
  assert.equal(wrongOrigin.cancelled, true);
  assert.equal(background.session['bt:session:7'].id, initial.sessionId);
});
