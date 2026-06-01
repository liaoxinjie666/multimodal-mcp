/**
 * Video Frame Extraction
 *
 * Uses ffmpeg to extract evenly-spaced frames from a video file, streaming
 * PNG bytes via stdout — no disk writes, no leftover temp files.
 *
 * Lookup order for ffmpeg: FFMPEG_PATH env var → ffmpeg-static package → PATH.
 *
 * Returns frame buffers + PNG base64 strings ready for MCP image content blocks.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

let cachedFfmpegPath: string | null = null;

/**
 * Probe whether a path points to a runnable ffmpeg binary by spawning
 * `ffmpeg -version` and checking the exit code. Caches the result.
 * Returns the path if runnable, null otherwise.
 */
async function probe(path: string): Promise<string | null> {
  try {
    await stat(path);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const proc = spawn(path, ["-version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? path : null));
  });
}

async function resolveFfmpegPath(): Promise<string | null> {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  // 1. Explicit env var — probe but don't cache failure (user may fix path later)
  if (process.env.FFMPEG_PATH) {
    const r = await probe(process.env.FFMPEG_PATH);
    if (r) cachedFfmpegPath = r;
    return r;
  }

  // 2. ffmpeg-static package
  try {
    const ffmpegStatic = (await import("ffmpeg-static")) as unknown as {
      default?: unknown;
    };
    const candidate =
      typeof ffmpegStatic.default === "string"
        ? ffmpegStatic.default
        : (ffmpegStatic as unknown as string | undefined);
    if (candidate && typeof candidate === "string") {
      const r = await probe(candidate);
      if (r) cachedFfmpegPath = r;
      if (r) return r;
    }
  } catch {
    // ffmpeg-static not installed
  }

  // 3. PATH
  const r = await probe("ffmpeg");
  if (r) cachedFfmpegPath = r;
  return r;
}

export async function ffmpegAvailable(): Promise<boolean> {
  return (await resolveFfmpegPath()) !== null;
}

export interface ExtractFramesParams {
  video_path: string;
  num_frames?: number; // default 8, range 1-32
  width?: number; // default 512, caps long edge to reduce token cost
}

export interface ExtractedFrame {
  index: number;
  timestamp_seconds: number;
  data: Buffer; // PNG bytes
  base64: string;
}

// PNG signature: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Get video duration in seconds by parsing ffmpeg's stderr output.
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  const ffmpeg = await resolveFfmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg not found");
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ["-i", videoPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", () => {
      const m = stderr.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error("Could not parse video duration"));
      const h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      const s = parseFloat(m[3]);
      resolve(h * 3600 + mm * 60 + s);
    });
  });
}

/**
 * Split a stream of concatenated PNG bytes into individual PNG buffers,
 * using the 8-byte PNG signature as a delimiter. Tolerates signatures
 * that fall across chunk boundaries (data event boundaries).
 */
function splitPngStream(buffers: Buffer[]): Buffer[] {
  const frames: Buffer[] = [];
  let pending = Buffer.alloc(0);
  for (const chunk of buffers) {
    pending = Buffer.concat([pending, chunk]);
    let searchFrom = 8; // skip the leading signature
    while (true) {
      const idx = pending.indexOf(PNG_SIG, searchFrom);
      if (idx === -1) break;
      frames.push(pending.subarray(0, idx));
      pending = pending.subarray(idx);
      searchFrom = 8;
    }
  }
  if (pending.length > 0) frames.push(pending);
  return frames;
}

/**
 * Extract N evenly-spaced frames as PNG buffers in memory.
 * Pipes ffmpeg output to stdout — no disk I/O for frame data.
 */
export async function extractVideoFrames(
  params: ExtractFramesParams,
): Promise<{
  frames: ExtractedFrame[];
  width: number;
  height: number;
  duration_seconds: number;
}> {
  const numFrames = Math.max(1, Math.min(32, params.num_frames ?? 8));
  const scale = params.width ?? 512;
  const duration = await getVideoDuration(params.video_path);

  const stepSeconds = duration / numFrames;
  const fpsFilter = `fps=1/${stepSeconds.toFixed(3)}`;
  const scaleFilter = `scale='min(${scale},iw)':'min(${scale},ih)':force_original_aspect_ratio=decrease`;

  const ffmpeg = await resolveFfmpegPath();
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg not found. Install it, set FFMPEG_PATH, or install ffmpeg-static (npm i ffmpeg-static).",
    );
  }

  // ffmpeg -i <in> -vf <filter> -frames:v N -f image2pipe -vcodec png -
  // image2pipe + '-' writes PNGs concatenated to stdout.
  const args = [
    "-i", params.video_path,
    "-vf", `${fpsFilter},${scaleFilter}`,
    "-frames:v", String(numFrames),
    "-f", "image2pipe",
    "-vcodec", "png",
    "-",
  ];

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (c) => chunks.push(c as Buffer));
    proc.stderr.on("data", () => {
      // ffmpeg logs progress to stderr; ignore unless we fail
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });

  const pngBuffers = splitPngStream(chunks);
  if (pngBuffers.length === 0) {
    throw new Error("ffmpeg produced no frames");
  }
  // If ffmpeg emitted more than requested (rare), truncate.
  const trimmed = pngBuffers.slice(0, numFrames);

  const frames: ExtractedFrame[] = trimmed.map((data, i) => {
    const ts = (i + 0.5) * stepSeconds;
    return {
      index: i,
      timestamp_seconds: Math.round(ts * 10) / 10,
      data,
      base64: data.toString("base64"),
    };
  });

  const { width, height } = parsePngDimensions(frames[0]?.data ?? Buffer.alloc(0));
  return { frames, width, height, duration_seconds: duration };
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  if (buf.toString("ascii", 1, 4) !== "PNG") return { width: 0, height: 0 };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ── Audio extraction ────────────────────────────────────────────────────────

export interface ExtractedAudio {
  data: Buffer;
  base64: string;
  format: string;
}

/**
 * Extract audio from a video file as WAV, piped to stdout — no disk writes.
 * Returns null if the video has no audio stream (ffmpeg exits non-zero or
 * produces empty output).
 */
export async function extractVideoAudio(
  videoPath: string,
): Promise<ExtractedAudio | null> {
  const ffmpeg = await resolveFfmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg not found");

  const args = [
    "-i", videoPath,
    "-vn",               // discard video stream
    "-acodec", "pcm_s16le", // uncompressed WAV (widely compatible)
    "-ar", "16000",      // 16kHz sample rate (good for speech)
    "-ac", "1",          // mono
    "-f", "wav",
    "pipe:1",            // stdout
  ];

  const chunks: Buffer[] = [];
  const exitCode = await new Promise<number>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (c) => chunks.push(c as Buffer));
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0 || chunks.length === 0) return null;

  const data = Buffer.concat(chunks);
  // WAV header minimum is 44 bytes; anything less is likely an error
  if (data.length < 44) return null;

  return {
    data,
    base64: data.toString("base64"),
    format: "wav",
  };
}
