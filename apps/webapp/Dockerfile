FROM public.ecr.aws/lambda/nodejs:22 AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /monorepo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/webapp/package.json apps/webapp/
COPY packages/datazone-auth/package.json packages/datazone-auth/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/webapp/ apps/webapp/

ARG SKIP_TS_BUILD=""
ARG ALLOWED_ORIGIN_HOST=""
ARG NEXT_PUBLIC_EVENT_HTTP_ENDPOINT=""
ARG NEXT_PUBLIC_AWS_REGION=""
ENV USER_POOL_CLIENT_ID="dummy"
ENV USER_POOL_ID="dummy"
ENV AMPLIFY_APP_ORIGIN="https://dummy.example.com"
ENV COGNITO_DOMAIN="dummy.example.com"
WORKDIR /monorepo/apps/webapp
RUN --mount=type=cache,target=/monorepo/apps/webapp/.next/cache pnpm run build

FROM public.ecr.aws/lambda/nodejs:22 AS runner
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=3000
ENV AWS_LWA_READINESS_CHECK_PATH="/api/health"
ENV AWS_LWA_INVOKE_MODE="response_stream"

COPY --from=builder /monorepo/apps/webapp/.next/static ./apps/webapp/.next/static
COPY --from=builder /monorepo/apps/webapp/.next/standalone ./
COPY --from=builder /monorepo/apps/webapp/run.sh ./run.sh

RUN ln -s /tmp/cache ./apps/webapp/.next/cache

ENTRYPOINT ["sh"]
CMD ["run.sh"]
