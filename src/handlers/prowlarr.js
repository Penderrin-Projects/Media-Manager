async function prowlarrRequest(store, endpoint) {
  const cfg = store.get('prowlarr') || {};
  if (!cfg.url || !cfg.apiKey) throw new Error('Prowlarr not configured');
  const base = cfg.url.replace(/\/$/, '');
  const res = await fetch(`${base}${endpoint}`, {
    headers: { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Prowlarr ${res.status}: ${res.statusText}`);
  return res.json();
}

// ========== 1337x Direct Scraper ==========
// Scrapes 1337x's actual Popular and Trending pages for accurate top results

const LEET_BASES = ['https://1337x.to', 'https://1337xx.to', 'https://1337x.st'];

async function fetchWithFallback(paths, userAgent) {
  const errors = [];
  for (const base of LEET_BASES) {
    for (const path of (Array.isArray(paths) ? paths : [paths])) {
      try {
        const url = `${base}${path}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        });
        if (res.ok) {
          const html = await res.text();
          // Basic check that we got an actual page with torrent table
          if (html.includes('<table') && html.includes('coll-1')) {
            return html;
          }
        }
      } catch (e) {
        errors.push(`${base}${path}: ${e.message}`);
      }
    }
  }
  throw new Error(`All 1337x sources failed: ${errors.join('; ')}`);
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.replace(/\s/g, '').match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'TB') return num * 1099511627776;
  if (unit === 'GB') return num * 1073741824;
  if (unit === 'MB') return num * 1048576;
  if (unit === 'KB') return num * 1024;
  return 0;
}

function parseTimeStr(timeStr) {
  // Parse 1337x time strings like "6pm Feb. 26th", "9:05am", "2h ago", "1d. ago"
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  // Relative times like "2h ago", "1d. ago", "30m ago"
  const relMatch = trimmed.match(/(\d+)\s*(h|d|m)\.?\s*ago/i);
  if (relMatch) {
    const val = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const now = Date.now();
    if (unit === 'm') return new Date(now - val * 60000).toISOString();
    if (unit === 'h') return new Date(now - val * 3600000).toISOString();
    if (unit === 'd') return new Date(now - val * 86400000).toISOString();
  }
  return null; // don't try to parse complex date formats
}

function parse1337xTable(html) {
  // Simple regex-based parser for 1337x table rows - no cheerio dependency needed
  const results = [];
  // Match each table row in tbody
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return results;
  const tbody = tbodyMatch[1];
  
  // Split into rows
  const rows = tbody.split(/<tr[\s>]/i).filter(r => r.includes('coll-1'));
  
  for (const row of rows) {
    try {
      // Title and link - get the second <a> in coll-1 (first is icon)
      const titleCell = row.match(/class="coll-1[^"]*"[\s\S]*?<\/td>/i);
      if (!titleCell) continue;
      
      const links = [...titleCell[0].matchAll(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi)];
      const torrentLink = links.find(l => l[1].startsWith('/torrent/'));
      if (!torrentLink) continue;
      
      const title = torrentLink[2].trim();
      const infoPath = torrentLink[1];
      
      // Seeders (coll-2)
      const seedMatch = row.match(/class="coll-2[^"]*"[^>]*>(\d+)<\/td>/i) || 
                        row.match(/seeds[^>]*>(\d+)</i);
      const seeders = seedMatch ? parseInt(seedMatch[1]) : 0;
      
      // Leechers (coll-3)  
      const leechMatch = row.match(/class="coll-3[^"]*"[^>]*>(\d+)<\/td>/i) ||
                         row.match(/leech[^>]*>(\d+)</i);
      const leechers = leechMatch ? parseInt(leechMatch[1]) : 0;
      
      // Time (coll-date)
      const timeMatch = row.match(/class="coll-date[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const timeStr = timeMatch ? timeMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      
      // Size (coll-4)
      const sizeMatch = row.match(/class="coll-4[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const sizeStr = sizeMatch ? sizeMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      
      if (title) {
        results.push({
          title,
          infoPath,
          seeders,
          leechers,
          size: parseSize(sizeStr),
          sizeStr,
          timeStr,
          publishDate: parseTimeStr(timeStr),
        });
      }
    } catch (e) {
      // Skip malformed rows
    }
  }
  
  return results;
}

async function scrape1337xMagnet(infoPath) {
  for (const base of LEET_BASES) {
    try {
      const url = `${base}${infoPath}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const html = await res.text();
      const magnetMatch = html.match(/href="(magnet:\?[^"]+)"/i);
      const imdbMatch = html.match(/tt(\d{7,9})/);
      if (magnetMatch) return { magnet: magnetMatch[1], imdbId: imdbMatch ? `tt${imdbMatch[1]}` : null };
    } catch {}
  }
  return { magnet: null, imdbId: null };
}

async function get1337xPopular(type, period) {
  // type: 'movies', 'tv', or 'anime'
  // period: 'day', 'week', 'month', or 'all'
  
  const paths = [];
  const category = type === 'tv' ? 'tv' : type === 'anime' ? 'anime' : 'movies';
  
  // 1337x doesn't have anime-specific pages, so for anime we return empty
  // (Nyaa will be used instead for anime)
  if (category === 'anime') return [];
  
  if (period === 'day') {
    paths.push(`/popular-${category}`);
    paths.push(`/trending/d/${category}/`);
  } else if (period === 'week') {
    paths.push(`/popular-${category}-week`);
    paths.push(`/trending/w/${category}/`);
  } else if (period === 'month') {
    paths.push(`/popular-${category}-week`);
    paths.push(`/popular-${category}`);
    paths.push(`/trending/w/${category}/`);
  } else {
    // all time — use top-100 page
    paths.push(`/top-100-${category}`);
  }
  
  const allResults = [];
  const seenTitles = new Set();
  
  for (const path of paths) {
    try {
      const html = await fetchWithFallback(path);
      const parsed = parse1337xTable(html);
      for (const r of parsed) {
        // Deduplicate by title
        const key = r.title.toLowerCase();
        if (!seenTitles.has(key)) {
          seenTitles.add(key);
          allResults.push(r);
        }
      }
    } catch (e) {
      // If one page fails, continue with others
    }
  }
  
  // Sort by seeders
  allResults.sort((a, b) => b.seeders - a.seeders);
  return allResults.slice(0, 20);
}

// ========== End 1337x Scraper ==========

// ========== Nyaa.si Scraper ==========

function parseNyaaTable(html) {
  const results = [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return results;
  const tbody = tbodyMatch[1];
  const rows = tbody.split(/<tr[\s>]/i).filter(r => r.includes('</tr>'));

  for (const row of rows) {
    try {
      // Title — last <a> in the title column that isn't a comment link
      const titleLinks = [...row.matchAll(/<a[^>]*href="\/view\/(\d+)"[^>]*(?:title="([^"]*)")?[^>]*>([^<]*)<\/a>/gi)];
      const titleLink = titleLinks[titleLinks.length - 1];
      if (!titleLink) continue;
      const title = (titleLink[2] || titleLink[3] || '').trim();
      const viewId = titleLink[1];
      if (!title) continue;

      // Magnet link
      const magnetMatch = row.match(/href="(magnet:\?[^"]+)"/i);
      const magnet = magnetMatch ? magnetMatch[1] : null;

      // Size — typically 3rd or 4th <td>
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      // Nyaa columns: Category, Name, Links, Size, Date, Seeders, Leechers, Downloads
      const sizeStr = tds.find(t => /^\d+(\.\d+)?\s*(GiB|MiB|KiB|TiB|GB|MB|KB|TB)$/i.test(t)) || '';
      const size = parseNyaaSize(sizeStr);

      // Seeders/Leechers — try styled tds first, then fall back to positional
      const seedMatch = row.match(/class="text-success[^"]*"[^>]*>(\d+)<\/td>/i);
      const leechMatch = row.match(/class="text-danger[^"]*"[^>]*>(\d+)<\/td>/i);
      let seeders = seedMatch ? parseInt(seedMatch[1]) : 0;
      let leechers = leechMatch ? parseInt(leechMatch[1]) : 0;

      // Fallback: Nyaa columns are Category, Name, Links, Size, Date, Seeders, Leechers, Downloads
      // Get all numeric-only text-center tds after the date td
      if (seeders === 0 && leechers === 0) {
        const numericTds = [...row.matchAll(/<td[^>]*class="text-center"[^>]*>(\d+)<\/td>/gi)].map(m => parseInt(m[1]));
        // The pattern is: seeders, leechers, downloads (3 consecutive numbers)
        if (numericTds.length >= 2) {
          seeders = numericTds[0];
          leechers = numericTds[1];
        }
      }

      // Date
      const dateMatch = row.match(/data-timestamp="(\d+)"/i);
      const publishDate = dateMatch ? new Date(parseInt(dateMatch[1]) * 1000).toISOString() : null;

      results.push({
        title, seeders, leechers, size, sizeStr,
        publishDate,
        downloadUrl: magnet,
        infoUrl: `https://nyaa.si/view/${viewId}`,
        guid: `nyaa-${viewId}`,
        indexer: 'Nyaa',
        categories: [5070],
        indexerFlags: [],
      });
    } catch (e) { /* skip */ }
  }
  return results;
}

function parseNyaaSize(str) {
  if (!str) return 0;
  const match = str.match(/([\d.]+)\s*(GiB|MiB|KiB|TiB|GB|MB|KB|TB)/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'tib' || unit === 'tb') return num * 1099511627776;
  if (unit === 'gib' || unit === 'gb') return num * 1073741824;
  if (unit === 'mib' || unit === 'mb') return num * 1048576;
  if (unit === 'kib' || unit === 'kb') return num * 1024;
  return 0;
}

async function getNyaaPopular(period) {
  // Nyaa sort options: seeders desc
  // period filter: for day/week/month/all we use different filter params
  // Nyaa filter: f=0 (no filter), c=1_0 (anime - all), s=seeders, o=desc
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  
  let url;
  if (period === 'all') {
    // All time top seeders
    url = 'https://nyaa.si/?f=0&c=1_0&q=&s=seeders&o=desc';
  } else {
    // Nyaa doesn't have day/week/month filters natively, so we search with no query sorted by seeders
    // and filter by date client-side
    url = 'https://nyaa.si/?f=0&c=1_0&q=&s=seeders&o=desc';
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const html = await res.text();
    let results = parseNyaaTable(html);

    // Date-based filtering for day/week/month
    if (period !== 'all' && results.length > 0) {
      const now = Date.now();
      const cutoffs = { day: 86400000, week: 604800000, month: 2592000000 };
      const cutoff = cutoffs[period] || cutoffs.month;
      results = results.filter(r => {
        if (!r.publishDate) return true; // keep if no date info
        return (now - new Date(r.publishDate).getTime()) <= cutoff;
      });
    }

    results.sort((a, b) => b.seeders - a.seeders);
    return results.slice(0, 20);
  } catch (e) {
    console.error('[nyaa] Scrape error:', e.message);
    return [];
  }
}

// ========== End Nyaa Scraper ==========

// ========== Language Filter for Auto-Grab ==========

const FOREIGN_MARKERS = [
  /\bLektor\s*(PL|CZ|HU)\b/i,
  /\bDubbing\s*(PL|CZ|HU)\b/i,
  /\bNapisy\s*PL\b/i,
  /\bTRUEFRENCH\b/i,
  /\bFRENCH\b/i,
  /\bVFF\b/i,
  /\bVFQ\b/i,
  /\bLATINO\b/i,
  /\bSPANISH\b/i,
  /\bGerman\s*DL\b/i,
  /\biTALiAN\b/i,
  /\bRUS(?:\s|$|\b)/i,
  /\bRUSSIAN\b/i,
  /\bHINDI\b/i,
  /\bTAMiL\b/i,
  /\bTELUGU\b/i,
  /\bKOREAN\b/i,
  /\bCHINESE\b/i,
  /\bJAPANESE\b/i,
  /\bARABIC\b/i,
  /\bTURKISH\b/i,
  /\bPOLISH\b/i,
  /\bCZECH\b/i,
  /\bHUNGARIAN\b/i,
  /\bPORTUGUESE\b/i,
  /\bBRAZILIAN\b/i,
  /\bDUTCH\b/i,
  /\bSWEDISH\b/i,
  /\bDANISH\b/i,
  /\bNORWEGIAN\b/i,
  /\bFINNISH\b/i,
  /\bGREEK\b/i,
  /\bHC\b/,
];

const FOREIGN_TITLE_PATTERNS = [
  /^Slepa\s/i, /^La\s\w+\s\//i, /^Le\s\w+\s\//i, /^El\s\w+\s\//i,
  /^Der\s\w+\s\//i, /^Das\s\w+\s\//i, /^Die\s\w+\s\//i,
];

const ENGLISH_MARKERS = [
  /\bENG(?:lish)?\b/i, /\bEnG\b/, /\bDUAL\b/i,
];

function isLikelyEnglish(title) {
  const t = title || '';
  for (const marker of FOREIGN_MARKERS) {
    if (marker.test(t)) {
      if (ENGLISH_MARKERS.some(em => em.test(t))) continue;
      return false;
    }
  }
  for (const pattern of FOREIGN_TITLE_PATTERNS) {
    if (pattern.test(t)) {
      if (!ENGLISH_MARKERS.some(em => em.test(t))) return false;
    }
  }
  return true;
}

function languageScore(title) {
  const t = title || '';
  if (!isLikelyEnglish(t)) return -1;
  let score = 0;
  if (/\bENG(?:lish)?\b/i.test(t) || /\bEnG\b/.test(t)) score += 2;
  if (/\bDUAL\b/i.test(t)) score += 1;
  return score;
}

// ========== End Language Filter ==========

function setupProwlarrRoutes(app, store, auth) {
  app.get('/api/prowlarr/test', auth, async (req, res) => {
    try {
      const data = await prowlarrRequest(store, '/api/v1/system/status');
      res.json({ success: true, version: data.version });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.get('/api/prowlarr/indexers', auth, async (req, res) => {
    try {
      const data = await prowlarrRequest(store, '/api/v1/indexer');
      const indexers = data
        .filter(i => i.enable && i.protocol === 'torrent')
        .map(i => ({ id: i.id, name: i.name, categories: i.capabilities?.categories || [] }));
      res.json({ success: true, indexers });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/prowlarr/search', auth, async (req, res) => {
    try {
      const { query, categories, indexerIds } = req.body;
      const cfg = store.get('prowlarr') || {};
      if (!cfg.url || !cfg.apiKey) throw new Error('Prowlarr not configured');
      const base = cfg.url.replace(/\/$/, '');
      const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };
      
      const idxRes = await fetch(`${base}/api/v1/indexer`, { headers });
      if (!idxRes.ok) throw new Error(`Failed to get indexers: ${idxRes.status}`);
      const allIndexers = await idxRes.json();
      const torrentIndexers = allIndexers.filter(i => i.enable && i.protocol === 'torrent');
      if (!torrentIndexers.length) throw new Error('No enabled torrent indexers found');
      
      // Search 1337x first — its proxy URLs work reliably
      const leet = torrentIndexers.filter(i => /1337/i.test(i.name));
      const others = torrentIndexers.filter(i => !/1337/i.test(i.name) && !/nyaa/i.test(i.name));

      const searchIndexers = async (indexers) => {
        const searches = indexers.map(async (idx) => {
          try {
            const url = `${base}/api/v1/search?query=${encodeURIComponent(query)}&indexerIds=${idx.id}&type=search`;
            const r = await fetch(url, { headers });
            if (!r.ok) return { indexer: idx.name, success: false, results: [] };
            const data = await r.json();
            return { indexer: idx.name, success: true, results: data };
          } catch { return { indexer: idx.name, success: false, results: [] }; }
        });
        return Promise.all(searches);
      };

      // 1337x first
      let outcomes = await searchIndexers(leet);
      let totalResults = outcomes.reduce((sum, o) => sum + o.results.length, 0);
      
      // Fall back to ext.to/others only if 1337x returned nothing
      if (totalResults === 0 && others.length > 0) {
        console.log(`[search] 1337x empty, falling back to: ${others.map(i => i.name).join(', ')}`);
        const fallbackOutcomes = await searchIndexers(others);
        outcomes = outcomes.concat(fallbackOutcomes);
      }

      const indexerStatus = outcomes.map(o => ({ name: o.indexer, success: o.success, count: o.results.length }));
      const allResults = [];
      for (const o of outcomes) {
        for (const r of o.results) {
          let dlUrl = r.downloadUrl || r.magnetUrl || null;
          if (!dlUrl && r.guid && r.guid.startsWith('magnet:')) dlUrl = r.guid;
          allResults.push({
            guid: r.guid, title: r.title, size: r.size,
            seeders: r.seeders || 0, leechers: r.leechers || 0,
            indexer: r.indexer, downloadUrl: dlUrl, infoUrl: r.infoUrl,
            publishDate: r.publishDate,
            imdbId: r.imdbId || null,
            categories: (r.categories || []).map(c => c.id),
            indexerFlags: r.indexerFlags || []
          });
        }
      }
      allResults.sort((a, b) => b.seeders - a.seeders);
      // Filter out non-English results for auto-grab
      const englishResults = allResults.filter(r => isLikelyEnglish(r.title));
      const filteredResults = englishResults.length > 0 ? englishResults : allResults;
      // Sort: English-marked first, then by seeders
      filteredResults.sort((a, b) => {
        const langDiff = languageScore(b.title) - languageScore(a.title);
        if (langDiff !== 0) return langDiff;
        return b.seeders - a.seeders;
      });
      res.json({ success: true, results: filteredResults, indexerStatus });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/prowlarr/browse', auth, async (req, res) => {
    try {
      const { indexerId, category, period } = req.body;
      const cfg = store.get('prowlarr') || {};
      let indexerName = '';
      if (cfg.url && cfg.apiKey) {
        try {
          const base = cfg.url.replace(/\/$/, '');
          const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };
          const idxRes = await fetch(`${base}/api/v1/indexer`, { headers });
          if (idxRes.ok) {
            const allIdx = await idxRes.json();
            const idx = allIdx.find(i => i.id === indexerId);
            if (idx) indexerName = idx.name;
          }
        } catch {}
      }
      
      const is1337x = /1337/i.test(indexerName);
      const isNyaa = /nyaa/i.test(indexerName);

      if (isNyaa) {
        const scraped = await getNyaaPopular(period || 'week');
        return res.json({ success: true, results: scraped });
      }
      
      if (is1337x) {
        const type = category === 5000 ? 'tv' : 'movies';
        const scraped = await get1337xPopular(type, period || 'week');
        const results = [];
        for (const item of scraped) {
          const result = {
            guid: item.infoPath, title: item.title, size: item.size,
            seeders: item.seeders, leechers: item.leechers,
            indexer: '1337x', downloadUrl: null,
            infoUrl: `https://1337x.to${item.infoPath}`,
            publishDate: item.publishDate, timeStr: item.timeStr,
            categories: category === 5000 ? [5000] : [2000], indexerFlags: []
          };
          try {
            const { magnet, imdbId } = await scrape1337xMagnet(item.infoPath);
            if (magnet) result.downloadUrl = magnet;
            if (imdbId) result.imdbId = imdbId;
          } catch {}
          results.push(result);
        }
        return res.json({ success: true, results });
      }
      
      // Fallback: Prowlarr browse
      if (!cfg.url || !cfg.apiKey) throw new Error('Prowlarr not configured');
      const base = cfg.url.replace(/\/$/, '');
      const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };
      const catParam = category ? `&categories=${category}` : '';
      const url = `${base}/api/v1/search?query=&indexerIds=${indexerId}&type=search${catParam}&limit=500`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`Prowlarr returned ${r.status}`);
      const data = await r.json();
      
      let results = data.map(r => {
        let dlUrl = r.downloadUrl || r.magnetUrl || null;
        if (!dlUrl && r.guid && r.guid.startsWith('magnet:')) dlUrl = r.guid;
        return { guid: r.guid, title: r.title, size: r.size, seeders: r.seeders || 0, leechers: r.leechers || 0,
          indexer: r.indexer, downloadUrl: dlUrl, infoUrl: r.infoUrl, publishDate: r.publishDate,
          imdbId: r.imdbId || null,
          categories: (r.categories || []).map(c => c.id), indexerFlags: r.indexerFlags || [] };
      });

      if (period && period !== 'all') {
        const now = Date.now();
        const cutoffs = { day: 86400000, week: 604800000, month: 2592000000 };
        const cutoff = cutoffs[period];
        if (cutoff) results = results.filter(r => r.publishDate && (now - new Date(r.publishDate).getTime()) <= cutoff);
      }
      results.sort((a, b) => b.seeders - a.seeders);
      res.json({ success: true, results: results.slice(0, 100) });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // Resolve magnet link on-demand (for 1337x and other indexers that don't include it in browse)
  app.post('/api/prowlarr/resolve-magnet', auth, async (req, res) => {
    try {
      const { infoUrl, guid, title } = req.body;
      if (!infoUrl && !guid && !title) return res.status(400).json({ error: 'infoUrl, guid, or title required' });

      const cfg = store.get('prowlarr') || {};
      const base = cfg.url ? cfg.url.replace(/\/$/, '') : '';
      const headers = cfg.apiKey ? { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' } : {};

      // Method 1: Search Prowlarr by title and match by guid or closest title
      if (base && cfg.apiKey && (title || guid)) {
        try {
          // Extract a clean search query from the title
          const searchQuery = (title || '').replace(/[\.\-\_\(\)]/g, ' ').replace(/\b(1080p|720p|2160p|x264|x265|HEVC|WEB-DL|WEBRip|BluRay|BRRip|HDRip|NeoNoir|BONE|DDP|AAC|AC3|FLAC|5\.1|10bit|10Bit|REMUX)\b/gi, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
          
          if (searchQuery.length >= 3) {
            const searchUrl = `${base}/api/v1/search?query=${encodeURIComponent(searchQuery)}&type=search&limit=50`;
            const sRes = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(15000) });
            if (sRes.ok) {
              const results = await sRes.json();
              // Try exact guid match first
              let match = guid ? results.find(r => r.guid === guid) : null;
              // Then try title match
              if (!match && title) {
                match = results.find(r => r.title === title);
              }
              // Then try fuzzy title match
              if (!match && title) {
                const lowerTitle = title.toLowerCase();
                match = results.find(r => r.title && r.title.toLowerCase() === lowerTitle);
              }
              if (match) {
                // Only return if it's an actual magnet — Prowlarr proxy URLs expire (410)
                const magnet = match.magnetUrl || (match.guid && match.guid.startsWith('magnet:') ? match.guid : null);
                if (magnet) return res.json({ success: true, downloadUrl: magnet });
                // If it's a 1337x result, scrape the magnet directly
                if ((match.indexer || '').toLowerCase().includes('1337x') && match.infoUrl) {
                  const infoPath = new URL(match.infoUrl).pathname;
                  const { magnet: scrapedMagnet } = await scrape1337xMagnet(infoPath);
                  if (scrapedMagnet) return res.json({ success: true, downloadUrl: scrapedMagnet });
                }
                // Method 3: For non-1337x indexers (ext.to etc), the proxy URL is fresh — fetch it
                // immediately and extract the magnet/torrent before it expires
                if (match.downloadUrl) {
                  try {
                    console.log(`[resolve-magnet] Fetching fresh proxy URL from ${match.indexer}...`);
                    const proxyHeaders = cfg.apiKey ? { 'X-Api-Key': cfg.apiKey } : {};
                    const proxyResp = await fetch(match.downloadUrl, { headers: proxyHeaders, redirect: 'follow', signal: AbortSignal.timeout(30000) });
                    if (proxyResp.ok) {
                      const contentType = proxyResp.headers.get('content-type') || '';
                      const finalUrl = proxyResp.url || match.downloadUrl;
                      if (finalUrl.startsWith('magnet:')) {
                        console.log(`[resolve-magnet] Proxy redirected to magnet`);
                        return res.json({ success: true, downloadUrl: finalUrl });
                      }
                      if (contentType.includes('text/plain') || contentType.includes('text/html')) {
                        const text = await proxyResp.text();
                        if (text.trim().startsWith('magnet:')) {
                          console.log(`[resolve-magnet] Proxy returned magnet in body`);
                          return res.json({ success: true, downloadUrl: text.trim() });
                        }
                      }
                      if (contentType.includes('bittorrent')) {
                        // Got a valid torrent file — return the fresh proxy URL for immediate use
                        console.log(`[resolve-magnet] Proxy returned torrent file, returning fresh URL`);
                        return res.json({ success: true, downloadUrl: match.downloadUrl });
                      }
                    } else {
                      console.log(`[resolve-magnet] Proxy fetch failed: ${proxyResp.status} — indexer ${match.indexer} download broken`);
                    }
                  } catch (proxyErr) {
                    console.log(`[resolve-magnet] Proxy fetch error: ${proxyErr.message}`);
                  }
                  // Proxy URL broken (410 etc) — try to find the same content on a working indexer
                  // Look for any 1337x result in the search results and scrape its magnet
                  console.log(`[resolve-magnet] Falling back to 1337x scrape for any matching result...`);
                  const leet1337 = results.find(r => (r.indexer || '').toLowerCase().includes('1337x') && r.infoUrl);
                  if (leet1337) {
                    try {
                      const infoPath = new URL(leet1337.infoUrl).pathname;
                      const { magnet: scrapedMagnet } = await scrape1337xMagnet(infoPath);
                      if (scrapedMagnet) {
                        console.log(`[resolve-magnet] Got magnet from 1337x fallback: ${leet1337.title}`);
                        return res.json({ success: true, downloadUrl: scrapedMagnet, fallbackTitle: leet1337.title });
                      }
                    } catch (e) {
                      console.log(`[resolve-magnet] 1337x fallback scrape failed: ${e.message}`);
                    }
                  }
                  // Last resort: try fetching from a working 1337x proxy URL
                  const leet1337dl = results.find(r => (r.indexer || '').toLowerCase().includes('1337x') && r.downloadUrl);
                  if (leet1337dl) {
                    try {
                      console.log(`[resolve-magnet] Trying 1337x proxy URL for: ${leet1337dl.title}`);
                      const proxyHeaders2 = cfg.apiKey ? { 'X-Api-Key': cfg.apiKey } : {};
                      const proxyResp2 = await fetch(leet1337dl.downloadUrl, { headers: proxyHeaders2, redirect: 'follow', signal: AbortSignal.timeout(15000) });
                      if (proxyResp2.ok) {
                        console.log(`[resolve-magnet] 1337x proxy works, returning URL`);
                        return res.json({ success: true, downloadUrl: leet1337dl.downloadUrl, fallbackTitle: leet1337dl.title });
                      }
                    } catch (e) {
                      console.log(`[resolve-magnet] 1337x proxy failed: ${e.message}`);
                    }
                  }
                }
              }
              // No magnet found via search — try all 1337x results
              const leet = results.find(r => (r.indexer || '').toLowerCase().includes('1337x') && r.infoUrl);
              if (leet) {
                const infoPath = new URL(leet.infoUrl).pathname;
                const { magnet: scrapedMagnet } = await scrape1337xMagnet(infoPath);
                if (scrapedMagnet) return res.json({ success: true, downloadUrl: scrapedMagnet });
              }
            }
          }
        } catch (e) {
          console.log('[resolve-magnet] Prowlarr search failed:', e.message);
        }
      }

      // Method 2: Try 1337x direct scrape (may fail due to Cloudflare)
      const path = infoUrl || guid || '';
      if (path.includes('1337x') || path.startsWith('/torrent/')) {
        const infoPath = path.startsWith('http') ? new URL(path).pathname : path;
        const { magnet } = await scrape1337xMagnet(infoPath);
        if (magnet) return res.json({ success: true, downloadUrl: magnet });
      }

      res.status(404).json({ error: 'Could not resolve download URL' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { setupProwlarrRoutes };
