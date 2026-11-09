# Vanshavali: family tree

A shared family tree. Add people anywhere (parents above, children below, spouses and siblings beside them),
open anyone's card for their details and relationships, and switch the whole app between **English and हिन्दी**.

- Names, places, gotra, occupation and notes can be filled in English, Hindi or both. Each viewer sees the
  version for the language they pick (EN / हिं at the top) and falls back to the other if only one was filled in.
- In Hindi, relationships use the specific kinship terms: दादा/नाना, चाचा/ताऊ/बुआ/मामा/मौसी, देवर/जेठ/ननद,
  साला/साली, भाभी/जीजा, भतीजा/भांजा, चचेरे/ममेरे/फुफेरे/मौसेरे भाई-बहन, and so on.
- Square photo per person (resized in the browser to 320×320 JPEG).
- Live updates: everyone with the page open sees changes immediately.
- One family passcode protects the whole tree. Anyone with the passcode can view and edit.
- Built for phones first: on a phone the **Family** view shows one person with their parents above and spouse,
  children and siblings below as large tappable cards (tap anyone to move to them). The **Tree** view shows
  everyone at once with pinch-zoom. Details and forms open full-screen with a sticky Back bar and Save button.

## What's in here

| Path | What it is |
| --- | --- |
| `app/index.html` | The whole front end (one file, no build step, phone-first). Also runs as a claude.ai artifact. |
| `server.js` | Tiny Node server, no dependencies. Serves the page and the `/api` for the tree. |
| `Dockerfile` | `node:22-alpine` image, about 50 MB, about 40 MB of RAM in use. |
| `deploy/` | Production setup for the Curiosand DigitalOcean droplet (see below). |

Data is stored in `DATA_DIR` (`/data` in Docker): `state.json` for people and relationships, and
`photos/<id>.jpg` for photos.

## Run locally

```bash
npm run dev            # http://localhost:3000, no passcode, data in ./data
FAMILY_PASSCODE=test npm run dev
```

Opening `app/index.html` directly as a file also works. It then saves only in that browser.

## Deploy on the Curiosand droplet (143.110.189.112)

The family tree runs as its **own** Docker Compose project (`vanshavali`) with its own data volume. It shares
only Curiosand's Caddy, which already owns ports 80/443 and the HTTPS certificates. `install.sh` adds one site
block to Curiosand's `Caddyfile` and reloads Caddy without restarting anything.

1. **Cloudflare DNS:** add an `A` record, name `family` (or whatever subdomain you want), value
   `143.110.189.112`, proxied (orange cloud).
2. **Deploy key** (on the server, in Termius). GitHub allows one repo per deploy key, so this repo gets its own:
   ```bash
   ssh-keygen -t ed25519 -N "" -C "vanshavali-server" -f ~/.ssh/github_family && cat ~/.ssh/github_family.pub
   ```
   On GitHub: **family-tree → Settings → Deploy keys → Add deploy key**, paste the line, leave write access off.
   Then:
   ```bash
   printf 'Host github-family\n  HostName github.com\n  IdentityFile ~/.ssh/github_family\n  IdentitiesOnly yes\n' >> ~/.ssh/config
   git clone -b claude/vanshavali-app git@github-family:AnshulNBhatt/family-tree.git ~/vanshavali
   ```
3. **Install:**
   ```bash
   cd ~/vanshavali/deploy && ./install.sh family.curiosand.com
   ```
   It asks you to choose the family passcode, starts the app, and adds the address to Caddy.
4. Open `https://family.curiosand.com` and enter the passcode.

### Later

```bash
cd ~/vanshavali/deploy && ./update.sh    # get the latest version (a few seconds, data kept)
cd ~/vanshavali/deploy && ./backup.sh    # save everything to deploy/backups/
docker compose logs -f                   # see what the app is doing (run inside ~/vanshavali/deploy)
nano .env                                # change the passcode, then: docker compose up -d
```

Changing the passcode signs everyone out, and they'll need the new one.

**Note for Curiosand updates:** `install.sh` appends a block to `~/curiosand/deploy/Caddyfile`. If a future
Curiosand update also changes that file, `git pull` there will refuse to run. To fix it:
`cd ~/curiosand/deploy && git stash && ./update.sh && git stash pop`, then
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
