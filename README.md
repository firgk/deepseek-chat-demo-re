# chat-demo

English | [简体中文](README.zh-CN.md)

A chat demo powered by the DeepSeek API. Run it as a static site or use the Node.js server for sign-in, synced history, and OpenAI-compatible endpoints.

Try the [static demo](https://deepseek-ai.github.io/chat-demo/) or download an archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) and open `index.html`. The static version takes its API key from Settings. To use password sign-in and synced history, start the server as described below.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Run with history sync

The server version requires Node.js 24 and pnpm. From the project root:

```sh
pnpm install --frozen-lockfile
cp .config_example .config
chmod 600 .config
```

Set `SITE_PASSWORD` in `.config`. To use an OpenAI-compatible endpoint, set `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_DEFAULT_MODEL`. Include the provider path prefix in the base URL, for example `https://api.openai.com/v1`. Git ignores the real `.config` file.

```sh
pnpm build
pnpm start
```

Open http://127.0.0.1:3000 and sign in with the site password. By default, the server listens on the local machine only. To allow other devices on the LAN, start it with `HOST=0.0.0.0 PORT=3000 pnpm start`. For public access, put an HTTPS reverse proxy in front of the server and pass `X-Forwarded-Proto: https`. Keep `.config` and `.data/` on persistent storage. The SQLite database at `.data/chat-demo.sqlite` holds conversations and quick prompts. Login sessions stay in server memory, so sign in again after a server restart.

In Settings → Data, you can edit the endpoint and site password, fetch models, and configure the model and reasoning selectors. New chats inherit the current selections. Quick prompts insert at the caret. Custom quick prompts sync across signed-in devices.

In server mode, conversations save automatically and load when you sign in, reopen the site, or reload. When another device updates the same conversation first, reload to fetch the latest server copy. Attachment descriptions sync, while file originals stay in the browser that uploaded them. Existing conversations from the same site origin migrate to SQLite on first use. IndexedDB is isolated by origin, so export a ZIP from the old site and import it at the new origin when moving between sites. Static mode continues to store history only in the current browser.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

In static mode, your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and validation, import replaces all conversations in the current mode. In static mode this replaces local history. In server mode it replaces the shared server history too. Exports include conversations and locally available original images, but exclude API keys, site configuration, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears conversations and local attachment originals in the current mode after confirmation. Server mode also clears shared server history. Ongoing replies stop and the app returns to a new chat. Browser API keys and settings are preserved. Files already uploaded to the API service are not deleted.

## Development

| Command       | Description                               |
| ------------- | ----------------------------------------- |
| `pnpm dev`    | Start the development server              |
| `pnpm build`  | Build into `dist/`                        |
| `pnpm type`   | Run TypeScript type checks                |
| `pnpm lint`   | Lint with oxlint                          |
| `pnpm format` | Format with oxfmt                         |
| `pnpm test`   | Test the server and frontend (Node.js 24) |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
