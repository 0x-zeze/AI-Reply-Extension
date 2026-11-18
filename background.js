// Background service worker - proxy API call supaya bebas CORS / mixed-content.
// Anti-Halu, Multilingual Engine (ID, EN, ZH-CN, ZH-TW, JA, KO, AR, RU, TH, VI, ES, dll.),
// Context & Intent Classifier, Smart Entity Anchor, dan Auto-Fallback Reasoning.

const API_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 700;

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return API_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// Unambiguous Indonesian stopwords & casual slang
const ID_STOP =
  /\b(yang|yg|dan|ini|itu|tidak|nggak|gak|ga|ngga|dengan|dgn|untuk|utk|dari|dr|ada|akan|sudah|udah|udh|belum|blm|bisa|juga|jg|saya|aku|gue|gw|kamu|lu|elu|dia|mereka|kita|kami|adalah|karena|krn|kalau|kalo|kl|jadi|jd|pada|atau|lebih|hanya|cuma|sangat|banget|bgt|hari|bukan|loh|lho|sih|dong|nih|tuh|kok|lah|kah|aja|saja|mau|lagi|lg|masih|baru|bikin|pakai|pake|lihat|liat|tahu|tau|gimana|gitu|gini|tapi|tp|memang|emang|kayak|kaya|buat|terus|trs|pas|banyak|semua|orang|kenapa|kapan|dimana|siapa|bagaimana|mantap|keren|parah|anjir|wkwk|wkwkwk|cuy|gan|bang|kak)\b/g;

// Distinctive English stopwords & common X/CT vocabulary
const EN_STOP =
  /\b(the|and|is|are|was|were|be|been|being|to|of|for|with|at|by|from|into|over|after|before|about|between|through|during|without|under|again|further|then|once|here|there|when|where|why|how|all|any|both|each|few|more|most|other|some|such|nor|not|only|own|same|than|too|very|can|will|just|should|now|that|this|these|those|what|which|who|whom|whose|you|your|yours|we|our|they|their|them|it|its|he|him|his|she|her|my|have|has|had|having|do|does|did|doing|would|could|might|must|shall|but|if|because|until|while|out|up|down|off|get|got|make|made|new|good|great|best|still|even|back|really|think|know|see|look|looks|looking|going|never|always|every|next|last|first|people|time|year|day|week|way|work|need|want|right|well|much|many|bullish|bearish|market|chart|launch|live|update|building|build|shipping|breaking|massive|strong|landing|makes|worth|watching)\b/g;

// Morfologi khas bahasa Indonesia
const ID_MORPH =
  /\b(?:(?:me|ber|ter|pe|ke|se|di)[a-z]{3,}(?:kan|nya|lah)|[a-z]{3,}nya|wkwk\w*)\b/g;

// Karakter pembeda Mandarin Tradisional vs Sederhana
const TRAD_HANZI =
  /[這們來個說對還沒發動現實際網幣鏈漲跌穩開關與為無會體國經見長門問間時機電買賣點頭後裡讓從進著樣種東車書學義]/g;
const SIMP_HANZI =
  /[这们来个说对还没发动现实际网币链涨跌稳开关与为无会体国经见长门问间时机电买卖点头后里让从进着样种东车书学义]/g;

// Stopwords ringan untuk bahasa Latin populer di X
const ES_STOP = /\b(el|la|los|las|una|unos|unas|pero|como|para|por|está|están|este|esta|estos|estas|muy|más|todo|todos|puede|hace|sobre|cuando|porque|también|solo|siempre)\b/g;
const PT_STOP = /\b(uma|uns|umas|não|está|estão|isso|isto|muito|mais|tudo|todos|pode|sobre|quando|porque|também|ainda|agora|você|vocês|pelos|pelas)\b/g;
const FR_STOP = /\b(les|des|une|dans|pour|pas|sur|avec|sont|cette|mais|plus|tout|tous|comme|c'est|quand|parce|aussi|même|très|bien)\b/g;
const DE_STOP = /\b(der|die|das|und|nicht|mit|auf|für|ist|sind|eine|einer|einem|auch|noch|wird|werden|aber|oder|wenn|über|mehr|sehr)\b/g;
const TR_STOP = /\b(bir|ve|bu|için|ile|olan|olarak|daha|çok|गibi|gibi|ama|fakat|kadar|sonra|önce|var|yok|bunu|şunu|nasıl|neden)\b/g;

// Peta kode atribut lang="..." dari DOM X (<div data-testid="tweetText" lang="...">)
const DOM_LANG_MAP = {
  en: { label: "English", code: "en" },
  id: { label: "Indonesian", code: "id" },
  in: { label: "Indonesian", code: "id" },
  ja: { label: "Japanese (日本語)", code: "ja", cjk: true },
  ko: { label: "Korean (한국어)", code: "ko", korean: true },
  zh: { label: "Simplified Chinese (简体中文)", code: "zh-CN", cjk: true },
  "zh-cn": { label: "Simplified Chinese (简体中文)", code: "zh-CN", cjk: true },
  "zh-hans": { label: "Simplified Chinese (简体中文)", code: "zh-CN", cjk: true },
  "zh-tw": { label: "Traditional Chinese (繁體中文)", code: "zh-TW", cjk: true },
  "zh-hk": { label: "Traditional Chinese (繁體中文)", code: "zh-TW", cjk: true },
  "zh-hant": { label: "Traditional Chinese (繁體中文)", code: "zh-TW", cjk: true },
  ru: { label: "Russian (Русский)", code: "ru", nonLatin: true },
  uk: { label: "Ukrainian (Українська)", code: "uk", nonLatin: true },
  ar: { label: "Arabic (العربية)", code: "ar", nonLatin: true },
  th: { label: "Thai (ภาษาไทย)", code: "th", nonLatin: true },
  hi: { label: "Hindi (हिन्दी)", code: "hi", nonLatin: true },
  vi: { label: "Vietnamese (Tiếng Việt)", code: "vi" },
  es: { label: "Spanish (Español)", code: "es" },
  pt: { label: "Portuguese (Português)", code: "pt" },
  fr: { label: "French (Français)", code: "fr" },
  de: { label: "German (Deutsch)", code: "de" },
  tr: { label: "Turkish (Türkçe)", code: "tr" },
  it: { label: "Italian (Italiano)", code: "it" },
  nl: { label: "Dutch (Nederlands)", code: "nl" },
  pl: { label: "Polish (Polski)", code: "pl" },
  tl: { label: "Tagalog / Filipino", code: "tl" },
  ms: { label: "Malay (Bahasa Melayu)", code: "ms" },
};

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
      : { label: "the exact same language as the target post", code: "same" };
  }

  const cleaned = stripNoiseForLang(raw) || raw;

  // 1. Deteksi Aksara CJK & Non-Latin (Tetap akurat walau bercampur istilah Inggris seperti "Injective", "Solana", "Mainnet"!)
  const kanaCount = countMatches(/[\u3040-\u30ff\uff66-\uff9f]/g, cleaned);
  const hangulCount = countMatches(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g, cleaned);
  const hanziCount = countMatches(/[\u4e00-\u9fff\u3400-\u4dbf]/g, cleaned);

  // Jepang: ada Hiragana/Katakana, ATAU Kanji murni yang ditandai lang="ja" oleh DOM X
  if (kanaCount >= 1 || (hanziCount >= 1 && normDom === "ja")) {
    return DOM_LANG_MAP.ja;
  }

  // Korea: ada Hangul atau Jamo Korea (mis. ㅋㅋㅋ, ㅠㅠ)
  if (hangulCount >= 1) {
    return DOM_LANG_MAP.ko;
  }

  // Mandarin / China (Simplified vs Traditional): tetap terdeteksi meski ada nama project Inggris panjang!
  if (hanziCount >= 1) {
    return detectChineseVariant(cleaned, normDom);
  }

  // Cyrillic (Rusia / Ukraina)
  if (countMatches(/[\u0400-\u04ff]/g, cleaned) >= 2) {
    if (normDom === "uk" || /[іїєґІЇЄҐ]/.test(cleaned)) return DOM_LANG_MAP.uk;
    return DOM_LANG_MAP.ru;
  }

  // Arab, Thailand, Hindi (Devanagari)
  if (countMatches(/[\u0600-\u06ff\u0750-\u077f]/g, cleaned) >= 2) return DOM_LANG_MAP.ar;
  if (countMatches(/[\u0e00-\u0e7f]/g, cleaned) >= 2) return DOM_LANG_MAP.th;
  if (countMatches(/[\u0900-\u097f]/g, cleaned) >= 2) return DOM_LANG_MAP.hi;

  // Vietnam (diakritik khas Tiếng Việt)
  if (/[ăâđêôơưĂÂĐÊÔƠƯảẩẫậắằẳẵặẻểễệỉịỏổỗộớờởỡợủửữựỳỷỹỵ]/.test(cleaned)) {
    return DOM_LANG_MAP.vi;
  }

  // 2. Deteksi Bahasa Beraksara Latin
  const lower = cleaned.toLowerCase();
  const idHits = countMatches(ID_STOP, lower);
  const idMorphHits = countMatches(ID_MORPH, lower);
  const idScore = idHits + idMorphHits;
  const enHits = countMatches(EN_STOP, lower);

  // Prioritaskan deteksi slang/kata Indonesia (karena X kadang salah melabeli slang Indo sebagai ms/tl)
  if (idScore > 0 && idScore >= enHits) {
    return DOM_LANG_MAP.id;
  }

  // Cek bahasa Eropa/Latin populer (Spanyol, Portugis, Prancis, Jerman, Turki)
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

  // Jika DOM X secara eksplisit memberi tahu bahasa non-EN/non-ID (mis. es, pt, fr, de, tr, vi, it, nl, pl)
  if (normDom && normDom !== "en" && normDom !== "id" && normDom !== "in") {
    // Pastikan bukan tweet bahasa Inggris penuh yang kebetulan salah tag
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

  return { label: "the exact same language as the target post", code: "same" };
}

// Prioritaskan bahasa dari tweet utama yang sedang dibalas (agar quote-tweet China/Jepang/Korea/Indo atas berita Inggris tetap mengikuti bahasa pembuat post!)
function resolveReplyLanguage(post) {
  const p = post || {};
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

// Deteksi ticker ($BTC, $sol) dan mention (@solana) tanpa menangkap nominal uang ($100) atau email
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

// Analisis maksud & struktur post (termasuk pola pertanyaan multibahasa: ?, ？, 吗, か, 나요/까요, dll.)
function analyzePostIntent(post) {
  const p = post || {};
  const primary = [p.articleTitle, p.tweetText, p.pollOptions].filter(Boolean).join(" ");
  const full = [primary, p.quotedText, p.cardSummary, p.imageAlt, p.parentContext]
    .filter(Boolean)
    .join(" ");

  const cues = [];

  const isPoll = Boolean(p.pollOptions);
  const isQuestion =
    /[?？](\s|$)/.test(primary) ||
    /\b(thoughts|wdyt|what do you think|which one|agree or disagree|menurut kalian|menurut lo|gimana menurut|pilih mana|setuju gak)\b/i.test(
      primary
    ) ||
    /(怎么看|觉得呢|哪个好|是不是|どう思う|どう思いますか|どっち|어떻게 생각|어떤가요|맞나요)/.test(primary);

  if (isPoll) {
    cues.push(
      "INTENT — POLL: Pick one concrete option from the poll or give a sharp reason favoring one choice."
    );
  } else if (isQuestion) {
    cues.push(
      "INTENT — QUESTION: Directly answer the author's question with a specific take instead of making a vague observation."
    );
  }

  const hasMetrics =
    /(\b\d+(?:[.,]\d+)?\s*(?:%|x|bps|k|m|b|t|ms|tps)\b|\$\d+(?:[.,]\d+)?\s*(?:k|m|b|t)?\b|\b(?:tvl|ath|volume|revenue|inflow|outflow|apr|apy|fdv|mcap|dau|mau)\b|(?:新高|突破|暴涨|急増|돌파|급등))/i.test(
      full
    );
  if (hasMetrics || p.imageAlt) {
    cues.push(
      "GROUNDING — DATA/CHART: Anchor your reaction on the concrete metric, figure, or chart detail mentioned."
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
      `- Naturally weave in the relevant ticker or project name (${examples.join(" / ")}${cleanAuthorName ? ` / ${cleanAuthorName}` : ""}) while writing in the required reply language.`,
      "- Prefer plain project names or $tickers over raw '@handle' tags — real humans rarely tag '@handle' mid-sentence.",
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
  if (p.tweetLang) {
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

// Aturan panjang, gaya ketikan native, dan larangan klise sesuai bahasa target!
function buildLanguageAndFormatDirectives(lang) {
  if (lang.code === "zh-CN") {
    return {
      formatBlock: [
        "ANTI-AI NATIVE FORMAT (SIMPLIFIED CHINESE / 简体中文):",
        "1. Output ONLY 1 short, punchy Chinese sentence (strictly 8–26 Chinese characters; keep English tickers/project names like $SOL or solana concise).",
        "2. Write in authentic, grounded Chinese X/CT netizen phrasing (自然口语、接地气、像真人手机随手回复，严禁生硬翻译腔和客服腔).",
        "3. NO ending period (不要句号 '。'), NO exclamation mark ('！'), NO quotation marks, NO emojis, NO hashtags.",
        "4. Banned AI clichés: '值得关注', '拭目以待', '完全同意', '说得太对了', '意义重大', '未来可期'.",
        "LANGUAGE LOCK: Reply 100% in Simplified Chinese (简体中文). Do NOT reply in English.",
      ].join("\n"),
      userReminder:
        "Write 1 short human reply to TARGET TWEET strictly in Simplified Chinese (简体中文, 8–26 chars, casual native X tone, no ending period '。', never reply in English).",
    };
  }

  if (lang.code === "zh-TW") {
    return {
      formatBlock: [
        "ANTI-AI NATIVE FORMAT (TRADITIONAL CHINESE / 繁體中文):",
        "1. Output ONLY 1 short, punchy Traditional Chinese sentence (strictly 8–26 Chinese characters; keep English tickers/project names concise).",
        "2. Write in authentic Taiwan/HK X community phrasing (自然口語、接地氣、像真人用手機隨手回覆，嚴禁機器翻譯腔與简体字).",
        "3. NO ending period (不要句號 '。'), NO exclamation mark ('！'), NO quotation marks, NO emojis, NO hashtags.",
        "4. Banned AI clichés: '值得關注', '拭目以待', '完全同意', '意義重大', '未來可期'.",
        "LANGUAGE LOCK: Reply 100% in Traditional Chinese (繁體中文). Do NOT use Simplified Chinese or English-only sentences.",
      ].join("\n"),
      userReminder:
        "Write 1 short human reply to TARGET TWEET strictly in Traditional Chinese (繁體中文, 8–26 chars, casual native X tone, no ending period '。', never reply in English).",
    };
  }

  if (lang.code === "ja") {
    return {
      formatBlock: [
        "ANTI-AI NATIVE FORMAT (JAPANESE / 日本語):",
        "1. Output ONLY 1 short, natural Japanese sentence (strictly 12–38 characters).",
        "2. Write in authentic Japanese X/Twitter casual phrasing (自然なXの口語・タメ口またはこなれたつぶやき調。直訳調や不自然な敬語・AIっぽい定型文は厳禁).",
        "3. NO ending period (句点 '。' なし), NO exclamation mark ('！' なし), NO quotation marks, NO emojis, NO hashtags.",
        "4. Banned AI clichés: '注目ですね', '目が離せない', '完全に同意', '素晴らしい洞察', '今後の展開に期待'.",
        "LANGUAGE LOCK: Reply 100% in natural Japanese (日本語). Do NOT reply in English or Chinese.",
      ].join("\n"),
      userReminder:
        "Write 1 short human reply to TARGET TWEET strictly in natural Japanese (日本語, 12–38 chars, casual X tone, no ending '。', never reply in English).",
    };
  }

  if (lang.code === "ko") {
    return {
      formatBlock: [
        "ANTI-AI NATIVE FORMAT (KOREAN / 한국어):",
        "1. Output ONLY 1 short, natural Korean sentence (strictly under 10 어절 / ~35 characters).",
        "2. Write in authentic Korean X/CT community casual tone (자연스러운 트위터/커뮤니티 구어체, 번역투나 딱딱한 로봇 말투 절대 금지).",
        "3. NO ending period (마침표 없이), NO exclamation mark, NO quotation marks, NO emojis, NO hashtags.",
        "4. Banned AI clichés: '주목할 만하네요', '기대됩니다', '전적으로 동의합니다', '좋은 인사이트', '지켜봐야겠네요'.",
        "LANGUAGE LOCK: Reply 100% in natural Korean (한국어). Do NOT reply in English.",
      ].join("\n"),
      userReminder:
        "Write 1 short human reply to TARGET TWEET strictly in natural Korean (한국어, 1 short casual sentence under 35 chars, no ending period, never reply in English).",
    };
  }

  if (lang.nonLatin) {
    return {
      formatBlock: [
        `ANTI-AI NATIVE FORMAT (${lang.label.toUpperCase()}):`,
        "1. Output ONLY 1 short, punchy sentence (under 14 words).",
        `2. Write in authentic, casual native ${lang.label} internet/X phrasing — never stiff machine-translated phrasing.`,
        "3. No ending period, no exclamation mark, no quotation marks, no emojis, no hashtags.",
        `LANGUAGE LOCK: Reply 100% in ${lang.label}. Do NOT reply in English.`,
      ].join("\n"),
      userReminder: `Write 1 short human reply to TARGET TWEET strictly in ${lang.label} (1 short casual sentence under 14 words, no ending period, never reply in English).`,
    };
  }

  const langLockLine =
    lang.code === "en"
      ? "LANGUAGE LOCK: The target post is in ENGLISH. Reply 100% in natural English. Zero Indonesian words."
      : lang.code === "id"
        ? "LANGUAGE LOCK: The target post is in INDONESIAN. Reply 100% in natural casual Indonesian (bahasa santai manusiawi, bukan terjemahan kaku)."
        : `LANGUAGE LOCK: Reply strictly in ${lang.label} (100% native casual phrasing, never switch to English).`;

  const targetName =
    lang.code === "en"
      ? "natural English"
      : lang.code === "id"
        ? "natural casual Indonesian"
        : lang.label;

  return {
    formatBlock: [
      "ANTI-AI COMPACT FORMAT:",
      "1. Output ONLY the reply itself — ONE single short sentence, strictly under 14 words.",
      "2. All lowercase. No ending period, no exclamation mark, no quotation marks, no emojis, no hashtags.",
      "3. Banned AI clichés: 'totally agree', 'spot on', 'interesting take', 'time will tell', 'great insight', 'game changer', 'massive', 'bullish on', 'underrated', 'quietly building', 'isn't just X it's Y', 'let that sink in', 'worth watching'.",
      "4. Sound like a sharp real person typing effortlessly from their phone.",
      langLockLine,
    ].join("\n"),
    userReminder: `Write 1 short human reply to TARGET TWEET strictly in ${targetName} (1 sentence under 14 words, all lowercase, no ending period, grounded in the exact topic above, never repeat the sentence).`,
  };
}

function contextLock(lang, post, detected) {
  const intentBlock = analyzePostIntent(post);
  const entityBlock = buildEntityAnchor(post, detected);
  const { formatBlock, userReminder } = buildLanguageAndFormatDirectives(lang);

  return {
    systemLock: [
      "STRICT GROUNDING (ZERO HALLUCINATION):",
      "- Base your reaction EXCLUSIVELY on facts, claims, numbers, and relationships present in TWEET CONTEXT.",
      "- NEVER invent outside news, fake dates, unmentioned partnerships, or random price targets.",
      "- Do NOT parrot or rephrase the tweet's exact words back at the author — add a sharp, grounded human angle on it.",
      "",
      intentBlock,
      "",
      entityBlock,
      "",
      formatBlock,
    ].join("\n"),
    userReminder,
  };
}

// ═══════════════════════════════════════════════════════════════
// Endpoint validation + shared fetch runner
// ═══════════════════════════════════════════════════════════════
function validateEndpoint(endpoint) {
  if (!endpoint) return { error: "Base URL kosong. Isi di Settings." };
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    return {
      error: `Base URL tidak valid: "${endpoint}". Contoh benar: https://api.x.ai/v1`,
    };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { error: `Base URL harus http/https, bukan "${parsed.protocol}"` };
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
      reason: e && e.name === "AbortError" ? "tidak ada respon" : (e && e.message) || "gagal",
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
        `Extension belum punya izin akses ke ${parsedEndpoint.origin}. ` +
        `Buka Settings → klik "Beri Izin Host" → Allow.`,
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
      ? `Server di ${parsedEndpoint.origin} hidup (HTTP ${probe.status}), tapi ` +
        `/chat/completions tidak selesai dalam ${elapsedSec} detik. ` +
        `Kemungkinan model lambat → naikkan "Timeout request" di Settings.`
      : `Host ${parsedEndpoint.host} tidak menjawab HTTP sama sekali (${probe.reason}). ` +
        `Cek port dan path Base URL, pastikan server memang melayani HTTP di port itu.`;
    return { ok: false, code: "timeout", error: `Timeout ${elapsedSec} detik. ${verdict}` };
  }

  if (
    err.name === "TypeError" ||
    /failed to fetch|networkerror|load failed|network error/i.test(err.message || "")
  ) {
    return {
      ok: false,
      code: "failed_to_fetch",
      error:
        `Tidak bisa menghubungi ${parsedEndpoint.host}. Kemungkinan: ` +
        `(1) izin host belum diberikan → Settings → "Beri Izin Host", ` +
        `(2) Base URL / port salah, ` +
        `(3) server menolak koneksi, ` +
        `(4) coba https:// kalau Base URL pakai http://. [detail: ${err.message}]`,
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

  if (action !== "generateReply" && action !== "testConnection") return false;

  const { endpoint, apiKey, model, systemPrompt, post, timeoutMs } = request;

  const check = validateEndpoint(endpoint);
  if (check.error) {
    sendResponse({ ok: false, code: "invalid_endpoint", error: check.error });
    return true;
  }
  if (!apiKey || !String(apiKey).trim()) {
    sendResponse({ ok: false, code: "no_key", error: "API key kosong. Isi di Settings." });
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

  const entityScanText = [
    post?.articleTitle,
    post?.tweetText,
    post?.pollOptions,
    post?.quotedText,
    post?.cardSummary,
  ]
    .filter(Boolean)
    .join("\n");

  const lang = resolveReplyLanguage(post);
  const detected = detectTickersAndProjects(entityScanText);
  const { systemLock, userReminder } = contextLock(lang, post, detected);

  const messages = [
    {
      role: "system",
      content:
        "You are a sharp, native-speaking human replying under a post on X. You ALWAYS match the exact language and script of the target post and write grounded, context-locked one-liners.\n" +
        systemLock,
    },
  ];

  if (systemPrompt && systemPrompt.trim()) {
    messages.push({
      role: "system",
      content:
        "Additional user vibe/personality preference (apply ONLY the tone/attitude — NEVER let this English description override the required reply LANGUAGE above):\n" +
        systemPrompt.trim(),
    });
  }

  messages.push({
    role: "user",
    content: formatPostBlock(post) + "\n\n" + userReminder,
  });

  runCompletion({
    endpoint,
    parsedEndpoint,
    originPattern,
    apiKey: cleanKey,
    timeoutMs,
    body: {
      model: model,
      messages: messages,
      max_tokens: 1024,
      temperature: 0.7,
      stream: false,
    },
  })
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, code: "internal", error: err?.message || String(err) })
    );

  return true;
});
