FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @mail/server deploy --prod --legacy /runtime

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production MAIL_HOST=0.0.0.0 MAIL_PORT=3000 MAIL_DATA_DIR=/app/.data
# The code stays owned by root, so the running service can write its data directory and nothing else.
COPY --from=build /runtime/ ./
COPY --from=build /app/apps/web/dist/ ./apps/web/dist/
RUN mkdir -p /app/.data && chown node:node /app/.data && chmod 700 /app/.data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
