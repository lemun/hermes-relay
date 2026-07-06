// Robust extraction of the last fenced ```json result block from a session's
// final message. The naive regex (```json … ```) breaks the moment the payload
// itself contains a fence — live failure rn#280: a template-conformant prBody
// with its own code block truncated the match mid-string, the parse returned
// null, and a perfectly good implementation got parked as blocked. This walks
// the JSON with brace-balancing that is string- and escape-aware instead of
// trusting the closing fence.

/** Parse the LAST ```json block in `text`; null when none parses. */
export function lastFencedJson(text) {
  if (typeof text !== "string" || !text) return null;
  const markers = [...text.matchAll(/```json/g)].map((m) => m.index);
  for (let i = markers.length - 1; i >= 0; i--) {
    const start = text.indexOf("{", markers[i]);
    if (start === -1) continue;
    const candidate = extractBalancedObject(text, start);
    if (candidate !== null) {
      try { return JSON.parse(candidate); } catch { /* malformed — try an earlier marker */ }
    }
  }
  return null;
}

// Slice one balanced {...} starting at `start`, honoring JSON string literals
// (braces and fences inside strings don't count) and backslash escapes.
function extractBalancedObject(text, start) {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
