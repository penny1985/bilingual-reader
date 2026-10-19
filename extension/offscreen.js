import { LocalTranslator, readableError } from './engine.js';

// A real module worker chunks long paragraphs for all open webpages.
// Chrome's window-only Translator stays in this offscreen Window.
const worker = new Worker('chunk-worker.js', { type: 'module' });
const pendingChunks = new Map();
let chunkId = 0;
worker.onmessage = ({ data }) => {
  const pending = pendingChunks.get(data.id);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingChunks.delete(data.id);
  if (data.error) pending.reject(new Error(data.error));
  else pending.resolve(data.chunks);
};
worker.onerror = event => {
  for (const pending of pendingChunks.values()) { clearTimeout(pending.timeout); pending.reject(new Error(event.message || '文字處理程序未回應。')); }
  pendingChunks.clear();
};
const engine = new LocalTranslator(globalThis.Translator, { chunker: text => new Promise((resolve, reject) => {
  const id = ++chunkId;
  const timeout = setTimeout(() => { pendingChunks.delete(id); reject(new Error('文字處理逾時，請重試。')); }, 10000);
  pendingChunks.set(id, { resolve, reject, timeout });
  worker.postMessage({ id, text });
}) });
const cancelled = new Set();
const preparing = new Map();

async function ready(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}:${targetLanguage}`;
  if (engine.models.has(key)) return;
  if (preparing.has(key)) return preparing.get(key);
  const work = (async () => {
    if (!engine.supported) throw new Error('Translator API is not available');
    for (const delay of [0, 500, 1000, 2000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const state = await Translator.availability({ sourceLanguage, targetLanguage });
      if (state !== 'available') {
        const error = new Error('這個語言的模型需要準備。請從工具列開啟「語言與初次設定」。');
        error.needsSetup = true;
        throw error;
      }
      try { await engine.prepare(sourceLanguage, targetLanguage); return; }
      catch (error) {
        // The model service can need a brief warm-up after a cold Chrome startup.
        if (delay === 2000 || !['NotSupportedError', 'OperationError', 'UnknownError'].includes(error.name)) throw error;
      }
    }
  })();
  preparing.set(key, work);
  try { return await work; } finally { preparing.delete(key); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'bt-offscreen' || sender.tab || sender.id !== chrome.runtime.id) return;
  if (message.type === 'BT_ENGINE_CANCEL') {
    cancelled.add(message.sessionId);
    while (cancelled.size > 1000) cancelled.delete(cancelled.values().next().value);
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== 'BT_ENGINE_TRANSLATE') return;
  const run = async () => {
    if (cancelled.has(message.sessionId)) return { ok: false, cancelled: true };
    if (typeof message.text !== 'string' || message.text.length > 16000) return { ok: false, error: '文字長度無法處理。' };
    await ready(message.sourceLanguage, message.targetLanguage);
    const text = await engine.translate(message.text, message.sourceLanguage, message.targetLanguage, () => !cancelled.has(message.sessionId));
    return { ok: true, text };
  };
  run().then(sendResponse).catch(error => sendResponse({ ok: false, cancelled: error.name === 'AbortError', needsSetup: Boolean(error.needsSetup), error: readableError(error) }));
  return true;
});
