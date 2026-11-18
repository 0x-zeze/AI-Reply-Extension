const DEFAULTS = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "",
  model: "grok-4.6-high",
  prompt:
    "all lowercase, under 10 words, dry and effortless, sound like a real person typing from phone, no emojis",
  timeout: 60,
};

let currentConfig = { ...DEFAULTS };
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
  if (!data) return "(tanpa detail)";
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
  return "(tanpa detail)";
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

function renderState() {
  const base = (currentConfig.baseUrl || DEFAULTS.baseUrl).trim();
  const parsed = parseBaseOrigin(base);
  const hasKey = Boolean(currentConfig.apiKey && currentConfig.apiKey.trim());

  $("hostValue").textContent = parsed ? parsed.host : "URL tidak valid";
  $("modelValue").textContent = currentConfig.model || DEFAULTS.model;

  if (hasKey) {
    $("keyValue").textContent = "✓ Terkonfigurasi";
    $("keyValue").dataset.tone = "ok";
  } else {
    $("keyValue").textContent = "Belum diisi";
    $("keyValue").dataset.tone = "warn";
  }

  syncTonePills(currentConfig.prompt);

  const badge = $("statusBadge");
  const statusText = $("statusText");
  const permBanner = $("permBanner");

  if (!parsed) {
    badge.dataset.tone = "error";
    statusText.textContent = "URL Invalid";
    delete permBanner.dataset.visible;
    return;
  }

  if (!chrome.permissions || !chrome.permissions.contains) {
    delete permBanner.dataset.visible;
    badge.dataset.tone = hasKey ? "ok" : "warn";
    statusText.textContent = hasKey ? "Siap" : "Isi API Key";
    return;
  }

  chrome.permissions.contains({ origins: [parsed.pattern] }, (granted) => {
    void chrome.runtime.lastError;
    if (!granted) {
      $("permBannerText").textContent = `Izin akses ke ${parsed.host} belum aktif.`;
      permBanner.dataset.visible = "true";
      badge.dataset.tone = "warn";
      statusText.textContent = "Perlu Izin";
      return;
    }

    delete permBanner.dataset.visible;
    if (hasKey) {
      badge.dataset.tone = "ok";
      statusText.textContent = "Siap";
    } else {
      badge.dataset.tone = "warn";
      statusText.textContent = "Isi API Key";
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
      prompt: data.prompt !== undefined ? data.prompt : DEFAULTS.prompt,
      timeout: Number(data.timeout) > 0 ? Number(data.timeout) : DEFAULTS.timeout,
    };
    renderState();
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

  $("quickGrant").addEventListener("click", () => {
    const parsed = parseBaseOrigin(currentConfig.baseUrl);
    if (!parsed || !chrome.permissions || !chrome.permissions.request) return;

    chrome.permissions.request({ origins: [parsed.pattern] }, (granted) => {
      void chrome.runtime.lastError;
      if (granted) {
        setFeedback(`✓ Izin diberikan untuk ${parsed.host}`, "ok");
      } else {
        setFeedback("Izin ditolak.", "warn");
      }
      renderState();
    });
  });

  document.querySelectorAll(".popup-tone").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextTone = btn.dataset.tone;
      currentConfig.prompt = nextTone;
      syncTonePills(nextTone);
      chrome.storage.sync.set({ prompt: nextTone }, () => {
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
      setFeedback("Base URL tidak valid. Periksa di Settings.", "error");
      return;
    }
    if (!currentConfig.apiKey || !currentConfig.apiKey.trim()) {
      setFeedback("API Key belum diisi. Klik Buka Settings.", "warn");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Menguji…";
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
          btn.textContent = "Tes API";

          if (chrome.runtime.lastError) {
            setFeedback("Runtime error: " + chrome.runtime.lastError.message, "error");
            return;
          }
          if (!res) {
            setFeedback("Background tidak merespon.", "error");
            return;
          }
          if (!res.ok) {
            const msg = res.error || `HTTP ${res.status} — ${extractUpstreamError(res.data)}`;
            setFeedback(msg, "error");
            return;
          }
          const ms = res.latencyMs ? ` · ${res.latencyMs} ms` : "";
          setFeedback(`✓ Koneksi aktif (HTTP ${res.status}${ms})`, "ok");
          renderState();
        }
      );
    };

    if (chrome.permissions && chrome.permissions.request) {
      chrome.permissions.request({ origins: [parsed.pattern] }, (granted) => {
        void chrome.runtime.lastError;
        if (!granted) {
          btn.disabled = false;
          btn.textContent = "Tes API";
          setFeedback(`Izin akses ke ${parsed.host} ditolak.`, "warn");
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
