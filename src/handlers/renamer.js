// ═══════════════════════════════════════════════════════════════════
// Built-in Renamer — replaces FileBot with zero external dependencies
// Uses Renamr's filename parser + TMDB API + Node.js fs operations
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

const VIDEO_EXTS = new Set(['.mkv','.mp4','.avi','.mov','.wmv','.flv','.m4v','.webm','.ts','.m2ts']);

// ══════════════════════════════════════════════════════════════════
// Filename Parser (from Renamr)
// ══════════════════════════════════════════════════════════════════

function parseMediaFilename(filename) {
  const name = path.basename(filename, path.extname(filename));
  const raw = name.replace(/\./g, ' ').replace(/_/g, ' ');
  const tags = extractMediaTags(raw);

  const clean = raw.replace(/\[.*?\]/g, '').replace(/\((?!\d{4})[^)]*\)/g, '').trim();

  // TV Show: S01E02, S01 E02, S01.E02, 1x02, Season 1 Episode 2
  const tvPatterns = [
    /(.+?)[\s._-]+S(\d{1,2})[\s._-]*E(\d{1,3})/i,
    /(.+?)[\s._-]+(\d{1,2})x(\d{1,3})/i,
    /(.+?)[\s._-]+Season[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})/i,
  ];
  for (const pattern of tvPatterns) {
    const match = clean.match(pattern);
    if (match) {
      let series = match[1].trim();
      let seriesYear = null;
      // Extract year from series name: bare "Scrubs 2026" or parenthesized "Ted Lasso (2020)"
      const yearInSeries = series.match(/[\s._-]+[\(\[]?((?:19|20)\d{2})[\)\]]?$/);
      if (yearInSeries) {
        seriesYear = parseInt(yearInSeries[1]);
        series = series.replace(/[\s._-]+[\(\[]?(?:19|20)\d{2}[\)\]]?$/, '').trim();
      }
      return { type: 'tv', series, seriesYear, season: parseInt(match[2]), episode: parseInt(match[3]), title: '', ...tags };
    }
  }

  // Movie: Title (Year) or Title Year
  const movieMatch = clean.match(/(.+?)[\s._-]*[\(\[]?(\d{4})[\)\]]?/);
  if (movieMatch) {
    return { type: 'movie', title: movieMatch[1].trim(), year: parseInt(movieMatch[2]), ...tags };
  }

  return { type: 'unknown', title: clean, ...tags };
}

function extractMediaTags(str) {
  const result = { resolution: '', source: '', videoCodec: '', audioCodec: '', hdr: '', edition: '', group: '', channels: '' };
  if (/2160p|4k|uhd/i.test(str))       result.resolution = '2160p';
  else if (/1080p|1080i/i.test(str))    result.resolution = '1080p';
  else if (/720p/i.test(str))           result.resolution = '720p';
  else if (/480p|sd/i.test(str))        result.resolution = '480p';
  if (/\bblu[\s-]?ray\b|bdremux|bdrip/i.test(str))       result.source = 'BluRay';
  else if (/\bremux\b/i.test(str))                         result.source = 'Remux';
  else if (/\bweb[\s-]?dl\b/i.test(str))                  result.source = 'WEB-DL';
  else if (/\bwebrip\b/i.test(str))                        result.source = 'WEBRip';
  else if (/\bweb\b/i.test(str))                           result.source = 'WEB';
  else if (/\bhdtv\b/i.test(str))                          result.source = 'HDTV';
  else if (/\bdvd(?:rip|scr)?\b/i.test(str))              result.source = 'DVD';
  if (/\bx265\b|\bhevc\b|\bh[\s.]?265\b/i.test(str))     result.videoCodec = 'x265';
  else if (/\bx264\b|\bavc\b|\bh[\s.]?264\b/i.test(str)) result.videoCodec = 'x264';
  else if (/\bav1\b/i.test(str))                           result.videoCodec = 'AV1';
  if (/\batmos\b/i.test(str))                              result.audioCodec = 'Atmos';
  else if (/\btruehd\b/i.test(str))                        result.audioCodec = 'TrueHD';
  else if (/\bdts[\s-]?hd[\s-]?ma\b/i.test(str))          result.audioCodec = 'DTS-HD MA';
  else if (/\bdts\b/i.test(str))                           result.audioCodec = 'DTS';
  else if (/\beac3\b|\bddp\b/i.test(str))                 result.audioCodec = 'EAC3';
  else if (/\bac3\b|\bdd5/i.test(str))                     result.audioCodec = 'AC3';
  else if (/\baac\b/i.test(str))                           result.audioCodec = 'AAC';
  if (/\b7[\s.]1\b/.test(str))          result.channels = '7.1';
  else if (/\b5[\s.]1\b/.test(str))     result.channels = '5.1';
  else if (/\b2[\s.]0\b/.test(str))     result.channels = '2.0';
  if (/\bdolby[\s-]?vision\b|\b(?:dv|dovi)\b/i.test(str)) result.hdr = 'DV';
  if (/\bhdr10\+?\b/i.test(str))                           result.hdr = result.hdr ? result.hdr + ' HDR10' : 'HDR10';
  else if (/\bhdr\b/i.test(str) && !result.hdr)            result.hdr = 'HDR';
  if (/\b10[\s-]?bit\b/i.test(str) && !result.hdr)        result.hdr = '10bit';
  if (/\bimax\b/i.test(str))                               result.edition = 'IMAX';
  else if (/\bdirector'?s[\s-]?cut\b/i.test(str))         result.edition = "Director's Cut";
  else if (/\bextended\b/i.test(str))                      result.edition = 'Extended';
  else if (/\bunrated\b/i.test(str))                       result.edition = 'Unrated';
  else if (/\bremastered\b/i.test(str))                    result.edition = 'Remastered';
  const groupMatch = str.match(/[-\s]([A-Za-z0-9]+)$/);
  if (groupMatch && groupMatch[1].length >= 2 && groupMatch[1].length <= 20) {
    const g = groupMatch[1];
    const fp = ['mkv','mp4','avi','mov','x264','x265','hevc','avc','hdr','web','dl','bluray','rip','remux','imax','extended'];
    if (!fp.includes(g.toLowerCase())) result.group = g;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════
// TMDB API helpers
// ══════════════════════════════════════════════════════════════════

async function tmdbSearchApi(apiKey, query, type, year) {
  const endpoint = type === 'tv'
    ? 'https://api.themoviedb.org/3/search/tv'
    : 'https://api.themoviedb.org/3/search/movie';
  let url = `${endpoint}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&language=en-US&page=1`;
  if (year) {
    // TMDB uses different year params: 'year' for movies, 'first_air_date_year' for TV
    url += type === 'tv' ? `&first_air_date_year=${year}` : `&year=${year}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, 10).map(item => ({
    id: item.id,
    title: item.title || item.name,
    year: (item.release_date || item.first_air_date || '').substring(0, 4),
    overview: item.overview || '',
    posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : null,
  }));
}

async function tmdbTvDetails(apiKey, tvId) {
  const url = `https://api.themoviedb.org/3/tv/${tvId}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    year: (data.first_air_date || '').substring(0, 4),
    seasons: (data.seasons || []).filter(s => s.season_number > 0).map(s => s.season_number),
  };
}

async function tmdbSeasonEpisodes(apiKey, tvId, seasonNum) {
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNum}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const ep of (data.episodes || [])) {
    map[ep.episode_number] = ep.name;
  }
  return map;
}

// ══════════════════════════════════════════════════════════════════
// Path formatting
// ══════════════════════════════════════════════════════════════════

function sanitize(str) {
  return str.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

// Movie: Title (Year)/Title (Year) Resolution.ext
function formatMoviePath(tmdbTitle, tmdbYear, resolution, ext) {
  const t = sanitize(tmdbTitle);
  const folder = tmdbYear ? `${t} (${tmdbYear})` : t;
  const file = tmdbYear
    ? `${t} (${tmdbYear})${resolution ? ' ' + resolution : ''}`
    : `${t}${resolution ? ' ' + resolution : ''}`;
  return path.join(folder, file + ext);
}

// TV: Series (Year)/Season S/Series - SXXEXX - Episode Title.ext
function formatTvPath(tmdbTitle, tmdbYear, season, episode, episodeName, ext) {
  const t = sanitize(tmdbTitle);
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const epPart = episodeName ? ` - ${sanitize(episodeName)}` : '';
  const folder = tmdbYear ? `${t} (${tmdbYear})` : t;
  return path.join(folder, `Season ${season}`, `${t} - S${s}E${e}${epPart}${ext}`);
}

// ══════════════════════════════════════════════════════════════════
// Scan staging for video files
// ══════════════════════════════════════════════════════════════════

function scanVideoFiles(dirPath) {
  const results = [];
  if (!dirPath || !fs.existsSync(dirPath)) return results;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) results.push(full);
    }
  }
  walk(dirPath);
  return results;
}

// ══════════════════════════════════════════════════════════════════
// Clean name for TMDB search
// ══════════════════════════════════════════════════════════════════

function cleanForSearch(name) {
  return name
    .replace(/[\.\-\_]/g, ' ')
    .replace(/\b(720p|1080p|2160p|4k|uhd|bluray|bdrip|brrip|webrip|web|dl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|atmos|dts|remux|proper|repack|internal|dubbed|subbed|multi|10bit|hdr|sdr|ddp|dv|dovi|5\.1)\b/gi, '')
    .replace(/\bS\d{1,2}[\s._-]*E\d{1,3}\b/gi, '')
    .replace(/\b(Season|S)\s*\d+/gi, '')
    .replace(/\bE\d{1,3}\b/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
}

// ══════════════════════════════════════════════════════════════════
// Core: match files against TMDB and produce rename plan
// ══════════════════════════════════════════════════════════════════

async function buildRenamePlan(stagingPath, type, apiKey, query) {
  if (!apiKey) throw new Error('TMDB API key not configured — add it in Settings');
  if (!stagingPath || !fs.existsSync(stagingPath)) throw new Error('Staging folder not found');

  const files = scanVideoFiles(stagingPath);
  console.log('[renamer] scanVideoFiles found', files.length, 'files in', stagingPath);
  if (!files.length) return [];

  const renames = [];
  const mediaType = type === 'tv' ? 'tv' : 'movie';

  if (mediaType === 'movie') {
    const parsed = parseMediaFilename(files[0]);
    const searchQuery = query || cleanForSearch(parsed.title || path.basename(files[0]));
    const year = parsed.year || null;
    console.log('[renamer] Movie search:', searchQuery, 'year:', year);
    const results = await tmdbSearchApi(apiKey, searchQuery, 'movie', year);
    if (!results.length) {
      const retry = year ? await tmdbSearchApi(apiKey, searchQuery, 'movie', null) : [];
      if (!retry.length) { console.log('[renamer] No TMDB movie results'); return []; }
      results.push(...retry);
    }
    const match = results[0];
    console.log('[renamer] Movie matched:', match.title, match.year);

    for (const filePath of files) {
      const fp = parseMediaFilename(filePath);
      const ext = path.extname(filePath);
      const newRel = formatMoviePath(match.title, match.year, fp.resolution, ext);
      const newPath = path.join(stagingPath, newRel);
      renames.push({ from: filePath, to: newPath, fromDisplay: path.basename(filePath), toDisplay: newRel });
    }
  } else {
    const parsed = files.map(f => ({ path: f, ...parseMediaFilename(f) }));
    let searchQuery = query || cleanForSearch(parsed[0].series || parsed[0].title || path.basename(files[0]));
    let searchYear = parsed[0].seriesYear || null;
    // Safety: strip (year) from search query if parser left it in
    const yearInQuery = searchQuery.match(/\s*[\(\[]?((?:19|20)\d{2})[\)\]]?$/);
    if (yearInQuery) {
      if (!searchYear) searchYear = parseInt(yearInQuery[1]);
      searchQuery = searchQuery.replace(/\s*[\(\[]?(?:19|20)\d{2}[\)\]]?$/, '').trim();
    }
    console.log('[renamer] TV search:', searchQuery, 'year:', searchYear, 'parsed[0]:', JSON.stringify({ series: parsed[0].series, seriesYear: parsed[0].seriesYear, season: parsed[0].season, episode: parsed[0].episode }));

    // Search with year first for disambiguation (e.g. Scrubs 2026 vs Scrubs 2001)
    let results = await tmdbSearchApi(apiKey, searchQuery, 'tv', searchYear);
    // If no results with year, retry without
    if (!results.length && searchYear) {
      console.log('[renamer] No results with year, retrying without...');
      results = await tmdbSearchApi(apiKey, searchQuery, 'tv', null);
    }
    if (!results.length) { console.log('[renamer] No TMDB TV results'); return []; }

    // If we have a year, prefer the result whose year matches
    let match = results[0];
    if (searchYear) {
      const yearMatch = results.find(r => r.year === String(searchYear));
      if (yearMatch) match = yearMatch;
    }
    console.log('[renamer] TV matched:', match.title, match.year, 'id:', match.id);

    const seasonsNeeded = [...new Set(parsed.filter(p => p.season).map(p => p.season))];
    console.log('[renamer] Seasons needed:', seasonsNeeded);
    const episodeNames = {};
    for (const sn of seasonsNeeded) {
      episodeNames[sn] = await tmdbSeasonEpisodes(apiKey, match.id, sn);
    }

    for (const p of parsed) {
      if (!p.season || !p.episode) continue;
      const ext = path.extname(p.path);
      const epName = episodeNames[p.season]?.[p.episode] || '';
      const newRel = formatTvPath(match.title, match.year, p.season, p.episode, epName, ext);
      const newPath = path.join(stagingPath, newRel);
      renames.push({ from: p.path, to: newPath, fromDisplay: path.basename(p.path), toDisplay: newRel });
    }
  }

  console.log('[renamer] Built', renames.length, 'renames');
  return renames;
}

// ══════════════════════════════════════════════════════════════════
// Execute renames (move files, create dirs, cleanup empties)
// ══════════════════════════════════════════════════════════════════

async function executeRenames(plan) {
  const results = [];
  const dirsToClean = new Set();

  for (const op of plan) {
    try {
      const targetDir = path.dirname(op.to);
      await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o777 });

      if (op.from === op.to) {
        results.push({ from: op.fromDisplay, to: op.toDisplay, success: true });
        continue;
      }

      if (fs.existsSync(op.to)) {
        results.push({ from: op.fromDisplay, to: op.toDisplay, success: false, error: 'Target already exists' });
        continue;
      }

      dirsToClean.add(path.dirname(op.from));

      try {
        await fs.promises.rename(op.from, op.to);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // Cross-device: copy then delete
          await fs.promises.copyFile(op.from, op.to);
          const srcStat = await fs.promises.stat(op.from);
          const dstStat = await fs.promises.stat(op.to);
          if (dstStat.size === srcStat.size) {
            await fs.promises.unlink(op.from);
          } else {
            try { await fs.promises.unlink(op.to); } catch (_) {}
            throw new Error('Copy verification failed');
          }
        } else {
          throw err;
        }
      }

      results.push({ from: op.fromDisplay, to: op.toDisplay, success: true });
    } catch (err) {
      results.push({ from: op.fromDisplay, to: op.toDisplay, success: false, error: err.message });
    }
  }

  // Clean empty source directories (up to 2 levels)
  for (const dir of dirsToClean) {
    let current = dir;
    for (let i = 0; i < 2; i++) {
      try {
        if (!fs.existsSync(current)) { current = path.dirname(current); continue; }
        const entries = await fs.promises.readdir(current);
        if (entries.length === 0) {
          await fs.promises.rmdir(current);
          current = path.dirname(current);
        } else break;
      } catch (_) { break; }
    }
  }

  return results;
}


// ══════════════════════════════════════════════════════════════════
// REST API Routes (replaces IPC handlers)
// ══════════════════════════════════════════════════════════════════

function setupRenamerRoutes(app, store, auth) {
  app.get('/api/renamer/test', auth, async (req, res) => {
    const apiKey = store.get('tmdb.apiKey') || '';
    if (!apiKey) return res.json({ success: false, error: 'TMDB API key not set — add it in Settings' });
    try {
      const r = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`);
      if (!r.ok) return res.json({ success: false, error: `TMDB API error: ${r.status}` });
      res.json({ success: true, version: 'Built-in Renamer (TMDB)' });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/renamer/preview', auth, async (req, res) => {
    try {
      const type = (req.body.type === 'movie' || req.body.type === 'tv') ? req.body.type : 'movie';
      const apiKey = store.get('tmdb.apiKey') || '';
      const staging = req.body.stagingPath || store.get('paths.staging') || '';
      const query = req.body.query || null;
      const plan = await buildRenamePlan(staging, type, apiKey, query);
      if (!plan.length) return res.json({ success: true, renames: [], output: 'No matches found' });
      res.json({ success: true, renames: plan.map(p => ({ from: p.fromDisplay, to: p.toDisplay })) });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/renamer/rename', auth, async (req, res) => {
    try {
      const type = (req.body.type === 'movie' || req.body.type === 'tv') ? req.body.type : 'movie';
      const apiKey = store.get('tmdb.apiKey') || '';
      const staging = req.body.stagingPath || store.get('paths.staging') || '';
      const query = req.body.query || null;
      const plan = await buildRenamePlan(staging, type, apiKey, query);
      if (!plan.length) return res.json({ success: true, renamed: [], output: 'No matches found' });
      const results = await executeRenames(plan);
      res.json({ success: true, renamed: results.filter(r => r.success), output: `Renamed ${results.filter(r => r.success).length} file(s)` });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/renamer/search', auth, async (req, res) => {
    try {
      const type = (req.body.type === 'tv') ? 'tv' : 'movie';
      const apiKey = store.get('tmdb.apiKey') || '';
      if (!apiKey) return res.json({ success: false, error: 'TMDB API key not configured' });
      const results = await tmdbSearchApi(apiKey, req.body.query, type, null);
      const matches = results.map(r => r.year ? `${r.title} (${r.year})` : r.title);
      res.json({ success: true, matches, output: `Found ${matches.length} result(s)` });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });
}


module.exports = {
  setupRenamerRoutes,
  parseMediaFilename,
  cleanForSearch,
  buildRenamePlan,
  executeRenames,
  tmdbSearchApi,
  scanVideoFiles,
};
