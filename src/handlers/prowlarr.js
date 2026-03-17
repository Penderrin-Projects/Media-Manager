// ========== Backend Detection ==========
let _backendType = null;

async function detectBackend(store) {
  if (_backendType) return _backendType;
  const cfg = store.get('prowlarr') || {};
  if (!cfg.url) throw new Error('Indexer not configured');
  const base = cfg.url.replace(/\/$/, '');
  try {
    const r = await fetch(base + '/api/indexers', { headers: {'Accept':'application/json'}, signal: AbortSignal.timeout(5000) });
    if (r.ok) { const d = await r.json(); if (d.indexers || d.success !== undefined) { _backendType = 'hunterr'; console.log('[backend] Hunterr at ' + base); return 'hunterr'; } }
  } catch {}
  try {
    const h = {'Accept':'application/json'}; if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
    const r = await fetch(base + '/api/v1/indexer', { headers: h, signal: AbortSignal.timeout(5000) });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d)) { _backendType = 'prowlarr'; console.log('[backend] Prowlarr at ' + base); return 'prowlarr'; } }
  } catch {}
  throw new Error('Cannot detect indexer at ' + base);
}
function resetBackendDetection() { _backendType = null; }

async function indexerRequest(store, endpoint, options = {}) {
  const cfg = store.get('prowlarr') || {};
  if (!cfg.url) throw new Error('Indexer not configured');
  const base = cfg.url.replace(/\/$/, '');
  const h = {'Accept':'application/json'}; if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
  if (options.body) h['Content-Type'] = 'application/json';
  const r = await fetch(base + endpoint, { method: options.method||'GET', headers: h, ...(options.body ? {body:JSON.stringify(options.body)} : {}) });
  if (!r.ok) throw new Error('Indexer ' + r.status + ': ' + r.statusText);
  return r.json();
}

async function searchViaHunterr(store, query, pri) {
  const d = await indexerRequest(store, '/api/search', { method:'POST', body:{query, primaryIndexer:pri||null} });
  if (!d.success) throw new Error(d.error||'Search failed');
  return { results: (d.results||[]).map(r=>({guid:r.id||r.guid,title:r.title,size:r.size||0,seeders:r.seeders||0,leechers:r.leechers||0,indexer:r.indexer,downloadUrl:r.magnetUrl||null,infoUrl:r.infoUrl,publishDate:r.publishDate||null,imdbId:r.imdbId||null,categories:r.category?[r.category]:[],indexerFlags:[]})), indexerStatus:d.indexerStatus||[] };
}

async function searchViaProwlarr(store, query, searchType) {
  const cfg = store.get('prowlarr')||{}; const base = cfg.url.replace(/\/$/, '');
  const h = {'Accept':'application/json'}; if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
  const ir = await fetch(base+'/api/v1/indexer',{headers:h}); if (!ir.ok) throw new Error('Indexers: '+ir.status);
  const all = await ir.json(); const ti = all.filter(i=>i.enable&&i.protocol==='torrent');
  if (!ti.length) throw new Error('No enabled torrent indexers');
  const leet = ti.find(i=>i.name.toLowerCase().includes('1337x'));
  const others = ti.filter(i=>!i.name.toLowerCase().includes('1337x'));
  const pri = leet ? [leet] : ti;
  const doSearch = async (idxs) => {
    const ps = idxs.map(async idx => {
      try { const r = await fetch(base+'/api/v1/search?query='+encodeURIComponent(query)+'&indexerIds='+idx.id+'&type='+(searchType||'search'),{headers:h}); return r.ok ? await r.json() : []; } catch { return []; }
    });
    return (await Promise.all(ps)).flat();
  };
  let raw = await doSearch(pri);
  if (!raw.length && others.length) raw = await doSearch(others);
  const results = raw.map(r => { let dl=r.downloadUrl||r.magnetUrl||null; if(!dl&&r.guid&&r.guid.startsWith('magnet:'))dl=r.guid; return {guid:r.guid,title:r.title,size:r.size,seeders:r.seeders||0,leechers:r.leechers||0,indexer:r.indexer,downloadUrl:dl,infoUrl:r.infoUrl||null,publishDate:r.publishDate,categories:(r.categories||[]).map(x=>typeof x==='object'?x.id:x),indexerFlags:[]}; });
  results.sort((a,b)=>b.seeders-a.seeders);
  return { results, indexerStatus:[] };
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
      const data = await indexerRequest(store, '/api/indexers');
      const indexerCount = data.indexers ? data.indexers.length : 0;
      res.json({ success: true, version: `Hunterr (${indexerCount} indexers)` });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.get('/api/prowlarr/indexers', auth, async (req, res) => {
    try {
      const data = await indexerRequest(store, '/api/indexers');
      const indexers = (data.indexers || [])
        .filter(i => i.enabled !== false)
        .map(i => ({ id: i.id, name: i.name, categories: i.categories || [] }));
      res.json({ success: true, indexers });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/prowlarr/search', auth, async (req, res) => {
    try {
      const { query, categories, indexerIds, primaryIndexer } = req.body;
      const cfg = store.get('prowlarr') || {};
      if (!cfg.url) throw new Error('Indexer not configured — set the URL in Settings');

      // Hunterr handles primary/fallback indexer logic internally
      const backend = await detectBackend(store);
      let searchResult;
      if (backend === 'hunterr') {
        searchResult = await searchViaHunterr(store, query, primaryIndexer || cfg.primaryIndexer);
      } else {
        searchResult = await searchViaProwlarr(store, query);
      }
      const allResults = searchResult.results;

      // Filter out non-English results for auto-grab
      const englishResults = allResults.filter(r => isLikelyEnglish(r.title));
      const filteredResults = englishResults.length > 0 ? englishResults : allResults;
      // Sort: English-marked first, then by seeders
      filteredResults.sort((a, b) => {
        const langDiff = languageScore(b.title) - languageScore(a.title);
        if (langDiff !== 0) return langDiff;
        return b.seeders - a.seeders;
      });
      const indexerStatus = searchResult.indexerStatus || [];
      res.json({ success: true, results: filteredResults, indexerStatus });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/prowlarr/browse', auth, async (req, res) => {
    try {
      const { indexerId, category, period } = req.body;
      const cfg = store.get('prowlarr') || {};

      // Determine indexer name for direct scraping fallbacks
      let indexerName = indexerId || '';
      if (cfg.url) {
        try {
          const idxData = await indexerRequest(store, '/api/indexers');
          const idx = (idxData.indexers || []).find(i => i.id === indexerId);
          if (idx) indexerName = idx.name || idx.id;
        } catch {}
      }
      
      const is1337x = /1337/i.test(indexerName);
      const isNyaa = /nyaa/i.test(indexerName);

      if (isNyaa) {
        const scraped = await getNyaaPopular(period || 'week');
        return res.json({ success: true, results: scraped });
      }

      // Try Hunterr browse API first
      if (cfg.url) {
        try {
          const type = category === 5000 ? 'tv' : 'movies';
          const data = await indexerRequest(store, `/api/browse/${encodeURIComponent(indexerId)}?category=${type}&period=${period || 'week'}`);
          if (data.success && data.results && data.results.length > 0) {
            const results = data.results.map(r => ({
              guid: r.id || r.guid, title: r.title, size: r.size || 0,
              seeders: r.seeders || 0, leechers: r.leechers || 0,
              indexer: r.indexer || indexerName, downloadUrl: r.magnetUrl || null,
              infoUrl: r.infoUrl,
              publishDate: r.publishDate || null, timeStr: r.timeStr || null,
              imdbId: r.imdbId || null,
              categories: category ? [category] : [], indexerFlags: []
            }));
            return res.json({ success: true, results });
          }
        } catch (e) {
          console.log(`[browse] Hunterr browse failed for ${indexerId}: ${e.message}, trying direct scrape...`);
        }
      }
      
      // Fallback: direct 1337x scraping
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

      throw new Error('No browse results available');
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // Resolve magnet link on-demand (for 1337x and other indexers that don't include it in browse)
  app.post('/api/prowlarr/resolve-magnet', auth, async (req, res) => {
    try {
      const { infoUrl, guid, title } = req.body;
      if (!infoUrl && !guid && !title) return res.status(400).json({ error: 'infoUrl, guid, or title required' });

      const cfg = store.get('prowlarr') || {};

      // Method 1: Use Hunterr's resolve API
      if (cfg.url && (guid || title)) {
        try {
          const data = await indexerRequest(store, '/api/resolve', {
            method: 'POST',
            body: { indexerId: null, dataId: guid, title, guid, infoUrl }
          });
          if (data.success && data.magnetUrl) {
            return res.json({ success: true, downloadUrl: data.magnetUrl });
          }
        } catch (e) {
          console.log('[resolve-magnet] Hunterr resolve failed:', e.message);
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
