import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/stamp-versions.sh", import.meta.url));

function run(dir, version) {
  return spawnSync("bash", [SCRIPT, dir, version], { encoding: "utf8" });
}

function makeSite(extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  mkdirSync(join(dir, "shared"));
  mkdirSync(join(dir, "parent"));
  const files = {
    "index.html": [
      '<link rel="manifest" href="manifest.webmanifest">',
      '<link rel="stylesheet" href="app.css">',
      '<link rel="icon" href="icons/icon-192.png">',
      '<script type="module" src="app.js"></script>',
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<a href="#main">Skip</a>',
    ].join("\n"),
    "parent/index.html": '<script type="module" src="../app.js"></script>',
    "app.js": [
      'import { config } from "./config.js";',
      "import { helper } from '../shared/helper.js';",
      'import "./side-effect.js";',
      'export { thing } from "./thing.js";',
      'const lazy = () => import("./lazy.js");',
      'import { remote } from "https://cdn.example.com/remote.js";',
    ].join("\n"),
    "shared/helper.js": 'export * from "./other.js";',
    ...extraFiles,
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("stamps relative HTML references and JS imports", () => {
  const dir = makeSite();
  try {
    const result = run(dir, "abc12345");
    assert.equal(result.status, 0, result.stderr);

    const html = readFileSync(join(dir, "index.html"), "utf8");
    assert.match(html, /href="manifest\.webmanifest\?v=abc12345"/);
    assert.match(html, /href="app\.css\?v=abc12345"/);
    assert.match(html, /src="app\.js\?v=abc12345"/);
    assert.match(html, /href="icons\/icon-192\.png"/, "images are left alone");
    assert.match(html, /src="https:\/\/cdn\.example\.com\/lib\.js"/, "absolute URLs untouched");
    assert.match(html, /href="#main"/);

    const parent = readFileSync(join(dir, "parent/index.html"), "utf8");
    assert.match(parent, /src="\.\.\/app\.js\?v=abc12345"/);

    const js = readFileSync(join(dir, "app.js"), "utf8");
    assert.match(js, /from "\.\/config\.js\?v=abc12345";/);
    assert.match(js, /from '\.\.\/shared\/helper\.js\?v=abc12345';/);
    assert.match(js, /import "\.\/side-effect\.js\?v=abc12345";/);
    assert.match(js, /from "\.\/thing\.js\?v=abc12345";/);
    assert.match(js, /import\("\.\/lazy\.js\?v=abc12345"\)/);
    assert.match(js, /from "https:\/\/cdn\.example\.com\/remote\.js";/);

    const shared = readFileSync(join(dir, "shared/helper.js"), "utf8");
    assert.match(shared, /from "\.\/other\.js\?v=abc12345";/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running twice does not stamp twice", () => {
  const dir = makeSite();
  try {
    assert.equal(run(dir, "v1").status, 0);
    const second = run(dir, "v1");
    assert.equal(second.status, 0, second.stderr);
    const js = readFileSync(join(dir, "app.js"), "utf8");
    assert.ok(!js.includes("?v=v1?v="), "no double stamps");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails the deploy when a relative import can't be stamped", () => {
  const dir = makeSite({ "data.js": 'import data from "./data.json" with { type: "json" };' });
  try {
    const result = run(dir, "abc12345");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not stamped/);
    assert.match(result.stderr, /data\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects missing or unsafe arguments", () => {
  const dir = makeSite();
  try {
    assert.equal(run(dir, "").status, 2);
    assert.equal(run(join(dir, "missing"), "v1").status, 2);
    assert.equal(run(dir, "bad;version").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
