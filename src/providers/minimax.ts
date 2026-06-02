/**
 * MiniMax API Provider
 * Handles: TTS (t2a_v2), Image Generation, Video Generation, Music Generation
 */

import { createWriteStream } from "node:fs";
import { tsFilename, writeToOutputDir, ensureOutputDir, OUTPUT_DIR } from "../utils.js";
import { join } from "node:path";

const MINIMAX_BASE_URL =
  process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "";

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MINIMAX_API_KEY}`,
  };
}

// ── Minimal response types ───────────────────────────────────────────────────

interface MiniMaxTTSResponse {
  data?: { audio?: string };
}

interface MiniMaxImageResponse {
  data?: { image_urls?: string[] };
}

interface MiniMaxMusicResponse {
  data?: { audio?: string; duration?: number };
}

/** Download a URL to a buffer with a size limit. */
async function fetchWithLimit(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return { ok: false, error: `Download failed: ${resp.status}` };

  const contentLength = resp.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return {
      ok: false,
      error: `File too large (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB), limit ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
    };
  }

  const data = Buffer.from(await resp.arrayBuffer());
  if (data.length > maxBytes) {
    return {
      ok: false,
      error: `File too large (${(data.length / 1024 / 1024).toFixed(1)}MB), limit ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
    };
  }

  return { ok: true, data };
}

/**
 * Download a URL directly to a file on disk via stream.
 * Memory usage stays constant (~chunk size) regardless of file size.
 */
async function fetchStreamToDisk(
  url: string,
  outPath: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ ok: true; size_bytes: number } | { ok: false; error: string }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return { ok: false, error: `Download failed: ${resp.status}` };

  const contentLength = resp.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return {
      ok: false,
      error: `File too large (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB), limit ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
    };
  }

  if (!resp.body) return { ok: false, error: "No response body" };

  await ensureOutputDir();
  const fileStream = createWriteStream(outPath);
  let downloaded = 0;

  // Register close/error listeners BEFORE any writes to avoid race condition.
  // Use "close" instead of "finish" — destroy() emits close but not finish.
  const finished = new Promise<void>((resolve, reject) => {
    fileStream.on("close", resolve);
    fileStream.on("error", reject);
  });

  const reader = resp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      if (downloaded > maxBytes) {
        fileStream.destroy();
        const { unlink } = await import("node:fs/promises");
        await unlink(outPath).catch(() => {});
        return {
          ok: false,
          error: `File too large (${(downloaded / 1024 / 1024).toFixed(1)}MB), limit ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
        };
      }
      fileStream.write(value);
    }
  } finally {
    fileStream.end();
  }

  await finished;

  return { ok: true, size_bytes: downloaded };
}

// ── TTS ─────────────────────────────────────────────────────────────────────

export interface MinimaxTTSParams {
  text: string;
  voice_id?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  model?: string;
}

export async function minimaxTTS(params: MinimaxTTSParams) {
  if (!MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not set" };

  const url = `${MINIMAX_BASE_URL}/v1/t2a_v2`;
  const body = {
    model: params.model ?? "speech-2.8-hd",
    text: params.text,
    voice_setting: {
      voice_id: params.voice_id ?? "male-qn-qingse",
      speed: params.speed ?? 1.0,
      vol: params.vol ?? 1.0,
      pitch: params.pitch ?? 0,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    return { error: `MiniMax TTS failed (${resp.status}): ${await resp.text()}` };
  }

  const data = (await resp.json()) as MiniMaxTTSResponse;
  const audioHex = data?.data?.audio;
  if (!audioHex) return { error: "No audio in response", raw: data };

  const audioBuf = Buffer.from(audioHex, "hex");
  const filename = tsFilename("minimax_tts", "mp3");
  const { outPath, size_bytes } = await writeToOutputDir(filename, audioBuf);

  return { success: true, file: outPath, size_bytes, format: "mp3" };
}

// ── Image Generation ────────────────────────────────────────────────────────

export interface MinimaxImageParams {
  prompt: string;
  aspect_ratio?: string;
  model?: string;
}

export async function minimaxImage(params: MinimaxImageParams) {
  if (!MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not set" };

  const url = `${MINIMAX_BASE_URL}/v1/image_generation`;
  const body = {
    model: params.model ?? "image-01",
    prompt: params.prompt,
    aspect_ratio: params.aspect_ratio ?? "1:1",
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    return { error: `MiniMax image gen failed (${resp.status}): ${await resp.text()}` };
  }

  const data = (await resp.json()) as MiniMaxImageResponse;
  const imageUrls = data?.data?.image_urls ?? [];
  if (!imageUrls.length) return { error: "No images in response", raw: data };

  const downloaded = await fetchWithLimit(imageUrls[0], 50 * 1024 * 1024, 30_000);
  if (!downloaded.ok) return { error: downloaded.error };

  const filename = tsFilename("minimax_img", "png");
  const { outPath, size_bytes } = await writeToOutputDir(filename, downloaded.data);

  return { success: true, file: outPath, size_bytes, url: imageUrls[0] };
}

// ── Video Generation ────────────────────────────────────────────────────────

export interface MinimaxVideoParams {
  prompt: string;
  duration?: number;
  model?: string;
}

export async function minimaxVideo(params: MinimaxVideoParams) {
  if (!MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not set" };

  const url = `${MINIMAX_BASE_URL}/v1/video_generation`;
  const body = {
    model: params.model ?? "MiniMax-Hailuo-2.3",
    prompt: params.prompt,
    duration: String(params.duration ?? 6),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    return { error: `MiniMax video gen failed (${resp.status}): ${await resp.text()}` };
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const taskId = data?.task_id as string | undefined;
  if (taskId) {
    return {
      success: true,
      status: "processing",
      task_id: taskId,
      message: `Video generation started. Task ID: ${taskId}. Poll with minimax_video_query.`,
    };
  }

  const nested = data?.data as Record<string, unknown> | undefined;
  const videoUrl = (data?.video_url as string) ?? (nested?.video_url as string);
  if (videoUrl) return { success: true, video_url: videoUrl };

  return { success: true, raw: data };
}

export async function minimaxVideoStatus(taskId: string) {
  if (!MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not set" };

  const url = `${MINIMAX_BASE_URL}/v1/query/video_generation?task_id=${taskId}`;
  const resp = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    return { error: `Query failed (${resp.status}): ${await resp.text()}` };
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const status = (data?.status as string) ?? "unknown";

  if (status === "Success") {
    const videoUrl = (data?.video as { url?: string })?.url ?? (data?.file_id as string) ?? "";
    if (videoUrl.startsWith("http")) {
      const filename = tsFilename("minimax_video", "mp4");
      const outPath = join(OUTPUT_DIR, filename);
      const downloaded = await fetchStreamToDisk(videoUrl, outPath, 500 * 1024 * 1024, 120_000);
      if (downloaded.ok) {
        return { success: true, status: "completed", file: outPath, size_bytes: downloaded.size_bytes };
      }
    }
    return { success: true, status: "completed", video_url: videoUrl };
  }

  return { success: true, status, message: "Still processing. Poll again later." };
}

// ── Music Generation ────────────────────────────────────────────────────────

export interface MinimaxMusicParams {
  prompt: string;
  lyrics?: string;
  instrumental?: boolean;
  model?: string;
}

export async function minimaxMusic(params: MinimaxMusicParams) {
  if (!MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not set" };

  const url = `${MINIMAX_BASE_URL}/v1/music_generation`;
  const body: Record<string, unknown> = {
    model: params.model ?? "music-2.5+",
    prompt: params.prompt,
  };
  if (params.instrumental) body.instrumental = true;
  if (params.lyrics) {
    body.lyrics = params.lyrics;
    body.lyrics_optimizer = true;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    return { error: `MiniMax music gen failed (${resp.status}): ${await resp.text()}` };
  }

  const data = (await resp.json()) as MiniMaxMusicResponse;
  const audioHex = data?.data?.audio;
  if (!audioHex) return { error: "No audio in response", raw: data };

  const audioBuf = Buffer.from(audioHex, "hex");
  const filename = tsFilename("minimax_music", "mp3");
  const { outPath, size_bytes } = await writeToOutputDir(filename, audioBuf);

  return {
    success: true,
    file: outPath,
    size_bytes,
    duration: data?.data?.duration,
  };
}
