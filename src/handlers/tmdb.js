// ═══════════════════════════════════════════════════════════════════
// TMDB Handler — Full TMDB integration
// Poster lookup, rich search, IMDB lookup, TV show/season details
// ═══════════════════════════════════════════════════════════════════

const { LRUCache } = require('media-manager-shared');
const posterCache = new LRUCache(500, 3600000); // 500 entries, 1hr TTL
const searchCache = new LRUCache(500, 3600000);

function cleanTitle(torrentTitle) {
  let t = torrentTitle;
  t = t.replace(/\.\w{2,4}$/, '');
  const yearMatch = t.match(/[\.\s\(]((19|20)\d{2})[\.\s\)]/);
  const year = yearMatch ? yearMatch[1] : null;
  t = t.replace(/[\.\s](?:S\d{1,2}|Season|Complete|720p|1080p|2160p|4k|UHD|WEB|HDTV|BluRay|BRRip|DVDRip|HDRip|AMZN|NF|DSNP|HULU|x264|x265|H\.?264|H\.?265|HEVC|AAC|DD5|DDP|Atmos|FLAC|REPACK|PROPER|MULTI|REMUX|10bit).*/i, '');
  if (year) t = t.replace(new RegExp(`[\\(\\.]?${year}[\\)\\.]?`), '');
  t = t.replace(/[\.\_\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return { query: t, year };
}

async function tmdbSoftSearch(apiKey, endpoint, query, year) {
  const words = query.split(' ').filter(Boolean);
  for (let len = words.length; len >= 2; len--) {
    const q = words.slice(0, len).join(' ');
    const yearParam = year ? `&${endpoint.includes('tv') ? 'first_air_date_year' : 'year'}=${year}` : '';
    const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(q)}${yearParam}`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const data = await r.json();
    if (data.results && data.results.length) return data.results;
  }
  if (year) {
    const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (r.ok) { const data = await r.json(); if (data.results && data.results.length) return data.results; }
  }
  return [];
}

function mapPosterResult(item) {
  return {
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : null,
    title: item.title || item.name,
    overview: (item.overview || '').slice(0, 200) + (item.overview && item.overview.length > 200 ? '...' : ''),
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
  };
}

function mapSearchResult(item, type) {
  return {
    id: item.id,
    title: item.title || item.name,
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    overview: (item.overview || '').slice(0, 200),
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : null,
    rating: item.vote_average ? item.vote_average.toFixed(1) : null,
    type,
  };
}

async function tmdbSearch(apiKey, query, type = 'movie') {
  const cacheKey = `${type}:${query}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);

  const yearMatch = query.match(/\((\d{4})\)/) || query.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;
  const cleanQuery = query.replace(/\(?\d{4}\)?/, '').trim();

  const doSearch = async (q, yr) => {
    const endpoint = type === 'tv' ? 'search/tv' : 'search/movie';
    const yearParam = yr ? `&${type === 'tv' ? 'first_air_date_year' : 'year'}=${yr}` : '';
    const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(q)}${yearParam}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, 10).map(r => mapSearchResult(r, type));
  };

  let results = await doSearch(cleanQuery, year);
  if (!results.length && year) results = await doSearch(cleanQuery, null);
  if (!results.length && cleanQuery.includes(' ')) {
    const words = cleanQuery.split(/\s+/);
    const merged = words.reduce((acc, w) => {
      if (acc.length && (acc[acc.length - 1].length <= 4 || w.length <= 4)) acc[acc.length - 1] += w;
      else acc.push(w);
      return acc;
    }, []).join(' ');
    if (merged !== cleanQuery) results = await doSearch(merged, null);
  }
  if (!results.length && cleanQuery.length >= 3) {
    for (const word of cleanQuery.split(/\s+/).filter(w => w.length >= 3)) {
      results = await doSearch(word, null);
      if (results.length) break;
    }
  }
  searchCache.set(cacheKey, results);
  return results;
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
      if (!results.length) { posterCache.set(cacheKey, { poster: null }); return res.json({ success: true, poster: null }); }
      const result = mapPosterResult(results[0]);
      posterCache.set(cacheKey, result);
      res.json({ success: true, ...result });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.get('/api/tmdb/search', auth, async (req, res) => {
    try {
      const { q, type } = req.query;
      if (!q) return res.status(400).json({ error: 'Query required' });
      const cfg = store.get('tmdb') || {};
      if (!cfg.apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
      let results = [];
      if (!type || type === 'movie') results.push(...await tmdbSearch(cfg.apiKey, q, 'movie'));
      if (!type || type === 'tv') results.push(...await tmdbSearch(cfg.apiKey, q, 'tv'));
      results.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
      res.json({ success: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tmdb/imdb/:id', auth, async (req, res) => {
    try {
      const cfg = store.get('tmdb') || {};
      if (!cfg.apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
      const url = `https://api.themoviedb.org/3/find/${req.params.id}?api_key=${cfg.apiKey}&external_source=imdb_id`;
      const tmdbRes = await fetch(url);
      if (!tmdbRes.ok) return res.status(404).json({ error: 'Not found on TMDB' });
      const data = await tmdbRes.json();
      const movie = data.movie_results?.[0]; const tv = data.tv_results?.[0]; const r = movie || tv;
      if (!r) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true, result: mapSearchResult(r, movie ? 'movie' : 'tv') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tmdb/tv/:tmdbId', auth, async (req, res) => {
    try {
      const cfg = store.get('tmdb') || {};
      if (!cfg.apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
      const showRes = await fetch(`https://api.themoviedb.org/3/tv/${req.params.tmdbId}?api_key=${cfg.apiKey}`);
      if (!showRes.ok) return res.status(404).json({ error: 'Show not found' });
      const show = await showRes.json();
      const today = new Date().toISOString().slice(0, 10);
      const seasons = (show.seasons || []).filter(s => s.season_number > 0).map(s => ({
        number: s.season_number, name: s.name, episodeCount: s.episode_count,
        airDate: s.air_date, aired: s.air_date && s.air_date <= today,
      }));
      res.json({
        success: true, title: show.name, totalSeasons: seasons.length, status: show.status, seasons,
        lastEpisode: show.last_episode_to_air ? { season: show.last_episode_to_air.season_number, episode: show.last_episode_to_air.episode_number } : null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tmdb/tv/:tmdbId/season/:num', auth, async (req, res) => {
    try {
      const cfg = store.get('tmdb') || {};
      if (!cfg.apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
      const seasonRes = await fetch(`https://api.themoviedb.org/3/tv/${req.params.tmdbId}/season/${req.params.num}?api_key=${cfg.apiKey}`);
      if (!seasonRes.ok) return res.status(404).json({ error: 'Season not found' });
      const season = await seasonRes.json();
      const today = new Date().toISOString().slice(0, 10);
      const episodes = (season.episodes || []).map(ep => ({
        number: ep.episode_number, name: ep.name, airDate: ep.air_date,
        aired: ep.air_date && ep.air_date <= today, overview: (ep.overview || '').slice(0, 120),
      }));
      res.json({ success: true, seasonNumber: season.season_number, name: season.name, episodes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { setupTmdbRoutes, tmdbSearch };
