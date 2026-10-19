const $ = id => document.getElementById(id);
const defaults = { enabled: true, preparedSources: [], blockedHosts: [], style: 'line', sourceOverrides: {} };
let settings = { ...defaults };
let tabId = null;
let hostname = '';
let latestState = null;
let stateRequest = 0;
let aiSettings = { engine: 'local', providers: {}, cloudConsent: false };

function showStatus(title, detail, error = false) {
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
  $('status-box').classList.toggle('error', error);
}

function render() {
  const isAI = aiSettings.engine === 'gemini' || aiSettings.engine === 'deepseek';
  $('engine-tag').textContent = aiSettings.engine === 'gemini' ? 'Gemini AI' : aiSettings.engine === 'deepseek' ? 'DeepSeek AI' : '本機翻譯';
  $('engine-note').textContent = isAI ? '使用自己的 API 金鑰' : '本機翻譯 · 不需訂閱';
  const validPage = Boolean(hostname && Number.isInteger(tabId));
  const blocked = settings.blockedHosts.includes(hostname);
  $('enabled').checked = settings.enabled;
  $('enabled').disabled = false;
  $('site-enabled').checked = !blocked;
  $('site-enabled').disabled = !validPage;
  $('style').value = settings.style === 'soft' ? 'soft' : 'line';
  $('style').disabled = false;
  $('source').value = settings.sourceOverrides[hostname] || 'auto';
  if (!$('source').value) $('source').value = 'auto';
  $('source').disabled = !validPage;
  $('restore').disabled = !validPage;
  $('retry').disabled = !validPage || !settings.enabled || blocked;
  if (!validPage) {
    showStatus('請開啟一般網頁', 'Chrome 內部頁面、擴充功能商店與 PDF 閱讀器不支援雙語翻譯。');
    return;
  }
  if (!settings.enabled) {
    showStatus('自動翻譯已關閉', '開啟上方開關，之後外語網頁會自動顯示雙語。');
    return;
  }
  if (blocked) {
    showStatus('這個網站已暫停翻譯', '開啟網站開關，就會自動翻譯這個網站。');
    return;
  }
  const state = latestState;
  if (state?.status === 'error') {
    showStatus('這頁暫時無法翻譯', state.error || '請重新翻譯，或到語言設定確認模型已經準備好。', true);
  } else if (state?.status === 'needsSetup' || (!isAI && !settings.preparedSources.length)) {
    showStatus(isAI ? '先完成 AI 引擎設定' : '先準備語言模型', '點下方「翻譯引擎與設定」完成一次設定，之後自動翻譯。');
  } else if (state?.status === 'translating') {
    const translated = Number(state.translated);
    const total = Number(state.total);
    const progress = Number.isFinite(translated) && Number.isFinite(total) && total > 0 ? `已完成 ${translated} / ${total} 段。` : '';
    showStatus('正在自動翻譯', `${progress}你可以關閉這個面板，繼續閱讀網頁。`);
  } else if (state?.status === 'paused') {
    if (state.error) showStatus('新引擎等待套用', state.error);
    else showStatus('這頁已還原', '點「重新翻譯這頁」恢復雙語，新開的網頁仍會自動翻譯。');
  } else if (state?.status === 'ready') {
    const translated = Number(state.translated);
    showStatus('雙語伴讀已開啟', translated > 0 ? `已翻譯 ${translated} 段。捲動時會繼續處理新段落。` : '譯文會自動出現在網頁段落下方。');
  } else {
    showStatus('自動翻譯已開啟', '外語段落會自動接上繁體中文，這個面板可以隨時關閉。');
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(defaults);
  settings = {
    ...defaults, ...stored,
    enabled: stored.enabled !== false,
    blockedHosts: Array.isArray(stored.blockedHosts) ? stored.blockedHosts : [],
    preparedSources: Array.isArray(stored.preparedSources) ? stored.preparedSources : [],
    sourceOverrides: stored.sourceOverrides && typeof stored.sourceOverrides === 'object' ? stored.sourceOverrides : {}
  };
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BT_AI_GET_SETTINGS' });
    if (response?.ok) aiSettings = response;
  } catch { /* Native mode remains available while an older background reloads. */ }
  render();
}

async function fetchState() {
  if (!Number.isInteger(tabId) || !hostname) return;
  const request = ++stateRequest;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BT_GET_TAB_STATE', tabId });
    if (request !== stateRequest) return;
    latestState = response?.ok ? response : null;
  } catch {
    if (request !== stateRequest) return;
    latestState = null;
  }
  render();
}

async function saveSetting(change) {
  try {
    await chrome.storage.local.set(change);
    settings = { ...settings, ...change };
    latestState = null;
    render();
    await fetchState();
  } catch {
    showStatus('設定未儲存', '請重新開啟面板後再試一次。', true);
  }
}

$('enabled').addEventListener('change', () => saveSetting({ enabled: $('enabled').checked }));
$('style').addEventListener('change', () => saveSetting({ style: $('style').value }));
$('site-enabled').addEventListener('change', async () => {
  const enabled = $('site-enabled').checked;
  try {
    const stored = await chrome.storage.local.get({ blockedHosts: [] });
    const hosts = new Set(Array.isArray(stored.blockedHosts) ? stored.blockedHosts : []);
    if (enabled) hosts.delete(hostname); else hosts.add(hostname);
    await saveSetting({ blockedHosts: [...hosts] });
  } catch {
    showStatus('網站設定未儲存', '請重新開啟面板後再試一次。', true);
  }
});
$('source').addEventListener('change', async () => {
  const value = $('source').value;
  try {
    const stored = await chrome.storage.local.get({ sourceOverrides: {} });
    const overrides = { ...stored.sourceOverrides };
    if (value === 'auto') delete overrides[hostname]; else overrides[hostname] = value;
    await saveSetting({ sourceOverrides: overrides });
  } catch {
    showStatus('語言設定未儲存', '請重新開啟面板後再試一次。', true);
  }
});

async function pageAction(type, button) {
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type, tabId });
    if (result?.ok === false) throw new Error(result.error || '請重新整理網頁後再試。');
    latestState = type === 'BT_RESTORE_CURRENT' ? { status: 'paused' } : { status: 'translating' };
    render();
    setTimeout(fetchState, 350);
  } catch (error) {
    render();
    showStatus('這次操作未完成', error.message || '請重新整理網頁後再試。', true);
  }
}
$('restore').addEventListener('click', () => pageAction('BT_RESTORE_CURRENT', $('restore')));
$('retry').addEventListener('click', () => pageAction('BT_RETRY_CURRENT', $('retry')));
$('setup').addEventListener('click', () => {
  if (globalThis.chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
  else showStatus('請從 Chrome 擴充功能開啟', '先載入 extension 資料夾，再點工具列上的雙語伴讀圖示。');
});

globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(key => key in defaults || key === 'aiEngine' || key === 'aiRevision')) {
    loadSettings().then(fetchState).catch(() => showStatus('無法讀取設定', '請重新開啟面板。', true));
  }
});

async function init() {
  if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.tabs?.query) {
    $('hostname').textContent = '請從工具列開啟';
    showStatus('這是擴充功能的控制面板', '在 Chrome 載入 extension 資料夾後，點工具列上的雙語伴讀圖示即可使用。');
    return;
  }
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id ?? null;
    try {
      const url = new URL(activeTab?.url || '');
      if (['http:', 'https:'].includes(url.protocol)) hostname = url.hostname;
    } catch { /* Internal and missing URLs have no site controls. */ }
    $('hostname').textContent = hostname || '目前頁面不支援';
    await loadSettings();
    await fetchState();
  } catch {
    showStatus('無法讀取目前網頁', '請關閉面板、回到想閱讀的網頁，再按伴讀圖示。', true);
  }
}
init();
setInterval(fetchState, 1500);
