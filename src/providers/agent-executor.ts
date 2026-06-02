/**
 * Agent Executor Provider
 * Handles: agent_execute (multi-turn sub-agent with MiMo as thinking engine)
 *
 * Architecture: MCP is zero-tool — this provider NEVER executes tool_calls.
 * It only sends multimodal content + tool definitions to MiMo and returns
 * the tool_calls for the calling agent to execute. Multi-turn is managed
 * via conversation state stored in memory.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  IMAGE_EXTS,
  AUDIO_EXTS,
  VIDEO_EXTS,
  DOC_EXTS,
  IMAGE_MIME,
  AUDIO_MIME,
  VIDEO_MIME,
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_TEXT_BYTES,
  isPathAllowed,
} from "./file-access.js";
import { parseDocument } from "./document-parser.js";
import { MIMO_BASE_URL, MIMO_API_KEY, mimoHeaders } from "./mimo-config.js";

// ── Config ─────────────────────────────────────────────────────────────────

const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONVERSATIONS = 100;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds
const MAX_VIDEO_BASE64_BYTES = 50 * 1024 * 1024; // 50MB (matches mimo.ts)

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentExecuteParams {
  content_path?: string;
  content_text?: string;
  tools: AgentToolDefinition[];
  system_prompt?: string;
  user_prompt: string;
  conversation_id?: string;
  tool_results?: Array<{
    tool_call_id: string;
    tool_name: string;
    result: string;
    error?: string;
  }>;
  max_rounds?: number;
  model?: string;
}

export interface AgentExecuteResult {
  conversation_id: string;
  status: "tool_calls" | "completed" | "error";
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  result?: string;
  round: number;
  usage?: Record<string, unknown>;
  error?: string;
}

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface ConversationState {
  id: string;
  messages: ConversationMessage[];
  tools: AgentToolDefinition[];
  model: string;
  round: number;
  created_at: number;
  last_active: number;
}

interface MimoChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: Record<string, unknown>;
}

// ── Conversation Store ─────────────────────────────────────────────────────

const conversations = new Map<string, ConversationState>();
let cleanupStarted = false;

function startCleanupIfNeeded() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, conv] of conversations) {
      if (now - conv.last_active > CONVERSATION_TTL_MS) {
        conversations.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
}

function createConversation(
  tools: AgentToolDefinition[],
  model: string,
  messages: ConversationMessage[],
): ConversationState {
  if (conversations.size >= MAX_CONVERSATIONS) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, conv] of conversations) {
      if (conv.created_at < oldestTime) {
        oldestTime = conv.created_at;
        oldest = id;
      }
    }
    if (oldest) conversations.delete(oldest);
  }

  const now = Date.now();
  const state: ConversationState = {
    id: randomUUID(),
    messages,
    tools,
    model,
    round: 0,
    created_at: now,
    last_active: now,
  };
  conversations.set(state.id, state);
  return state;
}

// ── Content Loading ────────────────────────────────────────────────────────

async function loadContentAsBlocks(
  contentPath?: string,
  contentText?: string,
): Promise<{ contentBlocks?: Array<Record<string, unknown>>; error?: string }> {
  if (contentText) {
    return { contentBlocks: [{ type: "text", text: contentText }] };
  }

  if (!contentPath) {
    return { error: "Either content_path or content_text is required" };
  }

  if (!isPathAllowed(contentPath)) {
    return { error: `Path not allowed: ${contentPath}` };
  }

  const ext = extname(contentPath).toLowerCase();

  // Image
  if (IMAGE_EXTS.has(ext)) {
    const buf = await readFile(contentPath);
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        error: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB), limit 20MB`,
      };
    }
    const mime = IMAGE_MIME[ext] ?? "image/png";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    return {
      contentBlocks: [
        {
          type: "image_url",
          image_url: { url: dataUrl },
        },
      ],
    };
  }

  // Audio
  if (AUDIO_EXTS.has(ext)) {
    const buf = await readFile(contentPath);
    if (buf.length > MAX_AUDIO_BYTES) {
      return {
        error: `Audio too large (${(buf.length / 1024 / 1024).toFixed(1)}MB), limit 25MB`,
      };
    }
    const mime = AUDIO_MIME[ext] ?? "audio/mpeg";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    return {
      contentBlocks: [
        {
          type: "input_audio",
          input_audio: {
            data: buf.toString("base64"),
            format: ext === ".mp3" ? "mp3" : ext.slice(1),
          },
        },
      ],
    };
  }

  // Video
  if (VIDEO_EXTS.has(ext)) {
    const buf = await readFile(contentPath);
    if (buf.length > MAX_VIDEO_BASE64_BYTES) {
      return {
        error: `Video too large (${(buf.length / 1024 / 1024).toFixed(1)}MB), limit 50MB`,
      };
    }
    const mime = VIDEO_MIME[ext] ?? "video/mp4";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    return {
      contentBlocks: [
        {
          type: "video_url",
          video_url: { url: dataUrl },
          fps: 2,
          media_resolution: "default",
        },
      ],
    };
  }

  // Document
  if (DOC_EXTS.has(ext)) {
    const result = await parseDocument({ file_path: contentPath });
    const textBlock = result.content?.find(
      (b: { type: string }) => b.type === "text",
    );
    const text = textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "";
    return { contentBlocks: [{ type: "text", text }] };
  }

  // Text / code / other
  const buf = await readFile(contentPath);
  if (buf.length > MAX_TEXT_BYTES) {
    return {
      error: `File too large (${(buf.length / 1024 / 1024).toFixed(1)}MB), limit 10MB`,
    };
  }
  return { contentBlocks: [{ type: "text", text: buf.toString("utf8") }] };
}

// ── MiMo API Call ──────────────────────────────────────────────────────────

async function callMimo(params: {
  model: string;
  messages: ConversationMessage[];
  tools: AgentToolDefinition[];
}): Promise<{
  response?: MimoChatCompletionResponse;
  error?: string;
}> {
  if (!MIMO_API_KEY) {
    return { error: "MIMO_API_KEY not set" };
  }

  const body = {
    model: params.model,
    messages: params.messages,
    tools:
      params.tools.length > 0
        ? params.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined,
    tool_choice: params.tools.length > 0 ? ("auto" as const) : undefined,
    max_completion_tokens: 4096,
  };

  const resp = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: mimoHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });

  if (!resp.ok) {
    return {
      error: `MiMo API error (${resp.status}): ${await resp.text()}`,
    };
  }

  const data = (await resp.json()) as MimoChatCompletionResponse;
  return { response: data };
}

// ── Main Export ────────────────────────────────────────────────────────────

export async function agentExecute(
  params: AgentExecuteParams,
): Promise<AgentExecuteResult> {
  startCleanupIfNeeded();

  // Validate
  if (!params.conversation_id && !params.content_path && !params.content_text) {
    return {
      conversation_id: "",
      status: "error",
      round: 0,
      error: "Either content_path, content_text, or conversation_id is required",
    };
  }

  if (params.tool_results && !params.conversation_id) {
    return {
      conversation_id: "",
      status: "error",
      round: 0,
      error: "tool_results requires conversation_id (continue an existing conversation)",
    };
  }

  const maxRounds = Math.max(1, Math.min(20, params.max_rounds ?? 10));
  const model = params.model ?? "mimo-v2.5";

  let conv: ConversationState;

  if (params.conversation_id) {
    // Continue existing conversation
    const existing = conversations.get(params.conversation_id);
    if (!existing) {
      return {
        conversation_id: params.conversation_id,
        status: "error",
        round: 0,
        error: `Conversation not found: ${params.conversation_id}. It may have expired (TTL: 30 minutes).`,
      };
    }
    conv = existing;
    conv.last_active = Date.now();

    // Check round limit
    if (conv.round >= maxRounds) {
      return {
        conversation_id: conv.id,
        status: "completed",
        round: conv.round,
        result: `[Conversation ended: max rounds (${maxRounds}) reached]`,
      };
    }

    // Append tool results as tool role messages
    if (params.tool_results) {
      for (const tr of params.tool_results) {
        conv.messages.push({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          name: tr.tool_name,
          content: tr.error
            ? JSON.stringify({ error: tr.error })
            : tr.result,
        });
      }
    }

    // Allow updating tools mid-conversation
    if (params.tools && params.tools.length > 0) {
      conv.tools = params.tools;
    }
  } else {
    // New conversation
    const { contentBlocks, error } = await loadContentAsBlocks(
      params.content_path,
      params.content_text,
    );
    if (error) {
      return {
        conversation_id: "",
        status: "error",
        round: 0,
        error,
      };
    }

    const messages: ConversationMessage[] = [];

    // System prompt
    if (params.system_prompt) {
      messages.push({ role: "system", content: params.system_prompt });
    }

    // User message with content + prompt
    const userContent: Array<Record<string, unknown>> = [
      ...(contentBlocks ?? []),
      { type: "text", text: params.user_prompt },
    ];
    messages.push({ role: "user", content: userContent });

    conv = createConversation(params.tools, model, messages);
  }

  // Call MiMo
  const { response, error: apiError } = await callMimo({
    model: conv.model,
    messages: conv.messages,
    tools: conv.tools,
  });

  if (apiError) {
    return {
      conversation_id: conv.id,
      status: "error",
      round: conv.round,
      error: apiError,
    };
  }

  if (!response?.choices?.[0]?.message) {
    return {
      conversation_id: conv.id,
      status: "error",
      round: conv.round,
      error: "Empty response from MiMo API",
      usage: response?.usage,
    };
  }

  const message = response.choices[0].message;

  // Append assistant message to conversation
  conv.messages.push({
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
  });
  conv.round++;
  conv.last_active = Date.now();

  // Check if MiMo returned tool_calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls = message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseJsonSafe(tc.function.arguments),
    }));

    return {
      conversation_id: conv.id,
      status: "tool_calls",
      tool_calls: toolCalls,
      round: conv.round,
      usage: response?.usage,
    };
  }

  // Completed (no tool_calls)
  return {
    conversation_id: conv.id,
    status: "completed",
    result: message.content ?? "",
    round: conv.round,
    usage: response?.usage,
  };
}

function parseJsonSafe(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}
