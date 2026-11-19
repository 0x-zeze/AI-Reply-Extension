// X AI Reply — Content Script (v5.2.1 Global Edition)
// GPU-composited "AI Reply" + Quick Angle Mini-Menu, Alt+R Shortcut,
// Vision Image Extractor, Multi-Layer Context Engine, English Translation Preview,
// & Anti-Double-Text Draft.js Paste Handler.

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.6-high";
const DEFAULT_PROMPT =
  "all lowercase, under 10 words, dry and effortless, sound like a real person typing from phone, no emojis";

const settingsCache = {
  baseUrl: DEFAULT_BASE_URL,
  apiKey: "",
  model: DEFAULT_MODEL,
  prompt: DEFAULT_PROMPT,
  timeout: 60,
  visionMode: true,
  translationPreview: true,
  shortcutEnabled: true,
};
let settingsLoaded = false;

// Rate limiting — minimum 2.5s between completed requests
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 2500;

// ═══════════════════════════════════════════════════════════════
// Tracking & Zero-Lag MutationObserver
// ═══════════════════════════════════════════════════════════════
let isInsertingText = false;
let observerDebounceTimer = null;
let observerRafId = null;
let reconnectObserverTimer = null;

const boxButtonMap = new WeakMap();
const mountedGroups = new Set();

// X has shipped multiple composer implementations (Draft.js + newer editors).
// Match any of them instead of a single testid prefix.
const COMPOSER_SELECTOR = [
  'div[contenteditable="true"][data-testid^="tweetTextarea"]',
  'div[contenteditable="true"][role="textbox"][data-testid*="tweetTextarea"]',
  'div[contenteditable="plaintext-only"][role="textbox"]',
  'div[contenteditable="true"][role="textbox"][aria-label]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");

function isComposerBox(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.closest?.(".x-ai-reply-group, .x-ai-toast-host, [role='search'], [data-testid='SearchBox_Search_Input']")) {
    return false;
  }

  const editable =
    el.matches?.(COMPOSER_SELECTOR) ||
    (el.getAttribute("contenteditable") === "true" &&
      Boolean(el.closest('[data-testid^="tweetTextarea"], [data-testid*="tweetTextarea"]')));
  if (!editable) return false;

  const testId = `${el.getAttribute("data-testid") || ""} ${el.closest("[data-testid]")?.getAttribute("data-testid") || ""}`;
  if (/tweetTextarea/i.test(testId)) return true;
  if (el.getAttribute("data-lexical-editor") === "true") return true;
  if (el.getAttribute("contenteditable") === "plaintext-only" && el.getAttribute("role") === "textbox") {
    return true;
  }
  const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("aria-placeholder") || ""}`;
  return /post|reply|quote|what.?s happening|tweet|balas|kutip/i.test(label);
}

function queryDeep(root, selector) {
  const scope = root || document;
  const found = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.querySelectorAll) {
      try {
        found.push(...node.querySelectorAll(selector));
      } catch (e) {}
    }
    // Only check direct shadow hosts instead of querying all children
    if (node.querySelectorAll) {
      try {
        const shadowHosts = node.querySelectorAll("[data-testid], [role], [contenteditable]");
        for (const child of shadowHosts) {
          if (child.shadowRoot) visit(child.shadowRoot);
        }
      } catch (e) {}
    }
  };
  visit(scope);
  return found;
}

function isGrokSurface(el) {
  if (!el) return false;
  if (/\/i\/grok|\/grok/i.test(location.pathname)) return true;
  const text = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("placeholder") || ""} ${el.textContent || ""}`.slice(0, 240);
  return /ask anything|what should we explore|meet grok/i.test(text);
}

function findComposerFromPlaceholder(root) {
  const scope = root && (root.querySelectorAll || root instanceof ShadowRoot) ? root : document;
  const hints = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue || "";
      return /post your reply|what.?s happening|tweet your reply/i.test(value)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let textNode = walker.nextNode();
  let guard = 0;
  while (textNode && guard < 12) {
    const el = textNode.parentElement;
    if (el) hints.push(el);
    textNode = walker.nextNode();
    guard += 1;
  }

  const buttons = queryDeep(scope, '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
  const found = [];
  const seen = new Set();

  const consider = (start) => {
    if (!start) return;
    let node = start;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const editable = node.querySelector?.(
        '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'
      );
      if (!editable || seen.has(editable)) continue;
      if (editable.closest?.("[role='search'], [data-testid='SearchBox_Search_Input']")) continue;
      seen.add(editable);
      found.push(editable);
      return;
    }
  };

  hints.forEach(consider);
  buttons.forEach((button) => consider(button.parentElement));
  return found;
}

function queryComposerBoxes(root) {
  const scope = root && (root.querySelectorAll || root instanceof ShadowRoot) ? root : document;
  const nodes = queryDeep(
    scope,
    `${COMPOSER_SELECTOR}, [data-testid^="tweetTextarea"] [contenteditable="true"], [data-testid*="tweetTextarea"] [contenteditable], [role="textbox"][contenteditable]`
  );
  const found = [];
  const seen = new Set();
  for (const node of [...nodes, ...findComposerFromPlaceholder(scope)]) {
    if (seen.has(node)) continue;
    const editable = node.getAttribute("contenteditable");
    const hinted = editable === "true" || editable === "plaintext-only" || node.getAttribute("role") === "textbox";
    if (!isComposerBox(node) && !hinted) continue;
    if (node.closest?.("[role='search'], [data-testid='SearchBox_Search_Input'], .x-ai-reply-group")) continue;
    if (isGrokSurface(node)) continue;
    seen.add(node);
    found.push(node);
  }
  return found;
}

function hasRelevantDomMutation(mutations) {
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;

    const target = m.target;
    if (target && target.nodeType === Node.ELEMENT_NODE) {
      if (
        target.closest?.(
          ".x-ai-reply-group, .x-ai-reply-button, .x-ai-toast-host"
        )
      ) {
        continue;
      }

      const activeEditor = target.closest?.(COMPOSER_SELECTOR);
      if (activeEditor) {
        const existingBtn = boxButtonMap.get(activeEditor);
        if (existingBtn && existingBtn.isConnected) continue;
      }
    }
    return true;
  }
  return false;
}

function scheduleReplyBoxScan() {
  if (isInsertingText || observerDebounceTimer) return;
  observerDebounceTimer = setTimeout(() => {
    observerDebounceTimer = null;
    if (isInsertingText) return;
    if (typeof requestAnimationFrame === "function") {
      if (observerRafId) cancelAnimationFrame(observerRafId);
      observerRafId = requestAnimationFrame(() => {
        observerRafId = null;
        if (!isInsertingText) insertButtonIntoReplyBoxes();
      });
    } else {
      insertButtonIntoReplyBoxes();
    }
  }, 110);
}

const observer = new MutationObserver((mutations) => {
  if (isInsertingText) return;
  if (!hasRelevantDomMutation(mutations)) return;
  scheduleReplyBoxScan();
});

// ═══════════════════════════════════════════════════════════════
// GPU-Composited Styles (transform & opacity only)
// ═══════════════════════════════════════════════════════════════
const SPARKLE_SVG = `<svg class="x-ai-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7.2 1.8C7.45 1.1 8.45 1.1 8.7 1.8L9.65 4.55C9.88 5.2 10.4 5.72 11.05 5.95L13.8 6.9C14.5 7.15 14.5 8.15 13.8 8.4L11.05 9.35C10.4 9.58 9.88 10.1 9.65 10.75L8.7 13.5C8.45 14.2 7.45 14.2 7.2 13.5L6.25 10.75C6.02 10.1 5.5 9.58 4.85 9.35L2.1 8.4C1.4 8.15 1.4 7.15 2.1 6.9L4.85 5.95C5.5 5.72 6.02 5.2 6.25 4.55L7.2 1.8Z" fill="currentColor"/><circle cx="13" cy="2.8" r="1.15" fill="currentColor" opacity="0.85"/></svg>`;
const SPINNER_SVG = `<svg class="x-ai-icon x-ai-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-opacity="0.28" stroke-width="2"/><path d="M13.75 8A5.75 5.75 0 0 0 8 2.25" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const CHECK_SVG = `<svg class="x-ai-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.3L6.6 11.4L12.6 4.8" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected && document.getElementById("x-ai-reply-styles")) return;
  if (document.getElementById("x-ai-reply-styles")) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = "x-ai-reply-styles";
  style.textContent = `
    @keyframes xAiSpin {
      to { transform: rotate(360deg); }
    }
    @keyframes xAiBtnEnter {
      from { opacity: 0; transform: translate3d(0, 3px, 0) scale(0.94); }
      to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }
    @keyframes xAiSheen {
      0% { transform: translate3d(-130%, 0, 0); }
      100% { transform: translate3d(130%, 0, 0); }
    }
    @keyframes xAiToastIn {
      from { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.97); }
      to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }

    #x-ai-reply-overlay {
      position: fixed;
      inset: 0;
      width: 0;
      height: 0;
      z-index: 2147483000;
      pointer-events: none;
      overflow: visible;
    }

    .x-ai-reply-group {
      position: fixed;
      z-index: 2147483646;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      pointer-events: none;
    }

    .x-ai-angle-bar {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 27px;
      position: absolute;
      right: 0;
      bottom: 34px;
      margin-bottom: 0;
      padding: 2px 4px;
      border-radius: 999px;
      background: rgba(15, 20, 25, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
      opacity: 0;
      transform: translate3d(0, 6px, 0) scale(0.96);
      pointer-events: none;
      backface-visibility: hidden;
      transition:
        opacity 0.16s cubic-bezier(0.22, 1, 0.36, 1),
        transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .x-ai-reply-group:hover .x-ai-angle-bar,
    .x-ai-reply-group:focus-within .x-ai-angle-bar,
    .x-ai-reply-group[data-open="true"] .x-ai-angle-bar {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      pointer-events: auto;
    }

    .x-ai-reply-group[data-busy="true"] .x-ai-angle-bar {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .x-ai-angle-pill {
      appearance: none;
      border: none;
      background: transparent;
      color: #d6d9db;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      font-size: 10.5px;
      font-weight: 650;
      padding: 3px 7px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
      line-height: 1;
      transition: background 0.14s ease, color 0.14s ease, transform 0.12s ease;
    }
    .x-ai-angle-pill:hover {
      background: rgba(29, 155, 240, 0.24);
      color: #ffffff;
      transform: translate3d(0, -0.5px, 0);
    }
    .x-ai-angle-pill:active {
      transform: scale(0.95);
    }

    .x-ai-reply-button {
      position: relative;
      pointer-events: auto;
      overflow: hidden;
      contain: layout paint;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-width: 82px;
      height: 27px;
      padding: 0 11px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: linear-gradient(135deg, #1d9bf0 0%, #4f46e5 55%, #7c3aed 100%);
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
      line-height: 1;
      white-space: nowrap;
      user-select: none;
      cursor: pointer;
      backface-visibility: hidden;
      transform: translate3d(0, 0, 0);
      box-shadow: 0 2px 8px rgba(29, 155, 240, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.22);
      animation: xAiBtnEnter 0.18s cubic-bezier(0.22, 1, 0.36, 1) both;
      transition:
        transform 0.16s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.16s ease,
        box-shadow 0.18s ease;
    }

    .x-ai-reply-button::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(
        105deg,
        transparent 20%,
        rgba(255, 255, 255, 0.26) 50%,
        transparent 80%
      );
      transform: translate3d(-130%, 0, 0);
      pointer-events: none;
    }

    .x-ai-reply-button:hover {
      transform: translate3d(0, -1.5px, 0) scale(1.025);
      box-shadow: 0 6px 16px rgba(79, 70, 229, 0.38), 0 2px 6px rgba(29, 155, 240, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.34);
    }

    .x-ai-reply-button:active {
      transform: translate3d(0, 0, 0) scale(0.96);
    }

    .x-ai-reply-button:focus-visible {
      outline: 2px solid #38bdf8;
      outline-offset: 2px;
    }

    .x-ai-reply-button[data-loading="true"] {
      pointer-events: none;
      opacity: 0.94;
    }

    .x-ai-reply-button[data-loading="true"]::after {
      animation: xAiSheen 1.35s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }

    .x-ai-reply-button[data-state="done"] {
      background: linear-gradient(135deg, #059669 0%, #10b981 100%);
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.34);
    }

    .x-ai-reply-button .x-ai-icon {
      width: 12.5px;
      height: 12.5px;
      flex-shrink: 0;
    }

    .x-ai-reply-button .x-ai-spin {
      animation: xAiSpin 0.72s linear infinite;
    }

    .x-ai-toast-host {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: min(390px, calc(100vw - 32px));
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    }

    .x-ai-toast {
      pointer-events: auto;
      contain: layout paint;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 11px 14px;
      border-radius: 14px;
      background: rgba(15, 20, 25, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
      color: #f7f9f9;
      font-size: 12.5px;
      line-height: 1.45;
      backface-visibility: hidden;
      animation: xAiToastIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
      transition: opacity 0.16s ease, transform 0.16s ease;
    }

    .x-ai-toast[data-leaving="true"] {
      opacity: 0;
      transform: translate3d(0, 8px, 0) scale(0.97);
    }

    .x-ai-toast-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
      background: #38bdf8;
      box-shadow: 0 0 8px currentColor;
    }
    .x-ai-toast[data-type="error"] .x-ai-toast-dot { background: #f43f5e; color: #f43f5e; }
    .x-ai-toast[data-type="warn"] .x-ai-toast-dot { background: #f59e0b; color: #f59e0b; }
    .x-ai-toast[data-type="success"] .x-ai-toast-dot { background: #10b981; color: #10b981; }
    .x-ai-toast[data-type="translate"] .x-ai-toast-dot { background: #a78bfa; color: #a78bfa; }

    .x-ai-toast-label {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #a78bfa;
      margin-bottom: 2px;
    }

    .x-ai-toast-body {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }

    .x-ai-toast-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 7px;
    }

    .x-ai-toast-btn {
      appearance: none;
      border: 1px solid rgba(29, 155, 240, 0.45);
      background: rgba(29, 155, 240, 0.18);
      color: #7dd3fc;
      font-family: inherit;
      font-size: 11.5px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .x-ai-toast-btn:hover {
      background: rgba(29, 155, 240, 0.3);
      border-color: rgba(56, 189, 248, 0.75);
    }

    .x-ai-toast-close {
      appearance: none;
      border: none;
      background: transparent;
      color: #8b98a5;
      font-size: 15px;
      line-height: 1;
      padding: 2px 4px;
      cursor: pointer;
      border-radius: 6px;
    }
    .x-ai-toast-close:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
    }

    @media (prefers-reduced-motion: reduce) {
      .x-ai-reply-button, .x-ai-reply-button::after, .x-ai-angle-bar, .x-ai-toast {
        transition: none !important;
        animation: none !important;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  stylesInjected = true;
}

function showToast(message, options = {}) {
  injectStyles();
  const {
    type = "info",
    title = "",
    duration = 4500,
    actionLabel = "",
    onAction = null,
  } = options;

  let host = document.querySelector(".x-ai-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "x-ai-toast-host";
    document.body.appendChild(host);
  }

  while (host.children.length >= 2) {
    host.firstElementChild.remove();
  }

  const toast = document.createElement("div");
  toast.className = "x-ai-toast";
  toast.dataset.type = type;

  const dot = document.createElement("span");
  dot.className = "x-ai-toast-dot";

  const body = document.createElement("div");
  body.className = "x-ai-toast-body";

  if (title) {
    const labelNode = document.createElement("div");
    labelNode.className = "x-ai-toast-label";
    labelNode.textContent = title;
    body.appendChild(labelNode);
  }

  const textNode = document.createElement("div");
  textNode.textContent = message;
  body.appendChild(textNode);

  const dismiss = () => {
    if (toast.dataset.leaving === "true") return;
    toast.dataset.leaving = "true";
    setTimeout(() => toast.remove(), 170);
  };

  if (actionLabel && typeof onAction === "function") {
    const actions = document.createElement("div");
    actions.className = "x-ai-toast-actions";
    const actBtn = document.createElement("button");
    actBtn.type = "button";
    actBtn.className = "x-ai-toast-btn";
    actBtn.textContent = actionLabel;
    actBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAction();
      dismiss();
    });
    actions.appendChild(actBtn);
    body.appendChild(actions);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "x-ai-toast-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  });

  toast.appendChild(dot);
  toast.appendChild(body);
  toast.appendChild(closeBtn);
  host.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

function openExtensionSettings() {
  try {
    chrome.runtime.sendMessage({ action: "openOptions" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    showToast("Extension was recently updated. Please refresh X (F5) first.", {
      type: "warn",
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Settings Sync
// ═══════════════════════════════════════════════════════════════
function applyStorageData(data) {
  if (!data) return;
  if (data.baseUrl !== undefined) {
    settingsCache.baseUrl = (data.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }
  if (data.apiKey !== undefined) {
    settingsCache.apiKey = data.apiKey || "";
  }
  if (data.model !== undefined) {
    settingsCache.model = data.model || DEFAULT_MODEL;
  }
  if (data.prompt !== undefined) {
    settingsCache.prompt = data.prompt;
  }
  if (data.timeout !== undefined) {
    const t = Number(data.timeout);
    settingsCache.timeout = Number.isFinite(t) && t > 0 ? t : 60;
  }
  if (data.visionMode !== undefined) {
    settingsCache.visionMode = data.visionMode !== false;
  }
  if (data.translationPreview !== undefined) {
    settingsCache.translationPreview = data.translationPreview !== false;
  }
  if (data.shortcutEnabled !== undefined) {
    settingsCache.shortcutEnabled = data.shortcutEnabled !== false;
  }
}

function loadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(
        [
          "baseUrl",
          "apiKey",
          "model",
          "prompt",
          "timeout",
          "visionMode",
          "translationPreview",
          "shortcutEnabled",
        ],
        (data) => {
          if (chrome.runtime.lastError) {
            console.warn("[Yap Extension] Storage read error:", chrome.runtime.lastError.message);
            resolve(settingsCache);
            return;
          }
          applyStorageData({
            baseUrl: data.baseUrl || DEFAULT_BASE_URL,
            apiKey: data.apiKey || "",
            model: data.model || DEFAULT_MODEL,
            prompt: data.prompt !== undefined ? data.prompt : DEFAULT_PROMPT,
            timeout: data.timeout,
            visionMode: data.visionMode !== false,
            translationPreview: data.translationPreview !== false,
            shortcutEnabled: data.shortcutEnabled !== false,
          });
          settingsLoaded = true;
          resolve(settingsCache);
        }
      );
    } catch (e) {
      resolve(settingsCache);
    }
  });
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const patch = {};
    for (const key of Object.keys(changes)) {
      patch[key] = changes[key].newValue;
    }
    applyStorageData(patch);
  });
} catch (e) {}

function buildEndpoint(baseUrl) {
  let url = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (!/\/chat\/completions(\?.*)?$/i.test(url)) {
    url += "/chat/completions";
  }
  return url;
}

// ═══════════════════════════════════════════════════════════════
// Deep Post Context + Vision Image URL Extractor
// ═══════════════════════════════════════════════════════════════
function cleanText(value) {
  return String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(text, maxLen) {
  const s = cleanText(text);
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return (sp > Math.floor(maxLen * 0.55) ? cut.slice(0, sp) : cut) + "...";
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "SECTION", "ARTICLE", "HEADER", "FOOTER"]);

function walkNodeText(el) {
  if (!el) return "";
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (tag === "IMG" && node.alt) {
        out += node.alt;
      } else if (tag === "BR") {
        out += " ";
      } else if (BLOCK_TAGS.has(tag)) {
        out += " " + walkNodeText(node) + " ";
      } else {
        out += walkNodeText(node);
      }
    }
  }
  return out;
}

function extractNodeTextWithEmojis(el) {
  if (!el) return "";
  return cleanText(walkNodeText(el));
}

function parseUserBlock(root, excludeScope) {
  if (!root) return { name: "", handle: "" };
  const userNodes = [...root.querySelectorAll('[data-testid="User-Name"]')];
  const userEl =
    userNodes.find((el) => !excludeScope || !excludeScope.contains(el)) || userNodes[0];
  if (!userEl) return { name: "", handle: "" };

  const raw = cleanText(userEl.innerText);
  const handleMatch = raw.match(/@([A-Za-z0-9_]{1,15})/);
  const handle = handleMatch ? "@" + handleMatch[1] : "";
  const name = raw
    .replace(/@([A-Za-z0-9_]+).*$/, "")
    .replace(/[·•].*$/, "")
    .trim();
  return { name, handle };
}

function findQuoteContainer(article) {
  if (!article) return null;
  const explicit = article.querySelector('[data-testid="quoteTweet"]');
  if (explicit) return explicit;

  const roleLinks = article.querySelectorAll('div[role="link"]');
  for (const link of roleLinks) {
    if (link === article) continue;
    if (link.closest('[data-testid^="card"]')) continue;
    const hasUser = Boolean(link.querySelector('[data-testid="User-Name"]'));
    const hasBody = Boolean(
      link.querySelector(
        '[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"]'
      )
    );
    if (hasUser && hasBody) return link;
  }
  return null;
}

function extractPollOptions(root, excludeScope) {
  const poll = root.querySelector('[data-testid="cardPoll"]');
  if (!poll || (excludeScope && excludeScope.contains(poll))) return "";

  const optionEls = poll.querySelectorAll('[role="radio"], [data-testid^="choice"], li');
  const opts = [];
  for (const el of optionEls) {
    const t = cleanText(extractNodeTextWithEmojis(el));
    if (t && !opts.includes(t)) opts.push(t);
  }
  if (opts.length > 0) return opts.slice(0, 5).join(" | ");
  return truncateAtWord(extractNodeTextWithEmojis(poll), 200);
}

function extractArticleLongform(root, excludeScope) {
  const titleEl = root.querySelector('[data-testid="twitter-article-title"]');
  const bodyEl = root.querySelector(
    '[data-testid="twitterArticleRichTextView"], [data-testid="twitterArticleReadView"], [data-testid="longformRichTextComponent"]'
  );
  const title =
    titleEl && (!excludeScope || !excludeScope.contains(titleEl))
      ? truncateAtWord(extractNodeTextWithEmojis(titleEl), 160)
      : "";
  const body =
    bodyEl && (!excludeScope || !excludeScope.contains(bodyEl))
      ? truncateAtWord(extractNodeTextWithEmojis(bodyEl), 420)
      : "";
  return { title, body };
}

function extractCardSummary(root, excludeScope) {
  const cards = root.querySelectorAll(
    '[data-testid="card.layoutLarge.detail"], [data-testid="card.layoutSmall.detail"], [data-testid="card.wrapper"], [data-testid^="card"]'
  );
  for (const card of cards) {
    if (card.getAttribute("data-testid") === "cardPoll") continue;
    if (excludeScope && excludeScope.contains(card)) continue;
    const cardText = extractNodeTextWithEmojis(card);
    if (cardText && cardText.length > 8) {
      return truncateAtWord(cardText, 340);
    }
  }
  return "";
}

function extractImageAlt(root, excludeScope) {
  const imgs = root.querySelectorAll('img[alt]:not([alt=""])');
  const alts = [];
  for (const img of imgs) {
    if (excludeScope && excludeScope.contains(img)) continue;
    if (img.closest('[data-testid^="Tweet-User-Avatar"], [data-testid="UserAvatar-Container"]')) {
      continue;
    }
    const src = String(img.getAttribute("src") || "").toLowerCase();
    if (src.includes("profile_images") || src.includes("twemoji") || src.includes("/emoji/")) {
      continue;
    }

    const alt = cleanText(img.getAttribute("alt"));
    const low = alt.toLowerCase();
    if (
      alt &&
      !low.includes("avatar") &&
      !low.includes("profile picture") &&
      low !== "image" &&
      low !== "gambar" &&
      low !== "embedded video" &&
      alt.length > 5 &&
      !alts.includes(alt)
    ) {
      alts.push(truncateAtWord(alt, 220));
    }
  }
  return alts.slice(0, 2).join(" | ");
}

function normalizeXMediaUrl(rawSrc) {
  const src = String(rawSrc || "").trim();
  if (!/^https?:\/\//i.test(src)) return "";
  try {
    const u = new URL(src);
    if (u.hostname.includes("twimg.com") && u.searchParams.has("name")) {
      u.searchParams.set("name", "medium");
    }
    return u.toString();
  } catch (e) {
    return src;
  }
}

// Extract attached media URLs (charts, screenshots, cards) for multimodal Vision mode
function extractImageUrls(root, excludeScope) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const imgs = root.querySelectorAll(
    '[data-testid="tweetPhoto"] img[src], [data-testid^="card"] img[src], [data-testid="videoPlayer"] img[src], img[src*="pbs.twimg.com/media/"]'
  );
  const urls = [];
  for (const img of imgs) {
    if (excludeScope && excludeScope.contains(img)) continue;
    if (img.closest('[data-testid^="Tweet-User-Avatar"], [data-testid="UserAvatar-Container"]')) {
      continue;
    }
    const rawSrc = String(img.getAttribute("src") || "");
    const low = rawSrc.toLowerCase();
    if (
      !rawSrc ||
      low.includes("profile_images") ||
      low.includes("profile_banners") ||
      low.includes("twemoji") ||
      low.includes("/emoji/")
    ) {
      continue;
    }
    const normalized = normalizeXMediaUrl(rawSrc);
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
      if (urls.length >= 2) break;
    }
  }
  return urls;
}

function detectMediaType(root, excludeScope, pollOptions, articleTitle) {
  if (pollOptions) return "Poll";
  if (articleTitle) return "X Longform Article";
  const video = root.querySelector('[data-testid="videoPlayer"], video');
  if (video && (!excludeScope || !excludeScope.contains(video))) return "Video Post";
  const photo = root.querySelector('[data-testid="tweetPhoto"]');
  if (photo && (!excludeScope || !excludeScope.contains(photo))) return "Image/Chart Post";
  return "";
}

function extractReplyTo(root) {
  if (!root) return "";
  const walker = root.querySelectorAll("span, div");
  for (const el of walker) {
    if (el.children.length > 6) continue;
    const t = cleanText(el.innerText);
    if (/^(Replying to|Membalas)\b/i.test(t) && t.length < 140) {
      return t;
    }
  }
  return "";
}

function extractDomLang(primaryNode, root, excludeScope) {
  const pickValid = (val) => {
    const code = String(val || "").trim().toLowerCase();
    if (!code || /^(und|zxx|qme|qht|qct|qam|art)$/.test(code)) return "";
    return code;
  };

  if (primaryNode && typeof primaryNode.getAttribute === "function") {
    const direct = pickValid(primaryNode.getAttribute("lang"));
    if (direct) return direct;
  }

  if (root && typeof root.querySelectorAll === "function") {
    const candidates = root.querySelectorAll(
      '[data-testid="tweetText"][lang], [data-testid="twitterArticleRichTextView"][lang], [data-testid="longformRichTextComponent"][lang]'
    );
    for (const el of candidates) {
      if (excludeScope && excludeScope.contains(el)) continue;
      const found = pickValid(el.getAttribute("lang"));
      if (found) return found;
    }
  }
  return "";
}

const TRANSLATED_LANG_NAME_MAP = {
  japanese: "ja",
  jepang: "ja",
  chinese: "zh-cn",
  "simplified chinese": "zh-cn",
  "traditional chinese": "zh-tw",
  mandarin: "zh-cn",
  tionghoa: "zh-cn",
  cina: "zh-cn",
  korean: "ko",
  korea: "ko",
  indonesian: "id",
  indonesia: "id",
  english: "en",
  inggris: "en",
  arabic: "ar",
  arab: "ar",
  russian: "ru",
  rusia: "ru",
  ukrainian: "uk",
  ukraina: "uk",
  thai: "th",
  thailand: "th",
  hindi: "hi",
  vietnamese: "vi",
  vietnam: "vi",
  spanish: "es",
  spanyol: "es",
  portuguese: "pt",
  portugis: "pt",
  french: "fr",
  prancis: "fr",
  german: "de",
  jerman: "de",
  turkish: "tr",
  turki: "tr",
  italian: "it",
  italia: "it",
  dutch: "nl",
  belanda: "nl",
  polish: "pl",
  polandia: "pl",
  tagalog: "tl",
  filipino: "tl",
  malay: "ms",
  melayu: "ms",
};

function extractTranslatedFromLang(root, excludeScope) {
  if (!root || typeof root.querySelectorAll !== "function") return "";
  const nodes = root.querySelectorAll("span, div, button");
  for (const el of nodes) {
    if (excludeScope && excludeScope.contains(el)) continue;
    if (el.children && el.children.length > 4) continue;
    const t = cleanText(el.innerText);
    if (!t || t.length > 90) continue;

    const m =
      t.match(/\bTranslated from\s+([A-Za-z\s()-]+?)(?:\s+by\b|$)/i) ||
      t.match(/\bDiterjemahkan dari(?:\s+bahasa)?\s+([A-Za-z\s()-]+?)(?:\s+oleh\b|$)/i);
    if (m && m[1]) {
      const key = m[1].replace(/[()]/g, "").trim().toLowerCase();
      if (TRANSLATED_LANG_NAME_MAP[key]) return TRANSLATED_LANG_NAME_MAP[key];
      const firstWord = key.split(/\s+/)[0];
      if (TRANSLATED_LANG_NAME_MAP[firstWord]) return TRANSLATED_LANG_NAME_MAP[firstWord];
    }
  }
  return "";
}

function extractDataFromArticle(article) {
  if (!article) return null;

  const quoteRoot = findQuoteContainer(article);
  const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
  const mainTextNode =
    textNodes.find((n) => !quoteRoot || !quoteRoot.contains(n)) || null;

  let tweetText = extractNodeTextWithEmojis(mainTextNode);
  const longform = extractArticleLongform(article, quoteRoot);
  if (!tweetText && longform.body) {
    tweetText = longform.body;
  } else if (tweetText && longform.body && longform.body.length > tweetText.length + 30) {
    tweetText = longform.body;
  }

  const tweetLang = extractDomLang(mainTextNode, article, quoteRoot);
  const translatedFromLang = extractTranslatedFromLang(article, quoteRoot);
  const { name, handle } = parseUserBlock(article, quoteRoot);
  const pollOptions = extractPollOptions(article, quoteRoot);
  const cardSummary = extractCardSummary(article, quoteRoot);
  const imageAlt = extractImageAlt(article, quoteRoot);
  let imageUrls = extractImageUrls(article, quoteRoot);
  const mediaType = detectMediaType(article, quoteRoot, pollOptions, longform.title);

  let quotedText = "";
  let quotedLang = "";
  if (quoteRoot) {
    const qTextNode = quoteRoot.querySelector('[data-testid="tweetText"]');
    quotedLang = extractDomLang(qTextNode, quoteRoot, null);
    const qBody =
      extractNodeTextWithEmojis(qTextNode) ||
      extractCardSummary(quoteRoot, null) ||
      extractImageAlt(quoteRoot, null);
    if (qBody && qBody !== tweetText && qBody.length > 2) {
      const qUser = parseUserBlock(quoteRoot, null);
      const qPrefix =
        qUser.name || qUser.handle
          ? `${[qUser.name, qUser.handle ? `(${qUser.handle})` : ""].filter(Boolean).join(" ")}: `
          : "";
      quotedText = truncateAtWord(qPrefix + qBody, 340);
    }
    if (imageUrls.length === 0) {
      imageUrls = extractImageUrls(quoteRoot, null);
    }
  }

  const replyTo = extractReplyTo(article);

  if (
    !tweetText &&
    !longform.title &&
    !pollOptions &&
    !quotedText &&
    !cardSummary &&
    !imageAlt &&
    imageUrls.length === 0
  ) {
    return null;
  }

  return {
    name,
    handle,
    tweetText: truncateAtWord(tweetText, 650),
    tweetLang,
    translatedFromLang,
    articleTitle: longform.title,
    pollOptions,
    quotedText,
    quotedLang,
    cardSummary,
    imageAlt,
    imageUrls,
    mediaType,
    replyTo,
    parentContext: "",
  };
}

function buildParentThreadSummary(articlesBeforeTarget) {
  if (!articlesBeforeTarget || articlesBeforeTarget.length === 0) return "";
  const recent = articlesBeforeTarget.slice(-2);
  const summaries = [];

  for (const art of recent) {
    const data = extractDataFromArticle(art);
    if (!data) continue;
    const body = data.tweetText || data.articleTitle || data.cardSummary || data.quotedText;
    if (!body) continue;
    const who = data.handle || data.name || "Author";
    summaries.push(`${who}: ${truncateAtWord(body, 220)}`);
  }
  return summaries.join("\n");
}

function extractComposerReplyTo(replyBox) {
  const scope =
    replyBox.closest('[role="dialog"]') ||
    replyBox.closest('[data-testid="cellInnerDiv"]') ||
    replyBox.parentElement?.parentElement?.parentElement;
  return extractReplyTo(scope);
}

function extractContextFromDialogNonArticle(dialog, replyBox) {
  const composerWrap = replyBox.closest(".DraftEditor-root") || replyBox.parentElement;
  const attachment =
    dialog.querySelector('[data-testid="attachments"]') ||
    dialog.querySelector('[data-testid="quoteTweet"]');

  const scope = attachment || dialog;
  const candidates = [...scope.querySelectorAll('[data-testid="tweetText"]')].filter(
    (el) => !composerWrap || !composerWrap.contains(el)
  );
  const targetTextEl = candidates[0] || null;
  const tweetText = extractNodeTextWithEmojis(targetTextEl);
  const tweetLang = extractDomLang(targetTextEl, scope, composerWrap);
  const translatedFromLang = extractTranslatedFromLang(scope, composerWrap);
  const { name, handle } = parseUserBlock(scope, composerWrap);
  const pollOptions = extractPollOptions(scope, composerWrap);
  const cardSummary = extractCardSummary(scope, composerWrap);
  const imageAlt = extractImageAlt(scope, composerWrap);
  const imageUrls = extractImageUrls(scope, composerWrap);

  if (!tweetText && !pollOptions && !cardSummary && !imageAlt && imageUrls.length === 0) {
    return null;
  }
  return {
    name,
    handle,
    tweetText: truncateAtWord(tweetText, 650),
    tweetLang,
    translatedFromLang,
    articleTitle: "",
    pollOptions,
    quotedText: "",
    quotedLang: "",
    cardSummary,
    imageAlt,
    imageUrls,
    mediaType: detectMediaType(scope, composerWrap, pollOptions, ""),
    replyTo: extractReplyTo(dialog),
    parentContext: "",
  };
}

function visibleText(el) {
  if (!el) return "";
  return cleanText(el.innerText || el.textContent || "");
}

function looksLikePostBody(text) {
  const value = cleanText(text);
  if (value.length < 8 || value.length > 1200) return false;
  if (/^(replying to|membalas|post your reply|what.?s happening|reply|post|quote)$/i.test(value)) return false;
  if (/^(show more|show this thread|translate post|view|follow)$/i.test(value)) return false;
  return true;
}

function contextFromVisibleComposer(replyBox) {
  const anchor = replyBox?.__xAiAnchor && replyBox.__xAiAnchor.isConnected ? replyBox.__xAiAnchor : replyBox;
  if (!anchor) return null;
  const anchorRect = anchor.getBoundingClientRect();
  const panel =
    anchor.closest('[role="dialog"]') ||
    [...document.querySelectorAll('[role="dialog"]')].find((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return rect.left <= anchorRect.right && rect.right >= anchorRect.left && rect.top <= anchorRect.bottom && rect.bottom >= anchorRect.top - 40;
    }) ||
    null;
  const scope = panel || document;
  const blocks = queryDeep(scope, "article, [data-testid='tweetText'], [data-testid='cellInnerDiv'], div, span");
  let best = "";
  let bestEl = null;
  let bestScore = Infinity;
  let replyTo = "";
  let name = "";
  let handle = "";

  for (const el of blocks) {
    if (!el || el.children?.length > 8) continue;
    if (el.closest?.(".x-ai-reply-group, .x-ai-toast-host")) continue;
    const text = visibleText(el);
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 8 || rect.bottom > anchorRect.top + 30) continue;
    if (panel && !panel.contains(el)) continue;
    const dist = anchorRect.top - rect.bottom;
    if (dist < -20 || dist > 900) continue;
    if (/^(replying to|membalas)\b/i.test(text) && text.length < 160) {
      replyTo = text;
      handle = (text.match(/@[\w_]+/) || [handle])[0] || handle;
      continue;
    }
    const userMatch = text.match(/^(.{1,40}?)\s+(@[\w_]{2,20})\b/);
    if (userMatch && text.length < 180 && dist < 420) {
      name = name || userMatch[1].replace(/[·•].*$/, "").trim();
      handle = handle || userMatch[2];
    }
    if (!looksLikePostBody(text)) continue;
    const score = dist + Math.abs(text.length - 140) * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = text;
      bestEl = el;
    }
  }

  if (!best && !replyTo) return null;
  const langNode = bestEl?.closest?.("[lang]") || bestEl?.querySelector?.("[lang]");
  return {
    name,
    handle: handle || (replyTo.match(/@[\w_]+/) || [""])[0],
    tweetText: truncateAtWord(best || replyTo, 650),
    tweetLang: langNode?.getAttribute?.("lang") || bestEl?.getAttribute?.("lang") || "",
    translatedFromLang: extractTranslatedFromLang(bestEl?.parentElement || document.body, null),
    articleTitle: "",
    pollOptions: "",
    quotedText: "",
    quotedLang: "",
    cardSummary: "",
    imageAlt: "",
    imageUrls: [],
    mediaType: "",
    replyTo,
    parentContext: "",
  };
}

function getPostContext(replyBox) {
  const emptyContext = {
    name: "",
    handle: "",
    tweetText: "",
    tweetLang: "",
    translatedFromLang: "",
    articleTitle: "",
    pollOptions: "",
    quotedText: "",
    quotedLang: "",
    cardSummary: "",
    imageAlt: "",
    imageUrls: [],
    mediaType: "",
    replyTo: "",
    parentContext: "",
  };

  const composerReplyTo = extractComposerReplyTo(replyBox);

  // 1. Modal Dialog (Reply / Quote Tweet / Thread Reply)
  const dialog = replyBox.closest('[role="dialog"]');
  if (dialog) {
    const articles = [
      ...dialog.querySelectorAll('article[data-testid="tweet"], article'),
    ];
    if (articles.length > 0) {
      const boxRect = replyBox.getBoundingClientRect();
      let chosenIdx = articles.length - 1;
      let bestDist = Infinity;

      for (let i = 0; i < articles.length; i++) {
        const rect = articles[i].getBoundingClientRect();
        const dist = boxRect.top - rect.bottom;
        if (dist >= -40 && dist < bestDist) {
          bestDist = dist;
          chosenIdx = i;
        }
      }

      const extracted = extractDataFromArticle(articles[chosenIdx]);
      if (extracted) {
        if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
        if (chosenIdx > 0) {
          extracted.parentContext = buildParentThreadSummary(articles.slice(0, chosenIdx));
        }
        return extracted;
      }
    }

    const dialogFallback = extractContextFromDialogNonArticle(dialog, replyBox);
    if (dialogFallback) return dialogFallback;
    const visibleDialog = contextFromVisibleComposer(replyBox);
    return visibleDialog || emptyContext;
  }

  // 2. Reply box directly inside <article>
  const ownArticle = replyBox.closest("article");
  if (ownArticle) {
    const extracted = extractDataFromArticle(ownArticle);
    if (extracted) {
      if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
      return extracted;
    }
  }

  // 3. Status detail page (/status/<id>) — prioritize the primary focal tweet
  const allTweets = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const statusMatch = location.pathname.match(/\/status\/(\d+)/);
  if (statusMatch) {
    const statusId = statusMatch[1];
    const mainFocalTweet =
      document.querySelector('article[tabindex="-1"]') ||
      allTweets.find((art) => art.querySelector(`a[href*="/status/${statusId}"]`));
    if (mainFocalTweet) {
      const extracted = extractDataFromArticle(mainFocalTweet);
      if (extracted) {
        if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
        const focalIdx = allTweets.indexOf(mainFocalTweet);
        if (focalIdx > 0) {
          extracted.parentContext = buildParentThreadSummary(allTweets.slice(0, focalIdx));
        }
        return extracted;
      }
    }
  }

  // 4. Fallback: nearest tweet above the reply composer
  const boxRect = replyBox.getBoundingClientRect();
  let bestIdx = -1;
  let minDistance = Infinity;

  for (let i = 0; i < allTweets.length; i++) {
    const rect = allTweets[i].getBoundingClientRect();
    const dist = boxRect.top - rect.bottom;
    if (dist >= -80 && dist < minDistance) {
      minDistance = dist;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) {
    const extracted = extractDataFromArticle(allTweets[bestIdx]);
    if (extracted) {
      if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
      if (bestIdx > 0) {
        extracted.parentContext = buildParentThreadSummary(allTweets.slice(0, bestIdx));
      }
      return extracted;
    }
  }

  return contextFromVisibleComposer(replyBox) || emptyContext;
}

// ═══════════════════════════════════════════════════════════════
// Mount Container, Quick Angle Mini-Menu & Zero-Reflow Injection
// ═══════════════════════════════════════════════════════════════
function getOverlayHost() {
  let host = document.getElementById("x-ai-reply-overlay");
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  host.id = "x-ai-reply-overlay";
  host.setAttribute("data-translate", "no");
  (document.body || document.documentElement).appendChild(host);
  return host;
}

function positionReplyGroup(group, box) {
  const anchor = group?.__xAiAnchor && group.__xAiAnchor.isConnected ? group.__xAiAnchor : box;
  if (!group || !anchor || !anchor.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) {
    group.style.display = "none";
    return;
  }
  const width = group.offsetWidth || 108;
  const height = group.offsetHeight || 32;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const top = Math.max(8, rect.top - height - 8);
  group.style.display = "inline-flex";
  group.style.left = `${Math.round(left)}px`;
  group.style.top = `${Math.round(top)}px`;
}

function repositionMountedGroups() {
  for (const group of mountedGroups) {
    if (!group.isConnected) continue;
    const box = group.__xAiBox;
    if (!box || !box.isConnected) continue;
    positionReplyGroup(group, box);
  }
}

function shouldInjectForBox(box) {
  if (!box || !box.isConnected) return false;
  const label = `${box.getAttribute("aria-label") || ""} ${box.getAttribute("data-placeholder") || ""} ${box.textContent || ""}`;
  if (isGrokSurface(box)) return false;
  if (/post your reply|reply|quote|what.?s happening/i.test(label)) return true;
  if (box.closest('[role="dialog"], article, main, [data-testid="primaryColumn"], [data-testid="cellInnerDiv"]')) {
    return true;
  }
  return /\/status\/\d+|^\/(home|compose\/post|compose\/tweet)?$/.test(location.pathname);
}

function setButtonVisualState(btn, state, langCode = "") {
  if (!btn) return;
  const group = btn.closest?.(".x-ai-reply-group");
  if (state === "loading") {
    btn.dataset.loading = "true";
    delete btn.dataset.state;
    if (group) group.dataset.busy = "true";
    btn.innerHTML = `${SPINNER_SVG}<span>Thinking…</span>`;
  } else if (state === "done") {
    delete btn.dataset.loading;
    btn.dataset.state = "done";
    if (group) delete group.dataset.busy;
    const shortLang =
      langCode && langCode !== "same"
        ? ` · ${String(langCode).split("-")[0].toUpperCase()}`
        : "";
    btn.innerHTML = `${CHECK_SVG}<span>Done${shortLang}</span>`;
  } else {
    delete btn.dataset.loading;
    delete btn.dataset.state;
    if (group) delete group.dataset.busy;
    btn.innerHTML = `${SPARKLE_SVG}<span>AI Reply</span>`;
  }
}

function cleanupOrphanButtons() {
  for (const group of mountedGroups) {
    const box = group.__xAiBox;
    const anchor = group.__xAiAnchor;
    if (!group.isConnected || !anchor || !anchor.isConnected) {
      group.remove();
      mountedGroups.delete(group);
      // Clean up WeakMap references to prevent stale entries blocking new button mounts
      if (box) boxButtonMap.delete(box);
      if (anchor) boxButtonMap.delete(anchor);
    }
  }
}

const QUICK_ANGLES = [
  { id: "agree", label: "👍 Agree", title: "Co-sign / agree with one concrete reason" },
  { id: "ask", label: "🤔 Ask", title: "Ask a sharp, curious follow-up question" },
  { id: "counter", label: "⚡ Counter", title: "Offer a calm skeptical / contrarian angle" },
  { id: "witty", label: "😎 Witty", title: "Drop a dry, effortless witty observation" },
];

function isSubmitButton(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.closest?.(".x-ai-reply-group, [role='search']")) return false;
  if (isGrokSurface(el)) return false;
  const testId = el.getAttribute("data-testid") || "";
  if (/tweetButton/i.test(testId)) return true;
  const label = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  if (!/^(reply|post|quote)$/i.test(label)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 36 && rect.width <= 180 && rect.height >= 24 && rect.height <= 64;
}

function findReplyActionButtons(root) {
  const scope = root && (root.querySelectorAll || root instanceof ShadowRoot) ? root : document;
  const nodes = queryDeep(scope, 'button, [role="button"], div[tabindex="0"]');
  const hits = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!isSubmitButton(node) || seen.has(node)) continue;
    const nested = node.parentElement?.closest?.("button, [role='button']");
    if (nested && isSubmitButton(nested)) continue;
    seen.add(node);
    hits.push(node);
  }
  return hits;
}

function findEditorNear(anchor) {
  if (!anchor) return null;
  let node = anchor;
  for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
    const editors = queryComposerBoxes(node);
    if (editors.length) return editors[0];
    const editable = node.querySelector?.(
      '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
    );
    if (editable && !editable.closest?.("[role='search']")) return editable;
  }
  // Only return anchor if it is itself an editable element, otherwise null
  const anchorEditable = anchor.getAttribute?.("contenteditable");
  if (anchorEditable === "true" || anchorEditable === "plaintext-only" || anchor.getAttribute?.("role") === "textbox") {
    return anchor;
  }
  return null;
}

function insertButtonIntoReplyBoxes() {
  cleanupOrphanButtons();

  const replyBoxes = queryComposerBoxes(document);
  const anchors = findReplyActionButtons(document);
  if (replyBoxes.length === 0 && anchors.length === 0) return;

  injectStyles();

  // Phase 1: Batch DOM reads
  const pendingMounts = [];
  const seenAnchors = new Set();
  const targets = anchors.length
    ? anchors.map((anchor) => ({ box: findEditorNear(anchor), anchor }))
    : replyBoxes.map((box) => ({ box, anchor: null }));

  for (const target of targets) {
    const box = target.box;
    const anchor = target.anchor;
    // Skip if findEditorNear could not locate a valid editor for this anchor
    if (anchor && !box) continue;
    const key = anchor || box;
    if (!key || seenAnchors.has(key)) continue;
    seenAnchors.add(key);
    const existing = boxButtonMap.get(key);
    if (existing && existing.isConnected) continue;
    if (anchor?.parentElement?.querySelector(":scope > .x-ai-reply-group")) continue;
    if (box && !shouldInjectForBox(box) && !anchor) continue;
    pendingMounts.push({ box: box || anchor, anchor });
  }

  // Phase 2: Batch DOM writes
  for (let i = 0; i < pendingMounts.length; i++) {
    const { box, anchor } = pendingMounts[i];

    const group = document.createElement("div");
    group.className = "x-ai-reply-group";
    group.setAttribute("data-translate", "no");

    const angleBar = document.createElement("div");
    angleBar.className = "x-ai-angle-bar";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "x-ai-reply-button";
    btn.title = "Generate AI Reply (Alt+R) · Hover for quick reaction angles";
    btn.setAttribute("data-translate", "no");
    setButtonVisualState(btn, "idle");

    for (const item of QUICK_ANGLES) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "x-ai-angle-pill";
      pill.textContent = item.label;
      pill.title = item.title;
      pill.dataset.angle = item.id;
      pill.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        delete group.dataset.open;
        if (btn.dataset.loading === "true") return;
        setButtonVisualState(btn, "loading");
        generateText(box, btn, box.parentElement, item.id);
      });
      angleBar.appendChild(pill);
    }

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("mouseenter", () => {
      group.dataset.open = "true";
    });
    group.addEventListener("mouseleave", () => {
      delete group.dataset.open;
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.loading === "true") return;
      setButtonVisualState(btn, "loading");
      generateText(box, btn, box.parentElement, "auto");
    });

    group.appendChild(angleBar);
    group.appendChild(btn);
    group.__xAiBox = box;
    group.__xAiAnchor = anchor || box;
    getOverlayHost().appendChild(group);
    group.style.position = "fixed";
    group.style.zIndex = "2147483646";
    positionReplyGroup(group, box);

    boxButtonMap.set(anchor || box, btn);
    if (box && box !== anchor) boxButtonMap.set(box, btn);
    mountedGroups.add(group);
  }
}

// ═══════════════════════════════════════════════════════════════
// Reply Sanitizer & Non-Blocking Translation Preview
// ═══════════════════════════════════════════════════════════════
function dedupeRepeatedText(text) {
  const s = String(text || "").trim();
  if (s.length < 8) return s;

  if (s.length % 2 === 0) {
    const half = s.length / 2;
    const first = s.slice(0, half);
    const second = s.slice(half);
    if (first.toLowerCase() === second.toLowerCase()) {
      return first.trim();
    }
  }

  const repeatedMatch = s.match(/^(.{4,}?)(?:[\s.!?,;—。！？、-]+)\1$/i);
  if (repeatedMatch) {
    return repeatedMatch[1].trim();
  }

  return s;
}

function cleanModelReply(rawText) {
  let cleaned = String(rawText || "");
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  if (/<think\b|<thinking\b/i.test(cleaned)) {
    return "";
  }

  cleaned = cleaned
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’「」『』`]+|["'“”‘’「」『』`]+$/g, "")
    .replace(/[.。!！]+$/g, "")
    .trim();

  return dedupeRepeatedText(cleaned);
}

function showForeignTranslationPreview(replyText, langCode, langLabel) {
  if (!settingsCache.translationPreview) return;
  if (!langCode || langCode === "en" || langCode === "same") return;

  try {
    chrome.runtime.sendMessage(
      {
        action: "translatePreview",
        endpoint: buildEndpoint(settingsCache.baseUrl),
        apiKey: settingsCache.apiKey.trim(),
        model: settingsCache.model,
        timeoutMs: 20000,
        replyText,
        sourceLang: langLabel || langCode,
      },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok || !res.translation) return;
        const tag = String(langCode).toUpperCase();
        showToast(res.translation, {
          type: "translate",
          title: `Reply Meaning (${tag} → EN)`,
          duration: 8500,
        });
      }
    );
  } catch (e) {}
}

async function generateText(box, btn, mountContainer, angle = "auto") {
  let succeeded = false;

  try {
    const now = Date.now();
    if (now - lastRequestTime < MIN_REQUEST_INTERVAL_MS) {
      const waitSec = Math.ceil((MIN_REQUEST_INTERVAL_MS - (now - lastRequestTime)) / 1000);
      showToast(`Please wait ${waitSec}s before generating again.`, {
        type: "warn",
        duration: 2400,
      });
      return;
    }

    if (!settingsLoaded) {
      await loadSettings();
    }

    if (!settingsCache.apiKey.trim()) {
      showToast("API key is not configured yet.", {
        type: "warn",
        duration: 6000,
        actionLabel: "Open Settings",
        onAction: openExtensionSettings,
      });
      return;
    }

    const post = getPostContext(box);
    const hasContent =
      post.tweetText ||
      post.articleTitle ||
      post.pollOptions ||
      post.quotedText ||
      post.cardSummary ||
      post.imageAlt ||
      (Array.isArray(post.imageUrls) && post.imageUrls.length > 0);

    if (!hasContent) {
      showToast("Could not detect post context. Make sure the target post is visible.", {
        type: "warn",
      });
      return;
    }

    const timeoutMs = Math.round(settingsCache.timeout * 1000);
    const savedAngle =
      angle && angle !== "auto"
        ? angle
        : /\bwitty\b|\bdeadpan\b|\bclever\b/i.test(settingsCache.prompt)
          ? "witty"
          : /\bfollow-up\b|\bask a short\b|\bcurious\b|\bcritical take\b/i.test(settingsCache.prompt)
            ? "ask"
            : /\bcrypto-native\b|\bcontrarian\b|\bskeptical\b|\bcounter\b/i.test(settingsCache.prompt)
              ? "counter"
              : /\bdry\b|\beffortless\b|\bcasual\b/i.test(settingsCache.prompt)
                ? "agree"
                : "auto";

    const result = await sendMessageSafe(
      {
        action: "generateReply",
        endpoint: buildEndpoint(settingsCache.baseUrl),
        apiKey: settingsCache.apiKey.trim(),
        model: settingsCache.model,
        systemPrompt: settingsCache.prompt,
        timeoutMs,
        angle: savedAngle,
        visionMode: settingsCache.visionMode,
        post,
      },
      timeoutMs + 25000
    );

    // Update rate limit timestamp regardless of success/failure to prevent spam
    lastRequestTime = Date.now();

    if (!result || result.error) {
      const errObj = new Error(result?.error || "Failed to contact API");
      errObj.code = result?.code || "";
      throw errObj;
    }

    if (!result.ok) {
      const rawErr = result.data?.error;
      let msg = "Upstream API error";
      if (typeof rawErr === "string" && rawErr.trim()) msg = rawErr;
      else if (rawErr?.message) msg = rawErr.message;
      else if (typeof rawErr?.error === "string") msg = rawErr.error;
      else if (rawErr) msg = JSON.stringify(rawErr).slice(0, 180);
      throw new Error(`HTTP ${result.status} — ${msg}`);
    }

    const messageObj = result.data?.choices?.[0]?.message;
    let rawReply = messageObj?.content;

    if (!rawReply && typeof result.data?.choices?.[0]?.text === "string") {
      rawReply = result.data.choices[0].text;
    }

    const replyText = cleanModelReply(rawReply);

    if (!replyText) {
      if (
        messageObj?.reasoning_content ||
        /<think\b|<thinking\b/i.test(String(rawReply || ""))
      ) {
        throw new Error(
          "Reasoning model ran out of tokens before writing the final reply. Try again or switch to a faster model."
        );
      }
      throw new Error("Model returned an empty response.");
    }

    const inserted = await insertTextProperly(box, replyText, mountContainer);
    if (!inserted) {
      showToast("The reply box was closed before generation completed.", {
        type: "warn",
      });
      return;
    }

    succeeded = true;
    setButtonVisualState(btn, "done", result.detectedLang);
    setTimeout(() => {
      if (btn && btn.isConnected && btn.dataset.loading !== "true") {
        setButtonVisualState(btn, "idle");
      }
    }, 1400);

    // Non-blocking English translation preview when replying in any non-English language
    showForeignTranslationPreview(
      replyText,
      result.detectedLang,
      result.detectedLangLabel
    );
  } catch (err) {
    console.error("[X AI Reply] Error:", err);
    const msg = err?.message || String(err);
    const needsPerm =
      err?.code === "no_permission" || /no_permission|host permission/i.test(msg);

    if (needsPerm) {
      showToast(
        "Host permission for your Base URL is not granted yet. Open Settings and click \"Allow Host Access\".",
        {
          type: "error",
          duration: 7500,
          actionLabel: "Open Settings",
          onAction: openExtensionSettings,
        }
      );
    } else {
      showToast(msg, { type: "error", duration: 5500 });
    }
  } finally {
    if (!succeeded) {
      setButtonVisualState(btn, "idle");
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// insertTextProperly — Ghost-Free Draft.js Paste Handler
// ═══════════════════════════════════════════════════════════════
function waitFrames(ms = 24) {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, ms));
    } else {
      setTimeout(resolve, ms);
    }
  });
}

async function insertTextProperly(el, text, fallbackScope) {
  const resolveLiveBox = () => {
    if (el && document.contains(el)) return el;
    if (fallbackScope && document.contains(fallbackScope)) {
      return queryComposerBoxes(fallbackScope)[0] || null;
    }
    return null;
  };

  el = resolveLiveBox();
  if (!el) return false;

  isInsertingText = true;
  if (observerDebounceTimer) {
    clearTimeout(observerDebounceTimer);
    observerDebounceTimer = null;
  }
  if (observerRafId && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(observerRafId);
    observerRafId = null;
  }
  if (reconnectObserverTimer) {
    clearTimeout(reconnectObserverTimer);
    reconnectObserverTimer = null;
  }
  observer.disconnect();

  try {
    if (document.activeElement !== el) {
      el.focus();
      await waitFrames(35);
      el = resolveLiveBox();
      if (!el) return false;
      if (document.activeElement !== el) {
        el.focus();
        await waitFrames(16);
      }
      if (document.activeElement !== el) {
        console.error("[X AI Reply] Could not focus reply editor.");
        return false;
      }
    }

    if (cleanText(el.innerText).length > 0) {
      try {
        document.execCommand("selectAll", false, null);
        await waitFrames(24);
        document.execCommand("delete", false, null);
        await waitFrames(24);
      } catch (e) {}
    }

    let handledByPaste = false;
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      const notCancelled = el.dispatchEvent(pasteEvent);
      if (!notCancelled) {
        handledByPaste = true;
      } else {
        await waitFrames(20);
        const current = cleanText(el.innerText);
        if (current && current.includes(text.slice(0, Math.min(12, text.length)))) {
          handledByPaste = true;
        }
      }
    } catch (e) {
      console.warn("[X AI Reply] ClipboardEvent paste failed, trying fallback:", e);
    }

    if (!handledByPaste) {
      // Try InputEvent-based insertion first (modern editors including Lexical)
      let insertedViaInput = false;
      try {
        const inputEvent = new InputEvent("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        el.dispatchEvent(inputEvent);
        await waitFrames(20);
        const afterInput = cleanText(el.innerText);
        if (afterInput && afterInput.includes(text.slice(0, Math.min(12, text.length)))) {
          insertedViaInput = true;
        }
      } catch (e) {}

      if (!insertedViaInput) {
        try {
          document.execCommand("insertText", false, text);
        } catch (e) {
          el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }

    // Final verification: if text still not in editor, force it as last resort
    await waitFrames(20);
    const finalCheck = cleanText(el.innerText);
    if (!finalCheck || !finalCheck.includes(text.slice(0, Math.min(12, text.length)))) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    return true;
  } finally {
    reconnectObserverTimer = setTimeout(() => {
      reconnectObserverTimer = null;
      isInsertingText = false;
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }, 450);
  }
}

// ═══════════════════════════════════════════════════════════════
// Keyboard Shortcut: Alt + R to trigger AI Reply immediately
// ═══════════════════════════════════════════════════════════════
function findTargetButtonForShortcut() {
  const activeEl = document.activeElement;
  if (activeEl && typeof activeEl.closest === "function") {
    const focusedEditor = activeEl.closest(
      COMPOSER_SELECTOR
    );
    if (focusedEditor) {
      const btn = boxButtonMap.get(focusedEditor);
      if (btn && btn.isConnected) return btn;
    }
  }

  const openDialog = document.querySelector?.('[role="dialog"]');
  if (openDialog) {
    const dialogBtn = openDialog.querySelector?.(".x-ai-reply-button");
    if (dialogBtn) return dialogBtn;
  }

  for (const group of mountedGroups) {
    if (group.isConnected) {
      const btn = group.querySelector(".x-ai-reply-button");
      if (btn) return btn;
    }
  }
  return null;
}

if (typeof document.addEventListener === "function") {
  document.addEventListener("keydown", (e) => {
    if (!settingsCache.shortcutEnabled) return;
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.code !== "KeyR" && String(e.key || "").toLowerCase() !== "r") return;

    const btn = findTargetButtonForShortcut();
    if (!btn || btn.dataset.loading === "true") return;

    e.preventDefault();
    e.stopPropagation();
    btn.click();
  });
}

// ═══════════════════════════════════════════════════════════════
// sendMessageSafe — chrome.runtime.sendMessage with timeout guard
// ═══════════════════════════════════════════════════════════════
function sendMessageSafe(payload, waitMs) {
  const totalWait = waitMs || 30000;
  return new Promise((resolve, reject) => {
    let settled = false;

    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Service worker did not respond (timed out after ${Math.round(totalWait / 1000)}s).`
        )
      );
    }, totalWait);

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(arg);
    };

    try {
      chrome.runtime.sendMessage(payload, (response) => {
        const err = chrome.runtime.lastError;

        if (err && /context invalidated|message port closed/i.test(err.message)) {
          return done(
            reject,
            new Error("Extension was reloaded. Please refresh X (F5) and try again.")
          );
        }
        if (err && /receiving end does not exist/i.test(err.message)) {
          return done(
            reject,
            new Error(
              "Service worker is inactive. Open chrome://extensions → reload extension, then refresh X."
            )
          );
        }
        if (err) {
          return done(reject, new Error("Runtime error: " + err.message));
        }
        if (response === undefined) {
          return done(
            reject,
            new Error("Service worker returned no response. Please refresh X and try again.")
          );
        }
        done(resolve, response);
      });
    } catch (e) {
      done(reject, new Error("Extension was reloaded. Please refresh X (F5) and try again."));
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════
loadSettings();

function bootComposerWatcher() {
  if (!document.body) return;
  observer.observe(document.body, { childList: true, subtree: true });
  insertButtonIntoReplyBoxes();
  window.addEventListener("scroll", repositionMountedGroups, true);
  window.addEventListener("resize", repositionMountedGroups);
  setInterval(() => {
    if (!isInsertingText) {
      insertButtonIntoReplyBoxes();
      repositionMountedGroups();
    }
  }, 700);
}

if (document.body) {
  bootComposerWatcher();
} else {
  window.addEventListener("DOMContentLoaded", bootComposerWatcher);
}
