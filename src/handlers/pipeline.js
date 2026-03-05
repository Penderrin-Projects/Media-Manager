const path = require('path');
const fs = require('fs');
const SftpClient = require('ssh2-sftp-client');

let jobs = [];
let jobId = 1;
let _store = null; // reference for saving

function fmtB(b) { if (!b || b < 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(Math.abs(b)) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i]; }

// ========== Persistent Queue ==========
function saveQueue() {
  if (!_store) return;
  try {
    const data = jobs.map(j => ({
      id: j.id, name: j.name, status: j.status, step: j.step,
      error: j.error, progress: j.progress, options: { ...j.options },
      renamePreview: j.renamePreview || null,
      torrentFiles: j.torrentFiles || null,
    }));
    _store.set('pipeline_queue', data);
    _store.set('pipeline_nextId', jobId);
  } catch (e) { console.log('[pipeline] Failed to save queue:', e.message); }
}

function restoreQueue(store) {
  try {
    const saved = store.get('pipeline_queue') || [];
    jobId = store.get('pipeline_nextId') || 1;
    for (const s of saved) {
      // Only restore non-complete jobs, mark running ones as failed (crashed)
      if (s.status === 'complete') continue;
      const job = {
        id: s.id, name: s.name, step: s.step,
        status: (s.status === 'running') ? 'failed' : s.status,
        error: (s.status === 'running') ? 'App was closed while job was running' : (s.error || null),
        progress: s.progress || '', transferDetail: null, parallelTransfers: null,
        renamePreview: s.renamePreview || null, torrentFiles: s.torrentFiles || null,
        options: s.options || {},
      };
      jobs.push(job);
    }
    if (jobs.length) console.log(`[pipeline] Restored ${jobs.length} jobs from previous session`);
  } catch (e) { console.log('[pipeline] Failed to restore queue:', e.message); }
}

// Recursively remove empty directories (leaves non-empty ones intact)
function cleanEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      const sub = path.join(dir, item.name);
      cleanEmptyDirs(sub);
      try { if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub); } catch (e) {}
    }
  }
}

let _broadcast = null;

function broadcast() {
  const d = { jobs: jobs.map(serializeJob) };
  if (_broadcast) _broadcast('pipeline:update', d);
  saveQueue();
}

function serializeJob(j) {
  return { id: j.id, name: j.name, status: j.status, step: j.step,
    error: j.error, progress: j.progress, options: { ...j.options },
    transferDetail: j.transferDetail || null,
    parallelTransfers: j.parallelTransfers || null,
    renamePreview: j.renamePreview || null,
    torrentFiles: j.torrentFiles || null };
}

function cleanName(name) {
  return name.replace(/\.\w{2,4}$/, '').replace(/[\.\-\_]/g, ' ')
    .replace(/\[.*?\]/g, '')  // strip [YTS.BZ], [ext.to], [eztvx.to], etc
    .replace(/\((\d{4})\)/g, '$1')  // keep year but remove parens
    .replace(/\b(720p|1080p|2160p|4k|uhd|bluray|bdrip|brrip|webrip|web|dl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|atmos|dts|remux|proper|repack|internal|dubbed|subbed|multi|10bit|hdr|sdr|ddp|dv|dovi|5\.1)\b/gi, '')
    .replace(/\b(NeoNoir|NTb|FLUX|SPARKS|RARBG|YTS|YIFY|FGT|EVO|AMIABLE|TERRi|MeGusta|ION10|SUCCESSORS|EDITH|CAKES|TGx|MIXED|ETHEL)\b/gi, '')
    .replace(/\b(Season|S)\s*\d+/gi, '').replace(/\bS\d{2}E\d{2}\b/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
}

// ========== Preview functions (built-in renamer) ==========

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

// ========== Pipeline steps ==========

async function stepTorrent(job, store) {
  const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
  const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
  const ck = (lr.headers.get('set-cookie') || '').split(';')[0];

  // If no hash yet, find the torrent by name
  if (!job.options.torrentHash) {
    const r = await fetch(`${base}/api/v2/torrents/info`, { headers: { 'Cookie': ck } });
    const allTs = await r.json();
    
    // Normalize for comparison: lowercase, strip dots/dashes/underscores, collapse spaces
    const norm = (s) => s.toLowerCase().replace(/[\.\-\_\(\)\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const jobNorm = norm(job.name);
    
    // Try exact normalized match
    let match = allTs.find(t => norm(t.name) === jobNorm);
    
    // Try: first N significant words match
    if (!match) {
      const jobWords = jobNorm.split(' ').filter(w => w.length > 1).slice(0, 5).join(' ');
      match = allTs.find(t => {
        const tWords = norm(t.name).split(' ').filter(w => w.length > 1).slice(0, 5).join(' ');
        return tWords === jobWords;
      });
    }
    
    // Try: first 3 words match on recently added
    if (!match) {
      const jobWords3 = jobNorm.split(' ').filter(w => w.length > 1).slice(0, 3).join(' ');
      const recent = [...allTs].sort((a, b) => b.added_on - a.added_on).slice(0, 10);
      match = recent.find(t => {
        const tWords3 = norm(t.name).split(' ').filter(w => w.length > 1).slice(0, 3).join(' ');
        return tWords3 === jobWords3;
      });
    }
    
    if (match) {
      job.options.torrentHash = match.hash;
      job.name = match.name;
      // Build remote path from qBit's content_path
      const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : '';
      if (match.content_path && sftpBase) {
        // content_path is the full local path on seedbox, extract relative part
        const savePath = (match.save_path || '').replace(/\/$/, '');
        if (savePath && match.content_path.startsWith(savePath)) {
          const relative = match.content_path.slice(savePath.length).replace(/^\//, '');
          job.options.remotePath = `${sftpBase}/${relative}`;
        } else {
          job.options.remotePath = `${sftpBase}/${match.name}`;
        }
      }
      console.log(`[pipeline] Matched torrent: "${match.name}" hash=${match.hash} remotePath=${job.options.remotePath}`);
    } else {
      job.progress = 'Waiting for torrent to appear in qBittorrent...';
      return false;
    }
  }

  const r = await fetch(`${base}/api/v2/torrents/info?hashes=${job.options.torrentHash}`, { headers: { 'Cookie': ck } });
  const ts = await r.json(); if (!ts.length) throw new Error('Torrent not found');
  const t = ts[0];

  if (!job.torrentFiles) {
    try {
      const fr = await fetch(`${base}/api/v2/torrents/files?hash=${job.options.torrentHash}`, { headers: { 'Cookie': ck } });
      const files = await fr.json();
      const VID = ['.mkv', '.mp4', '.avi', '.m4v', '.wmv', '.mov', '.ts', '.flv', '.webm'];
      job.torrentFiles = files.filter(f => VID.includes(path.extname(f.name).toLowerCase())).map(f => ({ name: f.name, size: f.size }));
      if (job.options.doRename && job.torrentFiles.length > 0) {
        await generatePreview(job, store, job.torrentFiles.map(f => f.name));
      }
      broadcast();
    } catch (e) { console.error('[pipeline] Error getting torrent files/preview:', e.message); }
  }

  if (t.progress >= 1) {
    // Re-resolve remotePath from content_path now that torrent is complete
    const sftpBase2 = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : '';
    if (sftpBase2 && t.content_path) {
      const savePath2 = (t.save_path || '').replace(/\/$/, '');
      if (savePath2 && t.content_path.startsWith(savePath2)) {
        const relative2 = t.content_path.slice(savePath2.length).replace(/^\//, '');
        job.options.remotePath = `${sftpBase2}/${relative2}`;
      } else {
        job.options.remotePath = `${sftpBase2}/${t.name}`;
      }
      console.log(`[pipeline] Torrent complete. content_path: ${t.content_path}`);
      console.log(`[pipeline] Resolved remotePath: ${job.options.remotePath}`);
    }
    if (t.category !== 'Long Seed') {
      try { await fetch(`${base}/api/v2/torrents/pause`, { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `hashes=${job.options.torrentHash}` }); } catch (e) {}
    }
    return true;
  }
  job.progress = `Torrent: ${Math.round(t.progress * 100)}% — ↓ ${fmtB(t.dlspeed)}/s`;
  return false;
}

// ========== Concurrent SFTP Transfer ==========

const MAX_CONCURRENT = 10;

// Walk remote directory tree, collect all file paths with sizes
async function collectRemoteFiles(sftp, remotePath, basePath) {
  const result = [];
  const items = await sftp.list(remotePath);
  for (const item of items) {
    const rp = `${remotePath}/${item.name}`;
    const lp = path.join(basePath, item.name);
    if (item.type === 'd') {
      const subFiles = await collectRemoteFiles(sftp, rp, lp);
      result.push(...subFiles);
    } else {
      result.push({ remote: rp, local: lp, name: item.name, size: item.size });
    }
  }
  return result;
}

async function stepTransfer(job, store) {
  const s = store.get('seedbox'), sp = store.get('paths.staging');
  if (!sp) throw new Error('Staging not configured');
  // Each job gets its own staging subfolder to avoid conflicts
  const jobStaging = path.join(sp, `job-${job.id}`);
  if (!fs.existsSync(jobStaging)) fs.mkdirSync(jobStaging, { recursive: true });
  job.options.stagingPath = jobStaging;

  // First connection: collect file list
  const scout = new SftpClient();
  await scout.connect({ host: s.sftpHost, port: s.sftpPort || 22, username: s.sftpUsername, password: s.sftpPassword });
  const rp = job.options.remotePath;
  if (!rp) throw new Error('Remote path not set — torrent may not have been matched in qBittorrent');
  const st = await scout.stat(rp);

  let files;
  if (st.isDirectory) {
    const localBase = path.join(jobStaging, path.basename(rp));
    files = await collectRemoteFiles(scout, rp, localBase);
  } else {
    files = [{ remote: rp, local: path.join(jobStaging, path.basename(rp)), name: path.basename(rp), size: st.size }];
  }
  await scout.end();

  if (files.length === 0) { job.progress = 'No files to transfer'; return; }

  // Ensure all local directories exist
  for (const f of files) {
    const dir = path.dirname(f.local);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Track active transfers for UI
  const activeSlots = {};
  let lastBroadcast = 0;
  const throttleBroadcast = () => {
    const now = Date.now();
    if (now - lastBroadcast > 300) {
      lastBroadcast = now;
      job.parallelTransfers = Object.values(activeSlots).filter(x => x);
      const totalDone = files.filter(f => f.done).length;
      job.progress = `Transferring: ${totalDone}/${files.length} files`;
      broadcast();
    }
  };

  // Use concurrency pool
  const concurrency = Math.min(MAX_CONCURRENT, files.length);
  let fileIdx = 0;

  const worker = async (workerId) => {
    const conn = new SftpClient();
    await conn.connect({ host: s.sftpHost, port: s.sftpPort || 22, username: s.sftpUsername, password: s.sftpPassword });

    while (fileIdx < files.length && job.status !== 'cancelled') {
      const idx = fileIdx++;
      if (idx >= files.length) break;
      const f = files[idx];
      let pB = 0, pT = Date.now();
      activeSlots[workerId] = { file: f.name, transferred: 0, total: f.size, percent: 0, speed: 0 };
      throttleBroadcast();

      await conn.fastGet(f.remote, f.local, { step: (x) => {
        const n = Date.now(), dt = (n - pT) / 1000;
        const spd = dt > 0 ? (x - pB) / dt : 0;
        pB = x; pT = n;
        activeSlots[workerId] = { file: f.name, transferred: x, total: f.size, percent: Math.round((x / f.size) * 100), speed: spd };
        throttleBroadcast();
      }});
      f.done = true;
      activeSlots[workerId] = null;
    }

    await conn.end();
  };

  // Launch workers
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(i));
  }
  await Promise.all(workers);

  job.parallelTransfers = null;
  job.transferDetail = null;
  job.progress = `Transfer complete — ${files.length} file(s)`;
}

async function stepRename(job, store) {
  const apiKey = store.get('tmdb.apiKey') || '';
  const sp = job.options.stagingPath || store.get('paths.staging');
  if (!apiKey) throw new Error('TMDB API key not configured — add it in Settings');
  if (!sp || !fs.existsSync(sp)) throw new Error('Staging folder not found');

  const plan = await _buildRenamePlan(sp, job.options.renameType || 'movie', apiKey, job.options.renameQuery || null);
  if (!plan.length) { job.progress = 'No files matched for renaming'; return; }

  const results = await _executeRenames(plan);
  const successCount = results.filter(r => r.success).length;
  job.progress = `Renamed ${successCount} file(s)`;
  cleanEmptyDirs(sp);
}

// Async file copy with progress — doesn't block the main process
function asyncCopyFile(src, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(src);
    const total = stat.size;
    let copied = 0;
    const readStream = fs.createReadStream(src);
    const writeStream = fs.createWriteStream(dest);
    readStream.on('data', (chunk) => {
      copied += chunk.length;
      if (onProgress) onProgress(copied, total);
    });
    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    readStream.pipe(writeStream);
  });
}

// Collect all files from a directory recursively
function collectFiles(dir, base) {
  const results = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const src = path.join(dir, item.name);
    const rel = path.join(base, item.name);
    if (item.isDirectory()) {
      results.push(...collectFiles(src, rel));
    } else {
      results.push({ src, rel, name: item.name, size: fs.statSync(src).size });
    }
  }
  return results;
}

// Async rm
async function rmDir(d) {
  for (const i of fs.readdirSync(d, { withFileTypes: true })) {
    const fp2 = path.join(d, i.name);
    if (i.isDirectory()) await rmDir(fp2);
    else fs.unlinkSync(fp2);
  }
  fs.rmdirSync(d);
}

async function stepMove(job, store) {
  const sp = job.options.stagingPath || store.get('paths.staging');
  const pm = { movies: 'paths.nasMovies', tv: 'paths.nasTVShows', kidsMovies: 'paths.nasKidsMovies',
    asianMovies: 'paths.nasAsianMovies', asianShows: 'paths.nasAsianShows',
    animeMovies: 'paths.nasAnimeMovies', animeShows: 'paths.nasAnimeShows' };
  const np = store.get(pm[job.options.moveType]);
  if (!np) throw new Error(`NAS path for "${job.options.moveType}" not configured`);
  if (!fs.existsSync(sp)) throw new Error('Staging empty');

  const VID = ['.mkv', '.mp4', '.avi', '.m4v', '.wmv', '.mov', '.ts', '.flv', '.webm'];
  const SUB = ['.srt', '.sub', '.idx', '.ass', '.ssa', '.vtt'];
  function isVid(f) { return VID.includes(path.extname(f).toLowerCase()); }
  function isSub(f) { return SUB.includes(path.extname(f).toLowerCase()); }

  // Detect English by scanning subtitle file content
  function isEnglishByContent(filepath) {
    try {
      const buf = fs.readFileSync(filepath, { encoding: 'utf8', flag: 'r' });
      const sample = buf.slice(0, 8192).toLowerCase();
      // Strip SRT/ASS formatting (timestamps, numbers, style tags)
      const text = sample
        .replace(/\d+\r?\n\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\r?\n/g, ' ')
        .replace(/dialogue:\s*\d,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,/gi, ' ')  // ASS format
        .replace(/<[^>]+>/g, ' ').replace(/\{[^}]+\}/g, ' ')
        .replace(/\d+/g, ' ').replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 30) return false;
      const engWords = [
        'the','you','and','that','this','what','have','for','not','with','are','but',
        'was','his','her','she','they','will','from','been','just','about','your',
        'know','don','would','could','should','going','come','here','there','where',
        'when','how','who','why','tell','said','like','think','look','want','give',
        'back','get','can','all','out','were','than','them','some','into','other',
        'well','right','okay','yeah','sorry','please','thank','never','really',
        'because','before','after','still','people','need','let','got','did','does',
      ];
      const words = text.split(/\s+/).filter(w => w.length > 1);
      if (words.length < 8) return false;
      let hits = 0;
      for (const w of words) { if (engWords.includes(w)) hits++; }
      const ratio = hits / words.length;
      console.log(`[subs] Content scan "${path.basename(filepath)}": ${hits}/${words.length} eng words (${(ratio*100).toFixed(1)}%)`);
      return ratio > 0.10;
    } catch (e) {
      console.log(`[subs] Could not read "${path.basename(filepath)}": ${e.message}`);
      return false;
    }
  }

  // Check filename for explicit English marker (fast path)
  function hasEnglishFilenameMarker(filename) {
    const l = filename.toLowerCase();
    return l.includes('english') || l.match(/[\._-]eng[\._-]/) || l.match(/[\._-]en[\._-]/) ||
      l.match(/[\._-]eng\./) || l.match(/[\._-]en\./) || l.includes('.eng.') || l.includes('.en.');
  }

  // Check filename for explicit foreign marker (fast reject)
  function hasForeignFilenameMarker(filename) {
    const l = filename.toLowerCase();
    const foreign = [
      'arabic','chinese','czech','danish','dutch','finnish','french','german','greek',
      'hebrew','hindi','hungarian','indonesian','italian','japanese','korean','malay',
      'norwegian','persian','polish','portuguese','romanian','russian','spanish',
      'swedish','tagalog','thai','turkish','ukrainian','vietnamese','bengali','croatian',
      'serbian','slovenian','bulgarian',
      '.chi.','.spa.','.fre.','.fra.','.ger.','.deu.','.ita.','.jpn.','.kor.','.ara.',
      '.rus.','.hin.','.tha.','.vie.','.pol.','.tur.','.dut.','.nld.','.swe.','.por.',
      '.dan.','.fin.','.nor.','.ces.','.hun.','.rom.','.heb.','.ind.','.msa.','.tgl.',
      '.ukr.','.hrv.','.srp.','.slv.','.bul.','.ell.','.ben.','.fas.','.zho.','.zht.',
    ];
    for (const fp of foreign) if (l.includes(fp)) return true;
    return false;
  }

  function isForced(filename) {
    const l = filename.toLowerCase();
    return l.includes('forced') || l.match(/[\._-]forc(ed)?[\._-]/);
  }

  // Extract subtitle tags (SDH, HI, CC, forced) from filename
  function getSubTags(filename) {
    const l = filename.toLowerCase();
    const tags = [];
    if (l.includes('sdh') || l.match(/[\._-]sdh[\._-]/) || l.match(/[\._-]sdh\./)) tags.push('sdh');
    if ((l.match(/[\._-]hi[\._-]/) || l.match(/[\._-]hi\./)) && !l.includes('hindi')) tags.push('sdh');
    if (l.includes('.cc.') || l.match(/[\._-]cc[\._-]/) || l.match(/[\._-]cc\./)) tags.push('cc');
    if (isForced(filename)) tags.push('forced');
    return [...new Set(tags)];
  }

  // Collect all files recursively from staging
  const allStaged = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, item.name);
      if (item.isDirectory()) { walk(fp); }
      else { allStaged.push({ src: fp, name: item.name, size: fs.statSync(fp).size, parentDir: dir }); }
    }
  }
  walk(sp);

  // Separate videos and detect English subs
  const videos = allStaged.filter(f => isVid(f.name) && !/sample/i.test(f.name));
  const candidateSubs = allStaged.filter(f => isSub(f.name) && !/sample/i.test(f.name));
  
  // Filter to English subs: filename check first, then content scan as fallback
  const engSubs = [];
  for (const sub of candidateSubs) {
    if (hasForeignFilenameMarker(sub.name)) {
      console.log(`[subs] Skipped (foreign filename): ${sub.name}`);
      continue;
    }
    if (hasEnglishFilenameMarker(sub.name)) {
      console.log(`[subs] Included (English filename): ${sub.name}`);
      engSubs.push(sub);
      continue;
    }
    // No language marker in filename — scan content
    if (isEnglishByContent(sub.src)) {
      console.log(`[subs] Included (English content): ${sub.name}`);
      engSubs.push(sub);
    } else {
      console.log(`[subs] Skipped (non-English content): ${sub.name}`);
    }
  }
  console.log(`[subs] Found ${engSubs.length} English sub(s) out of ${candidateSubs.length} total`);

  if (videos.length === 0) { job.progress = 'No video files to move'; return; }

  // Build move list: videos keep their (renamed) names, subs get renamed to match
  const allFiles = [];

  for (const vid of videos) {
    const vidBase = path.basename(vid.name, path.extname(vid.name));
    const vidExt = path.extname(vid.name);

    // Determine dest folder — if there's a parent structure (show/season), preserve it
    const relFromStaging = path.relative(sp, vid.src);
    const relDir = path.dirname(relFromStaging);
    const destDir = relDir !== '.' ? path.join(np, relDir) : np;
    
    allFiles.push({
      src: vid.src, dest: path.join(destDir, vid.name),
      name: vid.name, size: vid.size, parentDir: vid.parentDir
    });

    // Find subs that belong to this video
    // For single-video torrents: all English subs go with it
    // For multi-video: match subs by episode pattern or proximity
    let matchedSubs = engSubs;
    if (videos.length > 1) {
      // Try to match by episode number (S01E01, etc)
      const epMatch = vidBase.match(/S(\d+)E(\d+)/i);
      if (epMatch) {
        const epPattern = `S${epMatch[1]}E${epMatch[2]}`;
        matchedSubs = engSubs.filter(s => s.name.toUpperCase().includes(epPattern.toUpperCase()));
      }
      // If no episode match, try matching by similar name prefix
      if (matchedSubs.length === 0) {
        const prefix = vidBase.split(/[\.\s\-\_]/)[0].toLowerCase();
        matchedSubs = engSubs.filter(s => s.name.toLowerCase().startsWith(prefix));
      }
    }

    // Sort: forced first, then by name
    const forced = matchedSubs.filter(s => isForced(s.name));
    const nonForced = matchedSubs.filter(s => !isForced(s.name));

    // Rename subs to Plex naming convention:
    //   MovieName.en.srt              (single sub)
    //   MovieName.en.sdh.srt          (SDH tagged)
    //   MovieName.en.forced.srt       (forced)
    //   MovieName.en.forced.sdh.srt   (forced + SDH)
    //   MovieName.en2.srt             (second sub with same tags)
    // Language code "en" is required for Plex to detect English
    const usedNames = new Set();
    function buildSubName(sub, forceForced) {
      const subExt = path.extname(sub.name);
      const tags = getSubTags(sub.name);
      if (forceForced && !tags.includes('forced')) tags.unshift('forced');
      if (forceForced) {
        // Remove 'forced' so we can place it first
        const filtered = tags.filter(t => t !== 'forced');
        const tagStr = filtered.length ? '.forced.' + filtered.join('.') : '.forced';
        let candidate = `${vidBase}.en${tagStr}${subExt}`;
        let n = 2;
        while (usedNames.has(candidate)) {
          candidate = `${vidBase}.en${n}${tagStr}${subExt}`;
          n++;
        }
        usedNames.add(candidate);
        return candidate;
      } else {
        const tagStr = tags.length ? '.' + tags.join('.') : '';
        let candidate = `${vidBase}.en${tagStr}${subExt}`;
        let n = 2;
        while (usedNames.has(candidate)) {
          candidate = `${vidBase}.en${n}${tagStr}${subExt}`;
          n++;
        }
        usedNames.add(candidate);
        return candidate;
      }
    }

    for (const sub of nonForced) {
      const destName = buildSubName(sub, false);
      allFiles.push({
        src: sub.src, dest: path.join(destDir, destName),
        name: destName, size: sub.size, parentDir: sub.parentDir
      });
    }
    for (const sub of forced) {
      const destName = buildSubName(sub, true);
      allFiles.push({
        src: sub.src, dest: path.join(destDir, destName),
        name: destName, size: sub.size, parentDir: sub.parentDir
      });
    }
  }

  if (allFiles.length === 0) { job.progress = 'No matching files to move'; return; }

  console.log(`[pipeline] Moving ${allFiles.length} files (${videos.length} video, ${allFiles.length - videos.length} subs)`);

  const totalSize = allFiles.reduce((s, f) => s + f.size, 0);
  let totalCopied = 0;
  let filesDone = 0;
  let lastBroadcast = 0;

  for (const f of allFiles) {
    if (job.status === 'cancelled') return;
    const destDir = path.dirname(f.dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    // Try rename first (instant on same filesystem / NAS volume)
    try {
      await fs.promises.rename(f.src, f.dest);
      totalCopied += f.size;
      filesDone++;
      const pct = totalSize > 0 ? Math.round((totalCopied / totalSize) * 100) : 0;
      job.progress = `Moving: ${f.name} — ${filesDone}/${allFiles.length} files (${pct}%)`;
      broadcast();
      continue; // rename succeeded, skip copy
    } catch (renameErr) {
      if (renameErr.code !== 'EXDEV') throw renameErr;
      // Cross-device: fall through to copy
    }

    await asyncCopyFile(f.src, f.dest, (copied, total) => {
      const now = Date.now();
      if (now - lastBroadcast > 400) {
        lastBroadcast = now;
        const pct = totalSize > 0 ? Math.round(((totalCopied + copied) / totalSize) * 100) : 0;
        job.progress = `Moving: ${f.name} — ${filesDone}/${allFiles.length} files (${pct}%)`;
        broadcast();
      }
    });

    totalCopied += f.size;
    filesDone++;
    // Delete source after successful copy
    fs.unlinkSync(f.src);
  }

  // Clean up empty directories in staging
  try { cleanEmptyDirs(sp); } catch (e) {}

  job.progress = `Moved ${filesDone} file(s) to NAS`;
}

// ========== Job processor ==========

async function processJob(job, store) {
  try {
    const steps = [];
    if (job.options.grabUrl) steps.push('grabbing');
    if (job.options.torrentHash || job.options.grabUrl) steps.push('waiting_torrent');
    if (job.options.directToPC) {
      // Direct-to-PC mode: after torrent completes, wait for thin client to pull, then clean up
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
        // Server-side just waits — the thin client does the SFTP pull and calls /api/pipeline/pcTransferDone
        job.progress = 'Waiting for desktop client to pull files from seedbox...';
        broadcast();
        // Poll until thin client marks it done (or cancelled)
        while (job.status === 'running' && job.step === 'waiting_pc_transfer') {
          await new Promise(r => setTimeout(r, 2000));
        }
        if (job.status === 'cancelled') return;
        // If step changed away from waiting_pc_transfer, the thin client completed it
        continue;
      } else if (step === 'grabbing') {
        job.progress = 'Adding torrent to qBittorrent...';
        broadcast();
        const result = await _addAndDetect(store, job.options.grabUrl, job.name);
        if (!result.success) throw new Error('Failed to add torrent: ' + (result.error || 'Unknown'));
        if (!result.hash) throw new Error('Torrent added but could not detect hash in qBittorrent');
        job.options.torrentHash = result.hash;
        job.name = result.name || job.name;
        // Set Long Seed category if flagged (private tracker — seed forever, never pause/delete)
        if (job.options.longSeed && result.hash) {
          try {
            await _qbitRequest(store, '/api/v2/torrents/createCategory', 'POST', 'category=Long%20Seed&savePath=');
            await _qbitRequest(store, '/api/v2/torrents/setCategory', 'POST', `hashes=${result.hash}&category=Long%20Seed`);
            console.log(`[pipeline] Set Long Seed: ${result.hash}`);
          } catch (e) { console.log('[pipeline] Failed to set Long Seed:', e.message); }
        }
        // Build remotePath from qBit's actual content_path (not display name — may differ due to colons etc)
        const s = store.get('seedbox');
        const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : '';
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
          done = await stepTorrent(job, store);
          if (!done) { broadcast(); await new Promise(r => setTimeout(r, 10000)); }
        }
        if (job.status === 'cancelled') return;
        if (!job.options.remotePath) {
          const s = store.get('seedbox');
          const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : '';
          if (!sftpBase) throw new Error('SFTP Remote Path not configured in Settings');
          job.options.remotePath = `${sftpBase}/${job.name}`;
        }
      } else if (step === 'transferring') {
        await stepTransfer(job, store);
        if (job.options.doRename) { await previewFromStaging(job, store); broadcast(); }
      } else if (step === 'renaming') {
        await stepRename(job, store);
        job.renamePreview = null;
      } else if (step === 'moving') {
        await stepMove(job, store);
        // Auto-delete torrent from qBittorrent after successful move (unless Long Seed)
        if (job.options.torrentHash) {
          try {
            const s = store.get('seedbox'), base = s.qbitUrl.replace(/\/$/, '');
            const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
            const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
            // Check if Long Seed
            const tr = await fetch(`${base}/api/v2/torrents/info?hashes=${job.options.torrentHash}`, { headers: { 'Cookie': ck } });
            const ts = await tr.json();
            if (ts.length && ts[0].category !== 'Long Seed') {
              await fetch(`${base}/api/v2/torrents/delete`, { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `hashes=${job.options.torrentHash}&deleteFiles=true` });
              console.log(`[pipeline] Auto-deleted torrent: ${job.name}`);
            } else {
              console.log(`[pipeline] Skipped delete — Long Seed: ${job.name}`);
            }
          } catch (e) { console.log(`[pipeline] Failed to auto-delete: ${e.message}`); }
        }
      } else if (step === 'pc_cleanup') {
        // Auto-delete torrent from qBittorrent after successful PC transfer
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
    // Clean up job-specific staging subfolder
    if (job.options.stagingPath && fs.existsSync(job.options.stagingPath)) {
      try { fs.rmSync(job.options.stagingPath, { recursive: true, force: true }); } catch (e) {}
    }
    broadcast();
  } catch (e) { job.status = 'failed'; job.error = e.message; broadcast(); }
}

// ========== REST API Routes ==========

let _addAndDetect, _qbitRequest, _buildRenamePlan, _executeRenames, _tmdbSearchApi, _cleanForSearch, _parseMediaFilename;

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

  restoreQueue(store);

  app.post('/api/pipeline/start', auth, async (req, res) => {
    const opts = req.body;
    let remotePath = opts.remotePath || null;
    if (!remotePath && opts.name) {
      const s = store.get('seedbox');
      const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : '';
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
      const fs = require('fs');
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
      j.step = 'pc_transfer_done'; // Advance past waiting — processJob loop will continue to pc_cleanup
      // Don't change status — processJob loop handles it
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
      const { url, title, type, infoUrl } = req.body;
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
      const sftpBase = s.sftpRemotePath ? s.sftpRemotePath.replace(/\/$/, '') : '';
      if (sftpBase) remotePath = `${sftpBase}/${opts.name}`;
      
      const job = {
        id: jobId++, name: opts.name, status: 'queued', step: '', progress: '', error: null,
        transferDetail: null, parallelTransfers: null, renamePreview: null, torrentFiles: null,
        options: { ...opts, remotePath, torrentHash: null, renameQuery: '', renameDb: '', episodeOverrides: {} }
      };
      jobs.push(job); broadcast();
      processJob(job, store);
      res.json({ success: true, message: `Queued: ${title}` });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { setupPipelineRoutes, getJobs: () => jobs.map(serializeJob) };
