# The Boot Room — EPL Prediction League

A fully free, fully automated Premier League prediction game for you and your friends.
No servers, no paid tiers, no manual admin work once it's running.

**Stack:** GitHub Pages (hosting) + Firebase free tier (Google Sign-In + database) + GitHub Actions (free scheduled automation)

---

## 1. Create the GitHub repo
1. Create a new **public** GitHub repo (public repos get unlimited free GitHub Actions minutes; private repos get 2,000 free minutes/month, which is still more than enough — 8x/day × 30 days at ~1 min/run is ~240 min/month).
2. Push everything in this folder to it, preserving the structure:
   ```
   index.html
   css/style.css
   js/firebase-config.js
   js/app.js
   automation/sync-and-score.js
   automation/package.json
   firestore.rules
   .github/workflows/sync.yml
   ```
3. Go to **Settings → Pages**, set source to the `main` branch, root folder. Your site will be live at `https://yourusername.github.io/your-repo-name/`.

## 2. Create a free Firebase project
1. Go to **console.firebase.google.com** → Create a project (free "Spark" plan, no credit card needed).
2. **Authentication** → Sign-in method → enable **Google**.
3. **Firestore Database** → Create database → start in production mode (we'll set real rules next).
4. Go to **Project Settings → General → Your apps** → click the web icon `</>` → register your app → copy the `firebaseConfig` object it gives you.
5. Paste that object into `js/firebase-config.js` in your repo, replacing the placeholder values.
6. Go to **Firestore → Rules** and paste in the contents of `firestore.rules` from this project, then Publish. This is what stops anyone from editing their own score by hand — only the automation script (using an admin key) can write points, results, and badges.

**Free tier limits:** Firestore's free tier gives you 50,000 reads and 20,000 writes per day. A 15–50 person league doing this a few times a week uses a tiny fraction of that — you won't hit a paywall.

## 3. Create a Firebase service account (for the automation script)
1. In Firebase Console → **Project Settings → Service accounts** → **Generate new private key**. This downloads a JSON file — keep it secret, never commit it to the repo.
2. In your GitHub repo → **Settings → Secrets and variables → Actions** → **New repository secret**:
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: paste the entire contents of that JSON file

## 4. Get a free football data API key
1. Register at **football-data.org** (free tier, no credit card, 10 requests/minute — plenty for this).
2. Copy your API token.
3. Add it as another GitHub secret:
   - Name: `FOOTBALL_DATA_API_KEY`
   - Value: your token

## 5. Seed the initial config
Firestore needs one starting document so the site knows what gameweek it is. In the Firebase Console → Firestore → start a collection called `config`, with a document ID `current`, containing one field:
```
currentGameweek: 1
```
(The automation script will keep this updated automatically from here on.)

## 6. Turn on the automation
The workflow in `.github/workflows/sync.yml` is already configured to run every 3 hours automatically, for free, using GitHub Actions. Nothing to do here — just make sure the two secrets above are set. You can also trigger it manually any time from the **Actions** tab in your repo (click "Sync & Score EPL Predictions" → "Run workflow") to test it immediately after setup.

That first run will:
- Pull the full season's fixtures into Firestore
- Set the current gameweek
- From then on, auto-score any finished matches and rebuild the leaderboard every 3 hours

## 7. Invite your friends
Share your GitHub Pages URL. Anyone who signs in with Google automatically gets a profile — no invite system, no manual account creation needed.

---

## How the automation works (no admin work, ever)
- **Every 3 hours**, a GitHub Actions job (free, scheduled, serverless) runs `automation/sync-and-score.js`:
  1. Pulls the latest fixtures & results from football-data.org
  2. Scores any predictions for matches that just finished (25 pts exact score, 10 pts correct outcome)
  3. Rebuilds the leaderboard (streaks, table points, totals, ranks)
  4. At gameweek 19, scores everyone's final-table predictions against the actual mid-season table
  5. Checks for and awards badges (Oracle of the Week, Perfect Predictor, Iron Streak, Table Topper)
- The **browser app never has permission to write points, results, or badges** (enforced by `firestore.rules`) — only the automation script can, using its admin key. So there's no way for anyone (including you) to need to manually adjudicate or for a friend to fudge their own score.

## Running the final-table scoring at season end
The mid-season checkpoint (gameweek 19) is automatic. For the final table checkpoint, either:
- Add a date check to `main()` in `sync-and-score.js` comparing today's date to the known EPL season-end date, or
- Just trigger it once manually: go to Actions → run the workflow, or run `scoreTablePredictions(SCORING.FINAL_WEIGHT)` locally with your secrets set as env vars, the week the season ends.

## Customizing scoring or badges
Everything tunable lives in the `SCORING` object at the top of `automation/sync-and-score.js` — point values, streak milestones, table-prediction weighting. Change it, commit, done — no redeploy needed since GitHub Actions always runs the latest committed version.

## A note on the team list for Table Predictor
`js/app.js` has a hardcoded `PL_TEAMS_DEFAULT` list for this season's 20 clubs. Update it each summer when promotion/relegation changes the league.
