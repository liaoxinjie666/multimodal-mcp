/**
 * MiMo TTS Provider
 * Handles: Text-to-Speech via MiMo-V2.5-TTS series models
 * Also: Video understanding via mimo-v2.5 chat/completions (video_url)
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { tsFilename, writeToOutputDir } from "../utils.js";

const MIMO_BASE_URL =
  process.env.MIMO_BASE_URL ?? "https://api.xiaomimimo.com/v1";
const MIMO_API_KEY = process.env.MIMO_API_KEY ?? "";

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "api-key": MIMO_API_KEY,
  };
}

// ── Minimal response types ───────────────────────────────────────────────────

interface MimoTTSResponse {
  choices?: Array<{ message?: { audio?: { data?: string } } }>;
  usage?: unknown;
}

export const PRESET_VOICES = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
] as const;

// ── Preset Voice TTS ────────────────────────────────────────────────────────

export interface MimoTTSParams {
  text: string;
  voice?: string;
  style_instruction?: string;
  format?: string;
  model?: string;
}

export async function mimoTTS(params: MimoTTSParams) {
  if (!MIMO_API_KEY) return { error: "MIMO_API_KEY not set" };

  const url = `${MIMO_BASE_URL}/chat/completions`;
  const messages: Array<{ role: string; content: string }> = [];

  if (params.style_instruction) {
    messages.push({ role: "user", content: params.style_instruction });
  }
  messages.push({ role: "assistant", content: params.text });

  const body = {
    model: params.model ?? "mimo-v2.5-tts",
    messages,
    audio: {
      format: params.format ?? "wav",
      voice: params.voice ?? "mimo_default",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    return { error: `MiMo TTS failed (${resp.status}): ${await resp.text()}` };
  }

  const data = (await resp.json()) as MimoTTSResponse;
  const audioData = data?.choices?.[0]?.message?.audio?.data;
  if (!audioData) return { error: "No audio in response", raw: data };

  const audioBuf = Buffer.from(audioData, "base64");
  const ext = params.format ?? "wav";
  const filename = tsFilename("mimo_tts", ext);
  const { outPath, size_bytes } = await writeToOutputDir(filename, audioBuf);

  return {
    success: true,
    file: outPath,
    size_bytes,
    format: ext,
    voice: params.voice ?? "mimo_default",
  };
}

// ── Voice Design TTS ────────────────────────────────────────────────────────

export interface MimoVoiceDesignParams {
  text: string;
  voice_description: string;
  optimize_text?: boolean;
  format?: string;
}

export async function mimoTTSVoiceDesign(params: MimoVoiceDesignParams) {
  if (!MIMO_API_KEY) return { error: "MIMO_API_KEY not set" };

  const url = `${MIMO_BASE_URL}/chat/completions`;
  const body = {
    model: "mimo-v2.5-tts-voicedesign",
    messages: [
      { role: "user", content: params.voice_description },
      { role: "assistant", content: params.text },
    ],
    audio: {
      format: params.format ?? "wav",
      optimize_text_preview: params.optimize_text ?? true,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    return {
      error: `MiMo VoiceDesign TTS failed (${resp.status}): ${await resp.text()}`,
    };
  }

  const data = (await resp.json()) as MimoTTSResponse;
  const audioData = data?.choices?.[0]?.message?.audio?.data;
  if (!audioData) return { error: "No audio in response", raw: data };

  const audioBuf = Buffer.from(audioData, "base64");
  const ext = params.format ?? "wav";
  const filename = tsFilename("mimo_voicedesign", ext);
  const { outPath, size_bytes } = await writeToOutputDir(filename, audioBuf);

  return {
    success: true,
    file: outPath,
    size_bytes,
    format: ext,
    voice_description: params.voice_description,
  };
}

// ── Voice Clone TTS ─────────────────────────────────────────────────────────

export interface MimoVoiceCloneParams {
  text: string;
  reference_audio_path: string;
  style_instruction?: string;
  format?: string;
}

export async function mimoTTSVoiceClone(params: MimoVoiceCloneParams) {
  if (!MIMO_API_KEY) return { error: "MIMO_API_KEY not set" };

  const refPath = params.reference_audio_path;
  let audioData: Buffer;
  try {
    audioData = await readFile(refPath);
  } catch {
    return { error: `Reference audio not found: ${refPath}` };
  }

  if (audioData.length > 10 * 1024 * 1024) {
    return { error: "Reference audio too large (max 10MB before base64)" };
  }

  const ext = extname(refPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mpeg": "audio/mpeg",
  };
  const mime = mimeMap[ext] ?? "audio/mpeg";
  const voiceValue = `data:${mime};base64,${audioData.toString("base64")}`;

  const url = `${MIMO_BASE_URL}/chat/completions`;
  const messages: Array<{ role: string; content: string }> = [];
  messages.push({
    role: "user",
    content: params.style_instruction ?? "",
  });
  messages.push({ role: "assistant", content: params.text });

  const body = {
    model: "mimo-v2.5-tts-voiceclone",
    messages,
    audio: {
      format: params.format ?? "wav",
      voice: voiceValue,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });

  if (!resp.ok) {
    return {
      error: `MiMo VoiceClone TTS failed (${resp.status}): ${await resp.text()}`,
    };
  }

  const data = (await resp.json()) as MimoTTSResponse;
  const audioResult = data?.choices?.[0]?.message?.audio?.data;
  if (!audioResult) return { error: "No audio in response", raw: data };

  const outBuf = Buffer.from(audioResult, "base64");
  const outExt = params.format ?? "wav";
  const filename = tsFilename("mimo_voiceclone", outExt);
  const { outPath, size_bytes } = await writeToOutputDir(filename, outBuf);

  return {
    success: true,
    file: outPath,
    size_bytes,
    format: outExt,
  };
}

// ── Video Understanding (mimo-v2.5 native video_url) ──────────────────────
//
// Sends a base64-encoded video to MiMo as a video_url content block.
// MiMo handles frame extraction + audio understanding server-side, returns
// text description. Useful when client-side LLM (Claude/GPT) can't see video
// natively. Aligned with protocol-proxy's "use specialized API to summarize
// media, return text" pattern.

export interface MimoVideoAnalyzeParams {
  video_path: string;
  question?: string;
  fps?: number;
  media_resolution?: "default" | "max";
  model?: string;
}

const MAX_VIDEO_BASE64_BYTES = 50 * 1024 * 1024; // MiMo base64 limit

interface MimoChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: unknown;
}

export async function mimoVideoAnalyze(params: MimoVideoAnalyzeParams) {
  if (!MIMO_API_KEY) return { error: "MIMO_API_KEY not set" };

  let videoBuf: Buffer;
  try {
    videoBuf = await readFile(params.video_path);
  } catch {
    return { error: `Video not found: ${params.video_path}` };
  }
  if (videoBuf.length > MAX_VIDEO_BASE64_BYTES) {
    return {
      error: `Video too large for base64 (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB), limit 50MB`,
    };
  }

  const ext = extname(params.video_path).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
    ".webm": "video/webm",
  };
  const mime = mimeMap[ext] ?? "video/mp4";
  const dataUrl = `data:${mime};base64,${videoBuf.toString("base64")}`;

  const fps = Math.max(0.1, Math.min(10, params.fps ?? 2));
  const mediaResolution = params.media_resolution ?? "default";
  const prompt = params.question || "Describe this video in detail: scene, people, actions, subtitles, and audio.";

  const body = {
    model: params.model ?? "mimo-v2.5",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "video_url",
            video_url: { url: dataUrl },
            fps,
            media_resolution: mediaResolution,
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_completion_tokens: 2048,
  };

  const resp = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });

  if (!resp.ok) {
    return {
      error: `MiMo video analyze failed (${resp.status}): ${await resp.text()}`,
    };
  }

  const data = (await resp.json()) as MimoChatResponse;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) return { error: "No content in response", raw: data };

  return {
    success: true,
    description: text,
    model: body.model,
    fps,
    media_resolution: mediaResolution,
    size_bytes: videoBuf.length,
    mime,
    usage: data?.usage,
  };
}
