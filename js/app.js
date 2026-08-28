import { firebaseConfig, ADMIN_EMAIL } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
let currentGW = null;
let usersCache = null; // uid -> {displayName, email}
let standingsOrder = null; // array of team names, current real standings order (may be null pre-season)
let fixturesCache = null; // full fixtures collection, cached — see getAllFixtures()
let fixturesCacheTime = 0;
const FIXTURES_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — automation only updates Firestore hourly, so this stays fresh enough while cutting reload-driven reads a lot further

// QUOTA NOTE: this used to be called separately (as an unfiltered getDocs) from three different
// places — every page load (loadFixtures), every visit to Games (loadCommunity), and every visit
// to My Profile (loadProfile). With ~380 season fixtures, that meant up to 3×380 Firestore reads
// per user per session, which was the dominant cause of exhausting the free daily read quota.
// This shared, short-lived cache means one real Firestore read serves all three for 5 minutes.
const FIXTURES_LOCALSTORAGE_KEY = 'eplFixturesCache_v1';

async function getAllFixtures(forceRefresh = false) {
  if (!forceRefresh && fixturesCache && (Date.now() - fixturesCacheTime < FIXTURES_CACHE_TTL_MS)) {
    return fixturesCache; // in-memory hit — same page load, no reload happened
  }

  // QUOTA OPTIMIZATION: an in-memory cache alone resets on every page reload, which is a
  // normal thing people do (and happened a lot during testing) — each reload was re-reading
  // the entire ~380-doc fixtures collection again. Persisting in localStorage means a reload
  // within the TTL window costs zero Firestore reads instead of ~380.
  if (!forceRefresh) {
    try {
      const stored = JSON.parse(localStorage.getItem(FIXTURES_LOCALSTORAGE_KEY) || 'null');
      if (stored && (Date.now() - stored.time < FIXTURES_CACHE_TTL_MS)) {
        fixturesCache = stored.data;
        fixturesCacheTime = stored.time;
        return fixturesCache;
      }
    } catch (err) {
      // localStorage can be unavailable/restricted (e.g. some in-app browsers) — fall through to a normal fetch
      console.warn('localStorage fixtures cache unavailable, fetching fresh:', err);
    }
  }

  const snap = await getDocs(collection(db, 'fixtures'));
  fixturesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  fixturesCacheTime = Date.now();
  try {
    localStorage.setItem(FIXTURES_LOCALSTORAGE_KEY, JSON.stringify({ data: fixturesCache, time: fixturesCacheTime }));
  } catch (err) {
    // Non-fatal — worst case we just don't get the reload-persistence benefit this session
  }
  return fixturesCache;
}

const PL_TEAMS_DEFAULT = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton & Hove Albion", "Chelsea",
  "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City", "Ipswich Town",
  "Leeds United", "Liverpool", "Manchester City", "Manchester United", "Newcastle United",
  "Nottingham Forest", "Sunderland", "Tottenham Hotspur"
]; // 2026-27 season — confirmed promoted: Coventry, Ipswich, Hull. Relegated: West Ham, Burnley, Wolves

const BADGE_ICONS = {
  'Oracle of the Week': '🔮', 'Perfect Predictor': '🎯', 'Giant Killer': '⚡',
  'Iron Streak': '🔥', 'Table Topper': '👑'
};

// ---------- In-app browser detection (best effort — UA strings for these aren't 100% reliable, ----------
// ---------- so this is a helpful nudge, not a hard block) ----------
(function detectInAppBrowser() {
  const ua = navigator.userAgent || '';
  const isInApp = /WhatsApp|Instagram|FBAN|FBAV|Line\//i.test(ua);
  if (isInApp) {
    const el = document.getElementById('inAppBrowserWarning');
    if (el) el.style.display = 'block';
  }
})();

// ---------- Tabs ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(btn.dataset.tab).classList.add('active');

  if (btn.dataset.tab === 'allTables') loadAllTables();
  if (btn.dataset.tab === 'community') loadCommunity();
  if (btn.dataset.tab === 'highlights') loadHighlights();
  if (btn.dataset.tab === 'awards') { loadAwardsCommunity(); loadAwardsScorersRef(); }
  if (btn.dataset.tab === 'profile') loadProfile();
  if (btn.dataset.tab === 'home') loadHome();
});

async function loadHome() {
  const list = document.getElementById('homePlayerList');
  if (!list) return;
  try {
    const users = await getUsersMap();
    const names = Object.values(users).map(u => u.displayName).filter(Boolean).sort();
    list.innerHTML = names.length
      ? names.map(n => `<span class="home-player-chip">${n}</span>`).join('')
      : '<p class="empty-state">No players have signed in yet — be the first!</p>';
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Couldn\'t load the player list right now.</p>';
  }
}

// ---------- Fun UI: celebration flash ----------
function celebrate(message) {
  const el = document.getElementById('celebrate');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

function avatarHTML(uid, users, size) {
  size = size || '24px';
  const u = (users && users[uid]) || {};
  if (u.photoURL) {
    return `<img src="${u.photoURL}" class="avatar-img" style="width:${size};height:${size};" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
  }
  const initial = (u.displayName || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="avatar-fallback" style="width:${size};height:${size};">${initial}</span>`;
}

function kitColor(teamName) {
  const colors = ['#e64545', '#8b5cf6', '#4cbf7a', '#ffb627', '#3b82f6', '#ec4899', '#14b8a6'];
  let hash = 0;
  for (let i = 0; i < teamName.length; i++) hash = teamName.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function positionZoneClass(pos, total) {
  if (pos == null || isNaN(pos) || !total) return '';
  if (pos <= 4) return 'zone-top4';
  if (pos >= total - 2) return 'zone-bottom3'; // last 3 places
  if (pos === 5 || pos === 6) return 'zone-mid';
  return '';
}

// Shared team-name normalizer, used everywhere we match a name from the API against a name
// saved in a prediction. Brighton needs a manual alias since its short/common name ("Brighton")
// doesn't survive normal FC/AFC-suffix stripping against the API's full "Brighton & Hove Albion
// FC" — this was the root cause of a scrambled Table tab (a failed match cascaded into every
// other team's position shifting). orderTeams() below previously did an exact-string match with
// no normalization at all, which likely never correctly matched any team against the API names.
const NAME_ALIASES = { 'brighton': 'brightonhovealbion' };
function normalizeTeamName(name) {
  let n = String(name || '').toLowerCase().replace(/fc|afc|&/g, '').replace(/[^a-z0-9]/g, '').trim();
  return NAME_ALIASES[n] || n;
}

function getActualRank(teamName) {
  if (!standingsOrder || !standingsOrder.length) return null;
  const norm = normalizeTeamName(teamName);
  const idx = standingsOrder.findIndex(s => normalizeTeamName(s) === norm);
  return idx === -1 ? null : idx + 1;
}

function orderTeams(teams) {
  if (!standingsOrder || !standingsOrder.length) return [...teams].sort();
  const rankOf = (teamName) => {
    const norm = normalizeTeamName(teamName);
    const idx = standingsOrder.findIndex(s => normalizeTeamName(s) === norm);
    return idx === -1 ? Infinity : idx;
  };
  return [...teams].sort((a, b) => rankOf(a) - rankOf(b));
}

function matchStatusLine(fx, locked) {
  if (fx.status === 'FINISHED') return `FT: ${fx.homeScore}–${fx.awayScore}`;
  if (fx.status === 'IN_PLAY' || fx.status === 'PAUSED') {
    return `🔴 LIVE: ${fx.homeScore ?? 0}–${fx.awayScore ?? 0} (as of last sync — syncs about once an hour)`;
  }
  return `${new Date(fx.kickoffUTC).toLocaleString()}${locked ? ' · LOCKED' : ''}`;
}

// ---------- Auth ----------
document.getElementById('signInBtn').addEventListener('click', () => {
  signInWithPopup(auth, provider).catch(err => console.error('Sign-in failed:', err));
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const authArea = document.getElementById('authArea');
  if (user) {
    authArea.innerHTML = `
      <span style="margin-right:12px; font-size:14px;">${user.displayName}${user.email === ADMIN_EMAIL ? ' <span style="color:var(--amber); font-family:var(--font-mono); font-size:10px;">ADMIN</span>' : ''}</span>
      <button id="signOutBtn" class="btn btn-secondary">Sign out</button>
    `;
    document.getElementById('signOutBtn').addEventListener('click', () => signOut(auth));
    try {
      await ensureUserDoc(user);
    } catch (err) {
      console.error('ensureUserDoc error:', err);
      // Non-fatal — still try to load the tabs below even if the profile write failed
    }
    document.getElementById('adminLockControls').style.display = (user.email === ADMIN_EMAIL) ? 'flex' : 'none';
    // These three don't depend on each other's results, so run them concurrently instead of
    // one-after-another — this alone roughly halves time-to-interactive on slower connections.
    // Each of the three now handles its own errors internally and renders a visible message on
    // failure, so one broken load can no longer leave another tab silently stuck/blank.
    try {
      await Promise.all([loadFixtures(), loadTablePredictor(), setupAwardsForm()]);
    } catch (err) {
      console.error('Sign-in load sequence error:', err);
    }
  } else {
    authArea.innerHTML = `<button id="signInBtn" class="btn btn-primary">Sign in with Google</button>`;
    document.getElementById('signInBtn').addEventListener('click', () => signInWithPopup(auth, provider));
    document.getElementById('fixtureList').innerHTML = `<p class="empty-state">Sign in to see this gameweek's fixtures.</p>`;
    document.getElementById('adminLockControls').style.display = 'none';
  }
  loadLeaderboard();
  loadHome();
});

async function ensureUserDoc(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { email: user.email, displayName: user.displayName, photoURL: user.photoURL || null, joinedAt: serverTimestamp() });
  } else if (snap.data().photoURL !== user.photoURL) {
    await setDoc(ref, { photoURL: user.photoURL || null }, { merge: true });
  }
}

const USERS_LOCALSTORAGE_KEY = 'eplUsersCache_v1';
const USERS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — the roster of who's playing changes rarely

async function getUsersMap() {
  if (usersCache) return usersCache; // in-memory hit, same page load

  try {
    const stored = JSON.parse(localStorage.getItem(USERS_LOCALSTORAGE_KEY) || 'null');
    if (stored && (Date.now() - stored.time < USERS_CACHE_TTL_MS)) {
      usersCache = stored.data;
      return usersCache;
    }
  } catch (err) {
    console.warn('localStorage users cache unavailable, fetching fresh:', err);
  }

  const snap = await getDocs(collection(db, 'users'));
  usersCache = {};
  snap.forEach(d => { usersCache[d.id] = d.data(); });
  try {
    localStorage.setItem(USERS_LOCALSTORAGE_KEY, JSON.stringify({ data: usersCache, time: Date.now() }));
  } catch (err) {
    // Non-fatal
  }
  return usersCache;
}

async function loadConfig() {
  const snap = await getDoc(doc(db, 'config', 'current'));
  const cfg = snap.exists() ? snap.data() : { currentGameweek: 1, tableLocked: false };
  currentGW = cfg.currentGameweek;
  standingsOrder = cfg.standingsOrder || null;
  document.getElementById('gwNumber').textContent = currentGW;

  const banner = document.getElementById('tableLockBanner');
  if (cfg.tableLocked) {
    banner.style.display = 'block';
    banner.textContent = '🔒 Table predictions are currently locked by the admin.';
  } else {
    banner.style.display = 'none';
  }
  return cfg;
}

// ---------- Predict Gameweek tab ----------
let currentGwFixtureCards = []; // populated by loadFixtures — {card, fx, predRef} for each unlocked fixture, used by Save All

async function savePredictionForCard(card, fx, predRef) {
  const h = card.querySelector('.home-score').value;
  const a = card.querySelector('.away-score').value;
  if (h === '' || a === '') return false;
  await setDoc(predRef, {
    uid: currentUser.uid, fixtureId: fx.id, predHome: Number(h), predAway: Number(a),
    scored: false, points: 0, submittedAt: serverTimestamp()
  });
  card.querySelector('.pred-status').textContent = 'Saved ✓';
  renderCrowdPulse(card.querySelector('.crowd-pulse'), fx);
  return true;
}

async function loadFixtures() {
 try {
  const cfg = await loadConfig();
  const allFixtures = await getAllFixtures();
  const fixtures = allFixtures
    .filter(f => f.gameweek === cfg.currentGameweek)
    // Not-yet-started first, then live, then finished — sorted by kickoff time within each tier
    .sort((a, b) => {
      const priority = status => {
        if (status === 'IN_PLAY' || status === 'PAUSED') return 1;
        if (status === 'FINISHED') return 2;
        return 0; // SCHEDULED, TIMED, etc.
      };
      const diff = priority(a.status) - priority(b.status);
      if (diff !== 0) return diff;
      return new Date(a.kickoffUTC) - new Date(b.kickoffUTC);
    });

  const tickerText = fixtures.map(f => `⚽ ${f.homeTeam} vs ${f.awayTeam}`).join('   •   ') || 'No fixtures loaded yet — check back soon';
  document.getElementById('tickerTrack').textContent = tickerText + '     ' + tickerText;

  const list = document.getElementById('fixtureList');
  currentGwFixtureCards = [];
  if (!fixtures.length) {
    list.innerHTML = `<p class="empty-state">No fixtures for this gameweek yet. The sync job will populate them automatically.</p>`;
    document.getElementById('gwExtras').style.display = 'none';
    document.getElementById('saveAllBtn').style.display = 'none';
    document.getElementById('saveAllWithExtrasBtn').style.display = 'none';
    return;
  }

  // PERFORMANCE FIX: previously this did one `await getDoc()` per fixture, in sequence — with
  // ~10 fixtures a gameweek, that was 10 sequential network round trips before the page could
  // even start rendering (the actual cause of the 5-10s blank-page reports). This does exactly
  // one query for every prediction across all these fixtures (any player), then everything below
  // renders synchronously from data already in memory.
  const fixtureIds = fixtures.map(f => f.id);
  let allPredsForGW = [];
  if (fixtureIds.length) {
    const predsSnap = await getDocs(query(collection(db, 'predictions'), where('fixtureId', 'in', fixtureIds.slice(0, 30))));
    allPredsForGW = predsSnap.docs.map(d => d.data());
  }
  const predsByFixture = {};
  allPredsForGW.forEach(p => { (predsByFixture[p.fixtureId] = predsByFixture[p.fixtureId] || []).push(p); });

  list.innerHTML = '';
  let anyUnlocked = false;
  for (const fx of fixtures) {
    const locked = new Date(fx.kickoffUTC) <= new Date() || (fx.status !== 'SCHEDULED' && fx.status !== 'TIMED');
    const fixturePreds = predsByFixture[fx.id] || [];
    const existing = fixturePreds.find(p => p.uid === currentUser.uid) || null;
    const predRef = doc(db, 'predictions', `${currentUser.uid}_${fx.id}`);

    const card = document.createElement('div');
    card.className = 'fixture-card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="fixture-main">
        <div>
          <div class="fixture-teams"><span class="kit-dot" style="background:${kitColor(fx.homeTeam)}"></span>${fx.homeTeam} <span class="home-away-tag">(Home)</span> <span style="color:var(--chalk-dim); font-weight:400;">vs</span> ${fx.awayTeam} <span class="home-away-tag">(Away)</span> <span class="kit-dot" style="background:${kitColor(fx.awayTeam)}"></span></div>
          <div class="fixture-kickoff">${matchStatusLine(fx, locked)}</div>
        </div>
        <div class="score-input-group">
          <input type="number" min="0" max="20" class="score-input home-score" value="${existing ? existing.predHome : ''}" ${locked ? 'disabled' : ''} />
          <span class="score-dash">–</span>
          <input type="number" min="0" max="20" class="score-input away-score" value="${existing ? existing.predAway : ''}" ${locked ? 'disabled' : ''} />
          ${locked ? '' : '<button class="btn btn-primary save-pred-btn">Save</button>'}
          <span class="pred-status"></span>
        </div>
      </div>
      <div class="crowd-pulse" data-fixture="${fx.id}">${fixturePreds.length ? crowdPulseHTML(computeCrowdStats(fixturePreds, fx), fx) : '<div class="crowd-locked-note">No predictions yet — be the first!</div>'}</div>
    `;
    if (!locked) {
      anyUnlocked = true;
      const saveBtn = card.querySelector('.save-pred-btn');
      saveBtn.addEventListener('click', async () => {
        const ok = await savePredictionForCard(card, fx, predRef);
        if (ok) celebrate('Prediction locked in! ⚽');
      });
      currentGwFixtureCards.push({ card, fx, predRef });
    }
    list.appendChild(card);
  }

  document.getElementById('saveAllBtn').style.display = anyUnlocked ? 'inline-block' : 'none';
  document.getElementById('saveAllWithExtrasBtn').style.display = anyUnlocked ? 'inline-block' : 'none';

  await setupGwExtras(fixtures);
 } catch (err) {
  console.error('loadFixtures error:', err);
  document.getElementById('fixtureList').innerHTML = `<p class="empty-state">⚠️ Couldn't load this gameweek's fixtures. Try refreshing the page. (Error: ${err.message || err.code || 'unknown'})</p>`;
 }
}

document.getElementById('saveAllBtn').addEventListener('click', async () => {
  let count = 0;
  for (const { card, fx, predRef } of currentGwFixtureCards) {
    const ok = await savePredictionForCard(card, fx, predRef);
    if (ok) count++;
  }
  celebrate(count ? `${count} prediction${count === 1 ? '' : 's'} saved! ⚽` : 'Fill in at least one score first');
});

document.getElementById('saveAllWithExtrasBtn').addEventListener('click', async () => {
  let count = 0;
  for (const { card, fx, predRef } of currentGwFixtureCards) {
    const ok = await savePredictionForCard(card, fx, predRef);
    if (ok) count++;
  }
  const extrasSaved = await saveGwExtras();
  celebrate(`${count} prediction${count === 1 ? '' : 's'}${extrasSaved ? ' + extras' : ''} saved! 🎯`);
});

function computeCrowdStats(predictionDocs, fixture) {
  let home = 0, draw = 0, away = 0, sumHome = 0, sumAway = 0;
  const scorelineCounts = {};
  predictionDocs.forEach(p => {
    if (p.predHome > p.predAway) home++;
    else if (p.predHome < p.predAway) away++;
    else draw++;
    sumHome += p.predHome;
    sumAway += p.predAway;
    const key = `${p.predHome}-${p.predAway}`;
    scorelineCounts[key] = (scorelineCounts[key] || 0) + 1;
  });
  const total = home + draw + away;
  const pct = n => Math.round((n / total) * 100);
  const topScorelines = Object.entries(scorelineCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);

  let ftInfo = null;
  if (fixture.status === 'FINISHED' && total > 0) {
    const actual = outcomeInfo(fixture.homeScore, fixture.awayScore, fixture.homeTeam, fixture.awayTeam);
    const correctCount = predictionDocs.filter(p => outcomeInfo(p.predHome, p.predAway, fixture.homeTeam, fixture.awayTeam).kind === actual.kind).length;
    ftInfo = { actual, pctCorrect: Math.round((correctCount / total) * 100) };
  }

  return {
    total, home, draw, away,
    pctHome: pct(home), pctDraw: pct(draw), pctAway: pct(away),
    avgHome: (sumHome / total), avgAway: (sumAway / total),
    topScorelines, ftInfo
  };
}

function outcomeInfo(predHome, predAway, homeTeam, awayTeam) {
  if (predHome > predAway) return { kind: 'home', text: `Home win (${homeTeam})`, cls: 'outcome-home' };
  if (predHome < predAway) return { kind: 'away', text: `Away win (${awayTeam})`, cls: 'outcome-away' };
  return { kind: 'draw', text: 'Draw', cls: 'outcome-draw' };
}

const TEAM_SHORT_NAMES = {
  'Manchester United': 'Man Utd', 'Manchester United FC': 'Man Utd',
  'Manchester City': 'Man City', 'Manchester City FC': 'Man City',
  'Tottenham Hotspur': 'Spurs', 'Tottenham Hotspur FC': 'Spurs',
  'Newcastle United': 'Newcastle', 'Newcastle United FC': 'Newcastle',
  'Nottingham Forest': 'Nottm Forest', 'Nottingham Forest FC': 'Nottm Forest',
  'Crystal Palace': 'C Palace', 'Crystal Palace FC': 'C Palace',
  'West Ham United': 'West Ham', 'West Ham United FC': 'West Ham',
  'Wolverhampton Wanderers': 'Wolves', 'Wolverhampton Wanderers FC': 'Wolves',
  'Brighton & Hove Albion': 'Brighton', 'Brighton & Hove Albion FC': 'Brighton',
  'Leeds United': 'Leeds', 'Leeds United FC': 'Leeds',
  'Ipswich Town': 'Ipswich', 'Ipswich Town FC': 'Ipswich',
  'Hull City': 'Hull', 'Hull City FC': 'Hull',
  'Coventry City': 'Coventry', 'Coventry City FC': 'Coventry'
};
function shortTeamName(name) {
  if (TEAM_SHORT_NAMES[name]) return TEAM_SHORT_NAMES[name];
  const stripped = String(name || '').replace(/\s*(FC|AFC)$/i, '').trim();
  return stripped.length > 12 ? stripped.slice(0, 11) + '…' : stripped;
}

function segmentLabel(kind, pct, teamName) {
  // Longer, more descriptive labels only when there's room; shrinks down as the segment narrows
  // so text never overflows into the next segment. On narrow (mobile) viewports, we still show
  // the team name (shortened) + percentage rather than dropping to a bare number — the bar wraps
  // to a second line via CSS if needed so the name never gets cut off.
  if (pct <= 0) return '';
  const isNarrowScreen = window.innerWidth < 480;
  if (isNarrowScreen) {
    return kind === 'draw' ? `Draw ${pct}%` : `${shortTeamName(teamName)} ${pct}%`;
  }
  if (pct >= 32) {
    return kind === 'draw' ? `Draw ${pct}%` : `${kind === 'home' ? 'Home win' : 'Away win'} (${teamName}) ${pct}%`;
  }
  if (pct >= 14) {
    return kind === 'draw' ? `Draw ${pct}%` : `${teamName} ${pct}%`;
  }
  return `${pct}%`;
}

function crowdPulseHTML(stats, fixture) {
  const { total, pctHome, pctDraw, pctAway, avgHome, avgAway, topScorelines, ftInfo } = stats;
  const ftLine = ftInfo
    ? `<div class="ft-result-line ${ftInfo.actual.cls}">FT ${ftInfo.actual.text} ${fixture.homeScore}-${fixture.awayScore} (predicted by ${ftInfo.pctCorrect}% of players)</div>`
    : '';
  return `
    ${ftLine}
    <div class="label">Crowd predicts (${total} vote${total === 1 ? '' : 's'})</div>
    <div class="crowd-bar">
      ${pctHome ? `<span class="home" style="width:${pctHome}%" title="Home win (${fixture.homeTeam})">${segmentLabel('home', pctHome, fixture.homeTeam)}</span>` : ''}
      ${pctDraw ? `<span class="draw" style="width:${pctDraw}%" title="Draw">${segmentLabel('draw', pctDraw)}</span>` : ''}
      ${pctAway ? `<span class="away" style="width:${pctAway}%" title="Away win (${fixture.awayTeam})">${segmentLabel('away', pctAway, fixture.awayTeam)}</span>` : ''}
    </div>
    <div class="crowd-avg-goals">📊 Avg predicted score: ${fixture.homeTeam} ${avgHome.toFixed(1)} – ${avgAway.toFixed(1)} ${fixture.awayTeam}</div>
    <div class="crowd-scorelines">Most predicted: ${topScorelines.map(([s, c]) => `${s} (${c})`).join(' · ')}</div>
  `;
}

async function renderCrowdPulse(container, fixture) {
  const q = query(collection(db, 'predictions'), where('fixtureId', '==', fixture.id));
  const snap = await getDocs(q);
  if (snap.empty) {
    container.innerHTML = `<div class="crowd-locked-note">No predictions yet — be the first!</div>`;
    return;
  }
  const stats = computeCrowdStats(snap.docs.map(d => d.data()), fixture);
  container.innerHTML = crowdPulseHTML(stats, fixture);
}

// ---------- Gameweek extras ----------
async function setupGwExtras(fixtures) {
  const teams = [...new Set(fixtures.flatMap(f => [f.homeTeam, f.awayTeam]))].sort();
  const topSel = document.getElementById('topScoringTeam');
  const csSel = document.getElementById('cleanSheetTeam');
  [topSel, csSel].forEach(sel => { sel.innerHTML = teams.map(t => `<option value="${t}">${t}</option>`).join(''); });

  const ref = doc(db, 'gwExtraPredictions', `${currentUser.uid}_${currentGW}`);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data();
    topSel.value = d.topScoringTeam || teams[0];
    csSel.value = d.cleanSheetTeam || teams[0];
    document.getElementById('topScoringPlayer').value = d.topScoringPlayerGuess || '';
    document.getElementById('cleanSheetPlayer').value = d.cleanSheetPlayerGuess || '';
  }
  document.getElementById('gwExtras').style.display = 'block';

  document.getElementById('saveExtrasBtn').onclick = async () => {
    await saveGwExtras();
    celebrate('Extras locked in! 🎯');
  };
}

async function saveGwExtras() {
  const topSel = document.getElementById('topScoringTeam');
  const csSel = document.getElementById('cleanSheetTeam');
  if (!topSel.value || !csSel.value) return false;
  const ref = doc(db, 'gwExtraPredictions', `${currentUser.uid}_${currentGW}`);
  await setDoc(ref, {
    uid: currentUser.uid, gameweek: currentGW,
    topScoringTeam: topSel.value, cleanSheetTeam: csSel.value,
    topScoringPlayerGuess: document.getElementById('topScoringPlayer').value.trim(),
    cleanSheetPlayerGuess: document.getElementById('cleanSheetPlayer').value.trim(),
    scored: false, points: 0, submittedAt: serverTimestamp()
  });
  document.getElementById('extrasStatus').textContent = 'Saved ✓';
  return true;
}

// ---------- Predict League Table tab ----------
async function loadTablePredictor() {
 try {
  const cfg = await loadConfig();
  const isAdmin = currentUser.email === ADMIN_EMAIL;
  const locked = cfg.tableLocked && !isAdmin;

  const ref = doc(db, 'tablePredictions', currentUser.uid);
  const snap = await getDoc(ref);
  // BUG FIX: an empty array ([]) is truthy in JS, so a corrupted doc with teams: [] (from an
  // old save-bug) was passing this check and rendering zero rows — a permanently blank table
  // for that specific account, on every device, since it's a data issue not a client-side one.
  const hasValidTeams = snap.exists() && Array.isArray(snap.data().teams) && snap.data().teams.length > 0;
  const teams = hasValidTeams
    ? snap.data().teams.sort((a, b) => a.predictedPosition - b.predictedPosition).map(t => t.team)
    : orderTeams(PL_TEAMS_DEFAULT);

  renderTableList(teams, locked);

  document.getElementById('lockTableBtn').onclick = async () => {
    await setDoc(doc(db, 'config', 'current'), { tableLocked: true }, { merge: true });
    celebrate('Table predictions locked 🔒');
    loadTablePredictor();
  };
  document.getElementById('unlockTableBtn').onclick = async () => {
    await setDoc(doc(db, 'config', 'current'), { tableLocked: false }, { merge: true });
    celebrate('Table predictions unlocked 🔓');
    loadTablePredictor();
  };
 } catch (err) {
  console.error('loadTablePredictor error:', err);
  const loadingMsg = document.getElementById('tableLoadingMsg');
  if (loadingMsg) loadingMsg.style.display = 'none';
  document.getElementById('tableList').innerHTML = '';
  document.getElementById('saveTableBtn').style.display = 'none';
  const banner = document.getElementById('tableLockBanner');
  banner.style.display = 'block';
  banner.textContent = `⚠️ Couldn't load the table predictor. Try refreshing the page. (Error: ${err.message || err.code || 'unknown'})`;
 }
}

function renderTableList(teams, locked) {
  const loadingMsg = document.getElementById('tableLoadingMsg');
  if (loadingMsg) loadingMsg.style.display = 'none';

  const listEl = document.getElementById('tableList');
  listEl.innerHTML = '';
  teams.forEach((team) => {
    const li = document.createElement('li');
    li.draggable = !locked;
    li.dataset.team = team;
    const actualRank = getActualRank(team);
    const actualZone = actualRank ? positionZoneClass(actualRank, teams.length) : '';
    li.innerHTML = `
      <span class="pos"></span>
      <span class="kit-dot" style="background:${kitColor(team)}"></span>
      <span style="flex:1;">${team}</span>
      ${actualRank ? `<span class="actual-standing ${actualZone}" title="Current real standing">#${actualRank}</span>` : ''}
      ${locked ? '' : `
      <div class="reorder-controls" style="display: flex; align-items: center; gap: 6px;">
        <input type="number" class="rank-input" min="1" max="${teams.length}" aria-label="Set rank for ${team}" style="width: 45px; text-align: center;">
        <div class="reorder-btns">
          <button type="button" class="reorder-btn up" aria-label="Move ${team} up">▲</button>
          <button type="button" class="reorder-btn down" aria-label="Move ${team} down">▼</button>
        </div>
      </div>`}
    `;
    listEl.appendChild(li);
  });
  renumberTableList();
  if (!locked) {
    enableDragReorder(listEl);
    enableButtonReorder(listEl); 
    enableDirectRankInput(listEl); // Handles manual input updates
  }
  document.getElementById('saveTableBtn').style.display = locked ? 'none' : 'inline-block';
}

function renumberTableList() {
  const listEl = document.getElementById('tableList');
  const total = listEl.children.length;
  [...listEl.children].forEach((li, i) => {
    const currentRank = i + 1;
    li.querySelector('.pos').textContent = currentRank;

    li.classList.remove('zone-top4', 'zone-mid', 'zone-bottom3');
    const zone = positionZoneClass(currentRank, total);
    if (zone) li.classList.add(zone);

    const rankInput = li.querySelector('.rank-input');
    if (rankInput && document.activeElement !== rankInput) {
      rankInput.value = currentRank;
    }

    const upBtn = li.querySelector('.reorder-btn.up');
    const downBtn = li.querySelector('.reorder-btn.down');
    if (upBtn) upBtn.disabled = (i === 0);
    if (downBtn) downBtn.disabled = (i === total - 1);
  });
}

function enableDirectRankInput(listEl) {
  listEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('rank-input')) return;
    
    const input = e.target;
    const li = input.closest('li');
    const total = listEl.children.length;
    let newRank = parseInt(input.value, 10);

    // Validate rank input range
    if (isNaN(newRank) || newRank < 1) newRank = 1;
    if (newRank > total) newRank = total;

    const targetIndex = newRank - 1;
    const items = [...listEl.children];
    const currentIndex = items.indexOf(li);

    if (currentIndex === targetIndex) return;

    // Move element to selected index
    if (targetIndex >= items.length - 1) {
      listEl.appendChild(li);
    } else if (targetIndex > currentIndex) {
      listEl.insertBefore(li, items[targetIndex + 1]);
    } else {
      listEl.insertBefore(li, items[targetIndex]);
    }

    renumberTableList();
  });
}

function enableButtonReorder(listEl) {
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.reorder-btn');
    if (!btn) return;
    const li = btn.closest('li');
    if (btn.classList.contains('up') && li.previousElementSibling) {
      listEl.insertBefore(li, li.previousElementSibling);
    } else if (btn.classList.contains('down') && li.nextElementSibling) {
      listEl.insertBefore(li.nextElementSibling, li);
    }
    renumberTableList();
  });
}

function enableDragReorder(listEl) {
  let dragged;
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragged = li;
    li.classList.add('dragging');
  });
  listEl.addEventListener('dragend', (e) => {
    const li = e.target.closest('li');
    if (li) li.classList.remove('dragging');
    renumberTableList();
  });
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragged) return;
    const after = getDragAfterElement(listEl, e.clientY);
    if (after == null) listEl.appendChild(dragged); else listEl.insertBefore(dragged, after);
  });
}
function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('li:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: -Infinity }).element;
}

document.getElementById('saveTableBtn').addEventListener('click', async () => {
  if (!currentUser) return;
  const items = [...document.getElementById('tableList').children];
  // Guard against exactly the failure mode that corrupted 5 users' data: the list rendering
  // silently failed, leaving it empty on screen, but Save was still clickable. Never write an
  // incomplete list to Firestore — tell the user plainly and make them reload instead.
  if (items.length < PL_TEAMS_DEFAULT.length) {
    alert(`Something didn't load correctly — only ${items.length} of ${PL_TEAMS_DEFAULT.length} teams are showing. Please refresh the page before saving so your prediction doesn't get saved incomplete.`);
    return;
  }
  const teams = items.map((li, i) => ({ team: li.dataset.team, predictedPosition: i + 1 }));
  await setDoc(doc(db, 'tablePredictions', currentUser.uid), { uid: currentUser.uid, teams, submittedAt: serverTimestamp() });
  celebrate('Table prediction saved! 📋');
});




// ---------- Community Table Predictions tab (matrix) ----------
async function loadAllTables() {
  const grid = document.getElementById('allTablesGrid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const cfg = await loadConfig(); // also refreshes the module-level `standingsOrder` array
    const tablesSnap = await getDocs(collection(db, 'tablePredictions'));
    const users = typeof getUsersMap === 'function' ? await getUsersMap() : {};

    if (!tablesSnap || tablesSnap.empty) {
      grid.innerHTML = '<p class="empty-state">No table predictions submitted yet.</p>';
      return;
    }

    const playerEntries = [];
    const allTeams = new Set();

    tablesSnap.forEach(d => {
      const data = d.data();
      if (!data || !Array.isArray(data.teams)) return;

      const positions = {};
      data.teams.forEach(e => {
        if (e && e.team) {
          positions[e.team] = e.predictedPosition;
          allTeams.add(e.team);
        }
      });

      playerEntries.push({
        uid: d.id,
        name: users[d.id]?.displayName || data.userName || 'Unknown player',
        positions
      });
    });

    if (playerEntries.length === 0 || allTeams.size === 0) {
      grid.innerHTML = '<p class="empty-state">No complete table predictions found.</p>';
      return;
    }

    playerEntries.sort((a, b) => a.name.localeCompare(b.name));

    // cfg.standingsOrder comes straight from automation/sync-and-score.js's syncStandingsOrder(),
    // which writes it to config/current on every hourly run — this is the real current league order.
    // Ranks are computed independently per team (not by filtering a shared array) so one name
    // mismatch can never cascade into shifting every other team's position — see normalizeTeamName above.
    const standingsOrderList = cfg.standingsOrder || [];
    const rankOf = (teamName) => {
      const norm = normalizeTeamName(teamName);
      const idx = standingsOrderList.findIndex(s => normalizeTeamName(s) === norm);
      return idx === -1 ? Infinity : idx;
    };
    const usingFallback = standingsOrderList.length === 0;
    const teamRows = usingFallback
      ? [...allTeams].sort()
      : [...allTeams].sort((a, b) => rankOf(a) - rankOf(b));
    const totalTeams = teamRows.length;

    const fallbackNotice = usingFallback
      ? `<p class="empty-state" style="margin-bottom:10px;">⚠️ Live standings haven't synced to this site yet (showing alphabetical order for now) — check that the automation workflow has run recently and that <code>config/current</code> has a <code>standingsOrder</code> field in Firestore.</p>`
      : '';
    const scrollHint = playerEntries.length > 5
      ? `<p class="empty-state" style="margin-bottom:8px;">↔️ ${playerEntries.length} players — scroll sideways to compare everyone. Your column is highlighted in amber, and the header row/team column stay pinned as you scroll.</p>`
      : '';

    const header = `<tr><th>Team</th><th>GD</th><th>W</th><th>D</th><th>L</th><th>Form</th>${playerEntries.map(p => `<th class="${currentUser && p.uid === currentUser.uid ? 'own-col' : ''}">${avatarHTML(p.uid, users, '20px')} ${p.name}</th>`).join('')}</tr>`;

    // Stats keyed by the API's exact team name — build a normalized lookup so it matches
    // regardless of small spelling differences against our own team-name strings (same
    // normalizeTeamName approach used for standings order, for the same reason).
    const rawStats = cfg.standingsStats || {};
    const normalizedStats = {};
    Object.entries(rawStats).forEach(([k, v]) => { normalizedStats[normalizeTeamName(k)] = v; });
    const getStatsFor = (teamName) => normalizedStats[normalizeTeamName(teamName)] || null;
    const formChips = formStr => {
      if (!formStr) return '–';
      return `<span class="form-chips">${formStr.split(',').map(r => `<span class="form-chip ${r.trim()}">${r.trim()}</span>`).join('')}</span>`;
    };

    const rows = teamRows.map((teamName, idx) => {
      const actualPos = idx + 1;
      const actualZone = positionZoneClass(actualPos, totalTeams);
      const s = getStatsFor(teamName);
      return `
      <tr>
        <td>
          <span class="kit-dot" style="background:${typeof kitColor === 'function' ? kitColor(teamName) : '#ccc'}; margin-right:6px;"></span>${teamName}
          <span class="actual-standing ${actualZone}">#${actualPos}</span>
        </td>
        <td class="stat-col">${s && s.goalDifference != null ? (s.goalDifference > 0 ? '+' : '') + s.goalDifference : '–'}</td>
        <td class="stat-col">${s?.won ?? '–'}</td>
        <td class="stat-col">${s?.draw ?? '–'}</td>
        <td class="stat-col">${s?.lost ?? '–'}</td>
        <td class="stat-col">${s ? formChips(s.form) : '–'}</td>
        ${playerEntries.map(p => {
          const predPos = p.positions[teamName];
          const zone = positionZoneClass(predPos, totalTeams);
          const isMine = currentUser && p.uid === currentUser.uid;
          return `<td class="pos-num ${zone}" style="${isMine ? 'background:rgba(255,182,39,0.08);' : ''}">${predPos ?? '–'}</td>`;
        }).join('')}
      </tr>
    `;
    }).join('');

    grid.innerHTML = `${fallbackNotice}${scrollHint}<div class="table-scroll"><table class="matrix-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;

  } catch (err) {
    console.error('loadAllTables Error:', err);
    grid.innerHTML = `<p class="empty-state">Failed to load community predictions. (${err.message})</p>`;
  }
}



// ---------- Community Game Predictions tab (recent gameweeks by default, newest first) ----------
const RECENT_GW_WINDOW = 3; // how many gameweeks show by default — keeps the predictions read small and bounded regardless of season size

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchPredictionsForFixtureIds(fixtureIds) {
  if (!fixtureIds.length) return [];
  // Firestore 'in' queries cap at 30 values, so chunk and merge — still far cheaper than
  // reading the entire predictions collection, which only grows as the season goes on.
  const chunks = chunk(fixtureIds, 30);
  const results = await Promise.all(
    chunks.map(c => getDocs(query(collection(db, 'predictions'), where('fixtureId', 'in', c))))
  );
  return results.flatMap(snap => snap.docs.map(d => d.data()));
}

async function loadCommunity(showAll = false) {
  const grid = document.getElementById('communityGrid');
  grid.innerHTML = '<p class="empty-state">Loading…</p>';

  const [fixtures, users, cfg] = await Promise.all([getAllFixtures(), getUsersMap(), loadConfig()]);
  if (!fixtures.length) { grid.innerHTML = '<p class="empty-state">No fixtures synced yet.</p>'; return; }

  const byGW = {};
  fixtures.forEach(f => { (byGW[f.gameweek] = byGW[f.gameweek] || []).push(f); });

  // Use the same "current gameweek" the rest of the site uses (config.currentGameweek, set by
  // the automation script) rather than deriving a separate one here from which matches have
  // actually kicked off — that mismatch was why this tab lagged a gameweek behind Predict
  // Gameweek: the config value advances as soon as the previous gameweek fully finishes, even
  // before the next one has started.
  const currentGWNum = cfg.currentGameweek || Math.min(...fixtures.map(f => Number(f.gameweek)));

  const allGwNumbers = Object.keys(byGW).map(Number).filter(gw => gw <= currentGWNum).sort((a, b) => b - a);
  const gwNumbers = showAll ? allGwNumbers : allGwNumbers.slice(0, RECENT_GW_WINDOW);

  const visibleFixtureIds = gwNumbers.flatMap(gw => byGW[gw].map(f => f.id));
  const preds = await fetchPredictionsForFixtureIds(visibleFixtureIds);
  const predsByFixture = {};
  preds.forEach(p => { (predsByFixture[p.fixtureId] = predsByFixture[p.fixtureId] || []).push(p); });

  grid.innerHTML = '';

  if (!showAll && allGwNumbers.length > RECENT_GW_WINDOW) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'btn btn-secondary';
    loadMoreBtn.style.marginBottom = '16px';
    loadMoreBtn.textContent = `Show all ${allGwNumbers.length} gameweeks (currently showing the last ${RECENT_GW_WINDOW})`;
    loadMoreBtn.onclick = () => loadCommunity(true);
    grid.appendChild(loadMoreBtn);
  }

  gwNumbers.forEach((gw, i) => {
    const details = document.createElement('details');
    details.className = 'gw-collapsible';
    details.open = i === 0; // most recent gameweek starts expanded, older ones collapsed

    const summary = document.createElement('summary');
    summary.className = 'gw-section-header';
    summary.textContent = `Gameweek ${gw}`;
    details.appendChild(summary);

    const gwFixtures = byGW[gw].sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));
    gwFixtures.forEach(fx => {
      const fixturePreds = predsByFixture[fx.id] || [];
      const isFinished = fx.status === 'FINISHED';
      const actual = isFinished ? outcomeInfo(fx.homeScore, fx.awayScore, fx.homeTeam, fx.awayTeam) : null;

      const rows = fixturePreds.map(p => {
        const info = outcomeInfo(p.predHome, p.predAway, fx.homeTeam, fx.awayTeam);
        let resultIcon = '';
        if (isFinished) {
          resultIcon = info.kind === actual.kind
            ? '<span class="result-tick" title="Outcome correct">✅</span>'
            : '<span class="result-cross" title="Outcome incorrect">❌</span>';
        }
        const isMine = currentUser && p.uid === currentUser.uid;
        return `<tr class="${isMine ? 'my-prediction-row' : ''}">
          <td class="player-name ${info.cls}">${isMine ? '👤 ' : ''}${users[p.uid]?.displayName || 'Unknown'}${isMine ? ' (You)' : ''}</td>
          <td class="score-cell ${info.cls}">${p.predHome}–${p.predAway}</td>
          <td class="outcome-cell ${info.cls}">${info.text}</td>
          <td class="result-icon">${resultIcon}</td>
        </tr>`;
      }).join('');

      const card = document.createElement('div');
      card.className = 'community-fixture';
      card.innerHTML = `
        <h3>${fx.homeTeam} vs ${fx.awayTeam} ${isFinished ? `<span style="color:var(--chalk-dim); font-weight:400;">— FT ${fx.homeScore}–${fx.awayScore}</span>` : ''}</h3>
        <div class="crowd-pulse">${fixturePreds.length ? crowdPulseHTML(computeCrowdStats(fixturePreds, fx), fx) : '<div class="crowd-locked-note">No predictions yet</div>'}</div>
        <table>${rows || '<tr><td colspan="4" class="empty-state">No predictions</td></tr>'}</table>
      `;
      details.appendChild(card);
    });

    grid.appendChild(details);
  });
}


// ---------- Leaderboard tab ----------
async function loadLeaderboard() {
  const q = query(collection(db, 'leaderboard'), orderBy('rank', 'asc'));
  const snap = await getDocs(q);
  const body = document.getElementById('leaderboardBody');
  body.innerHTML = '';
  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
  const totalPlayers = rows.length;

  rows.forEach(r => {
    const tr = document.createElement('tr');
    const zone = positionZoneClass(r.rank, totalPlayers);
    if (zone) tr.classList.add(zone);
    tr.innerHTML = `
      <td>${r.rank}</td><td>${r.displayName || r.email || r.uid}</td>
      <td>${r.matchPoints || 0}</td><td>${r.tablePoints || 0}</td><td>${r.extraPoints || 0}</td>
      <td>${r.currentStreak || 0}</td>
      <td>${r.matchesPredicted || 0}</td><td>${r.correctPredictions || 0}</td><td>${r.perfectPredictions || 0}</td>
      <td>${r.totalPoints || 0}</td>
    `;
    body.appendChild(tr);
  });
  if (!rows.length) body.innerHTML = `<tr><td colspan="10" class="empty-state">Leaderboard populates after the first gameweek is scored.</td></tr>`;

  await loadPlayers(rows); // same leaderboard data, no extra Firestore read for the player cards below
}

let warzonePlayersCache = null;
async function loadPlayers(leaderboardRows) {
  const grid = document.getElementById('playersGrid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    if (!warzonePlayersCache) {
      const [users, badgesSnap] = await Promise.all([
        getUsersMap(),
        getDocs(collection(db, 'badges'))
      ]);
      const lbByUid = {};
      leaderboardRows.forEach(r => { lbByUid[r.uid] = r; });
      const badgeCountByUid = {};
      badgesSnap.forEach(d => { badgeCountByUid[d.id] = (d.data().badges || []).length; });

      warzonePlayersCache = Object.entries(users).map(([uid, u]) => {
        const lb = lbByUid[uid] || {};
        return {
          uid,
          name: u.displayName || 'Unknown player',
          totalPoints: lb.totalPoints || 0,
          rank: lb.rank || null,
          currentStreak: lb.currentStreak || 0,
          matchPoints: lb.matchPoints || 0,
          tablePoints: lb.tablePoints || 0,
          extraPoints: lb.extraPoints || 0,
          badgeCount: badgeCountByUid[uid] || 0,
          exactCount: lb.exactCount || 0,
          accuracyPct: lb.accuracyPct || 0
        };
      }).sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
    }
    renderPlayers(warzonePlayersCache);
    document.getElementById('playerSearch').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      renderPlayers(warzonePlayersCache.filter(p => p.name.toLowerCase().includes(q)));
    };
  } catch (err) {
    console.error('loadPlayers error:', err);
    grid.innerHTML = `<p class="empty-state">⚠️ Couldn't load players right now. (Error: ${err.message || err.code || 'unknown'})</p>`;
  }
}

function renderPlayers(list) {
  const grid = document.getElementById('playersGrid');
  if (!list.length) { grid.innerHTML = '<p class="empty-state">No one has signed in yet — be the first!</p>'; return; }
  grid.innerHTML = list.map(p => `
    <div class="player-card">
      <div class="name">${p.name}${p.rank ? ` <span style="color:var(--amber); font-family:var(--font-mono); font-size:11px;">#${p.rank}</span>` : ''}</div>
      <div class="meta">${p.totalPoints} pts total ${p.badgeCount ? `· 🥇 ${p.badgeCount}` : ''}</div>
      <div class="meta">🎯 ${p.matchPoints} · 📋 ${p.tablePoints} · ⚡ ${p.extraPoints} ${p.currentStreak ? `· 🔥 ${p.currentStreak}-streak` : ''}</div>
      <div class="meta">🎪 ${p.exactCount} perfect ${p.accuracyPct ? `· ✅ ${p.accuracyPct}% accuracy` : ''}</div>
    </div>
  `).join('');
}

// ---------- Season Awards tab ----------
async function setupAwardsForm() {
  const sel = document.getElementById('awardCleanSheetTeam');
  sel.innerHTML = PL_TEAMS_DEFAULT.map(t => `<option value="${t}">${t}</option>`).join('');
  if (!currentUser) return;

  const isAdmin = currentUser.email === ADMIN_EMAIL;
  const cfg = await loadConfig();
  const locked = cfg.awardsLocked && !isAdmin;

  document.getElementById('awardsAdminLockControls').style.display = isAdmin ? 'flex' : 'none';
  const banner = document.getElementById('awardsLockBanner');
  if (cfg.awardsLocked) {
    banner.style.display = 'block';
    banner.textContent = '🔒 Season Award predictions are currently locked by the admin.';
  } else {
    banner.style.display = 'none';
  }

  const inputs = ['awardGoldenBoot', 'awardGoldenGlove', 'awardManager', 'awardRedCards', 'awardCleanSheetTeam'];
  inputs.forEach(id => { document.getElementById(id).disabled = locked; });
  document.getElementById('saveAwardsBtn').style.display = locked ? 'none' : 'inline-block';

  const ref = doc(db, 'seasonPredictions', currentUser.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById('awardGoldenBoot').value = d.goldenBoot || '';
      document.getElementById('awardGoldenGlove').value = d.goldenGlove || '';
      document.getElementById('awardManager').value = d.managerOfYear || '';
      document.getElementById('awardRedCards').value = d.mostRedCards || '';
      sel.value = d.mostCleanSheetsTeam || PL_TEAMS_DEFAULT[0];
    }
  } catch (err) {
    console.error('setupAwardsForm prefill error:', err);
    // Non-fatal — the form still works for a fresh submission even if we couldn't preload past picks
  }

  document.getElementById('lockAwardsBtn').onclick = async () => {
    await setDoc(doc(db, 'config', 'current'), { awardsLocked: true }, { merge: true });
    celebrate('Season Awards locked 🔒');
    setupAwardsForm();
  };
  document.getElementById('unlockAwardsBtn').onclick = async () => {
    await setDoc(doc(db, 'config', 'current'), { awardsLocked: false }, { merge: true });
    celebrate('Season Awards unlocked 🔓');
    setupAwardsForm();
  };

  document.getElementById('saveAwardsBtn').onclick = async () => {
    await setDoc(ref, {
      uid: currentUser.uid,
      goldenBoot: document.getElementById('awardGoldenBoot').value.trim(),
      goldenGlove: document.getElementById('awardGoldenGlove').value.trim(),
      managerOfYear: document.getElementById('awardManager').value.trim(),
      mostRedCards: document.getElementById('awardRedCards').value.trim(),
      mostCleanSheetsTeam: sel.value,
      submittedAt: serverTimestamp()
    });
    document.getElementById('awardsStatus').textContent = 'Saved ✓';
    celebrate('Season picks locked in! 🎖️');
    loadAwardsCommunity();
  };
}

async function loadAwardsScorersRef() {
  const wrap = document.getElementById('awardsScorersRef');
  if (!wrap) return;
  wrap.innerHTML = '<p class="empty-state">Loading…</p>';
  try {
    const snap = await getDoc(doc(db, 'topScorers', 'current'));
    if (!snap.exists() || !snap.data().items?.length) {
      wrap.innerHTML = '<p class="empty-state">Top scorers haven\'t synced yet.</p>';
      return;
    }
    const items = snap.data().items.slice(0, 10); // top 10 is plenty for a quick reference
    wrap.innerHTML = `
      <div class="table-scroll">
        <table class="matrix-table scorers-table">
          <thead><tr><th>#</th><th>Player</th><th>Team</th><th>Goals</th></tr></thead>
          <tbody>${items.map((s, i) => `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.team}</td><td class="stat-goals">${s.goals}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    console.error('loadAwardsScorersRef error:', err);
    wrap.innerHTML = `<p class="empty-state">⚠️ Couldn't load top scorers. (${err.message || err.code || 'unknown'})</p>`;
  }
}

async function loadAwardsCommunity() {
  const container = document.getElementById('awardsCommunity');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  const [snap, users] = await Promise.all([getDocs(collection(db, 'seasonPredictions')), getUsersMap()]);
  if (snap.empty) { container.innerHTML = '<p class="empty-state">No predictions submitted yet.</p>'; return; }

  const categories = [
    ['goldenBoot', '🥾 Golden Boot'], ['goldenGlove', '🧤 Golden Glove'],
    ['managerOfYear', '📋 Manager of the Year'], ['mostRedCards', '🟥 Most Red Cards'],
    ['mostCleanSheetsTeam', '🛡️ Most Clean Sheets (Team)']
  ];
  container.innerHTML = '';
  categories.forEach(([field, label]) => {
    const tally = {}; // pick value -> array of display names who picked it
    snap.forEach(d => {
      const val = (d.data()[field] || '').trim();
      if (!val) return;
      const pickerName = users[d.id]?.displayName || 'Unknown player';
      (tally[val] = tally[val] || []).push(pickerName);
    });
    const sorted = Object.entries(tally).sort((a, b) => b[1].length - a[1].length);
    const div = document.createElement('div');
    div.className = 'award-tally';
    div.innerHTML = `<h4>${label}</h4>` + (sorted.length
      ? sorted.map(([pick, names]) => `
          <div class="pick-row">
            <span>${pick}</span>
            <span>${names.length} pick${names.length === 1 ? '' : 's'}</span>
          </div>
          <div class="pick-names">${names.join(', ')}</div>
        `).join('')
      : '<p class="empty-state">No picks yet</p>');
    container.appendChild(div);
  });
}

// ---------- Highlights tab ----------
async function loadHighlights() {
  const list = document.getElementById('highlightsList');
  list.innerHTML = '<p class="empty-state">Loading…</p>';
  const snap = await getDoc(doc(db, 'highlights', 'current'));
  if (!snap.exists() || !snap.data().items?.length) {
    list.innerHTML = '<p class="empty-state">Highlights populate automatically after each gameweek is scored.</p>';
    return;
  }
  const data = snap.data();
  list.innerHTML = data.items.map(h => `
    <div class="highlight-item"><span class="icon">${h.icon || '⭐'}</span><span>${h.text}</span></div>
  `).join('');
}

// ---------- Badges tab ----------
// ---------- Profile tab (also renders Badges, moved here from its own tab) ----------
async function loadProfile() {
  if (!currentUser) return;
  document.getElementById('profileName').textContent = `${currentUser.displayName}'s Profile`;

  const avatarEl = document.getElementById('profileAvatar');
  if (currentUser.photoURL) {
    avatarEl.src = currentUser.photoURL;
    avatarEl.style.display = 'block';
  }

  const [predsSnap, allFixtures, lbSnap, badgesSnap] = await Promise.all([
    getDocs(query(collection(db, 'predictions'), where('uid', '==', currentUser.uid))),
    getAllFixtures(),
    getDoc(doc(db, 'leaderboard', currentUser.uid)),
    getDoc(doc(db, 'badges', currentUser.uid))
  ]);
  const fixturesById = {};
  allFixtures.forEach(f => { fixturesById[f.id] = f; });

  const preds = predsSnap.docs.map(d => d.data()).sort((a, b) => {
    const fa = fixturesById[a.fixtureId], fb = fixturesById[b.fixtureId];
    return new Date(fb?.kickoffUTC || 0) - new Date(fa?.kickoffUTC || 0);
  });

  const scoredPreds = preds.filter(p => p.scored);
  const exactCount = scoredPreds.filter(p => p.points === 25).length;
  const outcomeCount = scoredPreds.filter(p => p.points === 10).length;
  const accuracy = scoredPreds.length ? Math.round(((exactCount + outcomeCount) / scoredPreds.length) * 100) : 0;
  const lb = lbSnap.exists() ? lbSnap.data() : {};

  document.getElementById('profileStats').innerHTML = `
    <div class="profile-stat-card"><div class="value">${lb.totalPoints || 0}</div><div class="label">Total Points</div></div>
    <div class="profile-stat-card"><div class="value">${lb.rank || '—'}</div><div class="label">Current Rank</div></div>
    <div class="profile-stat-card"><div class="value">${exactCount}</div><div class="label">Exact Scores</div></div>
    <div class="profile-stat-card"><div class="value">${accuracy}%</div><div class="label">Accuracy</div></div>
    <div class="profile-stat-card"><div class="value">${lb.currentStreak || 0}</div><div class="label">Current Streak</div></div>
  `;

  // Badges (moved here from the old standalone Badges tab)
  const badgeGrid = document.getElementById('badgeGrid');
  const badges = badgesSnap.exists() && badgesSnap.data().badges ? badgesSnap.data().badges : [];
  badgeGrid.innerHTML = badges.length
    ? badges.map(b => `
        <div class="badge-card">
          <div class="icon">${BADGE_ICONS[b.name] || '🏅'}</div>
          <div class="name">${b.name}</div>
          <div class="meta">${b.context || ''}</div>
        </div>
      `).join('')
    : '<p class="empty-state">No badges yet — get predicting.</p>';

  // History, grouped by gameweek, each group with its own mini stats header
  const historyEl = document.getElementById('profileHistory');
  if (!preds.length) { historyEl.innerHTML = '<p class="empty-state">No predictions yet — head to Predict Gameweek to get started.</p>'; return; }

  const byGW = {};
  preds.forEach(p => {
    const fx = fixturesById[p.fixtureId];
    if (!fx) return;
    (byGW[fx.gameweek] = byGW[fx.gameweek] || []).push(p);
  });
  const gwNumbers = Object.keys(byGW).map(Number).sort((a, b) => b - a);

  historyEl.innerHTML = gwNumbers.map(gw => {
    const gwPreds = byGW[gw];
    const gwScored = gwPreds.filter(p => p.scored);
    const gwPoints = gwPreds.reduce((sum, p) => sum + (p.points || 0), 0);
    const gwExact = gwScored.filter(p => p.points === 25).length;
    const gwCorrect = gwScored.filter(p => p.points === 25 || p.points === 10).length;
    const gwAccuracy = gwScored.length ? Math.round((gwCorrect / gwScored.length) * 100) : 0;

    const rows = gwPreds.map(p => {
      const fx = fixturesById[p.fixtureId];
      let pillClass = 'pending', pillText = 'Pending';
      if (p.scored) {
        if (p.points === 25) { pillClass = 'exact'; pillText = 'Exact! +25'; }
        else if (p.points === 10) { pillClass = 'outcome'; pillText = 'Outcome +10'; }
        else { pillClass = 'miss'; pillText = 'Missed'; }
      }
      return `
        <div class="history-row">
          <span>${fx.homeTeam} ${fx.homeScore ?? '?'}–${fx.awayScore ?? '?'} ${fx.awayTeam}</span>
          <span style="color:var(--chalk-dim);">You said ${p.predHome}–${p.predAway}</span>
          <span class="result-pill ${pillClass}">${pillText}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="profile-gw-group">
        <h3 class="section-title" style="margin-top:0;">Gameweek ${gw}</h3>
        <div class="profile-gw-stats">
          <span><strong>${gwPoints}</strong> points</span>
          <span><strong>${gwExact}</strong> exact</span>
          <span><strong>${gwAccuracy}%</strong> accuracy${gwScored.length < gwPreds.length ? ' (partial — some still pending)' : ''}</span>
        </div>
        ${rows}
      </div>
    `;
  }).join('');
}

// Note: setupAwardsForm() is called from onAuthStateChanged once currentUser is known —
// calling it at module load time (before sign-in resolves) meant the Save button's
// click handler never got attached, since the function returns early with no user.
