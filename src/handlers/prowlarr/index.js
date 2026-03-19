// ═══════════════════════════════════════════════════════════════════
// Prowlarr/Hunterr Handler — indexer API routes, backend detection
// Refactored: scraper logic extracted into scraper-1337x.js + scraper-nyaa.js
// ═══════════════════════════════════════════════════════════════════

const { isLikelyEnglish } = require('media-manager-shared');
const { scrape1337xMagnet, get1337xPopular } = require('./scraper-1337x');
const { getNyaaPopular } = require('./scraper-nyaa');

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

async function searchViaHunterr(store, query, pri, exclusive) {
  const d = await indexerRequest(store, '/api/search', { method:'POST', body:{query, primaryIndexer:pri||null, exclusiveIndexer:!!exclusive} });
  if (!d.success) throw new Error(d.error||'Search failed');
  return { results: (d.results||[]).map(r=>({guid:r.id||r.guid,title:r.title,size:r.size||0,seeders:r.seeders||0,leechers:r.leechers||0,indexer:r.indexer,downloadUrl:r.magnetUrl||null,infoUrl:r.infoUrl,publishDate:r.publishDate||null,imdbId:r.imdbId||null,categories:r.category?[r.category]:[],indexerFlags:[]})), indexerStatus:d.indexerStatus||[] };
}

async function searchViaProwlarr(store, query, searchType, primaryIndexerName, exclusive) {
  const cfg = store.get('prowlarr')||{}; const base = cfg.url.replace(/\/$/, '');
  const h = {'Accept':'application/json'}; if (cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
  const ir = await fetch(base+'/api/v1/indexer',{headers:h}); if (!ir.ok) throw new Error('Indexers: '+ir.status);
  const all = await ir.json(); const ti = all.filter(i=>i.enable&&i.protocol==='torrent');
  if (!ti.length) throw new Error('No enabled torrent indexers');
  let pri, others;
  if (exclusive && primaryIndexerName) {
    const match = ti.find(i => i.name.toLowerCase().includes(primaryIndexerName.toLowerCase()));
    pri = match ? [match] : ti;
    others = [];
  } else {
    const leet = ti.find(i=>i.name.toLowerCase().includes('1337x'));
    others = ti.filter(i=>!i.name.toLowerCase().includes('1337x'));
    pri = leet ? [leet] : ti;
  }
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

// ========== Language Filter ==========

function languageScore(title) {
  const t = title || '';
  if (!isLikelyEnglish(t)) return -1;
  let score = 0;
  if (/\bENG(?:lish)?\b/i.test(t) || /\bEnG\b/.test(t)) score += 2;
  if (/\bDUAL\b/i.test(t)) score += 1;
  return score;
}

// ========== Routes ==========

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

      const backend = await detectBackend(store);
      let searchResult;
      if (backend === 'hunterr') {
        searchResult = await searchViaHunterr(store, query, primaryIndexer || cfg.primaryIndexer, req.body.exclusiveIndexer);
      } else {
        searchResult = await searchViaProwlarr(store, query, null, primaryIndexer, req.body.exclusiveIndexer);
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

  // Resolve magnet link on-demand
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

      // Method 2: Try 1337x direct scrape
      const pathStr = infoUrl || guid || '';
      if (pathStr.includes('1337x') || pathStr.startsWith('/torrent/')) {
        const infoPath = pathStr.startsWith('http') ? new URL(pathStr).pathname : pathStr;
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
