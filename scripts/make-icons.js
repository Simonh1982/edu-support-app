// Generates the app icons as PNG files with no dependencies: `npm run icons`.
// The design is a neutral placeholder (no text, no name) until the look is chosen with the
// learner (build spec Appendix D). Full-bleed background with the motif well inside the
// central 80%, so the same file is safe for Android's "maskable" cropping.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const BACKGROUND = [0x1d, 0x4f, 0x7a];
const FOREGROUND = [0xff, 0xff, 0xff];
const RING_OUTER = 0.3; // fraction of the icon size
const RING_INNER = 0.18;
const SAMPLES = 4; // 4 × 4 supersampling for smooth edges

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Returns RGB pixel rows (each prefixed with PNG filter byte 0) for a square icon. */
export function renderIcon(size) {
  const rowLength = 1 + size * 3;
  const raw = Buffer.alloc(rowLength * size);
  const centre = size / 2;
  const outer = RING_OUTER * size;
  const inner = RING_INNER * size;
  for (let y = 0; y < size; y++) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = x + (sx + 0.5) / SAMPLES - centre;
          const dy = y + (sy + 0.5) / SAMPLES - centre;
          const d = Math.hypot(dx, dy);
          if (d <= outer && d >= inner) hits++;
        }
      }
      const t = hits / (SAMPLES * SAMPLES);
      const offset = y * rowLength + 1 + x * 3;
      for (let i = 0; i < 3; i++) {
        raw[offset + i] = Math.round(BACKGROUND[i] * (1 - t) + FOREGROUND[i] * t);
      }
    }
  }
  return raw;
}

/** Encodes a square RGB image as a PNG buffer. */
export function encodePng(size, raw = renderIcon(size)) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  const outDir = fileURLToPath(new URL("../web/icons/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  for (const size of [192, 512]) {
    const file = `${outDir}icon-${size}.png`;
    writeFileSync(file, encodePng(size));
    console.log(`wrote web/icons/icon-${size}.png`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
