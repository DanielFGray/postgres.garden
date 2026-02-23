# Stage 1: Install dependencies and build
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Vite inlines VITE_* env vars at build time; .env is dockerignored so pass via build arg
ARG VITE_OTEL_COLLECTOR_URL
ENV VITE_OTEL_COLLECTOR_URL=$VITE_OTEL_COLLECTOR_URL

RUN bun run build

# Stage 2: Production runtime
FROM oven/bun:1 AS runtime
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Built output: esbuild server bundle + Vite client assets
COPY --from=builder /app/dist ./dist

# Worker tasks
COPY worker ./worker

# Migrations and graphile-migrate config
COPY migrations ./migrations
COPY .gmrc ./

# Scripts + lib (for first-deploy db:init via Dokploy terminal)
COPY scripts ./scripts
COPY lib ./lib

EXPOSE 3000
CMD ["bun", "run", "start:prod"]
