Run the Puppeteer CRD test inside Docker

This container runs the `scripts/test-crd-puppeteer.js` script against your local dev server.

Prerequisites

- Docker installed
- Dev server running at http://localhost:4444 on the host

Build the image

```bash
# from repository root
docker build -t finra-crd-test -f scripts/puppeteer/Dockerfile scripts/puppeteer
```

Run the container (Linux/macOS)

```bash
# Linux: allow container to access host via host.docker.internal
# On Linux you may need to add --add-host=host.docker.internal:host-gateway

docker run --rm --network host finra-crd-test
```

Alternate (if host networking not allowed):

```bash
# expose host by mapping host gateway
docker run --rm --add-host=host.docker.internal:host-gateway finra-crd-test
```

Notes

- The script will use the `APP_BASE` env var if you override it. By default it points to `http://host.docker.internal:4444` so the container reaches your dev server.
- To be safe and avoid Upstash writes, ensure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are NOT set in your environment when running the dev server the test hits.
- The image includes Chromium via Puppeteer and minimal OS libs required to run headless Chromium.
