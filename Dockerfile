# The Onn HR server (pages and API together) as one container. Runs on any host that runs containers:
# Render, Railway, Fly.io, Cloud Run with one always-on instance, or a VM with Docker.
#
#   docker build -t onnhr-server .
#   docker run -p 3000:3000 --env-file production.env -v onnhr-data:/data onnhr-server
#
# Run exactly ONE copy (docs/DEPLOY.md, "One copy only"). Settings come from the host's environment, never from a
# file in the image: .env files are left out by .dockerignore.

FROM node:24-slim AS deps
WORKDIR /app
# puppeteer is only used by tests and local scripts; its browser download is not wanted in the image
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    # Employee documents and clock photos (encrypted files) and the error log live on the mounted disk, not in the
    # image: a container's own files are gone at every release. Mount a disk that is kept and backed up at /data.
    VAULT_DIR=/data/vault \
    LOG_DIR=/data/logs \
    BACKUP_DIR=/data/backups
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Not root: the app only needs to read its own files and write under /data
RUN mkdir -p /data/vault /data/logs /data/backups && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
# /api/health answers without a sign-in and without touching the database
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
