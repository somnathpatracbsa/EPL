import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;

// ---------- Tabs ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(btn.dataset.tab).classList.add('active');
});

// ---------- Auth ----------
document.getElementById('signInBtn').addEventListener('click', () => {
  signInWithPopup(auth, provider).catch(err => console.error('Sign-in failed:', err));
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const authArea = document.getElementById('authArea');
  if (user) {
    authArea.innerHTML = `
      <span style="margin-right:12px; font-size:14px;">${user.displayName}</span>
      <button id="signOutBtn" class="btn btn-secondary">Sign out</button>
    `;
    document.getElementById('signOutBtn').addEventListener('click', () => signOut(auth));
    await ensureUserDoc(user);
    loadFixtures();
    loadTablePredictor();
  } else {
    authArea.innerHTML = `<button id="signInBtn" class="btn btn-primary">Sign in with Google</button>`;
    document.getElementById('signInBtn').addEventListener('click', () => signInWithPopup(auth, provider));
    document.getElementById('fixtureList').innerHTML = `<p class="empty-state">Sign in to see this gameweek's fixtures.</p>`;
  }
  loadLeaderboard();
  loadBadges();
});

async function ensureUserDoc(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email,
      displayName: user.displayName,
      joinedAt: serverTimestamp()
    });
  }
}

// ---------- Predict tab ----------
async function loadFixtures() {
  const configSnap = await getDoc(doc(db, 'config', 'current'));
  const cfg = configSnap.exists() ? configSnap.data() : { currentGameweek: 1 };
  document.getElementById('gwNumber').textContent = cfg.currentGameweek;

  const fixturesSnap = await getDocs(collection(db, 'fixtures'));
  const fixtures = fixturesSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(f => f.gameweek === cfg.currentGameweek)
    .sort((a, b) => new Date(a.kickoffUTC) - new Date(b.kickoffUTC));

  // Update ticker with all fixtures this gameweek
  const tickerText = fixtures.map(f => `${f.homeTeam} vs ${f.awayTeam}`).join('   •   ') || 'No fixtures loaded yet — check back soon';
  document.getElementById('tickerTrack').textContent = tickerText + '     ' + tickerText;

  const list = document.getElementById('fixtureList');
  if (!fixtures.length) {
    list.innerHTML = `<p class="empty-state">No fixtures for this gameweek yet. The sync job will populate them automatically.</p>`;
    return;
  }

  list.innerHTML = '';
  for (const fx of fixtures) {
    const locked = new Date(fx.kickoffUTC) <= new Date() || fx.status !== 'SCHEDULED' && fx.status !== 'TIMED';
    const predRef = doc(db, 'predictions', `${currentUser.uid}_${fx.id}`);
    const predSnap = await getDoc(predRef);
    const existing = predSnap.exists() ? predSnap.data() : null;

    const card = document.createElement('div');
    card.className = 'fixture-card' + (locked ? ' locked' : '');
    card.innerHTML = `
      <div>
        <div class="fixture-teams">${fx.homeTeam} <span style="color:var(--chalk-dim); font-weight:400;">vs</span> ${fx.awayTeam}</div>
        <div class="fixture-kickoff">${new Date(fx.kickoffUTC).toLocaleString()} ${locked ? '· LOCKED' : ''}</div>
      </div>
      <div class="score-input-group">
        <input type="number" min="0" max="20" class="score-input home-score" value="${existing ? existing.predHome : ''}" ${locked ? 'disabled' : ''} />
        <span class="score-dash">–</span>
        <input type="number" min="0" max="20" class="score-input away-score" value="${existing ? existing.predAway : ''}" ${locked ? 'disabled' : ''} />
        ${locked ? '' : '<button class="btn btn-primary save-pred-btn">Save</button>'}
        <span class="pred-status"></span>
      </div>
    `;
    if (!locked) {
      const saveBtn = card.querySelector('.save-pred-btn');
      saveBtn.addEventListener('click', async () => {
        const h = card.querySelector('.home-score').value;
        const a = card.querySelector('.away-score').value;
        if (h === '' || a === '') return;
        await setDoc(predRef, {
          uid: currentUser.uid,
          fixtureId: fx.id,
          predHome: Number(h),
          predAway: Number(a),
          scored: false,
          points: 0,
          submittedAt: serverTimestamp()
        });
        card.querySelector('.pred-status').textContent = 'Saved ✓';
      });
    }
    list.appendChild(card);
  }
}

// ---------- Table Predictor tab ----------
const PL_TEAMS_DEFAULT = [
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Burnley",
  "Chelsea", "Crystal Palace", "Everton", "Fulham", "Leeds United", "Liverpool",
  "Manchester City", "Manchester United", "Newcastle United", "Nottingham Forest",
  "Sunderland", "Tottenham Hotspur", "West Ham United", "Wolverhampton Wanderers"
]; // Update this list each season if promoted/relegated clubs differ

async function loadTablePredictor() {
  const ref = doc(db, 'tablePredictions', currentUser.uid);
  const snap = await getDoc(ref);
  const teams = snap.exists() && snap.data().teams ? snap.data().teams : PL_TEAMS_DEFAULT;

  const listEl = document.getElementById('tableList');
  listEl.innerHTML = '';
  teams.forEach((team, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.team = team;
    li.innerHTML = `<span class="pos">${i + 1}</span> ${team}`;
    listEl.appendChild(li);
  });
  enableDragReorder(listEl);
}

function enableDragReorder(listEl) {
  let dragged;
  listEl.addEventListener('dragstart', (e) => {
    dragged = e.target;
    e.target.classList.add('dragging');
  });
  listEl.addEventListener('dragend', (e) => {
    e.target.classList.remove('dragging');
    [...listEl.children].forEach((li, i) => { li.querySelector('.pos').textContent = i + 1; });
  });
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const after = getDragAfterElement(listEl, e.clientY);
    if (after == null) listEl.appendChild(dragged);
    else listEl.insertBefore(dragged, after);
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
  await setDoc(doc(db, 'tablePredictions', currentUser.uid), {
    uid: currentUser.uid,
    teams,
    submittedAt: serverTimestamp()
  });
  alert('Table prediction saved!');
});

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
      <td>${r.rank}</td>
      <td>${r.displayName || r.email || d.id}</td>
      <td>${r.matchPoints || 0}</td>
      <td>${r.tablePoints || 0}</td>
      <td>${r.currentStreak || 0}</td>
      <td>${r.totalPoints || 0}</td>
    `;
    body.appendChild(tr);
  });
  if (!snap.size) {
    body.innerHTML = `<tr><td colspan="6" class="empty-state">Leaderboard populates after the first gameweek is scored.</td></tr>`;
  }
}

// ---------- Badges tab ----------
const BADGE_ICONS = {
  'Oracle of the Week': '🔮',
  'Perfect Predictor': '🎯',
  'Giant Killer': '⚡',
  'Iron Streak': '🔥',
  'Table Topper': '👑'
};

async function loadBadges() {
  const grid = document.getElementById('badgeGrid');
  if (!currentUser) {
    grid.innerHTML = `<p class="empty-state">Sign in to see your badge cabinet.</p>`;
    return;
  }
  const snap = await getDoc(doc(db, 'badges', currentUser.uid));
  const badges = snap.exists() && snap.data().badges ? snap.data().badges : [];
  grid.innerHTML = '';
  if (!badges.length) {
    grid.innerHTML = `<p class="empty-state">No badges yet — get predicting.</p>`;
    return;
  }
  badges.forEach(b => {
    const card = document.createElement('div');
    card.className = 'badge-card';
    card.innerHTML = `
      <div class="icon">${BADGE_ICONS[b.name] || '🏅'}</div>
      <div class="name">${b.name}</div>
      <div class="meta">${b.context || ''}</div>
    `;
    grid.appendChild(card);
  });
}
