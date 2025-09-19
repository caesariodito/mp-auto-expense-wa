# Use Puppeteer's maintained image with Chromium pre-installed
FROM ghcr.io/puppeteer/puppeteer:latest

# Create app directory
WORKDIR /app

# Copy package manifests first for better caching
COPY package*.json ./

# Install dependencies (omit dev deps for smaller image)
RUN npm ci --omit=dev

# Copy source code
COPY src ./src
COPY .env.example ./

# Ensure Puppeteer uses the system Chromium from the base image
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_DISABLE_HEADLESS_WARNING=true

# Create common data directories and set permissions for the non-root user
RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /app/data \
  && chown -R pptruser:pptruser /app

# Run as the non-root user provided by the base image
USER pptruser

# Recommended for Chromium stability in containers
ENV NODE_ENV=production

# Default command
CMD ["npm", "start"]

