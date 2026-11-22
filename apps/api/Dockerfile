# Radio Aha API. Multi-arch: node:22-alpine and Alpine's ffmpeg exist for linux/amd64 and linux/arm64,
# so `docker compose build` on the Oracle ARM VM builds natively.
# Build context: the repo root (pnpm workspace + lockfile).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @radio-jil/api...
COPY apps/api apps/api
RUN pnpm --filter @radio-jil/api build \
 && pnpm --filter @radio-jil/api deploy --prod --legacy /out

FROM node:22-alpine
# ffprobe reads duration/tags of uploads; tini forwards signals for a clean shutdown.
RUN apk add --no-cache ffmpeg tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/drizzle ./drizzle
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:4000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
