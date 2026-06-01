# Multimodal MCP Server

MCP server for multimodal generation: MiniMax (TTS/Image/Video/Music) + MiMo (TTS) + file access (image/audio/video/doc).

## Tools

### MiniMax
| Tool | Description |
|------|-------------|
| `minimax_tts_generate` | Text-to-speech (t2a_v2) |
| `minimax_image_generate` | Text-to-image |
| `minimax_video_generate` | Text-to-video (async, returns task_id) |
| `minimax_video_query` | Poll video generation status |
| `minimax_music_generate` | Text-to-music (with optional lyrics) |

### MiMo (Xiaomi)
| Tool | Description |
|------|-------------|
| `mimo_tts_generate` | TTS with preset voices (冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) |
| `mimo_tts_voice_design_generate` | TTS with AI-designed custom voice |
| `mimo_tts_voice_clone_generate` | TTS by cloning voice from audio sample |

### File / Document Access
| Tool | Description |
|------|-------------|
| `access_file` | Load a local file as multimodal content. Image/audio are returned as base64 content blocks (LLM can see/hear). Video has no MCP content type — controlled by `video_mode` parameter: `analyze` (call MiMo mimo-v2.5 for text description), `frames` (ffmpeg → image blocks), `auto` (analyze then fall back to frames), `path` (just return the file path). Documents (PDF/DOCX/PPTX/XLSX) are delegated to `parse_document`. |
| `parse_document` | Parse PDF / DOCX / PPTX / XLSX. Returns text + inline images (base64). Audio/video and unsupported image formats are saved to OUTPUT_DIR. |

## Setup

```bash
npm install
npm run build
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MINIMAX_API_KEY` | (required) | MiniMax API key |
| `MIMO_API_KEY` | (required) | MiMo API key |
| `MINIMAX_BASE_URL` | `https://api.minimax.chat` | MiniMax API base URL |
| `MIMO_BASE_URL` | `https://api.xiaomimimo.com/v1` | MiMo API base URL |
| `OUTPUT_DIR` | `./generated` (relative to server CWD) | Output directory for generated files |
| `FFMPEG_PATH` | (auto: `ffmpeg-static` → PATH) | ffmpeg binary path, used by `access_file` `video_mode=frames` |
| `ALLOWED_DIRS` | (unset = all paths) | Semicolon-separated list of allowed directories for `access_file`. Example: `C:\projects;D:\data` |

## Client Integration

MCP servers run as a child process and speak JSON-RPC 2.0 over stdio.

### Claude Code

```bash
claude mcp add multimodal -- node <path-to>/dist/server.js
# edit ~/.claude.json to set MINIMAX_API_KEY and MIMO_API_KEY under mcpServers.multimodal.env
```

Or edit `.claude.json` / `.mcp.json` directly:

```json
{
  "mcpServers": {
    "multimodal": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>/dist/server.js"],
      "env": {
        "MINIMAX_API_KEY": "your-minimax-key",
        "MIMO_API_KEY": "your-mimo-key"
      }
    }
  }
}
```

Restart Claude Code. Tools appear as `mcp__multimodal__minimax_tts_generate` etc.

### Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.multimodal]
command = "node"
args = ["<path-to>/dist/server.js"]

[mcp_servers.multimodal.env]
MINIMAX_API_KEY = "your-minimax-key"
MIMO_API_KEY = "your-mimo-key"
```

Restart Codex. Tools appear with `mcp__multimodal__` prefix.

### Hermes

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  multimodal:
    command: "node"
    args: ["<path-to>/dist/server.js"]
    env:
      MINIMAX_API_KEY: "your-minimax-key"
      MIMO_API_KEY: "your-mimo-key"
    timeout: 180
```

### Manual smoke test (no client)

```bash
node dist/server.js
# then send JSON-RPC via stdin:
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}
# {"jsonrpc":"2.0","method":"notifications/initialized"}
# {"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## Output

All generated files are saved to `OUTPUT_DIR` (default: `./generated` relative to server working directory).
