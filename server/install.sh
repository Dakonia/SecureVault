#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "[*] Docker не найден — устанавливаю (docker.io + compose)..."
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2
  systemctl enable --now docker
else
  echo "[*] Docker уже установлен: $(docker --version)"
fi

if [ ! -f .env ]; then
  tok="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 44)"
  echo "SECUREVAULT_TOKEN=$tok" > .env
  chmod 600 .env
  echo "[*] Сгенерирован секретный токен в .env"
fi

echo "[*] Сборка и запуск контейнера..."
docker compose up -d --build
docker compose ps

echo "[*] Проверка health..."
sleep 2
curl -fsS http://127.0.0.1:8088/health && echo "  <- receiver отвечает"
