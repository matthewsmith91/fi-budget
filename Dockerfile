# One image serves the static web app and the sync server from the same origin.
# Build: docker build -t budget-fi .   Run: see compose.yaml (adds HTTPS).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
RUN npm ci
COPY . .
RUN npx turbo run build

FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3001
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
# Only the server's own dependencies; the web app ships as static files.
RUN npm ci --omit=dev --workspace=api && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
