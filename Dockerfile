# Stage 1: Install dependencies and build
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Stage 2: Production runtime
FROM oven/bun:1 AS runtime
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Built client assets (Vite output)
COPY --from=builder /app/dist ./dist

# Server source (Bun runs TypeScript directly)
COPY server ./server
COPY lib ./lib
COPY generated ./generated

# Worker tasks and templates
COPY worker ./worker

# Migrations and graphile-migrate config
COPY migrations ./migrations
COPY .gmrc ./

# Scripts (for first-deploy db:init via Dokploy terminal)
COPY scripts ./scripts

EXPOSE 3000
CMD ["bun", "run", "start:prod"]
