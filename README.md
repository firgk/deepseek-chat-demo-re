# deepseek-chat-demo-re

English | [简体中文](README.zh-CN.md)

<img src="src/logo.svg" width="64" alt="deepseek-chat-demo-re" />

A self-hosted chat client extended from the DeepSeek chat demo, with native DeepSeek and OpenAI-compatible APIs, model presets, web search, image input, and synchronized chat history.

## Features

- **Models:** fetch model lists, fuzzy-search by ordered characters, or enter a model ID manually.
- **Presets:** save model, reasoning effort, and search strength together; confirm before deletion.
- **Search:** four strength levels, live reasoning and search progress, and sources.
- **Images:** select, paste, or drop images for vision-capable models.
- **Chat:** streaming, stop, edit, regenerate, message branches, and quick prompts.
- **Self-hosting:** password sign-in, server-side OpenAI credentials, and SQLite history sync.
- **Interface:** English and Chinese, light and dark themes, two-row mobile toolbar and consistent dropdowns.
- **Rendering:** Markdown, syntax highlighting, KaTeX, Mermaid, and ZIP history import/export.

### API modes

| Feature                  | DeepSeek                   | OpenAI-compatible                |
| ------------------------ | -------------------------- | -------------------------------- |
| Deployment               | Static / server            | Server                           |
| Protocol                 | Anthropic Messages / Files | Chat Completions                 |
| Model                    | deepseek-flash             | Configurable                     |
| Reasoning                | Native toggle              | Effort and returned reasoning    |
| Search                   | Native search              | Firecrawl function calling       |
| Images                   | Files API                  | Base64 image_url                 |
| PDF and other documents  | Supported                  | Not yet                          |
| Web page reading         | Supported                  | fetch_url                        |
| Voice input / read aloud | Supported                  | Not yet                          |
| Titles                   | API-generated              | Prompt excerpt or image filename |
| Continue generation      | When eligible              | Not yet                          |

Availability depends on the API and model.

## Quick start (recommended server mode)

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
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-api-key
OPENAI_DEFAULT_MODEL=your-model-id
OPENAI_DEFAULT_REASONING_EFFORT=default
OPENAI_MODEL_PRESETS=[]
```

For native DeepSeek only, leave the OpenAI fields empty and enter a DeepSeek API key in the web settings.

```sh
pnpm build
pnpm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and sign in.

## Configuration

| Setting                         | Description                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| SITE_PASSWORD                   | Required site password                                             |
| OPENAI_BASE_URL                 | API base URL, including the required prefix (e.g. /v1)             |
| OPENAI_API_KEY                  | Server-side API key; may be empty if authentication is unnecessary |
| OPENAI_DEFAULT_MODEL            | Default model ID                                                   |
| OPENAI_DEFAULT_REASONING_EFFORT | Default effort, initially default                                  |
| OPENAI_MODEL_PRESETS            | JSON array of presets, initially []                                |

Reasoning options: `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Not every model supports all values.

Example preset (single-line JSON):

```ini
OPENAI_MODEL_PRESETS=[{"model":"your-model-id","effort":"high","searchStrength":"medium"}]
```

In Settings → Data, switch providers, edit the endpoint and password, fetch models, and control selector visibility. Changing the endpoint requires its API key or explicitly choosing no key. Saved configuration is written to `.config`.

## Usage

### Model presets and quick prompts

Choose the model, reasoning effort and search strength, then click Add preset. Selecting a preset applies all three settings; deletion requires confirmation. Hiding selectors preserves the current selection. Fuzzy search matches characters in order: `ds` matches `deepseek`, but `sd` does not.

Quick prompts insert built-in or custom prompts at the caret. Save a draft as a reusable prompt. Custom prompts sync in server mode.

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

OpenAI mode supports PNG, JPEG, WebP, and GIF, with or without text.

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
- No DeepSeek Files API is used; other document formats are not supported.

## Deployment and data

Default address: `127.0.0.1:3000`. To allow LAN access:

```sh
HOST=0.0.0.0 PORT=3000 pnpm start
```

For public access, use an HTTPS reverse proxy and pass `X-Forwarded-Proto: https`. Set a strong password and keep `.config` and `.data/` private. Sign in again after server restarts.

| Location               | Contents                                                     |
| ---------------------- | ------------------------------------------------------------ |
| .config                | Site password, OpenAI settings, model presets                |
| .data/chat-demo.sqlite | Chat history and custom quick prompts                        |
| localStorage           | DeepSeek API key, UI settings and some selection preferences |
| IndexedDB              | Local conversations and attachment originals                 |
| Server memory          | Login sessions                                               |

Server mode saves and loads history automatically. If another device updates a conversation first, reload for the latest server copy. Attachment descriptions sync, but original files do not. Back up `.config` and `.data/`; export a ZIP to preserve locally available images.

On first use, unsynced conversations from the same origin migrate to the server. To move between origins, export a ZIP and import it at the new site.

Import replaces all conversations in the current mode after confirmation and validation. Exports include conversations and locally available images, but exclude API keys, site configuration, and non-image originals. Deleting all chats clears local attachments, but not files uploaded to an API service. See the [archive format (Chinese)](src/services/chat/history/README.md).

## Static mode and development

Static mode uses the native DeepSeek API without server sign-in or history sync.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:8090](http://localhost:8090). Run `pnpm build` to deploy `dist/` or open `dist/index.html` directly (requires browser support for file:// storage and API cross-origin access). Enter the DeepSeek API key in Settings.

Native mode uses deepseek-flash through Anthropic-compatible Messages / Files APIs, with ASR / TTS for speech. It requires native search, URL reading, title, and latest_reminder extensions. Customize the API origin and development proxy via `createConfig({ apiOrigin, devServer })` in [rspack.config.ts](rspack.config.ts).

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
    speech/         Recording and read-aloud playback
  i18n/             English and Chinese translations
  utils/            Shared utilities
tests/              Frontend tests
.config_example     Configuration example
```

## License

[MIT](LICENSE), extended from the [original DeepSeek project](https://github.com/deepseek-ai/chat-demo). Keep `dist/LICENSE` when distributing the build. Third-party dependencies follow their respective licenses.
