# The Relay API image. Bun runs our TypeScript directly, so there's no build step.

# Stage 1: install production dependencies only (no TypeScript, no @types).
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2: the image that runs. Bun's download cache from stage 1 stays behind.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The pipeline passes the commit; /version reports it, so we can see what's running.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

USER bun
EXPOSE 8080 

# Exec form: Bun itself is the main process, so it receives SIGTERM directly.
CMD ["bun", "src/server.ts"]
