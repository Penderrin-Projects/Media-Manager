FROM node:20-alpine

LABEL maintainer="Pennderin"
LABEL description="Media Manager Server — headless media pipeline with integrated Companion PWA"
LABEL org.opencontainers.image.source="https://github.com/Pennderin/Media-Manager"

WORKDIR /app

# Copy shared library first (needed by npm install for file: dependency)
COPY shared/ ./shared/

# Install deps (layer caching)
COPY package.json patch-ssh2.js ./
RUN npm install --production

# Copy application
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Default paths
ENV CONFIG_DIR=/config
ENV PORT=9876
ENV LOG_LEVEL=info
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

# Create default directories
RUN mkdir -p /config /staging

EXPOSE 9876

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9876/ping || exit 1

CMD ["node", "server.js"]
