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

echo "Installing server plugin..."
rm -rf "$ST_DIR/plugins/tt-sync-bridge"
cp -R "$SCRIPT_DIR/server" "$ST_DIR/plugins/tt-sync-bridge"

echo "Installing UI extension..."
rm -rf "$ST_DIR/public/scripts/extensions/third-party/tt-sync-bridge"
cp -R "$SCRIPT_DIR/extension" "$ST_DIR/public/scripts/extensions/third-party/tt-sync-bridge"

echo
echo "Installation complete."
echo "Ensure config.yaml contains:"
echo "  enableServerPlugins: true"
echo "  enableServerPluginsAutoUpdate: false"
echo "Then restart SillyTavern."
