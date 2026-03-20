// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const OPENDOTA      = 'https://api.opendota.com/api';
const DOTABUFF_BASE = 'https://www.dotabuff.com/esports/leagues/';
const MAX_PAGES     = 30;
const BATCH_SIZE    = 5;
const BATCH_DELAY   = 700;  // ms between OpenDota batches
const PAGE_DELAY    = 900;  // ms between Dotabuff page fetches

// Proxy list — rotated per page to avoid per-proxy rate limits
const PROXIES = [
  (url) => `https://r.jina.ai/${url}`,
  (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

// Returns proxies starting from a given offset so each page uses a different lead proxy
function proxiesFor(page) {
  const offset = (page - 1) % PROXIES.length;
  return [...PROXIES.slice(offset), ...PROXIES.slice(0, offset)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Global state
// ─────────────────────────────────────────────────────────────────────────────
let currentSlug      = '';
let currentMatchIds  = [];   // match IDs confirmed by user at preview step
let currentMatches   = [];
let currentTeams     = [];
let currentPlayers   = [];
let heroMap          = {};   // heroId (string) → localized_name

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
const $               = (id) => document.getElementById(id);
const loadingState    = $('loadingState');
const loadingText     = $('loadingText');
const progressWrap    = $('progressWrap');
const progressFill    = $('progressFill');
const progressLbl     = $('progressLabel');
const previewState    = $('previewState');
const previewSubtitle = $('previewSubtitle');
const matchIdGrid     = $('matchIdGrid');
const errorState      = $('errorState');
const errorTitle      = $('errorTitle');
const errorMessage    = $('errorMessage');
const pasteFallback   = $('pasteFallback');
const pasteArea       = $('pasteArea');
const parseBtn        = $('parseBtn');
const leagueHeader    = $('leagueHeader');
const summarySection  = $('summarySection');
const tabRow          = $('tabRow');

// ─────────────────────────────────────────────────────────────────────────────
// Header search
// ─────────────────────────────────────────────────────────────────────────────
$('headerSearchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const slug = extractSlug($('headerLeagueInput').value.trim());
  if (slug) window.location.href = `league.html?slug=${encodeURIComponent(slug)}`;
});

function extractSlug(value) {
  const m = value.match(/dotabuff\.com\/esports\/leagues\/([^\s/?#]+)/);
  if (m) return m[1];
  const s = value.match(/^(\d+[\w-]+)$/);
  if (s) return s[1];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    ['teams', 'players', 'games'].forEach((t) =>
      $(`tab-${t}`).classList.toggle('hidden', t !== tab)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Export buttons
// ─────────────────────────────────────────────────────────────────────────────
document.querySelectorAll('.export-btn').forEach((btn) => {
  btn.addEventListener('click', () => exportCSV(btn.dataset.export));
});

// ─────────────────────────────────────────────────────────────────────────────
// UI state helpers
// ─────────────────────────────────────────────────────────────────────────────
function setLoading(text) {
  loadingText.textContent = text;
}

function setProgress(done, total) {
  progressWrap.style.display = 'block';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width  = `${pct}%`;
  progressLbl.textContent   = `${done} / ${total} matches`;
}

function showError(title, msg, showPaste = true) {
  loadingState.classList.add('hidden');
  previewState.classList.add('hidden');
  errorState.classList.remove('hidden');
  errorTitle.textContent   = title;
  errorMessage.textContent = msg;
  pasteFallback.style.display = showPaste ? 'block' : 'none';
}

function showPreview(matchIds, pages, log = []) {
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  previewState.classList.remove('hidden');

  previewSubtitle.textContent =
    `${matchIds.length} match IDs found across ${pages} page${pages !== 1 ? 's' : ''}. ` +
    `Review below, then start extraction.`;

  // Page-by-page scrape log — each chip is clickable to retry that page
  const logEl = $('scrapeLog');
  if (log.length && logEl) {
    logEl.innerHTML = log.map(({ page, ids, status }) => {
      const icon = status === 'ok' || status === 'retry-ok' ? '✓' : status === 'empty' ? '—' : '✗';
      const cls  = status === 'ok' || status === 'retry-ok' ? 'log-ok' : status === 'empty' ? 'log-empty' : 'log-fail';
      return `<button class="log-entry ${cls}" data-page="${page}" title="Click to retry page ${page}">${icon} p${page} (${ids})</button>`;
    }).join('');
    logEl.style.display = 'flex';

    logEl.querySelectorAll('.log-entry').forEach(btn => {
      btn.addEventListener('click', () => retryPage(Number(btn.dataset.page), btn));
    });
  }

  matchIdGrid.innerHTML = matchIds.map(id =>
    `<a class="match-id-chip"
        href="https://www.opendota.com/matches/${id}"
        target="_blank" rel="noopener">${id}</a>`
  ).join('');
}

async function retryPage(page, btn) {
  btn.textContent = `⟳ p${page}`;
  btn.classList.remove('log-ok', 'log-empty', 'log-fail');
  btn.classList.add('log-retrying');
  btn.disabled = true;

  const url = buildSeriesUrl(currentSlug, page);
  let ids = [];
  try {
    const html = await proxyFetch(url, proxiesFor(page));
    ids = extractMatchIds(html);
  } catch { /* leave ids empty */ }

  const newIds = ids.filter(id => !currentMatchIds.includes(id));

  if (ids.length > 0) {
    currentMatchIds = [...currentMatchIds, ...newIds];
    btn.classList.remove('log-retrying');
    btn.classList.add('log-ok');
    btn.textContent = `✓ p${page} (${ids.length})`;
    // Refresh subtitle and grid
    previewSubtitle.textContent = previewSubtitle.textContent.replace(/^\d+ match IDs/, `${currentMatchIds.length} match IDs`);
    $('matchIdGrid').innerHTML = currentMatchIds.map(id =>
      `<a class="match-id-chip" href="https://www.opendota.com/matches/${id}" target="_blank" rel="noopener">${id}</a>`
    ).join('');
  } else {
    btn.classList.remove('log-retrying');
    btn.classList.add('log-fail');
    btn.textContent = `✗ p${page} (0)`;
  }

  btn.disabled = false;
}

function showContent() {
  loadingState.classList.add('hidden');
  previewState.classList.add('hidden');
  errorState.classList.add('hidden');
  leagueHeader.classList.remove('hidden');
  summarySection.classList.remove('hidden');
  tabRow.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────
// Steam 32-bit account_id → Steam 64-bit ID (used for profile URLs)
function toSteam64(accountId) {
  return (BigInt(accountId) + 76561197960265728n).toString();
}

function fmtDuration(sec) {
  if (!sec) return '—';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtPct(num, den) {
  if (!den) return '0.0%';
  return ((num / den) * 100).toFixed(1) + '%';
}

function winRateCell(wins, total) {
  const pct   = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
  const color = parseFloat(pct) >= 50 ? 'var(--win)' : 'var(--loss)';
  return `<td class="wr-cell">
    <div class="wr-bar-wrap">
      <div class="wr-bar"><div class="wr-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="wr-text" style="color:${color}">${pct}%</span>
    </div>
  </td>`;
}

function emptyRow(cols, msg) {
  return `<tr class="empty-row"><td colspan="${cols}">${msg}</td></tr>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS proxy fetch — tries each proxy in sequence
// ─────────────────────────────────────────────────────────────────────────────
async function proxyFetch(targetUrl, proxyList = PROXIES) {
  for (const buildUrl of proxyList) {
    try {
      const res = await fetch(buildUrl(targetUrl), {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      // allorigins wraps in JSON: { contents: "..." }
      try {
        const json = JSON.parse(text);
        if (json.contents) return json.contents;
      } catch { /* not JSON */ }
      return text;
    } catch { /* try next */ }
  }
  throw new Error('All CORS proxies failed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract /matches/XXXXXXXXXX IDs from any text
// ─────────────────────────────────────────────────────────────────────────────
function extractMatchIds(text) {
  const seen = new Set();
  const re   = /\/matches\/(\d{8,13})/g;
  let m;
  while ((m = re.exec(text)) !== null) seen.add(m[1]);
  return [...seen];
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-page Dotabuff scraper
// URL format:
//   page 1  → /series
//   page 2+ → /series?original_slug={slug}&page={n}
// ─────────────────────────────────────────────────────────────────────────────
function buildSeriesUrl(slug, page) {
  if (page === 1) return `${DOTABUFF_BASE}${slug}/series`;
  return `${DOTABUFF_BASE}${slug}/series?original_slug=${slug}&page=${page}`;
}

async function scrapeAllPages(slug, maxPages = MAX_PAGES) {
  const allIds   = new Set();
  const pageLog  = [];   // { page, ids, status }
  let   lastPage = 0;
  let   emptyStreak = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSeriesUrl(slug, page);
    setLoading(`Scraping page ${page} / ${maxPages === MAX_PAGES ? '?' : maxPages}… (${allIds.size} matches so far)`);

    // Rotate proxies per page to spread rate-limit risk
    const proxies = proxiesFor(page);

    let html = null;
    let status = 'ok';

    try {
      html = await proxyFetch(url, proxies);
    } catch {
      if (page === 1) throw new Error('First page failed — all proxies blocked');
      status = 'proxy-fail';
    }

    let ids = html ? extractMatchIds(html) : [];

    // If no IDs found but fetch succeeded, retry once with a longer pause
    // (proxy may have returned a rate-limit/challenge page instead of real content)
    if (html && ids.length === 0 && status === 'ok') {
      setLoading(`Page ${page} returned no IDs — retrying in 3 s…`);
      await new Promise(r => setTimeout(r, 3000));
      try {
        // Use next proxy in rotation for the retry
        const retryProxies = proxiesFor(page + 1);
        html = await proxyFetch(url, retryProxies);
        ids  = extractMatchIds(html);
      } catch { /* ignore, treat as empty */ }
      status = ids.length ? 'retry-ok' : 'empty';
    }

    pageLog.push({ page, ids: ids.length, status });

    if (ids.length === 0) {
      emptyStreak++;
      // Stop only after 2 consecutive empty/failed pages (avoids stopping on a single blip)
      if (emptyStreak >= 2) break;
      await new Promise(r => setTimeout(r, PAGE_DELAY));
      continue;
    }

    emptyStreak = 0;
    for (const id of ids) allIds.add(id);
    lastPage = page;

    if (page < maxPages) await new Promise(r => setTimeout(r, PAGE_DELAY));
  }

  return { ids: [...allIds], pages: lastPage, log: pageLog };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch hero name constants from OpenDota
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHeroMap() {
  try {
    const data = await fetch(`${OPENDOTA}/constants/heroes`).then(r => r.json());
    const map  = {};
    for (const [id, hero] of Object.entries(data)) {
      map[String(id)] = hero.localized_name || hero.name || `Hero ${id}`;
    }
    return map;
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a single match from OpenDota (one retry on 429)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMatch(matchId) {
  let res = await fetch(`${OPENDOTA}/matches/${matchId}`);
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2500));
    res = await fetch(`${OPENDOTA}/matches/${matchId}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAllMatches(ids) {
  const results = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch    = ids.slice(i, i + BATCH_SIZE);
    const settled  = await Promise.allSettled(batch.map(fetchMatch));
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value?.match_id) results.push(s.value);
    }
    setProgress(Math.min(i + BATCH_SIZE, ids.length), ids.length);
    if (i + BATCH_SIZE < ids.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate matches → teams + players (with per-hero stats)
// ─────────────────────────────────────────────────────────────────────────────
function aggregateMatches(matches) {
  const teamMap   = {};
  const playerMap = {};

  for (const match of matches) {
    const radiantName = match.radiant_name || match.radiant_team?.name || 'Radiant';
    const direName    = match.dire_name    || match.dire_team?.name    || 'Dire';

    // Teams
    const rKey = String(match.radiant_team_id || `n_${radiantName}`);
    const dKey = String(match.dire_team_id    || `n_${direName}`);

    if (!teamMap[rKey]) teamMap[rKey] = { id: match.radiant_team_id || null, name: radiantName, wins: 0, losses: 0, totalDuration: 0 };
    if (!teamMap[dKey]) teamMap[dKey] = { id: match.dire_team_id    || null, name: direName,    wins: 0, losses: 0, totalDuration: 0 };
    match.radiant_win ? teamMap[rKey].wins++   : teamMap[rKey].losses++;
    match.radiant_win ? teamMap[dKey].losses++ : teamMap[dKey].wins++;
    teamMap[rKey].totalDuration += match.duration || 0;
    teamMap[dKey].totalDuration += match.duration || 0;

    // Players
    if (!Array.isArray(match.players)) continue;

    for (const p of match.players) {
      const id = p.account_id;
      if (!id || id === 4294967295) continue;

      const isRadiant = (p.player_slot ?? 0) < 128;
      const won       = isRadiant ? match.radiant_win : !match.radiant_win;
      const team      = isRadiant ? radiantName : direName;
      const name      = p.name || p.personaname || `Player ${id}`;

      if (!playerMap[id]) {
        playerMap[id] = {
          id, name, team,
          games: 0, wins: 0,
          kills: 0, deaths: 0, assists: 0,
          gpm: 0, xpm: 0,
          heroStats: {},   // heroId → { games, wins }
        };
      }

      const pl = playerMap[id];
      pl.games++;
      if (won) pl.wins++;
      pl.kills   += p.kills        || 0;
      pl.deaths  += p.deaths       || 0;
      pl.assists += p.assists      || 0;
      pl.gpm     += p.gold_per_min || 0;
      pl.xpm     += p.xp_per_min   || 0;
      pl.name     = name;
      pl.team     = team;

      // Hero stats
      const hid = String(p.hero_id);
      if (hid && hid !== '0') {
        if (!pl.heroStats[hid]) pl.heroStats[hid] = { games: 0, wins: 0 };
        pl.heroStats[hid].games++;
        if (won) pl.heroStats[hid].wins++;
      }
    }
  }

  const teams   = Object.values(teamMap).sort((a, b) => b.wins - a.wins);
  const players = Object.values(playerMap).sort((a, b) => b.games - a.games);
  return { teams, players };
}

// Return top N heroes for a player sorted by games played
function topHeroes(player, n = 3) {
  return Object.entries(player.heroStats)
    .map(([hid, s]) => ({
      hid,
      name : heroMap[hid] || `Hero ${hid}`,
      games: s.games,
      wins : s.wins,
    }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins)
    .slice(0, n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────
function renderHeader(slug, leagueInfo) {
  const dotabuffUrl = `${DOTABUFF_BASE}${slug}`;
  $('dotabuffLink').href = dotabuffUrl;

  if (leagueInfo?.name) {
    $('leagueName').textContent = leagueInfo.name;
  } else {
    $('leagueName').textContent = slug
      .replace(/^\d+-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  const tier = leagueInfo?.tier;
  if (tier) {
    $('leagueTier').textContent = tier;
  } else {
    $('leagueTier').classList.add('hidden');
  }
}

function renderSource(label) {
  $('sourceBadge').textContent = label;
}

function renderSummary(teams, players, games) {
  $('totalTeams').textContent   = teams.length;
  $('totalPlayers').textContent = players.length;
  $('totalGames').textContent   = games.length;
}

function renderTeams(teams) {
  if (!teams.length) {
    $('teamsBody').innerHTML = emptyRow(5, 'No team data found.');
    return;
  }
  $('teamsBody').innerHTML = teams.map((t, i) => {
    const total   = t.wins + t.losses;
    const avgDur  = total ? fmtDuration(Math.round(t.totalDuration / total)) : '—';
    return `<tr>
      <td class="row-num">${i + 1}</td>
      <td class="team-name">${
        t.id
          ? `<a href="https://www.dotabuff.com/esports/teams/${t.id}" target="_blank" rel="noopener">${t.name}</a>`
          : t.name
      }</td>
      <td><span class="win-count">${t.wins}</span></td>
      <td><span class="loss-count">${t.losses}</span></td>
      ${winRateCell(t.wins, total)}
      <td class="duration-cell">${avgDur}</td>
    </tr>`;
  }).join('');
}

function renderPlayers(players) {
  if (!players.length) {
    $('playersBody').innerHTML = emptyRow(9, 'No player data found.');
    return;
  }
  $('playersBody').innerHTML = players.map((p, i) => {
    const avgK   = p.games ? (p.kills   / p.games).toFixed(1) : '0.0';
    const avgD   = p.games ? (p.deaths  / p.games).toFixed(1) : '0.0';
    const avgA   = p.games ? (p.assists / p.games).toFixed(1) : '0.0';
    const avgGPM = p.games ? Math.round(p.gpm / p.games)      : 0;
    const avgXPM = p.games ? Math.round(p.xpm / p.games)      : 0;

    const heroPills = topHeroes(p, 3).map(h => {
      const wr    = fmtPct(h.wins, h.games);
      const color = h.wins / h.games >= 0.5 ? 'var(--win)' : 'var(--loss)';
      return `<span class="hero-pill" style="border-color:${color}">
        ${h.name} <small>${h.games}G&nbsp;·&nbsp;<span style="color:${color}">${wr}</span></small>
      </span>`;
    }).join('');

    return `<tr>
      <td class="row-num">${i + 1}</td>
      <td class="player-name">
        <a href="https://steamcommunity.com/profiles/${toSteam64(p.id)}" target="_blank" rel="noopener">${p.name}</a>
      </td>
      <td>${p.team}</td>
      <td>${p.games}</td>
      ${winRateCell(p.wins, p.games)}
      <td class="kda-cell">
        <span class="win-count">${avgK}</span> /
        <span class="loss-count">${avgD}</span> /
        <span>${avgA}</span>
      </td>
      <td class="stat-cell">${avgGPM}</td>
      <td class="stat-cell">${avgXPM}</td>
      <td class="heroes-cell"><div class="hero-pills">${heroPills || '—'}</div></td>
    </tr>`;
  }).join('');
}

function renderGames(matches) {
  if (!matches.length) {
    $('gamesBody').innerHTML = emptyRow(7, 'No game data found.');
    return;
  }
  $('gamesBody').innerHTML = [...matches]
    .sort((a, b) => (b.start_time || 0) - (a.start_time || 0))
    .map((g) => {
      const radiant = g.radiant_name || g.radiant_team?.name || 'Radiant';
      const dire    = g.dire_name    || g.dire_team?.name    || 'Dire';
      const winner  = g.radiant_win
        ? `<span class="winner-badge winner-radiant">${radiant}</span>`
        : `<span class="winner-badge winner-dire">${dire}</span>`;
      const score = (g.radiant_score != null && g.dire_score != null)
        ? `${g.radiant_score} – ${g.dire_score}` : '—';
      return `<tr>
        <td><a class="match-link" href="https://www.opendota.com/matches/${g.match_id}" target="_blank" rel="noopener">${g.match_id}</a></td>
        <td>${radiant}</td>
        <td>${dire}</td>
        <td class="score-cell">${score}</td>
        <td class="duration-cell">${fmtDuration(g.duration)}</td>
        <td>${winner}</td>
        <td class="date-cell">${fmtDate(g.start_time)}</td>
      </tr>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────
function csvEscape(val) {
  const s = String(val ?? '');
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCSV(rows) {
  return '\uFEFF' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

function downloadCSV(filename, rows) {
  const blob = new Blob([buildCSV(rows)], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCSV(type) {
  const slug = currentSlug || 'league';

  if (type === 'teams') {
    const rows = [['Team ID', 'Dotabuff Link', 'Team', 'Wins', 'Losses', 'Win Rate', 'Avg Duration']];
    for (const t of currentTeams) {
      const total      = t.wins + t.losses;
      const avgDur     = total ? fmtDuration(Math.round(t.totalDuration / total)) : '';
      const dotabuffUrl = t.id ? `https://www.dotabuff.com/esports/teams/${t.id}` : '';
      rows.push([t.id || '', dotabuffUrl, t.name, t.wins, t.losses, fmtPct(t.wins, total), avgDur]);
    }
    downloadCSV(`${slug}_teams.csv`, rows);
  }

  else if (type === 'players') {
    // One row per player × hero combination (long format)
    const rows = [
      ['Steam64 ID', 'Steam Profile', 'Player', 'Team', 'Total Games', 'Total Wins', 'Total Win Rate',
       'Avg Kills', 'Avg Deaths', 'Avg Assists', 'Avg GPM', 'Avg XPM',
       'Hero', 'Hero Games', 'Hero Wins', 'Hero Win Rate'],
    ];
    for (const p of currentPlayers) {
      const steam64  = toSteam64(p.id);
      const profileUrl = `https://steamcommunity.com/profiles/${steam64}`;
      const base = [
        steam64, profileUrl, p.name, p.team, p.games, p.wins, fmtPct(p.wins, p.games),
        p.games ? (p.kills / p.games).toFixed(2)   : 0,
        p.games ? (p.deaths / p.games).toFixed(2)  : 0,
        p.games ? (p.assists / p.games).toFixed(2) : 0,
        p.games ? Math.round(p.gpm / p.games)      : 0,
        p.games ? Math.round(p.xpm / p.games)      : 0,
      ];
      const heroes = topHeroes(p, 99); // all heroes
      if (heroes.length === 0) {
        rows.push([...base, '', '', '', '']);
      } else {
        for (const h of heroes) {
          rows.push([...base, h.name, h.games, h.wins, fmtPct(h.wins, h.games)]);
        }
      }
    }
    downloadCSV(`${slug}_players.csv`, rows);
  }

  else if (type === 'games') {
    const rows = [['Match ID', 'Radiant', 'Dire', 'Radiant Score', 'Dire Score',
                   'Duration (s)', 'Duration', 'Winner', 'Date']];
    for (const g of [...currentMatches].sort((a, b) => (b.start_time || 0) - (a.start_time || 0))) {
      const radiant = g.radiant_name || g.radiant_team?.name || 'Radiant';
      const dire    = g.dire_name    || g.dire_team?.name    || 'Dire';
      rows.push([
        g.match_id, radiant, dire,
        g.radiant_score ?? '', g.dire_score ?? '',
        g.duration ?? '', fmtDuration(g.duration),
        g.radiant_win ? radiant : dire,
        fmtDate(g.start_time),
      ]);
    }
    downloadCSV(`${slug}_games.csv`, rows);
  }

  else if (type === 'general') {
    const totalKills = currentMatches.reduce((s, m) =>
      s + (m.radiant_score || 0) + (m.dire_score || 0), 0);
    const avgDur = currentMatches.length
      ? Math.round(currentMatches.reduce((s, m) => s + (m.duration || 0), 0) / currentMatches.length)
      : 0;

    // Top hero overall
    const heroTotals = {};
    for (const p of currentPlayers) {
      for (const [hid, s] of Object.entries(p.heroStats)) {
        if (!heroTotals[hid]) heroTotals[hid] = { name: heroMap[hid] || hid, games: 0, wins: 0 };
        heroTotals[hid].games += s.games;
        heroTotals[hid].wins  += s.wins;
      }
    }
    const sortedHeroes = Object.values(heroTotals).sort((a, b) => b.games - a.games);

    const rows = [['Stat', 'Value']];
    rows.push(['Tournament', $('leagueName').textContent]);
    rows.push(['Total Matches', currentMatches.length]);
    rows.push(['Total Teams', currentTeams.length]);
    rows.push(['Total Players', currentPlayers.length]);
    rows.push(['Total Kills', totalKills]);
    rows.push(['Avg Game Duration', fmtDuration(avgDur)]);
    if (currentTeams.length) {
      const best = currentTeams[0];
      rows.push(['Best Team (by W)', `${best.name} (${best.wins}W–${best.losses}L)`]);
    }
    if (currentPlayers.length) {
      const mp = currentPlayers[0];
      rows.push(['Most Active Player', `${mp.name} (${mp.games} games)`]);
    }
    rows.push(['', '']);
    rows.push(['Top Heroes (by picks)', '']);
    rows.push(['Hero', 'Games', 'Wins', 'Win Rate']);
    for (const h of sortedHeroes.slice(0, 15)) {
      rows.push([h.name, h.games, h.wins, fmtPct(h.wins, h.games)]);
    }
    downloadCSV(`${slug}_summary.csv`, rows);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core pipeline
// ─────────────────────────────────────────────────────────────────────────────
async function runPipeline(slug, matchIds, sourceLabel) {
  if (matchIds.length === 0) {
    showError('No match IDs found', 'The scraped pages contained no /matches/ links. Try the paste fallback below.');
    return;
  }

  setLoading(`Found ${matchIds.length} match IDs — loading from OpenDota…`);
  setProgress(0, matchIds.length);

  // Fetch hero names and match data in parallel
  const [matches, fetchedHeroMap] = await Promise.all([
    fetchAllMatches(matchIds),
    fetchHeroMap(),
  ]);

  heroMap = fetchedHeroMap;

  if (matches.length === 0) {
    showError(
      'OpenDota returned no data',
      'Match IDs were found but OpenDota could not load any. They may not be parsed yet.',
    );
    return;
  }

  const { teams, players } = aggregateMatches(matches);

  // Store in global state for CSV export
  currentMatches = matches;
  currentTeams   = teams;
  currentPlayers = players;

  // Best-effort league info from OpenDota
  const leagueId   = slug.match(/^(\d+)/)?.[1];
  let   leagueInfo = null;
  if (leagueId) {
    leagueInfo = await fetch(`${OPENDOTA}/leagues/${leagueId}`)
      .then(r => r.ok ? r.json() : null).catch(() => null);
  }

  renderHeader(slug, leagueInfo);
  renderSource(sourceLabel);
  renderSummary(teams, players, matches);
  renderTeams(teams);
  renderPlayers(players);
  renderGames(matches);
  showContent();
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview buttons
// ─────────────────────────────────────────────────────────────────────────────
$('startExtractionBtn').addEventListener('click', async () => {
  previewState.classList.add('hidden');
  loadingState.classList.remove('hidden');
  progressWrap.style.display = 'none';
  setLoading('Fetching match data from OpenDota…');
  await runPipeline(currentSlug, currentMatchIds, `Dotabuff (${currentMatchIds.length} matches)`);
});

$('exportMatchIdsBtn').addEventListener('click', () => {
  const rows = currentMatchIds.map(id => [id]);
  downloadCSV(`${currentSlug}_match_ids.csv`, rows);
});

$('cancelPreviewBtn').addEventListener('click', () => {
  window.location.href = 'index.html';
});

// ─────────────────────────────────────────────────────────────────────────────
// Paste fallback
// ─────────────────────────────────────────────────────────────────────────────
parseBtn.addEventListener('click', () => {
  const text = pasteArea.value.trim();
  if (!text) return;
  const ids = extractMatchIds(text);
  if (ids.length === 0) {
    errorMessage.textContent = 'No match IDs found in pasted text. Copy the full page.';
    return;
  }
  currentMatchIds = ids;
  showPreview(ids, '?');  // pages unknown when pasted manually
});

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(window.location.search);
  const slug   = params.get('slug');

  if (!slug) {
    showError('No league slug', 'Go back to the home page and paste a Dotabuff URL.', false);
    return;
  }

  currentSlug = slug;
  document.title = `${slug} — Beingstattracker`;

  const maxPagesParam = parseInt(params.get('maxPages'), 10);
  const maxPages      = maxPagesParam > 0 ? maxPagesParam : MAX_PAGES;

  setLoading('Scanning Dotabuff series pages…');

  let scraped;

  try {
    scraped = await scrapeAllPages(slug, maxPages);
  } catch (err) {
    showError(
      'Could not auto-fetch Dotabuff',
      `Cloudflare blocked the request (${err.message}). Use the paste fallback below.`,
    );
    pasteArea.placeholder =
      `Open ${DOTABUFF_BASE}${slug}/series in your browser, ` +
      `Ctrl+A → Ctrl+C, then paste all pages here.`;
    return;
  }

  if (scraped.ids.length === 0) {
    showError(
      'No matches found on Dotabuff',
      'All pages were scanned but no /matches/ links were found. Use the paste fallback.',
    );
    return;
  }

  // Show preview — user confirms before extraction starts
  currentMatchIds = scraped.ids;
  showPreview(scraped.ids, scraped.pages, scraped.log);
}

init();
