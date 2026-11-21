# Node.js 24.22.3 LTS includes the November 2026 security fixes.
# Periodically update this pinned patch and rebuild the image.
FROM node:24.22.3-alpine
WORKDIR /app
ENV NODE_ENV=production \
    AUDIT_DB_PATH=/data/audit.sqlite \
    AUDIT_HOST=0.0.0.0 \
    AUDIT_PORT=3000
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
