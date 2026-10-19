import { LocalTranslator, readableError, normalizeLanguage } from './engine.js';
import { AI_PROVIDERS } from './ai-engine.js';

const translator = new LocalTranslator();
const $ = id => document.getElementById(id);
const labels = { en: '英文', ja: '日文', ko: '韓文', zh: '簡體中文', fr: '法文', de: '德文', es: '西班牙文', pt: '葡萄牙文', ru: '俄文', vi: '越南文', th: '泰文' };
const originalLabels = new Map();
const prepared = new Set();
let preparing = false;
let selectedEngine = 'gemini';
let aiSettings = { engine: 'local', providers: {}, cloudConsent: false };
let aiBusy = false;
let providerDrafts = {};

function aiStatus(kind, title, detail, error = false) {
  $(`ai-${kind}-result`).hidden = false;
  $(`ai-${kind}-result`).classList.toggle('error', error);
  $(`ai-${kind}-title`).textContent = title;
  $(`ai-${kind}-detail`).textContent = detail;
}

function activeEngineLabel() {
  $('active-engine').textContent = aiSettings.engine === 'gemini' ? '目前使用 Gemini AI' : aiSettings.engine === 'deepseek' ? '目前使用 DeepSeek AI' : '目前使用本機翻譯';
}

function renderEngine() {
  const isLocal = selectedEngine === 'local';
  $('ai-settings').hidden = isLocal;
  $('native-settings').hidden = !isLocal;
  for (const input of document.querySelectorAll('[name="engine"]')) input.checked = input.value === selectedEngine;
  activeEngineLabel();
  if (isLocal) return;
  const provider = AI_PROVIDERS[selectedEngine];
  const saved = aiSettings.providers?.[selectedEngine] || {};
  const draft = providerDrafts[selectedEngine] || {};
  $('ai-heading').textContent = `使用自己的 ${selectedEngine === 'gemini' ? 'Gemini' : 'DeepSeek'} 金鑰`;
  $('key-link').href = provider.keyUrl;
  $('pricing-link').href = provider.pricingUrl;
  $('consent-provider').textContent = provider.label;
  $('provider-description').textContent = selectedEngine === 'gemini' ? '不需訂閱雙語伴讀。Gemini 提供免費額度，實際可用額度依你的帳號與地區而定。' : '不需月訂閱。DeepSeek 使用你自己的 API 帳戶，依服務商的實際用量計費。';
  $('billing-note').textContent = selectedEngine === 'gemini' ? '免費額度有速度與用量限制；Google 免費服務可能使用提交內容改善產品。若你的 API 專案已開啟計費，會依帳號方案收費。本擴充功能不會替你開啟計費。' : '請先查看 DeepSeek 的帳戶餘額、計費及資料使用政策。網頁文字會直接傳送給 DeepSeek；本擴充功能不會替你儲值，也不會切換其他服務。';
  $('ai-model').replaceChildren(...provider.models.map(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    return option;
  }));
  const model = draft.model || saved.model || provider.defaultModel;
  $('ai-model').value = provider.models.some(candidate => candidate.id === model) ? model : provider.defaultModel;
  $('api-key').value = draft.apiKey || '';
  $('api-key').type = 'password';
  $('toggle-key').textContent = '顯示';
  $('toggle-key').setAttribute('aria-label', '顯示輸入的金鑰');
  $('toggle-key').setAttribute('aria-pressed', 'false');
  $('api-key').placeholder = saved.hasKey ? '已儲存金鑰；留白即可保留' : '貼上你自己的 API 金鑰';
  $('key-state').textContent = saved.hasKey ? '已在這台 Chrome 儲存' : '尚未設定';
  $('cloud-consent').checked = draft.cloudConsent ?? (aiSettings.engine === selectedEngine && aiSettings.cloudConsent === true);
  $('save-ai').replaceChildren(document.createTextNode(`儲存並啟用 ${selectedEngine === 'gemini' ? 'Gemini' : 'DeepSeek'} `), Object.assign(document.createElement('span'), { textContent: '→' }));
  $('remove-key').hidden = !saved.hasKey;
  $('remove-key-note').hidden = !saved.hasKey;
}

function setAIBusy(busy) {
  aiBusy = busy;
  for (const id of ['test-ai', 'save-ai', 'remove-key', 'save-local', 'ai-model', 'api-key', 'cloud-consent']) $(id).disabled = busy;
  for (const input of document.querySelectorAll('[name="engine"]')) input.disabled = busy;
}

async function readAISettings() {
  const response = await chrome.runtime.sendMessage({ type: 'BT_AI_GET_SETTINGS' });
  if (!response?.ok) throw new Error('無法讀取引擎設定。請重新載入擴充功能後再試。');
  aiSettings = response;
}

function aiRequest(type) {
  const apiKey = $('api-key').value.trim();
  if (!apiKey && !aiSettings.providers?.[selectedEngine]?.hasKey) {
    throw new Error('請先貼上你自己的 API 金鑰。金鑰只會儲存在這台 Chrome。');
  }
  return { type, provider: selectedEngine, model: $('ai-model').value, ...(apiKey ? { apiKey } : {}) };
}

for (const input of document.querySelectorAll('[name="engine"]')) {
  input.addEventListener('change', () => {
    if (aiBusy || !input.checked) return;
    if (selectedEngine !== 'local') providerDrafts[selectedEngine] = { model: $('ai-model').value, apiKey: $('api-key').value, cloudConsent: $('cloud-consent').checked };
    selectedEngine = input.value;
    $('ai-test-result').hidden = true;
    $('ai-save-result').hidden = true;
    renderEngine();
  });
}

$('toggle-key').addEventListener('click', () => {
  const visible = $('api-key').type === 'password';
  $('api-key').type = visible ? 'text' : 'password';
  $('toggle-key').textContent = visible ? '隱藏' : '顯示';
  $('toggle-key').setAttribute('aria-label', visible ? '隱藏輸入的金鑰' : '顯示輸入的金鑰');
  $('toggle-key').setAttribute('aria-pressed', String(visible));
});

$('test-ai').addEventListener('click', async () => {
  if (aiBusy) return;
  try {
    const request = aiRequest('BT_AI_TEST');
    setAIBusy(true);
    aiStatus('test', '正在測試 AI 翻譯…', '只翻譯固定的博物館開放時間範例，尚未啟用網頁 AI 翻譯。');
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.ok) throw new Error(response?.error || '連線未完成，請稍後再試。');
    aiStatus('test', 'AI 連線成功', `原文：The museum opens at nine. Admission is free on Sundays.\n譯文：${response.translation || ''}\n\n滿意後，勾選下方同意項目並儲存。`);
  } catch (error) {
    aiStatus('test', 'AI 測試未完成', error.message || '請確認金鑰與帳號額度。', true);
  } finally { setAIBusy(false); }
});

$('save-ai').addEventListener('click', async () => {
  if (aiBusy) return;
  try {
    const request = aiRequest('BT_AI_SAVE');
    if (!$('cloud-consent').checked) throw new Error('請先勾選同意項目，確認網頁文字會傳送給選擇的 AI 服務。');
    setAIBusy(true);
    const response = await chrome.runtime.sendMessage({ ...request, engine: selectedEngine, cloudConsent: true });
    if (!response?.ok) throw new Error(response?.error || '設定未儲存，請再試一次。');
    providerDrafts = {};
    $('api-key').value = '';
    await readAISettings();
    renderEngine();
    aiStatus('save', `${selectedEngine === 'gemini' ? 'Gemini' : 'DeepSeek'} AI 已啟用`, '新開或重新整理的外語網頁，會自動用 AI 翻譯。已開著的頁面，請點伴讀圖示，再按「重新翻譯這頁」。');
  } catch (error) {
    aiStatus('save', '設定尚未完成', error.message || '請確認金鑰與同意項目。', true);
  } finally { setAIBusy(false); }
});

async function saveLocal(removeProviderKey = false) {
  if (aiBusy) return;
  setAIBusy(true);
  try {
    const request = { type: 'BT_AI_SAVE', engine: 'local', cloudConsent: false };
    if (removeProviderKey) Object.assign(request, { provider: selectedEngine, removeKey: true });
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.ok) throw new Error(response?.error || '設定未儲存，請再試一次。');
    providerDrafts = {};
    $('api-key').value = '';
    await readAISettings();
    selectedEngine = 'local';
    renderEngine();
    aiStatus('save', removeProviderKey ? '金鑰已刪除，已切回本機翻譯' : '已切換為本機翻譯', '請確認下方語言模型已準備好。新開或重新整理的網頁會套用此設定。');
  } catch (error) {
    aiStatus('save', '設定尚未完成', error.message || '請重新開啟設定頁後再試。', true);
  } finally { setAIBusy(false); }
}
$('save-local').addEventListener('click', () => saveLocal());
$('remove-key').addEventListener('click', () => saveLocal(true));

function showProgress(title, detail, error = false) {
  $('progress-box').hidden = false;
  $('progress-box').classList.toggle('error', error);
  $('progress-title').textContent = title;
  $('progress-detail').textContent = detail;
  $('download').hidden = error;
}

function updateButtons() {
  for (const button of document.querySelectorAll('.prepare-button')) {
    const source = button.dataset.source || $('more-source').value;
    const ready = prepared.has(source);
    button.disabled = preparing || !translator.supported;
    if (ready) {
      button.textContent = '已準備 ✓';
      button.setAttribute('aria-label', `${labels[source] || source}已準備，按一下重新確認`);
    } else {
      button.textContent = originalLabels.get(button);
      button.removeAttribute('aria-label');
    }
  }
  $('more-source').disabled = preparing || !translator.supported;
  $('language-state-en').textContent = prepared.has('en') ? '英文翻譯已準備好，開網頁就能閱讀雙語。' : '大多數英文網站都用得到。';
}

function showSuccess(source, enabled = true) {
  $('success-box').hidden = false;
  $('success-title').textContent = `${labels[source] || '語言'}翻譯已準備好。`;
  $('success-detail').textContent = aiSettings.engine === 'local' ? `現在可以關閉這頁，之後開${labels[source] || '這個語言的'}網頁會自動雙語。` : '本機模型已準備好。按「使用本機翻譯」後，新開或重新整理的網頁就會使用它。';
  $('success-detail').hidden = !enabled;
  $('paused-note').hidden = enabled;
}

function preparationError(error) {
  if (!translator.supported || /Translator API is not available/i.test(String(error?.message || ''))) {
    return '這台 Chrome 目前不支援內建翻譯。請先更新桌面版 Chrome，再重新開啟這頁；無痕模式或受管理的瀏覽器也可能無法使用。';
  }
  if (error?.name === 'NotAllowedError' || /user activation|gesture|permission/i.test(String(error?.message || ''))) {
    return 'Chrome 需要你直接點按才能準備模型。請再按一次準備按鈕，並保持這頁開啟。';
  }
  return readableError(error).replaceAll('翻譯按鈕', '準備按鈕');
}

async function prepareLanguage(source) {
  if (preparing) return;
  const normalized = normalizeLanguage(source);
  if (!normalized || !labels[normalized]) return;
  preparing = true;
  $('success-box').hidden = true;
  $('download').hidden = false;
  $('download').removeAttribute('value');
  showProgress(`正在準備${labels[normalized]}翻譯…`, '第一次可能需要幾分鐘，請保持連網並留在這頁。');
  // Call create through prepare synchronously in the click event. Reading storage
  // before this call would consume Chrome's transient user activation.
  const preparation = translator.prepare(normalized, 'zh-Hant', loaded => {
    const progress = Math.max(0, Math.min(1, Number(loaded) || 0));
    $('download').value = progress;
    $('progress-detail').textContent = `正在下載語言模型 ${Math.round(progress * 100)}%，請留在這頁。`;
  });
  updateButtons();
  try {
    await preparation;
    const stored = await chrome.storage.local.get({ preparedSources: [], enabled: true });
    const sources = new Set(Array.isArray(stored.preparedSources) ? stored.preparedSources : []);
    sources.add(normalized);
    // Preserve the global switch if the reader has deliberately turned it off.
    await chrome.storage.local.set({ preparedSources: [...sources] });
    for (const ready of sources) prepared.add(ready);
    $('download').value = 1;
    $('progress-box').hidden = true;
    showSuccess(normalized, stored.enabled !== false);
    try { await chrome.runtime.sendMessage({ type: 'BT_MODELS_READY' }); } catch { /* Already-open tabs retry when their settings change. */ }
  } catch (error) {
    showProgress('語言模型尚未準備完成', preparationError(error), true);
  } finally {
    preparing = false;
    updateButtons();
  }
}

for (const button of document.querySelectorAll('.prepare-button')) {
  originalLabels.set(button, button.textContent.trim());
  button.addEventListener('click', () => prepareLanguage(button.dataset.source || $('more-source').value));
}
$('more-source').addEventListener('change', updateButtons);

async function init() {
  renderEngine();
  if (!globalThis.chrome?.storage?.local) {
    showProgress('請在 Chrome 擴充功能中開啟', '先在 chrome://extensions 載入「雙語伴讀」的 extension 資料夾，再點擴充功能的「語言與初次設定」。', true);
    for (const button of document.querySelectorAll('.prepare-button')) button.disabled = true;
    $('more-source').disabled = true;
    setAIBusy(true);
    return;
  }
  try {
    await readAISettings();
    selectedEngine = aiSettings.engine === 'deepseek' ? 'deepseek' : 'gemini';
    renderEngine();
  } catch (error) {
    aiStatus('save', '引擎設定尚未就緒', error.message, true);
  }
  if (!translator.supported) {
    showProgress('目前無法使用本機翻譯', preparationError(new Error('Translator API is not available')), true);
    updateButtons();
    // Cloud AI can still be configured on Chrome without the native API.
  }
  try {
    const stored = await chrome.storage.local.get({ preparedSources: [], enabled: true });
    for (const source of Array.isArray(stored.preparedSources) ? stored.preparedSources : []) prepared.add(source);
    if (prepared.size) {
      const source = prepared.has('en') ? 'en' : [...prepared][0];
      showSuccess(source, stored.enabled !== false);
    }
  } catch {
    showProgress('暫時無法讀取設定', '請重新開啟這頁後再試一次。', true);
  }
  updateButtons();
}
init();
