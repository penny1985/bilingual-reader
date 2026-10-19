import { normalizeLanguage } from './engine.js';

// Inactive tabs may never finish Chrome's detection. Prefer explicit language
// metadata and bound the fallback so background translation can still start.
export async function detectSourceLanguage({
  override, lang, sample, detectLanguage,
  timeoutMs = 1500,
  scheduleTimeout = globalThis.setTimeout,
  cancelTimeout = globalThis.clearTimeout
} = {}) {
  const specified = normalizeLanguage(override);
  if (specified) return specified;
  const declared = normalizeLanguage(lang);
  if (declared) return declared;

  let detected = null;
  if (typeof detectLanguage === 'function') {
    let timer;
    try {
      detected = await Promise.race([
        Promise.resolve().then(detectLanguage).then(normalizeLanguage, () => null),
        new Promise(resolve => { timer = scheduleTimeout(() => resolve(null), timeoutMs); })
      ]);
    } finally {
      cancelTimeout(timer);
    }
  }
  if (detected) return detected;
  const text = String(sample || '');
  const latin = (text.match(/[a-z]/gi) || []).length;
  return latin > 24 && latin / Math.max(1, text.length) > 0.65 ? 'en' : null;
}
