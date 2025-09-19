# Use Puppeteer's maintained image with Chromium pre-installed
FROM ghcr.io/puppeteer/puppeteer:latest

# Create app directory
WORKDIR /app

# Copy package manifests first for better caching
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies (omit dev deps for smaller image)
RUN npm ci --omit=dev

# Copy source code
COPY --chown=pptruser:pptruser src ./src
COPY --chown=pptruser:pptruser .env.example ./

# Optional: quiet Puppeteer headless warnings
ENV PUPPETEER_DISABLE_HEADLESS_WARNING=true

# Create common data directories (owned by pptruser by default)
RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /app/data

# Recommended for Chromium stability in containers
ENV NODE_ENV=production

# Default command
CMD ["npm", "start"]
