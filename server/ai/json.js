// Forgiving JSON reply parser (blueprint §7.4). Models sometimes wrap the JSON object in code
// fences or a sentence, so strip fences and take the text from the first "{" to the last "}".

/**
 * @param {unknown} text
 * @returns {Record<string, unknown> | null} the object, or null if there isn't a valid one
 */
export function parseJsonReply(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(stripped.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
