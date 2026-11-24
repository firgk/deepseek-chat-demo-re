# deepseek-chat-demo-re

[English](README.md) | 简体中文

<img src="src/logo.svg" width="64" alt="deepseek-chat-demo-re" />

面向 OpenAI 兼容 Chat Completions API 的自托管聊天客户端，提供模型预设、思考强度控制、联网搜索、图片输入和跨设备会话同步。

## 功能

- 多模型切换：获取模型列表、按字符顺序模糊搜索、手动输入模型 ID。
- 模型预设：保存模型、思考强度、搜索强度组合，删除前确认。
- 联网搜索：四档搜索强度，实时显示思考、搜索进度和来源。
- 图片输入：选择、粘贴、拖拽图片，直接发送给支持视觉的模型。
- 聊天：流式回复、停止生成、编辑提问、重新生成、消息分支、快捷输入。
- 自托管：站点密码登录、服务端 OpenAI API Key、SQLite 历史同步。
- 界面：中英文、浅色 / 深色主题、手机端两行工具栏和统一下拉菜单。
- 渲染：Markdown、代码高亮、KaTeX 公式、Mermaid 图表，ZIP 历史导入导出。

具体能力取决于 API 服务及模型。暂不支持直接上传文档、语音输入、回复朗读和中断后继续生成；会话标题取自首条提问或图片文件名。

## 快速开始

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
HOST=0.0.0.0
PORT=3000
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=replace-with-your-api-key
OPENAI_SYSTEM_PROMPT=你是一个 AI 问答助手。
OPENAI_MODEL_PRESETS=[]
```

填写所使用的 OpenAI 兼容服务地址及对应密钥。

```sh
pnpm build
pnpm start
```

访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)，输入站点密码，在输入框选择模型即可开始对话。

## 配置

| 配置项               | 说明                                       |
| -------------------- | ------------------------------------------ |
| SITE_PASSWORD        | 必填，站点登录密码                         |
| HOST                 | 监听地址，0.0.0.0 允许局域网访问           |
| PORT                 | 监听端口，默认 3000                        |
| OPENAI_BASE_URL      | 接口根地址，包含服务商要求的前缀（如 /v1） |
| OPENAI_API_KEY       | 服务端 API Key；无需鉴权时可留空           |
| OPENAI_SYSTEM_PROMPT | 系统提示词，留空不注入身份提示词           |
| OPENAI_MODEL_PRESETS | 模型预设 JSON 数组，默认为 []              |

登录时恢复上次选择的预设，否则使用第一个预设；没有预设时手动选择模型，思考强度默认为 default。

在「设置 → 数据管理 → 模型 API」编辑系统提示词，保存后下一次请求生效，无需重启。配置文件支持单行纯文本或 JSON 字符串（例如 `OPENAI_SYSTEM_PROMPT="你是 AI 助手。\n请简洁回答。"`），联网工具规则独立追加。

思考强度：`default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。模型不一定支持全部档位。

预设配置示例（单行 JSON）：

```ini
OPENAI_MODEL_PRESETS=[{"model":"your-model-id","effort":"high","searchStrength":"medium"}]
```

「设置 → 数据管理」可修改端点及站点密码、获取模型列表、控制选择器显示。更换端点时需提供对应 API Key 或明确选择无需密钥。保存配置会写回 `.config`。

## 使用说明

### 模型预设与快捷输入

选择模型、思考强度和搜索强度，点击「添加预设」。切换预设即可应用整组配置，删除预设需要确认。隐藏选择器不重置当前选择。模型模糊搜索按字符顺序匹配，例如 `g5` 匹配 `gpt-5`，`5g` 不匹配。

「快捷输入」可在光标处插入内置或自定义提示词，也可将草稿保存为预设。自定义快捷提示词支持跨设备同步。

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

支持 PNG、JPEG、WebP、GIF，可仅发送图片，也可附带文字。

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
- 暂不支持直接上传其他文档格式。

## 部署与数据

在 `.config` 中设置 `HOST=0.0.0.0` 和 `PORT=3000`，执行 `pnpm start` 后访问 `http://服务器IP:3000`。仅本机访问时使用 `HOST=127.0.0.1`。环境变量优先于配置文件；均未设置时默认监听 `127.0.0.1:3000`。修改监听配置后需要重启服务。

公网部署使用 HTTPS 反向代理，传递 `X-Forwarded-Proto: https`。设置强密码，不公开 `.config` 或 `.data/`。服务重启后需要重新登录。

| 存储位置               | 内容                            |
| ---------------------- | ------------------------------- |
| .config                | 站点密码、OpenAI 配置、模型预设 |
| .data/chat-demo.sqlite | 会话历史、自定义快捷提示词      |
| localStorage           | 界面设置及选择偏好              |
| IndexedDB              | 本地会话、附件原件              |
| 服务端内存             | 登录会话                        |

自动保存和加载历史。同一会话发生跨设备冲突时，刷新获取服务器最新版本。附件描述同步，原件不随服务器历史同步。备份时保留 `.config` 和 `.data/`，本地原图另用 ZIP 导出。

首次使用服务版会迁移同一站点源尚未同步的本地会话。跨站点源迁移请先导出 ZIP，再在新站点导入。

导入经确认、校验后替换全部会话；导出包含会话和本地可用原图，不含 API Key、站点配置或非图片附件原件。删除所有对话会同步清理服务端历史和本地附件。详见[归档格式](src/services/chat/history/README.md)。

## 开发

使用 `pnpm build && pnpm start` 运行完整应用（登录、API 代理、联网工具、历史同步）。仅开发前端时可使用 `pnpm dev`，默认端口为 8090。

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
  i18n/             中英文文案
  utils/            通用工具
tests/              前端测试
.config_example     配置示例
```

## 许可证

[MIT](LICENSE)，基于 [DeepSeek 原始项目](https://github.com/deepseek-ai/chat-demo) 扩展。分发时保留 `dist/LICENSE`，第三方依赖遵循各自许可证。
