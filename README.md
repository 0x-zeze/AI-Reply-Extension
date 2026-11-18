<div align="center">
  <img src="icons/icon128.png" alt="X AI Reply Logo" width="84" height="84" />
  <h1>X AI Reply Extension</h1>
  <p><strong>Context-locked, multilingual, zero-lag AI reply assistant for X (Twitter) — powered by your own OpenAI-compatible API.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-1d9bf0?style=flat-square" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/Version-4.1-4f46e5?style=flat-square" alt="Version 4.1" />
    <img src="https://img.shields.io/badge/UI-Auto_Dark%2FLight_60fps-10b981?style=flat-square" alt="60fps UI" />
    <img src="https://img.shields.io/badge/API-OpenAI_Compatible-7c3aed?style=flat-square" alt="OpenAI Compatible" />
  </p>
</div>

---

## Overview

**X AI Reply** injects a lightweight, GPU-accelerated **AI Reply** button directly inside X (`x.com` / `twitter.com` / `pro.x.com`) reply and quote composers. With a single click, it extracts the rich context surrounding the target post, detects the post's exact language and intent, and inserts a concise, natural, human-sounding one-liner into X's Draft.js editor — ready for you to review, tweak, or send.

Built from the ground up with **strict anti-hallucination grounding**, **native multilingual matching**, and **zero-jank DOM performance**, it avoids generic bot clichés while giving you complete control over your API provider, model, timeout, and persona.

---

## Key Features

### 1. Deep Multi-Layer Post Context Extraction
Unlike basic scrapers that only read a single line of text, X AI Reply inspects the full conversation structure around the reply box:
- **Target Post Content**: Preserves exact spacing across inline links, `@mentions`, `$cashtags`, `#hashtags`, and emoji `alt` attributes.
- **Thread & Parent History**: Automatically reads up to 2 preceding posts in a thread or reply modal so comments on follow-up tweets retain full background context.
- **Quoted Posts**: Separately extracts embedded Quote Tweets (author + content) and bridges the quoting author's commentary with the quoted source.
- **Polls & X Longform Articles**: Reads poll choices (`cardPoll`) and native X Article titles & bodies (`twitterArticleRichTextView`).
- **Link Preview Cards & Chart Descriptions**: Captures news/article preview cards and meaningful image/chart `alt` descriptions while filtering out profile avatars and decorative icons.

### 2. Intent Classification & Anti-Hallucination Grounding
- **Intent-Aware Reactions**: Automatically detects whether the target post is a **Question**, **Poll**, **Data/Chart Milestone** (`TVL`, `%`, `ATH`, metrics), **Product Launch / Ecosystem Integration**, or **Quote Take**, steering the reply to answer questions directly or react to concrete specifics.
- **Smart Author & Entity Anchoring**: Distinguishes between the post's author, `$tickers` (e.g., `$BTC`, `$SOL`, `$INJ`), and mentioned ecosystems — weaving in natural project names instead of robotic `@handle` spam.
- **Anti-AI Slop Filter**: Strictly enforces concise, casual one-liners and blocks recognizable LLM filler phrases (*"totally agree"*, *"spot on"*, *"game changer"*, *"worth watching"*, *"quietly building"*, *"isn't just X, it's Y"*).

### 3. Automatic Multilingual & CJK Native Engine
Replies automatically match the **exact language, script, and internet register** of the target post by combining Unicode script/lexical analysis with X's native DOM `lang` attribute:
- **East Asian (CJK)**:
  - **Simplified Chinese (`zh-CN` / 简体中文)** & **Traditional Chinese (`zh-TW` / 繁體中文)** — accurately distinguished even when mixed with English protocol/project names, with native `8–26` character phrasing.
  - **Japanese (`ja` / 日本語)** — supports Hiragana, Katakana, and pure-Kanji posts (`12–38` character casual X phrasing).
  - **Korean (`ko` / 한국어)** — supports Hangul and Korean Jamo slang (`ㅋㅋㅋ`, `ㅠㅠ`) with natural community phrasing.
- **Southeast Asian, European & Middle Eastern**:
  - Native support for **English**, **Indonesian** (including casual slang), **Vietnamese**, **Thai**, **Hindi**, **Arabic**, **Russian**, **Ukrainian**, **Spanish**, **Portuguese**, **French**, **German**, **Turkish**, and more.
- **Target-First Priority**: If a user writes a comment in Indonesian, Chinese, Japanese, or Korean while quoting a long English news post, the reply stays locked to the language of the post you are replying to.

### 4. Bring Your Own API (100% OpenAI-Compatible)
- Connect **xAI (Grok)**, **OpenAI**, **Groq**, **OpenRouter**, **DeepSeek**, **Ollama**, or any self-hosted OpenAI-compatible proxy (`https://your-custom-endpoint.example.com/v1`).
- **Reasoning Model Ready**: Automatically strips `<think>...</think>` / `<thinking>...</thinking>` blocks and allocates reasoning token headroom so thinking models (such as Grok reasoning, DeepSeek R1, Qwen QwQ) output clean final replies.
- **Built-in Diagnostics**: Includes host-permission verification, origin reachability probing on timeouts, automatic transient connection retry, and real-time latency measurement (`ms`).

### 5. Smooth 60/120fps UI & Ghost-Free Draft.js Insertion
- **Zero-Lag In-Page Button**: GPU-composited CSS (`transform` & `opacity` only, `contain: layout paint`), `0%` CPU overhead while typing in X's editor, and zero forced layout reflows (`getBoundingClientRect`) during timeline scrolling.
- **No Double-Text Bug**: Uses async focus synchronization + synthetic `ClipboardEvent("paste")` so X's Draft.js `EditorState` renders cleanly once — preserving native `@mention` / `$cashtag` highlighting, character counter accuracy, and normal *Backspace* editing.
- **Modern Toolbar Popup & Settings Dashboard**: Automatic system **Light / Dark Mode**, 1-click provider presets, quick tone switcher pills, API key visibility toggle, and non-blocking in-page toast notifications.

---

## Use Cases

| Use Case | How X AI Reply Helps |
| :--- | :--- |
| **Web3 / Crypto & Tech Analysts** | React to protocol launches, ecosystem integrations, `$ticker` thesis threads, and chart metrics with grounded, non-hallucinated one-liners. |
| **Cross-Language Global Communities** | Engage naturally with Japanese, Korean, Simplified/Traditional Chinese, Indonesian, Spanish, or English communities in their own native casual X tone. |
| **Founders, Creators & DevRel** | Reply quickly to community questions, polls, and quote-tweets while keeping full control to edit every message before clicking *Reply*. |
| **Multi-Tweet Thread Discussions** | Jump into deep thread replies knowing the extension automatically reads earlier parent tweets for full conversation context. |
| **Custom / Local LLM Power Users** | Route requests through OpenRouter, ultra-fast Groq inference, or private self-hosted/local gateways without vendor lock-in. |

---

## Installation (Unpacked Extension)

1. **Clone or download this repository:**
   ```bash
   git clone https://github.com/0x-zeze/AI-Reply-Extension.git
   ```
2. Open your Chromium-based browser (**Google Chrome**, **Brave**, **Microsoft Edge**, or **Arc**) and navigate to:
   ```text
   chrome://extensions
   ```
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `AI-Reply-Extension` folder.
5. *(Optional)* Pin **X AI Reply** from the browser extensions puzzle menu for quick access to the toolbar popup.

---

## Configuration & How to Use

### Step 1 — Configure Your API Provider
1. Click the **X AI Reply** icon in your browser toolbar and click **Buka Settings** (Open Settings).
2. Select a **Provider Preset** chip (`xAI Grok`, `OpenAI`, `Groq`, `OpenRouter`, `DeepSeek`) or enter your custom OpenAI-compatible **Base URL**:
   ```text
   Base URL : https://api.x.ai/v1
   API Key  : xxx
   Model    : grok-4.6-high
   Timeout  : 60
   ```
3. *(Custom Domains)* If using a provider other than `api.x.ai`, click **Simpan Pengaturan** (Save) or **Beri Izin Host** and click **Allow** when Chrome asks for host permission.
4. Click **Tes Koneksi API** (or **Tes API** inside the toolbar popup) to verify your endpoint, API key (`xxx`), model, and latency.

### Supported Provider Examples

| Provider | Base URL | Example Model | API Key Placeholder |
| :--- | :--- | :--- | :--- |
| **xAI (Grok)** | `https://api.x.ai/v1` | `grok-4.6-high` | `xxx` |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | `xxx` |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `xxx` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `anthropic/claude-3.5-haiku` | `xxx` |
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-chat` | `xxx` |
| **Custom / Local Proxy** | `https://your-proxy.example.com/v1` | `your-model-name` | `xxx` |

> **Note:** The extension automatically appends `/chat/completions` to your Base URL if not already present.

### Step 2 — Customize Reply Vibe (Optional)
- Choose a **Quick Tone Preset** directly from the **Toolbar Popup** or **Settings** (*Casual & Dry*, *Witty & Sharp*, *Crypto / CT Native*, *Critical Discussion*), or write your own custom style instructions.
- Leave language rules out of the custom prompt — the engine automatically locks onto the target post's language.

### Step 3 — Generate Replies on X
1. Open **X (`https://x.com`)** and open any **Reply** box, **Thread Reply** modal, or **Quote** composer.
2. Click the floating **✨ AI Reply** pill in the top-right corner of the reply editor.
3. Wait for the `Thinking…` indicator to turn into `✓ Done` — the generated reply is inserted directly into X's composer.
4. Review or edit the text freely, then click X's **Reply** button whenever you're ready. *(The extension never auto-submits posts without your action.)*

---

## Project Structure

```text
AI-Reply-Extension/
├── manifest.json     # Chrome Extension Manifest V3 configuration
├── background.js     # Service worker: API proxy, multilingual detector, intent & anti-halu engine
├── content.js        # X DOM context extractor, GPU-smooth button/toast UI, Draft.js paste handler
├── options.html      # Full Settings Dashboard UI (Auto Light/Dark theme)
├── options.js        # Settings persistence, host permission manager, API diagnostic runner
├── popup.html        # Toolbar Popup UI (Live status, quick tone switcher, 1-click ping)
├── popup.js          # Toolbar Popup controller
└── icons/            # Extension icons (16x16, 48x48, 128x128)
```

---

## Privacy & Security

- **No Hardcoded Secrets:** No API keys, endpoints, or personal credentials are stored in the source code. Always keep your own API key (`xxx`) private in the extension settings.
- **Zero Third-Party Telemetry:** Requests go strictly from your browser's MV3 background service worker directly to the Base URL you configure. Tweet context and API keys are never sent anywhere else.
- **Manual Send Control:** X AI Reply only populates the composer box — you always have final review before posting.

---

## Troubleshooting

- **"Izin host belum diberikan" / `Failed to fetch`:** Open **Settings** (or the **Toolbar Popup**), click **Beri Izin Host** / **Izinkan Host**, and click **Allow** in the browser prompt so the service worker can reach your custom API domain.
- **Extension updated / reloaded:** After clicking **Reload (↻)** in `chrome://extensions`, refresh any already-open X tabs (`F5`) so the updated content script attaches cleanly.
- **Slow reasoning models timing out:** Increase **Timeout Request** (up to `180` seconds) in Settings when using deep-thinking models or high-latency proxies.

---

## License

MIT License — free for personal and commercial use.
