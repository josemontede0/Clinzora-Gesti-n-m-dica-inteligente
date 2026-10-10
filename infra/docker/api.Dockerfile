# API NestJS — imagen de producción multi-etapa.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @medigest/api... 
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @medigest/shared build && pnpm --filter @medigest/api build
RUN pnpm deploy --filter @medigest/api --prod --legacy /out && cp -r apps/api/dist apps/api/prisma /out/

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
RUN npx prisma generate --schema prisma/schema.prisma && useradd --system --uid 1001 medigest && mkdir -p /data/storage && chown medigest /data/storage
USER medigest
EXPOSE 3001
# Aplica migraciones pendientes y arranca.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node dist/src/main.js"]
