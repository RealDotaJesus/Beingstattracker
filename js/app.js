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

// Accepts:
//   Full URL: https://www.dotabuff.com/esports/leagues/17081-some-name
//   Slug:     17081-some-name
function extractDotabuffSlug(value) {
  const urlMatch = value.match(/dotabuff\.com\/esports\/leagues\/([^\s/?#]+)/);
  if (urlMatch) return urlMatch[1];

  // Bare slug starting with digits
  const slugMatch = value.match(/^(\d+[\w-]+)$/);
  if (slugMatch) return slugMatch[1];

  return null;
}
