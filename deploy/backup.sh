#!/usr/bin/env bash
# Saves the whole family tree (people, relationships, photos) to deploy/backups/, keeping the last 30.
#   cd ~/vanshavali/deploy && ./backup.sh
# Daily at 3:15 am:  (crontab -l 2>/dev/null; echo "15 3 * * * $HOME/vanshavali/deploy/backup.sh >/dev/null 2>&1") | crontab -
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
docker run --rm -v vanshavali_data:/data:ro -v "$(pwd)/backups:/backups" alpine \
  tar czf "/backups/vanshavali-$(date +%Y%m%d-%H%M%S).tgz" -C /data .
ls -1t backups/vanshavali-*.tgz | tail -n +31 | xargs -r rm --
echo "Backup saved: $(ls -1t backups/vanshavali-*.tgz | head -1)"
