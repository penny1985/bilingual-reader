(() => {
  "use strict";

  // A second injection must reuse the reader and its message listener.
  if (globalThis.__BT_BILINGUAL_READER_CONTENT__) return;
  globalThis.__BT_BILINGUAL_READER_CONTENT__ = true;

  const OWN_ATTRIBUTE = "data-bt-reader-owned";
  const OWN_SELECTOR = `[${OWN_ATTRIBUTE}]`;
  const BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,td,th,figcaption,blockquote,dd,dt,div";
  const EXCLUDE_SELECTOR = [
    OWN_SELECTOR, "nav", "header", "footer", "form", "button", "input", "textarea",
    "select", "option", "code", "pre", "script", "style", "noscript", "template",
    "svg", "math", "canvas", "iframe", "video", "audio", "[hidden]", "[inert]",
    '[aria-hidden="true"]', '[translate="no" i]', '[contenteditable]:not([contenteditable="false" i])',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="menu"]',
    '[role="menubar"]', '[role="toolbar"]', '[role="textbox"]', '[role="button"]',
    '[role="combobox"]', '[role="search"]'
  ].join(",");
  const MAX_TEXT_LENGTH = 16000;
  const MAX_WORKERS = 2;
  const SCAN_DELAY = 300;
  let current = null;
  let generation = 0;

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

  function isOwn(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest(OWN_SELECTOR));
  }

  // Each structural block owns its inline/direct text. Nested blocks are translated
  // independently, so a list item's introduction is retained without repeating its child list.
  function sourceText(element) {
    if (element.closest(EXCLUDE_SELECTOR)) return "";
    const pieces = [];
    const stack = Array.from(element.childNodes).reverse();
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        pieces.push(node.nodeValue || "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches(EXCLUDE_SELECTOR)) continue;
      if (node.matches(BLOCK_SELECTOR) || node.tagName === "BR") {
        // Preserve a boundary in "before<p>inner</p>after" instead of producing "beforeafter".
        pieces.push("\n");
        continue;
      }
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]);
      }
    }
    return pieces.join("").replace(/\s+/gu, " ").trim();
  }

  function isEligible(element) {
    if (!element.isConnected || element.closest(EXCLUDE_SELECTOR)) return false;
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  function findCandidates() {
    if (!document.body) return [];
    const all = Array.from(document.body.querySelectorAll(BLOCK_SELECTOR));
    const candidates = [];
    for (const element of all) {
      if (!isEligible(element)) continue;
      const text = sourceText(element);
      if (!text || !/\p{L}/u.test(text)) continue;
      candidates.push({ element, text });
    }
    return candidates;
  }

  function info() {
    // Language detection only needs a small sample. Do not scan every paragraph or
    // install observers until automatic translation has actually been enabled.
    const pieces = [];
    let length = 0;
    let examined = 0;
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (length < 1200 && examined < 240 && (node = walker.nextNode())) {
        examined += 1;
        const parent = node.parentElement;
        if (!parent || parent.closest(EXCLUDE_SELECTOR) || !isEligible(parent)) continue;
        const text = (node.nodeValue || "").slice(0, 1200 - length).replace(/\s+/gu, " ").trim();
        if (!text || !/\p{L}/u.test(text)) continue;
        pieces.push(text);
        length += text.length + 1;
      }
    }
    return {
      ok: true,
      title: document.title || "",
      lang: document.documentElement.lang || "",
      sample: pieces.join("\n").slice(0, 1200)
    };
  }

  function isCurrent(session) {
    return current === session && session.generation === generation;
  }

  function makeOwnedElement(name, kind) {
    const element = document.createElement(name);
    element.setAttribute(OWN_ATTRIBUTE, kind);
    element.setAttribute("translate", "no");
    return element;
  }

  function createProgress(session) {
    const host = makeOwnedElement("bt-reader-status", "status");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("right", "18px", "important");
    host.style.setProperty("bottom", "18px", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("max-width", "min(340px, calc(100vw - 36px))", "important");
    host.style.setProperty("pointer-events", "none", "important");
    host.style.setProperty("opacity", "0", "important");
    host.style.setProperty("visibility", "hidden", "important");
    host.style.setProperty("transition", "opacity 200ms ease, visibility 200ms", "important");
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; color-scheme: light; }
      .bar { box-sizing: border-box; padding: 11px 15px; border: 1px solid rgba(255,255,255,.18);
        border-radius: 12px; background: #183b35; color: #f8faf8; box-shadow: 0 5px 24px #0003;
        font: 13px/1.5 system-ui, -apple-system, "Noto Sans TC", sans-serif; letter-spacing: normal;
        text-align: left; overflow-wrap: anywhere; }
      .title { font-weight: 650; }
      .detail { margin-top: 2px; color: #d4e7df; font-size: 12px; }
    `;
    const box = document.createElement("div");
    box.className = "bar";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.setAttribute("aria-atomic", "true");
    const title = document.createElement("div");
    title.className = "title";
    const detail = document.createElement("div");
    detail.className = "detail";
    box.append(title, detail);
    shadow.append(style, box);
    (document.body || document.documentElement).append(host);
    session.progress = { host, title, detail, hideTimer: null, phase: "", shown: false };
  }

  function counts(session) {
    let translated = 0;
    let failed = 0;
    let error = "";
    for (const record of session.records.values()) {
      if (record.state === "done") translated += 1;
      if (record.state === "failed") {
        failed += 1;
        if (!error) error = record.error || "部分段落未能翻譯，請稍後重試。";
      }
    }
    const total = session.records.size;
    const pending = Math.max(0, total - translated - failed);
    const busy = session.active > 0 || session.queue.some((entry) => entry.record.state === "queued");
    return { total, translated, pending, failed, phase: busy ? "translating" : (failed ? "error" : "ready"), error };
  }

  function updateStatus(session, immediately = false) {
    if (!isCurrent(session)) return;
    const status = counts(session);
    const { title, detail } = session.progress;
    title.textContent = status.phase === "translating"
      ? `雙語翻譯中 · ${status.translated} / ${status.total} 段`
      : `雙語閱讀 · ${status.translated} / ${status.total} 段`;
    if (!status.total) detail.textContent = "這頁暫時找不到可翻譯的段落。";
    else if (status.failed) detail.textContent = `${status.failed} 段略過或失敗。${status.error}`;
    else if (status.pending && status.phase !== "translating") detail.textContent = `往下捲動，繼續翻譯其餘 ${status.pending} 段。`;
    else if (status.phase === "translating") detail.textContent = "保留原文，譯文會依序出現。";
    else detail.textContent = "目前的段落已翻譯完成。點工具列圖示可還原。";

    const progress = session.progress;
    const show = () => {
      clearTimeout(progress.hideTimer);
      progress.hideTimer = null;
      progress.host.style.setProperty("opacity", "1", "important");
      progress.host.style.setProperty("visibility", "visible", "important");
      progress.host.removeAttribute("aria-hidden");
      progress.shown = true;
    };
    if (status.phase === "translating") show();
    else if (progress.phase !== status.phase && (progress.shown || status.failed)) {
      if (status.failed) show();
      clearTimeout(progress.hideTimer);
      progress.hideTimer = setTimeout(() => {
        if (!isCurrent(session)) return;
        progress.host.style.setProperty("opacity", "0", "important");
        progress.host.style.setProperty("visibility", "hidden", "important");
        progress.host.setAttribute("aria-hidden", "true");
        progress.hideTimer = null;
        progress.shown = false;
      }, status.failed ? 4500 : 1500);
    }
    progress.phase = status.phase;

    const publish = () => {
      session.statusTimer = null;
      if (!isCurrent(session)) return;
      const next = counts(session);
      const message = { type: "BT_STATUS", sessionId: session.id, ...next };
      if (!message.error) delete message.error;
      const serialized = JSON.stringify(message);
      if (serialized === session.lastStatus) return;
      session.lastStatus = serialized;
      sendMessage(message).catch(() => {});
    };
    if (immediately) {
      clearTimeout(session.statusTimer);
      publish();
    } else if (session.statusTimer === null) {
      session.statusTimer = setTimeout(publish, 100);
    }
  }

  function removeTranslation(record) {
    if (record.host) record.host.remove();
    record.host = null;
  }

  function invalidate(session, record, text) {
    removeTranslation(record);
    record.version += 1;
    record.text = text;
    record.error = "";
    record.state = "waiting";
    if (text.length > MAX_TEXT_LENGTH) {
      record.state = "failed";
      record.error = "段落超過 16,000 字元，已略過；內容沒有被截斷。";
    }
  }

  function nearViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -500 && rect.top <= window.innerHeight + 500;
  }

  function enqueue(session, record) {
    if (!isCurrent(session) || record.state !== "waiting" || !record.element.isConnected) return;
    record.state = "queued";
    session.queue.push({ record, version: record.version });
    pump(session);
  }

  function renderTranslation(session, record, text) {
    const host = makeOwnedElement("bt-reader-translation", "translation");
    host.lang = session.config.targetLanguage;
    host.dir = "auto";
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("margin", "8px 0 10px", "important");
    host.style.setProperty("width", "auto", "important");
    host.style.setProperty("max-width", "100%", "important");
    host.style.setProperty("flex-basis", "100%", "important");
    host.style.setProperty("position", "static", "important");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; display: block; }
      .translation { display: block; box-sizing: border-box; margin: 0; font-weight: 400;
        line-height: 1.7; letter-spacing: normal; white-space: pre-wrap; overflow-wrap: anywhere;
        text-align: start; text-transform: none; text-decoration: none; }
      .line { border-inline-start: 2px solid #619c88; padding: 1px 0 1px 12px; }
      .soft { border-radius: 7px; padding: 9px 12px; background: rgba(128,128,128,.10); }
    `;
    const translation = document.createElement("div");
    translation.className = `translation ${session.config.style}`;
    translation.textContent = text;
    const originalStyle = getComputedStyle(record.element);
    translation.style.color = originalStyle.color;
    translation.style.fontFamily = originalStyle.fontFamily;
    const fontSize = parseFloat(originalStyle.fontSize) || 16;
    translation.style.fontSize = `${Math.max(12, Math.min(28, fontSize * 0.96))}px`;
    shadow.append(style, translation);
    // Appending inside the source keeps li/td/th/blockquote and table structures valid.
    record.element.append(host);
    record.host = host;
  }

  function isCancellation(response, error) {
    return Boolean(response?.cancelled || response?.canceled || /abort|cancel|取消|中止/i.test(String(error || "")));
  }

  function readableError(error) {
    const message = String(error?.message || error || "翻譯服務沒有回應，請稍後重試。");
    if (/extension context invalidated/i.test(message)) return "擴充套件已更新，請重新整理網頁後再試。";
    return message.slice(0, 280);
  }

  async function translate(session, record, version) {
    const original = record.text;
    record.state = "translating";
    session.active += 1;
    updateStatus(session);
    try {
      const response = await sendMessage({ type: "BT_TRANSLATE", sessionId: session.id, text: original });
      if (!isCurrent(session) || session.records.get(record.element) !== record || record.version !== version) return;
      if (!record.element.isConnected) return;
      const latest = sourceText(record.element);
      if (latest !== original) {
        invalidate(session, record, latest);
        scheduleScan(session);
        return;
      }
      if (!response?.ok) {
        if (isCancellation(response, response?.error)) {
          record.state = "waiting";
          return;
        }
        throw new Error(response?.error || "翻譯服務沒有回應，請點工具列圖示查看設定。");
      }
      if (typeof response.text !== "string" || !response.text.trim()) throw new Error("翻譯服務回傳了空白內容。");
      removeTranslation(record);
      renderTranslation(session, record, response.text.trim());
      record.state = "done";
      record.error = "";
    } catch (error) {
      if (!isCurrent(session) || session.records.get(record.element) !== record || record.version !== version) return;
      if (isCancellation(null, error?.message)) record.state = "waiting";
      else {
        record.state = "failed";
        record.error = readableError(error);
      }
    } finally {
      session.active = Math.max(0, session.active - 1);
      if (isCurrent(session)) {
        pump(session);
        updateStatus(session);
      }
    }
  }

  function pump(session) {
    if (!isCurrent(session)) return;
    while (session.active < MAX_WORKERS && session.queue.length) {
      const { record, version } = session.queue.shift();
      if (session.records.get(record.element) !== record || record.version !== version || record.state !== "queued") continue;
      if (!record.element.isConnected) continue;
      void translate(session, record, version);
    }
  }

  function scan(session) {
    if (!isCurrent(session)) return;
    const candidates = findCandidates();
    const seen = new Set();
    for (const { element, text } of candidates) {
      seen.add(element);
      let record = session.records.get(element);
      if (!record) {
        record = { element, text, version: 0, state: "waiting", host: null, error: "", visible: false };
        session.records.set(element, record);
        if (text.length > MAX_TEXT_LENGTH) invalidate(session, record, text);
        if (session.intersection) session.intersection.observe(element);
      } else if (record.text !== text) {
        invalidate(session, record, text);
      } else if (record.state === "done" && !record.host?.isConnected) {
        invalidate(session, record, text);
      }
      // Start the first screen promptly while waiting for the first IO callback.
      if (record.state === "waiting" && (record.visible || nearViewport(element))) enqueue(session, record);
    }
    for (const [element, record] of session.records) {
      if (seen.has(element)) continue;
      session.intersection?.unobserve(element);
      record.version += 1;
      removeTranslation(record);
      session.records.delete(element);
    }
    pump(session);
    updateStatus(session);
  }

  function scheduleScan(session) {
    if (!isCurrent(session) || session.scanTimer !== null) return;
    session.scanTimer = setTimeout(() => {
      session.scanTimer = null;
      scan(session);
    }, SCAN_DELAY);
  }

  function restore() {
    const previous = current;
    current = null;
    generation += 1;
    if (!previous) return;
    previous.mutation?.disconnect();
    previous.intersection?.disconnect();
    clearTimeout(previous.scanTimer);
    clearTimeout(previous.statusTimer);
    clearTimeout(previous.progress?.hideTimer);
    window.removeEventListener("scroll", previous.onScroll);
    window.removeEventListener("resize", previous.onResize);
    for (const record of previous.records.values()) {
      record.version += 1;
      removeTranslation(record);
    }
    previous.queue.length = 0;
    previous.records.clear();
    previous.progress?.host.remove();
  }

  function start(message) {
    if (typeof message.sessionId !== "string" || !message.sessionId.trim()) throw new Error("缺少翻譯工作識別碼。");
    restore();
    const config = message.config || {};
    const session = {
      id: message.sessionId,
      generation,
      config: {
        sourceLanguage: config.sourceLanguage || "auto",
        targetLanguage: config.targetLanguage || "zh-Hant",
        style: config.style === "soft" ? "soft" : "line"
      },
      records: new Map(), queue: [], active: 0, mutation: null, intersection: null,
      scanTimer: null, statusTimer: null, lastStatus: "", progress: null,
      onScroll: null, onResize: null
    };
    current = session;
    createProgress(session);
    if (typeof IntersectionObserver === "function") {
      session.intersection = new IntersectionObserver((entries) => {
        if (!isCurrent(session)) return;
        for (const entry of entries) {
          const record = session.records.get(entry.target);
          if (!record) continue;
          record.visible = entry.isIntersecting;
          if (entry.isIntersecting) enqueue(session, record);
        }
        updateStatus(session);
      }, { rootMargin: "500px 0px", threshold: 0 });
    }
    session.mutation = new MutationObserver((mutations) => {
      if (!isCurrent(session)) return;
      const external = mutations.some((mutation) => {
        if (isOwn(mutation.target)) return false;
        if (mutation.type !== "childList") return true;
        const changed = [...mutation.addedNodes, ...mutation.removedNodes];
        return changed.some((node) => !isOwn(node));
      });
      if (external) scheduleScan(session);
    });
    session.mutation.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style", "class", "translate", "contenteditable", "inert", "open"]
    });
    session.onScroll = () => {
      if (session.intersection || !isCurrent(session)) return;
      for (const record of session.records.values()) {
        if (record.state === "waiting" && nearViewport(record.element)) enqueue(session, record);
      }
      updateStatus(session);
    };
    session.onResize = () => scheduleScan(session);
    window.addEventListener("scroll", session.onScroll, { passive: true });
    window.addEventListener("resize", session.onResize, { passive: true });
    scan(session);
    updateStatus(session, true);
  }

  // auto.js shares this isolated world; no page script receives these controls.
  globalThis.__BT_READER_CONTROL__ = Object.freeze({ start, restore, info });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    try {
      if (message.type === "BT_GET_INFO") sendResponse(info());
      else if (message.type === "BT_GET_SELECTION") sendResponse({ ok: true, text: window.getSelection()?.toString().trim() || "" });
      else if (message.type === "BT_START") {
        globalThis.__BT_READER_AUTO_CONTROL__?.resumeManual(message);
        start(message);
        sendResponse({ ok: true });
      } else if (message.type === "BT_RESTORE") {
        if (globalThis.__BT_READER_AUTO_CONTROL__) globalThis.__BT_READER_AUTO_CONTROL__.pause();
        else restore();
        sendResponse({ ok: true });
      }
    } catch (error) {
      sendResponse({ ok: false, error: readableError(error) });
    }
    return false;
  });
})();
