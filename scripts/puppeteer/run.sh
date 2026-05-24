#!/usr/bin/env bash
# Helper to build and run the Puppeteer Docker test
set -eu
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

docker build -t finra-crd-test -f scripts/puppeteer/Dockerfile scripts/puppeteer
# On Linux, use host networking to reach localhost:4444. Otherwise, add host mapping.
if [[ "$(uname -s)" == "Linux" ]]; then
  docker run --rm --network host finra-crd-test
else
  docker run --rm --add-host=host.docker.internal:host-gateway finra-crd-test
fi
