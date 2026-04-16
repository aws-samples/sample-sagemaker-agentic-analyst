FROM public.ecr.aws/lambda/nodejs:22 AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /monorepo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/webapp/package.json apps/webapp/
COPY packages/datazone-auth/package.json packages/datazone-auth/
COPY packages/shared-types/package.json packages/shared-types/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/webapp/ apps/webapp/

WORKDIR /monorepo/apps/webapp
RUN pnpm exec prisma generate
RUN pnpm exec esbuild src/jobs/*.ts --bundle --outdir=dist --platform=node --charset=utf8 --external:@prisma/client

FROM public.ecr.aws/lambda/nodejs:22 AS runner

WORKDIR /build
COPY --from=builder /monorepo/apps/webapp/package.json ./
COPY --from=builder /monorepo/apps/webapp/prisma ./prisma
RUN corepack enable && corepack prepare pnpm@latest --activate
# job runner only needs prisma client
RUN pnpm add prisma @prisma/client
RUN pnpm exec prisma generate --generator client
COPY --from=builder /monorepo/apps/webapp/dist/. ./

CMD ["migration-runner.handler"]
