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

let currentConfig = { ...DEFAULTS };
let profilesList = [];
let activeProfileId = "";
let toneHintTimer = null;
let permCheckSeq = 0;
let selfWriteDepth = 0;

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

function buildEndpoint(baseUrl) {
  let url = normalizeBaseUrl(baseUrl || DEFAULTS.baseUrl);
  if (!/\/chat\/completions(\?.*)?$/i.test(url)) {
    url += "/chat/completions";
  }
  return url;
}

function parseBaseOrigin(baseUrl) {
  try {
    const u = new URL(normalizeBaseUrl(baseUrl));
    if (!/^https?:$/.test(u.protocol)) return null;
    return { host: u.host, pattern: u.origin + "/*" };
  } catch (e) {
    return null;
  }
}

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
  if (syncData && (syncData.apiKey || (Array.isArray(syncData.profiles) && syncData.profiles.length > 0))) {
    writeLocalConfig(merged);
  }
  return merged;
}

function extractUpstreamError(data) {
  if (!data) return "(no details)";
  const err = data.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
    if (typeof err.error === "string" && err.error.trim()) return err.error.trim();
    try {
      return JSON.stringify(err).slice(0, 180);
    } catch (e) {}
  }
  if (typeof data._raw === "string" && data._raw.trim()) return data._raw.trim().slice(0, 180);
  return "(no details)";
}

function setFeedback(text, tone) {
  const el = $("quickFeedback");
  if (!text) {
    el.textContent = "";
    delete el.dataset.visible;
    return;
  }
  el.textContent = text;
  el.dataset.tone = tone || "ok";
  el.dataset.visible = "true";
}

function syncTonePills(promptValue) {
  const clean = String(promptValue || "").trim();
  document.querySelectorAll(".popup-tone").forEach((btn) => {
    btn.dataset.active = btn.dataset.tone === clean ? "true" : "false";
  });
}

function syncFeatureButtons() {
  $("toggleVision").dataset.on = currentConfig.visionMode !== false ? "true" : "false";
  $("toggleTranslate").dataset.on =
    currentConfig.translationPreview !== false ? "true" : "false";
  $("toggleShortcut").dataset.on =
    currentConfig.shortcutEnabled !== false ? "true" : "false";
}

function renderProfileStrip() {
  const strip = $("popupProfiles");
  if (!strip) return;
  strip.innerHTML = "";

  if (!Array.isArray(profilesList) || profilesList.length <= 1) {
    strip.style.display = "none";
    return;
  }

  strip.style.display = "flex";
  profilesList.forEach((prof) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prof-pill";
    const displayName =
      prof.name === "Profil Utama" ? "Main Profile" : prof.name || "Profile";
    btn.textContent = displayName;
    btn.dataset.active = prof.id === activeProfileId ? "true" : "false";
    btn.addEventListener("click", () => {
      if (prof.id === activeProfileId) return;
      activatePopupProfile(prof);
    });
    strip.appendChild(btn);
  });
}

function activatePopupProfile(prof) {
  activeProfileId = prof.id;
  currentConfig.baseUrl = normalizeBaseUrl(prof.baseUrl || DEFAULTS.baseUrl);
  currentConfig.apiKey = prof.apiKey || "";
  currentConfig.model = prof.model || DEFAULTS.model;
  currentConfig.prompt = prof.prompt !== undefined ? prof.prompt : DEFAULTS.prompt;
  currentConfig.timeout = clampTimeout(prof.timeout);

  const displayName =
    prof.name === "Profil Utama" ? "Main Profile" : prof.name || "Profile";

  // Persist first so switching never gets interrupted if the new profile needs host permission
  writeLocalConfig(
    {
      baseUrl: currentConfig.baseUrl,
      apiKey: currentConfig.apiKey,
      model: currentConfig.model,
      prompt: currentConfig.prompt,
      timeout: currentConfig.timeout,
      activeProfileId: prof.id,
    },
    (err) => {
      if (err) {
        setFeedback("Failed to switch profile: " + err.message, "error");
        return;
      }
      renderProfileStrip();
      renderState();
      setFeedback(`✓ Switched to "${displayName}"`, "ok");
    }
  );
}

function renderState() {
  const reqSeq = ++permCheckSeq;
  const base = normalizeBaseUrl(currentConfig.baseUrl || DEFAULTS.baseUrl);
  const parsed = parseBaseOrigin(base);
  const hasKey = Boolean(currentConfig.apiKey && currentConfig.apiKey.trim());

  $("hostValue").textContent = parsed ? parsed.host : "Invalid URL";
  $("modelValue").textContent = currentConfig.model || DEFAULTS.model;

  if (hasKey) {
    $("keyValue").textContent = "✓ Configured";
    $("keyValue").dataset.tone = "ok";
  } else {
    $("keyValue").textContent = "Not set";
    $("keyValue").dataset.tone = "warn";
  }

  syncTonePills(currentConfig.prompt);
  syncFeatureButtons();

  const badge = $("statusBadge");
  const statusText = $("statusText");
  const permBanner = $("permBanner");

  if (!parsed) {
    badge.dataset.tone = "error";
    statusText.textContent = "Invalid URL";
    delete permBanner.dataset.visible;
    return;
  }

  if (!chrome.permissions || !chrome.permissions.contains) {
    delete permBanner.dataset.visible;
    badge.dataset.tone = hasKey ? "ok" : "warn";
    statusText.textContent = hasKey ? "Ready" : "Set API Key";
    return;
  }

  chrome.permissions.contains({ origins: [parsed.pattern] }, (granted) => {
    void chrome.runtime.lastError;
    if (reqSeq !== permCheckSeq) return;
    if (!granted) {
      $("permBannerText").textContent = `Host access to ${parsed.host} is not active.`;
      permBanner.dataset.visible = "true";
      badge.dataset.tone = "warn";
      statusText.textContent = "Needs Access";
      return;
    }

    delete permBanner.dataset.visible;
    if (hasKey) {
      badge.dataset.tone = "ok";
      statusText.textContent = "Ready";
    } else {
      badge.dataset.tone = "warn";
      statusText.textContent = "Set API Key";
    }
  });
}

async function loadPopupData() {
  const data = await loadConfigWithMigration();
  currentConfig = {
    baseUrl: normalizeBaseUrl(data.baseUrl || DEFAULTS.baseUrl),
    apiKey: data.apiKey || "",
    model: data.model || DEFAULTS.model,
    prompt: data.prompt !== undefined ? upgradeLegacyPrompt(data.prompt) : DEFAULTS.prompt,
    timeout: clampTimeout(data.timeout),
    visionMode: data.visionMode !== false,
    translationPreview: data.translationPreview !== false,
    shortcutEnabled: data.shortcutEnabled !== false,
  };

  if (Array.isArray(data.profiles) && data.profiles.length > 0) {
    profilesList = data.profiles.map((p) => ({
      ...p,
      baseUrl: normalizeBaseUrl(p.baseUrl || DEFAULTS.baseUrl),
      prompt: p.prompt !== undefined ? upgradeLegacyPrompt(p.prompt) : DEFAULTS.prompt,
      timeout: clampTimeout(p.timeout),
    }));
    activeProfileId =
      profilesList.some((p) => p.id === data.activeProfileId)
        ? data.activeProfileId
        : profilesList[0].id;
  } else {
    profilesList = [];
    activeProfileId = "";
  }

  renderProfileStrip();
  renderState();
}

function toggleBooleanFlag(key) {
  currentConfig[key] = !currentConfig[key];
  syncFeatureButtons();
  writeLocalConfig({ [key]: currentConfig[key] }, (err) => {
    if (err) {
      setFeedback("Failed to save setting: " + err.message, "error");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadPopupData();

  $("open-options").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(`chrome-extension://${chrome.runtime.id}/options.html`);
    }
  });

  $("toggleVision").addEventListener("click", () => toggleBooleanFlag("visionMode"));
  $("toggleTranslate").addEventListener("click", () =>
    toggleBooleanFlag("translationPreview")
  );
  $("toggleShortcut").addEventListener("click", () =>
    toggleBooleanFlag("shortcutEnabled")
  );

  $("quickGrant").addEventListener("click", () => {
    const parsed = parseBaseOrigin(currentConfig.baseUrl);
    if (!parsed || !chrome.permissions || !chrome.permissions.request) return;

    chrome.permissions.request({ origins: [parsed.pattern] }, (granted) => {
      void chrome.runtime.lastError;
      if (granted) {
        setFeedback(`✓ Host access granted for ${parsed.host}`, "ok");
      } else {
        setFeedback("Host access was denied.", "warn");
      }
      renderState();
    });
  });

  document.querySelectorAll(".popup-tone").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextTone = btn.dataset.tone;
      currentConfig.prompt = nextTone;
      syncTonePills(nextTone);

      const patch = { prompt: nextTone };
      if (Array.isArray(profilesList) && profilesList.length > 0) {
        const curProf = profilesList.find((p) => p.id === activeProfileId);
        if (curProf) {
          curProf.prompt = nextTone;
          patch.profiles = profilesList;
        }
      }

      writeLocalConfig(patch, (err) => {
        if (err) {
          setFeedback("Failed to save tone: " + err.message, "error");
          return;
        }
        const hint = $("toneSavedHint");
        hint.dataset.show = "true";
        clearTimeout(toneHintTimer);
        toneHintTimer = setTimeout(() => {
          delete hint.dataset.show;
        }, 1500);
      });
    });
  });

  $("quickTest").addEventListener("click", () => {
    const btn = $("quickTest");
    const parsed = parseBaseOrigin(currentConfig.baseUrl);

    if (!parsed) {
      setFeedback("Invalid Base URL. Check Settings.", "error");
      return;
    }
    if (!currentConfig.apiKey || !currentConfig.apiKey.trim()) {
      setFeedback("API Key is not set. Click Open Settings.", "warn");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Testing…";
    setFeedback("", "ok");

    const runPing = () => {
      chrome.runtime.sendMessage(
        {
          action: "testConnection",
          endpoint: buildEndpoint(currentConfig.baseUrl),
          apiKey: currentConfig.apiKey.trim(),
          model: currentConfig.model || DEFAULTS.model,
          timeoutMs: clampTimeout(currentConfig.timeout) * 1000,
        },
        (res) => {
          btn.disabled = false;
          btn.textContent = "Test API";

          if (chrome.runtime.lastError) {
            setFeedback("Runtime error: " + chrome.runtime.lastError.message, "error");
            return;
          }
          if (!res) {
            setFeedback("Background worker did not respond.", "error");
            return;
          }
          if (!res.ok) {
            const msg = res.error || `HTTP ${res.status} — ${extractUpstreamError(res.data)}`;
            setFeedback(msg, "error");
            return;
          }
          const ms = res.latencyMs ? ` · ${res.latencyMs} ms` : "";
          setFeedback(`✓ Connected (HTTP ${res.status}${ms})`, "ok");
          renderState();
        }
      );
    };

    // Check permission via contains() first so Test API never triggers a dialog that closes the popup mid-test
    if (chrome.permissions && chrome.permissions.contains) {
      chrome.permissions.contains({ origins: [parsed.pattern] }, (granted) => {
        void chrome.runtime.lastError;
        if (!granted) {
          btn.disabled = false;
          btn.textContent = "Test API";
          renderState();
          setFeedback(
            `Host access to ${parsed.host} is required first — click "Allow Host" above.`,
            "warn"
          );
          return;
        }
        runPing();
      });
    } else {
      runPing();
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || selfWriteDepth > 0) return;
      loadPopupData();
    });
  } catch (e) {}
});
