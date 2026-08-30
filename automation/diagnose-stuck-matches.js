/**
 * Diagnostic — finds matches that are stuck in Firestore.
 *
 * A match is "stuck" when one of these is true:
 *   A) API says FINISHED with real scores, but Firestore says TIMED/SCHEDULED/null scores
 *   B) API says TIMED/SCHEDULED, kickoff was >3h ago, and Firestore also has TIMED (never healed)
 *   C) API says FINISHED, Firestore says FINISHED, but scores differ (data corruption)
 *
 * Outputs a clear table of every stuck match with the API value vs Firestore value,
 * and at the end prints the exact workflow_dispatch inputs to fix each one.
 */

import admin from 'firebase-admin';

const API_BASE    = 'https://api.football-data.org/v4';
const COMPETITION = 'PL';
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, {
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
  });
  if (!res.ok) { console.error(`API error ${res.status} for ${path}: ${await res.text()}`); return null; }
  return res.json();
}

async function main() {
  const now = Date.now();

  // Fetch from both sources in parallel
  const [apiData, firestoreSnap] = await Promise.all([
    apiFetch(`/competitions/${COMPETITION}/matches`),
    db.collection('fixtures').get()
  ]);

  if (!apiData || !apiData.matches) {
    console.error('Failed to fetch from football-data.org API. Check FOOTBALL_DATA_API_KEY.');
    process.exit(1);
  }

  // Build Firestore map: id -> doc data
  const firestoreMap = {};
  firestoreSnap.forEach(d => { firestoreMap[d.id] = d.data(); });

  console.log(`\nAPI returned ${apiData.matches.length} matches.`);
  console.log(`Firestore has ${firestoreSnap.size} fixture docs.\n`);

  const stuck = [];

  for (const m of apiData.matches) {
    const id       = String(m.id);
    const apiStatus = m.status;
    const apiHome   = m.score?.fullTime?.home;
    const apiAway   = m.score?.fullTime?.away;
    const kickoffMs = new Date(m.utcDate).getTime();
    const isPastKickoff = (now - kickoffMs) > THREE_HOURS_MS;

    const fs = firestoreMap[id];
    const fsStatus = fs?.status ?? '(missing)';
    const fsHome   = fs?.homeScore ?? null;
    const fsAway   = fs?.awayScore ?? null;

    // Case A: API says FINISHED with real scores, Firestore disagrees on status OR scores
    if (apiStatus === 'FINISHED' && apiHome !== null && apiAway !== null) {
      if (fsStatus !== 'FINISHED' || fsHome !== apiHome || fsAway !== apiAway) {
        stuck.push({
          id,
          homeTeam:  m.homeTeam.name,
          awayTeam:  m.awayTeam.name,
          kickoff:   m.utcDate,
          gameweek:  m.matchday,
          reason:    fsStatus !== 'FINISHED'
                       ? `Firestore=${fsStatus}, API=FINISHED`
                       : `Score mismatch — Firestore=${fsHome}-${fsAway}, API=${apiHome}-${apiAway}`,
          apiStatus, apiHome, apiAway,
          fsStatus, fsHome, fsAway,
          needsFix: true
        });
      }
      continue;
    }

    // Case B: API says TIMED/SCHEDULED but kickoff was >3h ago AND Firestore is also stuck
    if ((apiStatus === 'TIMED' || apiStatus === 'SCHEDULED') && isPastKickoff) {
      if (fsStatus !== 'FINISHED') {
        const hoursAgo = Math.round((now - kickoffMs) / 3600000);
        stuck.push({
          id,
          homeTeam:  m.homeTeam.name,
          awayTeam:  m.awayTeam.name,
          kickoff:   m.utcDate,
          gameweek:  m.matchday,
          reason:    `API still says ${apiStatus} (kickoff ${hoursAgo}h ago) and Firestore=${fsStatus} — score unknown, needs manual entry`,
          apiStatus, apiHome: null, apiAway: null,
          fsStatus, fsHome, fsAway,
          needsFix: false  // can't auto-fix without knowing the real score
        });
      }
    }
  }

  if (!stuck.length) {
    console.log('✅ No stuck matches found — Firestore and the API are in sync.');
    return;
  }

  // Print results table
  console.log(`⚠️  Found ${stuck.length} stuck match(es):\n`);
  console.log('─'.repeat(100));
  for (const s of stuck) {
    console.log(`Match ID  : ${s.id}`);
    console.log(`Fixture   : GW${s.gameweek} | ${s.homeTeam} vs ${s.awayTeam}`);
    console.log(`Kickoff   : ${s.kickoff}`);
    console.log(`Issue     : ${s.reason}`);
    if (s.needsFix) {
      console.log(`Fix       : API has confirmed result ${s.apiHome}-${s.apiAway} — use Fix Match workflow`);
      console.log(`            match_id=${s.id}  home_score=${s.apiHome}  away_score=${s.apiAway}`);
    } else {
      console.log(`Fix       : Score unknown from API — check a reliable source and use Fix Match workflow manually`);
    }
    console.log('─'.repeat(100));
  }

  // Summary of fix commands for matches where we know the score
  const autoFixable = stuck.filter(s => s.needsFix);
  const manualOnly  = stuck.filter(s => !s.needsFix);

  if (autoFixable.length) {
    console.log('\n🔧 AUTO-FIXABLE (API has the real score — trigger "Fix Match" workflow with these inputs):\n');
    for (const s of autoFixable) {
      console.log(`  GW${s.gameweek} ${s.homeTeam} vs ${s.awayTeam}`);
      console.log(`    match_id=${s.id}  home_score=${s.apiHome}  away_score=${s.apiAway}\n`);
    }
  }

  if (manualOnly.length) {
    console.log('\n🔍 NEEDS MANUAL SCORE LOOKUP (API does not have a result yet):');
    for (const s of manualOnly) {
      console.log(`  GW${s.gameweek} ${s.homeTeam} vs ${s.awayTeam} (kicked off ${s.kickoff})`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
