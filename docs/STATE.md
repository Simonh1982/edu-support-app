STATE version: 2
Updated: 2026-10-20 17:28 (UK time)
Last work package applied: WP-004

## File tree
```
.devcontainer/devcontainer.json
.github/workflows/pages.yml
.gitignore
CLAUDE.md
LICENSE
README.md
docs/STATE.md
docs/blueprint.md
docs/build-spec.md
package.json
scripts/make-icons.js
scripts/stamp-versions.sh
scripts/start-server.sh
server/config.js
server/index.js
test/codespace.test.js
test/server.test.js
test/stamp-versions.test.js
test/web-shell.test.js
web/app.css
web/app.js
web/config.js
web/icons/icon-192.png
web/icons/icon-512.png
web/index.html
web/manifest.webmanifest
```

## Exports
- `web/app.js`: `loginUrl(workerUrl: string, shared: boolean): string | null`
- `web/config.js`: `config` (frozen object: `{ workerUrl: string }`)
- `scripts/make-icons.js`: `renderIcon(size: number): Buffer`, `encodePng(size: number, raw?: Buffer): Buffer`
- `server/config.js`: `PAGES_ORIGIN` (string), `loadConfig(env = process.env)` → frozen `{ port, host, idleTimeoutMin, devOrigins, jsonBodyLimit, uploadBodyLimit, codespaceName, publicUrl }`, `isAllowedOrigin(origin: string | undefined, config: { devOrigins: boolean }): boolean`
- `server/index.js`: `class HttpError(status, message)`, `createState(config, now = new Date())` → `{ startedAt, restsAt, ai, storage, port }`, `healthBody(state)`, `readJson(req, limit): Promise<unknown>`, `createHandler({ config, state, log = console })`, `createServer(config, state = createState(config), log = console)` → `{ server, state }`

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `scripts/start-server.sh [--foreground|--watch]`: proven start script (blueprint §3.2); logs to `.server/`.
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons. `npm run server`: restart the server in the background and tail the log.

## Routes
- `GET /api/health` (no pass). Everything else returns 404 JSON for now.

## Settings and secrets expected
- Server (optional, non-secret): `PORT`, `HOST`, `IDLE_TIMEOUT_MIN`, `DEV_ORIGINS`. Also read if present (set by Codespaces): `CODESPACE_NAME`, `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`.
- Codespace secrets declared in `devcontainer.json` (not yet read by code): `COPILOT_GITHUB_TOKEN`, `GH_PORTS_TOKEN`, `STORAGE_TOKEN`, `STORAGE_REPO`, `PASS_SIGNING_KEY`, `PASS_VERSION`, `ALLOWED_ACCOUNTS`.
- Front end: `web/config.js` `workerUrl` is empty by design until WP-011.

## Deviations in effect
None.

## Known issues
- Not yet verified: Codespace build, `postStartCommand`/`postAttachCommand` in a real Codespace, port forwarding.
- No `package-lock.json`: no dependencies, so `npm install` was not run.
