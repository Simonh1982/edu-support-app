// A model's own image limits, read from the account's model list, never hard-coded (amendment A-002,
// blueprint §7.1 and §10.4). Field names as confirmed by `npm run spike:image` in WP-006.

export const IMAGE_TOO_LARGE_MESSAGE = 'This photo is too large to read. Please take it again.';

/** { modelId, vision, maxBytes, mediaTypes } for one model, or null if it isn't in the list. */
export function imageLimits(list, modelId) {
  const model = Array.isArray(list) ? list.find((m) => m?.id === modelId) : undefined;
  if (!model) return null;
  const vision = model.capabilities?.limits?.vision ?? {};
  const maxBytes = Number.isFinite(vision.max_prompt_image_size) && vision.max_prompt_image_size > 0
    ? vision.max_prompt_image_size : null;
  const mediaTypes = Array.isArray(vision.supported_media_types)
    ? vision.supported_media_types.filter((t) => typeof t === 'string') : null;
  // only an explicit "no" counts: a missing flag leaves the decision to the size and type checks
  const supports = model.capabilities?.supports?.vision;
  return { modelId, vision: supports !== false, maxBytes, mediaTypes };
}

/** Can this image be sent to the model? Returns { ok, reason } with reason too-large | unsupported-type | no-vision. */
export function checkImage({ bytes, mimeType }, limits) {
  if (!limits) return { ok: true, reason: null };
  if (!limits.vision) return { ok: false, reason: 'no-vision' };
  if (limits.mediaTypes && limits.mediaTypes.length > 0 && !limits.mediaTypes.includes(mimeType)) {
    return { ok: false, reason: 'unsupported-type' };
  }
  if (limits.maxBytes !== null && Number(bytes) > limits.maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, reason: null };
}

/** The limits of a role's model, from startAi()'s handle. Null if the AI or the model isn't available. */
export async function loadImageLimits(handle, role = 'light') {
  try {
    const id = handle?.models?.[role];
    if (!id || typeof handle?.ai?.listModels !== 'function') return null;
    return imageLimits(await handle.ai.listModels(), id);
  } catch {
    return null;
  }
}
