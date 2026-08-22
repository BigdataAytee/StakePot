# Build context is the repository root:
#   docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Prisma probes for libssl to choose its engine, and on a slim image the probe
# finds nothing and falls back to openssl-1.1.x — an engine this Debian does not
# have. It warns rather than failing, so the image builds clean and then cannot
# reach the database at boot. Installing openssl is what makes the probe answer
# openssl-3.0.x, which is the truth here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
COPY packages/rules/package.json packages/rules/
COPY packages/tokens/package.json packages/tokens/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/engine packages/engine
COPY packages/rules packages/rules
COPY packages/tokens packages/tokens
COPY apps/api apps/api
RUN pnpm --filter @stakeam/engine build \
 && pnpm --filter @stakeam/rules build \
 && pnpm --filter @stakeam/api exec prisma generate \
 && pnpm --filter @stakeam/api build

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3001
# Migrations are deployed as a separate step, not on container start — a rolling
# deploy must not have several replicas racing `prisma migrate deploy`.
CMD ["node", "--enable-source-maps", "apps/api/dist/main.js"]
