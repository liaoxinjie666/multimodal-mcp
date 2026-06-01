/**
 * File Access Provider
 * Handles: access_file (load local image/audio/video as multimodal content)
 *
 * Mirrors protocol-proxy's access_file tool:
 * - Image: returns base64 in MCP image content block (LLM can see)
 * - Audio: returns base64 in MCP audio content block (LLM can hear, if supported)
 * - Video: MCP protocol has no video content block — copy to OUTPUT_DIR, return path
 * - Document (PDF/DOCX/PPTX/XLSX): delegate to parse_document
 * - Text/code: return as text content
 */

import { readFile, copyFile, stat } from "node:fs/promises";
import { join, extname, basename, resolve } from "node:path";
import { OUTPUT_DIR, writeToOutputDir, ensureOutputDir } from "../utils.js";
import { parseDocument } from "./document-parser.js";
import { mimoVideoAnalyze } from "./mimo.js";
import { extractVideoFrames, extractVideoAudio, ffmpegAvailable } from "./video-frames.js";

// ── Optional path sandbox ────────────────────────────────────────────────────
// Set ALLOWED_DIRS to a semicolon-separated list of directories that access_file
// is allowed to read. Example: "C:\projects;D:\data" or "/home/user/projects"
// If not set, all paths are allowed (original behavior).

function parseAllowedDirs(): string[] | null {
  const raw = process.env.ALLOWED_DIRS;
  if (!raw) return null;
  return raw
    .split(/[;:]/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => resolve(d));
}

const allowedDirs = parseAllowedDirs();

function isPathAllowed(filePath: string): boolean {
  if (!allowedDirs) return true;
  const resolved = resolve(filePath);
  return allowedDirs.some(
    (dir) => resolved === dir || resolved.startsWith(dir + "/") || resolved.startsWith(dir + "\\"),
  );
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const AUDIO_EXTS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);
const DOC_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};
const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_TEXT_BYTES = 10 * 1024 * 1024; // 10MB

export interface AccessFileParams {
  file_path: string;
  question?: string;
  /**
   * Video processing mode.
   * - "auto": try MiMo video analysis (server-side, returns text). Fall back to ffmpeg frames if API fails / no key.
   * - "analyze": force MiMo video analysis (returns text description)
   * - "frames": force ffmpeg frame extraction (returns image content blocks)
   * - "path": just return the file path (least useful; for symmetry with old behavior)
   */
  video_mode?: "auto" | "analyze" | "frames" | "path";
  video_fps?: number; // MiMo analyze mode: 0.1-10, default 2
  video_num_frames?: number; // frames mode: 1-32, default 8
  video_media_resolution?: "default" | "max"; // MiMo analyze mode
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

interface ToolResult {
  [key: string]: unknown;
  content: ContentBlock[];
  isError?: boolean;
}

function textJson(obj: unknown): ContentBlock {
  return { type: "text", text: JSON.stringify(obj) };
}

function errResult(message: string): ToolResult {
  return { content: [textJson({ error: message })], isError: true };
}

/**
 * Returns MCP tool result with content blocks.
 * - Image/Audio: { content: [text, image|audio(base64)] }
 * - Video:       { content: [text(json { file_path })] }  — saved to OUTPUT_DIR
 * - Text:        { content: [text] }
 * - Error:       { content: [text], isError: true }
 */
export async function accessFile(params: AccessFileParams): Promise<ToolResult> {
  if (!params.file_path) return errResult("file_path is required");

  if (!isPathAllowed(params.file_path)) {
    return errResult(`Access denied: ${params.file_path} is outside ALLOWED_DIRS`);
  }

  let resolved: string;
  try {
    await stat(params.file_path);
    resolved = params.file_path;
  } catch {
    return errResult(`File not found: ${params.file_path}`);
  }

  const st = await stat(resolved);
  const ext = extname(resolved).toLowerCase();
  const fileName = basename(resolved);
  const fileSizeKb = (st.size / 1024).toFixed(0);
  const fileSizeMb = (st.size / 1024 / 1024).toFixed(1);

  // ── Image ────────────────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    if (st.size > MAX_IMAGE_BYTES) {
      return errResult(`Image too large (${fileSizeMb}MB), limit 20MB`);
    }
    const mime = IMAGE_MIME[ext] ?? "image/png";
    const data = (await readFile(resolved)).toString("base64");
    const textPart = params.question
      ? `User question: ${params.question}`
      : `Loaded image: ${fileName} (${fileSizeKb}KB)`;
    return {
      content: [
        { type: "text", text: textPart },
        { type: "image", data, mimeType: mime },
      ],
    };
  }

  // ── Audio ────────────────────────────────────────────────────────────────
  if (AUDIO_EXTS.has(ext)) {
    if (st.size > MAX_AUDIO_BYTES) {
      return errResult(`Audio too large (${fileSizeMb}MB), limit 25MB`);
    }
    const mime = AUDIO_MIME[ext] ?? "audio/mpeg";
    const data = (await readFile(resolved)).toString("base64");
    const textPart = params.question
      ? `User question: ${params.question}`
      : `Loaded audio: ${fileName} (${fileSizeKb}KB)`;
    return {
      content: [
        { type: "text", text: textPart },
        { type: "audio", data, mimeType: mime },
      ],
    };
  }

  // ── Video ────────────────────────────────────────────────────────────────
  // Three modes:
  //   analyze: send video to MiMo (mimo-v2.5), get text description
  //   frames:  ffmpeg extract N PNG frames, return as image content blocks
  //   path:    copy to OUTPUT_DIR, return path only (least useful)
  //   auto:    analyze first, fall back to frames on failure
  if (VIDEO_EXTS.has(ext)) {
    const mode = params.video_mode ?? "auto";
    const mime = VIDEO_MIME[ext] ?? "video/mp4";

    if (mode === "path") {
      await ensureOutputDir();
      const outName = `access_video_${Date.now()}${ext}`;
      const outPath = join(OUTPUT_DIR, outName);
      await copyFile(resolved, outPath);
      return {
        content: [
          textJson({
            success: true,
            file: outPath,
            file_name: outName,
            size_bytes: st.size,
            mime,
            mode: "path",
            note: "MCP protocol has no video content block; file saved to disk, model cannot see it directly",
          }),
        ],
      };
    }

    if (mode === "analyze" || mode === "auto") {
      const result = await mimoVideoAnalyze({
        video_path: resolved,
        question: params.question,
        fps: params.video_fps,
        media_resolution: params.video_media_resolution,
      });
      if ((result as { error?: string }).error) {
        if (mode === "auto") {
          // fall through to frames below
        } else {
          return errResult((result as { error: string }).error);
        }
      } else {
        const r = result as { description: string; usage?: unknown };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                mode: "analyze",
                file: fileName,
                size_bytes: st.size,
                mime,
                description: r.description,
                usage: r.usage,
              }),
            },
          ],
        };
      }
    }

    // mode === "frames" OR auto fell through
    const haveFfmpeg = await ffmpegAvailable();
    if (!haveFfmpeg) {
      return errResult(
        "video_mode=frames requires ffmpeg (set FFMPEG_PATH or install ffmpeg-static); MiMo analyze also failed.",
      );
    }

    // Extract frames and audio in parallel
    const [{ frames, width, height, duration_seconds }, audio] = await Promise.all([
      extractVideoFrames({
        video_path: resolved,
        num_frames: params.video_num_frames,
      }),
      extractVideoAudio(resolved).catch(() => null),
    ]);

    const hasAudio = audio !== null;
    const frameTimestamps = frames.map((f) => `${f.timestamp_seconds.toFixed(1)}s`).join(", ");
    const intro = [
      `Extracted ${frames.length} frames from video ${fileName} (${width}x${height}, duration ${duration_seconds.toFixed(1)}s)`,
      hasAudio ? `with full audio (16kHz WAV)` : "",
      `Frame timestamps: [${frameTimestamps}]`,
      `Each image corresponds to its timestamp in the audio timeline.`,
      params.question ? `User question: ${params.question}` : "",
    ].filter(Boolean).join(". ");

    const content: ContentBlock[] = [
      { type: "text", text: intro },
      ...frames.map((f) => ({
        type: "image" as const,
        data: f.base64,
        mimeType: "image/png",
      })),
    ];

    if (hasAudio) {
      content.push({
        type: "audio",
        data: audio.base64,
        mimeType: "audio/wav",
      });
    }

    return { content };
  }

  // ── Document (delegate) ──────────────────────────────────────────────────
  if (DOC_EXTS.has(ext)) {
    return await parseDocument({ file_path: resolved });
  }

  // ── Text / code ──────────────────────────────────────────────────────────
  if (st.size > MAX_TEXT_BYTES) {
    return errResult(`File too large (${fileSizeMb}MB), limit 10MB`);
  }
  const text = await readFile(resolved, "utf8");
  const lineCount = text.split("\n").length;
  return {
    content: [
      textJson({
        text,
        line_count: lineCount,
        file: fileName,
        size: st.size,
      }),
    ],
  };
}
