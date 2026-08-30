/**
 * Manual match corrector — called by .github/workflows/fix-match.yml
 *
 * Reads MATCH_ID, HOME_SCORE, AWAY_SCORE from env vars (set by the workflow inputs).
 * 1. Writes FINISHED + correct scores to the fixtures doc
 * 2. Scores any predictions for that fixture that are still marked scored=false
 *
 * After this runs, trigger the main "Sync & Score EPL Predictions" workflow to
 * rebuild the leaderboard, badges and highlights.
 */

import admin from 'firebase-admin';

const MATCH_ID   = process.env.MATCH_ID;
const HOME_SCORE = Number(process.env.HOME_SCORE);
const AWAY_SCORE = Number(process.env.AWAY_SCORE);

if (!MATCH_ID || isNaN(HOME_SCORE) || isNaN(AWAY_SCORE)) {
  console.error('Missing or invalid env vars. Need MATCH_ID, HOME_SCORE, AWAY_SCORE.');
  process.exit(1);
}

const EXACT_SCORE_POINTS   = 25;
const CORRECT_OUTCOME_POINTS = 10;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

async function main() {
  console.log(`Fixing match ${MATCH_ID}: ${HOME_SCORE}-${AWAY_SCORE} (FINISHED)`);

  // 1. Update the fixture document
  const fixtureRef = db.collection('fixtures').doc(MATCH_ID);
  const beforeSnap = await fixtureRef.get();
  if (!beforeSnap.exists) {
    console.warn(`Warning: fixture ${MATCH_ID} does not exist in Firestore yet — will create it.`);
  } else {
    const b = beforeSnap.data();
    console.log(`  Before: status=${b.status}, homeScore=${b.homeScore}, awayScore=${b.awayScore}`);
  }

  await fixtureRef.set({
    status: 'FINISHED',
    homeScore: HOME_SCORE,
    awayScore: AWAY_SCORE
  }, { merge: true });

  const afterSnap = await fixtureRef.get();
  const a = afterSnap.data();
  console.log(`  After:  status=${a.status}, homeScore=${a.homeScore}, awayScore=${a.awayScore}`);

  // 2. Score any unscored predictions for this fixture
  const predsSnap = await db.collection('predictions')
    .where('fixtureId', '==', MATCH_ID)
    .where('scored', '==', false)
    .get();

  if (predsSnap.empty) {
    console.log('No unscored predictions found for this fixture — nothing to score.');
    return;
  }

  const batch = db.batch();
  let scoredCount = 0;
  predsSnap.forEach(d => {
    const p = d.data();
    let points = 0;
    if (p.predHome === HOME_SCORE && p.predAway === AWAY_SCORE) {
      points = EXACT_SCORE_POINTS;
    } else if (Math.sign(p.predHome - p.predAway) === Math.sign(HOME_SCORE - AWAY_SCORE)) {
      points = CORRECT_OUTCOME_POINTS;
    }
    console.log(`  ${p.uid}: predicted ${p.predHome}-${p.predAway} -> ${points} pts`);
    batch.update(d.ref, { points, scored: true });
    scoredCount++;
  });

  await batch.commit();
  console.log(`\nScored ${scoredCount} predictions for match ${MATCH_ID}.`);

  // Clear lastLeaderboardRebuildDate so the next sync run is forced to do a full leaderboard
  // rebuild even if it already rebuilt earlier today. Without this, the sync sees
  // "Scored 0 predictions this run + already rebuilt today" and skips the rebuild, leaving
  // the leaderboard stale despite the predictions having just been scored here.
  await db.collection('config').doc('current').set(
    { lastLeaderboardRebuildDate: null },
    { merge: true }
  );
  console.log('Cleared lastLeaderboardRebuildDate — the next sync will force a full leaderboard rebuild.');
  console.log('Now trigger "Sync & Score EPL Predictions" to rebuild the leaderboard, badges and highlights.');
}

main().catch(err => { console.error(err); process.exit(1); });
