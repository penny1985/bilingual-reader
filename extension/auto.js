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
  let disabled = false;
  let timer = null;
  let activeSignature = "";
  let pageUrl = location.href.split("#")[0];
  let languageObserver = null;
  let hydrationObserver = null;
  let hydrationTimer = null;
  let hydrationDeadline = null;
  let hydrationAttempts = 0;
  let hydrationSample = "";

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

  function stopHydrationWatch() {
    hydrationObserver?.disconnect();
    hydrationObserver = null;
    clearTimeout(hydrationTimer);
    clearTimeout(hydrationDeadline);
    hydrationTimer = hydrationDeadline = null;
  }

  function stopLanguageWatch() {
    stopHydrationWatch();
    languageObserver?.disconnect();
    languageObserver = null;
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
    stopLanguageWatch();
    stop();
  }

  function resumeManual(message) {
    paused = false;
    disabled = false;
    cancelPending();
    stopHydrationWatch();
    watchDeclaredLanguage();
    const config = message.config || {};
    activeSignature = signature(message.sessionId, {
      sourceLanguage: config.sourceLanguage || "auto",
      targetLanguage: config.targetLanguage || "zh-Hant",
      style: config.style === "soft" ? "soft" : "line"
    });
  }

  function watchDeclaredLanguage() {
    if (languageObserver || paused || suspended || disabled) return;
    let observedLanguage = String(reader.info().lang || "").trim().toLowerCase();
    languageObserver = new MutationObserver(() => {
      if (paused || suspended || disabled) return;
      const nextLanguage = String(reader.info().lang || "").trim().toLowerCase();
      if (nextLanguage === observedLanguage) return;
      observedLanguage = nextLanguage;
      cancelPending();
      stopHydrationWatch();
      hydrationAttempts = 0;
      stop();
      scheduleConfiguration();
    });
    languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  function infoSignature(info) {
    return JSON.stringify([info.lang || "", info.sample || ""]);
  }

  // Some pages initially render an empty shell. Observe only while language is
  // unknown: at most four changed samples within 20 seconds, never API failures.
  function watchHydration(info) {
    if (hydrationAttempts >= 4 || hydrationObserver || paused || suspended || disabled) return;
    hydrationSample = infoSignature(info);
    hydrationObserver = new MutationObserver(() => {
      if (hydrationTimer || paused || suspended || disabled) return;
      hydrationTimer = setTimeout(() => {
        hydrationTimer = null;
        const fresh = reader.info();
        const nextSample = infoSignature(fresh);
        if (nextSample === hydrationSample || !/\p{L}{2}/u.test(fresh.sample || "")) return;
        hydrationSample = nextSample;
        hydrationAttempts += 1;
        scheduleConfiguration();
        if (hydrationAttempts >= 4) stopHydrationWatch();
      }, 150);
    });
    hydrationObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    hydrationDeadline = setTimeout(stopHydrationWatch, 20000);
  }

  async function configure() {
    if (paused || suspended || disabled) return;
    const requestEpoch = ++epoch;
    const requestedPageUrl = pageUrl;
    const info = reader.info();
    try {
      const response = await sendMessage({ type: "BT_AUTO_CONFIG", info, pageUrl: requestedPageUrl });
      if (requestEpoch !== epoch || paused || suspended || disabled ||
          requestedPageUrl !== location.href.split("#")[0]) return;
      if (!response?.ok || !response.enabled || response.needsSetup ||
          typeof response.sessionId !== "string" || !response.sessionId.trim() ||
          typeof response.sourceLanguage !== "string" || !response.sourceLanguage.trim()) {
        stop();
        if (response?.disabled) disabled = true;
        if (response?.ok && response.needsLanguage) {
          watchDeclaredLanguage();
          watchHydration(info);
          // Hydration can finish while Chrome language detection is pending.
          if (hydrationAttempts < 4 && infoSignature(reader.info()) !== infoSignature(info)) {
            hydrationAttempts += 1;
            scheduleConfiguration();
          }
        } else if (response?.ok && response.sourceLanguage === "zh-Hant" && !response.needsSetup) {
          stopHydrationWatch();
          watchDeclaredLanguage();
        } else {
          stopLanguageWatch();
        }
        return;
      }
      stopHydrationWatch();
      watchDeclaredLanguage();
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
      if (requestEpoch === epoch && !paused && !suspended) {
        stopLanguageWatch();
        stop();
      }
    }
  }

  function scheduleConfiguration() {
    cancelPending();
    if (paused || suspended || disabled) return;
    timer = setTimeout(() => {
      timer = null;
      void configure();
    }, 120);
  }

  function navigated(expectedUrl) {
    const nextPageUrl = location.href.split("#")[0];
    if ((expectedUrl && expectedUrl !== nextPageUrl) || nextPageUrl === pageUrl) return;
    pageUrl = nextPageUrl;
    cancelPending();
    stopLanguageWatch();
    hydrationAttempts = 0;
    // Invalidate the content generation immediately, before a prior route's
    // pending response can add translated text to the new route.
    stop();
    scheduleConfiguration();
  }

  globalThis.__BT_READER_AUTO_CONTROL__ = Object.freeze({ pause, resumeManual });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "BT_RECONFIGURE") return false;
    if (message.reason === "navigation") {
      navigated(message.pageUrl);
    } else {
      if (!message.reason || message.reason === "manual") {
        paused = false;
        disabled = false;
      }
      stopHydrationWatch();
      hydrationAttempts = 0;
      scheduleConfiguration();
    }
    sendResponse({ ok: true });
    return false;
  });

  function settingsChanged(changes) {
    if (!Object.keys(changes).some((key) => WATCHED_SETTINGS.has(key))) return;
    // Discard an older config response before it can start a disabled reader.
    cancelPending();
    stopLanguageWatch();
    hydrationAttempts = 0;
    const blockedHosts = changes.blockedHosts?.newValue;
    if (changes.enabled?.newValue === false ||
        (Array.isArray(blockedHosts) && blockedHosts.includes(location.hostname))) {
      disabled = true;
      stop();
      return;
    }
    if (changes.enabled?.newValue === true || Array.isArray(blockedHosts)) disabled = false;
    scheduleConfiguration();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BT_SETTINGS_CHANGED") settingsChanged(message.changes || {});
    if (message?.type === "BT_ENGINE_CHANGED") pause();
    return false;
  });

  window.addEventListener("popstate", () => navigated());
  window.addEventListener("pagehide", () => {
    suspended = true;
    cancelPending();
    stopLanguageWatch();
    stop();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    suspended = false;
    pageUrl = location.href.split("#")[0];
    hydrationAttempts = 0;
    scheduleConfiguration();
  });

  void configure();
})();
