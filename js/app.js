// ─── Dotabuff URL search ──────────────────────────────────────────────────────
const form          = document.getElementById('searchForm');
const input         = document.getElementById('leagueInput');
const maxPagesInput = document.getElementById('maxPagesInput');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;

  const slug = extractDotabuffSlug(raw);
  if (!slug) {
    input.style.boxShadow = '0 0 0 2px var(--loss)';
    input.placeholder = 'Please paste a valid Dotabuff league URL';
    input.value = '';
    return;
  }

  const maxPages = parseInt(maxPagesInput.value, 10);
  const params   = new URLSearchParams({ slug });
  if (maxPages > 0) params.set('maxPages', maxPages);

  window.location.href = `league.html?${params.toString()}`;
});

function extractDotabuffSlug(value) {
  const urlMatch = value.match(/dotabuff\.com\/esports\/leagues\/([^\s/?#]+)/);
  if (urlMatch) return urlMatch[1];
  const slugMatch = value.match(/^(\d+[\w-]+)$/);
  if (slugMatch) return slugMatch[1];
  return null;
}

// ─── CSV import ───────────────────────────────────────────────────────────────
const csvFileInput     = document.getElementById('csvFileInput');
const importNameRow    = document.getElementById('importNameRow');
const importNameInput  = document.getElementById('importNameInput');
const importConfirmBtn = document.getElementById('importConfirmBtn');
const importStatus     = document.getElementById('importStatus');

let parsedImportIds = [];

csvFileInput.addEventListener('change', () => {
  const file = csvFileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    parsedImportIds = extractMatchIds(text);

    if (parsedImportIds.length === 0) {
      importStatus.textContent = 'No match IDs found in file.';
      importStatus.style.color = 'var(--loss)';
      importNameRow.classList.add('hidden');
      return;
    }

    importStatus.textContent = `${parsedImportIds.length} match ID${parsedImportIds.length !== 1 ? 's' : ''} found`;
    importStatus.style.color = 'var(--win)';
    importNameRow.classList.remove('hidden');
  };
  reader.readAsText(file);
});

// If a Dotabuff URL is pasted into the name field, fetch the league name from OpenDota
importNameInput.addEventListener('input', async () => {
  const val  = importNameInput.value.trim();
  const slug = extractDotabuffSlug(val);
  if (!slug) return;

  const leagueId = slug.match(/^(\d+)/)?.[1];
  if (!leagueId) return;

  importNameInput.disabled = true;
  importStatus.textContent  = 'Fetching league name…';
  importStatus.style.color  = 'var(--text-muted)';

  try {
    const res  = await fetch(`https://api.opendota.com/api/leagues/${leagueId}`);
    const data = res.ok ? await res.json() : null;
    if (data?.name) {
      importNameInput.value    = data.name;
      importStatus.textContent = `✓ ${data.name}`;
      importStatus.style.color = 'var(--win)';
    } else {
      importNameInput.value    = slug;
      importStatus.textContent = `Using slug (name not found)`;
      importStatus.style.color = 'var(--text-muted)';
    }
  } catch {
    importStatus.textContent = 'Could not fetch name';
    importStatus.style.color = 'var(--loss)';
  }

  importNameInput.disabled = false;
});

importConfirmBtn.addEventListener('click', () => {
  if (!parsedImportIds.length) return;
  const name = importNameInput.value.trim() || 'imported';
  sessionStorage.setItem('bst_import_ids', JSON.stringify(parsedImportIds));
  window.location.href = `league.html?source=csv&name=${encodeURIComponent(name)}`;
});

// Extract 8–13 digit match IDs from any text
function extractMatchIds(text) {
  const seen = new Set();
  const re   = /\b(\d{8,13})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) seen.add(m[1]);
  return [...seen];
}
