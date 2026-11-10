/**
 * The App Builder planner's reply, read whatever shape a provider gives it
 * (new-user test V8, item 4: Cortex through SQL failed 3 of 3 times with
 * "did not return valid JSON for the build brief").
 *
 * A model asked for "JSON only" still answers in several shapes: the object
 * alone; the object in a ```json fence; a sentence before or after it (with
 * braces of its own); the object as a JSON-encoded string; trailing commas
 * or comments; the brief wrapped in `{ "brief": … }`; or the object cut off
 * at the token limit. Each is read here. A reply cut off is closed after its
 * last complete value and marked `truncated`, so the caller can say so.
 *
 * Pure: no provider call, no I/O. Only plain JSON values come back; nothing
 * read here is executed.
 */

export interface PlannerJsonRead {
  value: Record<string, unknown>;
  /** The reply was cut off; it was closed after its last complete value. */
  truncated: boolean;
}

const BRIEF_KEYS = ['frame', 'requirements', 'components', 'pages'];
const WRAPPER_KEYS = ['brief', 'buildBrief', 'build_brief', 'appBuildBrief', 'plan', 'result', 'output', 'response', 'data'];
const MAX_CANDIDATES = 40;

/** Read the build brief object from a planner reply, or undefined when none can be read. */
export function readPlannerJson(raw: string | undefined): PlannerJsonRead | undefined {
  const text = (raw ?? '').replace(/^﻿/, '').trim();
  if (!text) return undefined;
  let fallback: Record<string, unknown> | undefined;
  for (const candidate of candidates(text)) {
    const value = parseObject(candidate);
    if (!value) continue;
    if (looksLikeBrief(value)) return { value, truncated: false };
    fallback ??= value;
  }
  // Cut off at the token limit: close the first object after its last complete value.
  const start = text.indexOf('{');
  if (start >= 0) {
    const closed = closeTruncatedJson(stripFence(text.slice(start)));
    const value = closed ? parseObject(closed) : undefined;
    if (value && looksLikeBrief(value)) return { value, truncated: true };
  }
  return fallback ? { value: fallback, truncated: false } : undefined;
}

function looksLikeBrief(value: Record<string, unknown>): boolean {
  return BRIEF_KEYS.some((key) => key in value);
}

/** The texts worth parsing, most likely first: the whole reply, fenced blocks, then each balanced object. */
function* candidates(text: string): Generator<string> {
  yield text;
  const fence = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    if (match[1]?.trim()) yield match[1].trim();
  }
  let tried = 0;
  for (let index = text.indexOf('{'); index >= 0 && tried < MAX_CANDIDATES; index = text.indexOf('{', index + 1)) {
    const end = matchingBrace(text, index);
    if (end < 0) continue;
    tried += 1;
    yield text.slice(index, end + 1);
  }
}

/** A fence opened and never closed (the reply was cut off inside it). */
function stripFence(text: string): string {
  return text.replace(/```\s*$/, '');
}

/** The index of the brace that closes the object opening at `start`, string-aware; -1 when it never closes. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** One candidate as a plain object: strict JSON, then with comments and trailing commas removed. */
function parseObject(candidate: string, depth = 0): Record<string, unknown> | undefined {
  const parsed = tryParse(candidate) ?? tryParse(lenient(candidate));
  if (typeof parsed === 'string' && depth === 0) {
    // The reply was the brief as a JSON-encoded string.
    const inner = parsed.trim();
    return inner.startsWith('{') || inner.startsWith('```') ? readPlannerJson(inner)?.value : undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!looksLikeBrief(record)) {
    for (const key of WRAPPER_KEYS) {
      const inner = record[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && looksLikeBrief(inner as Record<string, unknown>)) {
        return inner as Record<string, unknown>;
      }
      if (typeof inner === 'string' && depth === 0) {
        const unwrapped = parseObject(inner, depth + 1);
        if (unwrapped && looksLikeBrief(unwrapped)) return unwrapped;
      }
    }
  }
  return record;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Remove `//` and `/* *\/` comments and trailing commas, outside strings. */
function lenient(text: string): string {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1];
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Close a JSON object cut off mid-way: keep everything up to the last
 * complete value, drop the partial member after it, and close every open
 * array and object. Undefined when the text does not start an object.
 */
export function closeTruncatedJson(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined;
  const stack: string[] = [];
  let inString = false;
  // The end of the last complete value inside a container, and the containers open there.
  let safeEnd = -1;
  let safeStack: string[] = [];
  const markSafe = (end: number) => {
    safeEnd = end;
    safeStack = [...stack];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') {
        inString = false;
        // A complete string inside an array is a complete value.
        if (stack[stack.length - 1] === '[') markSafe(index + 1);
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char);
      markSafe(index + 1);
    } else if (char === '}' || char === ']') {
      stack.pop();
      if (stack.length === 0) return text.slice(0, index + 1);
      markSafe(index + 1);
    } else if (char === ',') {
      markSafe(index);
    } else if (/[0-9el]/.test(char) && /[,}\]\s]/.test(text[index + 1] ?? '') && stack[stack.length - 1] === '[') {
      // The end of a number, true, false or null inside an array (one at the
      // very end of the text may itself be cut off, so it is not counted).
      markSafe(index + 1);
    }
  }
  if (safeEnd < 0) return undefined;
  let body = text.slice(0, safeEnd).replace(/,\s*$/, '');
  // A dangling `"key":` with no value yet.
  body = body.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '');
  const closers = [...safeStack].reverse().map((open) => (open === '{' ? '}' : ']')).join('');
  return `${body}${closers}`;
}
