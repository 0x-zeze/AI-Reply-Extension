const MAX_PROFILES = 6;

const DEFAULTS = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "",
  model: "grok-4.6-high",
  prompt:
    "all lowercase, under 10 words, dry and effortless, sound like a real person typing from phone, no emojis",
  timeout: 60,
  visionMode: true,
  translationPreview: true,
  shortcutEnabled: true,
  profiles: null,
  activeProfileId: "",
};

let profilesState = [];
let activeProfileId = "";

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
// Multi-Profile Helpers & Seamless Migration
// ═══════════════════════════════════════════════════════════════
function ensureValidProfiles(data) {
  const fallbackProfile = {
    id: "prof_default",
    name: "Profil Utama",
    baseUrl: normalizeBaseUrl(data.baseUrl || DEFAULTS.baseUrl),
    apiKey: String(data.apiKey || "").trim(),
    model: String(data.model || DEFAULTS.model).trim(),
    prompt: data.prompt !== undefined ? String(data.prompt) : DEFAULTS.prompt,
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
    .map((p, idx) => ({
      id: String(p.id || `prof_${idx + 1}`),
      name: String(p.name || `Profil ${idx + 1}`).trim() || `Profil ${idx + 1}`,
      baseUrl: normalizeBaseUrl(p.baseUrl || DEFAULTS.baseUrl),
      apiKey: String(p.apiKey || "").trim(),
      model: String(p.model || DEFAULTS.model).trim(),
      prompt: p.prompt !== undefined ? String(p.prompt) : DEFAULTS.prompt,
      timeout: clampTimeout(p.timeout),
    }));

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
  cur.name = $("profileName").value.trim() || cur.name || "Profil";
  cur.baseUrl = currentBaseUrl();
  cur.apiKey = $("apiKey").value.trim();
  cur.model = $("model").value.trim() || DEFAULTS.model;
  cur.prompt = $("prompt").value.trim();
  cur.timeout = clampTimeout($("timeout").value);
}

function populateFormFromProfile(prof) {
  if (!prof) return;
  const t = clampTimeout(prof.timeout);
  $("profileName").value = prof.name || "Profil";
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
  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    prompt: active.prompt,
    timeout: active.timeout,
    visionMode: $("visionMode").checked,
    translationPreview: $("translationPreview").checked,
    shortcutEnabled: $("shortcutEnabled").checked,
    profiles: profilesState,
    activeProfileId: active.id,
  };
}

function switchProfile(targetId) {
  commitFormIntoCurrentProfile();
  activeProfileId = targetId;
  const next = getActiveProfileObj();
  populateFormFromProfile(next);
  renderProfileTabs();

  // Minta izin host bila domain baru belum diizinkan (langsung dalam klik user gesture)
  const pattern = originPatternFor(next.baseUrl);
  if (pattern && chrome.permissions && chrome.permissions.request) {
    try {
      chrome.permissions.request({ origins: [pattern] }, () => {
        void chrome.runtime.lastError;
        refreshPermissionAndReadiness();
      });
    } catch (e) {}
  }

  chrome.storage.sync.set(buildStoragePayloadFromActive(), () => {
    void chrome.runtime.lastError;
    $("status").textContent = `Profil "${next.name}" diaktifkan`;
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
    name: `Profil ${nextNum}`,
    baseUrl: DEFAULTS.baseUrl,
    apiKey: "",
    model: DEFAULTS.model,
    prompt: DEFAULTS.prompt,
    timeout: DEFAULTS.timeout,
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

  chrome.storage.sync.set(buildStoragePayloadFromActive(), () => {
    void chrome.runtime.lastError;
    $("status").textContent = "Profil dihapus";
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

    $("visionMode").checked = data.visionMode !== false;
    $("translationPreview").checked = data.translationPreview !== false;
    $("shortcutEnabled").checked = data.shortcutEnabled !== false;

    const resolved = ensureValidProfiles(data);
    profilesState = resolved.profiles;
    activeProfileId = resolved.activeId;

    populateFormFromProfile(getActiveProfileObj());
    renderProfileTabs();
  });
}

let saveResetTimer = null;

function saveSettings() {
  commitFormIntoCurrentProfile();
  const active = getActiveProfileObj();
  populateFormFromProfile(active);
  renderProfileTabs();

  const payload = buildStoragePayloadFromActive();

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
    status.textContent = `Profil "${active.name}" tersimpan`;
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

function saveFeatureTogglesQuick() {
  chrome.storage.sync.set(
    {
      visionMode: $("visionMode").checked,
      translationPreview: $("translationPreview").checked,
      shortcutEnabled: $("shortcutEnabled").checked,
    },
    () => {
      void chrome.runtime.lastError;
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
  $("addProfile").addEventListener("click", addNewProfile);
  $("deleteProfile").addEventListener("click", deleteCurrentProfile);

  $("profileName").addEventListener("input", () => {
    const cur = getActiveProfileObj();
    if (cur) {
      cur.name = $("profileName").value.trim() || "Profil";
      renderProfileTabs();
    }
  });

  $("visionMode").addEventListener("change", saveFeatureTogglesQuick);
  $("translationPreview").addEventListener("change", saveFeatureTogglesQuick);
  $("shortcutEnabled").addEventListener("change", saveFeatureTogglesQuick);

  $("clearMemory").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearReplyMemory" }, () => {
      void chrome.runtime.lastError;
      $("memoryStatus").textContent = "✓ Memori variasi balasan berhasil di-reset.";
      $("memoryStatus").style.color = "var(--green)";
      setTimeout(() => {
        $("memoryStatus").textContent =
          "Memori Anti-Repetisi aktif otomatis (menyimpan 8 balasan terakhir secara lokal agar gaya kalimat tidak monoton).";
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
});
