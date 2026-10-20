#!/usr/bin/env bash
# Usage: bash scripts/stamp-versions.sh <web-dir> <version>
# Run at deploy time only (never commit the result). Adds ?v=<version> to local CSS, JS and
# manifest references in HTML files, and to every relative ES module import in JS files.
# Why: Pages lets browsers keep files for 10 minutes and Chrome's normal reload doesn't
# re-check scripts, so without this a deploy can mix old and new code (blueprint §10.1).
set -euo pipefail

DIR="${1:-}"
VER="${2:-}"

if [[ -z "$DIR" || -z "$VER" ]]; then
  echo "usage: stamp-versions.sh <web-dir> <version>" >&2
  exit 2
fi
if [[ ! -d "$DIR" ]]; then
  echo "stamp-versions: not a directory: $DIR" >&2
  exit 2
fi
if [[ ! "$VER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "stamp-versions: version may contain only letters, digits, '.', '_' and '-'" >&2
  exit 2
fi

SQ="'"

# HTML: href="x.css" / src="x.js" / href="manifest.webmanifest" (relative paths only;
# anything with a scheme, a leading slash, a query or a fragment is left alone).
HTML_RE='((href|src)=")([^"/:?#][^":?#]*\.(css|js|webmanifest))"'

# JS: from "./x.js", import "./x.js", import("../x.js"), with single or double quotes.
# '?' is excluded from the path, so files already stamped are not stamped twice.
JS_RE="((from|import)[[:space:]]*\\(?[[:space:]]*)([\"${SQ}])(\\.{1,2}/[^\"${SQ}?]+\\.js)\\3"

html_count=0
js_count=0

while IFS= read -r -d '' f; do
  sed -E -i "s@${HTML_RE}@\\1\\3?v=${VER}\"@g" "$f"
  html_count=$((html_count + 1))
done < <(find "$DIR" -type f -name '*.html' -print0)

while IFS= read -r -d '' f; do
  sed -E -i "s@${JS_RE}@\\1\\3\\4?v=${VER}\\3@g" "$f"
  js_count=$((js_count + 1))
done < <(find "$DIR" -type f -name '*.js' -print0)

# Fail the deploy if anything relative is still unstamped (e.g. a JSON import or an
# import without a .js extension), rather than publishing a mix of versions.
missed_js="$(grep -rnE "(from|import)[[:space:]]*\\(?[[:space:]]*[\"${SQ}]\\.{1,2}/" --include='*.js' "$DIR" | grep -v '?v=' || true)"
missed_html="$(grep -rnE "${HTML_RE}" --include='*.html' "$DIR" || true)"

if [[ -n "$missed_js" || -n "$missed_html" ]]; then
  echo "stamp-versions: these references were not stamped:" >&2
  [[ -n "$missed_js" ]] && echo "$missed_js" >&2
  [[ -n "$missed_html" ]] && echo "$missed_html" >&2
  exit 1
fi

echo "stamp-versions: stamped ${html_count} HTML and ${js_count} JS files with v=${VER}"
