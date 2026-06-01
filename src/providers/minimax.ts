/**
 * MiniMax API Provider
 * Handles: TTS (t2a_v2), Image Generation, Video Generation, Music Generation
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const MINIMAX_BASE_URL =
  process.env.MINIMAX_BASE_URL ?? "https://api.minimax.chat";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "";

const OUTPUT_DIR =
  process.env.OUTPUT_DIR ?? join(process.cwd(), "generated");

// Ensure output dir exists
await mkdir(OUTPUT_DIR, { recursive: true });

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MINIMAX_API_KEY}`,
  };
}

function tsFilename(prefix: string, ext: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15);
  return `${prefix}_${ts}.${ext}`;
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

  const data = (await resp.json()) as any;
  const audioHex: string | undefined = data?.data?.audio;
  if (!audioHex) return { error: `No audio in response`, raw: data };

  const audioBuf = Buffer.from(audioHex, "hex");
  const filename = tsFilename("minimax_tts", "mp3");
  const outPath = join(OUTPUT_DIR, filename);
  await writeFile(outPath, audioBuf);

  return { success: true, file: outPath, size_bytes: audioBuf.length, format: "mp3" };
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

  const data = (await resp.json()) as any;
  const imageUrls: string[] = data?.data?.image_urls ?? [];
  if (!imageUrls.length) return { error: `No images in response`, raw: data };

  // Download first image
  const imgResp = await fetch(imageUrls[0], { signal: AbortSignal.timeout(30_000) });
  if (!imgResp.ok) return { error: `Download failed: ${imgResp.status}` };

  const imgBuf = Buffer.from(await imgResp.arrayBuffer());
  const filename = tsFilename("minimax_img", "png");
  const outPath = join(OUTPUT_DIR, filename);
  await writeFile(outPath, imgBuf);

  return { success: true, file: outPath, size_bytes: imgBuf.length, url: imageUrls[0] };
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

  const data = (await resp.json()) as any;
  const taskId: string | undefined = data?.task_id;
  if (taskId) {
    return {
      success: true,
      status: "processing",
      task_id: taskId,
      message: `Video generation started. Task ID: ${taskId}. Poll with minimax_video_query.`,
    };
  }

  const videoUrl = data?.video_url ?? data?.data?.video_url;
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

  const data = (await resp.json()) as any;
  const status: string = data?.status ?? "unknown";

  if (status === "Success") {
    const videoUrl: string = data?.video?.url ?? data?.file_id ?? "";
    if (videoUrl.startsWith("http")) {
      const vidResp = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
      if (vidResp.ok) {
        const vidBuf = Buffer.from(await vidResp.arrayBuffer());
        const filename = tsFilename("minimax_video", "mp4");
        const outPath = join(OUTPUT_DIR, filename);
        await writeFile(outPath, vidBuf);
        return { success: true, status: "completed", file: outPath, size_bytes: vidBuf.length };
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

  const data = (await resp.json()) as any;
  const audioHex: string | undefined = data?.data?.audio;
  if (!audioHex) return { error: `No audio in response`, raw: data };

  const audioBuf = Buffer.from(audioHex, "hex");
  const filename = tsFilename("minimax_music", "mp3");
  const outPath = join(OUTPUT_DIR, filename);
  await writeFile(outPath, audioBuf);

  return {
    success: true,
    file: outPath,
    size_bytes: audioBuf.length,
    duration: data?.data?.duration,
  };
}
