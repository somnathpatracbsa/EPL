/**
 * Squad Sync — populates the Player Profiles tab.
 * Runs weekly (see .github/workflows/squad-sync.yml), separate from the main
 * 3-hourly sync, since squads barely change and this keeps API usage low.
 *
 * NOTE ON DATA DEPTH: the free football-data.org tier gives name, position,
 * nationality, date of birth, and shirt number per player — no season stats
 * (appearances, goals, cards). Real per-player stats need a paid tier or a
 * different data source; the Player Profiles tab is intentionally a squad
 * directory rather than a stats page for that reason.
 */

import admin from 'firebase-admin';

const API_BASE = 'https://api.football-data.org/v4';
const COMPETITION = 'PL';

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, { headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY } });
  if (!res.ok) { console.error(`API error ${res.status} for ${path}: ${await res.text()}`); return null; }
  return res.json();
}

async function main() {
  const data = await apiFetch(`/competitions/${COMPETITION}/teams`);
  if (!data || !data.teams) { console.error('No team data returned — aborting squad sync.'); return; }

  const batch = db.batch();
  let count = 0;
  for (const team of data.teams) {
    (team.squad || []).forEach(player => {
      const ref = db.collection('players').doc(String(player.id));
      batch.set(ref, {
        name: player.name,
        position: player.position || '',
        nationality: player.nationality || '',
        dateOfBirth: player.dateOfBirth || '',
        shirtNumber: player.shirtNumber || null,
        team: team.name
      }, { merge: true });
      count++;
    });
  }
  await batch.commit();
  console.log(`Squad sync complete: ${count} players across ${data.teams.length} teams.`);
}

main().catch(err => { console.error(err); process.exit(1); });
