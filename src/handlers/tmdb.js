// ═══════════════════════════════════════════════════════════════════
// TMDB Poster Handler — REST API version
// ═══════════════════════════════════════════════════════════════════

const posterCache = new Map();

function cleanTitle(torrentTitle) {
  let t = torrentTitle;
  t = t.replace(/\.\w{2,4}$/, '');
  const yearMatch = t.match(/[\.\s\(]((19|20)\d{2})[\.\s\)]/);
  const year = yearMatch ? yearMatch[1] : null;
  // Strip from quality/codec/source keywords onwards
  t = t.replace(/[\.\s](?:S\d{1,2}|Season|Complete|720p|1080p|2160p|4k|UHD|WEB|HDTV|BluRay|BRRip|DVDRip|HDRip|AMZN|NF|DSNP|HULU|x264|x265|H\.?264|H\.?265|HEVC|AAC|DD5|DDP|Atmos|FLAC|REPACK|PROPER|MULTI|REMUX|10bit).*/i, '');
  if (year) t = t.replace(new RegExp(`[\\(\\.]?${year}[\\)\\.]?`), '');
  t = t.replace(/[\.\_\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return { query: t, year };
}

// Soft TMDB search: tries progressively shorter versions of the query by dropping
// trailing words one at a time until we get a hit (min 2 words). This handles
// titles with edition tags like "Extended", "Unrated", "Remastered", etc. that
// slip through cleanTitle — e.g. "Cowboys and Aliens Extended" → tries
// "Cowboys and Aliens Extended" first, then "Cowboys and Aliens" → hit.
async function tmdbSoftSearch(apiKey, endpoint, query, year) {
  const words = query.split(' ').filter(Boolean);

  // Try progressively shorter queries, stopping at 2 words minimum
  for (let len = words.length; len >= 2; len--) {
    const q = words.slice(0, len).join(' ');
    const yearParam = year ? `&${endpoint.includes('tv') ? 'first_air_date_year' : 'year'}=${year}` : '';
    const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(q)}${yearParam}`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const data = await r.json();
    if (data.results && data.results.length) return data.results;
  }

  // Last resort: try without the year constraint at full query length
  if (year) {
    const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (data.results && data.results.length) return data.results;
    }
  }

  return [];
}

function mapResult(item) {
  return {
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : null,
    title: item.title || item.name,
    overview: (item.overview || '').slice(0, 200) + (item.overview && item.overview.length > 200 ? '...' : ''),
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
  };
}

function setupTmdbRoutes(app, store, auth) {
  app.post('/api/tmdb/poster', auth, async (req, res) => {
    try {
      const { title: torrentTitle, type } = req.body;
      const cfg = store.get('tmdb') || {};
      if (!cfg.apiKey) return res.json({ success: false, error: 'No TMDB API key' });

      const cacheKey = `${type}:${torrentTitle}`;
      if (posterCache.has(cacheKey)) return res.json({ success: true, ...posterCache.get(cacheKey) });

      const { query, year } = cleanTitle(torrentTitle);
      if (!query) return res.json({ success: false, error: 'Could not parse title' });

      const endpoint = type === 'tv' ? 'search/tv' : 'search/movie';
      const results = await tmdbSoftSearch(cfg.apiKey, endpoint, query, year);

      if (!results.length) {
        posterCache.set(cacheKey, { poster: null });
        return res.json({ success: true, poster: null });
      }

      const result = mapResult(results[0]);
      posterCache.set(cacheKey, result);
      res.json({ success: true, ...result });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });
}

module.exports = { setupTmdbRoutes };
