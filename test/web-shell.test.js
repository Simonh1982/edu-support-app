import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginUrl } from "../web/app.js";
import { encodePng } from "../scripts/make-icons.js";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

test("manifest meets Chrome's install requirements", () => {
  const manifest = JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8"));
  assert.ok(manifest.name || manifest.short_name, "name or short_name");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./", "relative, so it works under the Pages sub-path");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.id, "./", "fixed id, so later changes don't create a new app");
  assert.notEqual(manifest.prefer_related_applications, true);

  const sizes = new Set(manifest.icons.map((icon) => icon.sizes));
  assert.ok(sizes.has("192x192") && sizes.has("512x512"), "192 and 512 icons");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"), "a maskable icon");

  for (const icon of manifest.icons) {
    const file = join(WEB, icon.src);
    assert.ok(existsSync(file), `${icon.src} exists (run: npm run icons)`);
    const { width, height } = pngSize(readFileSync(file));
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} dimensions`);
  }
});

test("icon generator produces valid PNGs of the requested size", () => {
  for (const size of [48, 192]) {
    const { width, height } = pngSize(encodePng(size));
    assert.equal(width, size);
    assert.equal(height, size);
  }
});

test("sign-in page is accessible and links the manifest", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /<html lang="en-GB">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<h1[^>]*>Sign in<\/h1>/);
  assert.match(html, /<label for="shared-computer">This is a shared computer<\/label>/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale/, "zoom must stay possible");
});

test("front-end code never uses window.confirm", () => {
  for (const file of jsFiles(WEB)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\bconfirm\s*\(/, file);
  }
});

test("loginUrl builds the Worker address", () => {
  assert.equal(loginUrl("", false), null);
  assert.equal(loginUrl("   ", true), null);
  assert.equal(loginUrl(undefined, false), null);
  assert.equal(loginUrl("https://w.example.dev", false), "https://w.example.dev/auth/login");
  assert.equal(
    loginUrl("https://w.example.dev/", true),
    "https://w.example.dev/auth/login?shared=1",
  );
});
