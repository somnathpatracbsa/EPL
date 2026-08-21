/**
 * EPL Prediction League — Automation Engine
 * Runs on a GitHub Actions schedule (see .github/workflows/sync.yml).
 * Uses the Firebase Admin SDK, so it can write fields (like points) that
 * the browser client is blocked from writing by firestore.rules.
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   FIREBASE_SERVICE_ACCOUNT   - full JSON of a Firebase service account key
 *   FOOTBALL_DATA_API_KEY      - free API key from football-data.org
 */

import admin from 'firebase-admin';

const SCORING = {
  EXACT_SCORE_POINTS: 25,
  CORRECT_OUTCOME_POINTS: 10,
  STREAK_MILESTONES: [3, 5, 10],
  STREAK_BONUS: 5,
  TABLE_MAX_POINTS_PER_TEAM: 20,
  TABLE_POSITION_PENALTY: 2,
  MIDSEASON_GAMEWEEK: 19,
  MIDSEASON_WEIGHT: 0.4,
  FINAL_WEIGHT: 0.6
};

const API_BASE = 'https://api.football-data.org/v4';
const COMPETITION = 'PL';

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, {
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
  });
  if (!res.ok) {
    console.error(`API error ${res.status} for ${path}: ${await res.text()}`);
    return null;
  }
  return res.json();
}

// ---------- 1. Sync fixtures & results ----------
async function syncFixtures() {
  const data = await apiFetch(`/competitions/${COMPETITION}/matches`);
  if (!data || !data.matches) return;

  const batch = db.batch();
  let count = 0;
  for (const m of data.matches) {
    const ref = db.collection('fixtures').doc(String(m.id));
    batch.set(ref, {
      gameweek: m.matchday,
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      kickoffUTC: m.utcDate,
      status: m.status,
      homeScore: m.score.fullTime.home,
      awayScore: m.score.fullTime.away
    }, { merge: true });
    count++;
    if (count % 400 === 0) { await batch.commit(); } // Firestore batch limit safety
  }
  await batch.commit();
  console.log(`Synced ${count} fixtures.`);

  // Update the "current gameweek" config to the earliest non-finished matchday
  const upcoming = data.matches
    .filter(m => m.status !== 'FINISHED')
    .sort((a, b) => a.matchday - b.matchday);
  if (upcoming.length) {
    await db.collection('config').doc('current').set({
      currentGameweek: upcoming[0].matchday
    }, { merge: true });
  }
}

// ---------- 2. Score newly finished matches ----------
async function scoreFinishedMatches() {
  const fixturesSnap = await db.collection('fixtures').where('status', '==', 'FINISHED').get();
  const finished = {};
  fixturesSnap.forEach(d => { finished[d.id] = d.data(); });

  const predsSnap = await db.collection('predictions').where('scored', '==', false).get();
  let scoredCount = 0;
  const batch = db.batch();

  predsSnap.forEach(d => {
    const p = d.data();
    const fx = finished[p.fixtureId];
    if (!fx) return;

    let points = 0;
    if (p.predHome === fx.homeScore && p.predAway === fx.awayScore) {
      points = SCORING.EXACT_SCORE_POINTS;
    } else if (Math.sign(p.predHome - p.predAway) === Math.sign(fx.homeScore - fx.awayScore)) {
      points = SCORING.CORRECT_OUTCOME_POINTS;
    }
    batch.update(d.ref, { points, scored: true });
    scoredCount++;
  });

  if (scoredCount) await batch.commit();
  console.log(`Scored ${scoredCount} predictions.`);
}

// ---------- 3. Rebuild leaderboard ----------
async function updateLeaderboard() {
  const usersSnap = await db.collection('users').get();
  const predsSnap = await db.collection('predictions').get();
  const fixturesSnap = await db.collection('fixtures').get();
  const tablePredsSnap = await db.collection('tablePredictions').get();

  const fixtureGW = {};
  fixturesSnap.forEach(d => { fixtureGW[d.id] = d.data().gameweek; });

  const userPoints = {};
  const userGWHit = {}; // uid -> { gw: true }

  predsSnap.forEach(d => {
    const p = d.data();
    userPoints[p.uid] = (userPoints[p.uid] || 0) + (p.points || 0);
    const gw = fixtureGW[p.fixtureId];
    if (!userGWHit[p.uid]) userGWHit[p.uid] = {};
    if ((p.points || 0) > 0) userGWHit[p.uid][gw] = true;
  });

  const userStreaks = {};
  Object.keys(userGWHit).forEach(uid => {
    const gws = Object.keys(userGWHit[uid]).map(Number).sort((a, b) => b - a);
    let streak = 0, expected = gws[0];
    for (const gw of gws) {
      if (gw === expected && userGWHit[uid][gw]) { streak++; expected--; }
      else break;
    }
    userStreaks[uid] = streak;
  });

  const tablePoints = {};
  tablePredsSnap.forEach(d => {
    const t = d.data();
    if (!t.checkpointPoints) return;
    const total = Object.values(t.checkpointPoints).reduce((a, b) => a + b, 0);
    tablePoints[d.id] = total;
  });

  const rows = [];
  usersSnap.forEach(d => {
    const u = d.data();
    const matchPts = userPoints[d.id] || 0;
    const tablePts = tablePoints[d.id] || 0;
    let streakBonus = 0;
    SCORING.STREAK_MILESTONES.forEach(m => { if ((userStreaks[d.id] || 0) >= m) streakBonus += SCORING.STREAK_BONUS; });
    rows.push({
      uid: d.id,
      displayName: u.displayName,
      email: u.email,
      matchPoints: matchPts,
      tablePoints: tablePts,
      currentStreak: userStreaks[d.id] || 0,
      totalPoints: matchPts + tablePts + streakBonus
    });
  });
  rows.sort((a, b) => b.totalPoints - a.totalPoints);
  rows.forEach((r, i) => r.rank = i + 1);

  const batch = db.batch();
  rows.forEach(r => batch.set(db.collection('leaderboard').doc(r.uid), r));
  await batch.commit();
  console.log(`Leaderboard rebuilt for ${rows.length} users.`);
  return rows;
}

// ---------- 4. Table prediction checkpoint scoring ----------
async function scoreTablePredictions(weight) {
  const data = await apiFetch(`/competitions/${COMPETITION}/standings`);
  if (!data || !data.standings) return;
  const table = data.standings.find(s => s.type === 'TOTAL').table;
  const actualPosition = {};
  table.forEach(t => { actualPosition[t.team.name] = t.position; });

  const snap = await db.collection('tablePredictions').get();
  const batch = db.batch();
  snap.forEach(d => {
    const t = d.data();
    if (!t.teams) return;
    let total = 0;
    t.teams.forEach(entry => {
      const actual = actualPosition[entry.team];
      if (actual === undefined) return;
      total += Math.max(0, SCORING.TABLE_MAX_POINTS_PER_TEAM - SCORING.TABLE_POSITION_PENALTY * Math.abs(entry.predictedPosition - actual));
    });
    const key = weight === SCORING.MIDSEASON_WEIGHT ? 'midseason' : 'final';
    batch.set(d.ref, { checkpointPoints: { [key]: total * weight } }, { merge: true });
  });
  await batch.commit();
  console.log(`Table predictions scored at weight ${weight}.`);
}

// ---------- 5. Badges ----------
async function checkBadges(leaderboardRows) {
  const fixturesSnap = await db.collection('fixtures').where('status', '==', 'FINISHED').get();
  let latestGW = 0;
  const gwFixtureIds = new Set();
  fixturesSnap.forEach(d => { latestGW = Math.max(latestGW, d.data().gameweek); });
  fixturesSnap.forEach(d => { if (d.data().gameweek === latestGW) gwFixtureIds.add(d.id); });
  if (!latestGW) return;

  const predsSnap = await db.collection('predictions').get();
  const gwTotals = {}, perfectCount = {}, gwPredCount = {};
  predsSnap.forEach(d => {
    const p = d.data();
    if (!gwFixtureIds.has(p.fixtureId)) return;
    gwTotals[p.uid] = (gwTotals[p.uid] || 0) + (p.points || 0);
    gwPredCount[p.uid] = (gwPredCount[p.uid] || 0) + 1;
    perfectCount[p.uid] = (perfectCount[p.uid] || 0) + (p.points === SCORING.EXACT_SCORE_POINTS ? 1 : 0);
  });

  const newBadgesByUid = {};
  const addBadge = (uid, name, context) => {
    if (!newBadgesByUid[uid]) newBadgesByUid[uid] = [];
    newBadgesByUid[uid].push({ name, context, awardedAt: new Date().toISOString() });
  };

  let topUid = null, topScore = -1;
  Object.entries(gwTotals).forEach(([uid, score]) => { if (score > topScore) { topScore = score; topUid = uid; } });
  if (topUid) addBadge(topUid, 'Oracle of the Week', `Gameweek ${latestGW}`);

  Object.keys(perfectCount).forEach(uid => {
    if (gwPredCount[uid] > 0 && perfectCount[uid] === gwPredCount[uid]) {
      addBadge(uid, 'Perfect Predictor', `Gameweek ${latestGW}`);
    }
  });

  leaderboardRows.forEach(r => {
    if (r.currentStreak >= 5) addBadge(r.uid, 'Iron Streak', `${r.currentStreak}-gameweek streak`);
    if (r.rank === 1) addBadge(r.uid, 'Table Topper', `As of Gameweek ${latestGW}`);
  });

  const batch = db.batch();
  for (const [uid, newBadges] of Object.entries(newBadgesByUid)) {
    const ref = db.collection('badges').doc(uid);
    const existing = await ref.get();
    const existingBadges = existing.exists && existing.data().badges ? existing.data().badges : [];
    const existingKeys = new Set(existingBadges.map(b => `${b.name}::${b.context}`));
    const toAdd = newBadges.filter(b => !existingKeys.has(`${b.name}::${b.context}`));
    if (toAdd.length) {
      batch.set(ref, { badges: [...existingBadges, ...toAdd] }, { merge: true });
    }
  }
  await batch.commit();
  console.log(`Badge check complete for gameweek ${latestGW}.`);
}

// ---------- Main ----------
async function main() {
  await syncFixtures();
  await scoreFinishedMatches();
  const rows = await updateLeaderboard();

  const configSnap = await db.collection('config').doc('current').get();
  const currentGW = configSnap.exists ? configSnap.data().currentGameweek : null;
  if (currentGW === SCORING.MIDSEASON_GAMEWEEK) {
    await scoreTablePredictions(SCORING.MIDSEASON_WEIGHT);
  }
  // Run scoreTablePredictions(SCORING.FINAL_WEIGHT) once the season is confirmed over —
  // trigger this manually once via workflow_dispatch, or extend main() with a season-end date check.

  await checkBadges(rows);
  console.log('Sync complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
