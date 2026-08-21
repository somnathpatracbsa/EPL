# PL Fan Warzone — Prediction Gameroom

A fully free, fully automated Premier League prediction game. No servers, no paid tiers,
no manual admin work once it's running (aside from the one lock/unlock toggle you control).

**Stack:** GitHub Pages (hosting) + Firebase free tier (Google Sign-In + database) + GitHub Actions (free scheduled automation)

This is v2 — if you're setting this up fresh, follow this README start to finish.
If you already had v1 running, see "Upgrading from v1" at the bottom.

---

## What's new in v2
- Renamed to **PL Fan Warzone**
- **Gameweek Extras**: predict the highest-scoring team and a clean-sheet team each gameweek (auto-scored), plus free-text player guesses (bragging rights only — see limitations below)
- **Crowd Pulse**: after you save your own prediction for a match, see the group's win/draw/loss split and most-predicted scorelines
- **Admin table lock**: you (the account matching `ADMIN_EMAIL`) can lock/unlock table predictions for everyone from the Table Predictor tab
- **All Table Picks tab**: browse everyone's predicted final table
- **Community Predictions tab**: every player's scoreline guess for the current gameweek, laid out match by match
- **Season Awards tab**: Golden Boot / Golden Glove / Manager of the Year / Most Red Cards / Most Clean Sheets predictions, with a community tally
- **Player Profiles tab**: this season's squads (name, position, nationality, shirt number), synced weekly
- **Highlights tab**: auto-generated stat highlights each sync (biggest win, highest-scoring match, group leader, closest table prediction)
- **My Profile tab**: your full prediction history with results, accuracy %, and streak
- Mobile-responsive layout throughout

## Honest limitations (free-tier data constraints)
The free football-data.org API gives fixtures, results, standings, and squad lists — but **not** detailed match events like individual goalscorers or red/yellow cards. That means:
- **Top scoring player / clean-sheet keeper** guesses (in Gameweek Extras) are saved and displayed, but **not auto-scored** — treat them as fun, honesty-system bragging rights, or adjudicate manually if you want them to count.
- **Season Awards tab** (Golden Boot, Golden Glove, Manager of the Year, Most Red Cards) is the same — predictions are collected and tallied, but there's no automated "winner" check. You can settle these manually at season end by eye (the actual Golden Boot winner etc. is public knowledge by then).
- **Player Profiles** shows squad info, not live stats (no goals/appearances/cards feed on the free tier).
- **Highlights** are generated from data we do have (results, predictions, leaderboard, table accuracy) — not video clips or news, since that needs a different (paid) data source.

Nothing here is silently faked — anything not backed by real automated data is clearly labeled `manual` in the UI.

---

## 1. Create the GitHub repo
1. Create a new **public** GitHub repo (unlimited free Actions minutes; a private repo's 2,000 free minutes/month is still plenty).
2. Push everything in this folder, preserving structure:
   ```
   index.html
   css/style.css
   js/firebase-config.js
   js/app.js
   automation/sync-and-score.js
   automation/squad-sync.js
   automation/package.json
   firestore.rules
   .github/workflows/sync.yml
   .github/workflows/squad-sync.yml
   ```
3. **Settings → Pages** → Source: `main` branch, root folder.

## 2. Create a free Firebase project
1. **console.firebase.google.com** → Create project (free "Spark" plan).
2. **Authentication** → Sign-in method → enable **Google**.
3. **Firestore Database** → Create database → production mode.
   - ⚠️ Make sure you're creating **Firestore**, not **Realtime Database** — they're separate products in the sidebar with very different rules syntax. If you accidentally create a Realtime Database, you can delete it via its own page's `⋮` menu — it costs nothing to leave unused either way.
4. **Project Settings → General → Your apps** → web icon `</>` → register → copy the `firebaseConfig` object.
5. Paste it into `js/firebase-config.js`, keeping the `export const firebaseConfig = { ... }` wrapper intact.
6. **Set your admin email**: still in `js/firebase-config.js`, set `ADMIN_EMAIL` to your exact Google account email. Then open `firestore.rules` and replace **both** occurrences of `'somnath@example.com'` with that same email, exactly.
7. **Firestore → Rules** tab → paste in `firestore.rules` → Publish.

**Free tier limits:** 50,000 reads / 20,000 writes per day — a 15–50 person league uses a tiny fraction of that.

## 3. Firebase service account (for automation)
1. **Project Settings → Service accounts** (a tab across the top of Settings, not the left sidebar) → **Generate new private key** → downloads a JSON file.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `FIREBASE_SERVICE_ACCOUNT`, Value: the full JSON file contents

## 4. Free football data API key
1. Register at **football-data.org** (free, no card).
2. Copy your token from **My Account**.
3. Add as a GitHub secret: `FOOTBALL_DATA_API_KEY`

## 5. Seed the initial config
Firestore → start a collection `config`, document ID `current`, one field:
```
currentGameweek: 1   (number)
tableLocked: false   (boolean)
```

## 6. Test the automation
GitHub repo → **Actions** tab → **Sync & Score EPL Predictions** → **Run workflow**. A green check means fixtures populated. Also manually run **Weekly Squad Sync** once to populate Player Profiles immediately rather than waiting for Monday.

## 7. Invite your friends
Share your GitHub Pages URL — Google Sign-In creates their profile automatically.

---

## How the admin table lock works
- Only the Google account matching `ADMIN_EMAIL` (in `firebase-config.js`) **and** the matching email hardcoded in `firestore.rules` can toggle the lock — this is enforced server-side by Firestore rules, not just hidden in the UI, so it can't be bypassed from the browser console.
- When locked, everyone else's Table Predictor becomes read-only (dragging disabled, Save button hidden) until you unlock it again.
- Both places must have the *exact same* email or the admin controls will silently fail — double check for typos.

## Running the final-table scoring at season end
The mid-season checkpoint (gameweek 19) is automatic. For the final checkpoint, manually run `scoreTablePredictions(SCORING.FINAL_WEIGHT)` — easiest way is to temporarily change `MIDSEASON_GAMEWEEK` in `sync-and-score.js` to the final gameweek number for one run, or trigger it locally with your secrets set as env vars.

## Customizing scoring, badges, or point values
Everything tunable lives in the `SCORING` object at the top of `automation/sync-and-score.js`.

---

## Upgrading from v1
If you already had the original version running:
1. Replace all files with these new ones (same repo, same Firebase project — no need to start over).
2. Add `ADMIN_EMAIL` to `js/firebase-config.js` and update `firestore.rules` with your email in both spots noted above, then re-publish the rules.
3. Add `tableLocked: false` to your existing `config/current` document in Firestore (Data tab → click the document → Add field).
4. Add the new `.github/workflows/squad-sync.yml` and run it once manually to populate Player Profiles.
5. Push, and you're on v2.
