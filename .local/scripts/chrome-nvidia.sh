#!/usr/bin/env bash
# Launch Chromium/Chrome on the NVIDIA dGPU (hybrid laptops: RTX + AMD/Intel iGPU).
# SVG filters on the Mesa iGPU path can SIGILL; routing the browser to NVIDIA avoids that
# so you can optionally use ?safe_gpu=0 for full filter effects.
set -euo pipefail

if ! command -v nvidia-smi >/dev/null 2>&1; then
	echo "nvidia-smi not found — is the NVIDIA driver installed?" >&2
	exit 1
fi

nvidia-smi -L || true

export __NV_PRIME_RENDER_OFFLOAD=1
export __VK_LAYER_NV_optimus=NVIDIA_only
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export DRI_PRIME=1

CHROME_BIN="${CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
	for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
		if command -v "$candidate" >/dev/null 2>&1; then
			CHROME_BIN="$candidate"
			break
		fi
	done
fi

if [[ -z "$CHROME_BIN" ]]; then
	echo "No Chrome/Chromium binary found. Set CHROME_BIN=/path/to/chrome" >&2
	exit 1
fi

URL="${1:-http://localhost:4444/}"
echo "Launching $CHROME_BIN on NVIDIA → $URL"
exec "$CHROME_BIN" --new-window "$URL"
