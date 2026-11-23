// Background Service Worker — CORS-free API proxy for X AI Reply.
// v5.4.0 Global Edition: Deep Post + High-Res Vision Understanding, Mood & Politeness Register Adaptation,
// Silent Read-Then-Reply Protocol, Post-Generation Anti-Slop/Quality Guard, Quote & Smart Regenerate Modes,
// Vision Multimodal + Auto 413/Text Fallback, Anti-Repetition Memory, & Live English Translation Preview.

const API_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 700;
const MAX_RECENT_REPLIES = 8;

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return API_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// Unambiguous Indonesian stopwords & everyday slang (excludes cross-language collisions like dr/ga/pas/lu/gan/kl)
const ID_STOP =
  /\b(yang|yg|dan|ini|itu|tidak|nggak|gak|ngga|dengan|dgn|untuk|utk|dari|ada|akan|sudah|udah|udh|belum|blm|bisa|juga|jg|saya|aku|gue|gw|kamu|elu|kalian|dia|mereka|kita|kami|adalah|karena|krn|kalau|kalo|jadi|jd|pada|atau|lebih|hanya|cuma|sangat|banget|bgt|hari|bukan|loh|lho|sih|dong|nih|tuh|kok|lah|kah|aja|saja|mau|lagi|lg|masih|baru|bikin|pakai|pake|lihat|liat|tahu|tau|gimana|gitu|gini|tapi|tp|memang|emang|kayak|kaya|buat|terus|trs|banyak|semua|orang|kenapa|kapan|dimana|siapa|bagaimana|mantap|keren|parah|anjir|wkwk|wkwkwk|cuy|bang|kak|sekarang|kemarin|besok|makin|paling|jangan|harus|perlu|mungkin|pasti|selalu|pernah|tanpa|sampai|sejak|mulai|cuan|nyangkut|serok|gokil|santuy|bener|benar|bagus|cepat|mahal|murah|beli|jual|dapet|dapat|punya|bilang|bakal|naik|turun)\b/g;

// Strict English function words (excludes cross-language tech/CT loanwords like chart/bullish/launch/update/live)
const EN_FUNC_STOP =
  /\b(the|and|is|are|was|were|be|been|being|to|of|for|with|from|into|over|after|before|about|between|through|during|without|under|again|further|then|once|here|there|when|where|why|how|all|any|both|each|few|more|most|other|some|such|nor|not|only|own|same|than|too|very|can|will|just|should|now|that|this|these|those|what|which|who|whom|whose|you|your|yours|we|our|they|their|them|it|its|he|him|his|she|her|my|have|has|had|having|do|does|did|doing|would|could|might|must|shall|but|if|because|until|while|really|think|know|looks|looking|going|never|always|every|people|still|even)\b/g;

// Distinctive English stopwords & common X/CT vocabulary (for post language detection)
const EN_STOP =
  /\b(the|and|is|are|was|were|be|been|being|to|of|for|with|at|by|from|into|over|after|before|about|between|through|during|without|under|again|further|then|once|here|there|when|where|why|how|all|any|both|each|few|more|most|other|some|such|nor|not|only|own|same|than|too|very|can|will|just|should|now|that|this|these|those|what|which|who|whom|whose|you|your|yours|we|our|they|their|them|it|its|he|him|his|she|her|my|have|has|had|having|do|does|did|doing|would|could|might|must|shall|but|if|because|until|while|out|up|down|off|get|got|make|made|new|good|great|best|still|even|back|really|think|know|see|look|looks|looking|going|never|always|every|next|last|first|people|time|year|day|week|way|work|need|want|right|well|much|many|bullish|bearish|market|chart|launch|live|update|building|build|shipping|breaking|massive|strong|landing|makes|worth|watching)\b/g;

const ID_MORPH =
  /\b(?:(?:me|ber|ter|pe|ke|se|di)[a-z]{3,}(?:kan|nya|lah)|[a-z]{3,}nya|wkwk\w*)\b/g;

const TRAD_HANZI =
  /[這們來個說對還沒發動現實際網幣鏈漲跌穩開關與為無會體國經見長門問間時機電買賣點頭後裡讓從進著樣種東車書學義]/g;
const SIMP_HANZI =
  /[这们来个说对还没发动现实际网币链涨跌稳开关与为无会体国经见长门问间时机电买卖点头后里让从进着样种东车书学义]/g;

const ES_STOP = /\b(el|la|los|las|una|unos|unas|pero|como|para|por|está|están|este|esta|estos|estas|muy|más|todo|todos|puede|hace|sobre|cuando|porque|también|solo|siempre|ahora|mercado|mejor)\b/g;
const PT_STOP = /\b(uma|uns|umas|não|está|estão|isso|isto|muito|mais|tudo|todos|pode|sobre|quando|porque|também|ainda|agora|você|vocês|pelos|pelas|melhor)\b/g;
const FR_STOP = /\b(les|des|une|dans|pour|pas|sur|avec|sont|cette|mais|plus|tout|tous|comme|c'est|quand|parce|aussi|même|très|bien|toujours)\b/g;
const DE_STOP = /\b(der|die|das|und|nicht|mit|auf|für|ist|sind|eine|einer|einem|auch|noch|wird|werden|aber|oder|wenn|über|mehr|sehr|jetzt)\b/g;
const TR_STOP = /\b(bir|ve|bu|için|ile|olan|olarak|daha|çok|gibi|ama|fakat|kadar|sonra|önce|var|yok|bunu|şunu|nasıl|neden|şimdi)\b/g;

const DOM_LANG_MAP = {
  en: { label: "English", nativeName: "English", code: "en" },
  id: { label: "Indonesian", nativeName: "Bahasa Indonesia", code: "id" },
  in: { label: "Indonesian", nativeName: "Bahasa Indonesia", code: "id" },
  ja: { label: "Japanese", nativeName: "日本語", code: "ja", cjk: true, nonLatin: true },
  ko: { label: "Korean", nativeName: "한국어", code: "ko", korean: true, nonLatin: true },
  zh: { label: "Simplified Chinese", nativeName: "简体中文", code: "zh-CN", cjk: true, nonLatin: true },
  "zh-cn": { label: "Simplified Chinese", nativeName: "简体中文", code: "zh-CN", cjk: true, nonLatin: true },
  "zh-hans": { label: "Simplified Chinese", nativeName: "简体中文", code: "zh-CN", cjk: true, nonLatin: true },
  "zh-tw": { label: "Traditional Chinese", nativeName: "繁體中文", code: "zh-TW", cjk: true, nonLatin: true },
  "zh-hk": { label: "Traditional Chinese", nativeName: "繁體中文", code: "zh-TW", cjk: true, nonLatin: true },
  "zh-hant": { label: "Traditional Chinese", nativeName: "繁體中文", code: "zh-TW", cjk: true, nonLatin: true },
  ru: { label: "Russian", nativeName: "Русский", code: "ru", nonLatin: true },
  uk: { label: "Ukrainian", nativeName: "Українська", code: "uk", nonLatin: true },
  ar: { label: "Arabic", nativeName: "العربية", code: "ar", nonLatin: true },
  th: { label: "Thai", nativeName: "ภาษาไทย", code: "th", nonLatin: true },
  hi: { label: "Hindi", nativeName: "हिन्दी", code: "hi", nonLatin: true },
  vi: { label: "Vietnamese", nativeName: "Tiếng Việt", code: "vi" },
  es: { label: "Spanish", nativeName: "Español", code: "es" },
  pt: { label: "Portuguese", nativeName: "Português", code: "pt" },
  fr: { label: "French", nativeName: "Français", code: "fr" },
  de: { label: "German", nativeName: "Deutsch", code: "de" },
  tr: { label: "Turkish", nativeName: "Türkçe", code: "tr" },
  it: { label: "Italian", nativeName: "Italiano", code: "it" },
  nl: { label: "Dutch", nativeName: "Nederlands", code: "nl" },
  pl: { label: "Polish", nativeName: "Polski", code: "pl" },
  tl: { label: "Tagalog", nativeName: "Tagalog", code: "tl" },
  ms: { label: "Malay", nativeName: "Bahasa Melayu", code: "ms" },
};

// ═══════════════════════════════════════════════════════════════
// Anti-Repetition Memory (chrome.storage.local)
// ═══════════════════════════════════════════════════════════════
function getRecentReplies() {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local) return resolve([]);
      chrome.storage.local.get(["recentReplies"], (data) => {
        void chrome.runtime.lastError;
        const arr = Array.isArray(data?.recentReplies) ? data.recentReplies : [];
        resolve(arr);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

let recentReplyWriteQueue = Promise.resolve();

function sanitizeReplyForMemory(replyText) {
  return String(replyText || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’「」『』`]+|["'“”‘’「」『』`]+$/g, "")
    .trim()
    .slice(0, 140);
}

function recordRecentReply(replyText) {
  const clean = sanitizeReplyForMemory(replyText);
  if (!clean || !chrome.storage || !chrome.storage.local) return Promise.resolve();

  recentReplyWriteQueue = recentReplyWriteQueue
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve) => {
          try {
            chrome.storage.local.get(["recentReplies"], (data) => {
              void chrome.runtime.lastError;
              const prev = Array.isArray(data?.recentReplies) ? data.recentReplies : [];
              const filtered = prev.filter((item) => item !== clean);
              filtered.push(clean);
              const next = filtered.slice(-MAX_RECENT_REPLIES);
              chrome.storage.local.set({ recentReplies: next }, () => {
                void chrome.runtime.lastError;
                resolve();
              });
            });
          } catch (e) {
            resolve();
          }
        })
    );

  return recentReplyWriteQueue;
}

function clearRecentReplies() {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local) return resolve({ ok: true, count: 0 });
      chrome.storage.local.set({ recentReplies: [] }, () => {
        void chrome.runtime.lastError;
        resolve({ ok: true, count: 0 });
      });
    } catch (e) {
      resolve({ ok: true, count: 0 });
    }
  });
}

function buildAntiRepetitionBlock(recentReplies) {
  if (!Array.isArray(recentReplies) || recentReplies.length === 0) return "";
  const lines = recentReplies.slice(-6).map((r) => `- "${r}"`);
  return [
    "ANTI-REPETITION MEMORY (KEEP EVERY REPLY FRESH):",
    "Your recent replies were:",
    ...lines,
    "- Do NOT reuse the same opening words, sentence skeleton, or '[X] is good, but [Y]...' pattern as any line above.",
    "- If replying to the same post again, take a completely different angle and sentence rhythm (e.g. switch between a quick reaction, casual question, or short side observation).",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════
// Language Detection & Output Verification
// ═══════════════════════════════════════════════════════════════
function countMatches(re, text) {
  const m = String(text || "").match(re);
  return m ? m.length : 0;
}

function stripNoiseForLang(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\$[A-Za-z0-9_]+/g, " ")
    .replace(/@[A-Za-z0-9_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDomLang(domLang) {
  const raw = String(domLang || "").trim().toLowerCase();
  if (!raw || /^(und|zxx|qme|qht|qct|qam|art)$/.test(raw)) return "";
  if (DOM_LANG_MAP[raw]) return raw;
  const base = raw.split(/[-_]/)[0];
  return DOM_LANG_MAP[base] ? base : "";
}

function detectChineseVariant(text, normDomLang) {
  const tradHits = countMatches(TRAD_HANZI, text);
  const simpHits = countMatches(SIMP_HANZI, text);
  if (
    normDomLang === "zh-tw" ||
    normDomLang === "zh-hk" ||
    normDomLang === "zh-hant" ||
    tradHits > simpHits
  ) {
    return DOM_LANG_MAP["zh-tw"];
  }
  return DOM_LANG_MAP["zh-cn"];
}

const JA_KANJI_HINT =
  /[々ヶ〆ヵ]|(?:速報|銘柄|利確|損切|爆上|暴落|円安|円高|承認|申請|神回|本当|大丈夫|発表|開始|予定|参加|無料|相場|上場|仮想通貨|暗号資産)/;

function detectTweetLanguage(text, domLangHint = "", options = {}) {
  const raw = String(text || "").trim();
  const normDom = normalizeDomLang(domLangHint);
  const authorName = String(options?.authorName || "").trim();
  const isAutoTranslated = Boolean(options?.isAutoTranslated);

  // If X auto-translated the post in the DOM (e.g. Japanese → English), trust the original DOM lang hint
  if (isAutoTranslated && normDom && normDom !== "en" && DOM_LANG_MAP[normDom]) {
    return DOM_LANG_MAP[normDom];
  }

  if (!raw) {
    if (normDom && DOM_LANG_MAP[normDom]) return DOM_LANG_MAP[normDom];
    return { label: "the exact same language as the target post", nativeName: "Same Language", code: "same" };
  }

  const cleaned = stripNoiseForLang(raw) || raw;

  const kanaCount = countMatches(/[\u3040-\u30ff\uff66-\uff9f]/g, cleaned);
  const hangulCount = countMatches(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, cleaned);
  const hanziCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, cleaned);

  if (kanaCount >= 1) {
    return DOM_LANG_MAP.ja;
  }
  if (hangulCount >= 1) {
    return DOM_LANG_MAP.ko;
  }
  if (hanziCount >= 1) {
    // Disambiguate kanji-only Japanese posts (e.g. "$INJ ETF 承認待ち") from Chinese
    if (
      normDom === "ja" ||
      JA_KANJI_HINT.test(cleaned) ||
      /[\u3040-\u30ff\uff66-\uff9f]/.test(authorName)
    ) {
      return DOM_LANG_MAP.ja;
    }
    return detectChineseVariant(cleaned, normDom);
  }

  if (countMatches(/[\u0400-\u04ff]/g, cleaned) >= 2) {
    if (normDom === "uk" || /[іїєґІЇЄҐ]/.test(cleaned)) return DOM_LANG_MAP.uk;
    return DOM_LANG_MAP.ru;
  }
  if (countMatches(/[\u0600-\u06ff\u0750-\u077f]/g, cleaned) >= 2) return DOM_LANG_MAP.ar;
  if (countMatches(/[\u0e00-\u0e7f]/g, cleaned) >= 2) return DOM_LANG_MAP.th;
  if (countMatches(/[\u0900-\u097f]/g, cleaned) >= 2) return DOM_LANG_MAP.hi;

  if (/[ăâđêôơưĂÂĐÊÔƠƯảẩẫậắằẳẵặẻểễệỉịỏổỗộớờởỡợủửữựỳỷỹỵ]/.test(cleaned)) {
    return DOM_LANG_MAP.vi;
  }

  const lower = cleaned.toLowerCase();
  const idHits = countMatches(ID_STOP, lower);
  const idMorphHits = countMatches(ID_MORPH, lower);
  // Avoid letting a lone "-nya" proper noun override an explicit non-Indonesian DOM lang tag
  const idScore =
    idHits === 0 && idMorphHits === 1 && normDom && normDom !== "id" && normDom !== "in"
      ? 0
      : idHits + idMorphHits;
  const enHits = countMatches(EN_STOP, lower);
  const enFuncHits = countMatches(EN_FUNC_STOP, lower);

  const latinLangScores = [
    { key: "id", hits: idScore, strong: idHits },
    { key: "es", hits: countMatches(ES_STOP, lower), strong: countMatches(ES_STOP, lower) },
    { key: "pt", hits: countMatches(PT_STOP, lower), strong: countMatches(PT_STOP, lower) },
    { key: "fr", hits: countMatches(FR_STOP, lower), strong: countMatches(FR_STOP, lower) },
    { key: "de", hits: countMatches(DE_STOP, lower), strong: countMatches(DE_STOP, lower) },
    { key: "tr", hits: countMatches(TR_STOP, lower), strong: countMatches(TR_STOP, lower) },
  ].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    // Tie-break in favor of explicit DOM language hint
    const aDom = a.key === normDom || (a.key === "id" && normDom === "in") ? 1 : 0;
    const bDom = b.key === normDom || (b.key === "id" && normDom === "in") ? 1 : 0;
    return bDom - aDom;
  });

  const topLatin = latinLangScores[0];
  if (
    topLatin.key === "id" &&
    topLatin.hits > 0 &&
    (topLatin.hits > enHits || (topLatin.hits === enHits && enFuncHits === 0))
  ) {
    return DOM_LANG_MAP.id;
  }

  if (topLatin.key !== "id" && topLatin.hits >= 2 && topLatin.hits >= enHits) {
    return DOM_LANG_MAP[topLatin.key];
  }

  // Trust explicit non-English DOM language tag (e.g. lang="ja" / "ko" / "zh" / "es") unless text is clearly long English
  if (normDom && normDom !== "en" && normDom !== "id" && normDom !== "in") {
    const domMeta = DOM_LANG_MAP[normDom];
    if (
      (domMeta && (domMeta.nonLatin || domMeta.cjk || domMeta.korean) && enHits <= 3) ||
      enHits <= 2 ||
      latinLangScores.some((x) => x.key === normDom && x.hits >= 1)
    ) {
      return domMeta;
    }
  }

  if ((normDom === "id" || normDom === "in") && enHits <= 1) {
    return DOM_LANG_MAP.id;
  }

  if (enHits > idScore) {
    return DOM_LANG_MAP.en;
  }

  if (normDom && DOM_LANG_MAP[normDom]) {
    return DOM_LANG_MAP[normDom];
  }

  return { label: "the exact same language as the target post", nativeName: "Same Language", code: "same" };
}

function detectScriptOnlyLang(text) {
  const s = String(text || "");
  if (!s) return null;
  if (/[\u3040-\u30ff\uff66-\uff9f]/.test(s)) return DOM_LANG_MAP.ja;
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(s)) return DOM_LANG_MAP.ko;
  if (countMatches(/[\u0400-\u04ff]/g, s) >= 2) {
    return /[іїєґІЇЄҐ]/.test(s) ? DOM_LANG_MAP.uk : DOM_LANG_MAP.ru;
  }
  if (countMatches(/[\u0600-\u06ff\u0750-\u077f]/g, s) >= 2) return DOM_LANG_MAP.ar;
  if (countMatches(/[\u0e00-\u0e7f]/g, s) >= 2) return DOM_LANG_MAP.th;
  if (countMatches(/[\u0900-\u097f]/g, s) >= 2) return DOM_LANG_MAP.hi;
  return null;
}

function resolveReplyLanguage(post) {
  const p = post || {};

  // 1. If the post was translated on X ("Translated from Japanese"), preserve the author's original language
  if (p.translatedFromLang) {
    const origKey = normalizeDomLang(p.translatedFromLang);
    if (origKey && DOM_LANG_MAP[origKey]) {
      return DOM_LANG_MAP[origKey];
    }
  }

  // 2. If X auto-translated the visible text and the tweet DOM tag still holds a non-English language, preserve it
  const normTweetLang = normalizeDomLang(p.tweetLang);
  if (p.isAutoTranslated && normTweetLang && normTweetLang !== "en" && DOM_LANG_MAP[normTweetLang]) {
    return DOM_LANG_MAP[normTweetLang];
  }

  const primaryText = [p.articleTitle, p.tweetText, p.pollOptions].filter(Boolean).join("\n");
  const cleanedPrimary = stripNoiseForLang(primaryText);
  const hasNonLatinScript =
    /[\u3040-\u30ff\uff66-\uff9f\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\u4e00-\u9fff\u3400-\u4dbf\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\u0900-\u097f]/.test(
      primaryText
    );
  const primaryWords = cleanedPrimary ? cleanedPrimary.split(/\s+/).filter(Boolean).length : 0;

  // 3. Detect directly from primary post content (never let a quoted English tweet override a Japanese/etc. main post)
  if (hasNonLatinScript || primaryWords >= 2) {
    const primaryLang = detectTweetLanguage(primaryText, p.tweetLang, {
      authorName: p.name,
      isAutoTranslated: p.isAutoTranslated,
    });
    if (primaryLang.code !== "same") return primaryLang;
  }

  // 4. Trust valid tweet DOM lang attribute (safe now because <html lang="en"> is excluded in content.js)
  if (normTweetLang && DOM_LANG_MAP[normTweetLang]) {
    const hinted = detectTweetLanguage(primaryText, normTweetLang, {
      authorName: p.name,
      isAutoTranslated: p.isAutoTranslated,
    });
    if (hinted.code !== "same") return hinted;
    return DOM_LANG_MAP[normTweetLang];
  }

  // 5. For media/emoji/ticker-only posts with no body text, check author's display name script before falling back to quoted tweets
  if (!cleanedPrimary || cleanedPrimary.length <= 6) {
    const authorScriptLang = detectScriptOnlyLang(p.name);
    if (authorScriptLang) return authorScriptLang;
  }

  // 6. Fallback across quoted tweet, card summary, parent thread, and image alt text
  const fallbackText = [
    primaryText,
    p.quotedText,
    p.cardSummary,
    p.parentContext,
    p.imageAlt,
  ]
    .filter(Boolean)
    .join("\n");

  return detectTweetLanguage(fallbackText, p.tweetLang || p.quotedLang || "", {
    authorName: p.name,
    isAutoTranslated: p.isAutoTranslated,
  });
}

function isReplyInExpectedLanguage(replyText, lang) {
  const raw = String(replyText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
  if (!raw || !lang || lang.code === "same") return true;

  const cleanedForLatinCheck = stripNoiseForLang(raw);
  const lower = cleanedForLatinCheck.toLowerCase();
  // Use strict English function words so natural CT/tech loanwords (chart, bullish, launch, update, live) don't false-reject
  const enFuncHits = countMatches(EN_FUNC_STOP, lower);
  const latinWords = countMatches(/\b[a-z]{3,}\b/g, lower);

  if (lang.code === "zh-CN" || lang.code === "zh-TW") {
    const hanziCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, raw);
    if (hanziCount < 2 || /[\u3040-\u30ff]/.test(raw)) return false;
    if (enFuncHits >= 2 || (enFuncHits >= 1 && latinWords > hanziCount)) return false;
    return true;
  }
  if (lang.code === "ja") {
    const kanaCount = countMatches(/[\u3040-\u30ff\uff66-\uff9f]/g, raw);
    const kanjiCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, raw);
    const jpChars = kanaCount + kanjiCount;
    if (jpChars < 2) return false;
    if (raw.length >= 6 && kanaCount === 0) return false;
    if (enFuncHits >= 2 || (enFuncHits >= 1 && latinWords > jpChars)) return false;
    return true;
  }
  if (lang.code === "ko") {
    const koChars = countMatches(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, raw);
    if (koChars < 2 || enFuncHits >= 2 || (enFuncHits >= 1 && latinWords > koChars)) return false;
    return true;
  }
  if (lang.code === "ru" || lang.code === "uk") {
    const cyr = countMatches(/[\u0400-\u04ff]/g, raw);
    return cyr >= 3 && enFuncHits < 2;
  }
  if (lang.code === "ar") {
    const ar = countMatches(/[\u0600-\u06ff\u0750-\u077f]/g, raw);
    return ar >= 3 && enFuncHits < 2;
  }
  if (lang.code === "th") {
    const th = countMatches(/[\u0e00-\u0e7f]/g, raw);
    return th >= 3 && enFuncHits < 2;
  }
  if (lang.code === "hi") {
    const hi = countMatches(/[\u0900-\u097f]/g, raw);
    return hi >= 3 && enFuncHits < 2;
  }

  const idScore = countMatches(ID_STOP, lower) + countMatches(ID_MORPH, lower);

  if (lang.code === "id") {
    if (enFuncHits >= 2 && idScore === 0) return false;
    if (enFuncHits >= 3 && enFuncHits > idScore * 2) return false;
    if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(raw)) return false;
    return true;
  }

  if (lang.code === "en") {
    if (idScore >= 2 && enFuncHits === 0) return false;
    if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/.test(raw)) {
      return false;
    }
    return true;
  }

  if (enFuncHits >= 3) {
    if (lang.code === "vi" && !/[ăâđêôơưảẩẫậắằẳẵặẻểễệỉịỏổỗộớờởỡợủửữựỳỷỹỵ]/i.test(raw)) {
      return false;
    }
    if (lang.code === "es" && countMatches(ES_STOP, lower) === 0) return false;
    if (lang.code === "pt" && countMatches(PT_STOP, lower) === 0) return false;
    if (lang.code === "fr" && countMatches(FR_STOP, lower) === 0) return false;
    if (lang.code === "de" && countMatches(DE_STOP, lower) === 0) return false;
    if (lang.code === "tr" && countMatches(TR_STOP, lower) === 0) return false;
  }

  return true;
}

// Strip Latin-only rules ("all lowercase", "under X words") from custom prompts when targeting non-Latin scripts
function sanitizeStylePromptForLang(systemPrompt, lang) {
  const raw = String(systemPrompt || "").trim();
  if (!raw) return "";
  if (!lang || (!lang.nonLatin && !lang.cjk && !lang.korean)) return raw;

  return raw
    .replace(/\ball\s+lowercase\b[,]?\s*/gi, "")
    .replace(/\blowercase\b[,]?\s*/gi, "")
    .replace(/\bunder\s+\d+\s+words\b[,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim();
}

// ═══════════════════════════════════════════════════════════════
// Context, Quick Angle, & Entity Builders
// ═══════════════════════════════════════════════════════════════
function detectTickersAndProjects(text) {
  const cleaned = String(text || "").replace(/https?:\/\/\S+/gi, " ");
  const tickers = [];
  const mentions = [];

  const tickerRe = /(?:^|[^A-Za-z0-9_])(\$[A-Za-z][A-Za-z0-9]{1,9})\b/g;
  let m;
  while ((m = tickerRe.exec(cleaned)) !== null) {
    tickers.push(m[1]);
  }

  const mentionRe = /(?:^|[^A-Za-z0-9_.])(@[A-Za-z0-9_]{1,15})\b/g;
  while ((m = mentionRe.exec(cleaned)) !== null) {
    mentions.push(m[1]);
  }

  return {
    tickers: [...new Set(tickers)],
    mentions: [...new Set(mentions)],
  };
}

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

function upgradeLegacyStylePrompt(prompt) {
  const clean = String(prompt || "").trim();
  return LEGACY_PROMPT_UPGRADES[clean] || clean;
}

function buildAngleDirective(angle) {
  switch (String(angle || "auto").toLowerCase()) {
    case "agree":
      return "VIBE FOR THIS REPLY — CASUAL CO-SIGN: Back up the author's point naturally like a friend nodding along on X, using native everyday phrasing in the target language. Zero corporate praise or stiff agreement clichés.";
    case "ask":
      return "VIBE FOR THIS REPLY — CASUAL QUESTION: Ask 1 quick, genuinely curious question about a specific detail in the post, phrased the way native speakers actually ask on X. A '?' at the end is totally fine.";
    case "counter":
      return "VIBE FOR THIS REPLY — CHILL SKEPTICISM: Push back lightly or point out one real-world catch/risk in a relaxed, conversational way in the target language. NEVER use stiff essay contrast templates like 'X sounds nice, but Y matters most'.";
    case "witty":
      return "VIBE FOR THIS REPLY — EFFORTLESS WIT: Drop a quick, relatable joke, dry quip, or light playful roast directly about the situation in the post. Keep it punchy, native, and unforced.";
    default:
      return "";
  }
}

function cleanPrimaryLen(p) {
  return String(p?.tweetText || p?.articleTitle || "")
    .replace(/https?:\/\/\S+/gi, "")
    .trim().length;
}

function isReportingAboutOthers(post) {
  const p = post || {};
  const text = String(p.tweetText || "");
  if (!text) return false;
  const authorHandle = String(p.handle || "").replace(/^@/, "").toLowerCase();
  const mentions = (text.match(/@([A-Za-z0-9_]{1,15})/g) || [])
    .map((m) => m.slice(1).toLowerCase())
    .filter((h) => h && h !== authorHandle);
  const looksLikeNewsLead =
    /^(?:🔥|🚨|⚡|📢|👀)?\s*(?:breaking|just in|update|alert|new|report|reportedly|速報|快讯|속보)\s*[:：]/i.test(
      text.trim()
    ) ||
    /\b(?:stated|stating|called|announced|contributed|reported|according to|says|said)\b/i.test(text);
  return looksLikeNewsLead && mentions.length >= 1;
}

function detectPostMood(post) {
  const p = post || {};
  const primary = [p.articleTitle, p.tweetText, p.selfThreadContinuation].filter(Boolean).join(" ").trim();
  const full = [primary, p.quotedText, p.cardSummary].filter(Boolean).join(" ").trim();
  const cleanedPrimary = primary.replace(/https?:\/\/\S+/gi, "").replace(/@[A-Za-z0-9_]+/g, "").trim();

  // 1. Sensitive / bad news / condolences / hack / rug — highest priority so tone is never tone-deaf
  if (
    /\b(rip|r\.i\.p|passed away|rest in peace|sorry for your loss|condolences|got hacked|was hacked|wallet drained|got drained|got rugged|exploited for|lost everything|laid off|diagnosed with|hospitalized|innalillahi|turut berduka|belasungkawa|kena hack|kena drain|kena scam|ketipu|duka cita)\b/i.test(
      full
    ) ||
    /(ご冥福|お悔やみ|亡くな|ハッキング被害|抜かれた|詐欺被害|삼가 고인의 명복|해킹 당|털렸|节哀|被盗|黑客攻击|跑路了)/.test(
      full
    )
  ) {
    return "sensitive";
  }

  // 2. Ultra-short greeting / check-in ("gm", "gn", "おはよう", "pagi") with no rich body/media
  const hasRichAttachment = Boolean(
    p.quotedText || p.pollOptions || p.cardSummary || p.articleTitle || (Array.isArray(p.imageUrls) && p.imageUrls.length > 0)
  );
  if (
    !hasRichAttachment &&
    cleanedPrimary.length > 0 &&
    cleanedPrimary.length <= 28 &&
    /^(?:gm+|gn+|good morning|good night|happy (?:friday|weekend|monday|new year)|pagi+|selamat pagi|malam+|おはよう(?:ございます)?|おやすみ(?:なさい)?|좋은\s*아침|잘\s*자|早安|晚安|早上好)[!~.\s☀️🌙☕]*$/i.test(
      cleanedPrimary
    )
  ) {
    return "greeting";
  }

  // 3. Meme / joke / shitpost / light sarcasm
  if (
    /\b(lmao|lmfao|bro really|ain't no way|aint no way|pov:|me when|crying rn|i'm crying|im dead|wkwk\w*|ngakak|receh|kocak|lawak)\b/i.test(
      primary
    ) ||
    /(草+|ワロタ|わろた|笑った|面白すぎ|ㅋㅋ{2,}|ㅎㅎ{2,}|웃겨|笑死|哈哈{2,}|离谱)/.test(primary)
  ) {
    return "meme";
  }

  // 4. Personal win / author's own build/launch/milestone (not a 3rd-party news reporter)
  if (
    !isReportingAboutOthers(p) &&
    (/\b(i built|i just built|i made|we just launched|we launched|just shipped|finally shipped|finally launched|my first|happy birthday|hit \d+[kmb]?\s+(?:users|followers|stars)|after \d+\s+(?:months|weeks|years) of)\b/i.test(
      primary
    ) ||
      /\b(baru rilis|akhirnya rilis|akhirnya kelar|bikin sendiri|ulang tahun)\b/i.test(primary) ||
      /(リリースしました|公開しました|作りました|誕生日|출시했습니다|만들었습니다|생일|发布了|上线了|开源了)/.test(
        primary
      ))
  ) {
    return "milestone";
  }

  // 5. Venting / hot take / strong opinion
  if (
    /\b(unpopular opinion|hot take|sick of|tired of|why is everyone|honestly tired|capek banget|kesel banget|heran deh|jujur aja)\b/i.test(
      primary
    ) ||
    /(正直なところ|マジで無理|イライラ|솔직히|진짜 답답|说实话|受不了)/.test(primary)
  ) {
    return "vent";
  }

  return "neutral";
}

function detectSocialRegister(post, lang, mood) {
  if (mood === "sensitive") return "empathetic";
  const text = [post?.articleTitle, post?.tweetText, post?.selfThreadContinuation].filter(Boolean).join(" ");

  if (lang?.code === "ja") {
    const hasPolite =
      /(です|ます|ました|ません|いたします|お知らせ|発表|公式|ありがとうございま|よろしくお願い|ご案内)/.test(text) ||
      isReportingAboutOthers(post);
    const hasStrongCasual = /(草|ワロタ|わろた|だよ|じゃん|マジ|やばい|だわ|すぎる|w$|\sw\b)/.test(text);
    if (hasStrongCasual && !hasPolite) return "casual";
    if (hasPolite) return "polite_casual";
    return "soft_polite";
  }

  if (lang?.code === "ko") {
    const hasPolite = /(요[.!?\s]?$|습니다|니다|감사합니다|발표|공지|안내|해요|네요|세요)/.test(text) || isReportingAboutOthers(post);
    const hasBanmal = /(ㅋㅋ|ㅎㅎ|미쳤|개쩐|존나|실화냐|어이없)/.test(text) && !hasPolite;
    if (hasBanmal) return "casual";
    return "polite_casual";
  }

  if (lang?.code === "id") {
    const hasSlang = /\b(gw|gue|lu|elu|wkwk\w*|anjir|bgt|banget|cuy|bro|nih|sih|gak|nggak|udah|emang|dong|lah|kocak|santuy)\b/i.test(
      text
    );
    const hasFormal =
      /\b(saya|anda|resmi|mengumumkan|pemerintah|berdasarkan|terima kasih|selamat kepada|dilaporkan)\b/i.test(text) ||
      isReportingAboutOthers(post);
    if (hasFormal && !hasSlang) return "semi_casual";
    return "casual";
  }

  return "casual";
}

function computeDynamicTemperature({ angle, mood, hasMetrics, isRegenerate, hasUserSeed }) {
  let temp = 0.65;
  const a = String(angle || "auto").toLowerCase();
  if (mood === "sensitive") {
    temp = 0.45;
  } else if (hasUserSeed) {
    temp = 0.56;
  } else if (a === "ask" || hasMetrics) {
    temp = 0.55;
  } else if (a === "witty" || mood === "meme") {
    temp = 0.78;
  } else if (mood === "greeting") {
    temp = 0.72;
  }
  if (isRegenerate) {
    temp = Math.min(mood === "sensitive" ? 0.58 : 0.86, temp + 0.12);
  }
  return Number(temp.toFixed(2));
}

function analyzePostIntent(post, angle = "auto", visionAttached = false, mood = "neutral", register = "casual", options = {}) {
  const p = post || {};
  const primary = [p.articleTitle, p.tweetText, p.selfThreadContinuation, p.pollOptions]
    .filter(Boolean)
    .join(" ");
  const full = [primary, p.quotedText, p.cardSummary, p.imageAlt, p.parentContext]
    .filter(Boolean)
    .join(" ");

  const cues = [];

  if (p.composerMode === "quote") {
    cues.push(
      "COMPOSER MODE — QUOTE POST: You are writing a Quote Post shown to your OWN followers, NOT a direct reply to the author. Make the commentary stand on its own as a crisp reaction to the quoted post."
    );
  }

  const explicitAngle = buildAngleDirective(angle);
  if (explicitAngle) {
    if (mood === "sensitive" && String(angle).toLowerCase() === "witty") {
      cues.push(
        "MOOD OVERRIDE — SENSITIVE POST: This post involves loss, bad news, or a hack. Stay respectful and empathetic — do NOT joke, roast, or sound flippant."
      );
    } else {
      cues.push(explicitAngle);
    }
  }

  if (options.userSeed) {
    cues.push(
      `USER'S DRAFT IDEA (HIGH PRIORITY): The user already typed "${options.userSeed}" as their rough direction. Express THAT exact point naturally and concisely in the target language while staying strictly faithful to the post facts.`
    );
  } else if (options.previousDraft) {
    cues.push(
      `REGENERATE — FRESH ANGLE REQUIRED: The user rejected your previous draft "${options.previousDraft}". Pick a COMPLETELY different detail, angle, and sentence skeleton — do NOT reword the old draft.`
    );
  }

  if (mood === "sensitive") {
    cues.push(
      "MOOD — SENSITIVE / BAD NEWS: Keep it brief, sincere, and grounded. Zero jokes, zero sarcasm, zero hype slang ('lol', 'ngl', 'wkwk', '草')."
    );
  } else if (mood === "greeting") {
    cues.push(
      "MOOD — QUICK GREETING: This is a short greeting/check-in. Return an effortless, warm 1-line greeting matching their vibe — do NOT overthink or invent a topic."
    );
  } else if (mood === "meme") {
    cues.push(
      "MOOD — MEME / HUMOR: Play along with the joke or absurdity lightly like a human scrolling X — NEVER explain the joke or reply with a stiff serious lecture."
    );
  } else if (mood === "milestone") {
    cues.push(
      "MOOD — PERSONAL MILESTONE/LAUNCH: Give genuine, low-key props tied to what they actually built/achieved — avoid generic PR hype."
    );
  } else if (mood === "vent") {
    cues.push(
      "MOOD — VENT / HOT TAKE: Match the candid conversational energy without sounding preachy or lecturing."
    );
  }

  if (p.communityNote) {
    cues.push(
      "FACT CHECK — COMMUNITY NOTE: Readers added verified context/correction below the post. Factor that correction into your take and NEVER endorse claims contradicted by the Community Note."
    );
  }

  if (isReportingAboutOthers(p)) {
    cues.push(
      "AUTHOR ROLE — NEWS/REPORTER: The post author is reporting news or quoting other people/projects. React to the actual news, numbers, or claim itself — do NOT congratulate or address the reporter as if they built it."
    );
  }

  const isPoll = Boolean(p.pollOptions);
  const isQuestion =
    /[?？](\s|$)/.test(primary) ||
    /\b(thoughts|wdyt|what do you think|which one|agree or disagree|menurut kalian|menurut lo|gimana menurut|pilih mana|setuju gak)\b/i.test(
      primary
    ) ||
    /(怎么看|觉得呢|哪个好|是不是|どう思う|どう思いますか|どっち|어떻게 생각|어떤가요|맞나요)/.test(primary);

  if (!explicitAngle && !options.userSeed && mood !== "greeting" && mood !== "sensitive") {
    if (isPoll) {
      cues.push(
        "REACTION CUE — POLL: Pick one option actually listed in Poll Choices and give a quick gut reason why."
      );
    } else if (isQuestion) {
      cues.push(
        "REACTION CUE — QUESTION: Directly answer the author's exact question in a casual way."
      );
    }
  }

  const hasMetrics =
    /(\b\d+(?:[.,]\d+)?\s*(?:%|x|bps|k|m|b|t|ms|tps)\b|\$\d+(?:[.,]\d+)?\s*(?:k|m|b|t)?\b|\b(?:tvl|ath|volume|revenue|inflow|outflow|apr|apy|fdv|mcap|dau|mau)\b|(?:新高|突破|暴涨|急増|돌파|급등))/i.test(
      full
    );
  const hasSubstantiveText = cleanPrimaryLen(p) >= 20;
  if (visionAttached) {
    if (hasSubstantiveText) {
      cues.push(
        "TEXT + IMAGE SYNERGY: Read BOTH Post Text and the attached image(s) carefully. If an image is a chart, table, screenshot, or diagram with real data/text, combine that visual detail with the post text. If an image is just a project logo, banner, or decorative graphic, focus primarily on the main news/point in Post Text — NEVER ignore the text to comment solely on a logo shape or graphic design unless the text itself is about design."
      );
    } else {
      cues.push(
        "IMAGE-PRIMARY POST: The post relies mostly on the attached image(s). Inspect every legible detail in the image(s) — text, numbers, chart movement, meme joke, UI, or scene — and react directly to what is actually shown."
      );
    }
    cues.push(
      "VISUAL GROUNDING: Only mention visual details you can CLEARLY see/read in the attached image(s). Never guess blurry numbers or invent off-screen details."
    );
  } else if (p.mediaType === "Image/Chart Post" && !p.imageAlt) {
    cues.push(
      "MEDIA NOTICE: The image could not be viewed directly — react ONLY to the written text/caption provided. NEVER pretend you saw the image or chart."
    );
  } else if (hasMetrics || p.imageAlt) {
    cues.push(
      "DATA GROUNDING: Only cite numbers or details explicitly present in TWEET CONTEXT — never extrapolate or invent extra numbers."
    );
  }

  if (p.mediaType === "Video Post") {
    cues.push(
      "VIDEO NOTICE: You cannot watch the video itself (at most a static thumbnail may be attached). React ONLY to the caption/text/visible thumbnail — NEVER pretend you watched the video or heard audio."
    );
  }

  const isShipOrCollab =
    /(\b(?:live on|launching|launched|introducing|announcing|integrated|integration|partnering|partnership|landing on|now available|mainnet|testnet|upgrade|shipped|rollout|going live)\b|(?:上线|推出|集成|合作|主网|公開|連携|ローンチ|출시|통합|메인넷|상장))/i.test(
      full
    );
  if (isShipOrCollab && !explicitAngle && !options.userSeed && mood !== "sensitive") {
    cues.push(
      "REACTION CUE — LAUNCH/NEWS: React casually to the exact update announced in the post — skip generic PR praise and never invent unmentioned roadmap details."
    );
  }

  if (p.quotedText) {
    cues.push(
      "CONTEXT CUE — QUOTE TWEET: Keep both the author's caption and the quoted post aligned — respond to the author's actual point about the quote."
    );
  }

  if (p.selfThreadContinuation) {
    cues.push(
      "CONTEXT CUE — SELF-THREAD: The author continued their point right below the main post; use that continuation to understand the full picture."
    );
  }

  if (p.parentContext) {
    cues.push(
      "CONTEXT CUE — THREAD: Use Earlier Thread Context only for background accuracy; reply directly to MAIN POST."
    );
  }

  if (p.topReplies) {
    cues.push(
      "COMMUNITY VIBE — TOP REPLIES: Use top replies ONLY to understand hidden context/sarcasm and avoid repeating what other commenters already said. NEVER reply to a commenter instead of MAIN POST."
    );
  }

  if (cues.length === 0) {
    cues.push(
      "REACTION CUE — CONTEXT-LOCKED: Match the post's actual mood and react directly to one concrete detail actually in the post."
    );
  }

  return { intentBlock: cues.join("\n"), hasMetrics };
}

function buildEntityAnchor(post, detected) {
  const p = post || {};
  const cleanAuthorHandle = String(p.handle || "").replace(/^@/, "").trim();
  const cleanAuthorName = String(p.name || "").trim();

  const mentionNames = detected.mentions
    .map((h) => h.replace(/^@/, ""))
    .filter((h) => h.toLowerCase() !== cleanAuthorHandle.toLowerCase());

  const hints = [];
  if (detected.tickers.length > 0) {
    hints.push(`tickers: ${detected.tickers.join(", ")}`);
  }
  if (mentionNames.length > 0) {
    hints.push(`mentioned: ${mentionNames.join(", ")}`);
  }
  if (cleanAuthorName || cleanAuthorHandle) {
    hints.push(
      `author: ${[cleanAuthorName, cleanAuthorHandle ? `(@${cleanAuthorHandle})` : ""].filter(Boolean).join(" ")}`
    );
  }

  if (detected.tickers.length > 0 || mentionNames.length > 0) {
    return [
      `TOPIC CONTEXT (${hints.join(" | ")}):`,
      "- Stay clearly on-topic to this specific post, but do NOT force the ticker or project name into the opening words if it sounds robotic or SEO-like.",
      "- Avoid raw '@handle' tags unless completely natural.",
    ].join("\n");
  }

  return [
    `TOPIC CONTEXT${hints.length ? ` (${hints.join(" | ")})` : ""}:`,
    "- React directly to the specific thing happening in this post so it clearly belongs here, without sounding forced or robotic.",
  ].join("\n");
}

function hasReadableTextContext(post) {
  const p = post || {};
  return Boolean(
    String(p.tweetText || "").trim() ||
      String(p.selfThreadContinuation || "").trim() ||
      String(p.articleTitle || "").trim() ||
      String(p.pollOptions || "").trim() ||
      String(p.quotedText || "").trim() ||
      String(p.cardSummary || "").trim() ||
      String(p.imageAlt || "").trim()
  );
}

function formatPostBlock(post, attachedImageCount = 0) {
  const p = post || {};
  const lines = ["=== TWEET CONTEXT ==="];

  if (p.parentContext) {
    lines.push("EARLIER THREAD ABOVE (background context ONLY — do NOT reply to this instead of the main post):\n" + p.parentContext);
    lines.push("---");
  }

  lines.push(
    p.composerMode === "quote"
      ? "POST YOU ARE QUOTING TO YOUR FOLLOWERS (read carefully first):"
      : "MAIN POST YOU ARE REPLYING TO (read this carefully first):"
  );
  if (p.name || p.handle) {
    lines.push("Author: " + [p.name, p.handle].filter(Boolean).join(" ").trim());
  }
  if (p.timestamp) {
    lines.push("Posted: " + p.timestamp);
  }
  if (p.translatedFromLang) {
    lines.push("Original Untranslated Language of Post: " + p.translatedFromLang);
  } else if (p.tweetLang) {
    lines.push("Detected Tweet Language Tag: " + p.tweetLang);
  }
  if (p.replyTo) {
    lines.push("Thread Participants: " + p.replyTo);
  }
  if (p.mediaType) {
    lines.push("Post Format: " + p.mediaType);
  }
  if (attachedImageCount > 0) {
    const mainCnt = Number(p.mainImageCount || 0);
    const quoteCnt = mainCnt > 0 && attachedImageCount > mainCnt ? attachedImageCount - mainCnt : 0;
    const imgSummary =
      quoteCnt > 0
        ? `${attachedImageCount} image(s) attached below (${mainCnt} from main post, ${quoteCnt} from quoted post)`
        : `${attachedImageCount} image(s) attached below`;
    lines.push("Visual Media: " + imgSummary);
  }
  if (p.articleTitle) {
    lines.push("Article Headline: " + p.articleTitle);
  }
  if (p.tweetText) {
    lines.push("Post Text:\n" + p.tweetText);
  }
  if (p.selfThreadContinuation) {
    lines.push("Author's Immediate Thread Continuation:\n" + p.selfThreadContinuation);
  }
  if (p.isTruncated) {
    lines.push("Note: This post is truncated with 'Show more' — react ONLY to the visible text above and NEVER guess hidden parts.");
  }
  if (p.pollOptions) {
    lines.push("Poll Choices: " + p.pollOptions);
  }
  if (p.cardSummary) {
    lines.push("Attached Link/Article Preview:\n" + p.cardSummary);
  }
  if (p.communityNote) {
    lines.push("Community Note (Verified Reader Context):\n" + p.communityNote);
  }
  if (p.imageAlt) {
    lines.push("Attached Image/Chart Alt Description:\n" + p.imageAlt);
  }
  if (p.quotedText) {
    lines.push("---\nQUOTED POST ATTACHED INSIDE IT (context for what the author is reacting to):\n" + p.quotedText);
  }
  if (p.topReplies) {
    lines.push("---\nTOP REPLIES FROM OTHERS (vibe/background ONLY — do NOT copy them or reply to them instead of MAIN POST):\n" + p.topReplies);
  }

  lines.push("=== END TWEET ===");
  return lines.join("\n");
}

const BUILTIN_PRESET_LOCALIZED = {
  casual: {
    ja: "スマホでXを流し見しながら友達に返すみたいな超ゆるい一言。解説っぽくしない、絵文字なし",
    id: "super santai kayak bales temen di timeline X dari HP, singkat mengalir, jangan kaku kayak artikel atau AI, tanpa emoji",
    "zh-CN": "像刷X随手回朋友一样自然随性，短句口语有活人感，不装深刻不写点评腔，不要表情",
    "zh-TW": "像滑X隨手回朋友一樣自然隨性，短句口語有活人感，不裝深刻不寫評論腔，不要表情",
    ko: "폰으로 트위터 보다가 편하게 툭 던지는 짧은 한마디, 해설가 말투 금지, 이모지 없음",
  },
  witty: {
    ja: "クスッと笑える軽めのボケや皮肉、狙いすぎない自然なXノリ、絵文字なし",
    id: "nyelekit tipis atau lucu santai yang natural, nggak maksa receh, huruf kecil semua, tanpa emoji",
    "zh-CN": "带点轻松调侃或冷幽默，自然抖机灵不硬尬，不要表情",
    "zh-TW": "帶點輕鬆調侃或冷幽默，自然抖機靈不硬尬，不要表情",
    ko: "힘 안 주고 툭 던지는 가벼운 드립이나 재치 있는 한마디, 억지 유머 금지, 이모지 없음",
  },
  ct: {
    ja: "クリプト民・トレーダーのリアルなX口調。チャートやネタへの素の反応、アナリスト気取り禁止、絵文字なし",
    id: "vibe anak CT / trader beneran yang santai dan ceplas-ceplos, reaksi spontan soal market/narasi, jangan kayak laporan riset, tanpa emoji",
    "zh-CN": "真实币圈/CT老哥的随口吐槽或直觉反应，接地气不端着，绝不写研报腔，不要表情",
    "zh-TW": "真實幣圈/CT老哥的隨口吐槽或直覺反應，接地氣不端著，絕不寫研報腔，不要表情",
    ko: "찐 코인/CT 유저의 솔직하고 편한 한마디, 리포트 말투 금지, 이모지 없음",
  },
  curious: {
    ja: "素朴に気になったことを軽く聞くか、率直な感想を一言だけ。説教っぽくしない、絵文字なし",
    id: "beneran penasaran atau ngasih reaksi jujur yang santai kayak ngobrol biasa, jangan menggurui atau kaku, tanpa emoji",
    "zh-CN": "真的好奇随口问一句，或者说个大实话反应，别说教也别端着，不要表情",
    "zh-TW": "真的好奇隨口問一句，或者說個大實話反應，別說教也別端著，不要表情",
    ko: "진짜 궁금해서 가볍게 물어보거나 솔직한 반응 한마디, 훈수/설교 금지, 이모지 없음",
  },
};

function classifyBuiltInPreset(stylePrompt) {
  const s = String(stylePrompt || "").trim();
  if (!s) return "casual";
  if (s.startsWith("super casual and chill")) return "casual";
  if (s.startsWith("playful casual humor")) return "witty";
  if (s.startsWith("real CT trader vibe")) return "ct";
  if (s.startsWith("genuinely curious and conversational")) return "curious";
  return "";
}

function resolveLocalizedPersona(upgradedStyle, lang) {
  const presetKey = classifyBuiltInPreset(upgradedStyle);
  if (presetKey && BUILTIN_PRESET_LOCALIZED[presetKey]?.[lang.code]) {
    return BUILTIN_PRESET_LOCALIZED[presetKey][lang.code];
  }
  return sanitizeStylePromptForLang(upgradedStyle, lang);
}

function buildLanguageAndFormatDirectives(lang, register = "casual", mood = "neutral") {
  const punctHintZh =
    "不要句号「。」、不要感叹号「！」、不要引号、不要emoji、不要标签（发问可以用「？」）。";
  const punctHintJa =
    "句点「。」なし、感嘆符「！」なし、カギ括弧なし、絵文字なし、ハッシュタグなし（質問の「？」はOK）。";
  const punctHintLatin =
    mood === "sensitive"
      ? "Natural calm casing. No exclamation mark, no quotes, no emojis, no hashtags."
      : "All lowercase. No ending period, no exclamation mark, no quotes, no emojis, no hashtags ('?' is fine if asking).";

  const twoLineInstruction =
    mood === "greeting"
      ? "Output ONLY the short greeting reply."
      : "Output EXACTLY 2 lines:\nPOINT: <core point & mood of the post in <=10 words>\nREPLY: <ONLY your final reply in the target language>";

  if (lang.code === "zh-CN") {
    return {
      formatBlock: [
        "必须严格遵守【简体中文】回复规则：",
        "1. 100%简体中文，1句简短真人反应（6–22字），只说1个具体念头，严禁英文整句。",
        `2. ${punctHintZh}`,
        "3. 对比参考 — ❌AI味：「这个合作听起来很棒，但真正的考验在于落地」 / ✅真人：「24小时冲到这个量有点离谱，看下周还能不能稳住」",
      ].join("\n"),
      userReminder: `先看懂原帖再只用【简体中文】回一句真人短话（6–22字，别像AI点评）。\n${twoLineInstruction}`,
    };
  }

  if (lang.code === "zh-TW") {
    return {
      formatBlock: [
        "必須嚴格遵守【繁體中文】回覆規則：",
        "1. 100%繁體中文，1句簡短真人反應（6–22字），只講1個具體念頭，嚴禁簡體字或英文整句。",
        `2. ${punctHintZh}`,
        "3. 對比參考 — ❌AI味：「這個進展很值得關注，但關鍵還是看後續」 / ✅真人：「一天就衝到這數字有點扯，看後面撐不撐得住」",
      ].join("\n"),
      userReminder: `先看懂貼文再只用【繁體中文】回一句真人短話（6–22字，自然口語）。\n${twoLineInstruction}`,
    };
  }

  if (lang.code === "ja") {
    const jaRegisterRule =
      register === "casual"
        ? "口調：投稿がくだけた雰囲気なので、自然なタメ口・ゆるい独り言感でOK。"
        : register === "empathetic"
          ? "口調：深刻・悲しい内容なので、落ち着いた丁寧な寄り添い口調にする（ネタ・軽いノリ禁止）。"
          : "口調：公式・丁寧な投稿なので、硬すぎない「やわらかい口語〜軽い敬語（〜ですね / 〜かな / 〜すごいですね）」にする（馴れ馴れしすぎるタメ口は避ける）。";
    const jaGoodSample =
      register === "casual"
        ? "24時間でこの規模はさすがにエグい"
        : "24時間でこの数字はすごいですね、ここから定着するか気になる";
    return {
      formatBlock: [
        "【日本語での返信ルール（絶対厳守）】",
        "1. 100%自然な日本語のみ（英語の文章は絶対禁止）。8〜28文字の短い一言だけ。",
        `2. ${jaRegisterRule}`,
        `3. ${punctHintJa}`,
        `4. 比較 — ❌AI臭い：「素晴らしい取り組みですね、今後の展開に注目です」 / ✅リアル：「${jaGoodSample}」`,
      ].join("\n"),
      userReminder: `投稿の要点をつかんでから【日本語のみ】で自然な短い一言を書いて（8〜28文字、英語禁止）。\n${twoLineInstruction}`,
    };
  }

  if (lang.code === "ko") {
    const koRegisterRule =
      register === "casual"
        ? "말투: 원글이 반말/밈 분위기라 가벼운 반말 구어체 OK."
        : register === "empathetic"
          ? "말투: 무거운/안타까운 글이라 차분하고 진심 어린 해요체로만 짧게."
          : "말투: 일반/공식 글이라 과하지 않고 편한 해요체(~네요 / ~같아요 / ~인가요)로 자연스럽게 (무례한 반말 금지).";
    const koGoodSample =
      register === "casual"
        ? "하루 만에 이 규모면 진짜 빠르긴 하네"
        : "하루 만에 이 정도 규모면 생각보다 훨씬 빠른데요";
    return {
      formatBlock: [
        "【한국어 답글 규칙 (필수)】",
        "1. 100% 자연스러운 한국어 한 줄 (6–28자, 영어 문장 절대 금지).",
        `2. ${koRegisterRule}`,
        "3. 마침표/느낌표/따옴표/이모지/해시태그 금지 (질문이면 '?' 가능).",
        `4. 비교 — ❌AI 말투: '정말 주목할 만한 소식이네요, 앞으로가 기대됩니다' / ✅진짜 사람: '${koGoodSample}'`,
      ].join("\n"),
      userReminder: `원글 핵심을 먼저 파악하고 반드시 【한국어만】 써서 자연스러운 한 줄 답글을 써줘 (6–28자, 영어 금지).\n${twoLineInstruction}`,
    };
  }

  if (lang.code === "id") {
    const idRegisterRule =
      register === "semi_casual"
        ? "Gaya bahasa: post aslinya rapi/resmi, jadi balas pakai Bahasa Indonesia santai yang sopan dan netral (jangan pakai gw/lu yang terlalu sok akrab)."
        : register === "empathetic"
          ? "Gaya bahasa: post bernuansa sedih/musibah, balas singkat, tulus, dan tenang (tanpa candaan/wkwk)."
          : "Gaya bahasa: santai khas warga X di HP ('sih', 'aja', 'udah', 'gak', 'emang', 'kayaknya' secukupnya kalau pas).";
    const idGoodSample =
      register === "semi_casual"
        ? "baru 24 jam angkanya udah segitu, cepat juga pertumbuhannya"
        : "baru 24 jam udah masuk segitu, lumayan kenceng juga nih";
    return {
      formatBlock: [
        "ATURAN BALASAN BAHASA INDONESIA (WAJIB):",
        "1. 100% Bahasa Indonesia natural, 1 celetukan pendek (4–12 kata), jangan balas pakai bahasa Inggris.",
        `2. ${idRegisterRule}`,
        `3. ${punctHintLatin}`,
        `4. Contoh — ❌AI kaku: 'langkah yang solid banget, tapi eksekusi jangka panjang tetap paling penting' / ✅Manusia: '${idGoodSample}'`,
      ].join("\n"),
      userReminder: `Pahami inti post dulu lalu balas 100% pakai 【Bahasa Indonesia】 yang natural (4–12 kata, dilarang bahasa Inggris).\n${twoLineInstruction}`,
    };
  }

  if (lang.code === "en") {
    return {
      formatBlock: [
        "MANDATORY ENGLISH REPLY STYLE:",
        "1. 100% natural everyday English — 1 short off-the-cuff line (4–12 words), ONE concrete human thought.",
        `2. ${punctHintLatin}`,
        "3. Contrast — ❌AI slop: 'this partnership sounds great, but real adoption matters most' / ✅Human: '$524m in 24 hours is kinda wild if that pace actually holds'",
        "4. Never use two-sided essay templates ('X sounds nice, but Y matters most') or AI clichés ('totally agree', 'spot on', 'worth watching', 'game changer', 'time will tell', 'execution is key').",
      ].join("\n"),
      userReminder: `Grasp the exact point first, then write 1 unpolished human 【English】 reply (4–12 words, zero AI clichés).\n${twoLineInstruction}`,
    };
  }

  if (lang.code === "same") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & NATURAL STYLE:",
        "1. Match the EXACT language of MAIN POST (including legible text inside attached images) — 1 short spontaneous line (4–12 words or 8–26 CJK chars).",
        "2. Match the post's politeness/mood naturally. For casual Latin scripts, use lowercase. No ending period, no exclamation mark, no quotes, no emojis, no hashtags.",
      ].join("\n"),
      userReminder: `Identify the post's exact language and point first, then reply strictly in THAT same language.\n${twoLineInstruction}`,
    };
  }

  if (lang.nonLatin) {
    return {
      formatBlock: [
        `MANDATORY LANGUAGE & FORMAT (${lang.label.toUpperCase()} / ${lang.nativeName}):`,
        `1. Reply 100% in natural native ${lang.label} (${lang.nativeName}), 1 short spontaneous line (4–12 words). FORBIDDEN: English.`,
        "2. No ending period, no exclamation mark, no quotes, no emojis, no hashtags ('?' allowed if asking).",
      ].join("\n"),
      userReminder: `Grasp the post first, then write 1 natural native ${lang.label} (${lang.nativeName}) reply — NEVER English.\n${twoLineInstruction}`,
    };
  }

  return {
    formatBlock: [
      `MANDATORY LANGUAGE & FORMAT (${lang.label.toUpperCase()}):`,
      `1. Reply 100% in relaxed everyday ${lang.label}, 1 short spontaneous line (4–12 words). Do NOT switch to English.`,
      `2. ${punctHintLatin}`,
    ].join("\n"),
    userReminder: `Grasp the post first, then write 1 natural ${lang.label} reply — NEVER switch to English.\n${twoLineInstruction}`,
  };
}

function buildSystemHeader(lang, register = "casual") {
  switch (lang.code) {
    case "ja":
      return register === "casual"
        ? "あなたはスマホでXを流し見しながら気楽にリプを返す普通の日本人ユーザーです。AIっぽさや解説口調を消し、自然な日本語の短い一言だけ返してください。"
        : "あなたはXを普段使いしている普通の日本人ユーザーです。相手の投稿の雰囲気に合わせた自然な日本語（硬すぎず失礼でもない口語〜軽い敬語）で、AIっぽさのない短い一言を返してください。";
    case "id":
      return register === "semi_casual"
        ? "Kamu pengguna X Indonesia biasa yang membalas secara santai tapi tetap sopan dan natural sesuai gaya post aslinya — jangan kaku kayak AI atau berita."
        : "Kamu pengguna X Indonesia biasa yang lagi santai scroll timeline dari HP dan nimbrung pakai celetukan singkat. Balas selalu pakai Bahasa Indonesia yang beneran natural dan manusiawi — jangan pernah kaku kayak AI.";
    case "zh-CN":
      return "你是一个刷X手机随手评论的普通中文网友。彻底去掉AI味和点评腔，只用一句简短自然的简体中文口语回复。";
    case "zh-TW":
      return "你是一個滑X手機隨手留言的普通中文網友。徹底去掉AI味和評論腔，只用一句簡短自然的繁體中文口語回覆。";
    case "ko":
      return register === "casual"
        ? "너는 폰으로 트위터 보다가 가볍게 답글 다는 평범한 한국인 유저야. AI 티나 해설가 말투를 빼고 자연스러운 한국어 한 줄만 짧게 써."
        : "당신은 트위터를 일상적으로 쓰는 평범한 한국인 유저입니다. AI 말투나 해설조를 완전히 빼고, 부담 없이 자연스러운 해요체로 짧은 한 줄 답글만 작성하세요.";
    default:
      return "You are an ordinary human casually scrolling X on your phone, firing off quick off-the-cuff replies. Never sound polished, wise, balanced, or AI-generated — just react naturally in the exact target language.";
  }
}

function buildGroundingRules(lang) {
  switch (lang.code) {
    case "ja":
      return [
        "【まず投稿をしっかり読む・文脈厳守・捏造禁止】",
        "- 返信を書く前に必ず「MAIN POST」（および添付画像）の全文を読み、投稿者が何を言いたいのか・どんなノリ（ネタ/皮肉/質問/報告/愚痴）なのかを正確に把握する。",
        "- 投稿に実際に書かれている内容・話題だけに自然に反応する。",
        "- 投稿にない事実・数字・日付・噂・機能や、「前から使ってる」「動画見た」みたいな嘘の体験談は絶対に捏造しない。",
        "- 投稿の具体的なポイント1つに自然に絡め、どの投稿にも当てはまる適当な相槌や言い換えは避ける。",
        "- 1つの素直な一言だけ。AIっぽい「〜は良いけど結局〜が大事」の二段構えは禁止。",
      ].join("\n");
    case "id":
      return [
        "BACA POST DULU — ATURAN KONTEKS & ANTI-HALU (WAJIB):",
        "- Sebelum bikin balasan, pahami dulu isi lengkap MAIN POST (dan gambar terlampir jika ada): topik persisnya apa, maksud author apa, dan suasananya gimana (becanda/sarkas/curhat/berita/pertanyaan).",
        "- Balas HANYA berdasarkan fakta, topik, dan hal yang benar-benar tertulis/terlihat di post itu.",
        "- DILARANG mengarang fakta luar, angka, tanggal, fitur yang tidak disebut, atau pengalaman palsu (misal 'udah nyoba kemarin' atau 'keren videonya').",
        "- Tangkap 1 detail spesifik dari post biar jelas kamu beneran baca — jangan kasih komen generik atau cuma ngulang isi post.",
        "- Cukup 1 celetukan manusiawi yang simpel, hindari pola AI sok bijak dua sisi ('X sih bagus, tapi Y lebih penting').",
      ].join("\n");
    case "zh-CN":
      return [
        "【先读懂原帖・严格紧扣上下文・严禁编造】",
        "- 回复前先完整读懂MAIN POST（及清晰可见的附图）到底在说什么、作者是什么语气（玩梗/吐槽/提问/消息）。",
        "- 只针对原帖里真实出现的事实、话题和观点自然接话，严禁瞎编帖子里没提到的数字、时间、功能或虚假个人经历。",
        "- 抓住帖子里1个具体点自然回应，别复述原话，也别发放到哪条都能用的水评。",
        "- 只说1个直觉反应，绝不写“虽然…但更重要的是…”这种AI味套话。",
      ].join("\n");
    case "zh-TW":
      return [
        "【先讀懂原貼文・嚴格緊扣上下文・嚴禁捏造】",
        "- 回覆前先完整讀懂MAIN POST（及清楚可見的附圖）到底在說什麼、作者是什麼語氣。",
        "- 只針對原貼文真實出現的內容與話題自然接話，嚴禁編造沒提到的數字、日期、功能或假個人經歷。",
        "- 抓住貼文裡1個具體細節自然回應，不要重複原話或發空泛罐頭留言。",
        "- 只講1個直覺反應，絕不寫「雖然…但更重要的是…」這種AI套話。",
      ].join("\n");
    case "ko":
      return [
        "【먼저 글 정확히 읽기 & 지어내기 금지】",
        "- 답글 쓰기 전에 MAIN POST(와 첨부 이미지)의 핵심 내용과 분위기(농담/진지함/질문/소식)를 먼저 정확히 파악해.",
        "- 글에 실제로 나온 사실·주제에만 맞춰 자연스럽게 반응하고, 없는 숫자·날짜·기능이나 '어제 써봤는데', '영상 잘 봤어' 같은 거짓 경험담은 절대 지어내지 마.",
        "- 글의 구체적인 포인트 하나를 콕 짚어 자연스럽게 답하고, 아무 글에나 붙일 수 있는 뻔한 반응이나 말 되풀이 금지.",
        "- 꾸미지 않은 짧은 생각 하나만 던져. 'A는 좋지만 B가 더 중요하다' 같은 AI 해설 금지.",
      ].join("\n");
    default:
      return [
        "READ POST FIRST — STRICT FACT-LOCK (ZERO HALLUCINATION):",
        "- Before writing a single word, carefully read the entire MAIN POST (and attached image if present) to grasp its exact point and mood (joking, sarcastic, venting, news, question).",
        "- React ONLY to facts, claims, or details actually stated in the post (or clearly visible in attached images).",
        "- NEVER invent outside facts, extra numbers, fake dates, unmentioned features, or fake personal experiences (e.g. 'been using this for weeks', 'just watched the video').",
        "- Anchor on ONE concrete detail from the post so it unmistakably fits this exact tweet — never drop vague generic filler or parrot/reword the post back.",
        "- Keep it to ONE quick, unpolished human thought — never use balanced two-part AI takes ('X is nice, but Y matters most').",
      ].join("\n");
  }
}

function contextLock(lang, post, detected, customStylePrompt, angle, recentReplies, visionAttached = false, options = {}) {
  const explicitAngle =
    angle && angle !== "auto" ? String(angle).toLowerCase() : "auto";
  const mood = options.mood || detectPostMood(post);
  const register = options.register || detectSocialRegister(post, lang, mood);
  const { intentBlock, hasMetrics } = analyzePostIntent(
    post,
    explicitAngle,
    visionAttached,
    mood,
    register,
    options
  );
  const entityBlock = buildEntityAnchor(post, detected);
  const memoryBlock = buildAntiRepetitionBlock(recentReplies);
  const { formatBlock, userReminder } = buildLanguageAndFormatDirectives(lang, register, mood);
  const upgradedStyle = upgradeLegacyStylePrompt(customStylePrompt);
  const localizedPersona =
    mood === "sensitive" ? "" : resolveLocalizedPersona(upgradedStyle, lang);

  const sections = [
    buildGroundingRules(lang),
    "",
    intentBlock,
    "",
    entityBlock,
  ];

  if (memoryBlock) {
    sections.push("", memoryBlock);
  }

  if (localizedPersona) {
    sections.push(
      "",
      `TONE / VIBE (attitude only — NEVER override target language ${lang.label}, post mood, or invent facts):`,
      localizedPersona
    );
  }

  // Keep mandatory language & naturalness rules at the very end for maximum adherence
  sections.push("", formatBlock);

  return {
    systemLock: sections.join("\n"),
    userReminder,
    mood,
    register,
    hasMetrics,
  };
}

// ═══════════════════════════════════════════════════════════════
// Silent Read-Then-Reply Parser & Post-Generation Quality Guard
// ═══════════════════════════════════════════════════════════════
function extractStructuredReply(rawText) {
  const s = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
  if (!s) return "";

  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Look for explicit REPLY: line (supports markdown **REPLY:** / **REPLY**: and localized labels)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(
      /^\*{0,2}(?:REPLY|BALASAN|返信|回复|回覆|답글)\*{0,2}\s*[:：]\s*\*{0,2}\s*(.+)$/i
    );
    if (m && m[1]) {
      return m[1].trim();
    }
  }

  // If the model started writing POINT: but never reached REPLY: (truncated), NEVER leak POINT: into X
  if (/^\*{0,2}(?:POINT|INTI|要点)\*{0,2}\s*[:：]/i.test(lines[0])) {
    if (lines.length >= 2) {
      const candidate = lines[lines.length - 1];
      if (!/^\*{0,2}(?:POINT|INTI|要点)\*{0,2}\s*[:：]/i.test(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  // Fallback for models that ignored the 2-line template and returned a direct reply
  return s.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}

function patchCompletionReply(res, cleanReply) {
  if (!res || !res.data) return res;
  const clonedData = { ...res.data };
  if (Array.isArray(clonedData.choices) && clonedData.choices.length > 0) {
    const first = { ...clonedData.choices[0] };
    first.message = { ...(first.message || {}), content: cleanReply };
    clonedData.choices = [first, ...clonedData.choices.slice(1)];
  }
  return { ...res, data: clonedData };
}

const AI_SLOP_RE =
  /(?:\b(?:sounds?|looks?|is)\s+(?:nice|good|great|catchy|clean|solid|promising|cool|interesting),?\s+but\s+(?:the\s+real|real|actual|execution|adoption|it\s+still|what\s+matters)\b|\b(?:totally agree|couldn't agree more|spot on|great insight|game changer|time will tell|let that sink in|worth watching|at the end of the day|the real test is|execution is key|quietly building|more than just branding|solid move)\b|\bisn't just\b.{2,30}\bit's\b|\b(?:setuju banget|patut ditunggu|mantap jiwa|langkah yang solid|yang paling penting|lebih dari sekadar|menarik untuk disimak|waktu yang akan menjawab)\b|注目ですね|目が離せない|完全に同意|素晴らしい洞察|今後の展開に期待|が鍵になります|興味深いですね|本質は|值得关注|拭目以待|完全同意|说得太对了|意义重大|未来可期|真正的考验在于|值得關注|意義重大|未來可期|주목할 만하네요|전적으로 동의합니다|좋은 인사이트|지켜봐야겠네요|앞으로가 기대됩니다)/i;

const VIDEO_CLAIM_RE =
  /\b(?:great|nice|awesome|cool|loved|watched|watching)\s+(?:the\s+|this\s+)?video\b|\b(?:keren|bagus|lucu)\s+videonya\b|動画見た|動画最高|영상 잘 봤|视频很棒/i;

const UNSEEN_VISUAL_CLAIM_RE =
  /\b(?:nice|clean|great|crazy|wild|love\s+this|sick)\s+(?:chart|photo|pic|image|screenshot|graphic|logo)\b|\b(?:chartnya|gambarnya|fotonya)\s+(?:keren|bagus|gila)\b|画像見|チャート見/i;

function computeWordOverlapRatio(a, b) {
  const toWords = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[$@#][a-z0-9_]+/gi, " ")
      .replace(/[^a-z0-9\u00c0-\u024f\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4);

  const wordsA = toWords(a);
  const wordsB = new Set(toWords(b));
  if (wordsA.length < 4 || wordsB.size < 4) return 0;
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared += 1;
  }
  return shared / wordsA.length;
}

function auditGeneratedReply(replyText, post, lang, options = {}) {
  const issues = [];
  const clean = String(replyText || "").trim();
  if (!clean) {
    issues.push("empty");
    return issues;
  }

  if (!isReplyInExpectedLanguage(clean, lang)) {
    issues.push("wrong_lang");
  }

  if (AI_SLOP_RE.test(clean)) {
    issues.push("ai_slop");
  }

  // Detect parroting (copying >=75% of meaningful words verbatim from the post)
  if (post?.tweetText && options.mood !== "greeting") {
    const overlap = computeWordOverlapRatio(clean, post.tweetText);
    if (overlap >= 0.75) {
      issues.push("parroting");
    }
  }

  // Detect hallucinating unseen video or unseen image when Vision wasn't attached
  if (post?.mediaType === "Video Post" && VIDEO_CLAIM_RE.test(clean)) {
    issues.push("media_hallucination");
  } else if (
    !options.visionAttached &&
    post?.mediaType === "Image/Chart Post" &&
    !post?.imageAlt &&
    UNSEEN_VISUAL_CLAIM_RE.test(clean)
  ) {
    issues.push("media_hallucination");
  }

  // Detect overly long essay-style replies
  if (lang?.cjk || lang?.korean) {
    if (clean.length > 65) issues.push("too_long");
  } else {
    const wc = clean.split(/\s+/).filter(Boolean).length;
    if (wc > 26 || clean.length > 190) issues.push("too_long");
  }

  // On Regenerate, flag if the model produced almost the exact same reply as previousDraft
  if (options.previousDraft) {
    const normNew = clean.toLowerCase().replace(/\s+/g, "");
    const normOld = String(options.previousDraft).toLowerCase().replace(/\s+/g, "");
    if (normNew === normOld || computeWordOverlapRatio(clean, options.previousDraft) >= 0.65) {
      issues.push("same_as_previous");
    }
  }

  return issues;
}

function buildQualityFixMessages(draftReply, issues, lang, post, options = {}) {
  const postSnippet = String(
    post?.tweetText ||
      post?.articleTitle ||
      post?.selfThreadContinuation ||
      post?.pollOptions ||
      post?.quotedText ||
      post?.cardSummary ||
      post?.imageAlt ||
      ""
  ).slice(0, 320);

  const fixNotes = [];
  if (issues.includes("wrong_lang")) {
    fixNotes.push(`Must be 100% natural native ${lang.label} (${lang.nativeName || lang.label}) — ZERO English sentences if target is non-English.`);
  }
  if (issues.includes("ai_slop")) {
    fixNotes.push("Remove ALL AI clichés and two-sided contrast templates ('X sounds nice, but Y matters most', 'worth watching', 'setuju banget', '注目ですね'). Make it sound like a real human.");
  }
  if (issues.includes("parroting")) {
    fixNotes.push("Do NOT repeat/reword the post text back — react with a fresh human response or quick question instead.");
  }
  if (issues.includes("media_hallucination")) {
    fixNotes.push("Do NOT pretend you watched the video or saw an unseen chart/image — react strictly to the written post text only.");
  }
  if (issues.includes("too_long")) {
    fixNotes.push("Shorten sharply to ONE brief spontaneous X line (4–12 words or 8–26 CJK chars).");
  }
  if (issues.includes("same_as_previous") && options.previousDraft) {
    fixNotes.push(`Completely abandon the angle/wording of "${options.previousDraft}" and react to a different aspect of the post.`);
  }

  const targetDesc = `${lang.label}${lang.nativeName ? ` (${lang.nativeName})` : ""}`;
  const registerHint =
    lang.code === "ja" && options.register !== "casual"
      ? "Use soft natural Japanese (やわらかい口語〜軽い敬語), no '。', no emojis."
      : lang.code === "ko" && options.register !== "casual"
        ? "Use natural polite Korean (해요체), no ending period, no emojis."
        : lang.cjk
          ? "1 short casual line (8–24 chars), no '。', no emojis, no quotes."
          : lang.korean
            ? "1 short casual Korean line (6–28 chars), no ending period, no emojis."
            : lang.nonLatin
              ? "1 short natural line (4–12 words), no ending period, no emojis."
              : "1 short casual line (4–12 words), lowercase, no ending period, no emojis, no quotes.";

  return [
    {
      role: "system",
      content:
        `Rewrite the draft X reply strictly in natural native ${targetDesc}. ` +
        `Fix these exact issues:\n- ${fixNotes.join("\n- ")}\n` +
        `Format: ${registerHint} Output ONLY the final reply line (no POINT/REPLY prefix).`,
    },
    {
      role: "user",
      content:
        `Target post: ${postSnippet}\n` +
        `Draft to fix: ${draftReply}\n\n` +
        `Output ONLY the fixed ${targetDesc} reply:`,
    },
  ];
}

function buildRewriteMessages(wrongReply, lang, post) {
  return buildQualityFixMessages(wrongReply, ["wrong_lang"], lang, post);
}

const MAX_VISION_IMAGES = 4;
const MAX_INLINE_IMAGE_BYTES = 2.5 * 1024 * 1024;
const MAX_TOTAL_INLINE_BYTES = 4.5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 4500;

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function downgradeXMediaToMedium(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)twimg\.com$/i.test(u.hostname) && u.searchParams.has("name")) {
      u.searchParams.set("name", "medium");
      return u.toString();
    }
  } catch (e) {}
  return "";
}

// Fetch X media directly in the service worker and inline as base64 Data URI
// so third-party / self-hosted Vision APIs can always see the exact images even if they cannot fetch pbs.twimg.com
async function fetchImageAsDataUrl(url, maxAllowedBytes = MAX_INLINE_IMAGE_BYTES) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)twimg\.com$/i.test(parsed.hostname)) {
      return { payload: url, bytes: 0 };
    }
  } catch (e) {
    return { payload: url, bytes: 0 };
  }

  const fetchOnce = async (targetUrl) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(targetUrl, {
        method: "GET",
        signal: controller.signal,
        cache: "force-cache",
      });
      if (!resp.ok) {
        // Drop dead/expired media (404/410) instead of feeding broken URLs to Vision
        if (resp.status === 404 || resp.status === 410) return { drop: true };
        return { fallbackUrl: targetUrl };
      }
      const rawType = String(resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      // Never base64-encode HTML/XML error pages or SVG as fake image/jpeg
      if (!rawType.startsWith("image/") || rawType === "image/svg+xml") {
        return { drop: true };
      }
      const normalizedType = rawType === "image/jpg" ? "image/jpeg" : rawType;
      const supportedMime = /^image\/(jpeg|png|webp|gif)$/i.test(normalizedType)
        ? normalizedType
        : "";
      if (!supportedMime) {
        return { fallbackUrl: targetUrl };
      }
      const buf = await resp.arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        return { drop: true };
      }
      if (buf.byteLength > maxAllowedBytes) {
        return { tooLarge: true, fallbackUrl: targetUrl };
      }
      const b64 = bytesToBase64(new Uint8Array(buf));
      return { payload: `data:${supportedMime};base64,${b64}`, bytes: buf.byteLength };
    } catch (e) {
      return { fallbackUrl: targetUrl };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await fetchOnce(url);
  if (res.tooLarge) {
    const mediumUrl = downgradeXMediaToMedium(url);
    if (mediumUrl && mediumUrl !== url) {
      res = await fetchOnce(mediumUrl);
    }
  }
  if (res.drop) return { payload: "", bytes: 0 };
  if (res.payload) return { payload: res.payload, bytes: res.bytes };
  return { payload: res.fallbackUrl || url, bytes: 0 };
}

async function prepareVisionImagePayloads(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];
  const validUrls = imageUrls
    .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
    .slice(0, MAX_VISION_IMAGES);
  if (validUrls.length === 0) return [];

  const fetched = await Promise.all(validUrls.map((url) => fetchImageAsDataUrl(url, MAX_INLINE_IMAGE_BYTES)));
  const payloads = [];
  let totalBytes = 0;

  for (let i = 0; i < fetched.length; i++) {
    const item = fetched[i];
    if (!item || !item.payload) continue;
    if (item.bytes > 0) {
      if (totalBytes + item.bytes <= MAX_TOTAL_INLINE_BYTES) {
        totalBytes += item.bytes;
        payloads.push(item.payload);
      } else {
        // Keep total JSON body safely under proxy size limits by falling back to remote URL for overflow images
        payloads.push(validUrls[i]);
      }
    } else {
      payloads.push(item.payload);
    }
  }
  return payloads;
}

function buildUserContentWithVision(textPrompt, resolvedImages, visionEnabled) {
  if (!visionEnabled || !Array.isArray(resolvedImages) || resolvedImages.length === 0) {
    return textPrompt;
  }
  const valid = resolvedImages
    .filter((u) => typeof u === "string" && (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)))
    .slice(0, MAX_VISION_IMAGES);
  if (valid.length === 0) return textPrompt;

  // Use "high" detail for 1-2 images so small chart numbers and screenshot text are crystal clear
  const detailLevel = valid.length <= 2 ? "high" : "auto";
  return [
    { type: "text", text: textPrompt },
    ...valid.map((url) => ({
      type: "image_url",
      image_url: { url, detail: detailLevel },
    })),
  ];
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

function extractReplyContentFromData(data) {
  const msg = data?.choices?.[0]?.message;
  let text = extractMessageContentString(msg?.content);
  if (!text && typeof data?.choices?.[0]?.text === "string") {
    text = data.choices[0].text;
  }
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

function isNonVisionConfigError(res) {
  if (!res || !res.data) return false;
  const raw =
    typeof res.data.error === "string"
      ? res.data.error
      : typeof res.data.error?.message === "string"
        ? res.data.error.message
        : typeof res.data.error?.code === "string"
          ? res.data.error.code
          : JSON.stringify(res.data.error || res.data._raw || "");
  return /model[_ ]?not[_ ]?found|does not exist|unknown model|invalid[_ ]?api[_ ]?key|unauthorized|authentication|insufficient[_ ]?quota|billing|rate[_ ]?limit|context[_ ]?length/i.test(
    String(raw)
  );
}

function hasAnyTargetNonLatinScript(text, lang) {
  const s = String(text || "");
  if (!s || !lang) return false;
  switch (lang.code) {
    case "ja":
      return /[\u3040-\u30ff\uff66-\uff9f]/.test(s);
    case "ko":
      return /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(s);
    case "zh-CN":
    case "zh-TW":
      return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);
    case "ru":
    case "uk":
      return /[\u0400-\u04ff]/.test(s);
    case "ar":
      return /[\u0600-\u06ff\u0750-\u077f]/.test(s);
    case "th":
      return /[\u0e00-\u0e7f]/.test(s);
    case "hi":
      return /[\u0900-\u097f]/.test(s);
    default:
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Endpoint Validation & Shared Fetch Runner
// ═══════════════════════════════════════════════════════════════
function validateEndpoint(endpoint) {
  if (!endpoint) return { error: "Base URL is empty. Set it in Settings." };
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    return {
      error: `Invalid Base URL: "${endpoint}". Example: https://api.x.ai/v1`,
    };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { error: `Base URL must use http:// or https://, not "${parsed.protocol}"` };
  }
  return { parsed, originPattern: parsed.origin + "/*" };
}

function hasHostPermission(originPattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [originPattern] }, (granted) => {
        void chrome.runtime.lastError;
        resolve(!!granted);
      });
    } catch (e) {
      resolve(true);
    }
  });
}

async function probeOrigin(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(origin + "/", {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
    });
    return { reachable: true, status: resp.status };
  } catch (e) {
    return {
      reachable: false,
      reason: e && e.name === "AbortError" ? "no response" : (e && e.message) || "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCompletion({ endpoint, parsedEndpoint, originPattern, apiKey, body, timeoutMs }) {
  const granted = await hasHostPermission(originPattern);
  if (!granted) {
    return {
      ok: false,
      code: "no_permission",
      error:
        `Missing host permission for ${parsedEndpoint.origin}. ` +
        `Open Settings → click "Allow Host Access" → Allow.`,
    };
  }

  const limit = normalizeTimeout(timeoutMs);
  const startedAt = Date.now();

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "follow",
      });

      const rawBody = await resp.text();
      let data = null;
      try {
        data = rawBody ? JSON.parse(rawBody) : null;
      } catch (e) {
        data = { _raw: rawBody.slice(0, 500) };
      }
      return {
        ok: resp.ok,
        status: resp.status,
        data,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (!err || err.name !== "TypeError" || i === 1) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  const err = lastErr || new Error("unknown error");
  const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

  if (err.name === "AbortError") {
    const probe = await probeOrigin(parsedEndpoint.origin);
    const verdict = probe.reachable
      ? `Server at ${parsedEndpoint.origin} is reachable (HTTP ${probe.status}), but ` +
        `/chat/completions did not finish within ${elapsedSec}s. ` +
        `Try increasing "Request Timeout" in Settings for slower reasoning models.`
      : `Host ${parsedEndpoint.host} did not respond over HTTP (${probe.reason}). ` +
        `Check the Base URL, port, and server status.`;
    return { ok: false, code: "timeout", error: `Timed out after ${elapsedSec}s. ${verdict}` };
  }

  if (
    err.name === "TypeError" ||
    /failed to fetch|networkerror|load failed|network error/i.test(err.message || "")
  ) {
    return {
      ok: false,
      code: "failed_to_fetch",
      error:
        `Could not reach ${parsedEndpoint.host}. Possible causes: ` +
        `(1) missing host permission → Settings → "Allow Host Access", ` +
        `(2) wrong Base URL or port, ` +
        `(3) server refused connection, ` +
        `(4) try https:// if Base URL uses http://. [detail: ${err.message}]`,
    };
  }

  return { ok: false, code: "network", error: err.message || String(err) };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request && request.action;

  if (action === "openOptions") {
    try {
      chrome.runtime.openOptionsPage(() => {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }

  if (action === "clearReplyMemory") {
    clearRecentReplies().then(sendResponse);
    return true;
  }

  if (
    action !== "generateReply" &&
    action !== "testConnection" &&
    action !== "translatePreview"
  ) {
    return false;
  }

  const {
    endpoint,
    apiKey,
    model,
    systemPrompt,
    post,
    timeoutMs,
    angle,
    visionMode,
    previousDraft,
    userSeed,
    replyText,
    sourceLang,
  } = request;

  const check = validateEndpoint(endpoint);
  if (check.error) {
    sendResponse({ ok: false, code: "invalid_endpoint", error: check.error });
    return true;
  }
  if (!apiKey || !String(apiKey).trim()) {
    sendResponse({ ok: false, code: "no_key", error: "API key is empty. Please set it in Settings." });
    return true;
  }

  const parsedEndpoint = check.parsed;
  const originPattern = check.originPattern;
  const cleanKey = String(apiKey).trim();

  if (action === "testConnection") {
    runCompletion({
      endpoint,
      parsedEndpoint,
      originPattern,
      apiKey: cleanKey,
      timeoutMs,
      body: {
        model: model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 64,
        stream: false,
      },
    })
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, code: "internal", error: err?.message || String(err) })
      );
    return true;
  }

  // Non-blocking English Translation Preview for non-English replies (ZH, JA, KO, ID, AR, RU, ES, etc.)
  if (action === "translatePreview") {
    runCompletion({
      endpoint,
      parsedEndpoint,
      originPattern,
      apiKey: cleanKey,
      timeoutMs: Math.min(normalizeTimeout(timeoutMs), 25000),
      body: {
        model: model,
        messages: [
          {
            role: "system",
            content:
              "Translate the given short X reply into natural, concise English so the user knows its exact meaning before posting. Output ONLY the English translation in 1 short line, no quotes, no explanation.",
          },
          {
            role: "user",
            content: `Source language (${sourceLang || "non-English"}): ${String(replyText || "").slice(0, 280)}\nEnglish meaning:`,
          },
        ],
        max_tokens: 256,
        temperature: 0.2,
        stream: false,
      },
    })
      .then((res) => {
        const translated = res?.ok ? extractReplyContentFromData(res.data) : "";
        sendResponse({
          ok: Boolean(translated),
          translation: translated.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim(),
        });
      })
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err) })
      );
    return true;
  }

  (async () => {
    const baseTimeoutMs = normalizeTimeout(timeoutMs);
    const overallDeadline = Date.now() + Math.min(baseTimeoutMs * 2 + 15000, 320000);
    const remainingBudget = (minFloor = 8000) =>
      Math.min(baseTimeoutMs, Math.max(minFloor, overallDeadline - Date.now()));

    const entityScanText = [
      post?.articleTitle,
      post?.tweetText,
      post?.selfThreadContinuation,
      post?.pollOptions,
      post?.quotedText,
      post?.cardSummary,
    ]
      .filter(Boolean)
      .join("\n");

    const recentReplies = await getRecentReplies();
    const lang = resolveReplyLanguage(post);
    const detected = detectTickersAndProjects(entityScanText);
    const mood = detectPostMood(post);
    const register = detectSocialRegister(post, lang, mood);
    const cleanPrevDraft = String(previousDraft || "").trim().slice(0, 180);
    const cleanUserSeed = String(userSeed || "").trim().slice(0, 160);
    const lockOptions = {
      mood,
      register,
      previousDraft: cleanPrevDraft,
      userSeed: cleanUserSeed,
    };

    const visionEnabled = visionMode !== false;
    const rawVisionUrls =
      visionEnabled && Array.isArray(post?.imageUrls)
        ? post.imageUrls
            .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
            .slice(0, MAX_VISION_IMAGES)
        : [];
    const preparedVisionImages =
      rawVisionUrls.length > 0 ? await prepareVisionImagePayloads(rawVisionUrls) : [];
    const willAttachVision = preparedVisionImages.length > 0;
    const sentInlineDataUri = preparedVisionImages.some((u) => /^data:image\//i.test(u));

    const { systemLock, userReminder, hasMetrics } = contextLock(
      lang,
      post,
      detected,
      systemPrompt,
      angle,
      recentReplies,
      willAttachVision,
      lockOptions
    );

    const dynamicTemp = computeDynamicTemperature({
      angle,
      mood,
      hasMetrics,
      isRegenerate: Boolean(cleanPrevDraft),
      hasUserSeed: Boolean(cleanUserSeed),
    });

    const systemMessage = {
      role: "system",
      content: buildSystemHeader(lang, register) + "\n\n" + systemLock,
    };

    const plainUserPrompt =
      formatPostBlock(post, preparedVisionImages.length) + "\n\n" + userReminder;
    const multimodalContent = buildUserContentWithVision(
      plainUserPrompt,
      preparedVisionImages,
      visionEnabled
    );
    const usedVisionPayload = Array.isArray(multimodalContent);
    let finalVisionAttached = usedVisionPayload;

    let firstRes = await runCompletion({
      endpoint,
      parsedEndpoint,
      originPattern,
      apiKey: cleanKey,
      timeoutMs: baseTimeoutMs,
      body: {
        model: model,
        messages: [
          systemMessage,
          { role: "user", content: multimodalContent },
        ],
        max_tokens: 1024,
        temperature: dynamicTemp,
        stream: false,
      },
    });

    // If base64 payload triggered HTTP 413 Payload Too Large, retry Vision using lightweight remote URLs first
    if (
      usedVisionPayload &&
      sentInlineDataUri &&
      firstRes &&
      !firstRes.ok &&
      firstRes.status === 413 &&
      rawVisionUrls.length > 0 &&
      overallDeadline - Date.now() > 6000
    ) {
      const remoteUrlContent = buildUserContentWithVision(
        formatPostBlock(post, rawVisionUrls.length) + "\n\n" + userReminder,
        rawVisionUrls,
        visionEnabled
      );
      firstRes = await runCompletion({
        endpoint,
        parsedEndpoint,
        originPattern,
        apiKey: cleanKey,
        timeoutMs: remainingBudget(),
        body: {
          model: model,
          messages: [
            systemMessage,
            { role: "user", content: remoteUrlContent },
          ],
          max_tokens: 1024,
          temperature: dynamicTemp,
          stream: false,
        },
      });
    }

    // Automatic plain-text fallback if the configured model/gateway rejected Vision inputs (HTTP 400 / 413 / 415 / 422)
    // Skip fallback when the upstream error is clearly a model/auth/quota misconfiguration
    if (
      usedVisionPayload &&
      firstRes &&
      !firstRes.ok &&
      (firstRes.status === 400 ||
        firstRes.status === 413 ||
        firstRes.status === 415 ||
        firstRes.status === 422) &&
      !isNonVisionConfigError(firstRes)
    ) {
      // Never hallucinate a reply for an image-only post if the model rejected Vision and there is no text context
      if (!hasReadableTextContext(post)) {
        return {
          ok: false,
          code: "vision_required",
          error:
            "This post only contains an image/media and your current model does not support Vision. Switch to a Vision-capable model so AI can actually see the post before replying.",
          detectedLang: lang.code,
        };
      }

      if (overallDeadline - Date.now() > 6000) {
        finalVisionAttached = false;
        // Rebuild system prompt with visionAttached=false so the model never hallucinates unseen images
        const textOnlyLock = contextLock(
          lang,
          post,
          detected,
          systemPrompt,
          angle,
          recentReplies,
          false,
          lockOptions
        );
        const textOnlySystemMessage = {
          role: "system",
          content: buildSystemHeader(lang, register) + "\n\n" + textOnlyLock.systemLock,
        };
        const textOnlyUserPrompt = formatPostBlock(post) + "\n\n" + textOnlyLock.userReminder;

        firstRes = await runCompletion({
          endpoint,
          parsedEndpoint,
          originPattern,
          apiKey: cleanKey,
          timeoutMs: remainingBudget(),
          body: {
            model: model,
            messages: [
              textOnlySystemMessage,
              { role: "user", content: textOnlyUserPrompt },
            ],
            max_tokens: 1024,
            temperature: dynamicTemp,
            stream: false,
          },
        });
      }
    }

    if (!firstRes || !firstRes.ok) {
      return { ...firstRes, detectedLang: lang.code };
    }

    const rawFirstContent = extractReplyContentFromData(firstRes.data);
    const firstCandidate = extractStructuredReply(rawFirstContent);
    const cleanFirstRes = patchCompletionReply(firstRes, firstCandidate);

    // Unified Post-Generation Quality Guard (language, AI slop, parroting, unseen media hallucination, length, regenerate duplicate, or truncated POINT-only output)
    const auditOpts = {
      visionAttached: finalVisionAttached,
      mood,
      register,
      previousDraft: cleanPrevDraft,
    };
    const issues = firstCandidate
      ? auditGeneratedReply(firstCandidate, post, lang, auditOpts)
      : rawFirstContent
        ? ["empty"]
        : [];

    if (issues.length > 0 && (firstCandidate || rawFirstContent) && overallDeadline - Date.now() > 6000) {
      const rewriteRes = await runCompletion({
        endpoint,
        parsedEndpoint,
        originPattern,
        apiKey: cleanKey,
        timeoutMs: remainingBudget(6000),
        body: {
          model: model,
          messages: buildQualityFixMessages(
            firstCandidate || rawFirstContent,
            issues,
            lang,
            post,
            auditOpts
          ),
          max_tokens: 512,
          temperature: Math.min(0.65, dynamicTemp),
          stream: false,
        },
      });

      const rawRewritten = rewriteRes?.ok ? extractReplyContentFromData(rewriteRes.data) : "";
      const rewrittenText = extractStructuredReply(rawRewritten);
      if (rewrittenText) {
        const rewriteIssues = auditGeneratedReply(rewrittenText, post, lang, auditOpts);
        const recoveredEmpty = !firstCandidate && !rewriteIssues.includes("wrong_lang");
        const langFixed =
          issues.includes("wrong_lang") &&
          (!rewriteIssues.includes("wrong_lang") ||
            (!hasAnyTargetNonLatinScript(firstCandidate, lang) &&
              hasAnyTargetNonLatinScript(rewrittenText, lang)));
        const qualityImproved =
          !rewriteIssues.includes("wrong_lang") && rewriteIssues.length < issues.length;

        if (recoveredEmpty || langFixed || qualityImproved) {
          await recordRecentReply(rewrittenText);
          return {
            ...patchCompletionReply(rewriteRes, rewrittenText),
            detectedLang: lang.code,
            detectedLangLabel: lang.label,
            rewrittenLang: issues.includes("wrong_lang"),
            qualityFixed: issues,
          };
        }
      }
    }

    if (firstCandidate) {
      await recordRecentReply(firstCandidate);
    }

    return {
      ...cleanFirstRes,
      detectedLang: lang.code,
      detectedLangLabel: lang.label,
    };
  })()
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, code: "internal", error: err?.message || String(err) })
    );

  return true;
});
