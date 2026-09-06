# syntax=docker/dockerfile:1

# ---- deps: install node_modules and generate the Prisma client ----
# Debian slim (not alpine): the Prisma query engine and the native `bcrypt`
# addon are more reliable on glibc, and `node:24-slim` matches local dev.
FROM node:24-slim AS deps
WORKDIR /app

# OpenSSL is required by the Prisma engine at generate/runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

# ---- runtime: copy only what the server needs, run as non-root ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh \
  && groupadd --system app && useradd --system --gid app app \
  && chown -R app:app /app
USER app

EXPOSE 3000
# entrypoint runs `prisma migrate deploy` (and optional seed) then execs CMD
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
