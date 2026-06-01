#!/usr/bin/env node
/**
 * Multimodal MCP Server
 * Tools: MiniMax (TTS/Image/Video/Music) + MiMo (TTS)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { z } from "zod";

import {
  minimaxTTS,
  minimaxImage,
  minimaxVideo,
  minimaxVideoStatus,
  minimaxMusic,
} from "./providers/minimax.js";

import {
  mimoTTS,
  mimoTTSVoiceDesign,
  mimoTTSVoiceClone,
  PRESET_VOICES,
} from "./providers/mimo.js";

import { accessFile } from "./providers/file-access.js";
import { parseDocument } from "./providers/document-parser.js";

const server = new McpServer({
  name: "multimodal",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════════════════════════════════════
// MiniMax Tools
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "minimax_tts_generate",
  "Generate speech from text using MiniMax TTS (t2a_v2).",
  {
    text: z.string().describe("Text to convert to speech"),
    voice_id: z
      .string()
      .default("male-qn-qingse")
      .describe("Voice preset ID"),
    speed: z.number().min(0.5).max(2.0).default(1.0).describe("Speech speed"),
    vol: z.number().min(0.1).max(10.0).default(1.0).describe("Volume"),
    pitch: z.number().min(-12).max(12).default(0).describe("Pitch adjustment"),
    model: z.string().default("speech-2.8-hd").describe("Model name"),
  },
  async (params) => {
    const result = await minimaxTTS(params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "minimax_image_generate",
  "Generate an image from text prompt using MiniMax.",
  {
    prompt: z.string().describe("Image description (English works best)"),
    aspect_ratio: z
      .enum(["1:1", "16:9", "9:16"])
      .default("1:1")
      .describe("Image aspect ratio"),
    model: z.string().default("image-01").describe("Model name"),
  },
  async (params) => {
    const result = await minimaxImage(params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "minimax_video_generate",
  "Generate a video from text prompt using MiniMax. Returns task_id for async processing.",
  {
    prompt: z.string().describe("Video content description"),
    duration: z.number().default(6).describe("Duration in seconds"),
    model: z
      .string()
      .default("MiniMax-Hailuo-2.3")
      .describe("Model name"),
  },
  async (params) => {
    const result = await minimaxVideo(params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "minimax_video_query",
  "Query the status of a MiniMax video generation task.",
  {
    task_id: z.string().describe("Task ID from minimax_video_generate"),
  },
  async ({ task_id }) => {
    const result = await minimaxVideoStatus(task_id);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "minimax_music_generate",
  "Generate music from text prompt using MiniMax.",
  {
    prompt: z.string().describe("Music style and content description"),
    lyrics: z.string().default("").describe("Lyrics (optional, for vocal music)"),
    instrumental: z
      .boolean()
      .default(false)
      .describe("Generate instrumental only (no vocals)"),
    model: z.string().default("music-2.5+").describe("Model name"),
  },
  async (params) => {
    const result = await minimaxMusic(params);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// MiMo TTS Tools
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "mimo_tts_generate",
  `Generate speech using MiMo-V2.5-TTS with preset voices. Voices: ${PRESET_VOICES.join(", ")}. Supports style tags like (温柔)你好 and singing with (唱歌)歌词.`,
  {
    text: z
      .string()
      .describe(
        'Text to synthesize. Can include style tags like "(温柔)你好" or "(唱歌)歌词"',
      ),
    voice: z
      .enum(PRESET_VOICES as unknown as [string, ...string[]])
      .default("mimo_default")
      .describe("Preset voice ID"),
    style_instruction: z
      .string()
      .default("")
      .describe(
        'Natural language style control, e.g. "用温柔低沉的语气，语速稍慢"',
      ),
    audio_format: z.enum(["wav", "pcm16"]).default("wav").describe("Output format"),
  },
  async (params) => {
    const result = await mimoTTS({
      ...params,
      format: params.audio_format,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "mimo_tts_voice_design_generate",
  "Generate speech with a custom AI-designed voice using MiMo VoiceDesign. Describe the desired voice in natural language.",
  {
    text: z.string().describe("Text to synthesize"),
    voice_description: z
      .string()
      .describe(
        'Voice description, e.g. "young female, warm and confident, slow pace"',
      ),
    optimize_text: z
      .boolean()
      .default(true)
      .describe("Auto-optimize synthesis text"),
    audio_format: z.enum(["wav", "pcm16"]).default("wav").describe("Output format"),
  },
  async (params) => {
    const result = await mimoTTSVoiceDesign({
      ...params,
      format: params.audio_format,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "mimo_tts_voice_clone_generate",
  "Generate speech by cloning a voice from a reference audio sample using MiMo VoiceClone.",
  {
    text: z.string().describe("Text to synthesize"),
    reference_audio_path: z
      .string()
      .describe("Local path to reference audio file (mp3/wav, max 10MB)"),
    style_instruction: z
      .string()
      .default("")
      .describe("Optional style control instruction"),
    audio_format: z.enum(["wav", "pcm16"]).default("wav").describe("Output format"),
  },
  async (params) => {
    const result = await mimoTTSVoiceClone({
      ...params,
      format: params.audio_format,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// File / Document Tools
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "access_file",
  "Read a local file as multimodal content. Image/audio is injected as base64 content blocks (LLM can see/hear). Video has no MCP content type — use video_mode: 'analyze' (call MiMo mimo-v2.5 for text description), 'frames' (ffmpeg → image blocks), 'auto' (analyze then fall back to frames), or 'path' (just return file path). Documents (PDF/DOCX/PPTX/XLSX) are delegated to parse_document.",
  {
    file_path: z
      .string()
      .describe("Absolute path to the local file"),
    question: z
      .string()
      .optional()
      .describe("Optional question/instruction paired with the file"),
    video_mode: z
      .enum(["auto", "analyze", "frames", "path"])
      .default("auto")
      .describe(
        "Video processing mode. 'analyze'=MiMo text desc, 'frames'=ffmpeg PNG frames, 'path'=save and return path, 'auto'=analyze then fall back to frames.",
      ),
    video_fps: z
      .number()
      .min(0.1)
      .max(10)
      .default(2)
      .describe("MiMo video analyze: frames-per-second sampling (0.1-10)"),
    video_num_frames: z
      .number()
      .min(1)
      .max(32)
      .default(8)
      .describe("ffmpeg frames mode: number of frames to extract (1-32)"),
    video_media_resolution: z
      .enum(["default", "max"])
      .default("default")
      .describe("MiMo video analyze: per-frame resolution tier"),
  },
  async (params) => accessFile(params),
);

server.tool(
  "parse_document",
  "Parse PDF / DOCX / PPTX / XLSX and extract text + embedded media. Returns text and a list of inline images (base64). Audio/video and unsupported image formats are saved to OUTPUT_DIR.",
  {
    file_path: z
      .string()
      .describe("Absolute path to the document file"),
  },
  async (params) => parseDocument(params),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════════════════════════

const transport = new StdioServerTransport();
console.error("Starting Multimodal MCP Server...");
console.error(
  `Output directory: ${process.env.OUTPUT_DIR ?? join(process.cwd(), "generated")}`,
);
await server.connect(transport);
