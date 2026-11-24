# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天示例。可以作为静态网页运行，也可以用 Node.js 启动带登录、对话同步和 OpenAI 兼容端点的服务版。

可以通过[在线体验](https://deepseek-ai.github.io/chat-demo/)试用静态版，也可以从 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 使用。静态版的 API Key 在设置中填写。若要使用密码登录和多设备同步，请按下文启动服务版。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 启动同步版

服务版需要 Node.js 24 和 pnpm。在项目根目录执行：

```sh
pnpm install --frozen-lockfile
cp .config_example .config
chmod 600 .config
```

在 `.config` 设置 `SITE_PASSWORD`。如需连接 OpenAI 兼容服务，填写 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 和 `OPENAI_DEFAULT_MODEL`。Base URL 要包含服务商要求的路径前缀，例如 `https://api.openai.com/v1`。实际使用的 `.config` 不会提交到 Git。

```sh
pnpm build
pnpm start
```

打开 http://127.0.0.1:3000 并输入站点密码。服务默认只监听本机。要让局域网内的其他设备访问，可用 `HOST=0.0.0.0 PORT=3000 pnpm start` 监听所有网卡。公网部署应在服务前配置 HTTPS 反向代理，并传递 `X-Forwarded-Proto: https`。将项目根目录下的 `.config` 和 `.data/` 放在持久化磁盘上。SQLite 对话和快捷预设保存在 `.data/chat-demo.sqlite`。登录会话存在服务内存中，服务重启后需要重新登录。

服务版的「设置 → 数据管理」可修改站点密码和端点，保存后写回 `.config`。模型列表由配置的端点提供，默认模型 ID 也可手动填写。可开启输入框旁的模型与思考深度选择器，新对话会沿用当前选择。「快捷输入」把预设插到光标处。登录后可同步自定义预设。

服务版的对话会在操作时自动保存，登录、重新打开或刷新页面时自动加载。若另一台设备先更新了同一会话，页面会提示刷新，刷新后加载服务器最新版本。附件原件留在上传它们的浏览器，服务器同步附件描述，不同步文件原件。服务版首次启动会将当前站点源 IndexedDB 中服务器尚未保存的会话迁移到 SQLite。浏览器的 IndexedDB 按站点源隔离，从不同站点切换时，可在旧站点导出 ZIP，再在新站点导入。静态版继续只在当前浏览器本地保存历史。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

静态版的 API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。确认并通过校验后，导入会替换当前模式中的全部会话。静态版替换本地记录，服务版同时替换服务器历史。导出包含会话和本地可用的图片原件，不包含 API Key、站点配置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空当前模式的会话和附件原件，停止正在生成的回复并返回新对话。服务版也会同步清除服务器历史。浏览器中的 API Key、站点配置和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                               |
| ------------- | ---------------------------------- |
| `pnpm dev`    | 启动开发服务器                     |
| `pnpm build`  | 构建到 `dist/`                     |
| `pnpm type`   | TypeScript 类型检查                |
| `pnpm lint`   | oxlint 检查                        |
| `pnpm format` | oxfmt 格式化                       |
| `pnpm test`   | 运行服务端和前端测试（Node.js 24） |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
