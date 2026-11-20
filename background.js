// Background Service Worker — CORS-free API proxy for X AI Reply.
// v5.2.7 Global Edition: Anti-Hallucination Grounding, Guaranteed Multilingual Engine,
// Vision Multimodal + Auto Text Fallback, Quick Reaction Angles, Anti-Repetition Memory,
// and Live English Translation Preview for non-English replies.

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

// Unambiguous Indonesian stopwords & everyday slang (for detecting Indonesian tweets accurately)
const ID_STOP =
  /\b(yang|yg|dan|ini|itu|tidak|nggak|gak|ga|ngga|dengan|dgn|untuk|utk|dari|dr|ada|akan|sudah|udah|udh|belum|blm|bisa|juga|jg|saya|aku|gue|gw|kamu|lu|elu|kalian|dia|mereka|kita|kami|adalah|karena|krn|kalau|kalo|kl|jadi|jd|pada|atau|lebih|hanya|cuma|sangat|banget|bgt|hari|bukan|loh|lho|sih|dong|nih|tuh|kok|lah|kah|aja|saja|mau|lagi|lg|masih|baru|bikin|pakai|pake|lihat|liat|tahu|tau|gimana|gitu|gini|tapi|tp|memang|emang|kayak|kaya|buat|terus|trs|pas|banyak|semua|orang|kenapa|kapan|dimana|siapa|bagaimana|mantap|keren|parah|anjir|wkwk|wkwkwk|cuy|gan|bang|kak|sekarang|kemarin|besok|makin|paling|jangan|harus|perlu|mungkin|pasti|selalu|pernah|tanpa|sampai|sejak|mulai|cuan|nyangkut|serok|gokil|santuy|bener|benar|bagus|cepat|mahal|murah|beli|jual|dapet|dapat|punya|bilang)\b/g;

// Distinctive English stopwords & common X/CT vocabulary
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

function recordRecentReply(replyText) {
  return new Promise((resolve) => {
    try {
      const clean = String(replyText || "").trim().slice(0, 140);
      if (!clean || !chrome.storage || !chrome.storage.local) return resolve();
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
  });
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
  const idScore = idHits + idMorphHits;
  const enHits = countMatches(EN_STOP, lower);

  if (idScore > 0 && idScore >= enHits) {
    return DOM_LANG_MAP.id;
  }

  const latinLangScores = [
    { key: "es", hits: countMatches(ES_STOP, lower) },
    { key: "pt", hits: countMatches(PT_STOP, lower) },
    { key: "fr", hits: countMatches(FR_STOP, lower) },
    { key: "de", hits: countMatches(DE_STOP, lower) },
    { key: "tr", hits: countMatches(TR_STOP, lower) },
  ].sort((a, b) => b.hits - a.hits);

  if (latinLangScores[0].hits >= 2 && latinLangScores[0].hits >= enHits) {
    return DOM_LANG_MAP[latinLangScores[0].key];
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
  const enHits = countMatches(EN_STOP, lower);
  const latinWords = countMatches(/\b[a-z]{3,}\b/g, lower);

  if (lang.code === "zh-CN" || lang.code === "zh-TW") {
    const hanziCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, raw);
    if (hanziCount < 2 || /[\u3040-\u30ff]/.test(raw)) return false;
    if (enHits >= 2 || latinWords > hanziCount) return false;
    return true;
  }
  if (lang.code === "ja") {
    const kanaCount = countMatches(/[\u3040-\u30ff\uff66-\uff9f]/g, raw);
    const kanjiCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, raw);
    const jpChars = kanaCount + kanjiCount;
    if (jpChars < 2) return false;
    if (raw.length >= 6 && kanaCount === 0) return false;
    if (enHits >= 2 || latinWords > jpChars) return false;
    return true;
  }
  if (lang.code === "ko") {
    const koChars = countMatches(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, raw);
    if (koChars < 2 || enHits >= 2 || latinWords > koChars) return false;
    return true;
  }
  if (lang.code === "ru" || lang.code === "uk") {
    const cyr = countMatches(/[\u0400-\u04ff]/g, raw);
    return cyr >= 3 && enHits < 2;
  }
  if (lang.code === "ar") {
    const ar = countMatches(/[\u0600-\u06ff\u0750-\u077f]/g, raw);
    return ar >= 3 && enHits < 2;
  }
  if (lang.code === "th") {
    const th = countMatches(/[\u0e00-\u0e7f]/g, raw);
    return th >= 3 && enHits < 2;
  }
  if (lang.code === "hi") {
    const hi = countMatches(/[\u0900-\u097f]/g, raw);
    return hi >= 3 && enHits < 2;
  }

  const idScore = countMatches(ID_STOP, lower) + countMatches(ID_MORPH, lower);

  if (lang.code === "id") {
    if (enHits >= 2 && idScore === 0) return false;
    if (enHits >= 3 && enHits > idScore * 2) return false;
    if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(raw)) return false;
    return true;
  }

  if (lang.code === "en") {
    if (idScore >= 2 && enHits === 0) return false;
    if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/.test(raw)) {
      return false;
    }
    return true;
  }

  if (enHits >= 3) {
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

function analyzePostIntent(post, angle = "auto", visionAttached = false) {
  const p = post || {};
  const primary = [p.articleTitle, p.tweetText, p.pollOptions].filter(Boolean).join(" ");
  const full = [primary, p.quotedText, p.cardSummary, p.imageAlt, p.parentContext]
    .filter(Boolean)
    .join(" ");

  const cues = [];
  const explicitAngle = buildAngleDirective(angle);
  if (explicitAngle) {
    cues.push(explicitAngle);
  }

  const isPoll = Boolean(p.pollOptions);
  const isQuestion =
    /[?？](\s|$)/.test(primary) ||
    /\b(thoughts|wdyt|what do you think|which one|agree or disagree|menurut kalian|menurut lo|gimana menurut|pilih mana|setuju gak)\b/i.test(
      primary
    ) ||
    /(怎么看|觉得呢|哪个好|是不是|どう思う|どう思いますか|どっち|어떻게 생각|어떤가요|맞나요)/.test(primary);

  if (!explicitAngle) {
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
  if (visionAttached) {
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
  if (isShipOrCollab && !explicitAngle) {
    cues.push(
      "REACTION CUE — LAUNCH/NEWS: React casually to the exact update announced in the post — skip generic PR praise and never invent unmentioned roadmap details."
    );
  }

  if (p.quotedText) {
    cues.push(
      "CONTEXT CUE — QUOTE TWEET: Keep both the author's caption and the quoted post aligned — respond to the author's actual point about the quote."
    );
  }

  if (p.parentContext) {
    cues.push(
      "CONTEXT CUE — THREAD: Use Earlier Thread Context only for background accuracy; reply directly to TARGET TWEET."
    );
  }

  if (cues.length === 0) {
    cues.push(
      "REACTION CUE — CONTEXT-LOCKED: Match the post's actual mood (joking, sarcastic, venting, news, opinion) and react directly to one concrete detail actually in the post."
    );
  }

  return cues.join("\n");
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
      String(p.articleTitle || "").trim() ||
      String(p.pollOptions || "").trim() ||
      String(p.quotedText || "").trim() ||
      String(p.cardSummary || "").trim() ||
      String(p.imageAlt || "").trim()
  );
}

function formatPostBlock(post) {
  const p = post || {};
  const lines = ["=== TWEET CONTEXT ==="];

  if (p.parentContext) {
    lines.push("EARLIER THREAD ABOVE (background context ONLY — do NOT reply to this instead of the main post):\n" + p.parentContext);
    lines.push("---");
  }

  lines.push("MAIN POST YOU ARE REPLYING TO (read this carefully first):");
  if (p.name || p.handle) {
    lines.push("Author: " + [p.name, p.handle].filter(Boolean).join(" ").trim());
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
  if (p.articleTitle) {
    lines.push("Article Headline: " + p.articleTitle);
  }
  if (p.tweetText) {
    lines.push("Post Text:\n" + p.tweetText);
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
  if (p.imageAlt) {
    lines.push("Attached Image/Chart Alt Description:\n" + p.imageAlt);
  }
  if (p.quotedText) {
    lines.push("---\nQUOTED POST ATTACHED INSIDE IT (context for what the author is reacting to):\n" + p.quotedText);
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

function buildLanguageAndFormatDirectives(lang) {
  const punctHintZh =
    "不要句号「。」、不要感叹号「！」、不要引号、不要emoji、不要标签（发问可以用「？」）。";
  const punctHintJa =
    "句点「。」なし、感嘆符「！」なし、カギ括弧なし、絵文字なし、ハッシュタグなし（質問の「？」はOK）。";
  const punctHintLatin =
    "All lowercase. No ending period, no exclamation mark, no quotes, no emojis, no hashtags ('?' is fine if asking).";

  if (lang.code === "zh-CN") {
    return {
      formatBlock: [
        "必须严格遵守【简体中文】回复规则：",
        "1. 100%使用简体中文，只要1句极简短的真人反应（6–22个汉字），别凑字数。",
        "2. 像真人在X上随手回的一句大白话——只说1个念头，别端着、别像点评或总结。",
        `3. ${punctHintZh}`,
        "4. 禁用AI味句式与套话：「虽然…但更重要的是…」「值得关注」「拭目以待」「完全同意」「说得太对了」「意义重大」「未来可期」「真正的考验在于」。",
        "5. 严禁输出英文整句。",
      ].join("\n"),
      userReminder:
        "只用【简体中文】回一句像真人在X随手打的短话（6-22字，1个简单念头，千万别像AI点评，严禁英文）。只输出回复：",
    };
  }

  if (lang.code === "zh-TW") {
    return {
      formatBlock: [
        "必須嚴格遵守【繁體中文】回覆規則：",
        "1. 100%使用繁體中文，只要1句簡短真人反應（6–22個漢字），別硬湊字數。",
        "2. 像台灣/香港用戶滑X隨手打的口語——只講1個念頭，別寫成評論或翻譯腔，嚴禁簡體字。",
        `3. ${punctHintZh}`,
        "4. 禁用AI味套話：「雖然…但更重要的是…」「值得關注」「拭目以待」「完全同意」「意義重大」「未來可期」。",
        "5. 嚴禁輸出英文整句。",
      ].join("\n"),
      userReminder:
        "只用【繁體中文】回一句像真人在X隨手打的短話（6-22字，自然口語，別像AI評論，嚴禁英文）。只輸出回覆：",
    };
  }

  if (lang.code === "ja") {
    return {
      formatBlock: [
        "【日本語での返信ルール（絶対厳守）】",
        "1. 必ず100%自然な日本語だけで返す（英語で返すのは絶対禁止）。長さは8〜28文字の短い一言だけ。",
        "2. Xのタイムラインでスマホから思わず返すようなリアルな口語（タメ口・ゆるい独り言感・自然な相槌）。",
        "3. 1つの素直なリアクションだけを書く。「〜は良いけど、結局〜が大事」みたいなバランスの取れた解説・AIっぽいまとめは絶対NG。",
        `4. ${punctHintJa}`,
        "5. 禁止ワード・AI臭い表現：「注目ですね」「目が離せない」「完全に同意」「素晴らしい洞察」「今後の展開に期待」「確かに〜ですが」「〜が鍵になります」「興味深いですね」「本質は〜」。",
      ].join("\n"),
      userReminder:
        "必ず【日本語のみ】で、Xの一般ユーザーがスマホからポロッと返すような短い一言を書いて（8〜28文字、解説口調やAI臭い表現は禁止、英語禁止）。返信本文だけ出力：",
    };
  }

  if (lang.code === "ko") {
    return {
      formatBlock: [
        "【한국어 답글 규칙 (필수)】",
        "1. 100% 자연스러운 한국어로만 짧은 한마디 작성 (6–28자, 영어 문장 절대 금지).",
        "2. 트위터 보다가 폰으로 툭 던지는 진짜 사람 말투 (가벼운 구어체, 생각 하나만 담백하게).",
        "3. 'A는 좋지만 결국 B가 중요하다' 같은 AI 해설/균형잡기 문장 절대 금지.",
        "4. 마침표/느낌표/따옴표/이모지/해시태그 금지 (질문이면 '?' 가능).",
        "5. 금지 표현: '주목할 만하네요', '기대됩니다', '전적으로 동의합니다', '좋은 인사이트', '지켜봐야겠네요'.",
      ].join("\n"),
      userReminder:
        "반드시 【한국어만】 써서 트위터에서 폰으로 툭 던지는 진짜 사람 답글 한 줄만 써줘 (6-28자, AI 해설 말투 금지, 영어 금지). 본문만:",
    };
  }

  if (lang.code === "id") {
    return {
      formatBlock: [
        "ATURAN BALASAN BAHASA INDONESIA (WAJIB):",
        "1. Balas 100% pakai Bahasa Indonesia santai khas warga X di HP — cukup 1 reaksi pendek & spontan (4–11 kata).",
        "2. Ngobrol biasa aja (pakai 'sih', 'aja', 'udah', 'gak', 'emang', 'kayaknya', 'bentar', 'lah' secukupnya kalau pas). JANGAN terdengar kayak terjemahan Inggris atau artikel berita.",
        "3. Cukup 1 pikiran simpel — JANGAN bikin kalimat sok bijak dua sisi kayak 'X sih bagus, tapi yang paling penting Y'.",
        `4. ${punctHintLatin}`,
        "5. DILARANG kata/pola AI: 'setuju banget', 'menarik banget', 'patut ditunggu', 'luar biasa', 'mantap jiwa', 'yang paling penting', 'lebih dari sekadar', 'langkah yang solid'. DILARANG membalas pakai bahasa Inggris.",
      ].join("\n"),
      userReminder:
        "Balas post di atas 100% pakai 【Bahasa Indonesia】 yang super santai & manusiawi kayak anak X di HP (4-11 kata, huruf kecil semua, tanpa titik, 1 celetukan simpel aja jangan kayak AI, dilarang bahasa Inggris). Tulis balasannya aja:",
    };
  }

  if (lang.code === "en") {
    return {
      formatBlock: [
        "MANDATORY ENGLISH REPLY STYLE:",
        "1. Reply 100% in casual everyday English — 1 short off-the-cuff line, ideally 4–11 words.",
        "2. Express ONE simple human thought — don't try to sound wise, balanced, or analytical. Fragments and natural contractions (that's, don't, feels like, kinda, tbh, ngl, wait, fair, lol — only when organic) feel way more human than tidy complete essays.",
        `3. ${punctHintLatin}`,
        "4. NEVER sound like an AI reply guy. Banned formulas & words:",
        "   - No balanced contrast templates: '[X] sounds nice/catchy/clear, but [Y] matters most / still needs more than [Z]'.",
        "   - No AI fluff: 'totally agree', 'spot on', 'interesting take', 'time will tell', 'great insight', 'game changer', 'massive', 'bullish on', 'underrated', 'quietly building', 'isn't just X it's Y', 'let that sink in', 'worth watching', 'matters most', 'more than branding', 'at the end of the day', 'the real test is', 'solid move', 'execution is key'.",
        "5. Zero non-English words.",
      ].join("\n"),
      userReminder:
        "Drop 1 super natural, unpolished 【English】 reply like a real person scrolling X (4-11 words, lowercase, no ending period, ONE casual thought only — never sound like an AI or analyst). Output only the reply:",
    };
  }

  if (lang.code === "same") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & NATURAL STYLE:",
        "1. Detect the exact language used in TARGET TWEET (including any text inside attached images/screenshots) and reply 100% in THAT exact language — e.g. if it's Japanese reply ONLY in natural Japanese, if Indonesian reply ONLY in casual Indonesian.",
        "2. Keep it short, loose, and genuinely human (1 quick spontaneous reaction, 4–11 words or 8–26 CJK chars). Never sound like an AI commentator or balanced essay.",
        "3. No ending period, no exclamation mark, no quotes, no emojis, no hashtags ('?' is fine if asking).",
      ].join("\n"),
      userReminder:
        "Reply 100% in the EXACT same language as the post (or attached image) — 1 super short, natural human reaction like texting on X, zero AI stiffness. Output only the reply:",
    };
  }

  if (lang.nonLatin) {
    return {
      formatBlock: [
        `MANDATORY LANGUAGE & FORMAT (${lang.label.toUpperCase()} / ${lang.nativeName}):`,
        `1. Reply 100% in casual everyday ${lang.label} (${lang.nativeName}), 1 short spontaneous line (4–11 words).`,
        `2. Sound like a real native ${lang.label} user scrolling X on their phone — 1 simple reaction only, never stiff or machine-translated.`,
        "3. No ending period, no exclamation mark, no quotes, no emojis, no hashtags ('?' allowed if asking).",
        "4. FORBIDDEN: Do NOT reply in English.",
      ].join("\n"),
      userReminder: `Write 1 short, genuinely human reply strictly in native ${lang.label} (${lang.nativeName}) — 1 quick casual thought, no ending period, NEVER reply in English. Output only the reply:`,
    };
  }

  return {
    formatBlock: [
      `MANDATORY LANGUAGE & FORMAT (${lang.label.toUpperCase()}):`,
      `1. Reply strictly in relaxed, everyday ${lang.label}, 1 short spontaneous line (4–11 words).`,
      `2. ${punctHintLatin}`,
      "3. Sound like a real native speaker firing off a quick phone reply on X — 1 simple thought, never essay-like. Do NOT switch to English.",
    ].join("\n"),
    userReminder: `Write 1 super casual, human reply strictly in ${lang.label} (4-11 words, all lowercase, no ending period, never switch to English). Output only the reply:`,
  };
}

function buildSystemHeader(lang) {
  switch (lang.code) {
    case "ja":
      return "あなたはスマホでXを流し見しながら気楽にリプを返す普通の日本人ユーザーです。AIっぽさや解説口調を完全に消し、必ず自然な日本語の短い一言だけ返してください。";
    case "id":
      return "Kamu pengguna X Indonesia biasa yang lagi santai scroll timeline dari HP dan nimbrung pakai celetukan singkat. Balas selalu pakai Bahasa Indonesia yang beneran natural dan manusiawi — jangan pernah kaku kayak AI.";
    case "zh-CN":
      return "你是一个刷X手机随手评论的普通中文网友。彻底去掉AI味和点评腔，只用一句简短自然的简体中文口语回复。";
    case "zh-TW":
      return "你是一個滑X手機隨手留言的普通中文網友。徹底去掉AI味和評論腔，只用一句簡短自然的繁體中文口語回覆。";
    case "ko":
      return "너는 폰으로 트위터 보다가 가볍게 답글 다는 평범한 한국인 유저야. AI 티나 해설가 말투를 완전히 빼고 자연스러운 한국어 한 줄만 짧게 써.";
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

function contextLock(lang, post, detected, customStylePrompt, angle, recentReplies, visionAttached = false) {
  const explicitAngle =
    angle && angle !== "auto" ? String(angle).toLowerCase() : "auto";
  const intentBlock = analyzePostIntent(post, explicitAngle, visionAttached);
  const entityBlock = buildEntityAnchor(post, detected);
  const memoryBlock = buildAntiRepetitionBlock(recentReplies);
  const { formatBlock, userReminder } = buildLanguageAndFormatDirectives(lang);
  const upgradedStyle = upgradeLegacyStylePrompt(customStylePrompt);
  const localizedPersona = resolveLocalizedPersona(upgradedStyle, lang);

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
      `TONE / VIBE (attitude only — NEVER override target language ${lang.label} or invent facts):`,
      localizedPersona
    );
  }

  // Keep mandatory language & naturalness rules at the very end for maximum adherence
  sections.push("", formatBlock);

  return {
    systemLock: sections.join("\n"),
    userReminder,
  };
}

function buildRewriteMessages(wrongReply, lang, post) {
  const postSnippet = String(post?.tweetText || post?.quotedText || "").slice(0, 260);

  if (lang.code === "ja") {
    return [
      {
        role: "system",
        content:
          "あなたはXの日本人ユーザーです。英語や不自然な下書きを、スマホから普通に返すような8〜28文字の自然な日本語の短いリプライに書き直してください。翻訳調・敬語・解説口調・句点「。」・絵文字は禁止。本文のみ出力。",
      },
      {
        role: "user",
        content: `元の投稿: ${postSnippet}\n下書き: ${wrongReply}\n\n自然な日本語の短いリプライ（8〜28文字、英語禁止）だけ出力：`,
      },
    ];
  }

  if (lang.code === "id") {
    return [
      {
        role: "system",
        content:
          "Ubah draft balasan jadi 1 baris Bahasa Indonesia santai khas warga X di HP (4–11 kata, huruf kecil semua, tanpa titik akhir, tanpa emoji, jangan kaku seperti terjemahan). Tulis balasannya saja.",
      },
      {
        role: "user",
        content: `Post: ${postSnippet}\nDraft: ${wrongReply}\n\nBalasan Bahasa Indonesia santai saja:`,
      },
    ];
  }

  const targetDesc = `${lang.label}${lang.nativeName ? ` (${lang.nativeName})` : ""}`;
  const lengthRule = lang.cjk
    ? "1 short casual line (8–24 characters), no ending period ('。'), no emojis, no quotes"
    : lang.korean
      ? "1 short casual Korean X line (under 28 characters), no ending period, no emojis, no quotes"
      : lang.nonLatin
        ? "1 short casual line (4–11 words), no ending period, no emojis, no quotes"
        : "1 short casual line (4–11 words), all lowercase, no ending period, no emojis, no quotes";

  return [
    {
      role: "system",
      content: `Rewrite the reply into a genuinely casual, native-sounding X reply strictly in ${targetDesc} — NOT a stiff translation. Output ONLY the reply in ${targetDesc}.`,
    },
    {
      role: "user",
      content:
        `Target post: ${postSnippet}\n` +
        `Draft (wrong language): ${wrongReply}\n\n` +
        `Rewrite into 100% natural, casual native ${targetDesc} (${lengthRule}). Keep $tickers/project names intact. Output ONLY the final ${targetDesc} reply:`,
    },
  ];
}

function buildUserContentWithVision(textPrompt, imageUrls, visionEnabled) {
  if (!visionEnabled || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return textPrompt;
  }
  const validUrls = imageUrls
    .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
    .slice(0, 2);
  if (validUrls.length === 0) return textPrompt;

  return [
    { type: "text", text: textPrompt },
    ...validUrls.map((url) => ({
      type: "image_url",
      image_url: { url, detail: "auto" },
    })),
  ];
}

function extractReplyContentFromData(data) {
  const msg = data?.choices?.[0]?.message;
  let text = msg?.content;
  if (!text && typeof data?.choices?.[0]?.text === "string") {
    text = data.choices[0].text;
  }
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
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
    const entityScanText = [
      post?.articleTitle,
      post?.tweetText,
      post?.pollOptions,
      post?.quotedText,
      post?.cardSummary,
    ]
      .filter(Boolean)
      .join("\n");

    const recentReplies = await getRecentReplies();
    const lang = resolveReplyLanguage(post);
    const detected = detectTickersAndProjects(entityScanText);

    const visionEnabled = visionMode !== false;
    const validVisionUrls =
      visionEnabled && Array.isArray(post?.imageUrls)
        ? post.imageUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 2)
        : [];
    const willAttachVision = validVisionUrls.length > 0;

    const { systemLock, userReminder } = contextLock(
      lang,
      post,
      detected,
      systemPrompt,
      angle,
      recentReplies,
      willAttachVision
    );

    const systemMessage = {
      role: "system",
      content: buildSystemHeader(lang) + "\n\n" + systemLock,
    };

    const plainUserPrompt = formatPostBlock(post) + "\n\n" + userReminder;
    const multimodalContent = buildUserContentWithVision(
      plainUserPrompt,
      validVisionUrls,
      visionEnabled
    );
    const usedVisionPayload = Array.isArray(multimodalContent);

    let firstRes = await runCompletion({
      endpoint,
      parsedEndpoint,
      originPattern,
      apiKey: cleanKey,
      timeoutMs,
      body: {
        model: model,
        messages: [
          systemMessage,
          { role: "user", content: multimodalContent },
        ],
        max_tokens: 1024,
        temperature: 0.68,
        stream: false,
      },
    });

    // Automatic plain-text fallback if the configured model does not support Vision inputs (HTTP 400 / 415 / 422)
    if (
      usedVisionPayload &&
      firstRes &&
      !firstRes.ok &&
      (firstRes.status === 400 || firstRes.status === 415 || firstRes.status === 422)
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

      // Rebuild system prompt with visionAttached=false so the model never hallucinates unseen images
      const textOnlyLock = contextLock(
        lang,
        post,
        detected,
        systemPrompt,
        angle,
        recentReplies,
        false
      );
      const textOnlySystemMessage = {
        role: "system",
        content: buildSystemHeader(lang) + "\n\n" + textOnlyLock.systemLock,
      };
      const textOnlyUserPrompt = formatPostBlock(post) + "\n\n" + textOnlyLock.userReminder;

      firstRes = await runCompletion({
        endpoint,
        parsedEndpoint,
        originPattern,
        apiKey: cleanKey,
        timeoutMs,
        body: {
          model: model,
          messages: [
            textOnlySystemMessage,
            { role: "user", content: textOnlyUserPrompt },
          ],
          max_tokens: 1024,
          temperature: 0.68,
          stream: false,
        },
      });
    }

    if (!firstRes || !firstRes.ok) {
      return { ...firstRes, detectedLang: lang.code };
    }

    const firstCandidate = extractReplyContentFromData(firstRes.data);

    // Automatic Self-Correction Guard if the model still replied in the wrong language
    if (firstCandidate && !isReplyInExpectedLanguage(firstCandidate, lang)) {
      const rewriteRes = await runCompletion({
        endpoint,
        parsedEndpoint,
        originPattern,
        apiKey: cleanKey,
        timeoutMs,
        body: {
          model: model,
          messages: buildRewriteMessages(firstCandidate, lang, post),
          max_tokens: 512,
          temperature: 0.5,
          stream: false,
        },
      });

      const rewrittenText = rewriteRes?.ok ? extractReplyContentFromData(rewriteRes.data) : "";
      if (rewrittenText && isReplyInExpectedLanguage(rewrittenText, lang)) {
        await recordRecentReply(rewrittenText);
        return {
          ...rewriteRes,
          detectedLang: lang.code,
          detectedLangLabel: lang.label,
          rewrittenLang: true,
        };
      }
    }

    if (firstCandidate) {
      await recordRecentReply(firstCandidate);
    }

    return {
      ...firstRes,
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
