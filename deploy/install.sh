#!/usr/bin/env bash
# One-time setup on the Curiosand server.
#   cd ~/vanshavali/deploy && ./install.sh family.curiosand.com
# 1. creates .env (asks you for the family passcode)
# 2. builds and starts the family tree container
# 3. adds the family tree's address to Curiosand's Caddy and reloads Caddy (no downtime for Curiosand)
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="${1:-}"
CURIOSAND_DIR="${CURIOSAND_DIR:-$HOME/curiosand/deploy}"
CADDYFILE="$CURIOSAND_DIR/Caddyfile"

if [ -z "$DOMAIN" ]; then echo "Usage: ./install.sh family.curiosand.com"; exit 1; fi
if [ ! -f "$CADDYFILE" ]; then echo "Can't find $CADDYFILE. Set CURIOSAND_DIR=/path/to/curiosand/deploy and run again."; exit 1; fi
if ! docker network inspect curiosand_default >/dev/null 2>&1; then echo "The Curiosand stack isn't running (no curiosand_default network). Start it first."; exit 1; fi

# --- 1. settings ---
if [ ! -f .env ]; then
  echo "Choose the family passcode. Everyone in the family will type this once on each phone or computer."
  echo "Use something easy to share but hard to guess, e.g. three words: nimbu-pahad-diwali"
  read -r -p "Family passcode (leave empty to generate one): " PASS
  if [ -z "$PASS" ]; then PASS="$(openssl rand -hex 5)"; fi
  umask 077
  printf 'FAMILY_DOMAIN=%s\nFAMILY_PASSCODE=%s\nSESSION_SECRET=%s\nPROXY_NETWORK=curiosand_default\n' \
    "$DOMAIN" "$PASS" "$(openssl rand -hex 32)" > .env
  echo "Saved settings to $(pwd)/.env  (family passcode: $PASS)"
else
  echo ".env already exists, keeping it."
fi

# --- 2. start the app ---
docker compose up -d --build
docker image prune -f >/dev/null

# --- 3. Caddy ---
if grep -q "vanshavali (family tree)" "$CADDYFILE"; then
  echo "Caddy already has the family tree block."
else
  cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
  # append (not rewrite) so Caddy's bind-mounted file stays the same file
  sed "s/__DOMAIN__/$DOMAIN/" vanshavali.caddy >> "$CADDYFILE"
  echo "Added $DOMAIN to $CADDYFILE (backup saved next to it)."
fi
cd "$CURIOSAND_DIR"
if docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo
  echo "Done. Open https://$DOMAIN  (the first visit can take up to a minute while the certificate is issued)."
else
  echo "Caddy rejected the new config. Details:"
  docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
  echo "Curiosand is unaffected (Caddy is still running the old config). Send these lines to Claude."
  exit 1
fi
