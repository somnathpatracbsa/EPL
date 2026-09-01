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
  if (btn.dataset.tab === 'leaderboard') { loadLeaderboard(); loadHighlights(); }
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

    const isLive = fx.status === 'IN_PLAY' || fx.status === 'PAUSED';
    const card = document.createElement('div');
    card.className = 'fixture-card' + (locked ? ' locked' : '') + (isLive ? ' fixture-live-card' : '');
    card.innerHTML = `
      <div class="fixture-main">
        <div>
          <div class="fixture-teams"><span class="kit-dot home-dot"></span>${fx.homeTeam} <span class="home-away-tag">(Home)</span> <span style="color:var(--chalk-dim); font-weight:400;">vs</span> ${fx.awayTeam} <span class="home-away-tag">(Away)</span> <span class="kit-dot away-dot"></span></div>
          <div class="fixture-kickoff">${matchStatusLine(fx, locked)}</div>
        </div>
        <div class="score-input-group">
          <input type="number" min="0" max="20" class="score-input home-score" value="${existing ? existing.predHome : ''}" ${locked ? 'disabled' : ''} />
          <span class="score-dash">–</span>
          <input type="number" min="0" max="20" class="score-input away-score" value="${existing ? existing.predAway : ''}" ${locked ? 'disabled' : ''} />
          <span class="pred-status"></span>
        </div>
      </div>
      ${isLive ? `<div class="live-score-bar"><span class="live-dot"></span><span class="live-score-num">${fx.homeScore ?? 0} – ${fx.awayScore ?? 0}</span><span class="live-sync-note">score as of last hourly sync</span></div>` : ''}
      <div class="crowd-pulse" data-fixture="${fx.id}">${fixturePreds.length ? crowdPulseHTML(computeCrowdStats(fixturePreds, fx), fx) : '<div class="crowd-locked-note">No predictions yet — be the first!</div>'}</div>
    `;
    if (!locked) {
      anyUnlocked = true;
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
  if (extrasSaved) {
    const fixtures = await getAllFixtures();
    const gwFixtures = fixtures.filter(f => Number(f.gameweek) === Number(currentGW));
    await refreshExtrasCrowdStats(gwFixtures);
  }
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
  const highGameSel = document.getElementById('highestScoringGame');
  const lowGameSel = document.getElementById('lowestScoringGame');

  const defaultTeamOpt = '<option value="">-- Select Team --</option>';
  const teamOptions = defaultTeamOpt + teams.map(t => `<option value="${t}">${t}</option>`).join('');
  topSel.innerHTML = teamOptions;
  csSel.innerHTML = teamOptions;

  const defaultGameOpt = '<option value="">-- Select Match --</option>';
  const fixtureOptions = defaultGameOpt + fixtures.map(f => `<option value="${f.id}">⚽ ${f.homeTeam} vs ${f.awayTeam}</option>`).join('');
  highGameSel.innerHTML = fixtureOptions;
  lowGameSel.innerHTML = fixtureOptions;

  // Set default values as blank
  topSel.value = '';
  csSel.value = '';
  highGameSel.value = '';
  lowGameSel.value = '';

  // Locks the moment any match in this gameweek has kicked off — same cutoff logic used for
  // individual fixture cards, since the "highest scoring team" / "clean sheet" guesses stop
  // being meaningful predictions once matches are already underway.
  const gwLocked = fixtures.some(fx => new Date(fx.kickoffUTC) <= new Date() || (fx.status !== 'SCHEDULED' && fx.status !== 'TIMED'));

  const ref = doc(db, 'gwExtraPredictions', `${currentUser.uid}_${currentGW}`);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data();
    if (d.topScoringTeam) topSel.value = d.topScoringTeam;
    if (d.cleanSheetTeam) csSel.value = d.cleanSheetTeam;
    if (d.highestScoringGame) highGameSel.value = d.highestScoringGame;
    if (d.lowestScoringGame) lowGameSel.value = d.lowestScoringGame;
  }
  document.getElementById('gwExtras').style.display = 'block';

  const lockNote = document.getElementById('gwExtrasLockNote');
  const saveBtn = document.getElementById('saveExtrasBtn');
  [topSel, csSel, highGameSel, lowGameSel].forEach(sel => { sel.disabled = gwLocked; });
  saveBtn.style.display = gwLocked ? 'none' : 'inline-block';
  lockNote.style.display = gwLocked ? 'block' : 'none';
  if (gwLocked) lockNote.textContent = '🔒 Locked — a match in this gameweek has already kicked off.';

  saveBtn.onclick = async () => {
    const ok = await saveGwExtras();
    if (ok) {
      celebrate('Extras locked in! 🎯');
      await refreshExtrasCrowdStats(fixtures);
    }
  };

  await refreshExtrasCrowdStats(fixtures);
}

async function refreshExtrasCrowdStats(fixtures) {
  const crowdContainer = document.getElementById('gwExtrasCrowdStats');
  if (!crowdContainer || !currentGW) return;
  try {
    const extrasSnap = await getDocs(query(collection(db, 'gwExtraPredictions'), where('gameweek', '==', currentGW)));
    const extrasDocs = extrasSnap.docs.map(d => d.data());
    renderExtrasCrowdPulse(crowdContainer, extrasDocs, fixtures);
  } catch (err) {
    console.error('Error loading extras crowd stats:', err);
  }
}

function renderExtrasCrowdPulse(container, extrasDocs, fixtures) {
  if (!extrasDocs.length) {
    container.innerHTML = '<div class="crowd-locked-note" style="margin-top:14px;">No gameweek extra predictions yet — be the first!</div>';
    return;
  }

  const fixtureMap = {};
  fixtures.forEach(f => { fixtureMap[f.id] = `${f.homeTeam} vs ${f.awayTeam}`; });

  const getTopPicks = (key, isMatch = false) => {
    const counts = {};
    let total = 0;
    extrasDocs.forEach(d => {
      const val = d[key];
      if (val) {
        counts[val] = (counts[val] || 0) + 1;
        total++;
      }
    });
    if (!total) return [];
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => {
        const name = isMatch ? (fixtureMap[id] || id) : id;
        const pct = Math.round((count / total) * 100);
        return { name, count, pct };
      });
  };

  const topScoring = getTopPicks('topScoringTeam');
  const cleanSheet = getTopPicks('cleanSheetTeam');
  const highestGame = getTopPicks('highestScoringGame', true);
  const lowestGame = getTopPicks('lowestScoringGame', true);

  const renderPickList = (picks) => {
    if (!picks.length) return '<span class="extras-no-votes">No picks yet</span>';
    return picks.map(p => `<span class="extra-crowd-chip"><strong>${p.name}</strong> ${p.pct}%</span>`).join(' ');
  };

  container.innerHTML = `
    <div class="extras-crowd-box">
      <div class="label">👥 Community Extra Picks (${extrasDocs.length} player${extrasDocs.length === 1 ? '' : 's'})</div>
      <div class="extras-crowd-grid">
        <div class="extras-crowd-item">
          <span class="cat-title">🎯 Top Scoring Team</span>
          <div class="cat-chips">${renderPickList(topScoring)}</div>
        </div>
        <div class="extras-crowd-item">
          <span class="cat-title">🛡️ Clean Sheet</span>
          <div class="cat-chips">${renderPickList(cleanSheet)}</div>
        </div>
        <div class="extras-crowd-item">
          <span class="cat-title">🔥 Highest Scoring Game</span>
          <div class="cat-chips">${renderPickList(highestGame)}</div>
        </div>
        <div class="extras-crowd-item">
          <span class="cat-title">🔒 Lowest Scoring Game</span>
          <div class="cat-chips">${renderPickList(lowestGame)}</div>
        </div>
      </div>
    </div>
  `;
}

async function saveGwExtras() {
  const topSel = document.getElementById('topScoringTeam');
  const csSel = document.getElementById('cleanSheetTeam');
  const highGameSel = document.getElementById('highestScoringGame');
  const lowGameSel = document.getElementById('lowestScoringGame');
  if (topSel.disabled || csSel.disabled || highGameSel.disabled || lowGameSel.disabled) return false; // locked — a match has already kicked off
  if (!topSel.value && !csSel.value && !highGameSel.value && !lowGameSel.value) return false;
  const ref = doc(db, 'gwExtraPredictions', `${currentUser.uid}_${currentGW}`);
  await setDoc(ref, {
    uid: currentUser.uid, gameweek: currentGW,
    topScoringTeam: topSel.value || null,
    cleanSheetTeam: csSel.value || null,
    highestScoringGame: highGameSel.value || null,
    lowestScoringGame: lowGameSel.value || null,
    scored: false, points: 0, submittedAt: serverTimestamp()
  }, { merge: true });
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
      <span class="team-name">${team}</span>
      ${actualRank ? `<span class="actual-standing ${actualZone}" title="Current live EPL table standing"><span class="actual-label">Live:</span> #${actualRank}</span>` : ''}
      ${locked ? '' : `
      <div class="reorder-controls">
        <input type="number" class="rank-input" min="1" max="${teams.length}" aria-label="Set rank for ${team}">
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

function renumberTableList() {
  const listEl = document.getElementById('tableList');
  const total = listEl.children.length;
  [...listEl.children].forEach((li, i) => {
    const currentRank = i + 1;
    li.querySelector('.pos').textContent = currentRank;

    li.classList.remove('zone-top4', 'zone-mid', 'zone-bottom3');
    const zone = positionZoneClass(currentRank, total);
    if (zone) li.classList.add(zone);

    const actualRank = getActualRank(li.dataset.team);
    let accEl = li.querySelector('.table-pred-accuracy');
    if (!accEl) {
      accEl = document.createElement('span');
      accEl.className = 'table-pred-accuracy';
      const teamNameEl = li.querySelector('.team-name');
      if (teamNameEl) teamNameEl.after(accEl);
    }
    if (actualRank != null) {
      const diff = Math.abs(currentRank - actualRank);
      if (diff === 0) {
        accEl.innerHTML = `<span class="matrix-tick-icon" title="Exact match! (Rank #${actualRank})">✓</span>`;
      } else if (diff === 1) {
        accEl.innerHTML = `<span class="matrix-dot dot-diff-1" title="Off by 1 (Predicted #${currentRank}, Actual #${actualRank})"></span>`;
      } else if (diff === 2) {
        accEl.innerHTML = `<span class="matrix-dot dot-diff-2" title="Off by 2 (Predicted #${currentRank}, Actual #${actualRank})"></span>`;
      } else {
        accEl.innerHTML = '';
      }
    } else {
      accEl.innerHTML = '';
    }

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

    let matrixPlayerOrder = null;
    try {
      const saved = sessionStorage.getItem('matrix_player_order');
      if (saved) matrixPlayerOrder = JSON.parse(saved);
    } catch (e) {}

    if (Array.isArray(matrixPlayerOrder) && matrixPlayerOrder.length) {
      const orderMap = {};
      matrixPlayerOrder.forEach((uid, idx) => { orderMap[uid] = idx; });
      playerEntries.sort((a, b) => {
        const idxA = orderMap[a.uid] ?? 9999;
        const idxB = orderMap[b.uid] ?? 9999;
        if (idxA !== idxB) return idxA - idxB;
        return a.name.localeCompare(b.name);
      });
    } else {
      playerEntries.sort((a, b) => a.name.localeCompare(b.name));
    }

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

    const rawStats = cfg.standingsStats || {};
    const normalizedStats = {};
    Object.entries(rawStats).forEach(([k, v]) => { normalizedStats[normalizeTeamName(k)] = v; });
    const getStatsFor = (teamName) => normalizedStats[normalizeTeamName(teamName)] || null;
    const formChips = formStr => {
      if (!formStr) return '–';
      return `<span class="form-chips">${formStr.split(',').map(r => `<span class="form-chip ${r.trim()}">${r.trim()}</span>`).join('')}</span>`;
    };

    let showTeamStats = false;
    try {
      const savedStatsState = sessionStorage.getItem('matrix_show_team_stats');
      if (savedStatsState !== null) showTeamStats = JSON.parse(savedStatsState);
    } catch (e) {}

    function renderMatrix() {
      const scrollHint = `
        <div class="matrix-controls-bar">
          <span class="matrix-hint-text">↔️ ${playerEntries.length} players — <strong>tap ◀ ▶ or drag</strong> header to reorder columns. Your column is highlighted in amber.</span>
          <div class="matrix-btn-group">
            <button id="toggleTeamStatsBtn" class="btn btn-secondary" style="font-size:11px; padding:4px 8px;">${showTeamStats ? '📊 Hide Team Stats' : '📊 Show Team Stats'}</button>
            ${currentUser ? `<button id="pinMyColBtn" class="btn btn-secondary" style="font-size:11px; padding:4px 8px;">📌 Move Me First</button>` : ''}
            <button id="resetColOrderBtn" class="btn btn-secondary" style="font-size:11px; padding:4px 8px;">Reset Order</button>
          </div>
        </div>
      `;

      const statsHeaders = showTeamStats ? '<th>Pts</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Form</th>' : '';
      const header = `<tr>
        <th>Team</th>${statsHeaders}
        ${playerEntries.map((p, idx) => `
          <th class="player-col-th ${currentUser && p.uid === currentUser.uid ? 'own-col' : ''}" draggable="true" data-uid="${p.uid}" title="Drag or tap ◀ ▶ to reorder">
            <div class="player-th-content">
              <button type="button" class="col-arrow-btn move-left" data-uid="${p.uid}" data-dir="-1" title="Move left" aria-label="Move left" ${idx === 0 ? 'disabled' : ''}>◀</button>
              ${avatarHTML(p.uid, users, '20px')}
              <span class="player-col-name">${p.name}</span>
              <button type="button" class="col-arrow-btn move-right" data-uid="${p.uid}" data-dir="1" title="Move right" aria-label="Move right" ${idx === playerEntries.length - 1 ? 'disabled' : ''}>▶</button>
              <span class="col-drag-handle" title="Drag to reorder">⋮⋮</span>
            </div>
          </th>
        `).join('')}
      </tr>`;

      const rows = teamRows.map((teamName, idx) => {
        const actualPos = idx + 1;
        const actualZone = positionZoneClass(actualPos, totalTeams);
        const s = getStatsFor(teamName);
        const statsCells = showTeamStats ? `
          <td class="stat-col" style="font-weight:700; color:var(--chalk);">${s?.points ?? '–'}</td>
          <td class="stat-col">${s?.won ?? '–'}</td>
          <td class="stat-col">${s?.draw ?? '–'}</td>
          <td class="stat-col">${s?.lost ?? '–'}</td>
          <td class="stat-col">${s && s.goalDifference != null ? (s.goalDifference > 0 ? '+' : '') + s.goalDifference : '–'}</td>
          <td class="stat-col">${s ? formChips(s.form) : '–'}</td>
        ` : '';
        return `
        <tr>
          <td>
            <span class="team-name ${actualZone}">${teamName}</span>
            <span class="actual-standing ${actualZone}">#${actualPos}</span>
          </td>
          ${statsCells}
          ${playerEntries.map(p => {
            const predPos = p.positions[teamName];
            const zone = positionZoneClass(predPos, totalTeams);
            const isMine = currentUser && p.uid === currentUser.uid;
            let indicator = '';
            if (predPos != null && !usingFallback) {
              const diff = Math.abs(predPos - actualPos);
              if (diff === 0) {
                indicator = '<span class="matrix-tick-icon" title="Exact match! (Rank #' + actualPos + ')">✓</span>';
              } else if (diff === 1) {
                indicator = '<span class="matrix-dot dot-diff-1" title="Off by 1 (Predicted #' + predPos + ', Actual #' + actualPos + ')"></span>';
              } else if (diff === 2) {
                indicator = '<span class="matrix-dot dot-diff-2" title="Off by 2 (Predicted #' + predPos + ', Actual #' + actualPos + ')"></span>';
              }
            }
            return `<td class="pos-num ${zone}" style="${isMine ? 'background:rgba(255,182,39,0.08);' : ''}">${predPos ?? '–'}${indicator}</td>`;
          }).join('')}
        </tr>
      `;
      }).join('');

      grid.innerHTML = `${fallbackNotice}${scrollHint}<div class="table-scroll"><table class="matrix-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;

      // Helper action buttons
      const toggleStatsBtn = document.getElementById('toggleTeamStatsBtn');
      if (toggleStatsBtn) {
        toggleStatsBtn.onclick = () => {
          showTeamStats = !showTeamStats;
          try { sessionStorage.setItem('matrix_show_team_stats', JSON.stringify(showTeamStats)); } catch (e) {}
          renderMatrix();
        };
      }

      const pinBtn = document.getElementById('pinMyColBtn');
      if (pinBtn) {
        pinBtn.onclick = () => {
          const myIdx = playerEntries.findIndex(p => p.uid === currentUser.uid);
          if (myIdx > 0) {
            const [me] = playerEntries.splice(myIdx, 1);
            playerEntries.unshift(me);
            savePlayerOrder();
            renderMatrix();
          }
        };
      }

      const resetBtn = document.getElementById('resetColOrderBtn');
      if (resetBtn) {
        resetBtn.onclick = () => {
          playerEntries.sort((a, b) => a.name.localeCompare(b.name));
          try { sessionStorage.removeItem('matrix_player_order'); } catch (e) {}
          renderMatrix();
        };
      }

      // Column shift buttons (◀ and ▶)
      grid.querySelectorAll('.col-arrow-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const uid = btn.dataset.uid;
          const dir = parseInt(btn.dataset.dir, 10);
          const currIdx = playerEntries.findIndex(p => p.uid === uid);
          if (currIdx === -1) return;
          const targetIdx = currIdx + dir;
          if (targetIdx < 0 || targetIdx >= playerEntries.length) return;

          const [movedPlayer] = playerEntries.splice(currIdx, 1);
          playerEntries.splice(targetIdx, 0, movedPlayer);
          savePlayerOrder();
          renderMatrix();
        });
      });

      enableMatrixColumnDrag(grid.querySelector('.matrix-table'), playerEntries, renderMatrix, savePlayerOrder);
    }

    function savePlayerOrder() {
      try {
        sessionStorage.setItem('matrix_player_order', JSON.stringify(playerEntries.map(p => p.uid)));
      } catch (e) {}
    }

    renderMatrix();

  } catch (err) {
    console.error('loadAllTables Error:', err);
    grid.innerHTML = `<p class="empty-state">Failed to load community predictions. (${err.message})</p>`;
  }
}

function enableMatrixColumnDrag(tableEl, playerEntries, renderMatrix, savePlayerOrder) {
  if (!tableEl) return;
  let draggedUid = null;
  const ths = tableEl.querySelectorAll('th.player-col-th');
  ths.forEach(th => {
    th.addEventListener('dragstart', (e) => {
      draggedUid = th.dataset.uid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedUid);
      th.classList.add('dragging-col');
    });

    th.addEventListener('dragend', () => {
      th.classList.remove('dragging-col');
      ths.forEach(t => t.classList.remove('drag-over-col'));
    });

    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      th.classList.add('drag-over-col');
    });

    th.addEventListener('dragleave', () => {
      th.classList.remove('drag-over-col');
    });

    th.addEventListener('drop', (e) => {
      e.preventDefault();
      th.classList.remove('drag-over-col');
      const targetUid = th.dataset.uid;
      if (!draggedUid || draggedUid === targetUid) return;

      const fromIdx = playerEntries.findIndex(p => p.uid === draggedUid);
      const toIdx = playerEntries.findIndex(p => p.uid === targetUid);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = playerEntries.splice(fromIdx, 1);
      playerEntries.splice(toIdx, 0, moved);

      savePlayerOrder();
      renderMatrix();
    });
  });
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
  const podiumEl = document.getElementById('seasonPodium');
  grid.innerHTML = '<p class="empty-state">Loading…</p>';
  if (podiumEl) podiumEl.innerHTML = '';

  const [fixtures, users, cfg, lbSnap] = await Promise.all([
    getAllFixtures(),
    getUsersMap(),
    loadConfig(),
    getDocs(query(collection(db, 'leaderboard'), orderBy('rank', 'asc')))
  ]);
  if (!fixtures.length) { grid.innerHTML = '<p class="empty-state">No fixtures synced yet.</p>'; return; }

  // Render Overall Season Podium (Top 3)
  if (podiumEl && !lbSnap.empty) {
    const lbRows = lbSnap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(r => (r.totalPoints || 0) > 0);
    if (lbRows.length > 0) {
      const top1 = lbRows[0];
      const top2 = lbRows[1];
      const top3 = lbRows[2];

      const renderPodiumCard = (p, rankNum, tagText, tagClass, animWrap, ptsClass) => {
        if (!p) return '';
        const name = p.displayName || users[p.uid]?.displayName || p.email || 'Player';
        const predicted = p.matchesPredicted ?? p.predictedCount ?? 0;
        const correct = p.correctPredictions ?? p.correctCount ?? 0;
        const perfect = p.perfectPredictions ?? p.exactCount ?? 0;
        const accuracy = p.accuracyPct ?? (predicted > 0 ? Math.round((correct / predicted) * 100) : 0);
        return `
          <div class="podium-card podium-rank-${rankNum}">
            <div class="star-badge-header">
              <div class="star-left-group">
                ${animWrap}
                <div class="star-title-wrap">
                  <div class="star-tag ${tagClass}">${tagText}</div>
                  <div class="star-player-name">${avatarHTML(p.uid, users, '26px')} <span>${name}</span></div>
                </div>
              </div>
              <div class="${ptsClass}">
                <span class="star-pts-num">${p.totalPoints || 0}</span>
                <span class="star-pts-lbl">TOTAL PTS</span>
              </div>
            </div>
            <div class="star-stats-grid">
              <div class="star-stat"><span class="lbl">Predicted</span><span class="val">${predicted}</span></div>
              <div class="star-stat"><span class="lbl">Correct</span><span class="val">${correct}</span></div>
              <div class="star-stat"><span class="lbl">Accuracy</span><span class="val">${accuracy}%</span></div>
              <div class="star-stat"><span class="lbl">Perfect</span><span class="val">${perfect} 🎯</span></div>
            </div>
          </div>
        `;
      };

      const starAnim = `
        <div class="star-anim-wrap" title="Star Predictor">
          <span class="flying-ball">⚽</span>
          <span class="kicking-player">🏃‍♂️</span>
          <span class="star-trophy">🌟</span>
        </div>
      `;
      const challengerAnim = `
        <div class="challenger-anim-wrap" title="Challenger">
          <span class="fist-bump">👊</span>
          <span class="challenger-medal">🥈</span>
        </div>
      `;
      const bronzeAnim = `
        <div class="bronze-anim-wrap" title="In-The-Run">
          <span class="walking-player">🚶</span>
          <span class="bronze-medal">🥉</span>
        </div>
      `;

      podiumEl.innerHTML = `
        <div class="podium-section-wrap">
          <div class="podium-header-bar">
            <span class="podium-title">🏆 Overall Season Leaderboard & Podium</span>
            <span class="podium-sub">Ranked by total points across all gameweeks</span>
          </div>
          <div class="podium-cards-grid">
            ${renderPodiumCard(top1, 1, '👑 Star Predictor · 1st', 'gold-tag', starAnim, 'star-total-pts')}
            ${renderPodiumCard(top2, 2, '🥈 Challenger · 2nd', 'silver-tag', challengerAnim, 'challenger-total-pts')}
            ${renderPodiumCard(top3, 3, '🥉 In-The-Run · 3rd', 'bronze-tag', bronzeAnim, 'bronze-total-pts')}
          </div>
        </div>
      `;
    }
  }

  const byGW = {};
  fixtures.forEach(f => { (byGW[f.gameweek] = byGW[f.gameweek] || []).push(f); });

  const currentGWNum = cfg.currentGameweek || Math.min(...fixtures.map(f => Number(f.gameweek)));
  const allGwNumbers = Object.keys(byGW).map(Number).filter(gw => gw <= currentGWNum).sort((a, b) => b - a);
  const gwNumbers = showAll ? allGwNumbers : allGwNumbers.slice(0, RECENT_GW_WINDOW);

  const visibleFixtureIds = gwNumbers.flatMap(gw => byGW[gw].map(f => f.id));
  const [preds, extrasSnap] = await Promise.all([
    fetchPredictionsForFixtureIds(visibleFixtureIds),
    getDocs(collection(db, 'gwExtraPredictions'))
  ]);

  const predsByFixture = {};
  preds.forEach(p => { (predsByFixture[p.fixtureId] = predsByFixture[p.fixtureId] || []).push(p); });

  const extrasByGW = {};
  extrasSnap.forEach(d => {
    const e = d.data();
    if (e && e.gameweek) {
      (extrasByGW[e.gameweek] = extrasByGW[e.gameweek] || []).push(e);
    }
  });

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

    // Calculate per-player stats for this gameweek (matches + extras)
    const userGwStats = {};
    gwFixtures.forEach(fx => {
      const fixturePreds = predsByFixture[fx.id] || [];
      fixturePreds.forEach(p => {
        if (!userGwStats[p.uid]) {
          userGwStats[p.uid] = {
            uid: p.uid,
            name: users[p.uid]?.displayName || 'Player',
            totalPoints: 0,
            predicted: 0,
            correct: 0,
            perfect: 0,
            scoredCount: 0
          };
        }
        const st = userGwStats[p.uid];
        st.predicted++;
        if (p.scored) {
          st.scoredCount++;
          st.totalPoints += (p.points || 0);
          if (p.points === 25) {
            st.perfect++;
            st.correct++;
          } else if (p.points === 10) {
            st.correct++;
          }
        }
      });
    });

    const gwExtras = extrasByGW[gw] || [];
    gwExtras.forEach(e => {
      if (e.scored && e.points) {
        if (!userGwStats[e.uid]) {
          userGwStats[e.uid] = {
            uid: e.uid,
            name: users[e.uid]?.displayName || 'Player',
            totalPoints: 0,
            predicted: 0,
            correct: 0,
            perfect: 0,
            scoredCount: 0
          };
        }
        userGwStats[e.uid].totalPoints += (e.points || 0);
      }
    });

    Object.values(userGwStats).forEach(st => {
      st.accuracy = st.scoredCount > 0 ? Math.round((st.correct / st.scoredCount) * 100) : 0;
    });

    const starPlayers = Object.values(userGwStats).filter(st => st.totalPoints > 0)
      .sort((a, b) => b.totalPoints - a.totalPoints || b.perfect - a.perfect || b.correct - a.correct);
    const star = starPlayers[0] || null;
    const challenger = starPlayers[1] || null;

    if (star) {
      const performersGrid = document.createElement('div');
      performersGrid.className = 'gw-performers-grid';

      const starCardHTML = `
        <div class="gw-star-card">
          <div class="star-badge-header">
            <div class="star-left-group">
              <div class="star-anim-wrap" title="Star of the Gameweek">
                <span class="flying-ball">⚽</span>
                <span class="kicking-player">🏃‍♂️</span>
                <span class="star-trophy">🌟</span>
              </div>
              <div class="star-title-wrap">
                <div class="star-tag">⭐ Star of Gameweek ${gw}</div>
                <div class="star-player-name">${avatarHTML(star.uid, users, '26px')} <span>${star.name}</span></div>
              </div>
            </div>
            <div class="star-total-pts">
              <span class="star-pts-num">${star.totalPoints}</span>
              <span class="star-pts-lbl">GW PTS</span>
            </div>
          </div>
          <div class="star-stats-grid">
            <div class="star-stat"><span class="lbl">Predicted</span><span class="val">${star.predicted}</span></div>
            <div class="star-stat"><span class="lbl">Correct</span><span class="val">${star.correct}</span></div>
            <div class="star-stat"><span class="lbl">Accuracy</span><span class="val">${star.accuracy}%</span></div>
            <div class="star-stat"><span class="lbl">Perfect</span><span class="val">${star.perfect} 🎯</span></div>
          </div>
        </div>
      `;

      let challengerCardHTML = '';
      if (challenger) {
        challengerCardHTML = `
          <div class="gw-challenger-card">
            <div class="star-badge-header">
              <div class="star-left-group">
                <div class="challenger-anim-wrap" title="Challenger of the Gameweek">
                  <span class="fist-bump">👊</span>
                  <span class="challenger-medal">🥈</span>
                </div>
                <div class="star-title-wrap">
                  <div class="challenger-tag">🥈 Challenger of Gameweek ${gw}</div>
                  <div class="star-player-name">${avatarHTML(challenger.uid, users, '26px')} <span>${challenger.name}</span></div>
                </div>
              </div>
              <div class="challenger-total-pts">
                <span class="star-pts-num">${challenger.totalPoints}</span>
                <span class="star-pts-lbl">GW PTS</span>
              </div>
            </div>
            <div class="star-stats-grid">
              <div class="star-stat"><span class="lbl">Predicted</span><span class="val">${challenger.predicted}</span></div>
              <div class="star-stat"><span class="lbl">Correct</span><span class="val">${challenger.correct}</span></div>
              <div class="star-stat"><span class="lbl">Accuracy</span><span class="val">${challenger.accuracy}%</span></div>
              <div class="star-stat"><span class="lbl">Perfect</span><span class="val">${challenger.perfect} 🎯</span></div>
            </div>
          </div>
        `;
      }

      performersGrid.innerHTML = starCardHTML + challengerCardHTML;
      details.appendChild(performersGrid);
    }

    // Compute Extras Actuals for this gameweek if any matches have finished
    const finishedGwFixtures = gwFixtures.filter(f => f.status === 'FINISHED' && f.homeScore !== null && f.awayScore !== null);
    if (finishedGwFixtures.length > 0) {
      const totalExtrasCount = gwExtras.length;

      // 1. Highest scoring team(s)
      const teamGoals = {};
      finishedGwFixtures.forEach(f => {
        teamGoals[f.homeTeam] = (teamGoals[f.homeTeam] || 0) + (f.homeScore || 0);
        teamGoals[f.awayTeam] = (teamGoals[f.awayTeam] || 0) + (f.awayScore || 0);
      });
      const maxGoals = Math.max(...Object.values(teamGoals));
      const topScoringTeams = Object.entries(teamGoals).filter(([, g]) => g === maxGoals).map(([t]) => t);
      const topTeamCorrect = gwExtras.filter(e => topScoringTeams.includes(e.topScoringTeam)).length;
      const topTeamPct = totalExtrasCount > 0 ? Math.round((topTeamCorrect / totalExtrasCount) * 100) : 0;
      const topTeamStr = `${topScoringTeams.join(', ')} (${maxGoals} goal${maxGoals === 1 ? '' : 's'})`;
      const topTeamHitPlayers = gwExtras.filter(e => topScoringTeams.includes(e.topScoringTeam)).map(e => users[e.uid]?.displayName || users[e.uid]?.email || 'Player');

      // 2. Clean sheet team(s)
      const cleanSheetTeams = [];
      finishedGwFixtures.forEach(f => {
        if (f.awayScore === 0) cleanSheetTeams.push(f.homeTeam);
        if (f.homeScore === 0) cleanSheetTeams.push(f.awayTeam);
      });
      const cleanSheetSet = new Set(cleanSheetTeams);
      const csCorrect = gwExtras.filter(e => cleanSheetSet.has(e.cleanSheetTeam)).length;
      const csPct = totalExtrasCount > 0 ? Math.round((csCorrect / totalExtrasCount) * 100) : 0;
      const csStr = cleanSheetTeams.length ? cleanSheetTeams.join(', ') : 'None';
      const csHitPlayers = gwExtras.filter(e => cleanSheetSet.has(e.cleanSheetTeam)).map(e => users[e.uid]?.displayName || users[e.uid]?.email || 'Player');

      // 3. Highest scoring game(s)
      const matchGoals = finishedGwFixtures.map(f => ({ fx: f, total: (f.homeScore || 0) + (f.awayScore || 0) }));
      const maxMatchGoals = Math.max(...matchGoals.map(m => m.total));
      const topMatches = matchGoals.filter(m => m.total === maxMatchGoals);
      const topMatchIds = new Set(topMatches.flatMap(m => [String(m.fx.id), Number(m.fx.id)]));
      const highGameCorrect = gwExtras.filter(e => e.highestScoringGame && topMatchIds.has(e.highestScoringGame)).length;
      const highGamePct = totalExtrasCount > 0 ? Math.round((highGameCorrect / totalExtrasCount) * 100) : 0;
      const highGameStr = topMatches.map(m => `${m.fx.homeTeam} ${m.fx.homeScore}–${m.fx.awayScore} ${m.fx.awayTeam} (${m.total}g)`).join(' · ');
      const highGameHitPlayers = gwExtras.filter(e => e.highestScoringGame && topMatchIds.has(e.highestScoringGame)).map(e => users[e.uid]?.displayName || users[e.uid]?.email || 'Player');

      // 4. Lowest scoring game(s)
      const minMatchGoals = Math.min(...matchGoals.map(m => m.total));
      const lowMatches = matchGoals.filter(m => m.total === minMatchGoals);
      const lowMatchIds = new Set(lowMatches.flatMap(m => [String(m.fx.id), Number(m.fx.id)]));
      const lowGameCorrect = gwExtras.filter(e => e.lowestScoringGame && lowMatchIds.has(e.lowestScoringGame)).length;
      const lowGamePct = totalExtrasCount > 0 ? Math.round((lowGameCorrect / totalExtrasCount) * 100) : 0;
      const lowGameStr = lowMatches.map(m => `${m.fx.homeTeam} ${m.fx.homeScore}–${m.fx.awayScore} ${m.fx.awayTeam} (${m.total}g)`).join(' · ');
      const lowGameHitPlayers = gwExtras.filter(e => e.lowestScoringGame && lowMatchIds.has(e.lowestScoringGame)).map(e => users[e.uid]?.displayName || users[e.uid]?.email || 'Player');

      const formatHitPlayers = (names) => {
        if (!names.length) return '<div class="item-hit-players none">No players predicted this</div>';
        return `<div class="item-hit-players">🎯 <strong>Hit by (${names.length}):</strong> ${names.join(', ')}</div>`;
      };

      const extrasCard = document.createElement('div');
      extrasCard.className = 'gw-extras-actual-card';
      extrasCard.innerHTML = `
        <div class="gw-extras-actual-title">⚡ Gameweek ${gw} Extras — Actual Results</div>
        <div class="extras-rows">
          <div class="extras-row">
            <div class="gw-extras-actual-item">
              <span class="item-lbl">🎯 Top Scoring Team</span>
              <span class="item-val">${topTeamStr}</span>
              <span class="item-pct">predicted by ${topTeamPct}% (${topTeamCorrect}/${totalExtrasCount})</span>
              ${formatHitPlayers(topTeamHitPlayers)}
            </div>
            <div class="gw-extras-actual-item">
              <span class="item-lbl">🛡️ Clean Sheet</span>
              <span class="item-val">${csStr}</span>
              <span class="item-pct">${cleanSheetTeams.length ? `predicted by ${csPct}% (${csCorrect}/${totalExtrasCount})` : '–'}</span>
              ${formatHitPlayers(csHitPlayers)}
            </div>
          </div>
          <div class="extras-row">
            <div class="gw-extras-actual-item">
              <span class="item-lbl">🔥 Highest Scoring Game</span>
              <span class="item-val">${highGameStr}</span>
              <span class="item-pct">predicted by ${highGamePct}% (${highGameCorrect}/${totalExtrasCount})</span>
              ${formatHitPlayers(highGameHitPlayers)}
            </div>
            <div class="gw-extras-actual-item">
              <span class="item-lbl">🔒 Lowest Scoring Game</span>
              <span class="item-val">${lowGameStr}</span>
              <span class="item-pct">predicted by ${lowGamePct}% (${lowGameCorrect}/${totalExtrasCount})</span>
              ${formatHitPlayers(lowGameHitPlayers)}
            </div>
          </div>
        </div>
      `;
      details.appendChild(extrasCard);
    }

    gwFixtures.forEach(fx => {
      const fixturePreds = predsByFixture[fx.id] || [];
      const isFinished = fx.status === 'FINISHED';
      const isLive = fx.status === 'IN_PLAY' || fx.status === 'PAUSED';
      const actual = isFinished ? outcomeInfo(fx.homeScore, fx.awayScore, fx.homeTeam, fx.awayTeam) : null;

      const rows = fixturePreds.map(p => {
        const info = outcomeInfo(p.predHome, p.predAway, fx.homeTeam, fx.awayTeam);
        let resultIcon = '';
        if (isFinished) {
          const isExact = p.predHome === fx.homeScore && p.predAway === fx.awayScore;
          if (isExact) {
            resultIcon = '<span class="result-bullseye" title="Perfect prediction — exact score">🎯</span> <span class="result-tick" title="Correct outcome">✅</span>';
          } else if (info.kind === actual.kind) {
            resultIcon = '<span class="result-tick" title="Correct outcome, wrong scoreline">✅</span>';
          } else {
            resultIcon = '<span class="result-cross" title="Wrong outcome">❌</span>';
          }
        }
        const isMine = currentUser && p.uid === currentUser.uid;
        return `<tr class="${isMine ? 'my-prediction-row' : ''}">
          <td class="player-name ${info.cls}">${isMine ? '👤 ' : ''}${users[p.uid]?.displayName || 'Unknown'}${isMine ? ' (You)' : ''}</td>
          <td class="score-cell ${info.cls}">${p.predHome}–${p.predAway}</td>
          <td class="outcome-cell ${info.cls}">${info.text}</td>
          <td class="result-icon">${resultIcon}</td>
        </tr>`;
      }).join('');

      // Build the score/status line shown next to the match title
      const scoreDisplay = isFinished
        ? `<span class="comm-ft">FT: ${fx.homeScore}–${fx.awayScore}</span>`
        : isLive
        ? `<span class="comm-live"><span class="live-dot"></span>${fx.homeScore ?? 0}–${fx.awayScore ?? 0}</span>`
        : '';

      const card = document.createElement('div');
      card.className = 'community-fixture' + (isLive ? ' fixture-live-card' : '');
      card.innerHTML = `
        <h3>${fx.homeTeam} vs ${fx.awayTeam} ${scoreDisplay ? `<span class="comm-score-wrap">${scoreDisplay}</span>` : ''}</h3>
        ${isLive ? `<div class="live-score-bar" style="margin:-4px 0 12px;"><span class="live-dot"></span><span class="live-score-num">${fx.homeScore ?? 0} – ${fx.awayScore ?? 0}</span><span class="live-sync-note">score as of last hourly sync</span></div>` : ''}
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
  const head = document.getElementById('leaderboardHead');
  const body = document.getElementById('leaderboardBody');
  body.innerHTML = '<tr><td colspan="12" class="empty-state">Loading leaderboard…</td></tr>';

  const [snap, fixtures, allPredsSnap, extrasSnap] = await Promise.all([
    getDocs(query(collection(db, 'leaderboard'), orderBy('rank', 'asc'))),
    getAllFixtures(),
    getDocs(collection(db, 'predictions')),
    getDocs(collection(db, 'gwExtraPredictions'))
  ]);

  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
  const totalPlayers = rows.length;

  const fixtureGW = {};
  fixtures.forEach(f => { fixtureGW[f.id] = Number(f.gameweek); });

  // Dynamically compute/ensure gwPoints for all players across all scored predictions
  const computedGwPoints = {};
  allPredsSnap.forEach(d => {
    const p = d.data();
    if (p.scored && p.fixtureId && fixtureGW[p.fixtureId] && (p.points || 0) > 0) {
      const gw = fixtureGW[p.fixtureId];
      if (!computedGwPoints[p.uid]) computedGwPoints[p.uid] = {};
      computedGwPoints[p.uid][gw] = (computedGwPoints[p.uid][gw] || 0) + (p.points || 0);
    }
  });
  extrasSnap.forEach(d => {
    const e = d.data();
    if (e.scored && e.gameweek && (e.points || 0) > 0) {
      const gw = Number(e.gameweek);
      if (!computedGwPoints[e.uid]) computedGwPoints[e.uid] = {};
      computedGwPoints[e.uid][gw] = (computedGwPoints[e.uid][gw] || 0) + (e.points || 0);
    }
  });

  // Merge computedGwPoints into rows
  rows.forEach(r => {
    r.gwPoints = { ...(computedGwPoints[r.uid] || {}), ...(r.gwPoints || {}) };
  });

  // Collect all scored gameweeks across all players
  const gwSet = new Set();
  rows.forEach(r => {
    if (r.gwPoints) Object.keys(r.gwPoints).forEach(gw => gwSet.add(Number(gw)));
  });
  // Also check finished fixtures in case a GW finished
  fixtures.forEach(f => {
    if (f.status === 'FINISHED') gwSet.add(Number(f.gameweek));
  });
  const allGWs = [...gwSet].sort((a, b) => a - b);

  // Compute Best Gameweek for each player
  rows.forEach(r => {
    if (!r.gwPoints || !Object.keys(r.gwPoints).length) {
      r.bestGW = '–';
    } else {
      const entries = Object.entries(r.gwPoints).map(([gw, pts]) => ({ gw: Number(gw), pts: Number(pts) })).filter(e => e.pts > 0);
      if (!entries.length) {
        r.bestGW = '–';
      } else {
        const maxPts = Math.max(...entries.map(e => e.pts));
        const matching = entries.filter(e => e.pts === maxPts).sort((a, b) => a.gw - b.gw);
        const best = matching[0];
        r.bestGW = `GW ${best.gw} (${best.pts} pts)`;
      }
    }
  });

  // For each gameweek, compute rank 1, 2, 3 scores across all players
  const gwTopScores = {};
  allGWs.forEach(gw => {
    const scores = rows.map(r => r.gwPoints?.[gw] || 0).filter(s => s > 0);
    const distinct = [...new Set(scores)].sort((a, b) => b - a);
    gwTopScores[gw] = {
      gold: distinct[0] || null,
      silver: distinct[1] || null,
      bronze: distinct[2] || null
    };
  });

  // Build header row:
  // Column order: Rank | Player | Total (frozen trio) | Best GW | Match Pts | Table Pts | Extras | Streak | Predicted | Correct | Perfect | Accuracy | GW 1 | GW 2 | …
  const staticHeaders = ['Best GW', 'Match Pts', 'Table Pts', 'Extras', 'Streak', 'Predicted', 'Correct', 'Perfect', 'Accuracy'];
  const gwHeaders = allGWs.map(gw => `GW ${gw}`);
  head.innerHTML = `<tr>
    <th class="lb-freeze lb-rank">Rank</th>
    <th class="lb-freeze lb-player">Player</th>
    <th class="lb-freeze lb-total">Total</th>
    ${staticHeaders.map(h => `<th>${h}</th>`).join('')}
    ${gwHeaders.map(h => `<th class="lb-gw-col">${h}</th>`).join('')}
  </tr>`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${3 + staticHeaders.length + allGWs.length}" class="empty-state">Leaderboard populates after the first gameweek is scored.</td></tr>`;
    return;
  }

  body.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const zone = positionZoneClass(r.rank, totalPlayers);
    if (zone) tr.classList.add(zone);

    const gwCells = allGWs.map(gw => {
      const pts = r.gwPoints?.[gw];
      if (pts === undefined || pts === null) return `<td class="lb-gw-col">–</td>`;
      const tops = gwTopScores[gw];
      let medalIcon = '';
      if (pts > 0) {
        if (pts === tops.gold) medalIcon = '<span class="lb-gw-medal" title="Star of Gameweek (1st)">🌟</span> ';
        else if (pts === tops.silver) medalIcon = '<span class="lb-gw-medal" title="Challenger of Gameweek (2nd)">🥈</span> ';
        else if (pts === tops.bronze) medalIcon = '<span class="lb-gw-medal" title="In-The-Run (3rd)">🥉</span> ';
      }
      return `<td class="lb-gw-col">${medalIcon}${pts}</td>`;
    }).join('');

    const accuracy = r.accuracyPct ?? (r.matchesPredicted > 0 ? Math.round(((r.correctPredictions || 0) / r.matchesPredicted) * 100) : 0);

    let rankDisplay = `${r.rank}`;
    if (r.rank === 1) rankDisplay = `<span title="1st Place · Leader">👑</span> 1`;
    else if (r.rank === 2) rankDisplay = `<span title="2nd Place · Challenger">🥈</span> 2`;
    else if (r.rank === 3) rankDisplay = `<span title="3rd Place · In-The-Run">🥉</span> 3`;

    tr.innerHTML = `
      <td class="lb-freeze lb-rank">${rankDisplay}</td>
      <td class="lb-freeze lb-player" title="${r.displayName || r.email || r.uid}">${r.displayName || r.email || r.uid}</td>
      <td class="lb-freeze lb-total">${r.totalPoints || 0}</td>
      <td style="font-family:var(--font-mono); font-weight:700; color:var(--chalk); white-space:nowrap;">${r.bestGW}</td>
      <td>${r.matchPoints || 0}</td>
      <td>${r.tablePoints || 0}</td>
      <td>${r.extraPoints || 0}</td>
      <td>${r.currentStreak || 0}</td>
      <td>${r.matchesPredicted || 0}</td>
      <td>${r.correctPredictions || 0}</td>
      <td>${r.perfectPredictions || 0}</td>
      <td>${accuracy}%</td>
      ${gwCells}
    `;
    body.appendChild(tr);
  });

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
  grid.innerHTML = list.map(p => {
    const rankBadge = p.rank === 1 ? '👑 #1' : p.rank === 2 ? '🥈 #2' : p.rank === 3 ? '🥉 #3' : (p.rank ? `#${p.rank}` : '');
    return `
      <div class="player-card">
        <div class="name">${p.name}${rankBadge ? ` <span style="color:var(--chalk-dim); font-family:var(--font-mono); font-size:11px;">${rankBadge}</span>` : ''}</div>
        <div class="meta">${p.totalPoints} pts total ${p.badgeCount ? `· 🥇 ${p.badgeCount}` : ''}</div>
        <div class="meta">🎯 ${p.matchPoints} · 📋 ${p.tablePoints} · ⚡ ${p.extraPoints} ${p.currentStreak ? `· 🔥 ${p.currentStreak}-streak` : ''}</div>
        <div class="meta">🎪 ${p.exactCount} perfect ${p.accuracyPct ? `· ✅ ${p.accuracyPct}% accuracy` : ''}</div>
      </div>
    `;
  }).join('');
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

  const [predsSnap, allFixtures, lbSnap, badgesSnap, allPredsSnap, extrasSnap, tablePredSnap, cfgSnap] = await Promise.all([
    getDocs(query(collection(db, 'predictions'), where('uid', '==', currentUser.uid))),
    getAllFixtures(),
    getDoc(doc(db, 'leaderboard', currentUser.uid)),
    getDoc(doc(db, 'badges', currentUser.uid)),
    getDocs(collection(db, 'predictions')),
    getDocs(collection(db, 'gwExtraPredictions')),
    getDoc(doc(db, 'tablePredictions', currentUser.uid)),
    getDoc(doc(db, 'config', 'current'))
  ]);
  const fixturesById = {};
  const fixturesByGW = {};
  allFixtures.forEach(f => {
    fixturesById[f.id] = f;
    if (!fixturesByGW[f.gameweek]) fixturesByGW[f.gameweek] = [];
    fixturesByGW[f.gameweek].push(f);
  });

  const preds = predsSnap.docs.map(d => d.data()).sort((a, b) => {
    const fa = fixturesById[a.fixtureId], fb = fixturesById[b.fixtureId];
    return new Date(fb?.kickoffUTC || 0) - new Date(fa?.kickoffUTC || 0);
  });

  const scoredPreds = preds.filter(p => p.scored);
  const exactCount = scoredPreds.filter(p => p.points === 25).length;
  const outcomeCount = scoredPreds.filter(p => p.points === 10).length;
  const accuracy = scoredPreds.length ? Math.round(((exactCount + outcomeCount) / scoredPreds.length) * 100) : 0;
  const lb = lbSnap.exists() ? lbSnap.data() : {};
  const cfg = cfgSnap.exists() ? cfgSnap.data() : {};

  // Process user's extras
  const myExtras = extrasSnap.docs.map(d => d.data()).filter(e => e.uid === currentUser.uid);
  const myExtrasByGW = {};
  myExtras.forEach(e => { myExtrasByGW[e.gameweek] = e; });

  let myExtrasPicksTotal = 0;
  let myExtrasPicksHit = 0;
  let totalExtrasPoints = 0;

  myExtras.forEach(e => {
    totalExtrasPoints += (e.points || 0);
    const gw = e.gameweek;
    const gwFixtures = fixturesByGW[gw] || [];
    const gwFinished = gwFixtures.filter(f => f.status === 'FINISHED');
    const isGwDone = gwFinished.length === gwFixtures.length && gwFixtures.length > 0;
    if (isGwDone) {
      // 1. Top scoring team
      if (e.topScoringTeam) {
        myExtrasPicksTotal++;
        const goalsByTeam = {};
        gwFixtures.forEach(f => {
          goalsByTeam[f.homeTeam] = (goalsByTeam[f.homeTeam] || 0) + (f.homeScore ?? 0);
          goalsByTeam[f.awayTeam] = (goalsByTeam[f.awayTeam] || 0) + (f.awayScore ?? 0);
        });
        const maxGoals = Math.max(...Object.values(goalsByTeam), 0);
        const topTeams = Object.keys(goalsByTeam).filter(t => goalsByTeam[t] === maxGoals && maxGoals > 0);
        if (topTeams.includes(e.topScoringTeam)) myExtrasPicksHit++;
      }
      // 2. Clean sheet team
      if (e.cleanSheetTeam) {
        myExtrasPicksTotal++;
        const csTeams = [];
        gwFixtures.forEach(f => {
          if (f.awayScore === 0) csTeams.push(f.homeTeam);
          if (f.homeScore === 0) csTeams.push(f.awayTeam);
        });
        if (csTeams.includes(e.cleanSheetTeam)) myExtrasPicksHit++;
      }
      // 3. Highest scoring game
      if (e.highestScoringGame) {
        myExtrasPicksTotal++;
        const matchGoals = gwFixtures.map(f => ({ id: f.id, total: (f.homeScore ?? 0) + (f.awayScore ?? 0) }));
        const maxMatchGoals = Math.max(...matchGoals.map(m => m.total), 0);
        const topMatchIds = new Set(matchGoals.filter(m => m.total === maxMatchGoals).flatMap(m => [String(m.id), Number(m.id)]));
        if (topMatchIds.has(e.highestScoringGame)) myExtrasPicksHit++;
      }
      // 4. Lowest scoring game
      if (e.lowestScoringGame) {
        myExtrasPicksTotal++;
        const matchGoals = gwFixtures.map(f => ({ id: f.id, total: (f.homeScore ?? 0) + (f.awayScore ?? 0) }));
        const minMatchGoals = Math.min(...matchGoals.map(m => m.total));
        const lowMatchIds = new Set(matchGoals.filter(m => m.total === minMatchGoals).flatMap(m => [String(m.id), Number(m.id)]));
        if (lowMatchIds.has(e.lowestScoringGame)) myExtrasPicksHit++;
      }
    }
  });

  // Calculate League Table Prediction live performance
  let currentTableLivePoints = 0;
  let exactTableHits = 0;
  let closeTableHits = 0;
  const tablePred = tablePredSnap.exists() ? tablePredSnap.data() : null;
  const standingsOrder = cfg?.standingsOrder || [];

  if (tablePred && Array.isArray(tablePred.teams) && tablePred.teams.length > 0 && standingsOrder.length > 0) {
    const actualPositions = {};
    standingsOrder.forEach((t, i) => { actualPositions[t] = i + 1; });
    currentTableLivePoints = calculateTableScore(tablePred.teams, actualPositions, 'final');

    tablePred.teams.forEach(t => {
      const actualRank = actualPositions[t.team];
      if (actualRank > 0) {
        const diff = Math.abs(t.predictedPosition - actualRank);
        if (diff === 0) exactTableHits++;
        else if (diff <= 1) closeTableHits++;
      }
    });
  }

  document.getElementById('profileStats').innerHTML = `
    <div class="profile-stat-card"><div class="value">${lb.totalPoints || 0}</div><div class="label">Total Points</div></div>
    <div class="profile-stat-card"><div class="value">${lb.rank ? '#' + lb.rank : '—'}</div><div class="label">Current Rank</div></div>
    <div class="profile-stat-card"><div class="value">${exactCount}</div><div class="label">Exact Match Scores</div></div>
    <div class="profile-stat-card"><div class="value">${accuracy}%</div><div class="label">Match Accuracy</div></div>
    <div class="profile-stat-card"><div class="value">${totalExtrasPoints} pts</div><div class="label">Extras (${myExtrasPicksHit}/${myExtrasPicksTotal || 0} hit)</div></div>
    <div class="profile-stat-card"><div class="value">${tablePred ? currentTableLivePoints + ' pts' : '–'}</div><div class="label">Table Live Score (${exactTableHits}/20 exact, ${closeTableHits} ±1)</div></div>
    <div class="profile-stat-card"><div class="value">${lb.currentStreak || 0}</div><div class="label">Current Streak</div></div>
  `;

  // Accolades / Honors Cards for this player
  const honorsEl = document.getElementById('profileHonors');
  if (honorsEl) {
    const honorCards = [];
    if (lb.rank === 1 && (lb.totalPoints || 0) > 0) {
      honorCards.push(`
        <div class="gw-star-card">
          <div class="star-badge-header">
            <div class="star-left-group">
              <div class="star-anim-wrap" title="Star Predictor"><span class="flying-ball">⚽</span><span class="kicking-player">🏃‍♂️</span><span class="star-trophy">🌟</span></div>
              <div class="star-title-wrap">
                <div class="star-tag">👑 Overall Season Leader · 1st Place</div>
                <div class="star-player-name">${currentUser.displayName}</div>
              </div>
            </div>
            <div class="star-total-pts"><span class="star-pts-num">${lb.totalPoints}</span><span class="star-pts-lbl">TOTAL PTS</span></div>
          </div>
        </div>
      `);
    } else if (lb.rank === 2 && (lb.totalPoints || 0) > 0) {
      honorCards.push(`
        <div class="gw-challenger-card">
          <div class="star-badge-header">
            <div class="star-left-group">
              <div class="challenger-anim-wrap" title="Challenger"><span class="fist-bump">👊</span><span class="challenger-medal">🥈</span></div>
              <div class="star-title-wrap">
                <div class="challenger-tag">🥈 Season Challenger · 2nd Place</div>
                <div class="star-player-name">${currentUser.displayName}</div>
              </div>
            </div>
            <div class="challenger-total-pts"><span class="star-pts-num">${lb.totalPoints}</span><span class="star-pts-lbl">TOTAL PTS</span></div>
          </div>
        </div>
      `);
    } else if (lb.rank === 3 && (lb.totalPoints || 0) > 0) {
      honorCards.push(`
        <div class="podium-card podium-rank-3">
          <div class="star-badge-header">
            <div class="star-left-group">
              <div class="bronze-anim-wrap" title="In-The-Run"><span class="walking-player">🚶</span><span class="bronze-medal">🥉</span></div>
              <div class="star-title-wrap">
                <div class="bronze-tag">🥉 Season In-The-Run · 3rd Place</div>
                <div class="star-player-name">${currentUser.displayName}</div>
              </div>
            </div>
            <div class="bronze-total-pts"><span class="star-pts-num">${lb.totalPoints}</span><span class="star-pts-lbl">TOTAL PTS</span></div>
          </div>
        </div>
      `);
    }

    // Calculate per-gameweek honors
    const fixtureGW = {};
    allFixtures.forEach(f => { fixtureGW[f.id] = Number(f.gameweek); });
    const userGwScores = {};
    allPredsSnap.forEach(d => {
      const p = d.data();
      if (p.scored && p.fixtureId && fixtureGW[p.fixtureId]) {
        const gw = fixtureGW[p.fixtureId];
        if (!userGwScores[gw]) userGwScores[gw] = {};
        userGwScores[gw][p.uid] = (userGwScores[gw][p.uid] || 0) + (p.points || 0);
      }
    });
    extrasSnap.forEach(d => {
      const e = d.data();
      if (e.scored && e.gameweek) {
        const gw = Number(e.gameweek);
        if (!userGwScores[gw]) userGwScores[gw] = {};
        userGwScores[gw][e.uid] = (userGwScores[gw][e.uid] || 0) + (e.points || 0);
      }
    });

    Object.keys(userGwScores).map(Number).sort((a, b) => b - a).forEach(gw => {
      const sorted = Object.entries(userGwScores[gw]).map(([uid, pts]) => ({ uid, pts })).filter(s => s.pts > 0).sort((a, b) => b.pts - a.pts);
      if (sorted.length > 0) {
        if (sorted[0]?.uid === currentUser.uid) {
          honorCards.push(`
            <div class="gw-star-card">
              <div class="star-badge-header">
                <div class="star-left-group">
                  <div class="star-anim-wrap" title="Star of the Gameweek"><span class="flying-ball">⚽</span><span class="kicking-player">🏃‍♂️</span><span class="star-trophy">🌟</span></div>
                  <div class="star-title-wrap">
                    <div class="star-tag">⭐ Star of Gameweek ${gw} (Top Performer)</div>
                    <div class="star-player-name">${currentUser.displayName}</div>
                  </div>
                </div>
                <div class="star-total-pts"><span class="star-pts-num">${sorted[0].pts}</span><span class="star-pts-lbl">GW PTS</span></div>
              </div>
            </div>
          `);
        } else if (sorted[1]?.uid === currentUser.uid) {
          honorCards.push(`
            <div class="gw-challenger-card">
              <div class="star-badge-header">
                <div class="star-left-group">
                  <div class="challenger-anim-wrap" title="Challenger of the Gameweek"><span class="fist-bump">👊</span><span class="challenger-medal">🥈</span></div>
                  <div class="star-title-wrap">
                    <div class="challenger-tag">🥈 Challenger of Gameweek ${gw} (Runner Up)</div>
                    <div class="star-player-name">${currentUser.displayName}</div>
                  </div>
                </div>
                <div class="challenger-total-pts"><span class="star-pts-num">${sorted[1].pts}</span><span class="star-pts-lbl">GW PTS</span></div>
              </div>
            </div>
          `);
        }
      }
    });

    if (honorCards.length > 0) {
      honorsEl.innerHTML = `
        <h2 class="section-title" style="margin-top:24px;">🎖️ My Honors & Podium Cards</h2>
        <div class="podium-cards-grid">${honorCards.join('')}</div>
      `;
    } else {
      honorsEl.innerHTML = '';
    }
  }

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
    const matchPoints = gwPreds.reduce((sum, p) => sum + (p.points || 0), 0);
    const gwExact = gwScored.filter(p => p.points === 25).length;
    const gwCorrect = gwScored.filter(p => p.points === 25 || p.points === 10).length;
    const gwAccuracy = gwScored.length ? Math.round((gwCorrect / gwScored.length) * 100) : 0;

    const myExtra = myExtrasByGW[gw];
    const extraPoints = myExtra?.points || 0;
    const totalGwPoints = matchPoints + extraPoints;

    const rows = gwPreds.map(p => {
      const fx = fixturesById[p.fixtureId];
      let pillClass = 'pending', pillText = 'Pending';
      if (p.scored) {
        if (p.points === 25) { pillClass = 'exact'; pillText = '<span class="result-bullseye" style="margin-right:2px;">🎯</span> Exact! +25'; }
        else if (p.points === 10) { pillClass = 'outcome'; pillText = 'Correct +10'; }
        else { pillClass = 'miss'; pillText = 'Incorrect'; }
      }
      return `
        <div class="history-row">
          <span>${fx.homeTeam} ${fx.homeScore ?? '?'}–${fx.awayScore ?? '?'} ${fx.awayTeam}</span>
          <span style="color:var(--chalk-dim);">You said ${p.predHome}–${p.predAway}</span>
          <span class="result-pill ${pillClass}">${pillText}</span>
        </div>
      `;
    }).join('');

    // Gameweek extras section
    let extrasSectionHTML = '';
    if (myExtra && (myExtra.topScoringTeam || myExtra.cleanSheetTeam || myExtra.highestScoringGame || myExtra.lowestScoringGame)) {
      const gwFixtures = fixturesByGW[gw] || [];
      const gwFinished = gwFixtures.filter(f => f.status === 'FINISHED');
      const isGwDone = gwFinished.length === gwFixtures.length && gwFixtures.length > 0;

      // 1. Top scoring team(s)
      const goalsByTeam = {};
      gwFixtures.forEach(f => {
        if (f.status === 'FINISHED' || f.status === 'IN_PLAY' || f.status === 'PAUSED') {
          goalsByTeam[f.homeTeam] = (goalsByTeam[f.homeTeam] || 0) + (f.homeScore ?? 0);
          goalsByTeam[f.awayTeam] = (goalsByTeam[f.awayTeam] || 0) + (f.awayScore ?? 0);
        }
      });
      const maxGoals = Math.max(...Object.values(goalsByTeam), 0);
      const topTeams = Object.keys(goalsByTeam).filter(t => goalsByTeam[t] === maxGoals && maxGoals > 0);
      let topPill = '<span class="extra-pill pending">Pending</span>';
      if (myExtra.topScoringTeam) {
        if (isGwDone) {
          topPill = topTeams.includes(myExtra.topScoringTeam)
            ? '<span class="extra-pill exact">✓ +15</span>'
            : '<span class="extra-pill miss">✗ 0</span>';
        }
      }

      // 2. Clean sheet team(s)
      const csTeams = [];
      gwFinished.forEach(f => {
        if (f.awayScore === 0) csTeams.push(f.homeTeam);
        if (f.homeScore === 0) csTeams.push(f.awayTeam);
      });
      let csPill = '<span class="extra-pill pending">Pending</span>';
      if (myExtra.cleanSheetTeam) {
        if (isGwDone) {
          csPill = csTeams.includes(myExtra.cleanSheetTeam)
            ? '<span class="extra-pill exact">✓ +15</span>'
            : '<span class="extra-pill miss">✗ 0</span>';
        }
      }

      // 3. Highest scoring game(s)
      const matchGoals = gwFixtures.map(f => ({ fx: f, id: f.id, total: (f.homeScore ?? 0) + (f.awayScore ?? 0) }));
      const maxMatchGoals = Math.max(...matchGoals.map(m => m.total), 0);
      const topMatchIds = new Set(matchGoals.filter(m => m.total === maxMatchGoals && (m.fx.status === 'FINISHED' || m.fx.status === 'IN_PLAY')).flatMap(m => [String(m.id), Number(m.id)]));
      const highGameFx = gwFixtures.find(f => String(f.id) === String(myExtra.highestScoringGame));
      const highGameName = highGameFx ? `${highGameFx.homeTeam} vs ${highGameFx.awayTeam}` : (myExtra.highestScoringGame || '–');
      let highPill = '<span class="extra-pill pending">Pending</span>';
      if (myExtra.highestScoringGame) {
        if (isGwDone) {
          highPill = topMatchIds.has(myExtra.highestScoringGame)
            ? '<span class="extra-pill exact">✓ +20</span>'
            : '<span class="extra-pill miss">✗ 0</span>';
        }
      }

      // 4. Lowest scoring game(s)
      const minMatchGoals = gwFinished.length > 0 ? Math.min(...gwFinished.map(f => (f.homeScore ?? 0) + (f.awayScore ?? 0))) : 0;
      const lowMatchIds = new Set(gwFinished.filter(f => (f.homeScore ?? 0) + (f.awayScore ?? 0) === minMatchGoals).flatMap(f => [String(f.id), Number(f.id)]));
      const lowGameFx = gwFixtures.find(f => String(f.id) === String(myExtra.lowestScoringGame));
      const lowGameName = lowGameFx ? `${lowGameFx.homeTeam} vs ${lowGameFx.awayTeam}` : (myExtra.lowestScoringGame || '–');
      let lowPill = '<span class="extra-pill pending">Pending</span>';
      if (myExtra.lowestScoringGame) {
        if (isGwDone) {
          lowPill = lowMatchIds.has(myExtra.lowestScoringGame)
            ? '<span class="extra-pill exact">✓ +20</span>'
            : '<span class="extra-pill miss">✗ 0</span>';
        }
      }

      extrasSectionHTML = `
        <div class="profile-gw-extras-card">
          <div class="extras-title">⚡ Gameweek ${gw} Extras Predictions ${extraPoints ? `<span style="color:var(--turf-bright); margin-left:6px;">(+${extraPoints} pts)</span>` : ''}</div>
          <div class="profile-extras-grid">
            <div class="profile-extra-item">
              <span class="lbl">🎯 Top Scoring Team</span>
              <div class="extra-val-line">
                <span class="val">${myExtra.topScoringTeam || '–'}</span>
                ${myExtra.topScoringTeam ? topPill : '<span class="extra-pill pending">–</span>'}
              </div>
            </div>
            <div class="profile-extra-item">
              <span class="lbl">🛡️ Clean Sheet</span>
              <div class="extra-val-line">
                <span class="val">${myExtra.cleanSheetTeam || '–'}</span>
                ${myExtra.cleanSheetTeam ? csPill : '<span class="extra-pill pending">–</span>'}
              </div>
            </div>
            <div class="profile-extra-item">
              <span class="lbl">🔥 Highest Scoring Game</span>
              <div class="extra-val-line">
                <span class="val">${highGameName}</span>
                ${myExtra.highestScoringGame ? highPill : '<span class="extra-pill pending">–</span>'}
              </div>
            </div>
            <div class="profile-extra-item">
              <span class="lbl">🔒 Lowest Scoring Game</span>
              <div class="extra-val-line">
                <span class="val">${lowGameName}</span>
                ${myExtra.lowestScoringGame ? lowPill : '<span class="extra-pill pending">–</span>'}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="profile-gw-group">
        <h3 class="section-title" style="margin-top:0;">Gameweek ${gw}</h3>
        <div class="profile-gw-stats">
          <span><strong>${totalGwPoints}</strong> total points ${extraPoints > 0 ? `(incl. ${extraPoints} extras pts)` : ''}</span>
          <span><strong>${gwExact}</strong> exact match scores</span>
          <span><strong>${gwAccuracy}%</strong> match accuracy${gwScored.length < gwPreds.length ? ' (partial — some still pending)' : ''}</span>
        </div>
        ${rows}
        ${extrasSectionHTML}
      </div>
    `;
  }).join('');
}

// Note: setupAwardsForm() is called from onAuthStateChanged once currentUser is known —
// calling it at module load time (before sign-in resolves) meant the Save button's
// click handler never got attached, since the function returns early with no user.
