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

const PL_TEAMS_DEFAULT = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Chelsea",
  "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City", "Ipswich Town",
  "Leeds United", "Liverpool", "Manchester City", "Manchester United", "Newcastle United",
  "Nottingham Forest", "Sunderland", "Tottenham Hotspur"
]; // 2026-27 season — confirmed promoted: Coventry, Ipswich, Hull. Relegated: West Ham, Burnley, Wolves

const BADGE_ICONS = {
  'Oracle of the Week': '🔮', 'Perfect Predictor': '🎯', 'Giant Killer': '⚡',
  'Iron Streak': '🔥', 'Table Topper': '👑'
};

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
  if (btn.dataset.tab === 'players') loadPlayers();
  if (btn.dataset.tab === 'highlights') loadHighlights();
  if (btn.dataset.tab === 'awards') loadAwardsCommunity();
  if (btn.dataset.tab === 'profile') loadProfile();
});

// ---------- Fun UI: celebration flash ----------
function celebrate(message) {
  const el = document.getElementById('celebrate');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

function kitColor(teamName) {
  const colors = ['#e64545', '#8b5cf6', '#4cbf7a', '#ffb627', '#3b82f6', '#ec4899', '#14b8a6'];
  let hash = 0;
  for (let i = 0; i < teamName.length; i++) hash = teamName.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function orderTeams(teams) {
  if (!standingsOrder || !standingsOrder.length) return [...teams].sort();
  const rank = new Map(standingsOrder.map((t, i) => [t, i]));
  return [...teams].sort((a, b) => (rank.has(a) ? rank.get(a) : 999) - (rank.has(b) ? rank.get(b) : 999));
}

function matchStatusLine(fx, locked) {
  if (fx.status === 'FINISHED') return `FT: ${fx.homeScore}–${fx.awayScore}`;
  if (fx.status === 'IN_PLAY' || fx.status === 'PAUSED') {
    return `🔴 LIVE: ${fx.homeScore ?? 0}–${fx.awayScore ?? 0} (as of last sync, updates every ~10 min)`;
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
    await ensureUserDoc(user);
    document.getElementById('adminLockControls').style.display = (user.email === ADMIN_EMAIL) ? 'flex' : 'none';
    await loadConfig();
    await loadFixtures();
    await loadTablePredictor();
  } else {
    authArea.innerHTML = `<button id="signInBtn" class="btn btn-primary">Sign in with Google</button>`;
    document.getElementById('signInBtn').addEventListener('click', () => signInWithPopup(auth, provider));
    document.getElementById('fixtureList').innerHTML = `<p class="empty-state">Sign in to see this gameweek's fixtures.</p>`;
    document.getElementById('adminLockControls').style.display = 'none';
  }
  loadLeaderboard();
  loadBadges();
});

async function ensureUserDoc(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { email: user.email, displayName: user.displayName, joinedAt: serverTimestamp() });
  }
}

async function getUsersMap() {
  if (usersCache) return usersCache;
  const snap = await getDocs(collection(db, 'users'));
  usersCache = {};
  snap.forEach(d => { usersCache[d.id] = d.data(); });
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
async function loadFixtures() {
  const cfg = await loadConfig();
  const fixturesSnap = await getDocs(collection(db, 'fixtures'));
  const fixtures = fixturesSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(f => f.gameweek === cfg.currentGameweek)
    .sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));

  const tickerText = fixtures.map(f => `⚽ ${f.homeTeam} vs ${f.awayTeam}`).join('   •   ') || 'No fixtures loaded yet — check back soon';
  document.getElementById('tickerTrack').textContent = tickerText + '     ' + tickerText;

  const list = document.getElementById('fixtureList');
  if (!fixtures.length) {
    list.innerHTML = `<p class="empty-state">No fixtures for this gameweek yet. The sync job will populate them automatically.</p>`;
    document.getElementById('gwExtras').style.display = 'none';
    return;
  }

  list.innerHTML = '';
  for (const fx of fixtures) {
    const locked = new Date(fx.kickoffUTC) <= new Date() || (fx.status !== 'SCHEDULED' && fx.status !== 'TIMED');
    const predRef = doc(db, 'predictions', `${currentUser.uid}_${fx.id}`);
    const predSnap = await getDoc(predRef);
    const existing = predSnap.exists() ? predSnap.data() : null;

    const card = document.createElement('div');
    card.className = 'fixture-card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="fixture-main">
        <div>
          <div class="fixture-teams"><span class="kit-dot" style="background:${kitColor(fx.homeTeam)}"></span>${fx.homeTeam} <span style="color:var(--chalk-dim); font-weight:400;">vs</span> ${fx.awayTeam} <span class="kit-dot" style="background:${kitColor(fx.awayTeam)}"></span></div>
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
      <div class="crowd-pulse" data-fixture="${fx.id}"></div>
    `;
    if (!locked) {
      const saveBtn = card.querySelector('.save-pred-btn');
      saveBtn.addEventListener('click', async () => {
        const h = card.querySelector('.home-score').value;
        const a = card.querySelector('.away-score').value;
        if (h === '' || a === '') return;
        await setDoc(predRef, {
          uid: currentUser.uid, fixtureId: fx.id, predHome: Number(h), predAway: Number(a),
          scored: false, points: 0, submittedAt: serverTimestamp()
        });
        card.querySelector('.pred-status').textContent = 'Saved ✓';
        celebrate('Prediction locked in! ⚽');
        renderCrowdPulse(card.querySelector('.crowd-pulse'), fx, true);
      });
    }
    list.appendChild(card);
    renderCrowdPulse(card.querySelector('.crowd-pulse'), fx, !!existing);
  }

  await setupGwExtras(fixtures);
}

async function renderCrowdPulse(container, fixture, unlocked) {
  if (!unlocked) {
    container.innerHTML = `<div class="crowd-locked-note">🔒 Save your own prediction to see what everyone else thinks.</div>`;
    return;
  }
  const q = query(collection(db, 'predictions'), where('fixtureId', '==', fixture.id));
  const snap = await getDocs(q);
  if (snap.empty) {
    container.innerHTML = `<div class="crowd-locked-note">No other predictions yet — be the first!</div>`;
    return;
  }
  let home = 0, draw = 0, away = 0;
  const scorelineCounts = {};
  snap.forEach(d => {
    const p = d.data();
    if (p.predHome > p.predAway) home++;
    else if (p.predHome < p.predAway) away++;
    else draw++;
    const key = `${p.predHome}-${p.predAway}`;
    scorelineCounts[key] = (scorelineCounts[key] || 0) + 1;
  });
  const total = home + draw + away;
  const pct = n => Math.round((n / total) * 100);
  const topScorelines = Object.entries(scorelineCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);

  container.innerHTML = `
    <div class="label">Crowd predicts (${total} vote${total === 1 ? '' : 's'})</div>
    <div class="crowd-bar">
      ${home ? `<span class="home" style="width:${pct(home)}%"></span>` : ''}
      ${draw ? `<span class="draw" style="width:${pct(draw)}%"></span>` : ''}
      ${away ? `<span class="away" style="width:${pct(away)}%"></span>` : ''}
    </div>
    <div class="crowd-legend">
      ${home ? `<span>🟢 ${pct(home)}% predict home win (${fixture.homeTeam})</span>` : ''}
      ${draw ? `<span>⚪ ${pct(draw)}% predict a draw</span>` : ''}
      ${away ? `<span>🟡 ${pct(away)}% predict away win (${fixture.awayTeam})</span>` : ''}
    </div>
    <div class="crowd-scorelines">Most predicted: ${topScorelines.map(([s, c]) => `${s} (${c})`).join(' · ')}</div>
  `;
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
    await setDoc(ref, {
      uid: currentUser.uid, gameweek: currentGW,
      topScoringTeam: topSel.value, cleanSheetTeam: csSel.value,
      topScoringPlayerGuess: document.getElementById('topScoringPlayer').value.trim(),
      cleanSheetPlayerGuess: document.getElementById('cleanSheetPlayer').value.trim(),
      scored: false, points: 0, submittedAt: serverTimestamp()
    });
    document.getElementById('extrasStatus').textContent = 'Saved ✓';
    celebrate('Extras locked in! 🎯');
  };
}

// ---------- Predict League Table tab ----------
async function loadTablePredictor() {
  const cfg = await loadConfig();
  const isAdmin = currentUser.email === ADMIN_EMAIL;
  const locked = cfg.tableLocked && !isAdmin;

  const ref = doc(db, 'tablePredictions', currentUser.uid);
  const snap = await getDoc(ref);
  const teams = snap.exists() && snap.data().teams
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
}

function renderTableList(teams, locked) {
  const listEl = document.getElementById('tableList');
  listEl.innerHTML = '';
  teams.forEach((team) => {
    const li = document.createElement('li');
    li.draggable = !locked;
    li.dataset.team = team;
    li.innerHTML = `
      <span class="pos"></span>
      <span class="kit-dot" style="background:${kitColor(team)}"></span>
      <span style="flex:1;">${team}</span>
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
    
    // Keep input field updated with current position
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
    const tablesPromise = getDocs(collection(db, 'tablePredictions'));
    const usersPromise = typeof getUsersMap === 'function' ? getUsersMap() : Promise.resolve({});
    const standingsPromise = getDocs(collection(db, 'standings')).catch(() => null);

    const [tablesSnap, users, standingsSnap] = await Promise.all([
      tablesPromise,
      usersPromise,
      standingsPromise
    ]);

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

    // Helper to normalize team names for matching (e.g. "Arsenal FC" -> "arsenal")
    const normalize = name => String(name || '').toLowerCase().replace(/fc|afc|&/g, '').replace(/[^a-z0-9]/g, '').trim();

    let sortedLiveTeams = [];
    if (standingsSnap && !standingsSnap.empty) {
      const standingsList = standingsSnap.docs.map(doc => doc.data());
      
      // Sort standings by position field directly or by points / GD
      standingsList.sort((a, b) => {
        if (a.position && b.position) return a.position - b.position;
        if ((b.points || 0) !== (a.points || 0)) return (b.points || 0) - (a.points || 0);
        const gdA = a.goalDifference ?? ((a.goalsFor || 0) - (a.goalsAgainst || 0));
        const gdB = b.goalDifference ?? ((b.goalsFor || 0) - (b.goalsAgainst || 0));
        if (gdB !== gdA) return gdB - gdA;
        return (b.goalsFor || 0) - (a.goalsFor || 0);
      });

      // Map standings team names back to the team names stored in user predictions
      const predictionTeamsArray = [...allTeams];
      sortedLiveTeams = standingsList
        .map(s => {
          const rawName = s.team || s.teamName || s.name || s.shortName;
          const normStanding = normalize(rawName);
          return predictionTeamsArray.find(pt => normalize(pt) === normStanding);
        })
        .filter(Boolean);
    }

    // Fallback: Standings -> Unsorted prediction team order
    const teamRows = sortedLiveTeams.length ? sortedLiveTeams : [...allTeams];

    // Render Table Matrix
    const header = `<tr><th>Team</th>${playerEntries.map(p => `<th>${p.name}</th>`).join('')}</tr>`;
    const rows = teamRows.map(teamName => `
      <tr>
        <td><span class="kit-dot" style="background:${typeof kitColor === 'function' ? kitColor(teamName) : '#ccc'}; margin-right:6px;"></span>${teamName}</td>
        ${playerEntries.map(p => `<td class="pos-num">${p.positions[teamName] ?? '–'}</td>`).join('')}
      </tr>
    `).join('');

    grid.innerHTML = `<div class="table-scroll"><table class="matrix-table"><thead>${header}</thead><tbody>${rows}</tbody></table></div>`;

  } catch (err) {
    console.error('loadAllTables Error:', err);
    grid.innerHTML = `<p class="empty-state">Failed to load community predictions. (${err.message})</p>`;
  }
}



// ---------- Community Game Predictions tab (all gameweeks, newest first) ----------
async function loadCommunity() {
  const grid = document.getElementById('communityGrid');
  grid.innerHTML = '<p class="empty-state">Loading…</p>';
  const [fixturesSnap, predsSnap, users] = await Promise.all([
    getDocs(collection(db, 'fixtures')), getDocs(collection(db, 'predictions')), getUsersMap()
  ]);
  const fixtures = fixturesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!fixtures.length) { grid.innerHTML = '<p class="empty-state">No fixtures synced yet.</p>'; return; }

  const byGW = {};
  fixtures.forEach(f => { (byGW[f.gameweek] = byGW[f.gameweek] || []).push(f); });

  // 1. Determine current gameweek based on fixtures already played/started
  const playedFixtures = fixtures.filter(f => f.status === 'FINISHED' || f.status === 'IN_PLAY' || f.status === 'PAUSED');
  const currentGW = playedFixtures.length 
    ? Math.max(...playedFixtures.map(f => Number(f.gameweek)))
    : Math.min(...fixtures.map(f => Number(f.gameweek))); // Fallback to GW1 if season hasn't started

  // 2. Filter gwNumbers so it only includes current and past gameweeks
  const gwNumbers = Object.keys(byGW)
    .map(Number)
    .filter(gw => gw <= currentGW)
    .sort((a, b) => b - a);

  const preds = predsSnap.docs.map(d => d.data());
  const predsByFixture = {};
  preds.forEach(p => { (predsByFixture[p.fixtureId] = predsByFixture[p.fixtureId] || []).push(p); });

  grid.innerHTML = '';
  gwNumbers.forEach(gw => {
    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'gw-section-header';
    sectionHeader.textContent = `Gameweek ${gw}`;
    grid.appendChild(sectionHeader);

    const gwFixtures = byGW[gw].sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));
    gwFixtures.forEach(fx => {
      const rows = (predsByFixture[fx.id] || [])
        .map(p => `<tr><td>${users[p.uid]?.displayName || 'Unknown'}</td><td>${p.predHome}–${p.predAway}</td></tr>`)
        .join('');
      const card = document.createElement('div');
      card.className = 'community-fixture';
      card.innerHTML = `
        <h3>${fx.homeTeam} vs ${fx.awayTeam} ${fx.status === 'FINISHED' ? `<span style="color:var(--chalk-dim); font-weight:400;">— FT ${fx.homeScore}–${fx.awayScore}</span>` : ''}</h3>
        <table>${rows || '<tr><td colspan="2" class="empty-state">No predictions</td></tr>'}</table>
      `;
      grid.appendChild(card);
    });
  });
}


// ---------- Leaderboard tab ----------
async function loadLeaderboard() {
  const q = query(collection(db, 'leaderboard'), orderBy('rank', 'asc'));
  const snap = await getDocs(q);
  const body = document.getElementById('leaderboardBody');
  body.innerHTML = '';
  snap.forEach(d => {
    const r = d.data();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.rank}</td><td>${r.displayName || r.email || d.id}</td>
      <td>${r.matchPoints || 0}</td><td>${r.tablePoints || 0}</td><td>${r.extraPoints || 0}</td>
      <td>${r.currentStreak || 0}</td><td>${r.totalPoints || 0}</td>
    `;
    body.appendChild(tr);
  });
  if (!snap.size) body.innerHTML = `<tr><td colspan="7" class="empty-state">Leaderboard populates after the first gameweek is scored.</td></tr>`;
}

// ---------- Season Awards tab ----------
async function setupAwardsForm() {
  const sel = document.getElementById('awardCleanSheetTeam');
  sel.innerHTML = PL_TEAMS_DEFAULT.map(t => `<option value="${t}">${t}</option>`).join('');
  if (!currentUser) return;
  const ref = doc(db, 'seasonPredictions', currentUser.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data();
    document.getElementById('awardGoldenBoot').value = d.goldenBoot || '';
    document.getElementById('awardGoldenGlove').value = d.goldenGlove || '';
    document.getElementById('awardManager').value = d.managerOfYear || '';
    document.getElementById('awardRedCards').value = d.mostRedCards || '';
    sel.value = d.mostCleanSheetsTeam || PL_TEAMS_DEFAULT[0];
  }
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

async function loadAwardsCommunity() {
  const container = document.getElementById('awardsCommunity');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  const snap = await getDocs(collection(db, 'seasonPredictions'));
  if (snap.empty) { container.innerHTML = '<p class="empty-state">No predictions submitted yet.</p>'; return; }

  const categories = [
    ['goldenBoot', '🥾 Golden Boot'], ['goldenGlove', '🧤 Golden Glove'],
    ['managerOfYear', '📋 Manager of the Year'], ['mostRedCards', '🟥 Most Red Cards'],
    ['mostCleanSheetsTeam', '🛡️ Most Clean Sheets (Team)']
  ];
  container.innerHTML = '';
  categories.forEach(([field, label]) => {
    const tally = {};
    snap.forEach(d => {
      const val = (d.data()[field] || '').trim();
      if (!val) return;
      tally[val] = (tally[val] || 0) + 1;
    });
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const div = document.createElement('div');
    div.className = 'award-tally';
    div.innerHTML = `<h4>${label}</h4>` + (sorted.length
      ? sorted.map(([name, count]) => `<div class="pick-row"><span>${name}</span><span>${count} pick${count === 1 ? '' : 's'}</span></div>`).join('')
      : '<p class="empty-state">No picks yet</p>');
    container.appendChild(div);
  });
}

// ---------- Player Profiles tab ----------
let playersCache = null;
async function loadPlayers() {
  const grid = document.getElementById('playersGrid');
  grid.innerHTML = '<p class="empty-state">Loading…</p>';
  if (!playersCache) {
    const snap = await getDocs(collection(db, 'players'));
    playersCache = snap.docs.map(d => d.data());
  }
  renderPlayers(playersCache);
  document.getElementById('playerSearch').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    renderPlayers(playersCache.filter(p => (p.name || '').toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q)));
  };
}
function renderPlayers(list) {
  const grid = document.getElementById('playersGrid');
  if (!list.length) { grid.innerHTML = '<p class="empty-state">No squad data synced yet — this populates from the weekly squad-sync job.</p>'; return; }
  grid.innerHTML = list.map(p => `
    <div class="player-card">
      <div class="name">${p.name}${p.shirtNumber ? ` <span style="color:var(--chalk-dim); font-family:var(--font-mono); font-size:11px;">#${p.shirtNumber}</span>` : ''}</div>
      <div class="meta">${p.team || ''}</div>
      <div class="meta">${p.position || ''} ${p.nationality ? '· ' + p.nationality : ''}</div>
    </div>
  `).join('');
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
async function loadBadges() {
  const grid = document.getElementById('badgeGrid');
  if (!currentUser) { grid.innerHTML = `<p class="empty-state">Sign in to see your badge cabinet.</p>`; return; }
  const snap = await getDoc(doc(db, 'badges', currentUser.uid));
  const badges = snap.exists() && snap.data().badges ? snap.data().badges : [];
  if (!badges.length) { grid.innerHTML = `<p class="empty-state">No badges yet — get predicting.</p>`; return; }
  grid.innerHTML = badges.map(b => `
    <div class="badge-card">
      <div class="icon">${BADGE_ICONS[b.name] || '🏅'}</div>
      <div class="name">${b.name}</div>
      <div class="meta">${b.context || ''}</div>
    </div>
  `).join('');
}

// ---------- Profile tab ----------
async function loadProfile() {
  if (!currentUser) return;
  document.getElementById('profileName').textContent = `${currentUser.displayName}'s Profile`;

  const [predsSnap, fixturesSnap, lbSnap] = await Promise.all([
    getDocs(query(collection(db, 'predictions'), where('uid', '==', currentUser.uid))),
    getDocs(collection(db, 'fixtures')),
    getDoc(doc(db, 'leaderboard', currentUser.uid))
  ]);
  const fixturesById = {};
  fixturesSnap.forEach(d => { fixturesById[d.id] = d.data(); });

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

  const historyEl = document.getElementById('profileHistory');
  if (!preds.length) { historyEl.innerHTML = '<p class="empty-state">No predictions yet — head to Predict Gameweek to get started.</p>'; return; }
  historyEl.innerHTML = preds.map(p => {
    const fx = fixturesById[p.fixtureId];
    if (!fx) return '';
    let pillClass = 'pending', pillText = 'Pending';
    if (p.scored) {
      if (p.points === 25) { pillClass = 'exact'; pillText = 'Exact! +25'; }
      else if (p.points === 10) { pillClass = 'outcome'; pillText = 'Outcome +10'; }
      else { pillClass = 'miss'; pillText = 'Missed'; }
    }
    return `
      <div class="history-row">
        <span>GW${fx.gameweek} · ${fx.homeTeam} ${fx.homeScore ?? '?'}–${fx.awayScore ?? '?'} ${fx.awayTeam}</span>
        <span style="color:var(--chalk-dim);">You said ${p.predHome}–${p.predAway}</span>
        <span class="result-pill ${pillClass}">${pillText}</span>
      </div>
    `;
  }).join('');
}

// Init forms that don't depend on gameweek fixtures
setupAwardsForm();
