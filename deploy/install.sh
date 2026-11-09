#!/usr/bin/env bash
# One-time setup on the Curiosand server. Asks nothing.
#   EDIT_CODE=123456 ~/vanshavali/deploy/install.sh            (address: family.<server-ip>.sslip.io)
#   EDIT_CODE=123456 ~/vanshavali/deploy/install.sh tree.example.com   (your own domain, if you ever want one)
# 1. saves the settings (.env) with the 6-digit edit code
# 2. builds and starts the family tree container
# 3. adds the address to Curiosand's Caddy, which fetches an HTTPS certificate (no Cloudflare or DNS needed)
set -euo pipefail
cd "$(dirname "$0")"

CURIOSAND_DIR="${CURIOSAND_DIR:-$HOME/curiosand/deploy}"
CADDYFILE="$CURIOSAND_DIR/Caddyfile"
if [ ! -f "$CADDYFILE" ]; then echo "Can't find $CADDYFILE. Set CURIOSAND_DIR=/path/to/curiosand/deploy and run again."; exit 1; fi
if ! docker network inspect curiosand_default >/dev/null 2>&1; then echo "The Curiosand stack isn't running (no curiosand_default network). Start it first."; exit 1; fi

# --- address: given, or saved earlier, or a free sslip.io name that points at this server ---
DOMAIN="${1:-}"
if [ -z "$DOMAIN" ] && [ -f .env ]; then DOMAIN="$(grep -E '^FAMILY_DOMAIN=' .env | cut -d= -f2- || true)"; fi
if [ -z "$DOMAIN" ]; then
  IP="$( { ip -4 route get 1.1.1.1 2>/dev/null || true; } | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  [ -n "$IP" ] || IP="$( { hostname -I 2>/dev/null || true; } | awk '{print $1}')"
  [ -n "$IP" ] || IP="$(curl -4fsS https://api.ipify.org || true)"
  [ -n "$IP" ] || { echo "Couldn't find this server's IP address. Run again with the address: ./install.sh family.<ip-with-dashes>.sslip.io"; exit 1; }
  DOMAIN="family.${IP//./-}.sslip.io"
fi

# --- 1. settings ---
touch .env && chmod 600 .env
setvar() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
setvar FAMILY_DOMAIN "$DOMAIN"
setvar PROXY_NETWORK curiosand_default
grep -q '^SESSION_SECRET=' .env || setvar SESSION_SECRET "$(openssl rand -hex 32)"
if [ -n "${EDIT_CODE:-}" ]; then
  [[ "$EDIT_CODE" =~ ^[0-9]{6}$ ]] || { echo "EDIT_CODE must be exactly 6 digits."; exit 1; }
  setvar EDIT_CODE "$EDIT_CODE"
elif ! grep -q '^EDIT_CODE=' .env; then
  setvar EDIT_CODE "$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom) % 1000000 )))"
fi

# --- 2. start the app ---
docker compose up -d --build
docker image prune -f >/dev/null

# --- 3. Caddy ---
if grep -q "vanshavali (family tree)" "$CADDYFILE"; then
  # already added earlier: point it at the current address
  # rewrite in place (same file), so the copy mounted into Caddy sees the change
  updated="$(sed "/# --- vanshavali (family tree)/{n;s|^[^ ]* {|$DOMAIN {|}" "$CADDYFILE")"
  printf '%s\n' "$updated" > "$CADDYFILE"
else
  cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
  sed "s/__DOMAIN__/$DOMAIN/" vanshavali.caddy >> "$CADDYFILE"   # append, so Caddy's mounted file stays the same file
fi
cd "$CURIOSAND_DIR"
if docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  echo "Caddy rejected the new config (Curiosand keeps running on the old one). Details:"
  docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
  exit 1
fi
cd - >/dev/null
echo
echo "Done. The family tree is at:   https://$DOMAIN"
echo "Edit code:                     $(grep '^EDIT_CODE=' .env | cut -d= -f2)"
echo "(The first visit can take up to a minute while the HTTPS certificate is issued.)"
