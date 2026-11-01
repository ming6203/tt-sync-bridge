#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 /path/to/SillyTavern"
  exit 1
fi

ST_DIR=$(realpath "$1")
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if [ ! -f "$ST_DIR/package.json" ] || [ ! -d "$ST_DIR/public/scripts/extensions" ]; then
  echo "Not a SillyTavern directory: $ST_DIR"
  exit 1
fi

EXT_DIR="$ST_DIR/public/scripts/extensions/third-party/tt-sync-bridge"
PLUGIN_DIR="$ST_DIR/plugins/tt-sync-bridge"

echo "Installing server plugin..."
rm -rf "$PLUGIN_DIR"
cp -R "$SCRIPT_DIR/server" "$PLUGIN_DIR"

echo "Installing UI extension..."
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp "$SCRIPT_DIR/manifest.json" "$SCRIPT_DIR/index.js" "$SCRIPT_DIR/settings.html" "$SCRIPT_DIR/style.css" "$EXT_DIR/"

echo
echo "Installation complete."
echo "Ensure config.yaml contains:"
echo "  enableServerPlugins: true"
echo "  enableServerPluginsAutoUpdate: false"
echo "Then restart SillyTavern."
