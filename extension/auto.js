(() => {
  "use strict";

  if (globalThis.__BT_READER_AUTO_CONTROL__ || window.top !== window) return;
  const reader = globalThis.__BT_READER_CONTROL__;
  if (!reader || !/^https?:$/.test(location.protocol)) return;

  const WATCHED_SETTINGS = new Set([
    "enabled", "preparedSources", "blockedHosts", "style", "sourceOverrides"
  ]);
  let epoch = 0;
  let paused = false;
  let suspended = false;
  let timer = null;
  let activeSignature = "";

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function signature(sessionId, config) {
    return JSON.stringify([
      sessionId, config.sourceLanguage, config.targetLanguage, config.style
    ]);
  }

  function stop() {
    activeSignature = "";
    reader.restore();
  }

  function cancelPending() {
    epoch += 1;
    clearTimeout(timer);
    timer = null;
  }

  // Restoring a page is a deliberate pause for this document. Background or
  // storage events cannot accidentally restart a request already in flight.
  function pause() {
    paused = true;
    cancelPending();
    stop();
  }

  function resumeManual(message) {
    paused = false;
    cancelPending();
    const config = message.config || {};
    activeSignature = signature(message.sessionId, {
      sourceLanguage: config.sourceLanguage || "auto",
      targetLanguage: config.targetLanguage || "zh-Hant",
      style: config.style === "soft" ? "soft" : "line"
    });
  }

  async function configure() {
    if (paused || suspended) return;
    const requestEpoch = ++epoch;
    try {
      const response = await sendMessage({ type: "BT_AUTO_CONFIG", info: reader.info() });
      if (requestEpoch !== epoch || paused || suspended) return;
      if (!response?.ok || !response.enabled || response.needsSetup ||
          typeof response.sessionId !== "string" || !response.sessionId.trim() ||
          typeof response.sourceLanguage !== "string" || !response.sourceLanguage.trim()) {
        stop();
        return;
      }
      const config = {
        sourceLanguage: response.sourceLanguage,
        targetLanguage: response.targetLanguage || "zh-Hant",
        style: response.style === "soft" ? "soft" : "line"
      };
      const nextSignature = signature(response.sessionId, config);
      if (nextSignature === activeSignature) return;
      reader.start({ sessionId: response.sessionId, config });
      activeSignature = nextSignature;
    } catch (_error) {
      // Setup and unavailable-model notices live in the toolbar popup. Automatic
      // reading must never place a blocking notice over the website.
      if (requestEpoch === epoch && !paused && !suspended) stop();
    }
  }

  function scheduleConfiguration() {
    cancelPending();
    if (paused || suspended) return;
    timer = setTimeout(() => {
      timer = null;
      void configure();
    }, 120);
  }

  globalThis.__BT_READER_AUTO_CONTROL__ = Object.freeze({ pause, resumeManual });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "BT_RECONFIGURE") return false;
    paused = false;
    scheduleConfiguration();
    sendResponse({ ok: true });
    return false;
  });

  function settingsChanged(changes) {
    if (!Object.keys(changes).some((key) => WATCHED_SETTINGS.has(key))) return;
    // Discard an older config response before it can start a disabled reader.
    cancelPending();
    const blockedHosts = changes.blockedHosts?.newValue;
    if (changes.enabled?.newValue === false ||
        (Array.isArray(blockedHosts) && blockedHosts.includes(location.hostname))) {
      stop();
      return;
    }
    scheduleConfiguration();
   }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BT_SETTINGS_CHANGED") settingsChanged(message.changes || {});
    if (message?.type === "BT_ENGINE_CHANGED") pause();
    return false;
  });

  window.addEventListener("pagehide", () => {
    suspended = true;
    cancelPending();
    stop();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    suspended = false;
    scheduleConfiguration();
  });

  void configure();
})();
