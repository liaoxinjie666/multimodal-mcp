/**
 * MiMo / OpenAI-compatible API Configuration
 *
 * Shared config for all providers that call MiMo-compatible APIs.
 * Supports both MiMo's native "api-key" header and standard "Bearer" auth.
 */

export const MIMO_BASE_URL =
  process.env.MIMO_BASE_URL ?? "https://api.xiaomimimo.com/v1";

export const MIMO_API_KEY = process.env.MIMO_API_KEY ?? "";

const AUTH_TYPE = (process.env.MIMO_AUTH_TYPE ?? "api-key").toLowerCase();

export function mimoHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TYPE === "bearer") {
    h["Authorization"] = `Bearer ${MIMO_API_KEY}`;
  } else {
    h["api-key"] = MIMO_API_KEY;
  }
  return h;
}
