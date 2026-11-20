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

function $(id) {
  return document.getElementById(id);
}

function buildEndpoint(baseUrl) {
  let url = String(baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, "");
  if (!/\/chat\/completions(\?.*)?$/i.test(url)) {
    url += "/chat/completions";
  }
  return url;
}

function parseBaseOrigin(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    return { host: u.host, pattern: u.origin + "/*" };
  } catch (e) {
    return null;
  }
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
  currentConfig.baseUrl = prof.baseUrl || DEFAULTS.baseUrl;
  currentConfig.apiKey = prof.apiKey || "";
  currentConfig.model = prof.model || DEFAULTS.model;
  currentConfig.prompt = prof.prompt !== undefined ? prof.prompt : DEFAULTS.prompt;
  currentConfig.timeout = Number(prof.timeout) > 0 ? Number(prof.timeout) : DEFAULTS.timeout;

  const parsed = parseBaseOrigin(currentConfig.baseUrl);
  if (parsed && chrome.permissions && chrome.permissions.request) {
    try {
      chrome.permissions.request({ origins: [parsed.pattern] }, () => {
        void chrome.runtime.lastError;
        renderState();
      });
    } catch (e) {}
  }

  const displayName =
    prof.name === "Profil Utama" ? "Main Profile" : prof.name || "Profile";

  chrome.storage.sync.set(
    {
      baseUrl: currentConfig.baseUrl,
      apiKey: currentConfig.apiKey,
      model: currentConfig.model,
      prompt: currentConfig.prompt,
      timeout: currentConfig.timeout,
      activeProfileId: prof.id,
    },
    () => {
      void chrome.runtime.lastError;
      renderProfileStrip();
      renderState();
      setFeedback(`✓ Switched to "${displayName}"`, "ok");
    }
  );
}

function renderState() {
  const base = (currentConfig.baseUrl || DEFAULTS.baseUrl).trim();
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

function loadPopupData() {
  chrome.storage.sync.get(DEFAULTS, (data) => {
    if (chrome.runtime.lastError) return;
    currentConfig = {
      baseUrl: data.baseUrl || DEFAULTS.baseUrl,
      apiKey: data.apiKey || "",
      model: data.model || DEFAULTS.model,
      prompt: data.prompt !== undefined ? upgradeLegacyPrompt(data.prompt) : DEFAULTS.prompt,
      timeout: Number(data.timeout) > 0 ? Number(data.timeout) : DEFAULTS.timeout,
      visionMode: data.visionMode !== false,
      translationPreview: data.translationPreview !== false,
      shortcutEnabled: data.shortcutEnabled !== false,
    };

    if (Array.isArray(data.profiles) && data.profiles.length > 0) {
      profilesList = data.profiles.map((p) => ({
        ...p,
        prompt: p.prompt !== undefined ? upgradeLegacyPrompt(p.prompt) : DEFAULTS.prompt,
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
  });
}

function toggleBooleanFlag(key) {
  currentConfig[key] = !currentConfig[key];
  syncFeatureButtons();
  chrome.storage.sync.set({ [key]: currentConfig[key] }, () => {
    void chrome.runtime.lastError;
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

      chrome.storage.sync.set(patch, () => {
        if (chrome.runtime.lastError) return;
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
          timeoutMs: Math.min(Math.max(currentConfig.timeout, 5), 180) * 1000,
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

    if (chrome.permissions && chrome.permissions.request) {
      chrome.permissions.request({ origins: [parsed.pattern] }, (granted) => {
        void chrome.runtime.lastError;
        if (!granted) {
          btn.disabled = false;
          btn.textContent = "Test API";
          setFeedback(`Host access to ${parsed.host} was denied.`, "warn");
          return;
        }
        renderState();
        runPing();
      });
    } else {
      runPing();
    }
  });
});
