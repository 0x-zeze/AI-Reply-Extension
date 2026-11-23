const MAX_PROFILES = 6;

const DEFAULTS = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "",
  model: "grok-4.6-high",
  prompt:
    "super casual and chill, like texting a friend on X, short punchy natural slang when it fits, never sound like an AI or analyst, no emojis",
  timeout: 60,
  visionMode: true,
  translationPreview: true,
  shortcutEnabled: true,
  profiles: null,
  activeProfileId: "",
};

const LEGACY_PROMPT_UPGRADES = {
  "all lowercase, under 10 words, dry and effortless, sound like a real person typing from phone, no emojis":
    "super casual and chill, like texting a friend on X, short punchy natural slang when it fits, never sound like an AI or analyst, no emojis",
  "super casual and chill, like texting a friend on X, short punchy lowercase, natural slang ok when it fits (tbh/ngl/lowkey/fr), never sound like an AI or analyst, no emojis":
    "super casual and chill, like texting a friend on X, short punchy natural slang when it fits, never sound like an AI or analyst, no emojis",
  "clever, witty one-liner, sharp observation, casual lowercase, zero clichés, under 12 words":
    "playful casual humor, clever quick quip or light sarcasm, effortless lowercase, relatable and funny without trying too hard, no emojis",
  "crypto-native CT vibe, grounded take on the thesis or chart, concise lowercase, under 12 words, no hype emojis":
    "real CT trader vibe, super casual shorthand, spontaneous take on the chart or narrative like someone in the trenches, lowercase, zero corporate analyst talk, no hype emojis",
  "curious and thoughtful, ask a short smart follow-up or add one concrete angle, casual lowercase, under 13 words":
    "genuinely curious and conversational, drop a casual real-talk question or honest gut reaction like a regular X user, lowercase, never preachy or stiff",
};

function upgradeLegacyPrompt(value) {
  const clean = String(value || "").trim();
  return LEGACY_PROMPT_UPGRADES[clean] || value;
}

let profilesState = [];
let activeProfileId = "";
let permCheckSeq = 0;
let selfWriteDepth = 0;

function readArea(area, defaultsObj) {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage[area]) return resolve(null);
      chrome.storage[area].get(defaultsObj, (data) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(data || {});
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function writeLocalConfig(payload, callback) {
  selfWriteDepth += 1;
  const fullPayload = { ...payload, _storageV2: true };
  chrome.storage.local.set(fullPayload, () => {
    const err = chrome.runtime.lastError;
    setTimeout(() => {
      selfWriteDepth = Math.max(0, selfWriteDepth - 1);
    }, 120);
    if (typeof callback === "function") callback(err || null);
  });
}

async function loadConfigWithMigration() {
  const keys = { ...DEFAULTS, _storageV2: false };
  const localData = await readArea("local", keys);
  if (
    localData &&
    (localData._storageV2 === true ||
      (Array.isArray(localData.profiles) && localData.profiles.length > 0) ||
      Boolean(localData.apiKey))
  ) {
    return localData;
  }

  const syncData = await readArea("sync", DEFAULTS);
  const merged = syncData || localData || { ...DEFAULTS };
  // One-time seamless migration from chrome.storage.sync → chrome.storage.local (10 MB quota, keys stay local)
  if (syncData && (syncData.apiKey || (Array.isArray(syncData.profiles) && syncData.profiles.length > 0))) {
    writeLocalConfig(merged);
  }
  return merged;
}

function $(id) {
  return document.getElementById(id);
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS.timeout;
  return Math.min(Math.max(Math.round(n), 5), 180);
}

function normalizeBaseUrl(raw) {
  let v = String(raw || "").trim();
  if (!v) return DEFAULTS.baseUrl;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.)/i.test(v);
    v = (isLocal ? "http://" : "https://") + v;
  }
  return v.replace(/\/+$/, "");
}

function currentBaseUrl() {
  return normalizeBaseUrl($("baseUrl").value);
}

function buildEndpoint(baseUrl) {
  let url = normalizeBaseUrl(baseUrl);
  if (!/\/chat\/completions(\?.*)?$/i.test(url)) {
    url += "/chat/completions";
  }
  return url;
}

function originPatternFor(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin + "/*";
  } catch (e) {
    return null;
  }
}

function hostLabelFor(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch (e) {
    return baseUrl;
  }
}

function extractUpstreamError(data) {
  if (!data) return "(no details)";
  const err = data.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
    if (typeof err.error === "string" && err.error.trim()) return err.error.trim();
    if (typeof err.code === "string" && err.code.trim()) return `Code: ${err.code}`;
    try {
      return JSON.stringify(err).slice(0, 240);
    } catch (e) {}
  }
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  if (typeof data._raw === "string" && data._raw.trim()) return data._raw.trim().slice(0, 240);
  return "(no details)";
}

function showResultBox(el, text, tone) {
  if (!el) return;
  if (!text) {
    el.textContent = "";
    delete el.dataset.visible;
    delete el.dataset.tone;
    return;
  }
  el.textContent = text;
  el.dataset.tone = tone || "ok";
  el.dataset.visible = "true";
}

// ═══════════════════════════════════════════════════════════════
// Multi-Profile Helpers & Seamless Migration
// ═══════════════════════════════════════════════════════════════
function ensureValidProfiles(data) {
  const fallbackProfile = {
    id: "prof_default",
    name: "Main Profile",
    baseUrl: normalizeBaseUrl(data.baseUrl || DEFAULTS.baseUrl),
    apiKey: String(data.apiKey || "").trim(),
    model: String(data.model || DEFAULTS.model).trim(),
    prompt: data.prompt !== undefined ? upgradeLegacyPrompt(String(data.prompt)) : DEFAULTS.prompt,
    timeout: clampTimeout(data.timeout),
  };

  if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
    return {
      profiles: [fallbackProfile],
      activeId: fallbackProfile.id,
    };
  }

  const sanitized = data.profiles
    .filter((p) => p && typeof p === "object")
    .slice(0, MAX_PROFILES)
    .map((p, idx) => {
      const rawName = String(p.name || "").trim();
      const normalizedName =
        rawName === "Profil Utama"
          ? "Main Profile"
          : rawName || `Profile ${idx + 1}`;
      return {
        id: String(p.id || `prof_${idx + 1}`),
        name: normalizedName,
        baseUrl: normalizeBaseUrl(p.baseUrl || DEFAULTS.baseUrl),
        apiKey: String(p.apiKey || "").trim(),
        model: String(p.model || DEFAULTS.model).trim(),
        prompt: p.prompt !== undefined ? upgradeLegacyPrompt(String(p.prompt)) : DEFAULTS.prompt,
        timeout: clampTimeout(p.timeout),
      };
    });

  if (sanitized.length === 0) {
    return { profiles: [fallbackProfile], activeId: fallbackProfile.id };
  }

  const chosenId = sanitized.some((p) => p.id === data.activeProfileId)
    ? data.activeProfileId
    : sanitized[0].id;

  return { profiles: sanitized, activeId: chosenId };
}

function getActiveProfileObj() {
  return (
    profilesState.find((p) => p.id === activeProfileId) || profilesState[0] || null
  );
}

function commitFormIntoCurrentProfile() {
  const cur = getActiveProfileObj();
  if (!cur) return;
  cur.name = $("profileName").value.trim() || cur.name || "Profile";
  cur.baseUrl = currentBaseUrl();
  cur.apiKey = $("apiKey").value.trim();
  cur.model = $("model").value.trim() || DEFAULTS.model;
  cur.prompt = $("prompt").value.trim();
  cur.timeout = clampTimeout($("timeout").value);
  if (cur.apiKey || cur.baseUrl !== DEFAULTS.baseUrl || cur.model !== DEFAULTS.model || cur.prompt !== DEFAULTS.prompt) {
    delete cur._unsavedDraft;
  }
}

function populateFormFromProfile(prof) {
  if (!prof) return;
  const t = clampTimeout(prof.timeout);
  $("profileName").value = prof.name || "Profile";
  $("baseUrl").value = prof.baseUrl || DEFAULTS.baseUrl;
  $("apiKey").value = prof.apiKey || "";
  $("model").value = prof.model || DEFAULTS.model;
  $("prompt").value = prof.prompt !== undefined ? prof.prompt : DEFAULTS.prompt;
  $("timeout").value = t;
  $("timeoutRange").value = t;
  syncActiveChips();
  refreshPermissionAndReadiness();
}

function renderProfileTabs() {
  const wrap = $("profileTabs");
  if (!wrap) return;
  wrap.innerHTML = "";

  profilesState.forEach((prof) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "profile-tab";
    btn.textContent = prof.name;
    btn.dataset.active = prof.id === activeProfileId ? "true" : "false";
    btn.addEventListener("click", () => {
      if (prof.id === activeProfileId) return;
      switchProfile(prof.id);
    });
    wrap.appendChild(btn);
  });

  $("addProfile").disabled = profilesState.length >= MAX_PROFILES;
  $("deleteProfile").disabled = profilesState.length <= 1;
}

function buildStoragePayloadFromActive() {
  const active = getActiveProfileObj();
  const cleanProfiles = profilesState.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
    prompt: p.prompt,
    timeout: p.timeout,
  }));
  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    prompt: active.prompt,
    timeout: active.timeout,
    visionMode: $("visionMode").checked,
    translationPreview: $("translationPreview").checked,
    shortcutEnabled: $("shortcutEnabled").checked,
    profiles: cleanProfiles,
    activeProfileId: active.id,
  };
}

function switchProfile(targetId) {
  const prev = getActiveProfileObj();
  commitFormIntoCurrentProfile();
  // Drop untouched blank draft profiles instead of persisting empty ghost profiles
  if (prev && prev._unsavedDraft && !prev.apiKey && profilesState.length > 1) {
    profilesState = profilesState.filter((p) => p.id !== prev.id);
  }
  activeProfileId = targetId;
  const next = getActiveProfileObj();
  if (!next) return;
  populateFormFromProfile(next);
  renderProfileTabs();

  const pattern = originPatternFor(next.baseUrl);
  if (pattern && chrome.permissions && chrome.permissions.request) {
    try {
      chrome.permissions.request({ origins: [pattern] }, () => {
        void chrome.runtime.lastError;
        refreshPermissionAndReadiness();
      });
    } catch (e) {}
  }

  writeLocalConfig(buildStoragePayloadFromActive(), (err) => {
    if (err) {
      $("status").textContent = "Failed to switch profile: " + err.message;
      $("status").style.color = "var(--red)";
      return;
    }
    $("status").textContent = `Switched to "${next.name}"`;
    $("status").style.color = "var(--green)";
    setTimeout(() => {
      $("status").textContent = "";
    }, 1800);
  });
}

function addNewProfile() {
  if (profilesState.length >= MAX_PROFILES) return;
  commitFormIntoCurrentProfile();
  const nextNum = profilesState.length + 1;
  const newProf = {
    id: "prof_" + Date.now(),
    name: `Profile ${nextNum}`,
    baseUrl: DEFAULTS.baseUrl,
    apiKey: "",
    model: DEFAULTS.model,
    prompt: DEFAULTS.prompt,
    timeout: DEFAULTS.timeout,
    _unsavedDraft: true,
  };
  profilesState.push(newProf);
  activeProfileId = newProf.id;
  populateFormFromProfile(newProf);
  renderProfileTabs();
  $("profileName").focus();
  $("profileName").select();
}

function deleteCurrentProfile() {
  if (profilesState.length <= 1) return;
  profilesState = profilesState.filter((p) => p.id !== activeProfileId);
  activeProfileId = profilesState[0].id;
  const next = getActiveProfileObj();
  populateFormFromProfile(next);
  renderProfileTabs();

  writeLocalConfig(buildStoragePayloadFromActive(), (err) => {
    if (err) {
      $("status").textContent = "Failed to delete profile: " + err.message;
      $("status").style.color = "var(--red)";
      return;
    }
    $("status").textContent = "Profile deleted";
    $("status").style.color = "var(--muted)";
    setTimeout(() => {
      $("status").textContent = "";
    }, 1600);
  });
}

// ═══════════════════════════════════════════════════════════════
// Active Chip Highlighting & Live Permission / Readiness Status
// ═══════════════════════════════════════════════════════════════
function syncActiveChips() {
  const url = currentBaseUrl().toLowerCase();
  document.querySelectorAll(".provider-chip").forEach((chip) => {
    const chipUrl = (chip.dataset.url || "").toLowerCase();
    chip.dataset.active = chipUrl === url ? "true" : "false";
  });

  const promptVal = $("prompt").value.trim();
  document.querySelectorAll(".tone-chip").forEach((chip) => {
    chip.dataset.active = chip.dataset.tone === promptVal ? "true" : "false";
  });
}

function refreshPermissionAndReadiness() {
  const reqSeq = ++permCheckSeq;
  const rawUrl = $("baseUrl").value.trim() || DEFAULTS.baseUrl;
  const normalized = normalizeBaseUrl(rawUrl);
  const pattern = originPatternFor(normalized);
  const hasKey = Boolean($("apiKey").value.trim());

  const permBadge = $("permBadge");
  const grantBtn = $("grant");
  const readinessBadge = $("readinessBadge");
  const readinessText = $("readinessText");

  if (!pattern) {
    permBadge.textContent = "Invalid URL";
    permBadge.dataset.tone = "error";
    delete grantBtn.dataset.attention;
    readinessBadge.dataset.tone = "warn";
    readinessText.textContent = "Invalid Base URL";
    return;
  }

  const host = hostLabelFor(normalized);

  if (!chrome.permissions || !chrome.permissions.contains) {
    permBadge.textContent = `Access active · ${host}`;
    permBadge.dataset.tone = "ok";
    delete grantBtn.dataset.attention;
    readinessBadge.dataset.tone = hasKey ? "ok" : "warn";
    readinessText.textContent = hasKey ? "Ready" : "Missing API Key";
    return;
  }

  chrome.permissions.contains({ origins: [pattern] }, (granted) => {
    void chrome.runtime.lastError;
    if (reqSeq !== permCheckSeq) return;
    if (granted) {
      permBadge.textContent = `✓ Access active · ${host}`;
      permBadge.dataset.tone = "ok";
      grantBtn.textContent = "Host Access Active";
      delete grantBtn.dataset.attention;
    } else {
      permBadge.textContent = `Needs access · ${host}`;
      permBadge.dataset.tone = "warn";
      grantBtn.textContent = `Allow (${host})`;
      grantBtn.dataset.attention = "true";
    }

    if (!hasKey) {
      readinessBadge.dataset.tone = "warn";
      readinessText.textContent = "Missing API Key";
    } else if (!granted) {
      readinessBadge.dataset.tone = "warn";
      readinessText.textContent = "Needs Host Access";
    } else {
      readinessBadge.dataset.tone = "ok";
      readinessText.textContent = "Ready";
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Load & Save Settings
// ═══════════════════════════════════════════════════════════════
async function loadSettings() {
  try {
    const data = await loadConfigWithMigration();

    $("visionMode").checked = data.visionMode !== false;
    $("translationPreview").checked = data.translationPreview !== false;
    $("shortcutEnabled").checked = data.shortcutEnabled !== false;

    const resolved = ensureValidProfiles(data);
    profilesState = resolved.profiles;
    activeProfileId = resolved.activeId;

    populateFormFromProfile(getActiveProfileObj());
    renderProfileTabs();
  } catch (e) {
    console.error("[X AI Reply] Storage load error:", e);
    $("status").textContent = "Failed to load settings.";
    $("status").style.color = "var(--red)";
  }
}

let saveResetTimer = null;

function saveSettings() {
  commitFormIntoCurrentProfile();
  const active = getActiveProfileObj();
  if (active) delete active._unsavedDraft;
  populateFormFromProfile(active);
  renderProfileTabs();

  const payload = buildStoragePayloadFromActive();

  const pattern = originPatternFor(payload.baseUrl);
  if (pattern && chrome.permissions && chrome.permissions.request) {
    try {
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        void chrome.runtime.lastError;
        if (granted) {
          showResultBox($("grantStatus"), `Access active for ${pattern}`, "ok");
        }
        refreshPermissionAndReadiness();
      });
    } catch (e) {}
  }

  writeLocalConfig(payload, (err) => {
    const status = $("status");
    const saveBtn = $("save");
    const saveLabel = $("saveLabel");

    if (err) {
      status.textContent = "Failed to save: " + err.message;
      status.style.color = "var(--red)";
      return;
    }

    saveBtn.dataset.saved = "true";
    saveLabel.textContent = "Saved";
    status.textContent = `Profile "${active.name}" saved`;
    status.style.color = "var(--green)";
    refreshPermissionAndReadiness();

    if (saveResetTimer) clearTimeout(saveResetTimer);
    saveResetTimer = setTimeout(() => {
      delete saveBtn.dataset.saved;
      saveLabel.textContent = "Save Settings";
      status.textContent = "";
    }, 2200);
  });
}

function saveFeatureTogglesQuick() {
  writeLocalConfig(
    {
      visionMode: $("visionMode").checked,
      translationPreview: $("translationPreview").checked,
      shortcutEnabled: $("shortcutEnabled").checked,
    },
    (err) => {
      if (err) {
        $("status").textContent = "Failed to save toggle: " + err.message;
        $("status").style.color = "var(--red)";
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════
// Explicit Host Permission & Connection Test
// ═══════════════════════════════════════════════════════════════
function grantHostPermission() {
  const out = $("grantStatus");
  const btn = $("grant");
  const baseUrl = currentBaseUrl();
  $("baseUrl").value = baseUrl;
  const pattern = originPatternFor(baseUrl);

  if (!pattern) {
    showResultBox(out, "Invalid Base URL: " + baseUrl, "error");
    refreshPermissionAndReadiness();
    return;
  }

  if (!chrome.permissions || !chrome.permissions.request) {
    showResultBox(out, "Permissions API is not available in this browser.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Requesting…";
  showResultBox(out, "", "ok");

  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      showResultBox(out, chrome.runtime.lastError.message, "error");
      refreshPermissionAndReadiness();
      return;
    }
    if (granted) {
      showResultBox(out, "✓ Access granted for " + pattern, "ok");
    } else {
      showResultBox(out, "Access denied. Requests to " + pattern + " will be blocked.", "warn");
    }
    refreshPermissionAndReadiness();
  });
}

function testConnection() {
  const out = $("testStatus");
  const btn = $("test");
  const baseUrl = currentBaseUrl();
  $("baseUrl").value = baseUrl;
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim() || DEFAULTS.model;
  const timeoutMs = clampTimeout($("timeout").value) * 1000;
  const pattern = originPatternFor(baseUrl);
  const idleLabel = "Test API Connection";

  if (!pattern) {
    showResultBox(out, "Invalid Base URL: " + baseUrl, "error");
    return;
  }

  if (!apiKey) {
    showResultBox(out, "API key is empty. Please enter your API key first.", "warn");
    $("apiKey").focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = "Testing…";
  showResultBox(out, "", "ok");

  let settled = false;
  const finish = (text, tone) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    btn.disabled = false;
    btn.textContent = idleLabel;
    showResultBox(out, text, tone);
    refreshPermissionAndReadiness();
  };

  const guard = setTimeout(() => {
    finish("Timed out waiting for background worker response. Try reloading the extension.", "error");
  }, timeoutMs + 15000);

  const dispatchTest = () => {
    chrome.runtime.sendMessage(
      {
        action: "testConnection",
        endpoint: buildEndpoint(baseUrl),
        apiKey,
        model,
        timeoutMs,
      },
      (res) => {
        if (chrome.runtime.lastError) {
          finish("Runtime error: " + chrome.runtime.lastError.message, "error");
          return;
        }
        if (!res) {
          finish("Background worker did not respond. Reload the extension and try again.", "error");
          return;
        }
        if (res.code === "no_permission" || res.code === "failed_to_fetch") {
          finish(res.error, "error");
          return;
        }
        if (!res.ok) {
          const upstream = extractUpstreamError(res.data);
          finish(`HTTP ${res.status} — ${upstream}`, "error");
          return;
        }

        const msgObj = res.data?.choices?.[0]?.message;
        const contentStr = Array.isArray(msgObj?.content)
          ? msgObj.content
              .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
              .filter(Boolean)
              .join(" ")
          : msgObj?.content;
        const rawSample =
          contentStr ||
          res.data?.choices?.[0]?.text ||
          (msgObj?.reasoning_content ? "(reasoning model active)" : "");
        const cleanSample = String(rawSample || "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
          .trim()
          .slice(0, 60);
        const latencyLabel = res.latencyMs ? ` · ${res.latencyMs} ms` : "";

        finish(
          `✓ Connected (HTTP ${res.status}${latencyLabel})\nModel: ${model}${cleanSample ? ` · Reply: "${cleanSample}"` : ""}`,
          "ok"
        );
      }
    );
  };

  if (chrome.permissions && chrome.permissions.request) {
    chrome.permissions.request({ origins: [pattern] }, (granted) => {
      void chrome.runtime.lastError;
      if (!granted) {
        finish(`Host access to ${pattern} was denied.`, "warn");
        return;
      }
      dispatchTest();
    });
  } else {
    dispatchTest();
  }
}

// ═══════════════════════════════════════════════════════════════
// Event Wiring
// ═══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  $("save").addEventListener("click", saveSettings);
  $("grant").addEventListener("click", grantHostPermission);
  $("test").addEventListener("click", testConnection);
  $("addProfile").addEventListener("click", addNewProfile);
  $("deleteProfile").addEventListener("click", deleteCurrentProfile);

  $("profileName").addEventListener("input", () => {
    const cur = getActiveProfileObj();
    if (cur) {
      cur.name = $("profileName").value.trim() || "Profile";
      const activeTab = $("profileTabs")?.querySelector('.profile-tab[data-active="true"]');
      if (activeTab) {
        activeTab.textContent = cur.name;
      } else {
        renderProfileTabs();
      }
    }
  });

  $("visionMode").addEventListener("change", saveFeatureTogglesQuick);
  $("translationPreview").addEventListener("change", saveFeatureTogglesQuick);
  $("shortcutEnabled").addEventListener("change", saveFeatureTogglesQuick);

  $("clearMemory").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearReplyMemory" }, () => {
      void chrome.runtime.lastError;
      $("memoryStatus").textContent = "✓ Reply variety memory cleared.";
      $("memoryStatus").style.color = "var(--green)";
      setTimeout(() => {
        $("memoryStatus").textContent =
          "Anti-Repetition Memory is active automatically (stores your last 8 replies locally so sentence structures stay fresh and varied).";
        $("memoryStatus").style.color = "";
      }, 2400);
    });
  });

  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("eyeOpenIcon").style.display = showing ? "" : "none";
    $("eyeClosedIcon").style.display = showing ? "none" : "";
  });

  $("timeoutRange").addEventListener("input", (e) => {
    $("timeout").value = e.target.value;
  });
  $("timeout").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) {
      $("timeoutRange").value = Math.min(Math.max(n, 5), 180);
    }
  });

  document.querySelectorAll(".provider-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const targetUrl = chip.dataset.url;
      const modelHint = chip.dataset.modelHint;
      $("baseUrl").value = targetUrl;
      if (modelHint) {
        $("model").placeholder = modelHint;
        const knownHints = [...document.querySelectorAll(".provider-chip")].map(
          (c) => c.dataset.modelHint
        );
        const curModel = $("model").value.trim();
        if (!curModel || knownHints.includes(curModel)) {
          $("model").value = modelHint;
        }
      }
      syncActiveChips();
      refreshPermissionAndReadiness();
    });
  });

  document.querySelectorAll(".tone-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("prompt").value = chip.dataset.tone;
      syncActiveChips();
    });
  });

  $("resetPrompt").addEventListener("click", () => {
    $("prompt").value = DEFAULTS.prompt;
    syncActiveChips();
  });

  let permDebounce = null;
  $("baseUrl").addEventListener("input", () => {
    syncActiveChips();
    clearTimeout(permDebounce);
    permDebounce = setTimeout(refreshPermissionAndReadiness, 220);
  });

  $("apiKey").addEventListener("input", refreshPermissionAndReadiness);
  $("prompt").addEventListener("input", syncActiveChips);

  // Stay live-synced if user switches profile, tone, or feature toggles from Toolbar Popup
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || selfWriteDepth > 0) return;
      const syncableKeys = [
        "baseUrl",
        "apiKey",
        "model",
        "prompt",
        "timeout",
        "visionMode",
        "translationPreview",
        "shortcutEnabled",
        "profiles",
        "activeProfileId",
      ];
      if (!syncableKeys.some((k) => Object.prototype.hasOwnProperty.call(changes, k))) return;
      loadSettings();
    });
  } catch (e) {}
});
