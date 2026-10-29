// Learner page: the capture screen (WP-014b). Camera, gallery and file picker; every image is
// shrunk on a canvas before it's sent (A-002). The logic lives in shared/capture.js; this file only
// does the parts that need the browser (canvas, file inputs, the list on screen).
import {
  CAPTURE_MESSAGES,
  MAX_FILES_AT_ONCE,
  classifyFile,
  createCaptureQueue,
  encodeWithinLimits,
  formatBytes,
  prepareCapture,
  shortTime,
} from "./shared/capture.js";

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // from-image applies the photo's rotation, so portrait photos stay upright.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall back to an <img>, which some browsers decode when createImageBitmap can't.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not decode the picture"));
    };
    img.src = url;
  });
}

/**
 * Shrinks a picture to JPEG within the A-002 limits. Re-encoding also drops the photo's
 * hidden details (such as location), because a canvas doesn't keep them.
 */
export async function resizeImage(file) {
  const source = await decodeImage(file);
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    let drawn = "";
    const encode = (width, height, quality) => {
      const size = `${width}x${height}`;
      if (drawn !== size) {
        canvas.width = width;
        canvas.height = height;
        // White behind transparent pictures, which JPEG can't store.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(source, 0, 0, width, height);
        drawn = size;
      }
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("could not encode"))), "image/jpeg", quality);
      });
    };
    return await encodeWithinLimits({
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
      encode,
    });
  } finally {
    source.close?.();
    canvas.width = 0; // releases the canvas memory straight away on phones
    canvas.height = 0;
  }
}

function rowElement(row, onRetry) {
  const item = document.createElement("li");
  item.className = "capture-item";
  item.dataset.state = row.state;

  const title = document.createElement("span");
  title.className = "capture-title";
  const time = shortTime(row.time);
  title.textContent = time ? `${row.title} · ${time}` : row.title;

  const message = document.createElement("span");
  message.className = "capture-message";
  message.textContent = row.message;

  item.append(title, message);

  const details = [];
  if (row.width && row.height) details.push(`${row.width} × ${row.height}`);
  if (row.bytes) details.push(formatBytes(row.bytes));
  if (details.length) {
    const detail = document.createElement("span");
    detail.className = "capture-detail";
    detail.textContent = details.join(" · ");
    item.append(detail);
  }

  if (row.canRetry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Try again";
    button.addEventListener("click", () => onRetry(row.uploadId));
    item.append(button);
  }
  return item;
}

/**
 * Wires up the capture section. Returns { start(token), stop() }, or null if the page doesn't
 * have the capture section.
 */
export function createCaptureScreen({ workerUrl, onSignedOut, doc = document }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    camera: byId("capture-camera"),
    gallery: byId("capture-gallery"),
    file: byId("capture-file"),
    cameraInput: byId("capture-camera-input"),
    galleryInput: byId("capture-gallery-input"),
    fileInput: byId("capture-file-input"),
    status: byId("capture-status"),
    list: byId("captures-list"),
    empty: byId("captures-empty"),
    refresh: byId("captures-refresh"),
  };
  if (Object.values(els).some((el) => !el)) return null;

  let queue = null;
  const status = (text) => setText(els.status, text);

  function render(rows) {
    const retry = (uploadId) => {
      const clientId = uploadId.replace(/^up_/, "");
      queue?.retry(clientId);
    };
    els.list.replaceChildren(...rows.map((row) => rowElement(row, retry)));
    els.empty.hidden = rows.length > 0;
  }

  async function handleFiles(input, source) {
    const chosen = Array.from(input.files ?? []);
    input.value = ""; // so choosing the same file again still fires "change"
    if (!queue || chosen.length === 0) return;
    const files = chosen.slice(0, MAX_FILES_AT_ONCE);
    if (chosen.length > files.length) status(CAPTURE_MESSAGES.tooMany);
    for (const file of files) {
      const current = queue;
      if (!current) return;
      const capturedAt = new Date().toISOString();
      const isImage = classifyFile(file)?.route === "image";
      status(isImage ? CAPTURE_MESSAGES.preparingPhoto : CAPTURE_MESSAGES.preparingFile);
      let prepared;
      try {
        prepared = await prepareCapture({ file, resizeImage });
      } catch (err) {
        // Never log the file's name: it may say something about the learner.
        console.error("[capture] could not prepare a capture:", err?.message ?? String(err));
        prepared = { error: "unreadable" };
      }
      if (prepared.error) {
        status(CAPTURE_MESSAGES[prepared.error]);
        continue;
      }
      if (queue !== current) return; // signed out while preparing
      status(CAPTURE_MESSAGES.sending);
      current.add(prepared, { source, capturedAt, contentKind: "brief" });
    }
  }

  els.camera.addEventListener("click", () => els.cameraInput.click());
  els.gallery.addEventListener("click", () => els.galleryInput.click());
  els.file.addEventListener("click", () => els.fileInput.click());
  els.cameraInput.addEventListener("change", () => handleFiles(els.cameraInput, "camera"));
  els.galleryInput.addEventListener("change", () => handleFiles(els.galleryInput, "gallery"));
  els.fileInput.addEventListener("change", () => handleFiles(els.fileInput, "file"));
  els.refresh.addEventListener("click", () => queue?.refresh({ manual: true }));
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") queue?.refresh();
  });

  function stop() {
    queue?.stop();
    queue = null;
    render([]);
    status("");
  }

  function start(token) {
    stop();
    queue = createCaptureQueue({
      workerUrl,
      getToken: () => token,
      onChange: render,
      onEvent: ({ message }) => status(message),
      onSignedOut: (reason) => {
        queue = null;
        onSignedOut?.(reason);
      },
    });
    queue.start();
  }

  return { start, stop };
}
