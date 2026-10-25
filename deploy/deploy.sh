#!/usr/bin/env bash
# SongRoom Docker 生产部署与升级脚本
# 从 GitHub Container Registry 拉取镜像 -> 优雅停机 -> 数据库迁移 -> 自检 -> 启动并检查健康
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_REF="${1:-ghcr.io/softmoonlit/songroom:latest}"
export APP_IMAGE="$IMAGE_REF"

echo "==> 拉取镜像: $APP_IMAGE ..."
docker compose pull songroom

echo "==> 停机以保证端口与数据库独占..."
docker compose stop songroom 2>/dev/null || true

echo "==> 执行数据库迁移..."
docker compose run --rm songroom node dist/cli.js db migrate

echo "==> 执行数据库只读自检..."
docker compose run --rm songroom node dist/cli.js db check

echo "==> 启动 SongRoom 容器..."
docker compose up -d songroom

echo "==> 等待健康检查就绪..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "SongRoom 部署成功，服务已就绪！"
    curl -fsS http://127.0.0.1:3000/healthz
    echo ""
    exit 0
  fi
  sleep 1
done

echo "错误：服务未在规定时间内就绪，请检查容器日志：docker compose logs songroom" >&2
exit 1
