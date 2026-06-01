/**
 * Document Parser Provider
 * Handles: parse_document (PDF / DOCX / PPTX / XLSX)
 *
 * Mirrors protocol-proxy's parse_document:
 * - PDF: pdfjs-dist per-page text extraction
 * - Office (DOCX/PPTX/XLSX): JSZip unpack, extract XML text + embedded media
 *   - Supported images (png/jpg/jpeg/gif/bmp/webp): return as base64 inline
 *   - Audio/Video: save to OUTPUT_DIR, return as media list
 *   - Unsupported image formats (emf/wmf/tif/tiff/svg): save to OUTPUT_DIR + flag
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import JSZip from "jszip";

// pdfjs-dist v4 is ESM-only. Use legacy build for Node.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const OUTPUT_DIR =
  process.env.OUTPUT_DIR ?? String.raw`C:\zhenghuo\Python\skills\generated`;

await mkdir(OUTPUT_DIR, { recursive: true });

const SUPPORTED_IMG = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
]);
const UNSUPPORTED_IMG = new Set(["emf", "wmf", "tif", "tiff", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "wmv", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "aac"]);

const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

export interface ParseDocumentParams {
  file_path: string;
}

interface MediaItem {
  name: string;
  file_path: string;
  type: "image" | "video" | "audio";
  size_bytes?: number;
}

interface InlineImage {
  name: string;
  base64_data: string;
  mime: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function jsonError(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function jsonOk(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

// Strip XML tags, collapse whitespace — used for Office text extraction.
function stripXml(xml: string, ext: string): string {
  const clean = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (ext === "pptx") return clean + "\n\n---\n\n";
  return (
    clean.replace(/<\/w:p>/g, "\n").replace(/<\/w:tr>/g, "\n") + "\n"
  );
}

async function extractPdf(filePath: string) {
  const data = new Uint8Array(await readFile(filePath));
  const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text +=
      content.items
        .map((it) => ("str" in it ? (it as { str: string }).str : ""))
        .join(" ") + "\n\n";
  }
  return { text: text.trim(), images: [] as InlineImage[], media: [] as MediaItem[], pages: pdf.numPages };
}

async function extractOffice(filePath: string, ext: string) {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const config = {
    docx: { textFiles: ["word/document.xml"], mediaDir: "word/media/" },
    pptx: { textFiles: ["ppt/slides/slide*.xml"], mediaDir: "ppt/media/" },
    xlsx: { textFiles: ["xl/sharedStrings.xml"], mediaDir: "xl/media/" },
  }[ext];
  if (!config) throw new Error(`不支持的格式: ${ext}`);

  const images: InlineImage[] = [];
  const media: MediaItem[] = [];
  const unsupported: Array<{ name: string; format: string; file_path: string }> = [];

  // Pull embedded media
  for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
    if (!entryPath.startsWith(config.mediaDir) || zipEntry.dir) continue;
    const mediaExt = extname(entryPath).toLowerCase().slice(1);
    const name = basename(entryPath);
    const data = await zipEntry.async("base64");
    const buf = Buffer.from(data, "base64");

    if (SUPPORTED_IMG.has(mediaExt)) {
      images.push({
        name,
        base64_data: data,
        mime: IMG_MIME[mediaExt] ?? "image/png",
      });
    } else if (VIDEO_EXTS.has(mediaExt) || AUDIO_EXTS.has(mediaExt)) {
      const outName = `parsed_${name}`;
      const outPath = join(OUTPUT_DIR, outName);
      await writeFile(outPath, buf);
      media.push({
        name,
        file_path: outPath,
        type: VIDEO_EXTS.has(mediaExt) ? "video" : "audio",
        size_bytes: buf.length,
      });
    } else if (UNSUPPORTED_IMG.has(mediaExt)) {
      const outName = `parsed_${name}`;
      const outPath = join(OUTPUT_DIR, outName);
      await writeFile(outPath, buf);
      unsupported.push({ name, format: mediaExt, file_path: outPath });
    }
  }

  // Pull text
  let text = "";
  for (const pattern of config.textFiles) {
    const regex = pattern.includes("*")
      ? new RegExp("^" + pattern.replace("*", "[^/]+") + "$")
      : null;
    for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
      const match = regex ? regex.test(entryPath) : entryPath === pattern;
      if (!match) continue;
      const xml = await zipEntry.async("text");
      text += stripXml(xml, ext);
    }
  }

  const result: Record<string, unknown> = {
    text: text.trim(),
    images,
    media,
  };
  if (unsupported.length > 0) {
    result.unsupported = unsupported;
    result.hint = `发现 ${unsupported.length} 张不支持的图片格式（${unsupported.map((u) => u.format).join(", ")}），已保存到 OUTPUT_DIR;可通过 access_file 加载后再让模型分析`;
  }
  return result;
}

export async function parseDocument(params: ParseDocumentParams) {
  if (!params.file_path) return jsonError("file_path 必填");

  let st;
  try {
    st = await stat(params.file_path);
  } catch {
    return jsonError(`文件不存在: ${params.file_path}`);
  }

  const ext = extname(params.file_path).toLowerCase().slice(1);

  try {
    if (ext === "pdf") {
      const result = await extractPdf(params.file_path);
      return jsonOk({ ...result, file: basename(params.file_path), size_bytes: st.size });
    }
    if (ext === "docx" || ext === "pptx" || ext === "xlsx") {
      const result = await extractOffice(params.file_path, ext);
      return jsonOk({ ...result, file: basename(params.file_path), size_bytes: st.size });
    }
    return jsonError(`不支持的文件格式: ${ext}。支持 PDF、DOCX、PPTX、XLSX`);
  } catch (err) {
    return jsonError(`解析 ${params.file_path} 失败: ${(err as Error).message}`);
  }
}
