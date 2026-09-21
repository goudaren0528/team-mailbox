FROM node:24-alpine

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Default environment configuration
ENV NODE_ENV=production \
    MSG_HOST=0.0.0.0 \
    MSG_PORT=8787 \
    MSG_DB_PATH=/data/msg.sqlite

# Create database volume mount point
RUN mkdir -p /data

VOLUME ["/data"]

EXPOSE 8787

CMD ["node", "src/server.js"]
