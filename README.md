<div align="center">
  <img src="icons/icon128.png" alt="X AI Reply Logo" width="84" height="84" />
  <h1>X AI Reply Extension</h1>
  <p><strong>Context-locked, vision-enabled, multilingual, zero-lag AI reply assistant for X (Twitter) — powered by your own OpenAI-compatible API.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-1d9bf0?style=flat-square" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/Version-5.4.1-4f46e5?style=flat-square" alt="Version 5.4.1" />
    <img src="https://img.shields.io/badge/Vision-Multimodal_Ready-059669?style=flat-square" alt="Vision Ready" />
    <img src="https://img.shields.io/badge/UI-Auto_Dark%2FLight_60fps-10b981?style=flat-square" alt="60fps UI" />
    <img src="https://img.shields.io/badge/API-OpenAI_Compatible-7c3aed?style=flat-square" alt="OpenAI Compatible" />
  </p>
</div>

---

## Overview

**X AI Reply** injects a lightweight, GPU-accelerated **AI Reply** pill (plus a slide-out **Quick Angle Bar** and `Alt + R` shortcut) directly inside X (`x.com` / `twitter.com` / `pro.x.com`) reply and quote composers. With a single click or keystroke, it inspects the full conversation and visual context around the target post, locks onto the post's native language and intent, and inserts a sharp, natural, human-sounding one-liner into X's Draft.js editor — ready for you to review, edit, or send.

---

## Key Features

### 1. Multimodal Vision Mode (Charts, Screenshots & Infographics)
- Automatically extracts attached tweet media (`pbs.twimg.com/media/...` normalized to sharp `large` resolution + `jpg` compatibility, fetched and inlined as base64 Data URIs via the background worker) and sends them via OpenAI-compatible `image_url` payloads so multimodal models (**Grok**, **GPT-4o**, **Claude**, **Gemini**, **Qwen-VL**) can read candlestick charts, PnL screenshots, tables, and memes even when no `alt` text is provided.
- **Automatic 413 & Text-Only Fallback**: If a gateway rejects large inline payloads (`HTTP 413`), the service worker retries with lightweight remote URLs first; if the model is text-only (`HTTP 400` / `413` / `415` / `422`), it transparently falls back to plain text so requests never break.

### 2. Deep Multi-Layer Post Context Extraction
- **Target Post Content**: Preserves exact spacing across inline links, `@mentions`, `$cashtags`, `#hashtags`, and emoji `alt` attributes.
- **Thread, Community Notes & Top Replies**: Reads up to 2 preceding parent posts, author self-thread continuations, verified **Community Notes** (`birdwatch-pivot`), external link card domains, and top 2–3 community replies on `/status/` pages to grasp hidden context/sarcasm without copying others.
- **Quoted Posts, Polls & X Longform Articles**: Separately extracts embedded Quote Tweets (author + body + images), automatically distinguishes **Quote Post** vs **Reply** composers, and reads poll options (`cardPoll`) and X Longform Articles (`twitterArticleRichTextView`).
- **Smart Regenerate & Guided Draft Seed**: Clicking **AI Reply** (or pressing `Alt + R`) again after a generated reply automatically avoids the previous angle; typing a short rough note in the reply box first turns your own idea into a natural context-locked reply.

### 3. Hover Quick-Angle Mini-Menu & `Alt + R` Keyboard Shortcut
- **1-Click Reaction Angles**: Hover over the **✨ AI Reply** button inside any X reply box to slide out quick angle pills:
  - **👍 Agree** — Co-sign the author's point with one concrete reason.
  - **🤔 Ask** — Ask a sharp, curious follow-up question.
  - **⚡ Counter** — Offer a calm, smart skeptical nuance or caveat.
  - **😎 Witty** — Drop a deadpan, effortless observation.
- **Keyboard Shortcut (`Alt + R`)**: Trigger or regenerate an AI reply directly from the keyboard without touching your mouse.

### 4. Guaranteed Multilingual Engine + Live Translation Preview
- **Native Language Lock & Self-Correction Guard**: Detects and replies in the exact language and script of the target post — including **English**, **Indonesian**, **Simplified Chinese (简体中文)**, **Traditional Chinese (繁體中文)**, **Japanese (日本語)**, **Korean (한국어)**, **Arabic**, **Russian**, **Ukrainian**, **Thai**, **Hindi**, **Vietnamese**, **Spanish**, **Portuguese**, **French**, **German**, **Turkish**, and more.
- **Works Even on Translated X Posts**: Even if you clicked *"Translate post"* on X to read a foreign tweet first, the extension detects X's *"Translated from..."* banner and replies in the author's original language.
- **Live Translation Preview Toast**: Whenever a reply is generated in a foreign script/language (such as Chinese, Japanese, Korean, Arabic, or Russian), a non-blocking toast displays its concise meaning so you can verify what your reply says before posting.

### 5. Mood & Politeness Adaptation, Silent Read-Then-Reply & Anti-Slop Guard
- **Mood & Politeness Register Detection**: Automatically adapts tone to sensitive/bad news (suppresses jokes/sarcasm), quick greetings (`gm`/`gn`), memes/shitposts, personal launches, and matches natural politeness levels across **Japanese** (soft keigo vs casual), **Korean** (`해요체` vs `반말`), and **Indonesian** (semi-formal vs casual slang).
- **Silent Read-Then-Reply + Post-Generation Quality Guard**: Forces the model to identify the post's core point & mood before writing the reply in a single API call, then locally audits the output for wrong language, AI clichés/slop, parroting, unseen video/chart hallucination, and regenerate duplicates — auto-repairing in 1 pass if needed.
- **Local Reply Variety Memory**: Stores your last 8 generated replies locally (`chrome.storage.local`) and uses dynamic temperature scaling to keep replies fresh and grounded.

### 6. Multi-Profile API Switcher & Smooth 60/120fps UI
- **Up to 6 Saved API Profiles**: Save multiple provider/model configurations (for example, an ultra-fast **Groq** profile for quick banter and a **Grok / Claude / OpenRouter** profile for deep chart & thread analysis) and switch between them in 1 click right from the **Toolbar Popup**.
- **Ghost-Free Draft.js Paste & Zero-Lag Observer**: 100% GPU-composited animations (`transform` & `opacity`), `0%` CPU overhead while typing, zero forced layout reflows during timeline scroll, and synthetic `ClipboardEvent("paste")` insertion that prevents Draft.js double-text bugs.

---

## Use Cases

| Use Case | How X AI Reply Helps |
| :--- | :--- |
| **Web3 / Crypto & Market Analysts** | Read attached TVL/price charts via **Vision Mode** and react to `$ticker` threads, launches, and integrations with grounded one-liners. |
| **Global Cross-Language Engagement** | Reply natively in Mandarin, Japanese, Korean, Arabic, Spanish, Indonesian, or English while verifying exact meaning via **Translation Preview**. |
| **High-Volume Creators & Founders** | Use **`Alt + R`**, **Quick Angles**, and **Anti-Repetition Memory** to reply across dozens of daily mentions without sounding repetitive or robotic. |
| **Multi-Model Power Users** | Switch effortlessly between fast inference providers and multimodal reasoning models using **Multi-Profile** tabs in the toolbar popup. |

---

## Installation (Unpacked Extension)

1. **Clone or download this repository:**
   ```bash
   git clone https://github.com/0x-zeze/AI-Reply-Extension.git
   ```
2. Open **Google Chrome**, **Brave**, **Microsoft Edge**, or **Arc** and go to:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `AI-Reply-Extension` folder.
5. Pin **X AI Reply** in your browser toolbar for instant access to profile switching and quick toggles.

---

## Configuration & How to Use

### 1. Set Up Your API Profile(s)
1. Click the **X AI Reply** toolbar icon → **Open Settings**.
2. Choose a provider preset or enter any OpenAI-compatible **API Base URL**, **API Key**, and **Model Name**:
   ```text
   Profile Name : Main Profile
   Base URL     : https://api.x.ai/v1
   API Key      : xxx
   Model        : grok-4.6-high
   Timeout      : 60
   ```
3. *(Optional)* Click **+ New Profile** to add extra API profiles (up to 6) for instant switching from the toolbar popup.
4. Click **Save Settings** and approve the browser host-permission prompt if using a custom domain, then click **Test API Connection** to verify connectivity and latency.

### Supported Provider Examples

| Provider | Base URL | Example Model | API Key Placeholder |
| :--- | :--- | :--- | :--- |
| **xAI (Grok)** | `https://api.x.ai/v1` | `grok-4.6-high` | `xxx` |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | `xxx` |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `xxx` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `anthropic/claude-3.5-haiku` | `xxx` |
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-chat` | `xxx` |
| **Custom / Local Proxy** | `https://your-proxy.example.com/v1` | `your-model-name` | `xxx` |

### 2. Generate Replies on X
- **Default Smart Reply:** Click **✨ AI Reply** (or press **`Alt + R`**) inside any X reply or quote box.
- **Specific Reaction Angle:** Hover over **✨ AI Reply** and click **👍 Agree**, **🤔 Ask**, **⚡ Counter**, or **😎 Witty**.
- **Foreign Language Verification:** When replying to Chinese, Japanese, Korean, Indonesian, or other non-English posts, check the purple **Translation Preview** (`Reply Meaning → EN`) toast at the bottom-right to confirm the exact English meaning of your reply before clicking X's **Reply** button.

---

## Project Structure

```text
AI-Reply-Extension/
├── manifest.json     # Chrome Extension Manifest V3 configuration (v5.4.1)
├── background.js     # Service worker: API proxy, vision fallback, multilingual & anti-repetition engine
├── content.js        # X DOM & image extractor, Quick Angle UI, Alt+R shortcut, Draft.js paste handler
├── options.html      # Full Settings Dashboard UI (Multi-profile, smart toggles, Auto Dark/Light)
├── options.js        # Profile manager, host permissions, & API diagnostics controller
├── popup.html        # Toolbar Popup UI (1-click profile switcher, feature toggles, tone pills)
├── popup.js          # Toolbar Popup controller
└── icons/            # Extension icons (16x16, 48x48, 128x128)
```

---

## Privacy & Security

- **No Hardcoded Secrets:** Zero API keys, tokens, or private endpoints are included in this repository (`xxx` is used strictly as a documentation placeholder).
- **Direct Local-to-API Architecture:** API keys, profiles, and recent reply variety history are stored locally in your browser (`chrome.storage.local`) and communicate exclusively with your configured Base URL.
- **Human-in-the-Loop:** Replies are only inserted into the X editor — never auto-posted without your explicit click.

---

## License

MIT License — free for personal and commercial use.
