# Vanshavali: family tree

A shared family tree. Add people anywhere (parents above, children below, spouses and siblings beside them),
open anyone's card for their details and relationships, and switch the whole app between **English and हिन्दी**.

- Names, places, gotra, occupation and notes can be filled in English, Hindi or both. Each viewer sees the
  version for the language they pick (EN / हिं at the top) and falls back to the other if only one was filled in.
- In Hindi, relationships use the specific kinship terms: दादा/नाना, चाचा/ताऊ/बुआ/मामा/मौसी, देवर/जेठ/ननद,
  साला/साली, भाभी/जीजा, भतीजा/भांजा, चचेरे/ममेरे/फुफेरे/मौसेरे भाई-बहन, and so on.
- Square photo per person (resized in the browser to 320×320 JPEG).
- Live updates: everyone with the page open sees changes immediately.
- Anyone with the link can view; changing anything needs a 6-digit edit code.
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
# edit code for local runs: 123456
```

Opening `app/index.html` directly as a file also works. It then saves only in that browser.

## Deploy on the Curiosand droplet (143.110.189.112)

No domain, DNS or Cloudflare needed. The address is a free `sslip.io` name that points straight at the
server's IP (`https://family.143-110-189-112.sslip.io`), and Curiosand's Caddy gets the HTTPS certificate.
The family tree runs as its own Docker Compose project (`vanshavali`) with its own data. It only adds one
site block to Curiosand's `Caddyfile` and reloads Caddy; Curiosand itself is not restarted.

In Termius on the server (put your 6-digit edit code in place of `<6-digit-code>`):

```bash
git clone -b claude/vanshavali-app https://github.com/AnshulNBhatt/family-tree.git ~/vanshavali
EDIT_CODE=<6-digit-code> ~/vanshavali/deploy/install.sh
```

The script prints the address and the edit code when it's done. Share the address with the family; give the
code only to the people who should be able to edit.

The clone command above needs the repo to be public (it holds only code: the family's data and the edit code
live only on the server). To keep it private instead, give the server a read-only deploy key first:
`ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_family && cat ~/.ssh/github_family.pub`, add that line under
**family-tree → Settings → Deploy keys**, then
`printf 'Host github-family\n  HostName github.com\n  IdentityFile ~/.ssh/github_family\n' >> ~/.ssh/config`
and clone from `git@github-family:AnshulNBhatt/family-tree.git` instead.

### Who can do what

- **Anyone with the link** can see the whole tree and everyone's details.
- **Editing** (adding people, changing details, photos, links) needs the 6-digit edit code. Tap the lock
  button (or **Edit** in the bottom bar on a phone), enter the code once, and that phone or computer stays
  unlocked. Tap the lock again to lock it. The server refuses any change without the code, and stops
  accepting guesses after 8 wrong tries from one place (15 minutes) or 100 in total (an hour).
- Optional: to stop people without a passcode from even viewing, add `FAMILY_PASSCODE=something` to
  `~/vanshavali/deploy/.env` and run `cd ~/vanshavali/deploy && docker compose up -d`.

### Later

```bash
cd ~/vanshavali/deploy && ./update.sh    # get the latest version (a few seconds, data kept)
cd ~/vanshavali/deploy && ./backup.sh    # save everything to deploy/backups/
docker compose logs -f                   # see what the app is doing (run inside ~/vanshavali/deploy)
```

To change the edit code: `EDIT_CODE=123456 ~/vanshavali/deploy/install.sh` (everyone who had editing
unlocked will need the new code).

**Note for Curiosand updates:** `install.sh` appends a block to `~/curiosand/deploy/Caddyfile`. If a future
Curiosand update also changes that file, `git pull` there will refuse to run. To fix it:
`cd ~/curiosand/deploy && git stash && ./update.sh && git stash pop`, then
`docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
