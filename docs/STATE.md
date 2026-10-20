STATE version: 1
Updated: 2026-10-20 09:27 (UK time)
Last work package applied: WP-001

## File tree
```
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

## Scripts
- `scripts/stamp-versions.sh <web-dir> <version>`: deploy-time `?v=` stamping (exit 2 bad args, exit 1 unstamped reference).
- `npm test`: `node --test`. `npm run icons`: regenerate the PNG icons.

## Settings and secrets expected
None yet. `web/config.js` `workerUrl` is empty by design until WP-011.

## Deviations in effect
- Work branch is `claude/sharp-mendel-9bkzvw`, not `wp-001-foundations`: the Claude Code session may push only to its assigned branch. Contents are as specified.

## Known issues
- Not yet verified: GitHub Pages deploy (needs Pages source set to GitHub Actions), Android install, real-browser rendering.
- No `package-lock.json`: no dependencies, so `npm install` was not run.
