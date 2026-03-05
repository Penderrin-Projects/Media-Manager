// ═══════════════════════════════════════════════════════════════════
// Plex Duplicate Check Handler
// ═══════════════════════════════════════════════════════════════════

const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function plexSearch(title, type, year, cfg) {
  const plexUrl = cfg?.url;
  const plexToken = cfg?.token;
  if (!plexUrl || !plexToken) return null; // not configured

  try {
    const base = plexUrl.replace(/\/$/, '');
    const url = `${base}/hubs/search?query=${encodeURIComponent(title)}&X-Plex-Token=${plexToken}&limit=10`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();

    const hubs = data.MediaContainer?.Hub || [];
    const targetTypes = type === 'tv' ? ['show'] : ['movie'];
    const searchNorm = normalize(title);
    const searchYear = year ? parseInt(year) : null;

    for (const hub of hubs) {
      if (!targetTypes.includes(hub.type)) continue;
      for (const item of hub.Metadata || []) {
        if (normalize(item.title) !== searchNorm) continue;
        if (searchYear && item.year && item.year !== searchYear) continue;
        return { found: true, title: item.title, year: item.year, type: hub.type };
      }
    }
    return { found: false };
  } catch (e) {
    console.error('[plex] Search error:', e.message);
    return null;
  }
}

function setupPlexRoutes(app, store, auth, getPipelineJobs) {
  // Check if title already exists in Plex library
  app.get('/api/plex/check', auth, async (req, res) => {
    try {
      const { title, type, year } = req.query;
      if (!title) return res.status(400).json({ error: 'Title required' });
      const cfg = store.get('plex') || {};
      console.log('[plex] check called, cfg:', JSON.stringify(cfg), 'title:', title);
      const result = await plexSearch(title, type || 'movie', year, cfg);
      if (result === null) return res.json({ configured: false });
      res.json({ configured: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Check if title is already in the active pipeline queue
  app.get('/api/plex/queue-check', auth, (req, res) => {
    try {
      const { title, type, year } = req.query;
      if (!title) return res.status(400).json({ error: 'Title required' });
      const jobs = getPipelineJobs().filter(j => !['done', 'failed', 'cancelled'].includes(j.status));
      const reqNorm = normalize(title);
      for (const job of jobs) {
        const jobNorm = normalize(job.name);
        if (!jobNorm.includes(reqNorm)) continue;
        if (year && !jobNorm.includes(String(year))) continue;
        return res.json({ found: true, jobName: job.name, jobStatus: job.status });
      }
      res.json({ found: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { setupPlexRoutes, plexSearch };
