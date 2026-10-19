// Chrome downloads and runs its own language models; this extension has no fetch calls.
export const SUPPORTED_SOURCES = new Set([
  'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi',
  'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl', 'no', 'pl', 'pt',
  'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-Hant'
]);

export function normalizeLanguage(value) {
  const tag = String(value || '').replaceAll('_', '-').toLowerCase();
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return 'zh-Hant';
  const base = tag.split('-')[0];
  return SUPPORTED_SOURCES.has(base) ? base : null;
}

// Preserve whitespace at hard boundaries; never silently truncate a paragraph.
export function splitText(text, max = 1800) {
  if (!Number.isInteger(max) || max < 2) throw new Error('Invalid chunk limit');
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = 0;
    const prefix = rest.slice(0, max);
    for (const match of prefix.matchAll(/[.!?。！？\n]\s*/gu)) {
      const end = match.index + match[0].length;
      if (end >= max / 2) cut = end;
    }
    if (!cut) {
      const space = prefix.lastIndexOf(' ');
      cut = space > max / 2 ? space + 1 : max;
    }
    // Do not split an emoji / other astral character in half.
    const before = rest.charCodeAt(cut - 1);
    if (before >= 0xD800 && before <= 0xDBFF) cut--;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function readableError(error) {
  const name = error?.name || '';
  const detail = String(error?.message || error || '');
  if (name === 'NotAllowedError' || /user activation|gesture|permission/i.test(detail)) {
    return 'Chrome 需要直接點按才能準備模型。請再按一次翻譯按鈕；也請確認這不是無痕視窗或受管理的瀏覽器。';
  }
  if (name === 'NotSupportedError' || /unavailable|not supported|not available/i.test(detail)) {
    return '這台 Chrome 目前無法使用此語言對。請更新桌面版 Chrome、檢查來源語言，並確認瀏覽器政策允許內建翻譯。';
  }
  if (/network|download|failed to fetch/i.test(detail)) {
    return '語言模型下載未完成。請確認網路可用，稍後再按翻譯按鈕。';
  }
  if (name === 'AbortError') return '這次操作已停止，可以重新開始。';
  if (/context|quota|input.*long/i.test(detail)) return '這段文字超出模型可處理的範圍，請選取較短的文字再試。';
  return `翻譯未完成：${detail.slice(0, 180) || '請重新嘗試。'}`;
}

export class LocalTranslator {
  constructor(api = globalThis.Translator, options = {}) {
    this.api = api;
    this.models = new Map();
    this.pending = new Map();
    this.cache = new Map();
    this.cacheLimit = 600;
    this.chunker = options.chunker || splitText;
    // Chrome translates sequentially. A single queue bounds memory and work.
    this.tail = Promise.resolve();
  }

  get supported() {
    return Boolean(this.api && typeof this.api.create === 'function');
  }

  async prepare(sourceLanguage, targetLanguage, onProgress = () => {}) {
    if (!this.supported) throw new Error('Translator API is not available');
    const key = `${sourceLanguage}:${targetLanguage}`;
    if (this.models.has(key)) return this.models.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    // Called before any await so the setup button's user activation is preserved.
    const creating = this.api.create({
      sourceLanguage, targetLanguage,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => onProgress(event.loaded));
      }
    }).then(model => {
      this.models.set(key, model);
      return model;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, creating);
    return creating;
  }

  translate(text, sourceLanguage, targetLanguage, isCurrent = () => true) {
    const key = `${sourceLanguage}\u0000${targetLanguage}\u0000${text}`;
    const work = async () => {
      if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
      if (this.cache.has(key)) {
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
      }
      const model = this.models.get(`${sourceLanguage}:${targetLanguage}`);
      if (!model) throw new Error('語言模型尚未準備好，請先按翻譯按鈕。');
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('文字長度無法處理。');
      const results = [];
      for (const chunk of await this.chunker(text)) {
        if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
        if (!chunk.trim()) { results.push(chunk); continue; }
        const result = await model.translate(chunk.trim());
        if (typeof result !== 'string' || !result.trim()) throw new Error('模型沒有傳回譯文。');
        results.push(result.trim());
      }
      if (!isCurrent()) throw new DOMException('Cancelled', 'AbortError');
      const translated = results.join('\n');
      this.cache.set(key, translated);
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
      return translated;
    };
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  clearCache() { this.cache.clear(); }
}
