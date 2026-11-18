const DEFAULTS = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "",
  model: "grok-4.6-high",
  prompt:
    "all lowercase, under 10 words, dry and effortless, sound like a real person typing from phone, no emojis",
  timeout: 60,
};

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
  if (!data) return "(tanpa detail)";
  const err = data.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
    if (typeof err.error === "string" && err.error.trim()) return err.error.trim();
    if (typeof err.code === "string" && err.code.trim()) return `Kode: ${err.code}`;
    try {
      return JSON.stringify(err).slice(0, 240);
    } catch (e) {}
  }
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  if (typeof data._raw === "string" && data._raw.trim()) return data._raw.trim().slice(0, 240);
  return "(tanpa detail)";
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
  const rawUrl = $("baseUrl").value.trim() || DEFAULTS.baseUrl;
  const normalized = normalizeBaseUrl(rawUrl);
  const pattern = originPatternFor(normalized);
  const hasKey = Boolean($("apiKey").value.trim());

  const permBadge = $("permBadge");
  const grantBtn = $("grant");
  const readinessBadge = $("readinessBadge");
  const readinessText = $("readinessText");

  if (!pattern) {
    permBadge.textContent = "URL tidak valid";
    permBadge.dataset.tone = "error";
    delete grantBtn.dataset.attention;
    readinessBadge.dataset.tone = "warn";
    readinessText.textContent = "Base URL tidak valid";
    return;
  }

  const host = hostLabelFor(normalized);

  if (!chrome.permissions || !chrome.permissions.contains) {
    permBadge.textContent = `Izin aktif · ${host}`;
    permBadge.dataset.tone = "ok";
    delete grantBtn.dataset.attention;
    readinessBadge.dataset.tone = hasKey ? "ok" : "warn";
    readinessText.textContent = hasKey ? "Siap digunakan" : "API Key belum diisi";
    return;
  }

  chrome.permissions.contains({ origins: [pattern] }, (granted) => {
    void chrome.runtime.lastError;
    if (granted) {
      permBadge.textContent = `✓ Izin aktif · ${host}`;
      permBadge.dataset.tone = "ok";
      grantBtn.textContent = "Izin Host Aktif";
      delete grantBtn.dataset.attention;
    } else {
      permBadge.textContent = `Perlu izin · ${host}`;
      permBadge.dataset.tone = "warn";
      grantBtn.textContent = `Beri Izin (${host})`;
      grantBtn.dataset.attention = "true";
    }

    if (!hasKey) {
      readinessBadge.dataset.tone = "warn";
      readinessText.textContent = "API Key belum diisi";
    } else if (!granted) {
      readinessBadge.dataset.tone = "warn";
      readinessText.textContent = "Perlu izin host";
    } else {
      readinessBadge.dataset.tone = "ok";
      readinessText.textContent = "Siap digunakan";
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Load & Save Settings
// ═══════════════════════════════════════════════════════════════
function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (data) => {
    if (chrome.runtime.lastError) {
      console.error("[Yap Extension] Storage load error:", chrome.runtime.lastError.message);
      $("status").textContent = "Gagal memuat settings.";
      $("status").style.color = "var(--red)";
      return;
    }
    const timeoutVal = clampTimeout(data.timeout);
    $("baseUrl").value = data.baseUrl || DEFAULTS.baseUrl;
    $("apiKey").value = data.apiKey || "";
    $("model").value = data.model || DEFAULTS.model;
    $("prompt").value = data.prompt !== undefined ? data.prompt : DEFAULTS.prompt;
    $("timeout").value = timeoutVal;
    $("timeoutRange").value = timeoutVal;

    syncActiveChips();
    refreshPermissionAndReadiness();
  });
}

let saveResetTimer = null;

function saveSettings() {
  const payload = {
    baseUrl: currentBaseUrl(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    prompt: $("prompt").value.trim(),
    timeout: clampTimeout($("timeout").value),
  };

  // Sinkronkan input form agar selalu mencerminkan nilai yang disimpan
  $("baseUrl").value = payload.baseUrl;
  $("apiKey").value = payload.apiKey;
  $("model").value = payload.model;
  $("timeout").value = payload.timeout;
  $("timeoutRange").value = payload.timeout;
  syncActiveChips();

  // Manfaatkan klik user gesture untuk langsung meminta izin host jika belum ada
  const pattern = originPatternFor(payload.baseUrl);
  if (pattern && chrome.permissions && chrome.permissions.request) {
    try {
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        void chrome.runtime.lastError;
        if (granted) {
          showResultBox($("grantStatus"), `Izin aktif untuk ${pattern}`, "ok");
        }
        refreshPermissionAndReadiness();
      });
    } catch (e) {}
  }

  chrome.storage.sync.set(payload, () => {
    const status = $("status");
    const saveBtn = $("save");
    const saveLabel = $("saveLabel");

    if (chrome.runtime.lastError) {
      status.textContent = "Gagal menyimpan: " + chrome.runtime.lastError.message;
      status.style.color = "var(--red)";
      return;
    }

    saveBtn.dataset.saved = "true";
    saveLabel.textContent = "Tersimpan";
    status.textContent = "Pengaturan berhasil disimpan";
    status.style.color = "var(--green)";
    refreshPermissionAndReadiness();

    if (saveResetTimer) clearTimeout(saveResetTimer);
    saveResetTimer = setTimeout(() => {
      delete saveBtn.dataset.saved;
      saveLabel.textContent = "Simpan Pengaturan";
      status.textContent = "";
    }, 2200);
  });
}

// ═══════════════════════════════════════════════════════════════
// Explicit Host Permission Button
// ═══════════════════════════════════════════════════════════════
function grantHostPermission() {
  const out = $("grantStatus");
  const btn = $("grant");
  const baseUrl = currentBaseUrl();
  $("baseUrl").value = baseUrl;
  const pattern = originPatternFor(baseUrl);

  if (!pattern) {
    showResultBox(out, "Base URL tidak valid: " + baseUrl, "error");
    refreshPermissionAndReadiness();
    return;
  }

  if (!chrome.permissions || !chrome.permissions.request) {
    showResultBox(out, "API permissions tidak tersedia di browser ini.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Meminta izin…";
  showResultBox(out, "", "ok");

  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) {
      showResultBox(out, chrome.runtime.lastError.message, "error");
      refreshPermissionAndReadiness();
      return;
    }
    if (granted) {
      showResultBox(out, "✓ Izin diberikan untuk " + pattern, "ok");
    } else {
      showResultBox(out, "Izin ditolak. Request ke " + pattern + " akan diblokir.", "warn");
    }
    refreshPermissionAndReadiness();
  });
}

// ═══════════════════════════════════════════════════════════════
// Tes Koneksi API (dengan auto-request permission + timeout guard)
// ═══════════════════════════════════════════════════════════════
function testConnection() {
  const out = $("testStatus");
  const btn = $("test");
  const baseUrl = currentBaseUrl();
  $("baseUrl").value = baseUrl;
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim() || DEFAULTS.model;
  const timeoutMs = clampTimeout($("timeout").value) * 1000;
  const pattern = originPatternFor(baseUrl);
  const idleLabel = "Tes Koneksi API";

  if (!pattern) {
    showResultBox(out, "Base URL tidak valid: " + baseUrl, "error");
    return;
  }

  if (!apiKey) {
    showResultBox(out, "API key masih kosong. Masukkan API key terlebih dahulu.", "warn");
    $("apiKey").focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = "Menguji koneksi…";
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
    finish("Timeout menunggu respon dari service worker. Coba reload extension.", "error");
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
          finish("Background tidak membalas. Reload extension lalu coba lagi.", "error");
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
        const rawSample =
          msgObj?.content ||
          res.data?.choices?.[0]?.text ||
          (msgObj?.reasoning_content ? "(reasoning model aktif)" : "");
        const cleanSample = String(rawSample || "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim()
          .slice(0, 60);
        const latencyLabel = res.latencyMs ? ` · ${res.latencyMs} ms` : "";

        finish(
          `✓ Terhubung (HTTP ${res.status}${latencyLabel})\nModel: ${model}${cleanSample ? ` · Respon: "${cleanSample}"` : ""}`,
          "ok"
        );
      }
    );
  };

  if (chrome.permissions && chrome.permissions.request) {
    chrome.permissions.request({ origins: [pattern] }, (granted) => {
      void chrome.runtime.lastError;
      if (!granted) {
        finish(`Izin akses ke ${pattern} ditolak.`, "warn");
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

  // Toggle visibilitas API key
  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("eyeOpenIcon").style.display = showing ? "" : "none";
    $("eyeClosedIcon").style.display = showing ? "none" : "";
  });

  // Sinkronisasi slider & input angka timeout
  $("timeoutRange").addEventListener("input", (e) => {
    $("timeout").value = e.target.value;
  });
  $("timeout").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) {
      $("timeoutRange").value = Math.min(Math.max(n, 5), 180);
    }
  });

  // Preset provider
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

  // Preset tone prompt
  document.querySelectorAll(".tone-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("prompt").value = chip.dataset.tone;
      syncActiveChips();
    });
  });

  // Reset prompt default
  $("resetPrompt").addEventListener("click", () => {
    $("prompt").value = DEFAULTS.prompt;
    syncActiveChips();
  });

  // Live refresh status saat mengetik
  let permDebounce = null;
  $("baseUrl").addEventListener("input", () => {
    syncActiveChips();
    clearTimeout(permDebounce);
    permDebounce = setTimeout(refreshPermissionAndReadiness, 220);
  });

  $("apiKey").addEventListener("input", refreshPermissionAndReadiness);
  $("prompt").addEventListener("input", syncActiveChips);
});
