# Build context is the repository root:
#   docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
COPY packages/tokens/package.json packages/tokens/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1

# The API's address is baked into the client bundle at build time — Next inlines
# every NEXT_PUBLIC_* value, so it cannot be supplied later by the runtime
# environment. Without this the image ships pointing at localhost:3001 and the
# deployed site calls the visitor's own machine: every request fails, and the
# app still renders, so nothing looks broken.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# The site's own origin, for the same reason and with the same trap: every Open
# Graph tag, the sitemap and robots.txt need an absolute URL, and a wrong one
# here means shared links preview against somewhere that is not this site while
# every page still renders perfectly.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

COPY tsconfig.base.json ./
# The engine as well as the tokens. `packages/engine/package.json` is copied in
# the deps stage, so pnpm links the workspace package and `pnpm install`
# succeeds — but the *source* never arrived and the package resolves through
# `dist/`, which nothing built. The web app started importing it when the topic
# taxonomy moved there (both apps need the same answer, or somebody is titled
# "Football Prophet" with their markets under Culture), and the local build
# kept working because a workspace symlink points at real files on disk.
# Only the container, with its curated COPYs, showed the gap.
COPY packages/engine packages/engine
COPY packages/tokens packages/tokens
COPY apps/web apps/web
RUN pnpm --filter @stakeam/engine build \
 && pnpm --filter @stakeam/tokens build \
 && pnpm --filter @stakeam/web build

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# `output: 'standalone'` traces exactly the files the server needs — but it
# traces *code*, so the two directories Next serves as-is have to come along
# separately. Without `public/` the image answers 404 for `/manifest.json` and
# `/sw.js`: the app still renders, so nothing looks broken, while the PWA is
# silently uninstallable and the offline shell never registers.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
