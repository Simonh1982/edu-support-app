// Model roles (blueprint §7.2). models.json maps each role to an exact model ID, so changing a
// model never means editing code.
import { readFile } from 'node:fs/promises';

export const ROLES = Object.freeze(['conversation', 'review', 'light', 'spelling', 'checker', 'judge']);

export const MODELS_URL = new URL('../../models.json', import.meta.url);

/**
 * Check a parsed models.json. Returns { models, errors }; models is null if anything is wrong.
 * @param {unknown} raw
 */
export function validateModels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { models: null, errors: ['models.json must be a JSON object'] };
  }
  const errors = [];
  const models = {};
  for (const role of ROLES) {
    const id = raw[role];
    if (typeof id !== 'string' || !id.trim()) errors.push(`${role}: missing model ID`);
    // "auto" lets Copilot switch models between requests, which breaks tone consistency
    else if (id.trim().toLowerCase() === 'auto') errors.push(`${role}: "auto" is not allowed`);
    else models[role] = id.trim();
  }
  for (const key of Object.keys(raw)) {
    if (!ROLES.includes(key)) errors.push(`${key}: unknown role`);
  }
  return errors.length ? { models: null, errors } : { models: Object.freeze(models), errors };
}

/** Read and check models.json. Never throws. */
export async function loadModels(url = MODELS_URL) {
  let text;
  try {
    text = await readFile(url, 'utf8');
  } catch (err) {
    return { models: null, errors: [`models.json could not be read (${err.code || err.message})`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { models: null, errors: ['models.json is not valid JSON'] };
  }
  return validateModels(raw);
}
