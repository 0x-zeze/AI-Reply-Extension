// Background Service Worker — CORS-free API proxy for X AI Reply.
// v5.2.1 Global Edition: Anti-Hallucination Grounding, Guaranteed Multilingual Engine,
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
    "ANTI-REPETITION MEMORY (VARY YOUR SENTENCE SKELETON):",
    "Your previous recent replies were:",
    ...lines,
    "Do NOT reuse the same opening words, sentence rhythm, or phrasing structure as any of those lines. Keep your cadence fresh.",
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

function detectTweetLanguage(text, domLangHint = "") {
  const raw = String(text || "").trim();
  const normDom = normalizeDomLang(domLangHint);

  if (!raw) {
    return normDom
      ? DOM_LANG_MAP[normDom]
      : { label: "the exact same language as the target post", nativeName: "Same Language", code: "same" };
  }

  const cleaned = stripNoiseForLang(raw) || raw;

  const kanaCount = countMatches(/[\u3040-\u30ff\uff66-\uff9f]/g, cleaned);
  const hangulCount = countMatches(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, cleaned);
  const hanziCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, cleaned);

  if (kanaCount >= 1 || (hanziCount >= 1 && normDom === "ja")) {
    return DOM_LANG_MAP.ja;
  }
  if (hangulCount >= 1) {
    return DOM_LANG_MAP.ko;
  }
  if (hanziCount >= 1) {
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

  if (normDom && normDom !== "en" && normDom !== "id" && normDom !== "in") {
    if (enHits <= 2 || latinLangScores.some((x) => x.key === normDom && x.hits >= 1)) {
      return DOM_LANG_MAP[normDom];
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

function resolveReplyLanguage(post) {
  const p = post || {};

  // If the post was translated on X ("Translated from Japanese"), preserve the author's original language
  if (p.translatedFromLang) {
    const origKey = normalizeDomLang(p.translatedFromLang);
    if (origKey && DOM_LANG_MAP[origKey]) {
      return DOM_LANG_MAP[origKey];
    }
  }

  const primaryText = [p.articleTitle, p.tweetText, p.pollOptions].filter(Boolean).join("\n");
  const cleanedPrimary = stripNoiseForLang(primaryText);
  const hasNonLatinScript =
    /[\u3040-\u30ff\uff66-\uff9f\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\u4e00-\u9fff\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\u0900-\u097f]/.test(
      primaryText
    );
  const primaryWords = cleanedPrimary ? cleanedPrimary.split(/\s+/).filter(Boolean).length : 0;

  if (hasNonLatinScript || primaryWords >= 2) {
    const primaryLang = detectTweetLanguage(primaryText, p.tweetLang);
    if (primaryLang.code !== "same") return primaryLang;
  }

  if (p.tweetLang) {
    const hinted = detectTweetLanguage(primaryText, p.tweetLang);
    if (hinted.code !== "same") return hinted;
  }

  const fallbackText = [
    primaryText,
    p.quotedText,
    p.cardSummary,
    p.parentContext,
    p.imageAlt,
  ]
    .filter(Boolean)
    .join("\n");

  return detectTweetLanguage(fallbackText, p.tweetLang || p.quotedLang || "");
}

function isReplyInExpectedLanguage(replyText, lang) {
  const raw = String(replyText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
  if (!raw || !lang || lang.code === "same") return true;

  if (lang.code === "zh-CN" || lang.code === "zh-TW") {
    return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(raw) && !/[\u3040-\u30ff]/.test(raw);
  }
  if (lang.code === "ja") {
    return /[\u3040-\u30ff\uff66-\uff9f\u4e00-\u9fff]/.test(raw);
  }
  if (lang.code === "ko") {
    return /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(raw);
  }
  if (lang.code === "ru" || lang.code === "uk") {
    return /[\u0400-\u04ff]/.test(raw);
  }
  if (lang.code === "ar") {
    return /[\u0600-\u06ff\u0750-\u077f]/.test(raw);
  }
  if (lang.code === "th") {
    return /[\u0e00-\u0e7f]/.test(raw);
  }
  if (lang.code === "hi") {
    return /[\u0900-\u097f]/.test(raw);
  }

  const lower = stripNoiseForLang(raw).toLowerCase();
  const idScore = countMatches(ID_STOP, lower) + countMatches(ID_MORPH, lower);
  const enHits = countMatches(EN_STOP, lower);

  if (lang.code === "id") {
    if (enHits >= 2 && idScore === 0) return false;
    if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(raw)) return false;
    return true;
  }

  if (lang.code === "en") {
    if (idScore >= 2 && enHits === 0) return false;
    if (/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(raw)) return false;
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

function angleFromSavedTone(systemPrompt) {
  const text = String(systemPrompt || "").toLowerCase();
  if (!text) return "auto";
  if (/\bwitty\b|\bdeadpan\b|\bclever\b/.test(text)) return "witty";
  if (/\bfollow-up\b|\bask a short\b|\bcurious\b|\bcritical take\b/.test(text)) return "ask";
  if (/\bcrypto-native\b|\bcontrarian\b|\bskeptical\b|\bcounter\b/.test(text)) return "counter";
  if (/\bdry\b|\beffortless\b|\bcasual\b/.test(text)) return "agree";
  return "auto";
}

function buildAngleDirective(angle) {
  switch (String(angle || "auto").toLowerCase()) {
    case "agree":
      return "SELECTED REACTION ANGLE — AGREE / CO-SIGN: Back up the author's core point by adding one concrete, grounded reason why it makes sense (without cliché 'totally agree' fluff).";
    case "ask":
      return "SELECTED REACTION ANGLE — CURIOUS FOLLOW-UP QUESTION: Ask 1 sharp, genuinely curious short question directly about a specific detail in the post (a question mark '?' IS allowed at the end for this angle).";
    case "counter":
      return "SELECTED REACTION ANGLE — SKEPTICAL / CONTRARIAN NUANCE: Point out 1 calm, smart caveat, risk, or counter-angle to the post's claim without being rude or hostile.";
    case "witty":
      return "SELECTED REACTION ANGLE — DRY / WITTY QUIP: Drop a clever, deadpan, effortless observation or light humor grounded directly in the post's situation.";
    default:
      return "";
  }
}

function analyzePostIntent(post, angle = "auto") {
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
        "INTENT — POLL: Pick one concrete option from the poll or give a sharp reason favoring one choice."
      );
    } else if (isQuestion) {
      cues.push(
        "INTENT — QUESTION: Directly answer the author's question with a specific take instead of making a vague observation."
      );
    }
  }

  const hasMetrics =
    /(\b\d+(?:[.,]\d+)?\s*(?:%|x|bps|k|m|b|t|ms|tps)\b|\$\d+(?:[.,]\d+)?\s*(?:k|m|b|t)?\b|\b(?:tvl|ath|volume|revenue|inflow|outflow|apr|apy|fdv|mcap|dau|mau)\b|(?:新高|突破|暴涨|急増|돌파|급등))/i.test(
      full
    );
  if (hasMetrics || p.imageAlt || (Array.isArray(p.imageUrls) && p.imageUrls.length > 0)) {
    cues.push(
      "GROUNDING — VISUAL/DATA: If chart/screenshot images or numbers are attached, anchor your reaction on a real detail visible in the image or text."
    );
  }

  const isShipOrCollab =
    /(\b(?:live on|launching|launched|introducing|announcing|integrated|integration|partnering|partnership|landing on|now available|mainnet|testnet|upgrade|shipped|rollout|going live)\b|(?:上线|推出|集成|合作|主网|公開|連携|ローンチ|출시|통합|메인넷|상장))/i.test(
      full
    );
  if (isShipOrCollab) {
    cues.push(
      "INTENT — LAUNCH/INTEGRATION: Focus on why this specific ship/integration actually matters in practice (e.g. liquidity, UX, speed, or real usage), not generic hype."
    );
  }

  if (p.quotedText) {
    cues.push(
      "STRUCTURE — QUOTE TWEET: Bridge the author's commentary with the quoted post's core point."
    );
  }

  if (p.parentContext) {
    cues.push(
      "STRUCTURE — THREAD/REPLY: Use the Earlier Thread Context for background facts, but reply directly to the TARGET TWEET."
    );
  }

  if (cues.length === 0) {
    cues.push(
      "INTENT — SHARP REACTION: Pick the single most specific claim or detail in the post and react to that exact point."
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
    hints.push(`mentioned ecosystems/accounts: ${mentionNames.join(", ")}`);
  }
  if (cleanAuthorName || cleanAuthorHandle) {
    hints.push(
      `post author: ${[cleanAuthorName, cleanAuthorHandle ? `(@${cleanAuthorHandle})` : ""].filter(Boolean).join(" ")}`
    );
  }

  if (detected.tickers.length > 0 || mentionNames.length > 0) {
    const examples = [
      ...detected.tickers.slice(0, 2),
      ...mentionNames.slice(0, 2),
    ];
    return [
      `ENTITY & TOPIC ANCHOR (${hints.join(" | ")}):`,
      `- Naturally weave in the relevant ticker or project name (${examples.join(" / ")}${cleanAuthorName ? ` / ${cleanAuthorName}` : ""}) while writing strictly in the target language.`,
      "- Prefer plain project names or $tickers over raw '@handle' tags.",
    ].join("\n");
  }

  return [
    `ENTITY & TOPIC ANCHOR${hints.length ? ` (${hints.join(" | ")})` : ""}:`,
    "- Reference the exact subject, protocol, product, or concept discussed in the post so the reply could NOT fit a random unrelated tweet.",
  ].join("\n");
}

function formatPostBlock(post) {
  const p = post || {};
  const lines = ["=== TWEET CONTEXT ==="];

  if (p.parentContext) {
    lines.push("Earlier Thread / Parent Tweet Context (for background):\n" + p.parentContext);
    lines.push("---");
  }

  lines.push("TARGET TWEET (the exact post you are replying to):");
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
    lines.push("Tweet Content:\n" + p.tweetText);
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
    lines.push("Quoted Tweet Inside Post:\n" + p.quotedText);
  }

  lines.push("=== END TWEET ===");
  return lines.join("\n");
}

function buildLanguageAndFormatDirectives(lang, angle = "auto") {
  const allowQuestionMark = String(angle || "").toLowerCase() === "ask";
  const punctHintZh = allowQuestionMark
    ? "NO ending period ('。') or exclamation ('！'); a question mark ('？') is allowed if asking a question."
    : "NO ending period ('。'), NO exclamation mark ('！'), NO quotes, NO emojis, NO hashtags.";
  const punctHintJa = allowQuestionMark
    ? "NO ending period ('。') or exclamation ('！'); '？' is allowed if asking a question."
    : "NO ending period ('。' なし), NO exclamation mark ('！' なし), NO quotes, NO emojis, NO hashtags.";
  const punctHintLatin = allowQuestionMark
    ? "All lowercase. No ending period, no exclamation mark (a '?' is allowed since you are asking a follow-up), no quotation marks, no emojis, no hashtags."
    : "All lowercase. No ending period, no exclamation mark, no quotation marks, no emojis, no hashtags.";

  if (lang.code === "zh-CN") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & FORMAT (SIMPLIFIED CHINESE / 简体中文):",
        "1. Reply 100% in Simplified Chinese (简体中文), 8–26 Chinese characters, 1 single short sentence.",
        "2. Sound like a real Chinese X/CT user typing casually on mobile (自然口语、接地气、干脆利落，严禁翻译腔和AI客服腔).",
        `3. ${punctHintZh}`,
        "4. Banned clichés: '值得关注', '拭目以待', '完全同意', '说得太对了', '意义重大', '未来可期'.",
        "5. FORBIDDEN: Do NOT output an English or Indonesian sentence.",
      ].join("\n"),
      userReminder:
        "请直接用【简体中文】写一句简短自然的推文回复（仅1句话，8-26个汉字左右，自然口语接地气，不要句号和感叹号，严禁使用英文整句回复，只输出回复内容本身）：",
    };
  }

  if (lang.code === "zh-TW") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & FORMAT (TRADITIONAL CHINESE / 繁體中文):",
        "1. Reply 100% in Traditional Chinese (繁體中文), 8–26 Chinese characters, 1 single short sentence.",
        "2. Sound like a real Taiwan/HK X user typing casually on mobile (自然口語、接地氣、不死板，嚴禁機器翻譯腔與簡體字).",
        `3. ${punctHintZh}`,
        "4. Banned clichés: '值得關注', '拭目以待', '完全同意', '意義重大', '未來可期'.",
        "5. FORBIDDEN: Do NOT output an English or Simplified Chinese sentence.",
      ].join("\n"),
      userReminder:
        "請直接用【繁體中文】寫一句簡短自然的推文回覆（僅1句話，8-26個漢字左右，自然口語，不要句號和驚嘆號，嚴禁使用英文整句回覆，只輸出回覆內容本身）：",
    };
  }

  if (lang.code === "ja") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & FORMAT (JAPANESE / 日本語):",
        "1. Reply 100% in natural Japanese (日本語), 12–38 characters, 1 single short sentence.",
        "2. Sound like an authentic Japanese X user (自然なXの口語・タメ口またはこなれたつぶやき調。直訳調やAIっぽい硬い敬語は厳禁).",
        `3. ${punctHintJa}`,
        "4. Banned clichés: '注目ですね', '目が離せない', '完全に同意', '素晴らしい洞察', '今後の展開に期待'.",
        "5. FORBIDDEN: Do NOT reply in English or Chinese.",
      ].join("\n"),
      userReminder:
        "必ず【自然な日本語】だけで短いリプライを1文（12〜38文字程度、Xの自然な口語、句点「。」や感嘆符なし、英語での返信は厳禁）書いてください。返信本文のみ出力：",
    };
  }

  if (lang.code === "ko") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & FORMAT (KOREAN / 한국어):",
        "1. Reply 100% in natural Korean (한국어), under 10 어절 (~35 characters), 1 single short sentence.",
        "2. Sound like an authentic Korean X/CT user (자연스러운 트위터/커뮤니티 구어체, 번역투나 딱딱한 로봇 말투 절대 금지).",
        `3. ${allowQuestionMark ? "NO ending period or exclamation mark ('?' allowed)." : "NO ending period, NO exclamation mark, NO quotes, NO emojis, NO hashtags."}`,
        "4. Banned clichés: '주목할 만하네요', '기대됩니다', '전적으로 동의합니다', '좋은 인사이트', '지켜봐야겠네요'.",
        "5. FORBIDDEN: Do NOT reply in English.",
      ].join("\n"),
      userReminder:
        "반드시 【자연스러운 한국어】로만 짧은 트위터 답글 한 문장(35자 이내, 자연스러운 커뮤니티 구어체, 마침표/느낌표 없이, 영어 답변 절대 금지)을 작성하세요. 답글 본문만 출력:",
    };
  }

  if (lang.code === "id") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & FORMAT (BAHASA INDONESIA):",
        "1. Reply 100% in natural casual Indonesian (casual everyday mobile phrasing, never stiff machine translation).",
        "2. Strictly 1 short sentence, under 14 words.",
        `3. ${punctHintLatin}`,
        "4. Banned clichés: 'setuju banget', 'menarik banget', 'patut ditunggu', 'luar biasa', 'mantap jiwa'.",
        "5. FORBIDDEN: Do NOT reply in English.",
      ].join("\n"),
      userReminder:
        "Balas TARGET TWEET di atas 100% dalam 【Bahasa Indonesia】 santai & natural (1 kalimat pendek di bawah 14 kata, huruf kecil semua, tanpa titik di akhir, dilarang keras membalas pakai bahasa Inggris). Tulis isi balasannya saja:",
    };
  }

  if (lang.code === "en") {
    return {
      formatBlock: [
        "MANDATORY LANGUAGE & FORMAT (ENGLISH):",
        "1. Reply 100% in natural English, 1 single short sentence, strictly under 14 words.",
        `2. ${punctHintLatin}`,
        "3. Banned AI clichés: 'totally agree', 'spot on', 'interesting take', 'time will tell', 'great insight', 'game changer', 'massive', 'bullish on', 'underrated', 'quietly building', 'isn't just X it's Y', 'let that sink in', 'worth watching'.",
        "4. Sound like a sharp real person typing effortlessly from their phone. Zero non-English words.",
      ].join("\n"),
      userReminder:
        "Reply to TARGET TWEET 100% in natural 【English】 (1 short sentence under 14 words, all lowercase, no ending period, grounded in the exact topic above, zero non-English words). Output only the reply text:",
    };
  }

  if (lang.nonLatin) {
    return {
      formatBlock: [
        `MANDATORY LANGUAGE & FORMAT (${lang.label.toUpperCase()} / ${lang.nativeName}):`,
        `1. Reply 100% in ${lang.label} (${lang.nativeName}), 1 single short casual sentence (under 14 words).`,
        `2. Use authentic native ${lang.label} X/internet phrasing — never stiff machine-translated phrasing.`,
        "3. No ending period, no exclamation mark, no quotation marks, no emojis, no hashtags.",
        "4. FORBIDDEN: Do NOT reply in English.",
      ].join("\n"),
      userReminder: `Write 1 short human reply to TARGET TWEET strictly in ${lang.label} (${lang.nativeName}) — 1 short casual sentence, no ending period, NEVER reply in English. Output only the reply:`,
    };
  }

  return {
    formatBlock: [
      `MANDATORY LANGUAGE & FORMAT (${lang.label.toUpperCase()}):`,
      `1. Reply strictly in ${lang.label}, 1 single short casual sentence, under 14 words.`,
      `2. ${punctHintLatin}`,
      "3. Sound like a real native speaker typing casually on mobile. Do NOT switch to English unless the target post itself is English.",
    ].join("\n"),
    userReminder: `Write 1 short human reply to TARGET TWEET strictly in ${lang.label} (1 short sentence under 14 words, all lowercase, no ending period, never switch to English). Output only the reply:`,
  };
}

function contextLock(lang, post, detected, customStylePrompt, angle, recentReplies) {
  const resolvedAngle =
    angle && angle !== "auto" ? angle : angleFromSavedTone(customStylePrompt);
  const intentBlock = analyzePostIntent(post, resolvedAngle);
  const entityBlock = buildEntityAnchor(post, detected);
  const memoryBlock = buildAntiRepetitionBlock(recentReplies);
  const { formatBlock, userReminder } = buildLanguageAndFormatDirectives(lang, angle);
  const cleanCustomStyle = sanitizeStylePromptForLang(customStylePrompt, lang);

  const sections = [
    "STRICT GROUNDING (ZERO HALLUCINATION):",
    "- Base your reaction EXCLUSIVELY on facts, claims, numbers, images, and relationships present in TWEET CONTEXT.",
    "- NEVER invent outside news, fake dates, unmentioned partnerships, or random price targets.",
    "- Do NOT parrot or rephrase the tweet's exact words back at the author — add a sharp, grounded human angle on it.",
    "",
    intentBlock,
    "",
    entityBlock,
  ];

  if (memoryBlock) {
    sections.push("", memoryBlock);
  }

  if (cleanCustomStyle) {
    sections.push(
      "",
      `USER VIBE PREFERENCE (tone/attitude ONLY — NEVER override the mandatory reply language ${lang.label}):`,
      cleanCustomStyle
    );
  }

  sections.push("", formatBlock);

  return {
    systemLock: sections.join("\n"),
    userReminder,
  };
}

function buildRewriteMessages(wrongReply, lang, post) {
  const targetDesc = `${lang.label}${lang.nativeName ? ` (${lang.nativeName})` : ""}`;
  const lengthRule = lang.cjk
    ? "1 short casual sentence (10–30 characters), no ending period ('。'), no emojis, no quotes"
    : lang.korean
      ? "1 short casual Korean X sentence (under 35 characters), no ending period, no emojis, no quotes"
      : lang.nonLatin
        ? "1 short casual sentence (under 14 words), no ending period, no emojis, no quotes"
        : "1 short casual sentence (under 14 words), all lowercase, no ending period, no emojis, no quotes";

  return [
    {
      role: "system",
      content: `You rewrite X/Twitter replies into authentic, native, casual ${targetDesc}. Output ONLY the rewritten reply in ${targetDesc} with zero explanation.`,
    },
    {
      role: "user",
      content:
        `Target post context: ${String(post?.tweetText || post?.quotedText || "").slice(0, 260)}\n` +
        `Draft reply (wrong language): ${wrongReply}\n\n` +
        `Rewrite that draft reply into 100% natural native ${targetDesc} (${lengthRule}). Keep any $tickers or project names intact. Output ONLY the final ${targetDesc} reply:`,
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
    const { systemLock, userReminder } = contextLock(
      lang,
      post,
      detected,
      systemPrompt,
      angle,
      recentReplies
    );

    const systemMessage = {
      role: "system",
      content:
        "You are a sharp, native-speaking human replying under a post on X. You ALWAYS reply in the exact mandatory target language and write grounded, context-locked one-liners.\n\n" +
        systemLock,
    };

    const plainUserPrompt = formatPostBlock(post) + "\n\n" + userReminder;
    const visionEnabled = visionMode !== false;
    const multimodalContent = buildUserContentWithVision(
      plainUserPrompt,
      post?.imageUrls,
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
        temperature: 0.7,
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
      firstRes = await runCompletion({
        endpoint,
        parsedEndpoint,
        originPattern,
        apiKey: cleanKey,
        timeoutMs,
        body: {
          model: model,
          messages: [
            systemMessage,
            { role: "user", content: plainUserPrompt },
          ],
          max_tokens: 1024,
          temperature: 0.7,
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
          temperature: 0.4,
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
