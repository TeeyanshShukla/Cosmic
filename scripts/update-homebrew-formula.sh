#!/bin/bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <version> <tap-formula-path>"
  exit 1
fi

VERSION="$1"
FORMULA_PATH="$2"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARM_URL="https://github.com/TeeyanshShukla/Cosmic/releases/download/v${VERSION}/cosmic-darwin-arm64.tar.gz"
X64_URL="https://github.com/TeeyanshShukla/Cosmic/releases/download/v${VERSION}/cosmic-darwin-x64.tar.gz"

curl -fsSL "$ARM_URL" -o "$TMP_DIR/arm.tar.gz"
curl -fsSL "$X64_URL" -o "$TMP_DIR/x64.tar.gz"

ARM_SHA="$(shasum -a 256 "$TMP_DIR/arm.tar.gz" | awk '{print $1}')"
X64_SHA="$(shasum -a 256 "$TMP_DIR/x64.tar.gz" | awk '{print $1}')"

sed \
  -e "s/REPLACE_VERSION/${VERSION}/g" \
  -e "s/REPLACE_SHA_ARM64/${ARM_SHA}/g" \
  -e "s/REPLACE_SHA_X64/${X64_SHA}/g" \
  packaging/homebrew/cosmic.rb.template > "$FORMULA_PATH"

echo "Updated formula: $FORMULA_PATH"
