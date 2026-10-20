// Codespace set-up files: checks that the proven configuration is in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('devcontainer.json: image, gh feature, foreground start, secrets', () => {
  const dc = JSON.parse(read('.devcontainer/devcontainer.json'));
  assert.match(dc.image, /javascript-node:1-22/);
  assert.ok(dc.features['ghcr.io/devcontainers/features/github-cli:1'], 'github-cli feature');
  assert.equal(dc.postStartCommand, 'bash scripts/start-server.sh --foreground');
  assert.equal(dc.postAttachCommand, 'bash scripts/start-server.sh --watch');
  assert.deepEqual(dc.forwardPorts, [3000]);
  assert.deepEqual(Object.keys(dc.secrets).sort(), [
    'ALLOWED_ACCOUNTS', 'COPILOT_GITHUB_TOKEN', 'GH_PORTS_TOKEN', 'PASS_SIGNING_KEY',
    'PASS_VERSION', 'STORAGE_REPO', 'STORAGE_TOKEN',
  ]);
});

test('start-server.sh: valid bash with the exact process pattern and three modes', () => {
  execFileSync('bash', ['-n', 'scripts/start-server.sh'], { cwd: ROOT });
  const sh = read('scripts/start-server.sh');
  assert.ok(sh.includes("pgrep -f '^node server/index\\.js'"), 'anchored pgrep pattern');
  assert.match(sh, /--foreground\)/);
  assert.match(sh, /--watch\)/);
  assert.match(sh, /node server\/index\.js >>"\$LOG" 2>&1 <\/dev\/null; note "stopped/);
  assert.match(sh, /exec tail -n 40 -f "\$LOG"/);
});

test('package.json: npm run server uses the start script', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.server, 'bash scripts/start-server.sh');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.type, 'module');
});

test('.gitignore keeps server logs and node_modules out of git', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('.server/'), '.server/ ignored');
  assert.ok(lines.includes('node_modules/'), 'node_modules/ ignored');
});

test('CLAUDE.md carries the assigned-branch rule and Branch line', () => {
  const md = read('CLAUDE.md');
  assert.ok(md.includes('3. **Use the branch your session is assigned.**'));
  assert.ok(!md.includes('3. **Create the branch** named in the package'));
  assert.ok(md.includes('PR: <link>   Branch: <assigned branch>   STATE: v<n> (in this PR)'));
});
