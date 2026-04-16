FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /monorepo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/chat-agent/package.json apps/chat-agent/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile

COPY packages/shared-types/ packages/shared-types/
COPY apps/chat-agent/ apps/chat-agent/

WORKDIR /monorepo/apps/chat-agent
RUN pnpm run build
RUN pnpm deploy --legacy --filter=chat-agent --prod /app

FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:20-slim

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
