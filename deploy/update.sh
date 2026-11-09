#!/usr/bin/env bash
# Pulls the latest family tree code and restarts it (a few seconds; data is kept).
#   cd ~/vanshavali/deploy && ./update.sh
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
