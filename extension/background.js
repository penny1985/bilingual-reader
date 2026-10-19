import { normalizeLanguage } from './engine.js';
import { AI_PROVIDERS, CloudTranslator } from './ai-engine.js';

const DEFAULTS = { enabled: true, preparedSources: [], blockedHosts: [], style: 'line', sourceOverrides: {},
  aiEngine: 'local', aiProviders: {}, aiConsent: false, aiRevision: '0' };
const CREDENTIALS_KEY = 'bt:cloudCredentials';
const cloud = new CloudTranslator({ fetch: (...args) => globalThis.fetch(...args) });
// Never expose local credentials or their change events to webpage content scripts.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void storageReady.then(() => chrome.storage.local.set({ btInstalledVersion: chrome.runtime.getManifest().version }));
const pendingSessions = new Set();
const failedCloudSessions = new Map();
const jobs = new Map();
let creatingOffscreen;
const sessionKey = tabId => `bt:session:${tabId}`;
const stateKey = tabId => `bt:state:${tabId}`;

function isWeb(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}
async function settings() { await storageReady; return chrome.storage.local.get(DEFAULTS); }
async function sessionFor(tabId) { return (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)]; }
async function storeState(tabId, value) {
  await chrome.storage.session.set({ [stateKey(tabId)]: value });
  const badge = value.status === 'needsSetup' || value.status === 'error' ? '!' : value.status === 'paused' ? '停' : '';
  await chrome.action.setBadgeText({ tabId, text: badge }).catch(() => {});
  if (badge) await chrome.action.setBadgeBackgroundColor({ tabId, color: value.status === 'paused' ? '#68766d' : '#a56730' }).catch(() => {});
}
async function tellEngine(message) {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] });
  if (!existing.length) {
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['WORKERS'],
        justification: 'Run a paragraph chunking worker alongside the document-only local Translator API for automatic webpage translation.'
      }).finally(() => { creatingOffscreen = null; });
    }
    await creatingOffscreen;
  }
  if (creatingOffscreen) await creatingOffscreen;
  // A module script can finish initialization a tick after the document loads.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'bt-offscreen', ...message });
      if (response !== undefined) return response;
      if (attempt === 2) throw new Error('本機翻譯程序還沒準備好，請稍後重試。');
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
    catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))); }
  }
}

async function cancelSession(session) {
  if (!session) return;
  pendingSessions.delete(session.id);
  failedCloudSessions.delete(session.id);
  cloud.cancelSession(session.id);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) chrome.runtime.sendMessage({ target: 'bt-offscreen', type: 'BT_ENGINE_CANCEL', sessionId: session.id }).catch(() => {});
}

async function detectSource(tabId, info, config, hostname) {
  const override = config.sourceOverrides?.[hostname];
  if (override && override !== 'auto') return normalizeLanguage(override);
  const html = normalizeLanguage(info?.lang);
  let detected = null;
  try { detected = normalizeLanguage(await chrome.tabs.detectLanguage(tabId)); } catch { /* HTML lang is a local fallback. */ }
  if ((!detected || detected === 'zh') && html === 'zh-Hant') return 'zh-Hant';
  const source = detected || html;
  if (source) return source;
  const sample = String(info?.sample || '');
  const latin = (sample.match(/[a-z]/gi) || []).length;
  return latin > 24 && latin / Math.max(1, sample.length) > 0.65 ? 'en' : null;
}

async function configure(message, sender) {
  const tabId = sender.tab.id;
  const documentId = sender.documentId;
  const hostname = new URL(sender.url).hostname;
  const config = await settings();
  const previous = await sessionFor(tabId);
  await cancelSession(previous);
  await chrome.storage.session.remove(sessionKey(tabId));
  if (!config.enabled || config.blockedHosts.includes(hostname)) {
    await storeState(tabId, { status: 'paused' });
    return { ok: true, enabled: false };
  }
  const sourceLanguage = await detectSource(tabId, message.info, config, hostname);
  if (!sourceLanguage || sourceLanguage === 'zh-Hant') {
    await storeState(tabId, { status: 'idle', sourceLanguage, error: sourceLanguage ? '這頁已是繁體中文。' : '這頁語言不明，可從工具列指定。' });
    return { ok: true, enabled: false };
  }
  const engine = Object.hasOwn(AI_PROVIDERS, config.aiEngine) ? config.aiEngine : 'local';
  if (engine !== 'local') {
    const credentials = (await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] || {};
    if (!config.aiConsent || !credentials[engine]) {
      await storeState(tabId, { status: 'needsSetup', sourceLanguage, engine, error: '請先在「翻譯引擎設定」儲存自己的 API 金鑰並同意雲端翻譯。' });
      return { ok: true, enabled: false, needsSetup: true, sourceLanguage };
    }
  }
  if (engine === 'local' && !config.preparedSources.includes(sourceLanguage)) {
    await storeState(tabId, { status: 'needsSetup', sourceLanguage, error: '請先在「語言與初次設定」準備這個語言的模型，之後就會自動翻譯。' });
    return { ok: true, enabled: false, needsSetup: true, sourceLanguage };
  }
  const session = { id: crypto.randomUUID(), documentId, sourceLanguage, targetLanguage: 'zh-Hant', hostname, pageUrl: sender.url.split('#')[0], engine,
    model: engine === 'local' ? '' : config.aiProviders[engine]?.model || AI_PROVIDERS[engine].defaultModel, revision: config.aiRevision };
  pendingSessions.add(session.id);
  await chrome.storage.session.set({ [sessionKey(tabId)]: session });
  await storeState(tabId, { status: 'translating', sourceLanguage });
  return { ok: true, enabled: true, sessionId: session.id, sourceLanguage, targetLanguage: 'zh-Hant', style: config.style === 'soft' ? 'soft' : 'line' };
}

function configureSerial(message, sender) {
  const tabId = sender.tab.id;
  const work = (jobs.get(tabId) || Promise.resolve()).catch(() => {}).then(() => configure(message, sender));
  jobs.set(tabId, work);
  work.finally(() => { if (jobs.get(tabId) === work) jobs.delete(tabId); }).catch(() => {});
  return work;
}

async function validSession(message, sender) {
  const session = await sessionFor(sender.tab.id);
  if (!session || session.id !== message.sessionId || session.documentId !== sender.documentId) return null;
  let currentTab;
  try { currentTab = await chrome.tabs.get(sender.tab.id); } catch { return null; }
  const currentUrl = currentTab.pendingUrl || currentTab.url || '';
  if (!isWeb(currentUrl) || (session.pageUrl && currentUrl.split('#')[0] !== session.pageUrl)) return null;
  const config = await settings();
  if (!config.enabled || config.blockedHosts.includes(session.hostname) || session.revision !== config.aiRevision || session.engine !== config.aiEngine || (session.engine !== 'local' && !config.aiConsent)) return null;
  return session;
}

async function handleContent(message, sender) {
  if (message.type === 'BT_AUTO_CONFIG') return configureSerial(message, sender);
  const session = await validSession(message, sender);
  if (!session) return { ok: false, cancelled: true, error: '這次翻譯已停止。' };
  if (message.type === 'BT_STATUS') {
    await storeState(sender.tab.id, { status: message.failed ? 'error' : message.phase === 'translating' ? 'translating' : 'ready', sourceLanguage: session.sourceLanguage,
      translated: Number(message.translated) || 0, total: Number(message.total) || 0, error: String(message.error || '').slice(0, 300) });
    return { ok: true };
  }
  if (message.type === 'BT_TRANSLATE') {
    if (failedCloudSessions.has(session.id)) return { ok: false, error: failedCloudSessions.get(session.id) };
    pendingSessions.add(session.id);
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16000) return { ok: false, error: '這段文字超出可處理的長度。' };
    let response;
    if (session.engine === 'local') {
      response = await tellEngine({ type: 'BT_ENGINE_TRANSLATE', sessionId: session.id, text: message.text,
        sourceLanguage: session.sourceLanguage, targetLanguage: session.targetLanguage });
    } else {
      const credentials = (await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] || {};
      try {
        const translation = await cloud.translate({ text: message.text, provider: session.engine, model: session.model,
          apiKey: credentials[session.engine], sourceLanguage: session.sourceLanguage, targetLanguage: session.targetLanguage,
          sessionId: session.id, isCurrent: async () => pendingSessions.has(session.id) && !failedCloudSessions.has(session.id) && Boolean(await validSession(message, sender)) });
        response = { ok: true, text: translation };
      } catch (error) {
        if (['auth', 'quota', 'model', 'balance'].includes(error.code)) failedCloudSessions.set(session.id, error.message);
        response = error.name === 'AbortError' ? { ok: false, cancelled: true } : { ok: false, error: error.message || 'AI 翻譯暫時無法使用。' };
      }
    }
    if (!await validSession(message, sender)) return { ok: false, cancelled: true };
    if (!response?.ok) await storeState(sender.tab.id, { status: response?.needsSetup ? 'needsSetup' : 'error', sourceLanguage: session.sourceLanguage, error: response?.error || '本機翻譯暫時無法使用。' });
    return response || { ok: false, error: '本機翻譯未回應。' };
  }
}

async function reconfigureTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter(tab => isWeb(tab.url)).map(tab => chrome.tabs.sendMessage(tab.id, { type: 'BT_RECONFIGURE' })));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'bt-offscreen' || sender.id !== chrome.runtime.id) return;
  const contentType = ['BT_AUTO_CONFIG', 'BT_TRANSLATE', 'BT_STATUS'].includes(message.type);
  if (contentType) {
    if (!sender.tab || sender.frameId !== 0 || !sender.documentId || !isWeb(sender.url)) return;
    handleContent(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error.message).slice(0, 240) }));
    return true;
  }
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const ui = async () => {
    if (message.type === 'BT_AI_GET_SETTINGS') return publicAISettings();
    if (message.type === 'BT_AI_TEST') {
      const { provider, model, apiKey } = await cloudInput(message);
      return cloud.testConnection({ provider, model, apiKey });
    }
    if (message.type === 'BT_AI_SAVE') return saveAISettings(message);
    if (message.type === 'BT_MODELS_READY') { if ((await settings()).aiEngine === 'local') await reconfigureTabs(); return { ok: true }; }
    if (message.type === 'BT_GET_TAB_STATE' && Number.isInteger(message.tabId)) {
      const state = (await chrome.storage.session.get(stateKey(message.tabId)))[stateKey(message.tabId)];
      return { ok: true, ...(state || { status: 'idle' }) };
    }
    if (['BT_RESTORE_CURRENT', 'BT_RETRY_CURRENT'].includes(message.type) && Number.isInteger(message.tabId)) {
      if (message.type === 'BT_RESTORE_CURRENT') {
        const session = await sessionFor(message.tabId);
        await cancelSession(session);
        await chrome.storage.session.remove(sessionKey(message.tabId));
        await chrome.tabs.sendMessage(message.tabId, { type: 'BT_RESTORE' });
        await storeState(message.tabId, { status: 'paused' });
      } else await chrome.tabs.sendMessage(message.tabId, { type: 'BT_RECONFIGURE' });
      return { ok: true };
    }
    return { ok: false, error: '未知的控制指令。' };
  };
  ui().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error.message).slice(0, 240) }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  sessionFor(tabId).then(cancelSession).catch(() => {});
  chrome.storage.session.remove([sessionKey(tabId), stateKey(tabId)]).catch(() => {});
});
chrome.runtime.onInstalled.addListener(async details => {
  const current = await chrome.storage.local.get(null);
  const initial = Object.fromEntries(Object.entries(DEFAULTS).filter(([key]) => !(key in current)));
  if (Object.keys(initial).length) await chrome.storage.local.set(initial);
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});


function providerModel(provider, requested) {
  const info = Object.hasOwn(AI_PROVIDERS, provider) ? AI_PROVIDERS[provider] : null;
  if (!info) throw new Error('請選擇支援的 AI 翻譯引擎。');
  const model = requested || info.defaultModel;
  if (!info.models.some(item => item.id === model)) throw new Error('請選擇清單中的模型。');
  return model;
}
async function cloudInput(message) {
  await storageReady;
  const provider = message.provider;
  const model = providerModel(provider, message.model);
  const stored = (await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] || {};
  const apiKey = typeof message.apiKey === 'string' && message.apiKey.trim() ? message.apiKey.trim() : stored[provider];
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > 512 || /[\r\n]/.test(apiKey)) throw new Error('請在這裡填入自己的 API 金鑰。');
  return { provider, model, apiKey };
}
async function publicAISettings() {
  const config = await settings();
  const credentials = (await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] || {};
  return { ok: true, engine: config.aiEngine, cloudConsent: !!config.aiConsent,
    providers: Object.fromEntries(Object.entries(AI_PROVIDERS).map(([id, info]) => [id, {
      model: config.aiProviders[id]?.model || info.defaultModel, hasKey: !!credentials[id]
    }])) };
}
async function invalidateSessions() {
  cloud.cancelAll();
  pendingSessions.clear();
  failedCloudSessions.clear();
  const records = await chrome.storage.session.get(null);
  const sessions = Object.entries(records).filter(([key]) => key.startsWith('bt:session:'));
  await Promise.allSettled(sessions.map(async ([key, session]) => {
    await cancelSession(session);
    await chrome.storage.session.remove(key);
    const tabId = Number(key.slice('bt:session:'.length));
    await storeState(tabId, { status: 'paused', error: '引擎設定已更新；重新整理或按「重新翻譯這頁」即可套用。' });
  }));
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter(tab => isWeb(tab.url)).map(async tab => {
    await storeState(tab.id, { status: 'paused', error: '引擎設定已更新；重新整理或按「重新翻譯這頁」即可套用。' });
    await chrome.tabs.sendMessage(tab.id, { type: 'BT_ENGINE_CHANGED' }).catch(() => {});
  }));
}
async function saveAISettings(message) {
  const config = await settings();
  const engine = message.engine;
  if (engine !== 'local' && !Object.hasOwn(AI_PROVIDERS, engine)) throw new Error('請選擇支援的翻譯引擎。');
  const credentials = (await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] || {};
  const providers = { ...config.aiProviders };
  if (engine !== 'local') {
    if (message.cloudConsent !== true) throw new Error('勾選同意傳送待翻譯文字後，才能啟用雲端 AI。');
    if (message.provider && message.provider !== engine) throw new Error('引擎與金鑰設定不一致。');
    const input = await cloudInput({ ...message, provider: engine });
    credentials[engine] = input.apiKey;
    providers[engine] = { model: input.model };
  }
  if (message.removeKey && Object.hasOwn(AI_PROVIDERS, message.provider)) {
    if (engine === message.provider) throw new Error('請先切換到本機翻譯，再移除這個引擎的金鑰。');
    delete credentials[message.provider];
  }
  // Stop old documents first. Saving never sends all currently-open pages to a new provider.
  await invalidateSessions();
  await chrome.storage.local.set({ [CREDENTIALS_KEY]: credentials, aiEngine: engine, aiProviders: providers,
    aiConsent: engine !== 'local' && message.cloudConsent === true, aiRevision: crypto.randomUUID() });
  return publicAISettings();
}

// With trusted storage, preference changes are relayed without leaking key values.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['aiEngine', 'aiProviders', 'aiConsent', 'aiRevision'].some(key => key in changes)) {
    // saveAISettings already cancelled old documents before atomically committing settings.
    return;
  }
  const relevant = ['enabled', 'preparedSources', 'blockedHosts', 'style', 'sourceOverrides'];
  if (!relevant.some(key => key in changes)) return;
  const safeChanges = Object.fromEntries(relevant.filter(key => key in changes).map(key => [key, changes[key]]));
  void chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.filter(tab => isWeb(tab.url)).map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: 'BT_SETTINGS_CHANGED', changes: safeChanges }))));
  if (changes.enabled?.newValue === false || changes.blockedHosts) {
    void chrome.storage.session.get(null).then(records => Promise.allSettled(Object.entries(records)
      .filter(([key]) => key.startsWith('bt:session:')).map(async ([key, session]) => {
        const fresh = await settings();
        if (!fresh.enabled || fresh.blockedHosts.includes(session.hostname)) {
          await cancelSession(session);
          await chrome.storage.session.remove(key);
        }
      })));
  }
});
