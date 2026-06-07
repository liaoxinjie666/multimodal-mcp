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

import { readFile, writeFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import JSZip from "jszip";
import { OUTPUT_DIR, ensureOutputDir } from "../utils.js";

// pdfjs-dist v4 is ESM-only. Use legacy build for Node.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

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
  if (ext === "pptx") {
    return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\n\n---\n\n";
  }
  // DOCX: replace self-closing break/newline tags first, then paragraph/row-ending tags
  const withBr = xml
    .replace(/<w:br\/>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n");
  return withBr.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\n";
}

// ── DOCX structured parsing ──────────────────────────────────────────────

/** Parse styles.xml → map of styleId → outlineLevel (0-8), only for heading styles */
function parseDocxStyles(stylesXml: string): Map<string, number> {
  const map = new Map<string, number>();
  const styleBlocks = stylesXml.match(/<w:style [^>]*>[\s\S]*?<\/w:style>/g) ?? [];
  for (const block of styleBlocks) {
    const idMatch = block.match(/w:styleId="([^"]+)"/);
    if (!idMatch) continue;
    const outlineMatch = block.match(/<w:outlineLvl w:val="(\d+)"/);
    if (outlineMatch) {
      map.set(idMatch[1], parseInt(outlineMatch[1], 10));
    }
  }
  return map;
}

/**
 * Parse numbering.xml → map of numId → { ilvl → formatTemplate }.
 * Format template uses %N placeholders (e.g. "%1.%2.%3.%4").
 */
function parseDocxNumbering(numberingXml: string): Map<string, Map<number, string>> {
  // abstractNumId → (ilvl → format)
  const abstractNums = new Map<string, Map<number, string>>();
  const absBlocks = numberingXml.match(/<w:abstractNum[^>]*>[\s\S]*?<\/w:abstractNum>/g) ?? [];
  for (const block of absBlocks) {
    const idMatch = block.match(/w:abstractNumId="(\d+)"/);
    if (!idMatch) continue;
    const levels = new Map<number, string>();
    const lvlBlocks = block.match(/<w:lvl [^>]*>[\s\S]*?<\/w:lvl>/g) ?? [];
    for (const lvl of lvlBlocks) {
      const ilvlMatch = lvl.match(/w:ilvl="(\d+)"/);
      const textMatch = lvl.match(/<w:lvlText w:val="([^"]*?)"/);
      if (ilvlMatch && textMatch) {
        levels.set(parseInt(ilvlMatch[1], 10), textMatch[1]);
      }
    }
    abstractNums.set(idMatch[1], levels);
  }

  // numId → abstractNumId mapping
  const numToAbstract = new Map<string, string>();
  const numMappings = numberingXml.matchAll(/<w:num w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"/g);
  for (const m of numMappings) {
    numToAbstract.set(m[1], m[2]);
  }

  // Build final map: numId → (ilvl → format)
  const result = new Map<string, Map<number, string>>();
  for (const [numId, absId] of numToAbstract) {
    const abs = abstractNums.get(absId);
    if (abs) result.set(numId, abs);
  }
  return result;
}

/** Replace %1..%N placeholders in a format template with actual counter values */
function computeSectionNumber(template: string, counters: number[]): string {
  return template.replace(/%(\d+)/g, (_match, numStr) => {
    const idx = parseInt(numStr, 10) - 1; // %1 → index 0
    return idx >= 0 && idx < counters.length ? String(counters[idx]) : "0";
  });
}

/**
 * Extract structured text from DOCX document.xml.
 * Headings get markdown # prefixes with computed section numbers.
 * Tables use markdown pipe syntax.
 */
function extractDocxText(
  documentXml: string,
  styles: Map<string, number>,
  numbering: Map<string, Map<number, string>>,
): string {
  const lines: string[] = [];

  // Counters for each outline level (0-8), for computing section numbers
  const counters = new Array(9).fill(0);

  // Split body content into paragraphs and tables
  // Process <w:tbl> and <w:p> in document order
  const bodyMatch = documentXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) return stripXml(documentXml, "docx");
  const body = bodyMatch[1];

  // Tokenize: split into paragraph and table chunks, preserving order
  const chunks: Array<{ type: "p" | "tbl"; xml: string }> = [];
  const tokenRe = /(<w:p[\s>][\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    const xml = m[1];
    chunks.push({
      type: xml.startsWith("<w:tbl") ? "tbl" : "p",
      xml,
    });
  }

  for (const chunk of chunks) {
    if (chunk.type === "tbl") {
      lines.push(extractDocxTable(chunk.xml));
      continue;
    }

    // Paragraph processing
    const pXml = chunk.xml;

    // Extract pStyle
    const styleMatch = pXml.match(/<w:pStyle w:val="([^"]+)"/);
    const styleId = styleMatch?.[1];
    const outlineLevel = styleId ? styles.get(styleId) : undefined;

    // Extract numPr (numId + ilvl)
    const numPrMatch = pXml.match(/<w:numPr>[\s\S]*?<\/w:numPr>/);
    let numId: string | undefined;
    let ilvl: number | undefined;
    if (numPrMatch) {
      const numIdMatch = numPrMatch[0].match(/<w:numId w:val="(\d+)"/);
      const ilvlMatch = numPrMatch[0].match(/<w:ilvl w:val="(\d+)"/);
      if (numIdMatch && numIdMatch[1] !== "0") numId = numIdMatch[1];
      if (ilvlMatch) ilvl = parseInt(ilvlMatch[1], 10);
    }

    // Extract text content (preserve line breaks and tabs)
    const text = extractParagraphText(pXml);
    if (!text.trim()) continue;

    // Determine heading level: use ONLY style outlineLevel for heading detection.
    // numPr ilvl is NOT used for detection — it's for list nesting, not heading levels.
    const headingLevel = outlineLevel;

    if (headingLevel !== undefined && headingLevel >= 0 && headingLevel <= 8) {
      // This is a heading — update counters
      counters[headingLevel]++;
      // Reset all deeper level counters
      for (let i = headingLevel + 1; i < 9; i++) counters[i] = 0;

      // Compute section number
      let sectionNum: string;
      const numFormats = numId ? numbering.get(numId) : undefined;
      if (numFormats) {
        // Use the format template for this heading level
        const template = numFormats.get(headingLevel);
        sectionNum = template ? computeSectionNumber(template, counters) : "";
      } else {
        // Fallback: generate from counters up to current level
        sectionNum = counters.slice(0, headingLevel + 1).join(".");
      }

      // Generate markdown heading prefix (cap at 6 for markdown)
      const hashLevel = Math.min(headingLevel + 1, 6);
      const hashes = "#".repeat(hashLevel);
      const prefix = sectionNum ? `${sectionNum} ` : "";
      lines.push(`${hashes} ${prefix}${text}`);
    } else {
      // Regular paragraph
      lines.push(text);
    }
  }

  return lines.join("\n") + "\n";
}

/** Extract text from a single <w:p> element, preserving breaks/tabs */
function extractParagraphText(pXml: string): string {
  let result = "";
  // Process runs and breaks in order
  const tokenRe = /<w:br\/>|<w:tab\/>|<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(pXml)) !== null) {
    if (m[0] === "<w:br/>") {
      result += "\n";
    } else if (m[0] === "<w:tab/>") {
      result += "\t";
    } else if (m[1] !== undefined) {
      result += m[1];
    }
  }
  return result.trim();
}

/** Extract a DOCX table as markdown pipe syntax */
function extractDocxTable(tblXml: string): string {
  const rows: string[] = [];
  const rowMatches = tblXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? [];
  for (const rowXml of rowMatches) {
    const cells: string[] = [];
    const cellMatches = rowXml.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? [];
    for (const cellXml of cellMatches) {
      // Extract all paragraph text within the cell
      const paraMatches = cellXml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
      const cellText = paraMatches.map((p) => extractParagraphText(p)).join(" ").trim();
      cells.push(cellText.replace(/\|/g, "\\|") || " ");
    }
    rows.push(`| ${cells.join(" | ")} |`);
  }

  if (rows.length === 0) return "";
  if (rows.length === 1) return rows[0];

  // Insert header separator after first row
  const colCount = (rows[0].match(/\|/g)?.length ?? 2) - 1;
  const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;
  rows.splice(1, 0, separator);
  return rows.join("\n");
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
  if (!config) throw new Error(`Unsupported format: ${ext}`);

  const images: InlineImage[] = [];
  const media: MediaItem[] = [];
  const unsupported: Array<{ name: string; format: string; file_path: string }> = [];

  // Pull embedded media
  await ensureOutputDir();
  for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
    if (!entryPath.startsWith(config.mediaDir) || zipEntry.dir) continue;
    const mediaExt = extname(entryPath).toLowerCase().slice(1);
    const name = basename(entryPath);
    // Sanitize: skip entries with path traversal chars
    if (name.includes("..") || name.includes("/") || name.includes("\\")) continue;
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
  if (ext === "docx") {
    // Structured DOCX extraction: read styles + numbering for heading hierarchy
    const stylesXml = zip.file("word/styles.xml") ? await zip.file("word/styles.xml")!.async("text") : "";
    const numberingXml = zip.file("word/numbering.xml") ? await zip.file("word/numbering.xml")!.async("text") : "";
    const styles = stylesXml ? parseDocxStyles(stylesXml) : new Map<string, number>();
    const numbering = numberingXml ? parseDocxNumbering(numberingXml) : new Map<string, Map<number, string>>();

    for (const pattern of config.textFiles) {
      const regex = pattern.includes("*")
        ? new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "[^/]+") + "$")
        : null;
      for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
        const match = regex ? regex.test(entryPath) : entryPath === pattern;
        if (!match) continue;
        const xml = await zipEntry.async("text");
        text += extractDocxText(xml, styles, numbering);
      }
    }
  } else {
    for (const pattern of config.textFiles) {
      const regex = pattern.includes("*")
        ? new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "[^/]+") + "$")
        : null;
      for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
        const match = regex ? regex.test(entryPath) : entryPath === pattern;
        if (!match) continue;
        const xml = await zipEntry.async("text");
        text += stripXml(xml, ext);
      }
    }
  }

  const result: Record<string, unknown> = {
    text: text.trim(),
    images,
    media,
  };
  if (unsupported.length > 0) {
    result.unsupported = unsupported;
    result.hint = `Found ${unsupported.length} unsupported image(s) (${unsupported.map((u) => u.format).join(", ")}), saved to OUTPUT_DIR; use access_file to load them`;
  }
  return result;
}

export async function parseDocument(params: ParseDocumentParams) {
  if (!params.file_path) return jsonError("file_path is required");

  let st;
  try {
    st = await stat(params.file_path);
  } catch {
    return jsonError(`File not found: ${params.file_path}`);
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
    return jsonError(`Unsupported file format: ${ext}. Supported: PDF, DOCX, PPTX, XLSX`);
  } catch (err) {
    return jsonError(`Failed to parse ${params.file_path}: ${(err as Error).message}`);
  }
}
