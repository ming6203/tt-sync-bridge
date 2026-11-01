#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 /path/to/SillyTavern"
  echo "Example: curl -fsSL https://raw.githubusercontent.com/ming6203/tt-sync-bridge/main/bootstrap.sh | bash -s -- /opt/SillyTavern"
  exit 1
fi

ST_DIR=$(realpath "$1")
REPO_ARCHIVE="https://github.com/ming6203/tt-sync-bridge/archive/refs/heads/main.tar.gz"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required."
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required."
  exit 1
fi

echo "Downloading TT-Sync Bridge..."
curl -fsSL "$REPO_ARCHIVE" -o "$TMP_DIR/repo.tar.gz"
tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"

"$TMP_DIR/tt-sync-bridge-main/install.sh" "$ST_DIR"
