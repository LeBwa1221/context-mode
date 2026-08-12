/**
 * Token estimation — single source of truth for the bytes-to-tokens guess.
 *
 * There is no tokenizer anywhere in this project's dependency tree, and one
 * is not being added here (Anthropic models do not use tiktoken, so a
 * tiktoken-based count would look precise while being wrong for the models
 * this tool targets). CHARS_PER_TOKEN is therefore a rough heuristic, not a
 * measurement: real chars-per-token varies by content type (English prose
 * runs closer to ~4, JSON and Windows paths are denser, minified code and
 * base64 are denser still). Every caller that needs a token figure MUST
 * route through estimateTokens() so the assumption lives in one place
 * instead of being re-guessed at each call site.
 *
 * Bytes are the ground truth everywhere in this codebase; tokens are always
 * a labeled estimate derived from bytes.
 */

/** Rough chars-per-token heuristic. Not a measurement — see module doc. */
export const CHARS_PER_TOKEN = 4;

/** bytes -> estimated token count, floored to a whole token. */
export function estimateTokens(bytes: number): number {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.floor(safe / CHARS_PER_TOKEN);
}

/** bytes -> "~N tokens est. @ 4 chars/token" label for user-facing output. */
export function estimateTokensLabel(bytes: number): string {
  return `~${estimateTokens(bytes).toLocaleString("en-US")} tokens est. @ ${CHARS_PER_TOKEN} chars/token`;
}
