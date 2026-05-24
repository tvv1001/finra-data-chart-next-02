# Lightweight Node image for running a Puppeteer test
FROM node:20-slim

WORKDIR /app

# Install OS deps Puppeteer needs (minimal)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    fonts-liberation \
    --no-install-suggests --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Copy only the test script (keeps image small)
COPY ../test-crd-puppeteer.js ./test-crd-puppeteer.js

# Install puppeteer (will download Chromium)
RUN npm init -y && npm install puppeteer@latest --no-audit --no-fund

ENV APP_BASE=http://host.docker.internal:4444

# Run as non-root user for security
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser && mkdir -p /home/pptruser
RUN chown -R pptruser:pptruser /app /home/pptruser
USER pptruser

CMD ["node", "./test-crd-puppeteer.js"]
