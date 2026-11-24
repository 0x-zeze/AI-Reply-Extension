// X AI Reply — Content Script (v5.4.1 Global Edition)
// GPU-composited "AI Reply" + Quick Angle Mini-Menu, Alt+R Shortcut,
// Vision Image Extractor (including Modal Underlying-Tweet Media Recovery),
// Multi-Layer Context Engine, English Translation Preview, & Draft.js / Lexical Replace Handler.

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.6-high";
const DEFAULT_PROMPT =
  "super casual and chill, like texting a friend on X, short punchy natural slang when it fits, never sound like an AI or analyst, no emojis";

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

// Rate limiting & global in-flight lock — minimum 2.5s between requests
let lastRequestTime = 0;
let isGenerating = false;
const MIN_REQUEST_INTERVAL_MS = 2500;

// ═══════════════════════════════════════════════════════════════
// Tracking & Zero-Lag MutationObserver
// ═══════════════════════════════════════════════════════════════
let isInsertingText = false;
let observerDebounceTimer = null;
let observerRafId = null;
let reconnectObserverTimer = null;

const boxButtonMap = new WeakMap();
const lastGeneratedByBox = new WeakMap();
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

function isDmOrNonReplySurface(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (/^\/messages(\/|$)/i.test(location.pathname)) return true;
  if (
    el.closest?.(
      '.x-ai-reply-group, .x-ai-toast-host, [role="search"], [data-testid="SearchBox_Search_Input"], [data-testid="DMDrawer"], [data-testid^="dmComposer"], [data-testid="DM_Conversation"]'
    )
  ) {
    return true;
  }
  const testId = el.getAttribute("data-testid") || "";
  return /^dmComposer/i.test(testId);
}

function isComposerBox(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (isDmOrNonReplySurface(el) || isGrokSurface(el)) return false;

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
  return /post|reply|quote|what.?s happening|tweet|balas|kutip|返信|ポスト|回复|回覆|发帖|답글|게시|responder|répondre|antworten/i.test(label);
}

function hasAnyComposerHintInDom(scope) {
  if (!scope || typeof scope.querySelector !== "function") return false;
  return Boolean(
    scope.querySelector(
      '[contenteditable="true"], [contenteditable="plaintext-only"], textarea, [role="dialog"], dialog[open], [data-testid^="tweetButton"]'
    )
  );
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
  if (/^\/messages(\/|$)|\/i\/grok|\/grok/i.test(location.pathname)) return [];
  const scope = root && (root.querySelectorAll || root instanceof ShadowRoot) ? root : document;
  if (!hasAnyComposerHintInDom(scope)) return [];
  const hints = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue || "";
      return /post your reply|what.?s happening|tweet your reply|posting balasan|返信をポスト|发布你的回复|답글 게시하기|postea tu respuesta/i.test(value)
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
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const editable = node.querySelector?.(
        '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'
      );
      if (!editable || seen.has(editable)) continue;
      if (isDmOrNonReplySurface(editable) || isGrokSurface(editable)) continue;
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
  if (/^\/messages(\/|$)|\/i\/grok|\/grok/i.test(location.pathname)) return [];
  const scope = root && (root.querySelectorAll || root instanceof ShadowRoot) ? root : document;
  if (!hasAnyComposerHintInDom(scope)) return [];
  const nodes = queryDeep(
    scope,
    `${COMPOSER_SELECTOR}, [data-testid^="tweetTextarea"] [contenteditable="true"], [data-testid*="tweetTextarea"] [contenteditable]`
  );
  const found = [];
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node)) continue;
    if (!isComposerBox(node)) continue;
    seen.add(node);
    found.push(node);
  }
  // Only fall back to full TreeWalker scan when standard selectors found nothing
  if (found.length === 0) {
    for (const node of findComposerFromPlaceholder(scope)) {
      if (seen.has(node)) continue;
      if (isDmOrNonReplySurface(node) || isGrokSurface(node)) continue;
      seen.add(node);
      found.push(node);
    }
  }
  return found;
}

function isExtensionNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  return Boolean(
    node.id === "x-ai-reply-overlay" ||
      node.id === "x-ai-reply-styles" ||
      node.matches?.(".x-ai-reply-group, .x-ai-reply-button, .x-ai-toast-host, .x-ai-reply-overlay-host")
  );
}

function hasRelevantDomMutation(mutations) {
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;

    // Ignore mutations that only add/remove our own extension elements
    let hasExternalNode = false;
    for (const n of m.addedNodes) {
      if (!isExtensionNode(n)) {
        hasExternalNode = true;
        break;
      }
    }
    if (!hasExternalNode) {
      for (const n of m.removedNodes) {
        if (!isExtensionNode(n)) {
          hasExternalNode = true;
          break;
        }
      }
    }
    if (!hasExternalNode) continue;

    const target = m.target;
    if (target && target.nodeType === Node.ELEMENT_NODE) {
      if (
        target.closest?.(
          ".x-ai-reply-group, .x-ai-reply-button, .x-ai-toast-host, .x-ai-reply-overlay-host, #x-ai-reply-overlay"
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

    #x-ai-reply-overlay,
    .x-ai-reply-overlay-host {
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
      background: rgba(15, 20, 25, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.34);
      opacity: 0;
      transform: translate3d(0, 6px, 0) scale(0.96);
      pointer-events: none;
      backface-visibility: hidden;
      transition:
        opacity 0.16s cubic-bezier(0.22, 1, 0.36, 1),
        transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Invisible hover bridge covering the 7px gap between AI Reply button and angle bar */
    .x-ai-angle-bar::after {
      content: "";
      position: absolute;
      left: -6px;
      right: -6px;
      top: 100%;
      height: 14px;
      pointer-events: none;
    }

    .x-ai-reply-group[data-placement="bottom"] .x-ai-angle-bar {
      bottom: auto;
      top: 34px;
      transform: translate3d(0, -6px, 0) scale(0.96);
    }

    .x-ai-reply-group[data-placement="bottom"] .x-ai-angle-bar::after {
      top: auto;
      bottom: 100%;
    }

    .x-ai-reply-group[data-align="left"] .x-ai-angle-bar {
      right: auto;
      left: 0;
    }

    .x-ai-reply-group:hover .x-ai-angle-bar,
    .x-ai-reply-group:focus-within .x-ai-angle-bar,
    .x-ai-reply-group[data-open="true"] .x-ai-angle-bar {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      pointer-events: auto;
    }

    .x-ai-reply-group:hover .x-ai-angle-bar::after,
    .x-ai-reply-group:focus-within .x-ai-angle-bar::after,
    .x-ai-reply-group[data-open="true"] .x-ai-angle-bar::after {
      pointer-events: auto;
    }

    .x-ai-reply-group[data-busy="true"] .x-ai-angle-bar,
    .x-ai-reply-group[data-busy="true"] .x-ai-angle-bar::after {
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
    (document.body || document.documentElement).appendChild(host);
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
// Settings Sync (chrome.storage.local v2 with seamless sync fallback)
// ═══════════════════════════════════════════════════════════════
const SETTINGS_KEYS = [
  "baseUrl",
  "apiKey",
  "model",
  "prompt",
  "timeout",
  "visionMode",
  "translationPreview",
  "shortcutEnabled",
  "_storageV2",
];
let usingLocalStorageV2 = false;

function normalizeBaseUrl(raw) {
  let v = String(raw || "").trim();
  if (!v) return DEFAULT_BASE_URL;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.)/i.test(v);
    v = (isLocal ? "http://" : "https://") + v;
  }
  return v.replace(/\/+$/, "");
}

function clampTimeoutSec(value) {
  const t = Number(value);
  if (!Number.isFinite(t) || t <= 0) return 60;
  return Math.min(Math.max(Math.round(t), 5), 180);
}

function applyStorageData(data) {
  if (!data) return;
  if (data._storageV2 === true) {
    usingLocalStorageV2 = true;
  }
  if (data.baseUrl !== undefined) {
    settingsCache.baseUrl = normalizeBaseUrl(data.baseUrl || DEFAULT_BASE_URL);
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
    settingsCache.timeout = clampTimeoutSec(data.timeout);
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

function readStorageArea(area, keys) {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage[area]) return resolve(null);
      chrome.storage[area].get(keys, (data) => {
        if (chrome.runtime.lastError) {
          console.warn("[X AI Reply] Storage read error:", chrome.runtime.lastError.message);
          return resolve(null);
        }
        resolve(data || {});
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function loadSettings() {
  try {
    const localData = await readStorageArea("local", SETTINGS_KEYS);
    let source = null;

    if (
      localData &&
      (localData._storageV2 === true ||
        localData.apiKey !== undefined ||
        localData.baseUrl !== undefined)
    ) {
      usingLocalStorageV2 = true;
      source = localData;
    } else {
      const syncData = await readStorageArea("sync", SETTINGS_KEYS);
      source = syncData || localData || {};
    }

    applyStorageData({
      baseUrl: source.baseUrl || DEFAULT_BASE_URL,
      apiKey: source.apiKey || "",
      model: source.model || DEFAULT_MODEL,
      prompt: source.prompt !== undefined ? source.prompt : DEFAULT_PROMPT,
      timeout: source.timeout,
      visionMode: source.visionMode !== false,
      translationPreview: source.translationPreview !== false,
      shortcutEnabled: source.shortcutEnabled !== false,
      _storageV2: source._storageV2 === true,
    });
    settingsLoaded = true;
  } catch (e) {}
  return settingsCache;
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      const relevant = SETTINGS_KEYS.some((k) => Object.prototype.hasOwnProperty.call(changes, k));
      if (!relevant) return;
      const patch = {};
      for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          patch[key] = changes[key].newValue;
        }
      }
      usingLocalStorageV2 = true;
      applyStorageData(patch);
      return;
    }
    if (area === "sync" && !usingLocalStorageV2) {
      const patch = {};
      for (const key of Object.keys(changes)) {
        patch[key] = changes[key].newValue;
      }
      applyStorageData(patch);
    }
  });
} catch (e) {}

function buildEndpoint(baseUrl) {
  let url = normalizeBaseUrl(baseUrl || DEFAULT_BASE_URL);
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

const REPLYING_TO_RE =
  /^(?:Replying to|Membalas|返信先|回复|回覆|Respondiendo a|En respuesta a|Respondendo a|Em resposta a|En réponse à|Antwort an|В ответ)|님에게 보내는 답글|yanıt olarak/i;

function matchesExclude(el, excludeScope) {
  if (!el || !excludeScope) return false;
  if (typeof excludeScope === "function") return Boolean(excludeScope(el));
  if (typeof excludeScope.contains === "function") return excludeScope.contains(el);
  return false;
}

function isComposerMediaAttachment(el) {
  if (!el || typeof el.closest !== "function") return false;
  const attach = el.closest('[data-testid="attachments"]');
  if (!attach) return false;
  // A quoted post inside a Quote Modal has User-Name / tweetText / quoteTweet; a user's draft upload has a Remove button
  if (attach.querySelector('[data-testid="User-Name"], [data-testid="tweetText"], [data-testid="quoteTweet"]')) {
    return false;
  }
  if (
    attach.querySelector(
      '[data-testid="removeMediaButton"], button[aria-label*="Remove"], button[aria-label*="Hapus"], button[aria-label*="削除"], button[aria-label*="移除"], button[aria-label*="제거"]'
    )
  ) {
    return true;
  }
  return Boolean(attach.querySelector('img[src^="blob:"]'));
}

function findComposerScope(replyBox, scopeRoot) {
  const innerWrap =
    replyBox?.closest?.(
      '[data-testid="tweetTextarea_0RichTextInputContainer"], [data-testid^="tweetTextarea"], .DraftEditor-root'
    ) || replyBox;
  if (!replyBox) return innerWrap;
  // Climb to composer wrapper containing the editor + submit button + draft media previews,
  // stopping before the dialog or any post <article> / [data-testid="tweetText"]
  let node = innerWrap?.parentElement || replyBox.parentElement;
  let best = innerWrap;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    if (
      node === scopeRoot ||
      node.tagName === "BODY" ||
      node.tagName === "HTML" ||
      node.tagName === "MAIN" ||
      node.tagName === "ARTICLE" ||
      node.getAttribute?.("role") === "dialog" ||
      node.getAttribute?.("data-testid") === "primaryColumn"
    ) {
      break;
    }
    if (node.querySelector?.('article, [data-testid="tweetText"], [data-testid="User-Name"]')) {
      break;
    }
    best = node;
    if (node.querySelector?.('[data-testid^="tweetButton"]')) {
      break;
    }
  }
  return best || innerWrap;
}

function parseUserBlock(root, excludeScope) {
  if (!root) return { name: "", handle: "" };
  const userNodes = [...root.querySelectorAll('[data-testid="User-Name"]')];
  const userEl = userNodes.find((el) => !matchesExclude(el, excludeScope));
  if (userEl) {
    const raw = cleanText(userEl.innerText || userEl.textContent || "");
    const handleMatch = raw.match(/@([A-Za-z0-9_]{1,15})/);
    const handle = handleMatch ? "@" + handleMatch[1] : "";
    const name = raw
      .replace(/@([A-Za-z0-9_]+).*$/, "")
      .replace(/[·•].*$/, "")
      .trim();
    if (name || handle) return { name, handle };
  }

  // Fallback for redesigned X DOM where data-testid="User-Name" may be absent
  const links = root.querySelectorAll('a[href^="/"]');
  for (const a of links) {
    if (matchesExclude(a, excludeScope)) continue;
    if (a.closest?.('[data-testid^="card"], [role="group"], nav, [data-testid="tweetText"]')) continue;
    const t = cleanText(a.textContent || "");
    if (/^@[A-Za-z0-9_]{1,15}$/.test(t)) {
      const parentText = cleanText(a.parentElement?.parentElement?.textContent || "");
      const namePart = parentText
        .replace(t, "")
        .replace(/[·•].*$/, "")
        .trim()
        .slice(0, 50);
      return { name: namePart, handle: t };
    }
  }
  return { name: "", handle: "" };
}

const FALLBACK_BODY_EXCLUDE_SELECTOR = [
  '[data-testid="User-Name"]',
  '[data-testid^="Tweet-User-Avatar"]',
  '[data-testid="UserAvatar-Container"]',
  '[data-testid^="card"]',
  '[data-testid="cardPoll"]',
  '[data-testid="birdwatch-pivot"]',
  '[data-testid="birdwatch-note"]',
  '[data-testid="sidebarColumn"]',
  '[role="group"]',
  "nav",
  "header",
  "footer",
  "aside",
  "button",
  '[role="button"]',
  "time",
  "svg",
  "script",
  "style",
  ".x-ai-reply-group",
  ".x-ai-toast-host",
].join(", ");

function isNonBodyUiLine(text, authorName = "", authorHandle = "") {
  const v = cleanText(text);
  if (!v) return true;
  const minLen = NON_LATIN_SCRIPT_RE.test(v) ? 2 : 4;
  if (v.length < minLen) return true;

  const low = v.toLowerCase();
  const cleanAuthorName = cleanText(authorName).toLowerCase();
  const cleanAuthorHandle = cleanText(authorHandle).toLowerCase();
  if (cleanAuthorName && low === cleanAuthorName) return true;
  if (cleanAuthorHandle && low === cleanAuthorHandle) return true;
  if (cleanAuthorName && cleanAuthorHandle && low === `${cleanAuthorName} ${cleanAuthorHandle}`) {
    return true;
  }

  if (
    /^(replying to|membalas|post your reply|what.?s happening|reply|post|quote|drafts|relevant|most relevant|most recent|most liked|everyone can reply|who can reply\??|promoted|ad|balas|posting|kutip|返信|ポスト|回复|回覆|답글|게시|responder|répondre|antworten)$/i.test(
      v
    )
  ) {
    return true;
  }
  if (REPLYING_TO_RE.test(v) && v.length < 160) return true;
  if (
    /^(show more|show less|show this thread|translate post|show original|translated from\b.*|translated by\b.*|auto-translated\b.*|view|views|reposts|quotes|likes|bookmarks|follow|following|subscribe|tampilkan lebih banyak|terjemahkan postingan|tampilkan yang asli|さらに表示|ポストを翻訳|原文を表示|显示更多|翻译帖子|더 보기|게시물 번역하기)$/i.test(
      v
    )
  ) {
    return true;
  }
  // Pure counts / engagement metrics (e.g. "21", "106", "2,789 Views", "1.2K")
  if (/^[\d.,]+[KMBkmb]?(\s+(views?|reposts?|quotes?|likes?|bookmarks?))?$/i.test(v)) return true;
  // Standalone timestamp lines (e.g. "5:43 PM · Nov 21, 2026 · 2,789 Views", "Nov 21", "2h")
  if (
    /^\d{1,2}:\d{2}\s*(?:AM|PM)\s*[·•]/i.test(v) ||
    /^[·•]?\s*\d+\s*[smhd]$/i.test(v) ||
    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?$/i.test(v)
  ) {
    return true;
  }
  // Bare @handle alone (not a sentence)
  if (/^@[A-Za-z0-9_]{1,15}$/.test(v)) return true;
  return false;
}

function isExcludedSubtree(el, excludeScope) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
  if (matchesExclude(el, excludeScope)) return true;
  return Boolean(el.closest?.(FALLBACK_BODY_EXCLUDE_SELECTOR));
}

function dedupeParagraphLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = cleanText(raw);
    if (!line) continue;
    if (out.some((existing) => existing === line || existing.includes(line))) continue;
    // If the new line supersedes a shorter fragment already collected, replace it
    const filtered = out.filter((existing) => !line.includes(existing));
    filtered.push(line);
    out.length = 0;
    out.push(...filtered);
  }
  return out;
}

// Resilient post body extractor that works even if X removes/renames data-testid="tweetText"
function extractFallbackBodyText(root, excludeScope, authorInfo = {}) {
  if (!root || typeof root.querySelectorAll !== "function") return { text: "", lang: "" };
  const authorName = authorInfo.name || "";
  const authorHandle = authorInfo.handle || "";

  const isInsideComposer = (el) =>
    Boolean(
      el.closest?.(
        '[contenteditable="true"], [contenteditable="plaintext-only"], [data-testid^="tweetTextarea"], .DraftEditor-root'
      )
    );

  // Strategy A: semantic text blocks (div[dir="auto"], p[dir="auto"], div[lang], p)
  const blockCandidates = [
    ...root.querySelectorAll('div[dir="auto"], p[dir="auto"], div[lang], p'),
  ].filter((el) => {
    if (isExcludedSubtree(el, excludeScope) || isInsideComposer(el)) return false;
    if (el.tagName === "HTML" || el.tagName === "BODY") return false;
    return true;
  });

  // Keep leaf blocks so parent wrappers don't duplicate child paragraphs
  const leafBlocks = blockCandidates.filter(
    (el) => !blockCandidates.some((other) => other !== el && el.contains(other))
  );

  let detectedLang = "";
  const paragraphs = [];
  for (const el of leafBlocks) {
    const t = extractNodeTextWithEmojis(el);
    if (isNonBodyUiLine(t, authorName, authorHandle)) continue;
    paragraphs.push(t);
    if (!detectedLang) {
      const l = String(el.getAttribute("lang") || "").trim().toLowerCase();
      if (l && !/^(und|zxx|qme|qht|qct|qam|art)$/.test(l)) {
        detectedLang = l;
      }
    }
  }

  const dedupedA = dedupeParagraphLines(paragraphs);
  if (dedupedA.length > 0) {
    return { text: dedupedA.join("\n"), lang: detectedLang };
  }

  // Strategy B: structural DOM walk skipping UI chrome (handles X layouts without dir="auto" or lang)
  const walkPieces = [];
  const walkClean = (node) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const val = cleanText(node.textContent || "");
      if (val) walkPieces.push(val);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (isExcludedSubtree(node, excludeScope) || isInsideComposer(node)) return;
    if (node.tagName === "IMG" && node.alt) {
      walkPieces.push(node.alt);
      return;
    }
    if (node.tagName === "BR") {
      walkPieces.push("\n");
      return;
    }
    const isBlock = BLOCK_TAGS.has(node.tagName);
    if (isBlock) walkPieces.push("\n");
    for (const child of node.childNodes) {
      walkClean(child);
    }
    if (isBlock) walkPieces.push("\n");
  };
  walkClean(root);

  const rawLines = walkPieces
    .join(" ")
    .split(/\n+/)
    .map((s) => cleanText(s))
    .filter((s) => !isNonBodyUiLine(s, authorName, authorHandle));

  const dedupedB = dedupeParagraphLines(rawLines);
  return { text: dedupedB.join("\n"), lang: detectedLang };
}

function findQuoteContainer(article, excludeScope = null) {
  if (!article) return null;
  const explicits = article.querySelectorAll('[data-testid="quoteTweet"]');
  for (const explicit of explicits) {
    if (!matchesExclude(explicit, excludeScope)) return explicit;
  }

  const roleLinks = article.querySelectorAll('div[role="link"]');
  for (const link of roleLinks) {
    if (link === article) continue;
    if (matchesExclude(link, excludeScope)) continue;
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
  const polls = root.querySelectorAll('[data-testid="cardPoll"]');
  let poll = null;
  for (const p of polls) {
    if (!matchesExclude(p, excludeScope)) {
      poll = p;
      break;
    }
  }
  if (!poll) return "";

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
  const titleEl = [...root.querySelectorAll('[data-testid="twitter-article-title"]')].find(
    (el) => !matchesExclude(el, excludeScope)
  );
  const bodyEl = [
    ...root.querySelectorAll(
      '[data-testid="twitterArticleRichTextView"], [data-testid="twitterArticleReadView"], [data-testid="longformRichTextComponent"]'
    ),
  ].find((el) => !matchesExclude(el, excludeScope));
  const title = titleEl ? truncateAtWord(extractNodeTextWithEmojis(titleEl), 160) : "";
  const body = bodyEl ? truncateAtWord(extractNodeTextWithEmojis(bodyEl), 900) : "";
  return { title, body };
}

function extractCardDomain(card) {
  if (!card || typeof card.querySelectorAll !== "function") return "";
  const links = card.querySelectorAll('a[href^="http"]');
  for (const a of links) {
    try {
      const u = new URL(a.getAttribute("href") || "");
      const host = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (host && !/^(x\.com|twitter\.com|t\.co|mobile\.twitter\.com)$/.test(host)) {
        return host;
      }
    } catch (e) {}
  }
  return "";
}

function extractCardSummary(root, excludeScope) {
  const cards = root.querySelectorAll(
    '[data-testid="card.layoutLarge.detail"], [data-testid="card.layoutSmall.detail"], [data-testid="card.wrapper"], [data-testid^="card"]'
  );
  for (const card of cards) {
    if (card.getAttribute("data-testid") === "cardPoll") continue;
    if (matchesExclude(card, excludeScope)) continue;
    const cardText = extractNodeTextWithEmojis(card);
    if (cardText && cardText.length > 8) {
      const domain = extractCardDomain(card);
      const prefixed =
        domain && !cardText.toLowerCase().includes(domain)
          ? `[${domain}] ${cardText}`
          : cardText;
      return truncateAtWord(prefixed, 360);
    }
  }
  return "";
}

function extractCommunityNote(root, excludeScope) {
  if (!root || typeof root.querySelectorAll !== "function") return "";
  const notes = root.querySelectorAll('[data-testid="birdwatch-pivot"], [data-testid="birdwatch-note"]');
  for (const note of notes) {
    if (matchesExclude(note, excludeScope)) continue;
    const text = extractNodeTextWithEmojis(note)
      .replace(
        /^(?:Readers added context(?: they thought people might want to know)?|Pembaca menambahkan konteks(?: yang mungkin ingin diketahui orang lain)?|読者が背景情報を追加しました|读者添加了背景信息)\s*/i,
        ""
      )
      .replace(/\s*(?:Rate it|Is this helpful\??|Context is written by people who use X).*$/i, "")
      .trim();
    if (text && text.length > 12) {
      return truncateAtWord(text, 360);
    }
  }
  return "";
}

function extractImageAlt(root, excludeScope) {
  const imgs = root.querySelectorAll('img[alt]:not([alt=""])');
  const alts = [];
  for (const img of imgs) {
    if (matchesExclude(img, excludeScope) || isComposerMediaAttachment(img)) continue;
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
    if (u.hostname.includes("twimg.com")) {
      // Request sharp resolution ("large") so small chart numbers and screenshot text stay legible for Vision
      const currentName = (u.searchParams.get("name") || "").toLowerCase();
      if (u.searchParams.has("name") && currentName !== "orig" && currentName !== "4096x4096") {
        u.searchParams.set("name", "large");
      }
      // Convert webp to jpg on X media CDN for universal Vision API compatibility
      if ((u.searchParams.get("format") || "").toLowerCase() === "webp") {
        u.searchParams.set("format", "jpg");
      }
    }
    return u.toString();
  } catch (e) {
    return src;
  }
}

function isMediaUrlAllowed(rawSrc) {
  const low = String(rawSrc || "").toLowerCase();
  if (!low || !/^https?:\/\//.test(low)) return false;
  if (
    low.includes("profile_images") ||
    low.includes("profile_banners") ||
    low.includes("twemoji") ||
    low.includes("/emoji/") ||
    low.includes("hashflags")
  ) {
    return false;
  }
  return true;
}

// Extract attached media URLs (up to 4 images: charts, screenshots, cards, CSS background-image, video poster)
function extractImageUrls(root, excludeScope, maxCount = 4) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const urls = [];
  const isExcluded = (el) => {
    if (!el) return true;
    if (matchesExclude(el, excludeScope)) return true;
    if (isComposerMediaAttachment(el)) return true;
    if (el.closest?.('[data-testid^="Tweet-User-Avatar"], [data-testid="UserAvatar-Container"]')) {
      return true;
    }
    return false;
  };
  const pushUrl = (raw) => {
    if (urls.length >= maxCount) return;
    if (!isMediaUrlAllowed(raw)) return;
    const normalized = normalizeXMediaUrl(raw);
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };

  // 1. Standard <img> tags inside tweet photos, cards, video players, or any twimg media URL
  const imgs = root.querySelectorAll(
    '[data-testid="tweetPhoto"] img, [data-testid^="card"] img, [data-testid="videoPlayer"] img, img[src*="pbs.twimg.com/media/"], img[src*="pbs.twimg.com/card_img/"], img[src*="pbs.twimg.com/ext_tw_video_thumb/"], img[src*="pbs.twimg.com/amplify_video_thumb/"]'
  );
  for (const img of imgs) {
    if (urls.length >= maxCount) break;
    if (isExcluded(img)) continue;
    pushUrl(img.currentSrc || img.getAttribute("src") || "");
  }

  // 2. CSS background-image elements (X often renders photo grids & cards via inline background-image)
  if (urls.length < maxCount) {
    const bgNodes = root.querySelectorAll(
      '[data-testid="tweetPhoto"] [style*="background-image"], [data-testid^="card"] [style*="background-image"], [style*="pbs.twimg.com/media/"]'
    );
    for (const el of bgNodes) {
      if (urls.length >= maxCount) break;
      if (isExcluded(el)) continue;
      const styleVal = el.getAttribute("style") || "";
      const m = styleVal.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
      if (m && m[1]) pushUrl(m[1]);
    }
  }

  // 3. Video poster frame fallback
  if (urls.length === 0) {
    const videos = root.querySelectorAll("video[poster]");
    for (const vid of videos) {
      if (isExcluded(vid)) continue;
      pushUrl(vid.getAttribute("poster") || "");
      if (urls.length >= 1) break;
    }
  }

  return urls;
}

function detectMediaType(root, excludeScope, pollOptions, articleTitle) {
  if (pollOptions) return "Poll";
  if (articleTitle) return "X Longform Article";
  const videos = root.querySelectorAll('[data-testid="videoPlayer"], video');
  for (const video of videos) {
    if (!matchesExclude(video, excludeScope) && !isComposerMediaAttachment(video)) {
      return "Video Post";
    }
  }
  const photos = root.querySelectorAll('[data-testid="tweetPhoto"]');
  for (const photo of photos) {
    if (!matchesExclude(photo, excludeScope) && !isComposerMediaAttachment(photo)) {
      return "Image/Chart Post";
    }
  }
  return "";
}

function extractReplyTo(root, excludeScope = null) {
  if (!root || typeof root.querySelectorAll !== "function") return "";
  const walker = root.querySelectorAll("span, div");
  for (const el of walker) {
    if (matchesExclude(el, excludeScope)) continue;
    if (el.closest?.('[data-testid="tweetText"]')) continue;
    if (el.children.length > 6) continue;
    const t = cleanText(el.innerText || el.textContent || "");
    if (REPLYING_TO_RE.test(t) && t.length < 160 && /@[A-Za-z0-9_]{1,15}/.test(t)) {
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

  const readNodeLang = (node) => {
    if (!node || typeof node.getAttribute !== "function") return "";
    if (node.tagName === "HTML" || node.tagName === "BODY") return "";
    const direct = pickValid(node.getAttribute("lang"));
    if (direct) return direct;
    const childLang = node.querySelector?.("[lang]");
    if (childLang && childLang.tagName !== "HTML" && childLang.tagName !== "BODY") {
      const found = pickValid(childLang.getAttribute("lang"));
      if (found) return found;
    }
    return "";
  };

  const fromPrimary = readNodeLang(primaryNode);
  if (fromPrimary) return fromPrimary;

  if (root && typeof root.querySelectorAll === "function") {
    const candidates = root.querySelectorAll(
      '[data-testid="tweetText"][lang], [data-testid="tweetText"] [lang], [data-testid="twitterArticleRichTextView"][lang], [data-testid="longformRichTextComponent"][lang]'
    );
    for (const el of candidates) {
      if (matchesExclude(el, excludeScope)) continue;
      if (el.tagName === "HTML" || el.tagName === "BODY") continue;
      const found = pickValid(el.getAttribute("lang"));
      if (found) return found;
    }
  }
  return "";
}

const TRANSLATED_LANG_NAME_MAP = {
  japanese: "ja",
  jepang: "ja",
  "日本語": "ja",
  chinese: "zh-cn",
  "simplified chinese": "zh-cn",
  "traditional chinese": "zh-tw",
  mandarin: "zh-cn",
  tionghoa: "zh-cn",
  cina: "zh-cn",
  "中国語": "zh-cn",
  korean: "ko",
  korea: "ko",
  "韓国語": "ko",
  indonesian: "id",
  indonesia: "id",
  "インドネシア語": "id",
  english: "en",
  inggris: "en",
  "英語": "en",
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

function extractTranslationInfo(root, excludeScope) {
  const result = { translatedFromLang: "", isAutoTranslated: false };
  if (!root || typeof root.querySelectorAll !== "function") return result;
  const nodes = root.querySelectorAll("span, div, button");
  for (const el of nodes) {
    if (matchesExclude(el, excludeScope)) continue;
    // Never mistake phrases inside the post body itself ("Show original", "Translated from Japanese") for X's UI banner
    if (
      el.closest?.(
        '[data-testid="tweetText"], [data-testid="User-Name"], [data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]'
      )
    ) {
      continue;
    }
    if (el.children && el.children.length > 4) continue;
    const t = cleanText(el.textContent || "");
    if (!t || t.length > 100) continue;

    if (
      /\b(Show original|Translated by|Auto-translated|Tampilkan yang asli|Diterjemahkan oleh|原文を表示|により翻訳)\b/i.test(
        t
      )
    ) {
      result.isAutoTranslated = true;
    }

    const m =
      t.match(/\bTranslated from\s+([A-Za-z\s()-]+?)(?:\s+by\b|$)/i) ||
      t.match(/\bDiterjemahkan dari(?:\s+bahasa)?\s+([A-Za-z\s()-]+?)(?:\s+oleh\b|$)/i) ||
      t.match(/([^\s]+?)から翻訳/);
    if (m && m[1]) {
      result.isAutoTranslated = true;
      const key = m[1].replace(/[()]/g, "").trim().toLowerCase();
      if (TRANSLATED_LANG_NAME_MAP[key]) {
        result.translatedFromLang = TRANSLATED_LANG_NAME_MAP[key];
        return result;
      }
      const firstWord = key.split(/\s+/)[0];
      if (TRANSLATED_LANG_NAME_MAP[firstWord]) {
        result.translatedFromLang = TRANSLATED_LANG_NAME_MAP[firstWord];
        return result;
      }
    }
  }
  return result;
}

const NON_LATIN_SCRIPT_RE =
  /[\u3040-\u30ff\uff66-\uff9f\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\u4e00-\u9fff\u3400-\u4dbf\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\u0900-\u097f]/;

function pickPrimaryTweetTextNode(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // If X renders both original text and an inline translation block, prefer the original (non-Latin or explicit non-en lang)
  const withNonLatin = candidates.find((n) => NON_LATIN_SCRIPT_RE.test(extractNodeTextWithEmojis(n)));
  if (withNonLatin) return withNonLatin;
  const withForeignLang = candidates.find((n) => {
    const l = String(n.getAttribute?.("lang") || "").trim().toLowerCase();
    return l && l !== "en" && !/^(und|zxx|qme|qht|qct|qam|art)$/.test(l);
  });
  return withForeignLang || candidates[0];
}

function extractPostTimestamp(root, excludeScope) {
  if (!root || typeof root.querySelectorAll !== "function") return "";
  const times = root.querySelectorAll("time");
  for (const t of times) {
    if (matchesExclude(t, excludeScope)) continue;
    const label = cleanText(t.textContent || t.getAttribute("datetime") || "");
    if (label) return label.slice(0, 48);
  }
  return "";
}

function extractDataFromArticle(article, extraExcludeScope = null) {
  if (!article) return null;

  const quoteRoot = findQuoteContainer(article, extraExcludeScope);
  const excludeMain = extraExcludeScope
    ? (el) => Boolean((quoteRoot && quoteRoot.contains(el)) || matchesExclude(el, extraExcludeScope))
    : quoteRoot;

  const { name, handle } = parseUserBlock(article, excludeMain);
  const textNodes = [...article.querySelectorAll('[data-testid="tweetText"]')].filter(
    (n) => !isExcludedSubtree(n, excludeMain)
  );
  const mainTextNode = pickPrimaryTweetTextNode(textNodes);

  let tweetText = extractNodeTextWithEmojis(mainTextNode);
  const longform = extractArticleLongform(article, excludeMain);
  if (!tweetText && longform.body) {
    tweetText = longform.body;
  } else if (tweetText && longform.body && longform.body.length > tweetText.length + 30) {
    tweetText = longform.body;
  }

  let tweetLang = extractDomLang(mainTextNode, article, excludeMain);

  // Fallback for redesigned X DOM where data-testid="tweetText" may be renamed or omitted
  if (!tweetText) {
    const fallbackBody = extractFallbackBodyText(article, excludeMain, { name, handle });
    if (fallbackBody.text) {
      tweetText = fallbackBody.text;
      if (!tweetLang && fallbackBody.lang) tweetLang = fallbackBody.lang;
    }
  }

  const { translatedFromLang, isAutoTranslated } = extractTranslationInfo(article, excludeMain);
  const pollOptions = extractPollOptions(article, excludeMain);
  const cardSummary = extractCardSummary(article, excludeMain);
  const communityNote = extractCommunityNote(article, excludeMain);
  const imageAlt = extractImageAlt(article, excludeMain);
  const mainImageUrls = extractImageUrls(article, excludeMain, 4);
  const imageUrls = [...mainImageUrls];
  const mainImageCount = mainImageUrls.length;
  const mediaType = detectMediaType(article, excludeMain, pollOptions, longform.title);
  const timestamp = extractPostTimestamp(article, excludeMain);

  let quotedText = "";
  let quotedLang = "";
  if (quoteRoot) {
    const qUser = parseUserBlock(quoteRoot, extraExcludeScope);
    const qTextNode = quoteRoot.querySelector('[data-testid="tweetText"]');
    quotedLang = extractDomLang(qTextNode, quoteRoot, extraExcludeScope);
    let qBody = extractNodeTextWithEmojis(qTextNode);
    if (!qBody) {
      const qFallback = extractFallbackBodyText(quoteRoot, extraExcludeScope, qUser);
      qBody = qFallback.text;
      if (!quotedLang && qFallback.lang) quotedLang = qFallback.lang;
    }
    qBody =
      qBody ||
      extractCardSummary(quoteRoot, extraExcludeScope) ||
      extractImageAlt(quoteRoot, extraExcludeScope);
    if (qBody && qBody !== tweetText && qBody.length > 2) {
      const qPrefix =
        qUser.name || qUser.handle
          ? `${[qUser.name, qUser.handle ? `(${qUser.handle})` : ""].filter(Boolean).join(" ")}: `
          : "";
      quotedText = truncateAtWord(qPrefix + qBody, 520);
    }
    // Also attach quote-tweet images (up to 4 total) so Vision understands quoted charts/memes too
    if (imageUrls.length < 4) {
      const quoteImgs = extractImageUrls(quoteRoot, extraExcludeScope, 4 - imageUrls.length);
      for (const u of quoteImgs) {
        if (!imageUrls.includes(u) && imageUrls.length < 4) {
          imageUrls.push(u);
        }
      }
    }
  }

  const replyTo = extractReplyTo(article, excludeMain);
  const showMoreLink = [...article.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].find(
    (el) => !matchesExclude(el, excludeMain)
  );
  const isTruncated = Boolean(showMoreLink);

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
    tweetText: truncateAtWord(tweetText, 1400),
    tweetLang,
    translatedFromLang,
    isAutoTranslated,
    isTruncated,
    timestamp,
    articleTitle: longform.title,
    pollOptions,
    quotedText,
    quotedLang,
    cardSummary,
    communityNote,
    imageAlt,
    imageUrls,
    mainImageCount,
    mediaType,
    replyTo,
    composerMode: "reply",
    parentContext: "",
    selfThreadContinuation: "",
    topReplies: "",
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
    summaries.push(`${who}: ${truncateAtWord(body, 320)}`);
  }
  return summaries.join("\n");
}

function buildSelfThreadContinuation(articlesAfterFocal, authorHandle) {
  const cleanHandle = String(authorHandle || "").trim().toLowerCase();
  if (!cleanHandle || !Array.isArray(articlesAfterFocal) || articlesAfterFocal.length === 0) {
    return { text: "", consumedCount: 0 };
  }
  const parts = [];
  let consumedCount = 0;
  for (const art of articlesAfterFocal.slice(0, 3)) {
    const user = parseUserBlock(art, findQuoteContainer(art));
    if (!user.handle || user.handle.toLowerCase() !== cleanHandle) break;
    const data = extractDataFromArticle(art);
    if (!data || !data.tweetText) break;
    parts.push(truncateAtWord(data.tweetText, 320));
    consumedCount += 1;
    if (parts.length >= 2) break;
  }
  return { text: parts.join("\n"), consumedCount };
}

function buildTopRepliesSummary(articlesAfterFocal, authorHandle, skipCount = 0) {
  if (!Array.isArray(articlesAfterFocal) || articlesAfterFocal.length <= skipCount) return "";
  const cleanAuthor = String(authorHandle || "").trim().toLowerCase();
  const replies = [];
  const seenHandles = new Set();

  for (const art of articlesAfterFocal.slice(skipCount, skipCount + 8)) {
    if (!art || art.querySelector?.('[data-testid="placementTracking"]')) continue;
    const data = extractDataFromArticle(art);
    if (!data || !data.tweetText) continue;
    const h = String(data.handle || "").trim().toLowerCase();
    if (cleanAuthor && h === cleanAuthor) continue;
    if (h && seenHandles.has(h)) continue;
    const cleanBody = cleanText(data.tweetText);
    if (cleanBody.length < 6) continue;
    if (h) seenHandles.add(h);
    const who = data.handle || data.name || "User";
    replies.push(`${who}: ${truncateAtWord(cleanBody, 140)}`);
    if (replies.length >= 3) break;
  }
  return replies.join("\n");
}

function detectComposerMode(replyBox, dialog, composerReplyTo) {
  if (!dialog) return "reply";
  if (composerReplyTo) return "reply";
  const boxRect = replyBox?.getBoundingClientRect?.();
  const quoteAttachment =
    dialog.querySelector('[data-testid="attachments"] [data-testid="tweetText"]') ||
    dialog.querySelector('[data-testid="quoteTweet"]');
  if (quoteAttachment && boxRect) {
    const qRect = quoteAttachment.getBoundingClientRect?.();
    if (qRect && qRect.top >= boxRect.bottom - 24) {
      return "quote";
    }
  }
  const submitBtn = dialog.querySelector('[data-testid="tweetButton"]');
  const submitLabel = cleanText(submitBtn?.textContent || submitBtn?.getAttribute?.("aria-label") || "");
  if (/^(post|posting|ポスト|发帖|게시하기)$/i.test(submitLabel)) {
    return "quote";
  }
  return "reply";
}

function extractComposerReplyTo(replyBox) {
  const directScope =
    replyBox.closest('[role="dialog"], dialog[open]') ||
    replyBox.closest('[data-testid="cellInnerDiv"]');
  if (directScope) {
    const found = extractReplyTo(directScope);
    if (found) return found;
  }
  let node = replyBox.parentElement;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    if (
      node.tagName === "MAIN" ||
      node.tagName === "BODY" ||
      node.getAttribute?.("data-testid") === "primaryColumn"
    ) {
      break;
    }
    const found = extractReplyTo(node);
    if (found) return found;
  }
  return "";
}

function extractContextFromDialogNonArticle(dialog, replyBox) {
  const composerWrap = findComposerScope(replyBox, dialog);

  const quoteRoot = findQuoteContainer(dialog, composerWrap);
  const excludeForMain = (el) =>
    Boolean(matchesExclude(el, composerWrap) || (quoteRoot && quoteRoot.contains(el)));

  const { name, handle } = parseUserBlock(dialog, excludeForMain);
  const mainCandidates = [...dialog.querySelectorAll('[data-testid="tweetText"]')].filter(
    (el) => !excludeForMain(el)
  );
  const targetTextEl = pickPrimaryTweetTextNode(mainCandidates);

  // Only fall back to quote/attachment scope if no primary tweetText exists in the dialog
  const fallbackScope =
    dialog.querySelector('[data-testid="attachments"]') || quoteRoot || dialog;
  const effectiveTextEl =
    targetTextEl ||
    pickPrimaryTweetTextNode(
      [...fallbackScope.querySelectorAll('[data-testid="tweetText"]')].filter(
        (el) => !matchesExclude(el, composerWrap)
      )
    );

  let tweetText = extractNodeTextWithEmojis(effectiveTextEl);
  let tweetLang = extractDomLang(effectiveTextEl, dialog, excludeForMain);

  if (!tweetText) {
    const fb = extractFallbackBodyText(dialog, excludeForMain, { name, handle });
    if (fb.text) {
      tweetText = fb.text;
      if (!tweetLang && fb.lang) tweetLang = fb.lang;
    }
  }

  const { translatedFromLang, isAutoTranslated } = extractTranslationInfo(dialog, excludeForMain);
  const pollOptions = extractPollOptions(dialog, excludeForMain);
  const cardSummary = extractCardSummary(dialog, excludeForMain);
  const communityNote = extractCommunityNote(dialog, excludeForMain);
  const imageAlt = extractImageAlt(dialog, excludeForMain);
  const mainImageUrls = extractImageUrls(dialog, excludeForMain, 4);
  const imageUrls = [...mainImageUrls];
  const mainImageCount = mainImageUrls.length;
  const timestamp = extractPostTimestamp(dialog, excludeForMain);
  const showMoreLink = [...dialog.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].find(
    (el) => !excludeForMain(el)
  );

  let quotedText = "";
  let quotedLang = "";
  if (quoteRoot && effectiveTextEl && !quoteRoot.contains(effectiveTextEl)) {
    const qTextNode = quoteRoot.querySelector('[data-testid="tweetText"]');
    quotedLang = extractDomLang(qTextNode, quoteRoot, composerWrap);
    const qBody =
      extractNodeTextWithEmojis(qTextNode) ||
      extractCardSummary(quoteRoot, composerWrap) ||
      extractImageAlt(quoteRoot, composerWrap);
    if (qBody && qBody !== tweetText && qBody.length > 1) {
      const qUser = parseUserBlock(quoteRoot, composerWrap);
      const qPrefix =
        qUser.name || qUser.handle
          ? `${[qUser.name, qUser.handle ? `(${qUser.handle})` : ""].filter(Boolean).join(" ")}: `
          : "";
      quotedText = truncateAtWord(qPrefix + qBody, 520);
    }
    if (imageUrls.length < 4) {
      const quoteImgs = extractImageUrls(quoteRoot, composerWrap, 4 - imageUrls.length);
      for (const u of quoteImgs) {
        if (!imageUrls.includes(u) && imageUrls.length < 4) {
          imageUrls.push(u);
        }
      }
    }
  }

  if (
    !tweetText &&
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
    tweetText: truncateAtWord(tweetText, 1400),
    tweetLang,
    translatedFromLang,
    isAutoTranslated,
    isTruncated: Boolean(showMoreLink),
    timestamp,
    articleTitle: "",
    pollOptions,
    quotedText,
    quotedLang,
    cardSummary,
    communityNote,
    imageAlt,
    imageUrls,
    mainImageCount,
    mediaType: detectMediaType(dialog, excludeForMain, pollOptions, ""),
    replyTo: extractReplyTo(dialog, excludeForMain),
    composerMode: detectComposerMode(replyBox, dialog, extractReplyTo(dialog, excludeForMain)),
    parentContext: "",
    selfThreadContinuation: "",
    topReplies: "",
  };
}

function looksLikePostBody(text) {
  const value = cleanText(text);
  const minLen = NON_LATIN_SCRIPT_RE.test(value) ? 2 : 8;
  if (value.length < minLen || value.length > 1200) return false;
  if (
    /^(replying to|membalas|post your reply|what.?s happening|reply|post|quote|drafts|everyone can reply|who can reply\??)$/i.test(
      value
    )
  ) {
    return false;
  }
  if (
    /^(show more|show less|show this thread|translate post|show original|translated from\b.*|translated by\b.*|view|views|reposts|quotes|likes|bookmarks|follow|following|subscribe)$/i.test(
      value
    )
  ) {
    return false;
  }
  if (/^\d+(?:[.,]\d+)?[KMBkmb]?$/.test(value)) return false;
  return true;
}

function isInsideReplyingToBanner(el) {
  let node = el;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    if (node.tagName === "ARTICLE" || node.tagName === "MAIN" || node.tagName === "BODY") break;
    if (node.children && node.children.length > 8) break;
    const t = cleanText(node.textContent || "");
    if (t.length > 0 && t.length < 180 && REPLYING_TO_RE.test(t)) {
      return true;
    }
  }
  return false;
}

function findPostContainerByReplyHandle(replyBox, composerReplyTo, scope) {
  const handleMatch = String(composerReplyTo || "").match(/@([A-Za-z0-9_]{1,15})/);
  if (!handleMatch) return null;
  const targetHandle = `@${handleMatch[1].toLowerCase()}`;
  const anchorRect = replyBox.getBoundingClientRect();
  const root = scope || document.querySelector('[data-testid="primaryColumn"], main') || document;
  const composerWrap = findComposerScope(replyBox, root);

  const candidates = root.querySelectorAll('a[href^="/"], span');
  let bestHandleNode = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (
      el.closest?.(
        '.x-ai-reply-group, .x-ai-toast-host, [data-testid="sidebarColumn"], aside, nav, [data-testid="tweetText"]'
      )
    ) {
      continue;
    }
    if (replyBox.contains(el) || matchesExclude(el, composerWrap)) continue;
    const t = cleanText(el.textContent || "").toLowerCase();
    if (t !== targetHandle) continue;
    // Never lock onto the "Replying to @author" label sitting directly above the composer
    if (isInsideReplyingToBanner(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const dist = anchorRect.top - rect.bottom;
    if (dist < 10 || dist > 1600) continue;
    // Prefer actual author header blocks ([data-testid="User-Name"]) over stray handle links
    const inUserHeader = Boolean(el.closest?.('[data-testid="User-Name"]'));
    const score = inUserHeader ? dist - 250 : dist;
    if (score < bestScore) {
      bestScore = score;
      bestHandleNode = el;
    }
  }

  if (!bestHandleNode) return null;

  // Climb from the author handle to the post wrapper (supports both separate and shared-wrapper X layouts)
  let container = bestHandleNode.parentElement;
  let bestContainer = null;
  let sharedParent = null;

  for (let depth = 0; container && depth < 10; depth += 1, container = container.parentElement) {
    const tag = container.tagName;
    if (
      tag === "BODY" ||
      tag === "HTML" ||
      tag === "MAIN" ||
      tag === "SECTION" ||
      container.getAttribute?.("data-testid") === "primaryColumn"
    ) {
      break;
    }
    if (container.contains(replyBox)) {
      sharedParent = container;
      break;
    }
    const textLen = cleanText(container.textContent || "").length;
    if (textLen > targetHandle.length + 12) {
      bestContainer = container;
    }
    if (
      tag === "ARTICLE" ||
      container.getAttribute?.("data-testid") === "tweet" ||
      container.getAttribute?.("data-testid") === "cellInnerDiv"
    ) {
      return { node: container, excludeFn: null };
    }
  }

  if (bestContainer) {
    const checkBody = extractFallbackBodyText(bestContainer, composerWrap, { handle: targetHandle });
    const checkImgs = extractImageUrls(bestContainer, composerWrap, 1);
    if (checkBody.text || checkImgs.length > 0) {
      return { node: bestContainer, excludeFn: null };
    }
  }

  // If the post body lives alongside the reply box in a shared wrapper, extract everything strictly above replyBox
  if (sharedParent) {
    const excludeComposerAndBelow = (el) => {
      if (!el) return true;
      if (composerWrap && composerWrap.contains(el)) return true;
      const r = el.getBoundingClientRect?.();
      return Boolean(r && r.top >= anchorRect.top - 10);
    };
    return { node: sharedParent, excludeFn: excludeComposerAndBelow };
  }

  return bestContainer ? { node: bestContainer, excludeFn: null } : null;
}

function contextFromVisibleComposer(replyBox, composerReplyTo = "") {
  const anchor = replyBox?.__xAiAnchor && replyBox.__xAiAnchor.isConnected ? replyBox.__xAiAnchor : replyBox;
  if (!anchor) return null;
  const anchorRect = anchor.getBoundingClientRect();
  const panel =
    anchor.closest('[role="dialog"], dialog[open]') ||
    [...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')].find((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return rect.left <= anchorRect.right && rect.right >= anchorRect.left && rect.top <= anchorRect.bottom && rect.bottom >= anchorRect.top - 40;
    }) ||
    null;
  const primaryCol = !panel ? document.querySelector('[data-testid="primaryColumn"], main') : null;
  const scope = panel || primaryCol || document;
  const composerWrap = findComposerScope(replyBox, scope);

  // Strategy 1: Anchor directly to the post container matching "Replying to @author" above the composer
  const replyToStr = composerReplyTo || extractComposerReplyTo(replyBox);
  if (replyToStr) {
    const handleMatchObj = findPostContainerByReplyHandle(replyBox, replyToStr, scope);
    if (handleMatchObj && handleMatchObj.node) {
      const fromHandle = extractDataFromArticle(handleMatchObj.node, handleMatchObj.excludeFn);
      if (
        fromHandle &&
        (fromHandle.tweetText ||
          fromHandle.quotedText ||
          fromHandle.articleTitle ||
          (fromHandle.imageUrls && fromHandle.imageUrls.length > 0))
      ) {
        if (!fromHandle.replyTo) fromHandle.replyTo = replyToStr;
        return fromHandle;
      }
    }
  }

  // Strategy 2: Collect ALL valid paragraph blocks above the composer (no children.length <= 8 cap!)
  const blocks = queryDeep(
    scope,
    "[data-testid='tweetText'], div[dir='auto'], p[dir='auto'], div[lang], p"
  );
  const validBlocks = [];
  let replyTo = replyToStr;
  let name = "";
  let handle = "";

  for (const el of blocks) {
    if (!el || el.tagName === "HTML" || el.tagName === "BODY") continue;
    if (isExcludedSubtree(el, composerWrap)) continue;
    if (el.contains(replyBox)) continue;
    if (panel && !panel.contains(el)) continue;

    const text = extractNodeTextWithEmojis(el);
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 8) continue;

    const distAbove = anchorRect.top - rect.bottom;
    const distBelow = rect.top - anchorRect.bottom;
    let dist;
    if (panel) {
      if (distAbove >= -30 && distAbove <= 1400) dist = distAbove;
      else if (distBelow >= -30 && distBelow <= 700) dist = distBelow + 80;
      else continue;
    } else {
      if (rect.bottom > anchorRect.top + 30) continue;
      if (distAbove < -20 || distAbove > 1400) continue;
      dist = distAbove;
    }

    if (REPLYING_TO_RE.test(text) && text.length < 160) {
      replyTo = replyTo || text;
      handle = (text.match(/@[\w_]+/) || [handle])[0] || handle;
      continue;
    }
    if (isNonBodyUiLine(text, name, handle) || !looksLikePostBody(text)) continue;
    validBlocks.push({ el, text, dist, top: rect.top });
  }

  // Keep leaf blocks only so a wrapper div doesn't duplicate its child paragraphs
  const leafValid = validBlocks.filter(
    (item) => !validBlocks.some((other) => other.el !== item.el && item.el.contains(other.el))
  );

  // Sort top-to-bottom in reading order, and keep paragraphs belonging to the same post cluster
  leafValid.sort((a, b) => a.top - b.top);
  let chosenBlocks = leafValid;
  if (leafValid.length > 1) {
    // Take the bottom-most post cluster closest to the composer (split on large vertical gaps > 360px unless inside same article)
    const cluster = [leafValid[leafValid.length - 1]];
    for (let i = leafValid.length - 2; i >= 0; i--) {
      const curr = leafValid[i];
      const next = cluster[0];
      const sameArticle =
        curr.el.closest("article") && curr.el.closest("article") === next.el.closest("article");
      if (sameArticle || next.top - curr.top <= 360) {
        cluster.unshift(curr);
      } else {
        break;
      }
    }
    chosenBlocks = cluster;
  }

  const combinedText = dedupeParagraphLines(chosenBlocks.map((b) => b.text)).join("\n");
  const primaryEl = chosenBlocks[0]?.el || null;
  // Never scan the entire primaryColumn for images — stay tightly scoped to the target post or modal
  const postContainerScope =
    panel ||
    primaryEl?.closest?.('article, div[data-testid="tweet"], [data-testid="cellInnerDiv"]') ||
    primaryEl?.parentElement ||
    null;
  const excludeBelowComposer = (el) => {
    if (matchesExclude(el, composerWrap)) return true;
    if (!panel && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.top >= anchorRect.top + 20) return true;
      // When scanning a broader fallback scope, ignore images far above the target post
      if (!postContainerScope && anchorRect.top - r.bottom > 950) return true;
    }
    return false;
  };
  const transScope = postContainerScope;
  const imageAlt = transScope ? extractImageAlt(transScope, excludeBelowComposer) : "";
  const imageUrls = transScope ? extractImageUrls(transScope, excludeBelowComposer, 4) : [];

  // Never hallucinate from a bare "Replying to @user" string with no actual post text or media
  if (!combinedText && !imageAlt && imageUrls.length === 0) return null;

  // Never inherit <html lang="en"> or <body lang="en"> (browser/X UI language) as the post language!
  const rawLangNode = primaryEl?.closest?.("[lang]") || primaryEl?.querySelector?.("[lang]");
  const validLangNode =
    rawLangNode && rawLangNode.tagName !== "HTML" && rawLangNode.tagName !== "BODY"
      ? rawLangNode
      : null;
  const { translatedFromLang, isAutoTranslated } = transScope
    ? extractTranslationInfo(transScope, excludeBelowComposer)
    : { translatedFromLang: "", isAutoTranslated: false };

  return {
    name,
    handle: handle || (replyTo.match(/@[\w_]+/) || [""])[0],
    tweetText: truncateAtWord(combinedText, 1400),
    tweetLang: validLangNode?.getAttribute?.("lang") || "",
    translatedFromLang,
    isAutoTranslated,
    isTruncated: false,
    timestamp: transScope ? extractPostTimestamp(transScope, excludeBelowComposer) : "",
    articleTitle: "",
    pollOptions: "",
    quotedText: "",
    quotedLang: "",
    cardSummary: "",
    communityNote: transScope ? extractCommunityNote(transScope, excludeBelowComposer) : "",
    imageAlt,
    imageUrls,
    mainImageCount: imageUrls.length,
    mediaType: transScope ? detectMediaType(transScope, excludeBelowComposer, "", "") : "",
    replyTo,
    composerMode: detectComposerMode(replyBox, panel, replyTo),
    parentContext: "",
    selfThreadContinuation: "",
    topReplies: "",
  };
}

function enrichIfTextMissing(extracted, replyBox, composerReplyTo) {
  if (!extracted) return extracted;
  const missingText =
    !extracted.tweetText && !extracted.articleTitle && !extracted.quotedText && !extracted.pollOptions;
  const expectsMedia =
    extracted.mediaType === "Image/Chart Post" || extracted.mediaType === "Video Post";
  const missingExpectedImages =
    expectsMedia && (!Array.isArray(extracted.imageUrls) || extracted.imageUrls.length === 0);

  // Never scan surrounding timeline for images on a normal text-only post (prevents cross-tweet image pollution!)
  if (!missingText && !missingExpectedImages) {
    return extracted;
  }

  // Recover missing post text or sibling images if redesigned X DOM split them outside <article>
  const recovered = contextFromVisibleComposer(replyBox, composerReplyTo);
  if (!recovered) return extracted;

  const sameAuthor =
    !extracted.handle ||
    !recovered.handle ||
    extracted.handle.toLowerCase() === recovered.handle.toLowerCase();

  return {
    ...extracted,
    tweetText: extracted.tweetText || (sameAuthor ? recovered.tweetText : ""),
    tweetLang: extracted.tweetLang || (sameAuthor ? recovered.tweetLang : ""),
    name: extracted.name || recovered.name,
    handle: extracted.handle || recovered.handle,
    translatedFromLang: extracted.translatedFromLang || (sameAuthor ? recovered.translatedFromLang : ""),
    isAutoTranslated: extracted.isAutoTranslated || (sameAuthor ? recovered.isAutoTranslated : false),
    communityNote: extracted.communityNote || (sameAuthor ? recovered.communityNote : ""),
    imageAlt: extracted.imageAlt || (sameAuthor ? recovered.imageAlt : ""),
    imageUrls:
      Array.isArray(extracted.imageUrls) && extracted.imageUrls.length > 0
        ? extracted.imageUrls
        : sameAuthor
          ? recovered.imageUrls || []
          : [],
    mainImageCount:
      extracted.mainImageCount ||
      (sameAuthor && Array.isArray(recovered.imageUrls) ? recovered.imageUrls.length : 0),
    mediaType: extracted.mediaType || (sameAuthor ? recovered.mediaType : ""),
  };
}

function filterTopLevelTweets(nodes) {
  if (!Array.isArray(nodes) || nodes.length <= 1) return nodes || [];
  return nodes.filter((el) => !nodes.some((other) => other !== el && other.contains(el)));
}

// X's Reply Modal ([role="dialog"]) hides the target tweet's attached photos/charts/cards/polls to save space.
// Match the modal's tweet back to its full <article> on the page behind the modal so Vision sees the actual chart/image!
function enrichModalFromUnderlyingTweet(extracted, dialog) {
  if (!extracted || !dialog || typeof document.querySelectorAll !== "function") {
    return extracted;
  }
  const hasImgs = Array.isArray(extracted.imageUrls) && extracted.imageUrls.length > 0;
  if (hasImgs && extracted.cardSummary && extracted.quotedText) {
    return extracted;
  }

  const targetHandle = String(extracted.handle || "").trim().toLowerCase();
  const normModalText = normalizeForCompare(extracted.tweetText || "");
  if (!targetHandle && normModalText.length < 12) {
    return extracted;
  }

  const pageScope = document.querySelector('[data-testid="primaryColumn"], main') || document;
  const pageArticles = filterTopLevelTweets(
    [
      ...pageScope.querySelectorAll('article[data-testid="tweet"], article, div[data-testid="tweet"]'),
    ].filter((el) => !dialog.contains(el) && !el.closest?.('[data-testid="sidebarColumn"], aside'))
  );

  const modalSample = normModalText.slice(0, Math.min(36, normModalText.length));

  for (const art of pageArticles) {
    const pageUser = parseUserBlock(art, findQuoteContainer(art));
    const pageHandle = String(pageUser.handle || "").trim().toLowerCase();
    if (targetHandle && pageHandle && pageHandle !== targetHandle) continue;

    const pageData = extractDataFromArticle(art);
    if (!pageData) continue;

    const normPageText = normalizeForCompare(pageData.tweetText || "");
    let isSameTweet = false;
    if (modalSample.length >= 12 && normPageText.length >= 12) {
      const pageSample = normPageText.slice(0, Math.min(36, normPageText.length));
      isSameTweet = normPageText.includes(modalSample) || normModalText.includes(pageSample);
    } else if (targetHandle && pageHandle === targetHandle && normModalText === normPageText) {
      isSameTweet =
        !extracted.timestamp || !pageData.timestamp || extracted.timestamp === pageData.timestamp;
    }

    if (!isSameTweet) continue;

    const mergedImages = hasImgs ? extracted.imageUrls : pageData.imageUrls || [];
    return {
      ...extracted,
      tweetText:
        pageData.tweetText && pageData.tweetText.length > (extracted.tweetText || "").length
          ? pageData.tweetText
          : extracted.tweetText,
      articleTitle: extracted.articleTitle || pageData.articleTitle,
      pollOptions: extracted.pollOptions || pageData.pollOptions,
      quotedText: extracted.quotedText || pageData.quotedText,
      quotedLang: extracted.quotedLang || pageData.quotedLang,
      cardSummary: extracted.cardSummary || pageData.cardSummary,
      communityNote: extracted.communityNote || pageData.communityNote,
      imageAlt: extracted.imageAlt || pageData.imageAlt,
      imageUrls: mergedImages,
      mainImageCount: hasImgs ? extracted.mainImageCount : pageData.mainImageCount || mergedImages.length,
      mediaType: extracted.mediaType || pageData.mediaType,
    };
  }

  return extracted;
}

function getPostContext(replyBox) {
  const emptyContext = {
    name: "",
    handle: "",
    tweetText: "",
    tweetLang: "",
    translatedFromLang: "",
    isAutoTranslated: false,
    isTruncated: false,
    timestamp: "",
    articleTitle: "",
    pollOptions: "",
    quotedText: "",
    quotedLang: "",
    cardSummary: "",
    communityNote: "",
    imageAlt: "",
    imageUrls: [],
    mainImageCount: 0,
    mediaType: "",
    replyTo: "",
    composerMode: "reply",
    parentContext: "",
    selfThreadContinuation: "",
    topReplies: "",
  };

  const composerReplyTo = extractComposerReplyTo(replyBox);

  // 1. Modal Dialog (Reply / Quote Tweet / Thread Reply)
  const dialog = replyBox.closest('[role="dialog"], dialog[open]');
  if (dialog) {
    const mode = detectComposerMode(replyBox, dialog, composerReplyTo);
    const articles = filterTopLevelTweets([
      ...dialog.querySelectorAll('article[data-testid="tweet"], article, div[data-testid="tweet"]'),
    ]);
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

      let extracted = enrichIfTextMissing(
        extractDataFromArticle(articles[chosenIdx]),
        replyBox,
        composerReplyTo
      );
      if (extracted) {
        if (mode === "reply") {
          extracted = enrichModalFromUnderlyingTweet(extracted, dialog);
        }
        if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
        extracted.composerMode = mode;
        if (chosenIdx > 0) {
          extracted.parentContext = buildParentThreadSummary(articles.slice(0, chosenIdx));
        }
        return extracted;
      }
    }

    let dialogFallback = enrichIfTextMissing(
      extractContextFromDialogNonArticle(dialog, replyBox),
      replyBox,
      composerReplyTo
    );
    if (dialogFallback) {
      if (mode === "reply") {
        dialogFallback = enrichModalFromUnderlyingTweet(dialogFallback, dialog);
      }
      dialogFallback.composerMode = mode;
      return dialogFallback;
    }
    let visibleDialog = contextFromVisibleComposer(replyBox, composerReplyTo);
    if (visibleDialog) {
      if (mode === "reply") {
        visibleDialog = enrichModalFromUnderlyingTweet(visibleDialog, dialog);
      }
      visibleDialog.composerMode = mode;
      return visibleDialog;
    }
    return emptyContext;
  }

  // 2. Reply box directly inside <article>
  const ownArticle = replyBox.closest('article, div[data-testid="tweet"]');
  if (ownArticle) {
    const extracted = enrichIfTextMissing(
      extractDataFromArticle(ownArticle),
      replyBox,
      composerReplyTo
    );
    if (extracted) {
      if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
      return extracted;
    }
  }

  // 3. Status detail page (/status/<id>) — prioritize the primary focal tweet inside primaryColumn/main
  const mainScope = document.querySelector('[data-testid="primaryColumn"], main') || document;
  const allTweets = filterTopLevelTweets(
    [
      ...mainScope.querySelectorAll('article[data-testid="tweet"], article, div[data-testid="tweet"]'),
    ].filter((el) => !el.closest?.('[data-testid="sidebarColumn"], aside'))
  );

  const boxRect = replyBox.getBoundingClientRect();
  const replyHandleMatch = composerReplyTo.match(/@([A-Za-z0-9_]{1,15})/);
  const targetHandleLower = replyHandleMatch ? `@${replyHandleMatch[1].toLowerCase()}` : "";

  const statusMatch = location.pathname.match(/\/status\/(\d+)/);
  if (statusMatch) {
    const statusId = statusMatch[1];
    const mainFocalTweet =
      mainScope.querySelector('article[tabindex="-1"]') ||
      allTweets.find((art) => Boolean(art.querySelector(`a[href*="/status/${statusId}"] time`))) ||
      allTweets.find((art) => Boolean(art.querySelector(`a[href*="/status/${statusId}"]`)));
    if (mainFocalTweet) {
      const focalRect = mainFocalTweet.getBoundingClientRect();
      const focalAboveComposer = focalRect.bottom <= boxRect.top + 120;
      const focalUser = parseUserBlock(mainFocalTweet, findQuoteContainer(mainFocalTweet));
      const handleMatchesFocal =
        !targetHandleLower ||
        !focalUser.handle ||
        focalUser.handle.toLowerCase() === targetHandleLower ||
        boxRect.top - focalRect.bottom <= 220;

      if (focalAboveComposer && handleMatchesFocal) {
        const extracted = enrichIfTextMissing(
          extractDataFromArticle(mainFocalTweet),
          replyBox,
          composerReplyTo
        );
        if (extracted) {
          if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
          const focalIdx = allTweets.indexOf(mainFocalTweet);
          if (focalIdx > 0) {
            extracted.parentContext = buildParentThreadSummary(allTweets.slice(0, focalIdx));
          }
          if (focalIdx >= 0 && focalIdx < allTweets.length - 1) {
            const afterFocal = allTweets.slice(focalIdx + 1);
            let consumed = 0;
            if (extracted.handle) {
              const selfThread = buildSelfThreadContinuation(afterFocal, extracted.handle);
              extracted.selfThreadContinuation = selfThread.text;
              consumed = selfThread.consumedCount;
            }
            extracted.topReplies = buildTopRepliesSummary(afterFocal, extracted.handle, consumed);
          }
          return extracted;
        }
      }
    }
  }

  // 4. Fallback: nearest tweet directly above the reply composer (bounded within 900px to cover tall image posts)
  let bestIdx = -1;
  let bestScore = Infinity;

  for (let i = 0; i < allTweets.length; i++) {
    const rect = allTweets[i].getBoundingClientRect();
    const dist = boxRect.top - rect.bottom;
    if (dist < -80 || dist > 900) continue;
    let score = Math.max(0, dist);
    if (targetHandleLower) {
      const user = parseUserBlock(allTweets[i], findQuoteContainer(allTweets[i]));
      if (user.handle && user.handle.toLowerCase() === targetHandleLower) {
        score -= 300;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) {
    const extracted = enrichIfTextMissing(
      extractDataFromArticle(allTweets[bestIdx]),
      replyBox,
      composerReplyTo
    );
    if (extracted) {
      if (!extracted.replyTo && composerReplyTo) extracted.replyTo = composerReplyTo;
      if (bestIdx > 0) {
        extracted.parentContext = buildParentThreadSummary(allTweets.slice(0, bestIdx));
      }
      return extracted;
    }
  }

  // Do not hallucinate a reply from the top-of-feed "What's happening?" new-post composer
  if (!composerReplyTo && /^\/(home|compose\/post|compose\/tweet)?$/i.test(location.pathname)) {
    return emptyContext;
  }

  return contextFromVisibleComposer(replyBox, composerReplyTo) || emptyContext;
}

// ═══════════════════════════════════════════════════════════════
// Mount Container, Quick Angle Mini-Menu & Zero-Reflow Injection
// ═══════════════════════════════════════════════════════════════
let repositionRafId = null;

function getActiveDialogs() {
  const candidates = document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]');
  const active = [];
  for (const el of candidates) {
    if (!el.isConnected) continue;
    if (el.closest?.('[data-testid="DMDrawer"], [data-testid="HoverCard"]')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 120 && rect.height > 120) {
      active.push(el);
    }
  }
  return active;
}

function getOverlayHost(anchor) {
  // Native <dialog open> renders in the browser Top Layer above body overlays
  const nativeDialog = anchor?.closest?.("dialog[open]");
  if (nativeDialog) {
    let dialogHost = nativeDialog.querySelector(":scope > .x-ai-reply-overlay-host");
    if (dialogHost && dialogHost.isConnected) return dialogHost;
    dialogHost = document.createElement("div");
    dialogHost.className = "x-ai-reply-overlay-host";
    dialogHost.setAttribute("data-translate", "no");
    nativeDialog.appendChild(dialogHost);
    return dialogHost;
  }

  let host = document.getElementById("x-ai-reply-overlay");
  if (host && host.isConnected) return host;

  host = document.createElement("div");
  host.id = "x-ai-reply-overlay";
  host.className = "x-ai-reply-overlay-host";
  host.setAttribute("data-translate", "no");
  (document.body || document.documentElement).appendChild(host);
  return host;
}

function resolveLiveComposerForGroup(group) {
  if (!group) return null;
  const currentBox = group.__xAiBox;
  if (currentBox && currentBox.isConnected) return currentBox;
  const anchor = group.__xAiAnchor;
  if (anchor && anchor.isConnected) {
    const freshBox = findEditorNear(anchor);
    if (freshBox && freshBox.isConnected) {
      if (currentBox && currentBox !== freshBox) {
        boxButtonMap.delete(currentBox);
      }
      group.__xAiBox = freshBox;
      const btn = group.querySelector(".x-ai-reply-button");
      if (btn) boxButtonMap.set(freshBox, btn);
      return freshBox;
    }
  }
  return null;
}

function positionReplyGroup(group, box, openDialogs = null) {
  const anchor = group?.__xAiAnchor && group.__xAiAnchor.isConnected ? group.__xAiAnchor : box;
  if (!group || !anchor || !anchor.isConnected) return;

  const dialogs = openDialogs || getActiveDialogs();
  if (dialogs.length > 0) {
    const insideActiveDialog = dialogs.some((d) => d.contains(anchor));
    if (!insideActiveDialog) {
      if (group.style.display !== "none") {
        group.style.display = "none";
      }
      delete group.dataset.open;
      return;
    }
  }

  // Ensure group is in the right host (e.g., if dialog became inert or top-layer)
  const expectedHost = getOverlayHost(anchor);
  if (group.parentElement !== expectedHost) {
    expectedHost.appendChild(group);
  }

  const rect = anchor.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) {
    if (group.style.display !== "none") {
      group.style.display = "none";
    }
    delete group.dataset.open;
    return;
  }

  if (group.style.display !== "inline-flex") {
    group.style.display = "inline-flex";
  }

  const width = group.offsetWidth || 108;
  const height = group.offsetHeight || 28;
  const viewportLeft = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const viewportTop = Math.max(8, rect.top - height - 8);

  // Account for any transformed/top-layer containing block offset
  const hostRect = expectedHost.getBoundingClientRect();
  const roundedLeft = Math.round(viewportLeft - hostRect.left);
  const roundedTop = Math.round(viewportTop - hostRect.top);

  const isInteractive = group.dataset.open === "true" || group.matches(":hover");
  const lastPos = group.__xAiLastPos;

  // Freeze micro-shifts while user is hovering or clicking so click events never cancel
  if (isInteractive && lastPos) {
    const dx = Math.abs(roundedLeft - lastPos.left);
    const dy = Math.abs(roundedTop - lastPos.top);
    if (dx <= 6 && dy <= 6) {
      return;
    }
  }

  if (!lastPos || lastPos.left !== roundedLeft || lastPos.top !== roundedTop) {
    group.style.left = `${roundedLeft}px`;
    group.style.top = `${roundedTop}px`;
    group.__xAiLastPos = { left: roundedLeft, top: roundedTop };
  }

  if (!isInteractive) {
    // Flip angle bar below button if too close to top of viewport
    const nextPlacement = viewportTop < 52 ? "bottom" : "top";
    if (group.dataset.placement !== nextPlacement) {
      group.dataset.placement = nextPlacement;
    }
    // Align angle bar to left edge if too close to left of viewport
    const nextAlign = viewportLeft + width < 270 ? "left" : "right";
    if (group.dataset.align !== nextAlign) {
      group.dataset.align = nextAlign;
    }
  }
}

function repositionMountedGroups() {
  if (mountedGroups.size === 0) return;
  const openDialogs = getActiveDialogs();
  for (const group of mountedGroups) {
    if (!group.isConnected) continue;
    const liveBox = resolveLiveComposerForGroup(group);
    const anchor = group.__xAiAnchor;
    if (!anchor || !anchor.isConnected) continue;
    positionReplyGroup(group, liveBox || anchor, openDialogs);
  }
}

function scheduleReposition() {
  if (repositionRafId) return;
  if (typeof requestAnimationFrame === "function") {
    repositionRafId = requestAnimationFrame(() => {
      repositionRafId = null;
      if (!isInsertingText) repositionMountedGroups();
    });
  } else {
    repositionMountedGroups();
  }
}

function shouldInjectForBox(box) {
  if (!box || !box.isConnected) return false;
  if (isDmOrNonReplySurface(box) || isGrokSurface(box)) return false;
  if (!isComposerBox(box)) return false;
  const label = `${box.getAttribute("aria-label") || ""} ${box.getAttribute("data-placeholder") || ""} ${box.textContent || ""}`;
  if (/post your reply|reply|quote|what.?s happening/i.test(label)) return true;
  if (box.closest('[role="dialog"], article, [data-testid="primaryColumn"], [data-testid="cellInnerDiv"]')) {
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
      if (typeof group.__xAiClearMenuTimer === "function") group.__xAiClearMenuTimer();
      group.remove();
      mountedGroups.delete(group);
      if (box) boxButtonMap.delete(box);
      if (anchor) boxButtonMap.delete(anchor);
      continue;
    }
    // If React replaced the editor while keeping the submit button, re-bind the live editor
    if (!box || !box.isConnected) {
      const freshBox = resolveLiveComposerForGroup(group);
      if (!freshBox) {
        if (typeof group.__xAiClearMenuTimer === "function") group.__xAiClearMenuTimer();
        group.remove();
        mountedGroups.delete(group);
        if (box) boxButtonMap.delete(box);
        if (anchor) boxButtonMap.delete(anchor);
      }
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
  if (
    isDmOrNonReplySurface(el) ||
    isGrokSurface(el) ||
    el.closest?.('nav, [role="navigation"], [role="banner"]')
  ) {
    return false;
  }
  const testId = el.getAttribute("data-testid") || "";
  if (/SideNav/i.test(testId) || testId === "reply" || /^dmComposer/i.test(testId)) return false;
  if (/tweetButton/i.test(testId)) return true;
  // Ignore action-bar buttons inside a tweet article unless it's an explicit tweetButton
  if (el.closest?.('article [role="group"]')) return false;
  // Use textContent/aria-label instead of innerText to avoid forced layout reflows
  const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  if (
    !/^(reply|post|quote|balas|posting|kutip|返信|ポスト|回复|回覆|发帖|답글|게시하기|responder|répondre|antworten)$/i.test(
      label
    )
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width >= 36 && rect.width <= 180 && rect.height >= 24 && rect.height <= 64;
}

function findReplyActionButtons(root) {
  if (/^\/messages(\/|$)|\/i\/grok|\/grok/i.test(location.pathname)) return [];
  const scope = root && (root.querySelectorAll || root instanceof ShadowRoot) ? root : document;
  if (!hasAnyComposerHintInDom(scope)) return [];

  // Fast path: match X's explicit tweet/reply submit testids without scanning every button on the page
  const fastNodes = queryDeep(
    scope,
    '[data-testid="tweetButtonInline"], [data-testid="tweetButton"], [data-testid^="tweetButton"]'
  );
  const hits = [];
  const seen = new Set();
  for (const node of fastNodes) {
    if (!isSubmitButton(node) || seen.has(node)) continue;
    const nested = node.parentElement?.closest?.("button, [role='button']");
    if (nested && isSubmitButton(nested)) continue;
    seen.add(node);
    hits.push(node);
  }
  if (hits.length > 0) return hits;

  // Fallback path only if explicit testids are absent and an editable composer actually exists
  const fallbackNodes = queryDeep(scope, 'button, [role="button"]');
  for (const node of fallbackNodes) {
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
  let node = anchor.parentElement;
  for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
    // Stop climbing before crossing into page-wide containers so we never bind to an unrelated composer
    const tag = node.tagName;
    if (
      tag === "BODY" ||
      tag === "HTML" ||
      tag === "MAIN" ||
      tag === "SECTION" ||
      node.getAttribute?.("data-testid") === "primaryColumn" ||
      node.getAttribute?.("role") === "region"
    ) {
      break;
    }

    const direct = node.querySelector?.(
      `${COMPOSER_SELECTOR}, [data-testid^="tweetTextarea"] [contenteditable="true"], [data-testid*="tweetTextarea"] [contenteditable]`
    );
    if (direct && isComposerBox(direct)) return direct;

    const editable = node.querySelector?.(
      '[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], textarea'
    );
    if (editable && !isDmOrNonReplySurface(editable) && !isGrokSurface(editable)) {
      if (isComposerBox(editable) || editable.tagName === "TEXTAREA") return editable;
    }

    // Stop after inspecting the immediate dialog, article, or tweet cell boundary
    if (
      tag === "ARTICLE" ||
      tag === "DIALOG" ||
      node.getAttribute?.("role") === "dialog" ||
      node.getAttribute?.("data-testid") === "cellInnerDiv"
    ) {
      break;
    }
  }
  // Only return anchor if it is itself a valid composer element, otherwise null
  if (isComposerBox(anchor)) return anchor;
  return null;
}

function insertButtonIntoReplyBoxes() {
  cleanupOrphanButtons();

  const anchors = findReplyActionButtons(document);
  const replyBoxes = anchors.length > 0 ? [] : queryComposerBoxes(document);
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
    if (box && !shouldInjectForBox(box) && !anchor) continue;
    pendingMounts.push({ box: box || anchor, anchor });
  }

  if (pendingMounts.length === 0) return;

  const openDialogs = getActiveDialogs();

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

    let closeMenuTimer = null;
    const clearMenuTimer = () => {
      if (closeMenuTimer) {
        clearTimeout(closeMenuTimer);
        closeMenuTimer = null;
      }
    };
    group.__xAiClearMenuTimer = clearMenuTimer;
    const openAngleMenu = () => {
      clearMenuTimer();
      if (btn.dataset.loading === "true") return;
      group.dataset.open = "true";
    };
    const scheduleCloseAngleMenu = () => {
      clearMenuTimer();
      closeMenuTimer = setTimeout(() => {
        closeMenuTimer = null;
        delete group.dataset.open;
      }, 180);
    };

    const triggerGeneration = (selectedAngle) => {
      clearMenuTimer();
      delete group.dataset.open;
      if (btn.dataset.loading === "true") return;
      const liveBox = resolveLiveComposerForGroup(group) || box;
      if (!liveBox || !liveBox.isConnected) {
        showToast("Reply editor was refreshed. Please click AI Reply again.", {
          type: "warn",
          duration: 3000,
        });
        return;
      }
      generateText(liveBox, btn, liveBox.parentElement, selectedAngle);
    };

    const blockFocusSteal = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    for (const item of QUICK_ANGLES) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "x-ai-angle-pill";
      pill.textContent = item.label;
      pill.title = item.title;
      pill.dataset.angle = item.id;
      pill.addEventListener("pointerdown", blockFocusSteal);
      pill.addEventListener("mousedown", blockFocusSteal);
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerGeneration(item.id);
      });
      angleBar.appendChild(pill);
    }

    btn.addEventListener("pointerdown", blockFocusSteal);
    btn.addEventListener("mousedown", blockFocusSteal);
    btn.addEventListener("mouseenter", openAngleMenu);
    btn.addEventListener("focus", openAngleMenu);
    angleBar.addEventListener("mouseenter", openAngleMenu);
    group.addEventListener("mouseenter", openAngleMenu);
    group.addEventListener("mouseleave", scheduleCloseAngleMenu);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerGeneration("auto");
    });

    group.appendChild(angleBar);
    group.appendChild(btn);
    group.__xAiBox = box;
    group.__xAiAnchor = anchor || box;
    getOverlayHost(anchor || box).appendChild(group);
    group.style.position = "fixed";
    group.style.zIndex = "2147483646";
    positionReplyGroup(group, box, openDialogs);

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

function stripMatchingOuterQuotes(text) {
  let s = String(text || "").trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
    ["`", "`"],
  ];
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

function extractMessageContentString(raw) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return typeof part.text === "string"
            ? part.text
            : typeof part.content === "string"
              ? part.content
              : "";
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function cleanModelReply(rawText) {
  let cleaned = extractMessageContentString(rawText);
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  if (/<think\b|<thinking\b/i.test(cleaned)) {
    return "";
  }

  // Defensive strip if structured INTENT / HOOK / POINT / REPLY lines ever slip through
  const replyLineMatch = cleaned.match(
    /(?:^|\n)\s*\*{0,2}(?:REPLY|BALASAN|返信|回复|回覆|답글)\*{0,2}\s*[:：]\s*\*{0,2}\s*([^\n]+)/i
  );
  if (replyLineMatch && replyLineMatch[1]) {
    cleaned = replyLineMatch[1];
  } else if (/^\s*\*{0,2}(?:INTENT|HOOK|POINT|INTI|要点)\*{0,2}\s*[:：]/i.test(cleaned)) {
    return "";
  }

  cleaned = stripMatchingOuterQuotes(
    cleaned
      .replace(/\r?\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
    .replace(/[.。!！]+$/g, "")
    .trim();

  return dedupeRepeatedText(cleaned);
}

function classifyEditorDraft(box) {
  const current = getEditorText(box);
  if (!current || current.length < 3) {
    return { previousDraft: "", userSeed: "" };
  }
  const last = lastGeneratedByBox.get(box);
  if (last && last.text) {
    const normCur = normalizeForCompare(current);
    const normLast = normalizeForCompare(last.text);
    if (normCur === normLast) {
      return { previousDraft: current.slice(0, 180), userSeed: "" };
    }
    // Treat minor edits of the last AI reply as a regenerate request rather than a user seed
    const curWords = new Set(current.toLowerCase().split(/\s+/).filter((w) => w.length >= 2));
    const lastWords = new Set(last.text.toLowerCase().split(/\s+/).filter((w) => w.length >= 2));
    let shared = 0;
    for (const w of curWords) {
      if (lastWords.has(w)) shared += 1;
    }
    const overlap = curWords.size > 0 ? shared / Math.max(curWords.size, lastWords.size) : 0;
    if (overlap >= 0.55) {
      return { previousDraft: current.slice(0, 180), userSeed: "" };
    }
  }
  // Short non-AI draft typed by the user acts as a guided direction seed
  if (current.length <= 160) {
    return { previousDraft: "", userSeed: current };
  }
  return { previousDraft: "", userSeed: "" };
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
  let acquiredLock = false;

  try {
    if (isGenerating) {
      showToast("Already generating a reply — please wait a moment.", {
        type: "warn",
        duration: 2200,
      });
      return;
    }

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
    const hasReadableText = Boolean(
      post.tweetText ||
        post.selfThreadContinuation ||
        post.articleTitle ||
        post.pollOptions ||
        post.quotedText ||
        post.cardSummary ||
        post.imageAlt
    );
    const hasImages = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;

    if (!hasReadableText && !hasImages) {
      showToast("No target post detected. Open a post or reply box so AI can read it first.", {
        type: "warn",
      });
      return;
    }

    if (!hasReadableText && hasImages && !settingsCache.visionMode) {
      showToast("This post only has an image — enable Vision mode so AI can read it before replying.", {
        type: "warn",
        duration: 5500,
      });
      return;
    }

    isGenerating = true;
    acquiredLock = true;
    setButtonVisualState(btn, "loading");

    const timeoutMs = Math.round(clampTimeoutSec(settingsCache.timeout) * 1000);
    const selectedAngle = angle && angle !== "auto" ? angle : "auto";
    const { previousDraft, userSeed } = classifyEditorDraft(box);

    const result = await sendMessageSafe(
      {
        action: "generateReply",
        endpoint: buildEndpoint(settingsCache.baseUrl),
        apiKey: settingsCache.apiKey.trim(),
        model: settingsCache.model,
        systemPrompt: settingsCache.prompt,
        timeoutMs,
        angle: selectedAngle,
        visionMode: settingsCache.visionMode,
        previousDraft,
        userSeed,
        post,
      },
      Math.min(timeoutMs * 2 + 30000, 360000)
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
    let rawReply = extractMessageContentString(messageObj?.content);

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

    const insertResult = await insertTextProperly(box, replyText, mountContainer);
    if (!insertResult || !insertResult.ok) {
      const reasonMsg =
        insertResult?.method === "focus_failed"
          ? "Could not focus the reply box. Click inside it and try again."
          : insertResult?.method === "insert_failed"
            ? "Could not insert the reply into the editor. Please try again."
            : "The reply box was closed before generation completed.";
      showToast(reasonMsg, {
        type: "warn",
      });
      return;
    }

    if (insertResult.method === "clipboard") {
      showToast("Reply copied to clipboard — press Ctrl+V in the reply box to paste.", {
        type: "info",
        duration: 6000,
      });
    } else {
      lastGeneratedByBox.set(box, { text: replyText, at: Date.now() });
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
    if (acquiredLock) {
      isGenerating = false;
    }
    if (!succeeded) {
      setButtonVisualState(btn, "idle");
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// insertTextProperly — Ghost-Free Draft.js / Lexical Replace Handler
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

function getEditorText(el) {
  if (!el) return "";
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    return cleanText(el.value);
  }
  return cleanText(String(el.innerText || "").replace(/[\u200B-\u200D\uFEFF]/g, ""));
}

function selectAllInEditor(el) {
  if (!el) return;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    el.focus();
    el.select();
    return;
  }
  try {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }
  } catch (e) {}
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      document.execCommand("selectAll", false, null);
    }
  } catch (e) {}
}

async function clearEditorContent(el) {
  if (getEditorText(el).length === 0) return true;

  // Attempt 1: Explicit Range selection + beforeinput(deleteContentBackward) (Lexical / modern Draft.js)
  selectAllInEditor(el);
  await waitFrames(28);
  try {
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  } catch (e) {}
  await waitFrames(28);
  if (getEditorText(el).length === 0) return true;

  // Attempt 2: Explicit Range selection + execCommand("delete")
  selectAllInEditor(el);
  await waitFrames(24);
  try {
    document.execCommand("delete", false, null);
  } catch (e) {}
  await waitFrames(28);
  if (getEditorText(el).length === 0) return true;

  // Attempt 3: Explicit Range selection + Backspace key event + delete
  selectAllInEditor(el);
  await waitFrames(24);
  try {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        which: 8,
        bubbles: true,
        cancelable: true,
      })
    );
    document.execCommand("delete", false, null);
    el.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        which: 8,
        bubbles: true,
      })
    );
  } catch (e) {}
  await waitFrames(28);
  if (getEditorText(el).length === 0) return true;

  // Attempt 4: Leave entire editor content selected so paste/insert replaces it instead of appending
  selectAllInEditor(el);
  await waitFrames(24);
  return false;
}

function dispatchPasteText(el, text) {
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const pasteEvent = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  return !el.dispatchEvent(pasteEvent);
}

function normalizeForCompare(str) {
  return String(str || "")
    .replace(/[\u200B-\u200D\uFEFF\s]+/g, "")
    .toLowerCase();
}

function editorHasExpectedText(actual, expected) {
  const normActual = normalizeForCompare(actual);
  const normExpected = normalizeForCompare(expected);
  if (!normActual || !normExpected) return false;
  if (normActual.length < Math.max(1, Math.floor(normExpected.length * 0.65))) return false;
  const headSample = normExpected.slice(0, Math.min(10, normExpected.length));
  if (!normActual.includes(headSample)) return false;
  if (normExpected.length > 14) {
    const tailSample = normExpected.slice(-Math.min(8, normExpected.length));
    if (!normActual.includes(tailSample)) return false;
  }
  return true;
}

async function copyToClipboardFallback(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const tmp = document.createElement("textarea");
    tmp.value = text;
    tmp.setAttribute("readonly", "");
    tmp.style.position = "fixed";
    tmp.style.opacity = "0";
    tmp.style.pointerEvents = "none";
    (document.body || document.documentElement).appendChild(tmp);
    tmp.select();
    const ok = document.execCommand("copy");
    tmp.remove();
    return Boolean(ok);
  } catch (e) {
    return false;
  }
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
  if (!el) return { ok: false, method: "closed" };

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
    // Handle native <textarea> / <input> composers directly
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.focus();
      const proto =
        el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, method: "inserted" };
    }

    if (document.activeElement !== el) {
      el.focus();
      await waitFrames(35);
      el = resolveLiveBox();
      if (!el) return { ok: false, method: "closed" };
      if (document.activeElement !== el) {
        el.focus();
        await waitFrames(16);
      }
      if (document.activeElement !== el) {
        console.error("[X AI Reply] Could not focus reply editor.");
        const copied = await copyToClipboardFallback(text);
        return copied ? { ok: true, method: "clipboard" } : { ok: false, method: "focus_failed" };
      }
    }

    const expectedClean = cleanText(text);
    const prevText = getEditorText(el);

    // Step 1: Clear any existing draft text and verify it's actually removed
    if (prevText.length > 0) {
      await clearEditorContent(el);
      el = resolveLiveBox();
      if (!el) return { ok: false, method: "closed" };
      if (document.activeElement !== el) {
        el.focus();
        await waitFrames(16);
      }
      // If text is still present, keep it fully selected so insertion replaces it
      if (getEditorText(el).length > 0) {
        selectAllInEditor(el);
        await waitFrames(20);
      }
    }

    // Step 2: Insert via ClipboardEvent paste (preserves Draft.js & Lexical internal state)
    let handledByPaste = false;
    try {
      const prevented = dispatchPasteText(el, text);
      await waitFrames(28);
      let afterPaste = getEditorText(el);
      if (!editorHasExpectedText(afterPaste, expectedClean) && prevented) {
        // Give async Draft.js/Lexical paste handlers a moment before falling back
        await waitFrames(65);
        afterPaste = getEditorText(el);
      }
      if (editorHasExpectedText(afterPaste, expectedClean)) {
        handledByPaste = true;
      }
    } catch (e) {
      console.warn("[X AI Reply] ClipboardEvent paste failed, trying fallback:", e);
    }

    if (!handledByPaste) {
      // Ensure any leftover text stays selected before fallback insertion
      if (getEditorText(el).length > 0) {
        selectAllInEditor(el);
        await waitFrames(16);
      }

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
        await waitFrames(24);
        if (editorHasExpectedText(getEditorText(el), expectedClean)) {
          insertedViaInput = true;
        }
      } catch (e) {}

      if (!insertedViaInput) {
        try {
          document.execCommand("insertText", false, text);
        } catch (e) {}
      }
    }

    // Step 3: Anti-double & safe final verification (never mutate Draft.js/Lexical textContent directly)
    await waitFrames(28);
    el = resolveLiveBox();
    if (!el) return { ok: false, method: "closed" };

    const finalText = getEditorText(el);
    const normFinal = normalizeForCompare(finalText);
    const normExpected = normalizeForCompare(expectedClean);
    const hasConcatenatedOldText =
      normFinal.length > normExpected.length + 2 && normFinal.includes(normExpected);

    if (hasConcatenatedOldText) {
      // Old text survived and new text got appended — atomically replace full selection
      selectAllInEditor(el);
      await waitFrames(24);
      let replaced = false;
      try {
        document.execCommand("insertText", false, text);
        await waitFrames(24);
        if (normalizeForCompare(getEditorText(el)) === normExpected) replaced = true;
      } catch (e) {}

      if (!replaced) {
        await clearEditorContent(el);
        if (getEditorText(el).length === 0) {
          try {
            dispatchPasteText(el, text);
            await waitFrames(24);
          } catch (e) {}
        }
      }
    }

    const verifiedText = getEditorText(el);
    if (!editorHasExpectedText(verifiedText, expectedClean)) {
      // Do NOT set el.textContent directly (breaks Draft.js/Lexical EditorState); copy to clipboard instead
      const copied = await copyToClipboardFallback(text);
      return copied ? { ok: true, method: "clipboard" } : { ok: false, method: "insert_failed" };
    }

    return { ok: true, method: "inserted" };
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
  if (activeEl && activeEl.nodeType === Node.ELEMENT_NODE) {
    const focusedEditor = activeEl.closest?.(COMPOSER_SELECTOR);
    if (focusedEditor && isComposerBox(focusedEditor)) {
      const btn = boxButtonMap.get(focusedEditor);
      if (btn && btn.isConnected) return btn;
    }
    // Never hijack Alt+R when user is typing inside Search, DM, or any non-composer input
    if (
      activeEl.matches?.("input, textarea, select") ||
      activeEl.isContentEditable ||
      isDmOrNonReplySurface(activeEl)
    ) {
      return null;
    }
  }

  const openDialogs = getActiveDialogs();
  if (openDialogs.length > 0) {
    const topDialog = openDialogs[openDialogs.length - 1];
    for (const group of mountedGroups) {
      if (!group.isConnected) continue;
      const anchor = group.__xAiAnchor;
      const box = group.__xAiBox;
      if ((anchor && topDialog.contains(anchor)) || (box && topDialog.contains(box))) {
        const btn = group.querySelector(".x-ai-reply-button");
        if (btn && btn.isConnected) return btn;
      }
    }
    return null;
  }

  // Outside modals, only trigger if a single unambiguous reply button is visible (or on /status/ page)
  const visibleBtns = [];
  for (const group of mountedGroups) {
    if (group.isConnected && group.style.display !== "none") {
      const btn = group.querySelector(".x-ai-reply-button");
      if (btn) visibleBtns.push(btn);
    }
  }
  if (visibleBtns.length === 1 || (visibleBtns.length > 0 && /\/status\/\d+/.test(location.pathname))) {
    return visibleBtns[0];
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
  window.addEventListener("scroll", scheduleReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleReposition, { passive: true });
  setInterval(() => {
    if (!isInsertingText) {
      insertButtonIntoReplyBoxes();
      repositionMountedGroups();
    }
  }, 1500);
}

if (document.body) {
  bootComposerWatcher();
} else {
  window.addEventListener("DOMContentLoaded", bootComposerWatcher);
}
