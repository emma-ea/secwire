# One image for web, worker and the one-off migrate job (SPEC §11).
# The worker and scripts run TypeScript through tsx, so the runtime keeps the
# full dependency tree rather than a pruned production install.

FROM node:22.16-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Env is validated lazily (src/env.ts), so the build needs no secrets.
RUN pnpm build

FROM build AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["pnpm", "start"]
