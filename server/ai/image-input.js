// Image attachments for the Copilot SDK (blueprint §7.1, phase 0 test 1). The SDK accepts a
// "file" attachment (the runtime reads the file) or a "blob" (base64 sent from memory).
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

// Matches the server's upload limit (blueprint §3.5); phone photos are resized far below this.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// SVG is excluded: the SDK treats it as text, not an image. HEIC is not accepted by the models.
export const IMAGE_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});

// Phones save JPEGs as .jpg or .jpeg, in either case.
const JPEG_SPELLINGS = ['.jpg', '.jpeg', '.JPG', '.JPEG'];

/** " (did you mean x.jpeg?)" if the same photo exists with the other JPEG spelling. */
async function jpegSuggestion(filePath) {
  const ext = path.extname(filePath);
  if (!JPEG_SPELLINGS.includes(ext)) return '';
  const base = filePath.slice(0, -ext.length);
  for (const other of JPEG_SPELLINGS) {
    if (other === ext) continue;
    try {
      if ((await stat(base + other)).isFile()) return ` (did you mean ${path.basename(base + other)}?)`;
    } catch {
      // not there: try the next spelling
    }
  }
  return '';
}

/**
 * Check an image file before sending it. Error messages never include the folder path.
 * @param {string} filePath absolute path
 * @returns {Promise<{ path: string, mimeType: string, bytes: number, displayName: string }>}
 */
export async function checkImageFile(filePath, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Image path must be absolute');
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_TYPES[ext];
  if (!mimeType) throw new Error(`Unsupported image type "${ext || '(none)'}": use JPG, PNG, WebP or GIF`);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`Image file not found: ${path.basename(filePath)}${await jpegSuggestion(filePath)}`);
  }
  if (!info.isFile()) throw new Error('Image path is not a file');
  if (info.size === 0) throw new Error('Image file is empty');
  if (info.size > maxBytes) throw new Error(`Image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  return { path: filePath, mimeType, bytes: info.size, displayName: path.basename(filePath) };
}

// VERIFY: file attachment shape { type: 'file', path, displayName } (SDK image-input docs).
export function fileAttachment(image) {
  return { type: 'file', path: image.path, displayName: image.displayName };
}

// VERIFY: blob attachment shape { type: 'blob', data (base64), mimeType, displayName }.
export async function blobAttachment(image) {
  const data = (await readFile(image.path)).toString('base64');
  return { type: 'blob', data, mimeType: image.mimeType, displayName: image.displayName };
}
