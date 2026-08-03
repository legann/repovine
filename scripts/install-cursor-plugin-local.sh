#!/usr/bin/env bash
# Maintainer dev helper: install the generated Cursor bundle into ~/.cursor for
# local testing. Render first with `npm run render-client-plugins`.
# Override the plugin repo location with REPOVINE_CLIENT_PLUGINS_DIR=/path.
set -euo pipefail

ENGINE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_REPO="${REPOVINE_CLIENT_PLUGINS_DIR:-$(cd "$ENGINE_ROOT/.." && pwd)/repovine-client-plugins}"
PLUGIN_SRC="$PLUGIN_REPO/repovine-plugins/cursor"
PLUGIN_DST="$HOME/.cursor/plugins/local/repovine"

if [ ! -f "$PLUGIN_SRC/.cursor-plugin/plugin.json" ]; then
  echo "Missing $PLUGIN_SRC/.cursor-plugin/plugin.json" >&2
  echo "Run: npm run render-client-plugins" >&2
  exit 1
fi

rm -rf "$PLUGIN_DST"
mkdir -p "$(dirname "$PLUGIN_DST")"
cp -r "$PLUGIN_SRC" "$PLUGIN_DST"

echo "Copied to $PLUGIN_DST"
echo "  source: $PLUGIN_SRC"
echo "Reload Cursor Window to pick up changes"
