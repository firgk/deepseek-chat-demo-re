# deepseek-chat-demo-re

[English](README.md) | 简体中文

<img src="src/logo.svg" width="64" alt="deepseek-chat-demo-re" />

基于 DeepSeek 聊天示例扩展的自托管聊天客户端，支持 DeepSeek 原生 API 和 OpenAI 兼容 API，提供模型预设、联网搜索、图片输入和跨设备会话同步。

## 功能

- 多模型切换：获取模型列表、按字符顺序模糊搜索、手动输入模型 ID。
- 模型预设：保存模型、思考强度、搜索强度组合，删除前确认。
- 联网搜索：四档搜索强度，实时显示思考、搜索进度和来源。
- 图片输入：选择、粘贴、拖拽图片，直接发送给支持视觉的模型。
- 聊天：流式回复、停止生成、编辑提问、重新生成、消息分支、快捷输入。
- 自托管：站点密码登录、服务端 OpenAI API Key、SQLite 历史同步。
- 界面：中英文、浅色 / 深色主题、手机端两行工具栏和统一下拉菜单。
- 渲染：Markdown、代码高亮、KaTeX 公式、Mermaid 图表，ZIP 历史导入导出。

### API 模式对比

| 功能            | DeepSeek                   | OpenAI 兼容                |
| --------------- | -------------------------- | -------------------------- |
| 运行方式        | 静态版 / 服务版            | 服务版                     |
| 协议            | Anthropic Messages / Files | Chat Completions           |
| 模型            | deepseek-flash             | 自定义                     |
| 深度思考        | 原生开关                   | 思考强度与返回的思考内容   |
| 搜索            | 原生智能搜索               | Firecrawl Function Calling |
| 图片            | Files API                  | Base64 image_url           |
| PDF、文档等附件 | 支持                       | 暂不支持                   |
| 网页正文读取    | 支持                       | fetch_url                  |
| 语音输入 / 朗读 | 支持                       | 暂不支持                   |
| 自动标题        | API 生成                   | 截取提问或图片文件名       |
| 继续生成        | 符合条件时支持             | 暂不支持                   |

具体能力取决于 API 服务及模型。

## 快速开始（推荐服务版）

环境：Node.js 24、pnpm。

```sh
git clone https://github.com/firgk/deepseek-chat-demo-re.git
cd deepseek-chat-demo-re
pnpm install --frozen-lockfile
cp -n .config_example .config
chmod 600 .config
```

编辑 `.config`：

```ini
SITE_PASSWORD=replace-with-your-password
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-api-key
OPENAI_DEFAULT_MODEL=your-model-id
OPENAI_DEFAULT_REASONING_EFFORT=default
OPENAI_MODEL_PRESETS=[]
```

仅使用 DeepSeek 原生模式时，OpenAI 配置可以留空，在网页设置中填写 DeepSeek API Key。

```sh
pnpm build
pnpm start
```

访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)，输入站点密码。

## 配置

| 配置项                          | 说明                                       |
| ------------------------------- | ------------------------------------------ |
| SITE_PASSWORD                   | 必填，站点登录密码                         |
| OPENAI_BASE_URL                 | 接口根地址，包含服务商要求的前缀（如 /v1） |
| OPENAI_API_KEY                  | 服务端 API Key；无需鉴权时可留空           |
| OPENAI_DEFAULT_MODEL            | 默认模型 ID                                |
| OPENAI_DEFAULT_REASONING_EFFORT | 默认思考强度，默认为 default               |
| OPENAI_MODEL_PRESETS            | 模型预设 JSON 数组，默认为 []              |

思考强度：`default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。模型不一定支持全部档位。

预设配置示例（单行 JSON）：

```ini
OPENAI_MODEL_PRESETS=[{"model":"your-model-id","effort":"high","searchStrength":"medium"}]
```

「设置 → 数据管理」可切换服务、修改端点及站点密码、获取模型列表、控制选择器显示。更换端点时需提供对应 API Key 或明确选择无需密钥。保存配置会写回 `.config`。

## 使用说明

### 模型预设与快捷输入

选择模型、思考强度和搜索强度，点击「添加预设」。切换预设即可应用整组配置，删除预设需要确认。隐藏选择器不重置当前选择。模型模糊搜索按字符顺序匹配，例如 `ds` 匹配 `deepseek`，`sd` 不匹配。

「快捷输入」可在光标处插入内置或自定义提示词，也可将草稿保存为预设。自定义快捷提示词支持服务端同步。

### 搜索强度

| 强度 | 配置值 | 每次结果上限 | 最大联网轮次 |
| ---- | ------ | -----------: | -----------: |
| 关闭 | off    |            0 |            0 |
| 低   | low    |            5 |            2 |
| 中   | medium |            8 |            5 |
| 高   | high   |           10 |           10 |

搜索和网页读取共用轮次预算，每轮最多 3 次工具调用，相同调用去重。单次搜索超时 15 秒，读取超时 20 秒。接口须支持 Function Calling。

使用 Firecrawl 免 Key HTTP 搜索，不启动 MCP。免 Key 服务可能限流或不可用。查询会发往第三方，请勿包含敏感信息。策略见 [server/search-policy.mjs](server/search-policy.mjs)。

思考内容取决于服务商是否返回 `reasoning_content` 或 `reasoning`。

### 网页正文读取

开启搜索强度后，模型可直接调用 `fetch_url(url, startIndex?)`，通过 Web Basics 提取公开 HTTP(S) 网页、PDF、纯文本及受支持的帖子、视频字幕。每次最多返回 8000 字符，使用 `nextStartIndex` 继续读取。与搜索共用轮次预算，界面显示网页标题、链接及读取进度。正文只传给模型，不保存到聊天历史。暂不支持网络图片或内网资源；若服务开放给不可信用户，建议限制服务端网络出口。

### 图片输入

OpenAI 模式支持 PNG、JPEG、WebP、GIF，可仅发送图片，也可附带文字。

```text
选择 / 粘贴 / 拖拽图片
    ↓
浏览器缩放 → Base64 image_url
    ↓
Node.js 代理 → 视觉模型
```

- 图片长边最多 4096 像素，缩放后的文件每张最多 6 MiB。
- 每次请求 Base64 图片数据总量最多 24 MiB（含历史图片）。
- 原件留在当前浏览器，保有原件时可用于后续追问。
- 不经过 DeepSeek Files API，暂不支持其他文档。

## 部署与数据

默认监听 `127.0.0.1:3000`，局域网访问：

```sh
HOST=0.0.0.0 PORT=3000 pnpm start
```

公网部署使用 HTTPS 反向代理，传递 `X-Forwarded-Proto: https`。设置强密码，不公开 `.config` 或 `.data/`。服务重启后需要重新登录。

| 存储位置               | 内容                                     |
| ---------------------- | ---------------------------------------- |
| .config                | 站点密码、OpenAI 配置、模型预设          |
| .data/chat-demo.sqlite | 会话历史、自定义快捷提示词               |
| localStorage           | DeepSeek API Key、界面设置及部分选择偏好 |
| IndexedDB              | 本地会话、附件原件                       |
| 服务端内存             | 登录会话                                 |

服务版自动保存和加载历史。同一会话发生跨设备冲突时，刷新获取服务器最新版本。附件描述同步，原件不随服务器历史同步。备份时保留 `.config` 和 `.data/`，本地原图另用 ZIP 导出。

首次使用服务版会迁移同一站点源尚未同步的本地会话。跨站点源迁移请先导出 ZIP，再在新站点导入。

导入经确认、校验后替换当前模式的全部会话；导出包含会话和本地可用原图，不含 API Key、站点配置或非图片附件原件。删除所有对话会清理当前模式历史和本地附件，不会删除 API 服务中已上传的文件。详见[归档格式](src/services/chat/history/README.md)。

## 静态版与开发

静态版仅使用 DeepSeek 原生 API，无服务端登录及历史同步。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问 [http://localhost:8090](http://localhost:8090)。执行 `pnpm build` 后可部署 `dist/`，或直接打开 `dist/index.html`（需浏览器支持 file:// 存储且 API 允许跨域请求）。在设置中填写 DeepSeek API Key。

原生模式默认通过 Anthropic 兼容的 Messages / Files API 使用 deepseek-flash，语音使用 ASR / TTS。服务需支持搜索、链接阅读、标题及 latest_reminder 等扩展。[rspack.config.ts](rspack.config.ts) 的 `createConfig({ apiOrigin, devServer })` 可自定义 API 地址和开发代理。

| 命令        | 用途                     |
| ----------- | ------------------------ |
| pnpm dev    | 前端开发                 |
| pnpm build  | 生产构建至 dist/         |
| pnpm start  | 启动 Node.js 服务        |
| pnpm type   | TypeScript 类型检查      |
| pnpm lint   | 代码检查                 |
| pnpm format | 代码格式化               |
| pnpm test   | 前后端测试（Node.js 24） |

```text
server/             认证、SQLite、API 代理、搜索
src/
  app/              布局、主题、登录
  components/       聊天、设置、公共 UI
  services/
    api/            API 协议与流式事件
    chat/           会话、分支、存储、归档
    markdown/       Markdown、公式、图表
    speech/         语音输入与朗读
  i18n/             中英文文案
  utils/            通用工具
tests/              前端测试
.config_example     配置示例
```

## 许可证

[MIT](LICENSE)，基于 [DeepSeek 原始项目](https://github.com/deepseek-ai/chat-demo) 扩展。分发时保留 `dist/LICENSE`，第三方依赖遵循各自许可证。
