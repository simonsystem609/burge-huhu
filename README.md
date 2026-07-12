# Bürge · Hühü 🃏

A Hungarian trump card game (a.k.a. *birge / süsü / küldőcske / ötös hülü*) built with
**Node.js + Express + Socket.io**. Play **singleplayer** against bots or **multiplayer**
online with a room code. Bilingual UI (**Magyar / English**).

## The game in one line
Get rid of your cards. The last player still holding cards is the **bürge** (loser). 🙈

## Rules implemented
- 32-card Hungarian deck. Suits: **Tök, Makk, Zöld, Piros**.
  Ranks weak→strong: **VII, VIII, IX, X, Alsó, Felső, Király, Ász**.
- Deal 5 each. The flipped card's **suit is trump (adu)**; it sits at the bottom of the
  draw pile (drawn last).
- The **attacker** plays a card; the **defender** must **beat** it (higher card of the
  same suit, or any trump / a higher trump) or **pick it up**.
  - Beaten → cards discarded, the defender leads next.
  - Picked up → the defender is skipped, the next player leads.
- After each round, refill to 5 while the pile lasts.
- The **trump VII** can be swapped for the face-up trump card on your turn.
- When the pile is empty, a player who empties their hand is out; the last one holding
  cards is the bürge.

> Folk rules vary by region. This is one clean, consistent interpretation — tweak
> `game/engine.js` to match your house rules.

## Run locally
Requires Node.js 18+.

```bash
npm install
npm start
# open http://localhost:3000
```

To test multiplayer on one machine, open the URL in two browser tabs/windows: create a
room in one, join with the code in the other. Or just use **Singleplayer** vs bots.

Run the engine self-test (a full simulated game, no server needed):

```bash
npm test   # if you add the script, or:
node test/smoke.js
```

## Project layout
```
server.js          Express + Socket.io wiring, bot turn driver
game/deck.js       32-card deck, shuffle, beat logic
game/engine.js     pure rules: deal, legal moves, apply move, win/lose
game/bot.js        heuristic AI opponent
game/rooms.js      lobby / room / seat management
public/            front-end (vanilla JS, no build step)
public/cards_img/  cropped card-face photos — see CREDIT.txt (CC BY-SA 4.0)
```

## Deploy to Render — no GitHub needed (Docker image)

Glitch ended app hosting on **8 July 2025**. Render normally deploys from a connected
GitHub/GitLab/Bitbucket repo, but it *also* accepts a **prebuilt Docker image from a
registry** — that path needs no git hosting at all. This repo already has a `Dockerfile`.

1. **Install Docker Desktop** (docker.com) and **create a free Docker Hub account**
   (hub.docker.com) — this is the only account you need; it's just an image registry,
   not a code host.
2. Build and push the image (replace `yourdockerhubname`):
   ```bash
   docker login
   docker build -t yourdockerhubname/burge-huhu:latest .
   docker push yourdockerhubname/burge-huhu:latest
   ```
3. On [render.com](https://render.com): **New + → Web Service → Deploy an existing
   image from a registry** → paste `docker.io/yourdockerhubname/burge-huhu:latest` →
   pick the **Free** instance type → **Create Web Service**.
4. Render assigns a public URL (`https://<name>.onrender.com`) — share that link with
   friends to play online. Render injects `PORT` automatically; the server already
   reads `process.env.PORT`.

**To update after code changes:** rebuild + push the image (step 2), then click
**Manual Deploy → Deploy latest image** on the Render service page. No auto-deploy on
this path — that's the tradeoff for skipping git hosting.

**Free-tier caveat:** Render's free web services spin down after ~15 minutes with no
traffic and cold-start (~30–60s) on the next request. Fine for casual play; if that's
annoying, Render's cheapest paid tier removes it.

### Alternative: still deploy from git, just not GitHub
Render's **"Public Git Repository"** option (dashboard → New + → Web Service → *Public
Git Repository*) accepts a URL from **any** host, not just GitHub — e.g. a public
GitLab.com or Bitbucket repo, no Render/GitHub account linking required. Same manual
redeploy tradeoff as the Docker path (no push-to-deploy).

Other hosts that also work here (all support WebSockets): **Railway**, **Fly.io**,
**Replit**. Anything serverless (plain Vercel/Netlify functions) is **not** suitable —
Socket.io needs a long-lived connection.

## Env vars
- `PORT` — server port (default 3000; set by the host).
- `BOT_DELAY_MS` — delay between bot moves in ms (default 850).
- `ALLOWED_ORIGIN` — restricts Socket.IO's CORS to this origin (comma-separate for more
  than one), e.g. `https://your-app.onrender.com`. Unset by default, which stays fully
  permissive (`*`) — set this once you know your deployed URL to lock it down.
- `MAX_ROOMS` — hard cap on total rooms across both games (default 500), to bound memory
  growth from room spam.
- `GAME_LOG` — `1`/`0` to force the local training-log writer on/off, overriding the
  default (on outside Render, off on Render — see `game/gamelog.js`).

## Reconnection
If your connection drops mid-game, the client automatically tries to rejoin. A bot
takes over your seat temporarily until you reconnect (within the same session).
Your room code is stored in `localStorage` so a page refresh won't lose your spot.

## Development

```bash
npm run lint     # ESLint
npm test         # smoke test (900 simulated games)
npm run dev      # auto-restart on file changes
```

CI runs `npm test` and `npm run lint` on every push via GitHub Actions.

## License
Code is [MIT](LICENSE). Image assets are licensed separately — see
[MEDIA-LICENSES.md](MEDIA-LICENSES.md).
