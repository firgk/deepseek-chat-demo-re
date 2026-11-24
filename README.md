# deepseek-chat-demo-re

English | [简体中文](README.zh-CN.md)

<img src="src/logo.svg" width="64" alt="deepseek-chat-demo-re" />

A self-hosted chat client for OpenAI-compatible Chat Completions APIs, with model presets, reasoning controls, web search, image input, and synchronized chat history.

## Features

- **Models:** fetch model lists, fuzzy-search by ordered characters, or enter a model ID manually.
- **Presets:** save model, reasoning effort, and search strength together; confirm before deletion.
- **Search:** four strength levels, live reasoning and search progress, and sources.
- **Images:** select, paste, or drop images for vision-capable models.
- **Chat:** streaming, stop, edit, regenerate, message branches, and quick prompts.
- **Self-hosting:** password sign-in, server-side OpenAI credentials, and SQLite history sync.
- **Interface:** English and Chinese, light and dark themes, two-row mobile toolbar and consistent dropdowns.
- **Rendering:** Markdown, syntax highlighting, KaTeX, Mermaid, and ZIP history import/export.

Model capabilities depend on the selected provider. Direct document uploads, voice input, read-aloud playback, and continuation of interrupted replies are not supported. Chat titles are derived from the first prompt or image filename.

## Quick start

Requirements: Node.js 24 and pnpm.

```sh
git clone https://github.com/firgk/deepseek-chat-demo-re.git
cd deepseek-chat-demo-re
pnpm install --frozen-lockfile
cp -n .config_example .config
chmod 600 .config
```

Edit `.config`:

```ini
SITE_PASSWORD=replace-with-your-password
HOST=0.0.0.0
PORT=3000
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-api-key
OPENAI_SYSTEM_PROMPT=你是一个 AI 问答助手。
OPENAI_MODEL_PRESETS=[]
```

Set the base URL and credentials for your preferred OpenAI-compatible provider.

```sh
pnpm build
pnpm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and sign in with the site password. Select a model in the composer to start chatting.

## Configuration

| Setting              | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| SITE_PASSWORD        | Required site password                                             |
| HOST                 | Listen address; use 0.0.0.0 for LAN access                         |
| PORT                 | Listen port, default 3000                                          |
| OPENAI_BASE_URL      | API base URL, including the required prefix (e.g. /v1)             |
| OPENAI_API_KEY       | Server-side API key; may be empty if authentication is unnecessary |
| OPENAI_SYSTEM_PROMPT | System prompt; empty disables the identity prompt                  |
| OPENAI_MODEL_PRESETS | JSON array of presets, initially []                                |

On sign-in, the last selected preset is restored, or the first preset is applied. With no presets, select a model manually; reasoning starts at default.

Edit the system prompt in Settings → Data → Model API. Saved changes apply to the next request without restarting. The config supports plain single-line text or a JSON string with escaped newlines (e.g. `OPENAI_SYSTEM_PROMPT="You are an AI assistant.\nAnswer concisely."`). Web tool instructions are appended separately.

Reasoning options: `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Not every model supports all values.

Example preset (single-line JSON):

```ini
OPENAI_MODEL_PRESETS=[{"model":"your-model-id","effort":"high","searchStrength":"medium"}]
```

In Settings → Data, edit the endpoint and password, fetch models, and control selector visibility. Changing the endpoint requires its API key or explicitly choosing no key. Saved configuration is written to `.config`.

## Usage

### Model presets and quick prompts

Choose the model, reasoning effort and search strength, then click Add preset. Selecting a preset applies all three settings; deletion requires confirmation. Hiding selectors preserves the current selection. Fuzzy search matches characters in order: `g5` matches `gpt-5`, but `5g` does not.

Quick prompts insert built-in or custom prompts at the caret. Save a draft as a reusable prompt. Custom prompts sync across devices.

### Search strength

| Strength | Setting | Results per call (max) | Web tool rounds (max) |
| -------- | ------- | ---------------------: | --------------------: |
| Off      | off     |                      0 |                     0 |
| Low      | low     |                      5 |                     2 |
| Medium   | medium  |                      8 |                     5 |
| High     | high    |                     10 |                    10 |

Search and URL reading share the round budget. Each round allows up to three tool calls; identical calls are deduplicated. Search has a 15-second timeout, URL reading 20 seconds. The provider must support function calling.

Search uses only keyless Firecrawl over HTTP, without starting MCP. The service may be rate-limited or unavailable. Queries go to a third party; avoid sensitive information. See [search policy](server/search-policy.mjs).

Reasoning is displayed when the provider returns `reasoning_content` or `reasoning`.

### Read web pages

With search strength enabled, the model can also call `fetch_url(url, startIndex?)` directly. Web Basics extracts text from public HTTP(S) pages, PDFs, text files, and supported posts or video transcripts. Each call returns up to 8,000 characters; use `nextStartIndex` to continue reading. Reading shares the search round budget, and the UI displays page titles, links and progress. Only text is returned to the model; page bodies are not stored in chat history. URL images and private network resources are not supported. Deploy with restricted outbound network access when exposing the service to untrusted users.

### Image input

Supports PNG, JPEG, WebP, and GIF, with or without text.

```text
Select / paste / drop image
    ↓
Browser resize → Base64 image_url
    ↓
Node.js proxy → vision-capable model
```

- Maximum longest edge: 4096 pixels; each resulting file must be at most 6 MiB.
- Total Base64 image data per request: 24 MiB, including historical images.
- Originals remain in the current browser and can be used in follow-up requests when available.
- Direct uploads of other document formats are not supported.

## Deployment and data

Set `HOST=0.0.0.0` and `PORT=3000` in `.config`, then run `pnpm start`. Access the application at `http://server-ip:3000`. For local-only access use `HOST=127.0.0.1`. Environment variables override the file; if omitted from both, the default is `127.0.0.1:3000`. Restart the server after changing listener settings.

For public access, use an HTTPS reverse proxy and pass `X-Forwarded-Proto: https`. Set a strong password and keep `.config` and `.data/` private. Sign in again after server restarts.

| Location               | Contents                                      |
| ---------------------- | --------------------------------------------- |
| .config                | Site password, OpenAI settings, model presets |
| .data/chat-demo.sqlite | Chat history and custom quick prompts         |
| localStorage           | UI settings and selection preferences         |
| IndexedDB              | Local conversations and attachment originals  |
| Server memory          | Login sessions                                |

Chat history is saved and loaded automatically. If another device updates a conversation first, reload for the latest server copy. Attachment descriptions sync, but original files do not. Back up `.config` and `.data/`; export a ZIP to preserve locally available images.

On first use, unsynced conversations from the same origin migrate to the server. To move between origins, export a ZIP and import it at the new site.

Import replaces all conversations after confirmation and validation. Exports include conversations and locally available images, but exclude API keys, site configuration, and non-image originals. Deleting all chats clears server history and local attachments. See the [archive format (Chinese)](src/services/chat/history/README.md).

## Development

Use `pnpm build && pnpm start` to run the complete application, including authentication, the API proxy, web tools and history sync. The frontend-only development server is available via `pnpm dev` at port 8090.

| Command     | Description                            |
| ----------- | -------------------------------------- |
| pnpm dev    | Frontend dev server                    |
| pnpm build  | Build into dist/                       |
| pnpm start  | Start the Node.js server               |
| pnpm type   | TypeScript checks                      |
| pnpm lint   | Lint source                            |
| pnpm format | Format source                          |
| pnpm test   | Frontend and server tests (Node.js 24) |

```text
server/             Auth, SQLite, API proxy, search
src/
  app/              Layout, themes, sign-in
  components/       Chat, settings, shared UI
  services/
    api/            API protocols and streaming events
    chat/           Conversations, branches, storage, archives
    markdown/       Markdown, math, diagrams
  i18n/             English and Chinese translations
  utils/            Shared utilities
tests/              Frontend tests
.config_example     Configuration example
```

## License

[MIT](LICENSE), extended from the [original DeepSeek project](https://github.com/deepseek-ai/chat-demo). Keep `dist/LICENSE` when distributing the build. Third-party dependencies follow their respective licenses.
