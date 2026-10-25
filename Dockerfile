ARG BASE_IMAGE=ubuntu:22.04

FROM ${BASE_IMAGE} AS node-base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    curl \
    xz-utils \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
  && corepack enable

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node-base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/songroom/package.json ./apps/songroom/
COPY packages/vendor/netease-cloud-music-api-enhanced/package.json ./packages/vendor/netease-cloud-music-api-enhanced/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

# ── Production runner stage ──────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS runner
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node-base /usr/local /usr/local

# 创建专用运行用户 songroom (UID 997, GID 997 匹配宿主机持久目录权限)
RUN groupadd -g 997 songroom && \
    useradd -u 997 -g songroom -s /usr/sbin/nologin -d /var/lib/songroom songroom && \
    install -d -o songroom -g songroom -m 0700 /var/lib/songroom /run/songroom /tmp/songroom && \
    mkdir -p /opt/songroom && \
    ln -s /app /opt/songroom/current

WORKDIR /app
COPY --from=builder --chown=songroom:songroom /app /app

USER songroom
WORKDIR /app/apps/songroom

ENV NODE_ENV=production \
    SONGROOM_CONFIG=/etc/songroom/config.json \
    TMPDIR=/tmp/songroom

EXPOSE 3000

CMD ["node", "dist/server.js"]
