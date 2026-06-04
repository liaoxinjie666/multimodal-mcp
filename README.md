# MCP Multimodal

AI 工具的多模态能力扩展 MCP Server。支持语音合成、图片生成、视频生成、音乐生成、视频/音频/文档理解。

让 Claude Code、Codex CLI、Hermes 等 AI 工具获得**多模态生成与理解**能力。

## 功能一览

| 能力 | 提供方 | 工具 |
|------|--------|------|
| 语音合成 | MiniMax t2a_v2 | `minimax_tts_generate` |
| 图片生成 | MiniMax image-01 | `minimax_image_generate` |
| 视频生成 | MiniMax Hailuo-2.3 | `minimax_video_generate` |
| 音乐生成 | MiniMax music-2.5+ | `minimax_music_generate` |
| 语音合成 | MiMo-V2.5-TTS | `mimo_tts_generate` |
| AI 设计声音 | MiMo VoiceDesign | `mimo_tts_voice_design_generate` |
| 声音克隆 | MiMo VoiceClone | `mimo_tts_voice_clone_generate` |
| 视频理解 | MiMo mimo-v2.5 | `access_file` (analyze 模式) |
| 图片/音频理解 | 直接 base64 传入 | `access_file` |
| 文档解析 | PDF/DOCX/PPTX/XLSX | `parse_document` |
| 多模态智能体 | MiMo + 工具调用 | `agent_execute` |

## 环境要求

- Node.js >= 18
- ffmpeg（视频抽帧/音频提取需要）
- MiniMax API Key
- MiMo API Key

## 安装

### 方式一：全局安装（推荐）

```bash
npm install -g mcp-multimodal
```

### 方式二：从源码构建

```bash
git clone https://github.com/liaoxinjie666/multimodal-mcp.git
cd multimodal-mcp/multimodal-mcp-server
npm install
npm run build
```

## API Key 获取

### MiniMax

1. 访问 [MiniMax 开放平台](https://platform.minimaxi.com/)
2. 注册并登录
3. 进入「API Keys」页面创建密钥

支持：语音合成、图片生成、视频生成、音乐生成

### MiMo (小米)

1. 访问 [小米 MiMo 开放平台](https://api.xiaomimimo.com/)
2. 注册并登录
3. 创建 API Key

支持：语音合成、声音克隆、声音设计、视频理解

## 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `MINIMAX_API_KEY` | 是 | — | MiniMax API 密钥 |
| `MIMO_API_KEY` | 是 | — | MiMo API 密钥 |
| `MINIMAX_BASE_URL` | 否 | `https://api.minimax.chat` | MiniMax API 地址（自部署/代理时修改） |
| `MIMO_BASE_URL` | 否 | `https://api.xiaomimimo.com/v1` | MiMo API 地址（自部署/代理时修改） |
| `OUTPUT_DIR` | 否 | `./generated` | 生成文件保存目录 |
| `FFMPEG_PATH` | 否 | 自动检测 | ffmpeg 可执行文件路径 |
| `ALLOWED_DIRS` | 否 | 不限 | 文件访问白名单，分号分隔，如 `C:\projects;D:\data` |

## 接入各 AI 工具

### Claude Code

```bash
claude mcp add mcp-multimodal -- mcp-multimodal
```

或手动编辑 `~/.claude.json`：

```json
{
  "mcpServers": {
    "mcp-multimodal": {
      "type": "stdio",
      "command": "mcp-multimodal",
      "env": {
        "MINIMAX_API_KEY": "你的 MiniMax Key",
        "MIMO_API_KEY": "你的 MiMo Key"
      }
    }
  }
}
```

配置完成后重启 Claude Code。

### Codex CLI

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.mcp-multimodal]
command = "mcp-multimodal"

[mcp_servers.mcp-multimodal.env]
MINIMAX_API_KEY = "你的 MiniMax Key"
MIMO_API_KEY = "你的 MiMo Key"
```

重启 Codex CLI 生效。

### Hermes

编辑 `~/.hermes/config.yaml`：

```yaml
mcp_servers:
  mcp-multimodal:
    command: "mcp-multimodal"
    env:
      MINIMAX_API_KEY: "你的 MiniMax Key"
      MIMO_API_KEY: "你的 MiMo Key"
    timeout: 180
```

重启 Hermes 生效。

### Cursor / Windsurf

编辑 `~/.cursor/mcp.json` 或 `~/.windsurf/mcp.json`：

```json
{
  "mcpServers": {
    "mcp-multimodal": {
      "type": "stdio",
      "command": "mcp-multimodal",
      "env": {
        "MINIMAX_API_KEY": "你的 MiniMax Key",
        "MIMO_API_KEY": "你的 MiMo Key"
      }
    }
  }
}
```

重启 IDE 生效。

### 从源码运行（不用全局安装）

把 `command` 改成 node 指向 dist/server.js：

```json
{
  "command": "node",
  "args": ["/path/to/multimodal-mcp-server/dist/server.js"]
}
```

## 工具使用说明

### 语音合成（MiniMax）

```
对 AI 说："用 MiniMax 合成一段语音：'你好，欢迎使用多模态 MCP'"
AI 会调用 minimax_tts_generate 工具，返回生成的音频文件路径
```

参数：
- `text`：要合成的文字
- `voice_id`：音色 ID，默认 `male-qn-qingse`
- `speed`：语速，0.5-2.0，默认 1.0
- `model`：模型，默认 `speech-2.8-hd`

### 语音合成（MiMo）

```
对 AI 说："用 MiMo 茉莉的声音合成：'今天天气真好'"
```

参数：
- `text`：要合成的文字，支持风格标签如 `(温柔)你好`、`(唱歌)歌词`
- `voice`：预设音色，可选：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`
- `style_instruction`：自然语言风格控制，如 `"用温柔低沉的语气，语速稍慢"`

### 声音克隆

```
对 AI 说："用这个音频的声音克隆来说：'你好世界'，参考音频在 D:/voice/sample.mp3"
```

参数：
- `text`：要合成的文字
- `reference_audio_path`：参考音频文件路径（mp3/wav，最大 10MB）

### 图片生成

```
对 AI 说："生成一张赛博朋克风格的城市夜景图片"
```

参数：
- `prompt`：图片描述（英文效果更佳）
- `aspect_ratio`：宽高比，可选 `1:1`、`16:9`、`9:16`

### 视频生成

```
对 AI 说："生成一段日落海滩的视频，6秒"
```

参数：
- `prompt`：视频描述
- `duration`：时长（秒），默认 6

视频生成是异步的，先返回 task_id，需要轮询查询：

```
对 AI 说："查询视频生成任务 xxx 的状态"
AI 会调用 minimax_video_query 工具
```

### 音乐生成

```
对 AI 说："生成一首轻快的电子音乐"
对 AI 说："生成一首中文歌，歌词是：春天的花秋天的月..."
```

参数：
- `prompt`：音乐风格描述
- `lyrics`：歌词（留空则生成纯音乐）
- `instrumental`：是否纯音乐，默认 false

### 视频理解

```
对 AI 说："帮我分析一下这个视频的内容：D:/videos/test.mp4"
对 AI 说："这个视频里有哪些人物和场景？D:/videos/movie.mp4"
```

参数：
- `file_path`：视频文件路径
- `question`：你对视频的问题（可选）
- `video_mode`：处理模式
  - `auto`（默认）：先用 MiMo 分析，失败则降级为抽帧
  - `analyze`：仅用 MiMo 分析（音画都保留）
  - `frames`：仅 ffmpeg 抽帧 + 提取音频
  - `path`：仅返回文件路径

### 图片/音频理解

```
对 AI 说："这张图片里有什么？D:/images/photo.jpg"
对 AI 说："这段音频在说什么？D:/audio/recording.mp3"
```

图片和音频会直接作为内容传给模型，**无信息损失**。

### 文档解析

```
对 AI 说："帮我解析这个 PDF 的内容：D:/docs/report.pdf"
```

支持：PDF、DOCX、PPTX、XLSX

### 多模态智能体

```
对 AI 说："帮我执行 agent：用 MiMo 看这个视频，然后用 ffmpeg 剪辑出前10秒"
```

`agent_execute` 是一个多轮对话工具，MiMo 可以：
1. 看到你提供的视频/图片/音频/文档
2. 根据内容进行推理
3. 返回工具调用指令（tool_calls）
4. 你执行后把结果返回，继续下一轮

适合需要"理解内容 + 执行操作"的复杂任务。

## 使用示例

### 示例 1：给视频配旁白

```
你：帮我分析 D:/videos/intro.mp4 的内容，然后用 MiniMax 生成一段旁白配音

AI 会：
1. 调用 access_file 分析视频内容
2. 根据视频内容生成旁白文案
3. 调用 minimax_tts_generate 合成语音
```

### 示例 2：文档转语音

```
你：把 D:/docs/article.pdf 的内容用 MiMo 冰糖的声音朗读出来

AI 会：
1. 调用 parse_document 解析文档
2. 提取文字内容
3. 调用 mimo_tts_generate 合成语音
```

### 示例 3：图片生成 + 再编辑

```
你：生成一张水墨风格的山水画，然后用 ffmpeg 把它变成10秒的缩放视频

AI 会：
1. 调用 minimax_image_generate 生成图片
2. 用 ffmpeg 将图片转为缩放动画视频
```

## 常见问题

### Q: 报错 "MINIMAX_API_KEY not set"

A: 确认环境变量已正确配置。检查 `~/.claude.json`（或对应工具配置文件）中 `env` 字段的 key 名拼写。

### Q: 视频分析失败

A: 确认：
1. `MIMO_API_KEY` 已配置
2. 视频文件不超过 50MB
3. 视频格式为 mp4/mov/avi/webm

### Q: ffmpeg 相关功能不工作

A: 安装 ffmpeg：
- Windows：`winget install ffmpeg` 或从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载
- macOS：`brew install ffmpeg`
- Linux：`sudo apt install ffmpeg`

或安装 npm 包：`npm install -g ffmpeg-static`

### Q: 生成的文件在哪里

A: 默认在 `./generated` 目录下（相对于 MCP Server 运行目录）。可通过 `OUTPUT_DIR` 环境变量修改。

### Q: 如何使用自部署的 API

A: 设置对应的 `*_BASE_URL` 环境变量指向你的服务地址。

## 许可证

MIT
