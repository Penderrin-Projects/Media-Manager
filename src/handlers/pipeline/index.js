// ═══════════════════════════════════════════════════════════════════
// Pipeline Handler — Job orchestration, route setup, WebSocket broadcast
// Refactored: step logic extracted into pipeline/steps/*.js
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

const { saveQueue, restoreQueue } = require('./persistence');
const { stepTorrent } = require('./steps/torrent');
const { stepTransfer } = require('./steps/transfer');
const { stepRename } = require('./steps/rename');
const { stepMove } = require('./steps/move');

let jobs = [];
let jobId = 1;
let _store = null;
let _broadcast = null;

// ========== Serialization ==========

function serializeJob(j) {
  return { id: j.id, name: j.name, status: j.status, step: j.step,
    error: j.error, progress: j.progress, options: { ...j.options },
    transferDetail: j.transferDetail || null,
    parallelTransfers: j.parallelTransfers || null,
    renamePreview: j.renamePreview || null,
    torrentFiles: j.torrentFiles || null };
}

function broadcast() {
  const d = { jobs: jobs.map(serializeJob) };
  if (_broadcast) _broadcast('pipeline:update', d);
  saveQueue(jobs, jobId, _store);
}

// ========== Preview functions (built-in renamer) ==========

let _buildRenamePlan, _executeRenames, _tmdbSearchApi, _cleanForSearch, _parseMediaFilename;

function cleanName(name) {
  return name.replace(/\.\w{2,4}$/, '').replace(/[\.\-\_]/g, ' ')
    .replace(/\[.*?\]/g, '')
    .replace(/\((\d{4})\)/g, '$1')
    .replace(/\b(720p|1080p|2160p|4k|uhd|bluray|bdrip|brrip|webrip|web|dl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|atmos|dts|remux|proper|repack|internal|dubbed|subbed|multi|10bit|hdr|sdr|ddp|dv|dovi|5\.1)\b/gi, '')
    .replace(/\b(NeoNoir|NTb|FLUX|SPARKS|RARBG|YTS|YIFY|FGT|EVO|AMIABLE|TERRi|MeGusta|ION10|SUCCESSORS|EDITH|CAKES|TGx|MIXED|ETHEL)\b/gi, '')
    .replace(/\b(Season|S)\s*\d+/gi, '').replace(/\bS\d{2}E\d{2}\b/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
}

async function generatePreview(job, store, filenames) {
  const apiKey = store.get('tmdb.apiKey') || '';
  if (!apiKey) { console.log('[preview] No TMDB API key'); job.renamePreview = null; return; }

  if (filenames && filenames.length > 0) {
    const tmpDir = path.join(require('os').tmpdir(), `mm-preview-${job.id}`);
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const dummy = Buffer.alloc(1024);
      for (const fn of filenames) {
        const base = path.basename(fn);
        const fp = path.join(tmpDir, base);
        if (!fs.existsSync(fp)) fs.writeFileSync(fp, dummy);
      }
      console.log('[preview] Built temp dir with', filenames.length, 'files, type:', job.options.renameType);
      const plan = await _buildRenamePlan(tmpDir, job.options.renameType || 'movie', apiKey, job.options.renameQuery || null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (plan.length > 0) {
        job.renamePreview = plan.map(p => ({ from: p.fromDisplay, to: p.toDisplay }));
        console.log('[preview] Got', plan.length, 'rename previews from file parsing');
        return;
      }
      console.log('[preview] buildRenamePlan returned empty — falling back to name search');
    } catch (e) {
      console.log('[preview] buildRenamePlan error:', e.message);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Fallback: name-based TMDB search for a preview label
  const query = job.options.renameQuery || _cleanForSearch(job.name);
  console.log('[preview] Fallback TMDB search for:', query, 'type:', job.options.renameType);
  try {
    const type = job.options.renameType === 'tv' ? 'tv' : 'movie';
    const results = await _tmdbSearchApi(apiKey, query, type, null);
    if (results.length > 0) {
      const m = results[0];
      const label = m.year ? `${m.title} (${m.year})` : m.title;
      job.renamePreview = [{ from: job.name, to: label + ' (full preview after transfer)' }];
      console.log('[preview] Fallback matched:', label);
    } else {
      console.log('[preview] Fallback: no TMDB results');
      job.renamePreview = null;
    }
  } catch (e) { console.log('[preview] Fallback error:', e.message); job.renamePreview = null; }
}

async function previewFromStaging(job, store) {
  const apiKey = store.get('tmdb.apiKey') || '';
  const sp = job.options.stagingPath || store.get('paths.staging');
  if (!sp || !fs.existsSync(sp) || !apiKey) { job.renamePreview = null; return; }
  try {
    const plan = await _buildRenamePlan(sp, job.options.renameType || 'movie', apiKey, job.options.renameQuery || null);
    job.renamePreview = plan.length > 0 ? plan.map(p => ({ from: p.fromDisplay, to: p.toDisplay })) : null;
  } catch (e) { job.renamePreview = null; }
}

// ========== Job processor ==========

let _addAndDetect, _qbitRequest;

async function processJob(job, store) {
  try {
    const steps = [];
    if (job.options.grabUrl) steps.push('grabbing');
    if (job.options.torrentHash || job.options.grabUrl) steps.push('waiting_torrent');
    if (job.options.directToPC) {
      steps.push('waiting_pc_transfer');
      steps.push('pc_cleanup');
    } else {
      if (job.options.doTransfer) steps.push('transferring');
      if (job.options.doRename) steps.push('renaming');
      if (job.options.doMove) steps.push('moving');
    }

    // When retrying, skip steps before the failed step
    let startIdx = 0;
    if (job.step) {
      const failedIdx = steps.indexOf(job.step);
      if (failedIdx >= 0) startIdx = failedIdx;
    }

    for (let i = startIdx; i < steps.length; i++) {
      const step = steps[i];
      if (job.status === 'cancelled') return;
      job.step = step; job.status = 'running'; job.progress = ''; broadcast();
      if (step === 'waiting_pc_transfer') {
        job.progress = 'Waiting for desktop client to pull files from seedbox...';
        broadcast();
        while (job.status === 'running' && job.step === 'waiting_pc_transfer') {
          await new Promise(r => setTimeout(r, 2000));
        }
        if (job.status === 'cancelled') return;
        continue;
      } else if (step === 'grabbing') {
        job.progress = 'Adding torrent to qBittorrent...';
        broadcast();
        const result = await _addAndDetect(store, job.options.grabUrl, job.name);
        if (!result.success) throw new Error('Failed to add torrent: ' + (result.error || 'Unknown'));
        if (!result.hash) throw new Error('Torrent added but could not detect hash in qBittorrent');
        job.options.torrentHash = result.hash;
        job.name = result.name || job.name;
        if (job.options.longSeed && result.hash) {
          try {
            await _qbitRequest(store, '/api/v2/torrents/createCategory', 'POST', 'category=Long%20Seed&savePath=');
            await _qbitRequest(store, '/api/v2/torrents/setCategory', 'POST', `hashes=${result.hash}&category=Long%20Seed`);
            console.log(`[pipeline] Set Long Seed: ${result.hash}`);
          } catch (e) { console.log('[pipeline] Failed to set Long Seed:', e.message); }
        }
        const s = store.get('seedbox');
        const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : (s.localDownloadPath || '');
        if (sftpBase && result.hash) {
          try {
            const tInfo = await _qbitRequest(store, `/api/v2/torrents/info?hashes=${result.hash}`);
            const tData = JSON.parse(tInfo);
            if (tData.length && tData[0].content_path) {
              const savePath = (tData[0].save_path || '').replace(/\/$/, '');
              if (savePath && tData[0].content_path.startsWith(savePath)) {
                const relative = tData[0].content_path.slice(savePath.length).replace(/^\//, '');
                job.options.remotePath = `${sftpBase}/${relative}`;
              } else {
                job.options.remotePath = `${sftpBase}/${tData[0].name}`;
              }
              console.log(`[pipeline] Remote path from content_path: ${job.options.remotePath}`);
            } else {
              job.options.remotePath = `${sftpBase}/${job.name}`;
            }
          } catch (e) {
            console.log('[pipeline] Could not query content_path, using name:', e.message);
            job.options.remotePath = `${sftpBase}/${job.name}`;
          }
        }
        job.progress = `Torrent added: ${job.name}`;
        broadcast();
      } else if (step === 'waiting_torrent') {
        let done = false;
        while (!done && job.status !== 'cancelled') {
          done = await stepTorrent(job, store, broadcast, { generatePreview });
          if (!done) { broadcast(); await new Promise(r => setTimeout(r, 10000)); }
        }
        if (job.status === 'cancelled') return;
        if (!job.options.remotePath) {
          const s = store.get('seedbox');
          const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : (s.localDownloadPath || '');
          if (!sftpBase) throw new Error('SFTP Remote Path not configured in Settings');
          job.options.remotePath = `${sftpBase}/${job.name}`;
        }
      } else if (step === 'transferring') {
        await stepTransfer(job, store, broadcast, {});
        if (job.options.doRename) { await previewFromStaging(job, store); broadcast(); }
      } else if (step === 'renaming') {
        await stepRename(job, store, broadcast, { buildRenamePlan: _buildRenamePlan, executeRenames: _executeRenames });
        job.renamePreview = null;
      } else if (step === 'moving') {
        await stepMove(job, store, broadcast, {});
        // Auto-delete torrent from qBittorrent after successful move (unless Long Seed)
        if (job.options.torrentHash) {
          try {
            const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
            const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
            const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
            const tr = await fetch(`${base}/api/v2/torrents/info?hashes=${job.options.torrentHash}`, { headers: { 'Cookie': ck } });
            const ts = await tr.json();
            if (ts.length && ts[0].category !== 'Long Seed') {
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  await fetch(base + '/api/v2/torrents/delete', { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'hashes=' + job.options.torrentHash + '&deleteFiles=true' });
                  console.log('[pipeline] Auto-deleted torrent: ' + job.name);
                  break;
                } catch (retryErr) {
                  if (attempt < 2) { console.log('[pipeline] Delete retry ' + (attempt + 1) + ': ' + retryErr.message); await new Promise(r => setTimeout(r, 2000)); }
                  else console.log('[pipeline] Delete failed after 3 attempts: ' + retryErr.message);
                }
              }
            } else {
              console.log('[pipeline] Skipped delete — Long Seed: ' + job.name);
            }
          } catch (e) { console.log('[pipeline] Failed to auto-delete: ' + e.message); }
        }
      } else if (step === 'pc_cleanup') {
        job.progress = 'Cleaning up seedbox...';
        broadcast();
        if (job.options.torrentHash) {
          try {
            const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
            const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
            const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
            await fetch(`${base}/api/v2/torrents/delete`, { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `hashes=${job.options.torrentHash}&deleteFiles=true` });
            console.log(`[pipeline] Auto-deleted torrent (PC transfer): ${job.name}`);
          } catch (e) { console.log(`[pipeline] Failed to auto-delete (PC transfer): ${e.message}`); }
        }
      }
    }
    job.status = 'done'; job.step = 'complete'; job.progress = 'All steps complete';
    setTimeout(() => { const idx = jobs.indexOf(job); if (idx !== -1) { jobs.splice(idx, 1); broadcast(); } }, 60000);
    if (job.options.stagingPath && fs.existsSync(job.options.stagingPath)) {
      try { fs.rmSync(job.options.stagingPath, { recursive: true, force: true }); } catch (e) {}
    }
    broadcast();
  } catch (e) { job.status = 'failed'; job.error = e.message;
    setTimeout(() => { const idx = jobs.indexOf(job); if (idx !== -1) { jobs.splice(idx, 1); broadcast(); } }, 300000); broadcast(); }
}

// ========== REST API Routes ==========

function setupPipelineRoutes(app, store, auth, broadcastFn, deps) {
  _store = store;
  _broadcast = broadcastFn;
  _addAndDetect = deps.addAndDetect;
  _qbitRequest = deps.qbitRequest;
  _buildRenamePlan = deps.buildRenamePlan;
  _executeRenames = deps.executeRenames;
  _tmdbSearchApi = deps.tmdbSearchApi;
  _cleanForSearch = deps.cleanForSearch;
  _parseMediaFilename = deps.parseMediaFilename;

  const restored = restoreQueue(store);
  jobs = restored.jobs;
  jobId = restored.jobId;

  app.post('/api/pipeline/start', auth, async (req, res) => {
    const opts = req.body;
    let remotePath = opts.remotePath || null;
    if (!remotePath && opts.name) {
      const s = store.get('seedbox');
      const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : (s.localDownloadPath || '');
      if (sftpBase) {
        remotePath = `${sftpBase}/${opts.name}`;
        console.log(`[pipeline:start] Built remotePath: ${remotePath}`);
      }
    }

    const job = {
      id: jobId++, name: opts.name || 'Unnamed', status: 'queued', step: '', progress: '', error: null,
      transferDetail: null, parallelTransfers: null, renamePreview: null, torrentFiles: null,
      options: {
        torrentHash: opts.torrentHash || null, remotePath,
        grabUrl: opts.grabUrl || null, indexer: opts.indexer || '', infoUrl: opts.infoUrl || null,
        longSeed: opts.longSeed || false,
        doTransfer: opts.doTransfer !== false, doRename: opts.doRename !== false,
        renameType: opts.renameType || 'movie', renameQuery: opts.renameQuery || '',
        renameDb: opts.renameDb || '', episodeOverrides: {},
        doMove: opts.doMove !== false, moveType: opts.moveType || 'movies',
        directToPC: opts.directToPC || false,
        pcLocalPath: opts.pcLocalPath || store.get('directToPC.localPath') || '',
      }
    };
    if (opts.torrentFileNames && opts.torrentFileNames.length > 0 && job.options.doRename) {
      job.torrentFiles = opts.torrentFileNames;
      generatePreview(job, store, job.torrentFiles.map(f => f.name)).then(() => broadcast());
    }
    jobs.push(job); broadcast();
    processJob(job, store);
    res.json({ success: true, jobId: job.id });
  });

  app.get('/api/pipeline/queue', auth, async (req, res) => {
    res.json({ success: true, jobs: jobs.map(serializeJob) });
  });

  // Alias for companion/external tools
  app.get('/status', (req, res) => {
    try {
      res.json({ status: 'ok', jobs: jobs.map(serializeJob) });
    } catch (e) {
      res.json({ status: 'ok', jobs: [], error: e.message });
    }
  });

  app.post('/api/pipeline/cancel', auth, async (req, res) => {
    const j = jobs.find(x => x.id === req.body.id);
    if (j) { j.status = 'cancelled'; broadcast(); return res.json({ success: true }); }
    res.json({ success: false, error: 'Not found' });
  });

  app.post('/api/pipeline/retry', auth, async (req, res) => {
    const j = jobs.find(x => x.id === req.body.id);
    if (!j) return res.json({ success: false, error: 'Not found' });
    if (j.status !== 'failed') return res.json({ success: false, error: 'Job is not in failed state' });
    console.log(`[pipeline] Retrying job ${j.id}: "${j.name}" from step: ${j.step}`);
    j.status = 'queued'; j.error = null; j.progress = `Retrying from ${j.step}...`;
    broadcast();
    processJob(j, store);
    res.json({ success: true });
  });

  app.post('/api/pipeline/updateOptions', auth, async (req, res) => {
    const { id, options: opts } = req.body;
    const j = jobs.find(x => x.id === id);
    if (!j) return res.json({ success: false, error: 'Not found' });
    const STEPS = ['waiting_torrent', 'transferring', 'renaming', 'moving', 'complete'];
    const ci = STEPS.indexOf(j.step);
    let changed = false;
    if (opts.renameType !== undefined && ci < STEPS.indexOf('renaming')) { j.options.renameType = opts.renameType; changed = true; }
    if (opts.renameQuery !== undefined && ci < STEPS.indexOf('renaming')) { j.options.renameQuery = opts.renameQuery; changed = true; }
    if (opts.renameDb !== undefined && ci < STEPS.indexOf('renaming')) { j.options.renameDb = opts.renameDb; changed = true; }
    if (opts.episodeOverrides !== undefined) { j.options.episodeOverrides = opts.episodeOverrides; }
    if (opts.moveType !== undefined && ci < STEPS.indexOf('moving')) { j.options.moveType = opts.moveType; }
    if (changed && j.options.doRename) {
      const sp = j.options.stagingPath || store.get('paths.staging');
      if (sp && fs.existsSync(sp) && fs.readdirSync(sp).length > 0) {
        await previewFromStaging(j, store);
      } else if (j.torrentFiles && j.torrentFiles.length > 0) {
        await generatePreview(j, store, j.torrentFiles.map(f => f.name));
      }
    }
    broadcast();
    res.json({ success: true });
  });

  // Direct-to-PC: thin client reports transfer progress
  app.post('/api/pipeline/pcTransferProgress', auth, async (req, res) => {
    const { id, progress, parallelTransfers } = req.body;
    const j = jobs.find(x => x.id === id);
    if (!j) return res.json({ success: false, error: 'Not found' });
    if (j.step !== 'waiting_pc_transfer') return res.json({ success: false, error: 'Job not in PC transfer state' });
    j.progress = progress || j.progress;
    if (parallelTransfers !== undefined) j.parallelTransfers = parallelTransfers;
    broadcast();
    res.json({ success: true });
  });

  // Direct-to-PC: thin client signals transfer complete
  app.post('/api/pipeline/pcTransferDone', auth, async (req, res) => {
    const { id, error } = req.body;
    const j = jobs.find(x => x.id === id);
    if (!j) return res.json({ success: false, error: 'Not found' });
    if (j.step !== 'waiting_pc_transfer') return res.json({ success: false, error: 'Job not in PC transfer state' });
    if (error) {
      j.status = 'failed'; j.error = error;
      broadcast();
    } else {
      j.progress = 'PC transfer complete';
      j.parallelTransfers = null;
      j.step = 'pc_transfer_done';
    }
    broadcast();
    res.json({ success: true });
  });

  // Get seedbox SFTP credentials for thin client PC transfer
  app.get('/api/pipeline/seedboxSftp', auth, async (req, res) => {
    const s = store.get('seedbox');
    res.json({
      success: true,
      host: s.sftpHost, port: s.sftpPort || 22,
      username: s.sftpUsername, password: s.sftpPassword,
    });
  });

  app.post('/api/pipeline/clearFinished', auth, async (req, res) => {
    jobs = jobs.filter(j => j.status === 'queued' || j.status === 'running');
    broadcast();
    res.json({ success: true });
  });

  // Auto-grab endpoint (Companion compatibility)
  app.post('/auto-grab', auth, async (req, res) => {
    try {
      const { url, title, type, infoUrl, renameQuery } = req.body;
      if (!url) return res.status(400).json({ error: 'No URL provided' });
      const contentType = type || 'movie';
      const renameType = contentType === 'tv' ? 'tv' : 'movie';
      const moveType = contentType === 'tv' ? 'tv' : 'movies';
      console.log(`[auto-grab] ${title || 'unknown'} | type: ${contentType} | move: ${moveType}`);

      const opts = {
        name: title || 'Companion Request', grabUrl: url, indexer: '', infoUrl: infoUrl || null, longSeed: false,
        doTransfer: true, doRename: true, renameType, doMove: true, moveType,
      };

      let remotePath = null;
      const s = store.get('seedbox');
      const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : (s.localDownloadPath || '');
      if (sftpBase) remotePath = `${sftpBase}/${opts.name}`;

      const job = {
        id: jobId++, name: opts.name, status: 'queued', step: '', progress: '', error: null,
        transferDetail: null, parallelTransfers: null, renamePreview: null, torrentFiles: null,
        options: { ...opts, remotePath, torrentHash: null, renameQuery: renameQuery || '', renameDb: '', episodeOverrides: {} }
      };
      jobs.push(job); broadcast();
      processJob(job, store);
      res.json({ success: true, message: `Queued: ${title}` });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { setupPipelineRoutes, getJobs: () => jobs.map(serializeJob) };
