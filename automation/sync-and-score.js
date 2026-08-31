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
  STREAK_TIERS: [ { min: 10, bonus: 20 }, { min: 5, bonus: 10 }, { min: 3, bonus: 5 } ], // highest tier reached applies — not cumulative
  MIDSEASON_GAMEWEEK: 19,
  MIDSEASON_WEIGHT: 0.3,
  FINAL_WEIGHT: 0.7,
  EXTRA_TEAM_CORRECT_POINTS: 15, // top-scoring-team / clean-sheet-team guesses
  EXTRA_GAME_CORRECT_POINTS: 20  // highest-scoring-game / lowest-scoring-game guesses
};

const API_BASE = 'https://api.football-data.org/v4';
const COMPETITION = 'PL';

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, { headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY } });
  if (!res.ok) {
    console.error(`API fetch failed (${res.status}): ${path}`);
    return null;
  }
  return res.json();
}

// Helper: delays execution for `ms` milliseconds — used to respect free-tier rate limits
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- 1. Sync fixtures & standings ----------
async function syncFixtures() {
  const data = await apiFetch(`/competitions/${COMPETITION}/matches`);
  // We also capture the canonical scores from these Firestore docs. This is critical: when the
  // API glitches and returns TIMED for a finished match, it also returns null scores. If we only
  // corrected the status (as before) but left the null scores in place, scoreFinishedMatches()
  // would either award 0 points to everyone or produce wrong outcomes — the scores it uses to
  // judge predictions would all be null. By pulling the true scores from Firestore here (where
  // they were correctly written during the run that first marked the match FINISHED), we ensure
  // the entire in-memory view is canonical, not just the status field.
  const alreadyFinishedSnap = await db.collection('fixtures').where('status', '==', 'FINISHED').get();
  const alreadyFinishedIds = new Set(alreadyFinishedSnap.docs.map(d => d.id));
  // id -> { homeScore, awayScore } from the last good write — used to restore scores when the
  // API regresses a match back to TIMED/SCHEDULED and sends null scores in the same response.
  const firestoreScores = {};
  alreadyFinishedSnap.docs.forEach(d => {
    const data = d.data();
    firestoreScores[d.id] = { homeScore: data.homeScore, awayScore: data.awayScore };
  });

  // A match cannot still be "not started" hours after its scheduled kickoff — if the API
  // says TIMED or SCHEDULED for a match that kicked off more than 3 hours ago, that is
  // definitively stale/wrong data. 3 hours covers the longest possible match (90 min +
  // stoppage + extra time + penalties + a buffer). We skip writing these to Firestore
  // entirely: the existing Firestore value — whatever it is — is more trustworthy than
  // an API response that claims the match hasn't started yet when it clearly has.
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const nowMs = Date.now();

  const batch = db.batch();
  let count = 0, skippedRegressions = 0, skippedStalePastKickoff = 0;
  // Track match IDs we're skipping due to past-kickoff staleness, so correctedMatches
  // can treat them the same way as alreadyFinishedIds (restore from Firestore if known).
  const stalePastKickoffIds = new Set();
  for (const m of data.matches) {
    const id = String(m.id);
    // Guard 1: already FINISHED in Firestore — never overwrite with a regressed status
    if (alreadyFinishedIds.has(id) && m.status !== 'FINISHED') {
      console.warn(`Skipping match ${id}: already FINISHED in Firestore, but this API response says ${m.status}. Not overwriting — this is likely a transient API glitch or an overlapping run, not a real result reversal.`);
      skippedRegressions++;
      continue;
    }
    // Guard 2: past-kickoff but TIMED/SCHEDULED — the API is returning stale data
    const isPastKickoff = (m.status === 'TIMED' || m.status === 'SCHEDULED') &&
                          (nowMs - new Date(m.utcDate).getTime()) > THREE_HOURS_MS;
    if (isPastKickoff) {
      console.warn(`Skipping match ${id} (${m.homeTeam.name} vs ${m.awayTeam.name}, kickoff ${m.utcDate}): API says ${m.status} but kickoff was >3 hours ago — this is stale API data. Not writing null scores to Firestore.`);
      stalePastKickoffIds.add(id);
      skippedStalePastKickoff++;
      continue;
    }
    const ref = db.collection('fixtures').doc(id);
    // Use existing Firestore scores as a fallback when the API returns null — this guards
    // against the football-data.org API returning status=FINISHED but score=null (which
    // can happen transiently). Guard 1 above only fires when status != FINISHED, so a
    // FINISHED+null response slips through and would otherwise wipe real scores. The
    // concurrency block in sync.yml is the primary race-condition fix; this is a
    // belt-and-suspenders safeguard for the API's own data quality issues.
    const existingScore = firestoreScores[id];
    const homeScore = m.score.fullTime.home ?? existingScore?.homeScore ?? null;
    const awayScore = m.score.fullTime.away ?? existingScore?.awayScore ?? null;
    batch.set(ref, {
      gameweek: m.matchday, homeTeam: m.homeTeam.name, awayTeam: m.awayTeam.name,
      kickoffUTC: m.utcDate, status: m.status,
      homeScore,
      awayScore
    }, { merge: true });
    count++;
    if (count % 400 === 0) await batch.commit();
  }
  await batch.commit();
  const skippedTotal = skippedRegressions + skippedStalePastKickoff;
  console.log(`Synced ${count} fixtures${skippedTotal ? ` (skipped ${skippedRegressions} status-regression${skippedRegressions === 1 ? '' : 's'}, ${skippedStalePastKickoff} stale-past-kickoff)` : ''}.`);

  // AUTO-HEAL PASS — for every match the bulk endpoint returned as TIMED/SCHEDULED despite
  // having a kickoff more than 3 hours ago, fetch the individual match endpoint. The bulk
  // endpoint is more aggressively cached on football-data.org's side and is the root cause
  // of these stale reads; the per-match endpoint (/v4/matches/{id}) bypasses that cache and
  // consistently returns the correct FINISHED result. If confirmed, write straight to Firestore
  // and promote into alreadyFinishedIds so correctedMatches (and everything downstream —
  // scoreFinishedMatches, leaderboard, badges) sees the real result in this same run, with no
  // manual intervention required.
  if (stalePastKickoffIds.size) {
    console.log(`Auto-heal: checking ${stalePastKickoffIds.size} past-kickoff stuck match(es) via individual endpoint...`);
    let healedCount = 0;
    for (const id of stalePastKickoffIds) {
      try {
        // Respect the free-tier rate limit (10 req/min) — bulk + standings + scorers = 3 calls
        // already used; a 400 ms gap keeps us well clear even with several stuck matches.
        await new Promise(r => setTimeout(r, 400));
        const matchData = await apiFetch(`/matches/${id}`);
        if (!matchData || matchData.status !== 'FINISHED') {
          console.warn(`Auto-heal: match ${id} still shows ${matchData?.status ?? 'unknown'} on individual endpoint — cannot auto-fix.`);
          continue;
        }
        const healedHome = matchData.score?.fullTime?.home;
        const healedAway = matchData.score?.fullTime?.away;
        if (healedHome === null || healedHome === undefined) {
          console.warn(`Auto-heal: match ${id} individual endpoint says FINISHED but scores are still null — skipping.`);
          continue;
        }
        // Write the confirmed result to Firestore
        await db.collection('fixtures').doc(id).set(
          { status: 'FINISHED', homeScore: healedHome, awayScore: healedAway },
          { merge: true }
        );
        // Promote into alreadyFinishedIds and firestoreScores so correctedMatches uses this data
        alreadyFinishedIds.add(id);
        firestoreScores[id] = { homeScore: healedHome, awayScore: healedAway };
        stalePastKickoffIds.delete(id);
        healedCount++;
        console.log(`Auto-heal: match ${id} healed — FINISHED ${healedHome}-${healedAway} (confirmed via individual endpoint).`);
      } catch (err) {
        console.error(`Auto-heal: failed for match ${id}: ${err.message}`);
      }
    }
    if (healedCount) console.log(`Auto-heal complete: ${healedCount} match(es) fixed this run.`);
    else console.log('Auto-heal: no matches could be healed from the individual endpoint this run.');
  }

  // Build the corrected in-memory matches array. Any match now in alreadyFinishedIds
  // (either was already there, or was just promoted by the auto-heal pass above) gets its
  // status and scores restored from firestoreScores — overriding whatever null/stale values
  // the bulk API returned. stalePastKickoffIds now only contains matches that were past-kickoff
  // TIMED AND whose individual endpoint also couldn't confirm a result; these are left as-is
  // (the downstream scorer skips them — correct, since we have no verified score yet).
  const correctedMatches = data.matches.map(m => {
    const id = String(m.id);
    if (alreadyFinishedIds.has(id) && m.status !== 'FINISHED') {
      const scores = firestoreScores[id] || {};
      return {
        ...m,
        status: 'FINISHED',
        score: {
          ...m.score,
          fullTime: { home: scores.homeScore ?? m.score.fullTime.home, away: scores.awayScore ?? m.score.fullTime.away }
        }
      };
    }
    return m;
  });

  const upcoming = correctedMatches
    .filter(m => m.status !== 'FINISHED')
    .sort((a, b) => a.matchday - b.matchday);
  if (upcoming.length) {
    await db.collection('config').doc('current').set({ currentGameweek: upcoming[0].matchday }, { merge: true });
  }
  return correctedMatches;
}

// ---------- 2. Score newly finished matches ----------
async function scoreFinishedMatches(fixturesInMemory) {
  const finished = {};
  fixturesInMemory.forEach(f => { if (f.status === 'FINISHED') finished[f.id] = f; });

  const predsSnap = await db.collection('predictions').where('scored', '==', false).get();
  let scoredCount = 0;
  const batch = db.batch();
  predsSnap.forEach(d => {
    const p = d.data();
    const fx = finished[p.fixtureId];
    if (!fx) return;
    let points = 0;
    if (p.predHome === fx.homeScore && p.predAway === fx.awayScore) points = SCORING.EXACT_SCORE_POINTS;
    else if (Math.sign(p.predHome - p.predAway) === Math.sign(fx.homeScore - fx.awayScore)) points = SCORING.CORRECT_OUTCOME_POINTS;
    batch.update(d.ref, { points, scored: true });
    scoredCount++;
  });
  if (scoredCount) await batch.commit();
  console.log(`Scored ${scoredCount} predictions.`);
  return scoredCount;
}

// ---------- 3. Score gameweek extras (top scoring team / clean sheet team / highest & lowest scoring games) ----------
async function scoreGwExtras(allFixtures) {
  // Group finished fixtures by gameweek where the ENTIRE gameweek is finished
  const byGW = {};
  allFixtures.forEach(f => { (byGW[f.gameweek] = byGW[f.gameweek] || []).push(f); });

  const completedGWs = Object.entries(byGW)
    .filter(([, fx]) => fx.every(f => f.status === 'FINISHED'))
    .map(([gw]) => Number(gw));

  let totalScored = 0;
  for (const gw of completedGWs) {
    const fx = byGW[gw];
    const teamGoals = {}; // team -> goals scored that gameweek
    const cleanSheetTeams = new Set();
    fx.forEach(f => {
      teamGoals[f.homeTeam] = (teamGoals[f.homeTeam] || 0) + (f.homeScore || 0);
      teamGoals[f.awayTeam] = (teamGoals[f.awayTeam] || 0) + (f.awayScore || 0);
      if (f.awayScore === 0) cleanSheetTeams.add(f.homeTeam);
      if (f.homeScore === 0) cleanSheetTeams.add(f.awayTeam);
    });
    const maxGoals = Math.max(...Object.values(teamGoals));
    const topScoringTeams = new Set(Object.entries(teamGoals).filter(([, g]) => g === maxGoals).map(([t]) => t));

    // Highest and lowest scoring matches in the gameweek
    const matchGoals = fx.map(f => (f.homeScore || 0) + (f.awayScore || 0));
    const maxMatchGoals = Math.max(...matchGoals);
    const minMatchGoals = Math.min(...matchGoals);
    const highestScoringGameIds = new Set(fx.filter(f => (f.homeScore || 0) + (f.awayScore || 0) === maxMatchGoals).flatMap(f => [String(f.id), Number(f.id)]));
    const lowestScoringGameIds = new Set(fx.filter(f => (f.homeScore || 0) + (f.awayScore || 0) === minMatchGoals).flatMap(f => [String(f.id), Number(f.id)]));

    const extrasSnap = await db.collection('gwExtraPredictions')
      .where('gameweek', '==', gw).where('scored', '==', false).get();
    if (extrasSnap.empty) continue;
    const batch = db.batch();
    extrasSnap.forEach(d => {
      const e = d.data();
      let points = 0;
      if (topScoringTeams.has(e.topScoringTeam)) points += SCORING.EXTRA_TEAM_CORRECT_POINTS;
      if (cleanSheetTeams.has(e.cleanSheetTeam)) points += SCORING.EXTRA_TEAM_CORRECT_POINTS;
      if (e.highestScoringGame && highestScoringGameIds.has(e.highestScoringGame)) points += SCORING.EXTRA_GAME_CORRECT_POINTS;
      if (e.lowestScoringGame && lowestScoringGameIds.has(e.lowestScoringGame)) points += SCORING.EXTRA_GAME_CORRECT_POINTS;
      batch.update(d.ref, { points, scored: true });
    });
    await batch.commit();
    totalScored += extrasSnap.size;
    console.log(`Scored gameweek ${gw} extras for ${extrasSnap.size} entries.`);
  }
  return totalScored;
}

// ---------- 4. Rebuild leaderboard ----------
async function updateLeaderboard(fixturesInMemory) {
  const [usersSnap, predsSnap, tablePredsSnap, extrasSnap] = await Promise.all([
    db.collection('users').get(), db.collection('predictions').get(),
    db.collection('tablePredictions').get(), db.collection('gwExtraPredictions').get()
  ]);

  const fixtureGW = {};
  fixturesInMemory.forEach(f => { fixtureGW[f.id] = f.gameweek; });

  const userPoints = {}, userGWHit = {}, userExtraPoints = {}, userGWPoints = {};
  const userExactCount = {}, userScoredCount = {}, userOutcomeCount = {}, userTotalCount = {};
  predsSnap.forEach(d => {
    const p = d.data();
    userPoints[p.uid] = (userPoints[p.uid] || 0) + (p.points || 0);
    userTotalCount[p.uid] = (userTotalCount[p.uid] || 0) + 1;
    const gw = fixtureGW[p.fixtureId];
    if (!userGWHit[p.uid]) userGWHit[p.uid] = {};
    if ((p.points || 0) > 0) userGWHit[p.uid][gw] = true;

    // Per-GW points breakdown — only count scored predictions so the column
    // shows the points actually awarded, not predictions still awaiting scoring.
    if (p.scored && gw) {
      if (!userGWPoints[p.uid]) userGWPoints[p.uid] = {};
      userGWPoints[p.uid][gw] = (userGWPoints[p.uid][gw] || 0) + (p.points || 0);
    }

    if (p.scored) {
      userScoredCount[p.uid] = (userScoredCount[p.uid] || 0) + 1;
      if (p.points === SCORING.EXACT_SCORE_POINTS) userExactCount[p.uid] = (userExactCount[p.uid] || 0) + 1;
      if (p.points === SCORING.CORRECT_OUTCOME_POINTS) userOutcomeCount[p.uid] = (userOutcomeCount[p.uid] || 0) + 1;
    }
  });
  extrasSnap.forEach(d => {
    const e = d.data();
    userExtraPoints[e.uid] = (userExtraPoints[e.uid] || 0) + (e.points || 0);
  });

  const userStreaks = {};
  Object.keys(userGWHit).forEach(uid => {
    const gws = Object.keys(userGWHit[uid]).map(Number).sort((a, b) => b - a);
    let streak = 0, expected = gws[0];
    for (const gw of gws) { if (gw === expected && userGWHit[uid][gw]) { streak++; expected--; } else break; }
    userStreaks[uid] = streak;
  });

  const tablePoints = {};
  tablePredsSnap.forEach(d => {
    const t = d.data();
    if (!t.checkpointPoints) return;
    tablePoints[d.id] = Object.values(t.checkpointPoints).reduce((a, b) => a + b, 0);
  });

  const rows = [];
  usersSnap.forEach(d => {
    const u = d.data();
    const matchPts = userPoints[d.id] || 0;
    const tablePts = tablePoints[d.id] || 0;
    const extraPts = userExtraPoints[d.id] || 0;
    let streakBonus = 0;
    const currentStreak = userStreaks[d.id] || 0;
    const tier = SCORING.STREAK_TIERS.find(t => currentStreak >= t.min); // tiers are ordered highest-first, so first match wins
    if (tier) streakBonus = tier.bonus;
    const scoredCount = userScoredCount[d.id] || 0;
    const exactCount = userExactCount[d.id] || 0;
    const outcomeCount = userOutcomeCount[d.id] || 0;
    const accuracyPct = scoredCount ? Math.round(((exactCount + outcomeCount) / scoredCount) * 100) : 0;
    rows.push({
      uid: d.id, displayName: u.displayName, email: u.email,
      matchPoints: matchPts, tablePoints: tablePts, extraPoints: extraPts,
      currentStreak: userStreaks[d.id] || 0,
      exactCount, accuracyPct,
      matchesPredicted: userTotalCount[d.id] || 0,
      correctPredictions: exactCount + outcomeCount,
      perfectPredictions: exactCount,
      totalPoints: matchPts + tablePts + extraPts + streakBonus,
      gwPoints: userGWPoints[d.id] || {}
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

// ---------- 5. Table prediction checkpoint scoring (mid-season / final only) ----------
function calculateTableScore(predictedTeams, actualPositions, checkpoint = 'final') {
  const isMid = checkpoint === 'midseason';
  let totalScore = 0;
  let top4PredictedAndActual = 0;
  let relegationPredictedAndActual = 0;

  predictedTeams.forEach(entry => {
    const actual = actualPositions[entry.team];
    if (actual === undefined) return;
    const pred = entry.predictedPosition;
    const diff = Math.abs(pred - actual);

    // Zone tiers:
    // Champion (1st): Mid [120, 60, 30] | Final [300, 120, 60]
    // Top 4 (2-4): Mid [100, 50, 25] | Final [250, 100, 50]
    // European (5-6): Mid [80, 40, 20] | Final [200, 80, 40]
    // Relegation (18-20): Mid [100, 50, 25] | Final [250, 100, 50]
    // Mid-Table (7-17): Mid [60, 30, 15] | Final [150, 60, 30]
    let exactPts = isMid ? 60 : 150;
    let diff1Pts = isMid ? 30 : 60;
    let diff2Pts = isMid ? 15 : 30;

    if (actual === 1 || pred === 1) {
      exactPts = isMid ? 120 : 300;
      diff1Pts = isMid ? 60 : 120;
      diff2Pts = isMid ? 30 : 60;
    } else if ((actual >= 2 && actual <= 4) || (pred >= 2 && pred <= 4)) {
      exactPts = isMid ? 100 : 250;
      diff1Pts = isMid ? 50 : 100;
      diff2Pts = isMid ? 25 : 50;
    } else if ((actual >= 5 && actual <= 6) || (pred >= 5 && pred <= 6)) {
      exactPts = isMid ? 80 : 200;
      diff1Pts = isMid ? 40 : 80;
      diff2Pts = isMid ? 20 : 40;
    } else if ((actual >= 18 && actual <= 20) || (pred >= 18 && pred <= 20)) {
      exactPts = isMid ? 100 : 250;
      diff1Pts = isMid ? 50 : 100;
      diff2Pts = isMid ? 25 : 50;
    }

    if (diff === 0) totalScore += exactPts;
    else if (diff === 1) totalScore += diff1Pts;
    else if (diff === 2) totalScore += diff2Pts;

    // Zone Qualifier Bonus: If predicted and actual are in the same zone, but diff > 2:
    if (pred <= 4 && actual <= 4) {
      top4PredictedAndActual++;
      if (diff > 2) totalScore += (isMid ? 20 : 50);
    }
    if (pred >= 18 && actual >= 18) {
      relegationPredictedAndActual++;
      if (diff > 2) totalScore += (isMid ? 20 : 50);
    }
  });

  // Zone Sweep Bonuses
  if (relegationPredictedAndActual === 3) totalScore += (isMid ? 50 : 150);
  if (top4PredictedAndActual === 4) totalScore += (isMid ? 60 : 150);

  return Math.round(totalScore);
}

async function scoreTablePredictions(checkpoint = 'final') {
  const data = await apiFetch(`/competitions/${COMPETITION}/standings`);
  if (!data || !data.standings) return null;
  const table = data.standings.find(s => s.type === 'TOTAL').table;
  const actualPosition = {};
  table.forEach(t => { actualPosition[t.team.name] = t.position; });

  const snap = await db.collection('tablePredictions').get();
  const batch = db.batch();
  snap.forEach(d => {
    const t = d.data();
    if (!t.teams) return;
    const score = calculateTableScore(t.teams, actualPosition, checkpoint);
    batch.set(d.ref, { checkpointPoints: { [checkpoint]: score } }, { merge: true });
  });
  await batch.commit();
  console.log(`Table predictions scored for checkpoint: ${checkpoint}.`);
  return table;
}

// ---------- 5b. Live standings order (every run — powers row sorting on the site, not scoring) ----------
// ---------- 5c. Top scorers (every run — real per-player data from the free /scorers endpoint) ----------
async function syncTopScorers() {
  const data = await apiFetch(`/competitions/${COMPETITION}/scorers?limit=20`);
  if (!data || !data.scorers) return;
  const items = data.scorers.map(s => ({
    name: s.player?.name || 'Unknown',
    team: s.team?.name || '',
    goals: s.goals ?? 0,
    assists: s.assists ?? null, // not always populated by the API even on this endpoint
    penalties: s.penalties ?? null,
    playedMatches: s.playedMatches ?? null
  }));
  await db.collection('topScorers').doc('current').set({
    items, updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`Top scorers synced (${items.length} players).`);
}

async function syncStandingsOrder() {
  const data = await apiFetch(`/competitions/${COMPETITION}/standings`);
  if (!data || !data.standings) return null;
  const table = data.standings.find(s => s.type === 'TOTAL').table;
  const sorted = table.sort((a, b) => a.position - b.position);
  const standingsOrder = sorted.map(t => t.team.name);

  // Re-added after the earlier removal — that removal was a workaround for data not
  // populating, but the real cause turned out to be the execution-order bug fixed above
  // (this function could silently never run some hours). Only fields the free tier actually
  // provides — no paid-tier-only data.
  const standingsStats = {};
  sorted.forEach(t => {
    standingsStats[t.team.name] = {
      played: t.playedGames ?? null,
      won: t.won ?? null,
      draw: t.draw ?? null,
      lost: t.lost ?? null,
      goalsFor: t.goalsFor ?? null,
      goalsAgainst: t.goalsAgainst ?? null,
      goalDifference: t.goalDifference ?? null,
      points: t.points ?? null,
      form: t.form ?? null // comma-separated e.g. "W,D,L,W,W" — not always populated by the API even here
    };
  });

  await db.collection('config').doc('current').set({ standingsOrder, standingsStats }, { merge: true });
  console.log(`Standings order + stats synced (${standingsOrder.length} teams).`);
  return table;
}

// ---------- 6. Badges ----------
async function checkBadges(leaderboardRows, fixturesInMemory) {
  let latestGW = 0;
  const gwFixtureIds = new Set();
  fixturesInMemory.forEach(f => { if (f.status === 'FINISHED') latestGW = Math.max(latestGW, f.gameweek); });
  fixturesInMemory.forEach(f => { if (f.status === 'FINISHED' && f.gameweek === latestGW) gwFixtureIds.add(f.id); });
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
    if (gwPredCount[uid] > 0 && perfectCount[uid] === gwPredCount[uid]) addBadge(uid, 'Perfect Predictor', `Gameweek ${latestGW}`);
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
    if (toAdd.length) batch.set(ref, { badges: [...existingBadges, ...toAdd] }, { merge: true });
  }
  await batch.commit();
  console.log(`Badge check complete for gameweek ${latestGW}.`);
}

// ---------- 7. Highlights ----------
async function generateHighlights(leaderboardRows, matches, standingsTable) {
  const items = [];
  const finished = (matches || []).filter(m => m.status === 'FINISHED');
  const latestGW = finished.length ? Math.max(...finished.map(m => m.matchday)) : null;
  const gwMatches = finished.filter(m => m.matchday === latestGW);

  if (gwMatches.length) {
    // Biggest win margin
    let biggest = null, biggestMargin = -1;
    gwMatches.forEach(m => {
      const margin = Math.abs(m.score.fullTime.home - m.score.fullTime.away);
      if (margin > biggestMargin) { biggestMargin = margin; biggest = m; }
    });
    if (biggest && biggestMargin > 0) {
      items.push({ icon: '💥', text: `Biggest result of GW${latestGW}: ${biggest.homeTeam.name} ${biggest.score.fullTime.home}-${biggest.score.fullTime.away} ${biggest.awayTeam.name}.` });
    }
    // Highest scoring match
    let highest = null, highestTotal = -1;
    gwMatches.forEach(m => {
      const total = m.score.fullTime.home + m.score.fullTime.away;
      if (total > highestTotal) { highestTotal = total; highest = m; }
    });
    if (highest) {
      items.push({ icon: '🎆', text: `Highest scoring game in GW${latestGW}: ${highest.homeTeam.name} ${highest.score.fullTime.home}-${highest.score.fullTime.away} ${highest.awayTeam.name} (${highestTotal} goals).` });
    }
  }

  // Oracle of the week / perfect predictors
  const topRow = leaderboardRows[0];
  if (topRow) items.push({ icon: '👑', text: `${topRow.displayName} leads the pack with ${topRow.totalPoints} points overall.` });

  // Closest table prediction (if we have current standings)
  if (standingsTable) {
    const actualPosition = {};
    standingsTable.forEach(t => { actualPosition[t.team.name] = t.position; });
    const tablePredsSnap = await db.collection('tablePredictions').get();
    let closestUid = null, closestDiff = Infinity;
    const usersSnap = await db.collection('users').get();
    const usersById = {}; usersSnap.forEach(d => { usersById[d.id] = d.data(); });
    tablePredsSnap.forEach(d => {
      const t = d.data();
      if (!t.teams) return;
      let diff = 0;
      t.teams.forEach(e => { const actual = actualPosition[e.team]; if (actual !== undefined) diff += Math.abs(e.predictedPosition - actual); });
      if (diff < closestDiff) { closestDiff = diff; closestUid = d.id; }
    });
    if (closestUid && usersById[closestUid]) {
      items.push({ icon: '🎯', text: `${usersById[closestUid].displayName} currently has the most accurate final-table prediction in the group.` });
    }
  }

  await db.collection('highlights').doc('current').set({
    gameweek: latestGW, items, updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`Highlights generated: ${items.length} items.`);
}

// ---------- Main ----------
async function main() {
  const matches = await syncFixtures();
  if (!matches) { console.log('No match data returned — aborting run.'); return; }

  const fixturesInMemory = matches.map(m => ({
    id: String(m.id), gameweek: m.matchday, homeTeam: m.homeTeam.name, awayTeam: m.awayTeam.name,
    kickoffUTC: m.utcDate, status: m.status,
    homeScore: m.score.fullTime.home, awayScore: m.score.fullTime.away
  }));

  // RELIABILITY FIX: these used to run as one unguarded sequence — if an earlier step threw
  // (e.g. a transient Firestore read failure), everything after it silently never ran, including
  // the standings/scorers sync. That was very likely why the Table tab's standings order could
  // go stale for extended periods without any visible error. Two changes: (1) standings/scorers
  // sync now runs FIRST, right after the fixtures sync — it's cheap (no Firestore reads at all,
  // just an API call + one tiny doc write) and independent of match scoring, so there's no good
  // reason for it to be blocked by anything else. (2) every step is now wrapped so a failure in
  // one is logged and isolated instead of silently cancelling the rest of the run.
  let standingsTableLive = null;
  try {
    standingsTableLive = await syncStandingsOrder();
    if (standingsTableLive) {
      console.log(`Standings check: top 3 = ${standingsTableLive.slice(0, 3).map(t => t.team.name).join(', ')}`);
    }
  } catch (err) { console.error('syncStandingsOrder failed:', err.message); }

  try { await syncTopScorers(); }
  catch (err) { console.error('syncTopScorers failed:', err.message); }

  let matchesScored = 0, extrasScored = 0;
  try { matchesScored = await scoreFinishedMatches(fixturesInMemory); }
  catch (err) { console.error('scoreFinishedMatches failed:', err.message); }

  try { extrasScored = await scoreGwExtras(fixturesInMemory); }
  catch (err) { console.error('scoreGwExtras failed:', err.message); }

  // config/current read once, used both for the midseason-checkpoint check and to decide
  // whether the expensive full-collection leaderboard rebuild is actually necessary this run.
  const configRef = db.collection('config').doc('current');
  let configData = {};
  try {
    const configSnap = await configRef.get();
    configData = configSnap.exists ? configSnap.data() : {};
  } catch (err) { console.error('config read failed:', err.message); }
  const currentGW = configData.currentGameweek ?? null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const alreadyRebuiltToday = configData.lastLeaderboardRebuildDate === todayStr;

  // QUOTA OPTIMIZATION: updateLeaderboard() (and the badges/highlights steps that depend on
  // its output) do full reads of users/predictions/tablePredictions/gwExtraPredictions —
  // by far the most expensive step in this script. On an hourly schedule that's 24 full
  // rebuilds a day, nearly all of them on hours where literally nothing changed. We only
  // need to rebuild when something was actually scored this run, or at least once a day as
  // a safety net (so the leaderboard/badges/highlights never go more than 24h stale even if
  // something unusual happens, e.g. a mid-gameweek data correction).
  const somethingChanged = matchesScored > 0 || extrasScored > 0;
  const shouldRebuild = somethingChanged || !alreadyRebuiltToday;

  let standingsTable = standingsTableLive;
  if (currentGW === SCORING.MIDSEASON_GAMEWEEK) {
    try { standingsTable = await scoreTablePredictions('midseason'); }
    catch (err) { console.error('scoreTablePredictions failed:', err.message); }
  }

  if (shouldRebuild) {
    try {
      const rows = await updateLeaderboard(fixturesInMemory);
      await checkBadges(rows, fixturesInMemory);
      await generateHighlights(rows, matches, standingsTable);
      await configRef.set({ lastLeaderboardRebuildDate: todayStr }, { merge: true });
      console.log(`Leaderboard rebuilt (reason: ${somethingChanged ? `${matchesScored} match(es) + ${extrasScored} extra(s) scored` : 'daily safety-net refresh'}).`);
    } catch (err) { console.error('Leaderboard/badges/highlights rebuild failed:', err.message); }
  } else {
    console.log('Nothing scored this run and already rebuilt today — skipping the expensive leaderboard/badges/highlights rebuild to save Firestore reads.');
  }
  // Run scoreTablePredictions(SCORING.FINAL_WEIGHT) once the season is confirmed over —
  // trigger manually via workflow_dispatch the week the season ends.

  // Written every run regardless of whether a rebuild happened — the staleness-check workflow
  // uses this to detect if GitHub's scheduler (or the external cron pinger) has gone quiet.
  await configRef.set({ lastSyncAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  console.log('Sync complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
