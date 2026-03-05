// ═══════════════════════════════════════════════════════════════════
// qBittorrent Handler — REST API version
// ═══════════════════════════════════════════════════════════════════

let sessionCookie = null;

async function qbitRequest(store, endpoint, method = 'GET', body = null) {
  const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
  if (!sessionCookie) {
    const r = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
    if (r.ok) { const c = r.headers.get('set-cookie'); if (c) sessionCookie = c.split(';')[0]; }
    else throw new Error('qBittorrent login failed');
  }
  const opts = { method, headers: { 'Cookie': sessionCookie || '' } };
  if (body) { opts.body = body; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const r = await fetch(`${base}${endpoint}`, opts);
  if (r.status === 403) { sessionCookie = null; return qbitRequest(store, endpoint, method, body); }
  return r;
}

async function addAndDetect(store, url, searchName) {
  try {
    const beforeR = await qbitRequest(store, '/api/v2/torrents/info');
    const beforeTs = await beforeR.json();
    const beforeHashes = new Set(beforeTs.map(t => t.hash));

    let addBody, addContentType;
    if (url.startsWith('magnet:')) {
      addBody = `urls=${encodeURIComponent(url)}`;
      addContentType = 'application/x-www-form-urlencoded';
    } else {
      console.log(`[addAndDetect] Downloading torrent from: ${url}`);
      const prowlarrCfg = store.get('prowlarr') || {};
      const headers = {};
      if (prowlarrCfg.apiKey) headers['X-Api-Key'] = prowlarrCfg.apiKey;

      let torrentResp;
      try {
        torrentResp = await fetch(url, { headers, redirect: 'follow' });
      } catch (fetchErr) {
        console.log(`[addAndDetect] Fetch error: ${fetchErr.message}`);
        const s2 = store.get('seedbox'), base2 = s2.qbitUrl.replace(/\/$/, '');
        if (!sessionCookie) {
          const lr2 = await fetch(`${base2}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `username=${encodeURIComponent(s2.qbitUsername)}&password=${encodeURIComponent(s2.qbitPassword)}` });
          if (lr2.ok) { const c = lr2.headers.get('set-cookie'); if (c) sessionCookie = c.split(';')[0]; }
        }
        const directR = await fetch(`${base2}/api/v2/torrents/add`, {
          method: 'POST',
          headers: { 'Cookie': sessionCookie || '', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `urls=${encodeURIComponent(url)}`
        });
        if (!directR.ok) throw new Error('Could not download torrent file and qBit also rejected URL');
        addBody = null;
        addContentType = null;
      }

      if (torrentResp) {
        if (!torrentResp.ok) {
          // On 410 (expired link), try to re-fetch a fresh URL from Prowlarr by searching for the torrent name
          if (torrentResp.status === 410 && searchName) {
            console.log(`[addAndDetect] 410 expired link, re-searching Prowlarr for: ${searchName}`);
            try {
              const prowlarrCfg = store.get('prowlarr') || {};
              const prowlarrBase = (prowlarrCfg.url || '').replace(/\/$/, '');
              const searchHeaders = { 'X-Api-Key': prowlarrCfg.apiKey, 'Accept': 'application/json' };
              const searchUrl = `${prowlarrBase}/api/v1/search?query=${encodeURIComponent(searchName)}&type=search&limit=20`;
              const searchResp = await fetch(searchUrl, { headers: searchHeaders });
              if (searchResp.ok) {
                const results = await searchResp.json();
                // Find closest title match
                const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
                const target = norm(searchName);
                const match = results.find(r => norm(r.title) === target) || results[0];
                if (match && (match.downloadUrl || match.magnetUrl || (match.guid && match.guid.startsWith('magnet:')))) {
                  const freshUrl = match.downloadUrl || match.magnetUrl || match.guid;
                  console.log(`[addAndDetect] Got fresh URL, retrying...`);
                  torrentResp = await fetch(freshUrl, { headers, redirect: 'follow' });
                }
              }
            } catch (retryErr) {
              console.log(`[addAndDetect] Re-search failed: ${retryErr.message}`);
            }
          }
          if (!torrentResp.ok) throw new Error(`Prowlarr returned ${torrentResp.status} downloading torrent`);
        }
        const contentType = torrentResp.headers.get('content-type') || '';
        const finalUrl = torrentResp.url || url;

        if (finalUrl.startsWith('magnet:')) {
          addBody = `urls=${encodeURIComponent(finalUrl)}`;
          addContentType = 'application/x-www-form-urlencoded';
        } else if (contentType.includes('text/plain') || contentType.includes('text/html')) {
          const text = await torrentResp.text();
          if (text.trim().startsWith('magnet:')) {
            addBody = `urls=${encodeURIComponent(text.trim())}`;
            addContentType = 'application/x-www-form-urlencoded';
          } else {
            throw new Error(`Expected torrent file but got ${contentType}`);
          }
        } else {
          const torrentBuf = Buffer.from(await torrentResp.arrayBuffer());
          const boundary = '----MediaManager' + Date.now();
          const header = `--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`;
          addBody = Buffer.concat([Buffer.from(header), torrentBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
          addContentType = `multipart/form-data; boundary=${boundary}`;
        }
      }
    }

    if (addBody !== null && addBody !== undefined) {
      const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
      if (!sessionCookie) {
        const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
        if (lr.ok) { const c = lr.headers.get('set-cookie'); if (c) sessionCookie = c.split(';')[0]; }
      }
      const addR = await fetch(`${base}/api/v2/torrents/add`, {
        method: 'POST',
        headers: { 'Cookie': sessionCookie || '', 'Content-Type': addContentType },
        body: addBody
      });
      if (!addR.ok) return { success: false, error: `qBittorrent rejected torrent: ${addR.status}` };
    }

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const afterR = await qbitRequest(store, '/api/v2/torrents/info');
      const afterTs = await afterR.json();
      const newT = afterTs.find(t => !beforeHashes.has(t.hash));
      if (newT) {
        console.log(`[addAndDetect] Found new torrent: "${newT.name}" hash=${newT.hash}`);
        return { success: true, hash: newT.hash, name: newT.name };
      }
    }

    if (searchName) {
      const norm = (s) => s.toLowerCase().replace(/[\.\-\_\(\)\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const sn = norm(searchName);
      const finalR = await qbitRequest(store, '/api/v2/torrents/info');
      const finalTs = await finalR.json();
      let match = finalTs.find(t => norm(t.name) === sn);
      if (!match) {
        const sw = sn.split(' ').filter(w => w.length > 1).slice(0, 5).join(' ');
        match = finalTs.find(t => norm(t.name).split(' ').filter(w => w.length > 1).slice(0, 5).join(' ') === sw);
      }
      if (!match) {
        const sw3 = sn.split(' ').filter(w => w.length > 1).slice(0, 3).join(' ');
        match = finalTs.find(t => norm(t.name).split(' ').filter(w => w.length > 1).slice(0, 3).join(' ') === sw3);
      }
      if (match) {
        console.log(`[addAndDetect] Duplicate found by name: "${match.name}" hash=${match.hash}`);
        return { success: true, hash: match.hash, name: match.name };
      }
    }

    return { success: true, hash: null, name: null };
  } catch (e) { return { success: false, error: e.message }; }
}

function setupQbitRoutes(app, store, auth) {
  app.get('/api/qbit/test', auth, async (req, res) => {
    try { sessionCookie = null; const r = await qbitRequest(store, '/api/v2/app/version'); res.json({ success: true, version: await r.text() }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.get('/api/qbit/torrents', auth, async (req, res) => {
    try { const f = req.query.filter || 'all'; const r = await qbitRequest(store, `/api/v2/torrents/info?filter=${f}`); res.json({ success: true, torrents: await r.json() }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/qbit/add', auth, async (req, res) => {
    try {
      const { url } = req.body;
      if (url.startsWith('magnet:')) {
        const r = await qbitRequest(store, '/api/v2/torrents/add', 'POST', `urls=${encodeURIComponent(url)}`);
        return res.json({ success: r.ok });
      }
      const torrentResp = await fetch(url);
      if (!torrentResp.ok) throw new Error(`Failed to download torrent: ${torrentResp.status}`);
      const torrentBuf = Buffer.from(await torrentResp.arrayBuffer());
      const boundary = '----MediaManager' + Date.now();
      const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`];
      const body = Buffer.concat([Buffer.from(parts[0]), torrentBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
      if (!sessionCookie) {
        const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
        if (lr.ok) { const c = lr.headers.get('set-cookie'); if (c) sessionCookie = c.split(';')[0]; }
      }
      const r = await fetch(`${base}/api/v2/torrents/add`, {
        method: 'POST', headers: { 'Cookie': sessionCookie || '', 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body
      });
      res.json({ success: r.ok });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/qbit/addAndDetect', auth, async (req, res) => {
    const { url, searchName } = req.body;
    const result = await addAndDetect(store, url, searchName);
    res.json(result);
  });

  app.post('/api/qbit/pause', auth, async (req, res) => {
    try { await qbitRequest(store, '/api/v2/torrents/pause', 'POST', `hashes=${req.body.hash}`); res.json({ success: true }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/qbit/resume', auth, async (req, res) => {
    try { await qbitRequest(store, '/api/v2/torrents/resume', 'POST', `hashes=${req.body.hash}`); res.json({ success: true }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/qbit/delete', auth, async (req, res) => {
    try { const df = req.body.deleteFiles !== false; await qbitRequest(store, '/api/v2/torrents/delete', 'POST', `hashes=${req.body.hash}&deleteFiles=${df}`); res.json({ success: true }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/qbit/setCategory', auth, async (req, res) => {
    try {
      const { hash, category } = req.body;
      if (category) await qbitRequest(store, '/api/v2/torrents/createCategory', 'POST', `category=${encodeURIComponent(category)}&savePath=`);
      await qbitRequest(store, '/api/v2/torrents/setCategory', 'POST', `hashes=${hash}&category=${encodeURIComponent(category || '')}`);
      res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.get('/api/qbit/files/:hash', auth, async (req, res) => {
    try { const r = await qbitRequest(store, `/api/v2/torrents/files?hash=${req.params.hash}`); res.json({ success: true, files: await r.json() }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });
}

module.exports = { setupQbitRoutes, qbitRequest, addAndDetect };
