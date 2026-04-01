// ═══════════════════════════════════════════════════════════════════
// Pipeline Handler — Slim (Local qBit only)
// Flow: Grab magnet → qBit downloads → Deliver (copy to library + rename)
// No SFTP, no staging folder, no seedbox
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

let jobs = [];
let jobId = 1;
let _store = null;

function fmtB(b) { if (!b || b < 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(Math.abs(b)) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i]; }


// Ensure magnet URLs have trackers — Windows protocol handlers strip them
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker2.dler.org:80/announce',
  'http://tracker.bt4g.com:2095/announce',
  'udp://tracker.tryhackx.org:6969/announce',
];

function ensureTrackers(magnetUrl) {
  if (!magnetUrl || !magnetUrl.startsWith('magnet:')) return magnetUrl;
  if (magnetUrl.includes('tr=')) return magnetUrl; // already has trackers
  const trackerParams = PUBLIC_TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('');
  return magnetUrl + trackerParams;
}

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
      if (s.status === 'complete') continue;
      const job = {
        id: s.id, name: s.name, step: s.step,
        status: (s.status === 'running') ? 'failed' : s.status,
        error: (s.status === 'running') ? 'App was closed while job was running' : (s.error || null),
        progress: s.progress || '',
        renamePreview: s.renamePreview || null, torrentFiles: s.torrentFiles || null,
        options: s.options || {},
      };
      jobs.push(job);
    }
    if (jobs.length) console.log(`[pipeline] Restored ${jobs.length} jobs from previous session`);
  } catch (e) { console.log('[pipeline] Failed to restore queue:', e.message); }
}

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
    renamePreview: j.renamePreview || null,
    torrentFiles: j.torrentFiles || null };
}

// ========== Preview functions ==========

async function generatePreview(job, store, filenames) {
  const apiKey = store.get('tmdb.apiKey') || '';
  if (!apiKey) { job.renamePreview = null; return; }

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
      const plan = await _buildRenamePlan(tmpDir, job.options.renameType || 'movie', apiKey, job.options.renameQuery || null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (plan.length > 0) {
        job.renamePreview = plan.map(p => ({ from: p.fromDisplay, to: p.toDisplay }));
        return;
      }
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Fallback: name-based TMDB search
  const query = job.options.renameQuery || _cleanForSearch(job.name);
  try {
    const type = job.options.renameType === 'tv' ? 'tv' : 'movie';
    const results = await _tmdbSearchApi(apiKey, query, type, null);
    if (results.length > 0) {
      const m = results[0];
      const label = m.year ? `${m.title} (${m.year})` : m.title;
      job.renamePreview = [{ from: job.name, to: label + ' (full preview after download)' }];
    } else {
      job.renamePreview = null;
    }
  } catch (e) { job.renamePreview = null; }
}

// ========== qBit helper ==========

async function qbitAuth(store) {
  const s = store.get('seedbox');
  const base = s.qbitUrl.replace(/\/$/, '');
  const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}` });
  const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
  return { base, ck };
}

// PC qBit helper — for MyPC target
async function pcQbitAuth(store) {
  const pc = store.get('pcQbit');
  if (!pc || !pc.url) throw new Error('PC qBittorrent not configured');
  const base = pc.url.replace(/\/$/, '');
  const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(pc.username || '')}&password=${encodeURIComponent(pc.password || '')}` });
  const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
  return { base, ck };
}

// ========== Pipeline steps ==========

async function stepTorrent(job, store) {
  const { base, ck } = await qbitAuth(store);

  if (!job.options.torrentHash) {
    const r = await fetch(`${base}/api/v2/torrents/info`, { headers: { 'Cookie': ck } });
    const allTs = await r.json();
    const norm = (s) => s.toLowerCase().replace(/[\.\-\_\(\)\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const jobNorm = norm(job.name);

    let match = allTs.find(t => norm(t.name) === jobNorm);
    if (!match) {
      const jobWords = jobNorm.split(' ').filter(w => w.length > 1).slice(0, 5).join(' ');
      match = allTs.find(t => norm(t.name).split(' ').filter(w => w.length > 1).slice(0, 5).join(' ') === jobWords);
    }
    if (!match) {
      const jobWords3 = jobNorm.split(' ').filter(w => w.length > 1).slice(0, 3).join(' ');
      const recent = [...allTs].sort((a, b) => b.added_on - a.added_on).slice(0, 10);
      match = recent.find(t => norm(t.name).split(' ').filter(w => w.length > 1).slice(0, 3).join(' ') === jobWords3);
    }

    if (match) {
      job.options.torrentHash = match.hash;
      job.name = match.name;
    } else {
      job.progress = 'Waiting for torrent to appear in qBittorrent...';
      return false;
    }
  }

  const r = await fetch(`${base}/api/v2/torrents/info?hashes=${job.options.torrentHash}`, { headers: { 'Cookie': ck } });
  const ts = await r.json(); if (!ts.length) throw new Error('Torrent not found');
  const t = ts[0];

  // Get torrent files for preview
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
    } catch (e) {}
  }

  if (t.progress >= 1) {
    // Remap qBit's internal path to our container's mount
    const qbitPath = t.content_path || path.join(t.save_path || '', t.name);
    const localDownloadPath = store.get('seedbox.localDownloadPath') || '/torrents';
    // Replace only the /downloads base — preserves subdirs like /downloads/Long Seed
    const qbitBase = '/downloads';
    job.options.localPath = qbitPath.startsWith(qbitBase)
      ? localDownloadPath + qbitPath.slice(qbitBase.length)
      : qbitPath;
    console.log(`[pipeline] Torrent complete. qBit: ${qbitPath} -> Local: ${job.options.localPath}`);
    // Pause unless Long Seed
    if (t.category !== 'Long Seed') {
      try { await fetch(`${base}/api/v2/torrents/pause`, { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `hashes=${job.options.torrentHash}` }); } catch (e) {}
    }
    return true;
  }
  job.progress = `Torrent: ${Math.round(t.progress * 100)}% — ↓ ${fmtB(t.dlspeed)}/s`;
  return false;
}

// MyPC mode: just add the magnet to the PC's qBit instance
async function stepPcGrab(job, store) {
  const { base, ck } = await pcQbitAuth(store);
  const magnetUrl = ensureTrackers(job.options.grabUrl);
  if (!magnetUrl) throw new Error('No magnet/URL to send to PC');
  
  // Use multipart form to avoid URL encoding mangling the magnet's & params
  const boundary = '----MMBoundary' + Date.now();
  let body = '';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="urls"\r\n\r\n${magnetUrl}\r\n`;
  if (job.options.longSeed) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nLong Seed\r\n`;
  }
  body += `--${boundary}--\r\n`;
  
  const r = await fetch(`${base}/api/v2/torrents/add`, {
    method: 'POST',
    headers: { 'Cookie': ck, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  if (!r.ok) throw new Error(`PC qBit returned ${r.status}`);
  job.progress = 'Sent to PC qBittorrent';
}

// Copy files from torrent download dir directly to library, then rename in place
async function stepDeliver(job, store) {
  const localPath = job.options.localPath;
  if (!localPath) throw new Error('No local download path — torrent may not have completed');

  // Determine destination library (dynamic — uses paths.libraries array)
  const libraries = store.get('paths.libraries') || [];
  const lib = libraries.find(l => l.name === job.options.moveType);
  // Fallback: check legacy flat keys for backwards compat
  const legacyMap = { movies: 'paths.nasMovies', tv: 'paths.nasTVShows', kidsMovies: 'paths.nasKidsMovies',
    asianMovies: 'paths.nasAsianMovies', asianShows: 'paths.nasAsianShows',
    animeMovies: 'paths.nasAnimeMovies', animeShows: 'paths.nasAnimeShows' };
  const destBase = lib ? lib.path : store.get(legacyMap[job.options.moveType]);
  if (!destBase) throw new Error(`NAS path for "${job.options.moveType}" not configured`);

  const VID = ['.mkv', '.mp4', '.avi', '.m4v', '.wmv', '.mov', '.ts', '.flv', '.webm'];
  const SUB = ['.srt', '.sub', '.idx', '.ass', '.ssa', '.vtt'];
  const isVid = (f) => VID.includes(path.extname(f).toLowerCase());
  const isSub = (f) => SUB.includes(path.extname(f).toLowerCase());

  // ---- Collect source files ----
  const stat = fs.statSync(localPath);
  let allSrc = [];
  if (stat.isDirectory()) {
    allSrc = collectFiles(localPath, '');
  } else {
    allSrc = [{ src: localPath, rel: path.basename(localPath), name: path.basename(localPath), size: stat.size }];
  }

  const videos = allSrc.filter(f => isVid(f.name) && !/sample/i.test(f.name));
  const candidateSubs = allSrc.filter(f => isSub(f.name) && !/sample/i.test(f.name));
  if (videos.length === 0) throw new Error('No video files found in torrent');

  // ---- Filter to English subs ----
  const engSubs = [];
  for (const sub of candidateSubs) {
    if (hasForeignFilenameMarker(sub.name)) continue;
    if (hasEnglishFilenameMarker(sub.name)) { engSubs.push(sub); continue; }
    if (isEnglishByContent(sub.src)) engSubs.push(sub);
  }

  // ---- Build copy list ----
  const copyList = [];
  for (const vid of videos) {
    const vidBase = path.basename(vid.name, path.extname(vid.name));
    const relDir = path.dirname(vid.rel);
    const destDir = relDir !== '.' ? path.join(destBase, relDir) : destBase;

    copyList.push({ src: vid.src, dest: path.join(destDir, vid.name), name: vid.name, size: vid.size });

    // Match subs
    let matchedSubs = engSubs;
    if (videos.length > 1) {
      const epMatch = vidBase.match(/S(\d+)E(\d+)/i);
      if (epMatch) {
        const epPattern = `S${epMatch[1]}E${epMatch[2]}`;
        matchedSubs = engSubs.filter(s => s.name.toUpperCase().includes(epPattern.toUpperCase()));
      }
      if (matchedSubs.length === 0) {
        const prefix = vidBase.split(/[\.\s\-\_]/)[0].toLowerCase();
        matchedSubs = engSubs.filter(s => s.name.toLowerCase().startsWith(prefix));
      }
    }

    const usedNames = new Set();
    for (const sub of matchedSubs) {
      const subExt = path.extname(sub.name);
      const tags = getSubTags(sub.name);
      const tagStr = tags.length ? '.' + tags.join('.') : '';
      let candidate = `${vidBase}.en${tagStr}${subExt}`;
      let n = 2;
      while (usedNames.has(candidate)) { candidate = `${vidBase}.en${n}${tagStr}${subExt}`; n++; }
      usedNames.add(candidate);
      copyList.push({ src: sub.src, dest: path.join(destDir, candidate), name: candidate, size: sub.size });
    }
  }

  // ---- Copy files to library ----
  job.progress = `Copying ${copyList.length} file(s) to ${job.options.moveType}...`;
  broadcast();

  const totalSize = copyList.reduce((s, f) => s + f.size, 0);
  let totalCopied = 0;
  let filesDone = 0;

  for (const f of copyList) {
    if (job.status === 'cancelled') return;
    const destDir = path.dirname(f.dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    await asyncCopyFile(f.src, f.dest, (copied, total) => {
      const pct = totalSize > 0 ? Math.round(((totalCopied + copied) / totalSize) * 100) : 0;
      job.progress = `Copying: ${f.name} — ${filesDone}/${copyList.length} (${pct}%)`;
    });
    totalCopied += f.size;
    filesDone++;
    broadcast();
  }

  job.progress = `Copied ${filesDone} file(s). Renaming...`;
  broadcast();

  // ---- Rename in place ----
  if (job.options.doRename) {
    const apiKey = store.get('tmdb.apiKey') || '';
    if (apiKey) {
      // Collect the destination paths we just wrote, grouped by directory
      const destDirs = new Set(copyList.filter(f => isVid(f.name)).map(f => path.dirname(f.dest)));
      let totalRenamed = 0;

      for (const dir of destDirs) {
        try {
          const plan = await _buildRenamePlan(dir, job.options.renameType || 'movie', apiKey, job.options.renameQuery || null);
          if (plan.length > 0) {
            const results = await _executeRenames(plan);
            totalRenamed += results.filter(r => r.success).length;
          }
        } catch (e) {
          console.log(`[pipeline] Rename error in ${dir}: ${e.message}`);
        }
      }
      job.progress = totalRenamed > 0 ? `Renamed ${totalRenamed} file(s)` : 'No rename matches (files copied as-is)';
    } else {
      job.progress = 'TMDB key not set — files copied without renaming';
    }
  } else {
    job.progress = `Delivered ${filesDone} file(s)`;
  }
}

// ========== Helpers ==========

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

function isEnglishByContent(filepath) {
  try {
    const buf = fs.readFileSync(filepath, { encoding: 'utf8', flag: 'r' });
    const sample = buf.slice(0, 8192).toLowerCase();
    const text = sample
      .replace(/\d+\r?\n\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\r?\n/g, ' ')
      .replace(/dialogue:\s*\d,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\{[^}]+\}/g, ' ')
      .replace(/\d+/g, ' ').replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 30) return false;
    const engWords = ['the','you','and','that','this','what','have','for','not','with','are','but',
      'was','his','her','she','they','will','from','been','just','about','your','know','don',
      'would','could','should','going','come','here','there','where','when','how','who','why',
      'tell','said','like','think','look','want','give','back','get','can','all','out','were',
      'than','them','some','into','other','well','right','okay','yeah','sorry','please','thank',
      'never','really','because','before','after','still','people','need','let','got','did','does'];
    const words = text.split(/\s+/).filter(w => w.length > 1);
    if (words.length < 8) return false;
    let hits = 0;
    for (const w of words) { if (engWords.includes(w)) hits++; }
    return (hits / words.length) > 0.10;
  } catch (e) { return false; }
}

function hasEnglishFilenameMarker(filename) {
  const l = filename.toLowerCase();
  return l.includes('english') || l.match(/[\._-]eng[\._-]/) || l.match(/[\._-]en[\._-]/) ||
    l.match(/[\._-]eng\./) || l.match(/[\._-]en\./) || l.includes('.eng.') || l.includes('.en.');
}

function hasForeignFilenameMarker(filename) {
  const l = filename.toLowerCase();
  const foreign = ['arabic','chinese','czech','danish','dutch','finnish','french','german','greek',
    'hebrew','hindi','hungarian','indonesian','italian','japanese','korean','malay','norwegian',
    'persian','polish','portuguese','romanian','russian','spanish','swedish','tagalog','thai',
    'turkish','ukrainian','vietnamese','bengali','croatian','serbian','slovenian','bulgarian',
    '.chi.','.spa.','.fre.','.fra.','.ger.','.deu.','.ita.','.jpn.','.kor.','.ara.','.rus.',
    '.hin.','.tha.','.vie.','.pol.','.tur.','.dut.','.nld.','.swe.','.por.','.dan.','.fin.',
    '.nor.','.ces.','.hun.','.rom.','.heb.','.ind.','.msa.','.tgl.','.ukr.','.hrv.','.srp.',
    '.slv.','.bul.','.ell.','.ben.','.fas.','.zho.','.zht.'];
  for (const fp of foreign) if (l.includes(fp)) return true;
  return false;
}

function getSubTags(filename) {
  const l = filename.toLowerCase();
  const tags = [];
  if (l.includes('sdh') || l.match(/[\._-]sdh[\._-]/) || l.match(/[\._-]sdh\./)) tags.push('sdh');
  if ((l.match(/[\._-]hi[\._-]/) || l.match(/[\._-]hi\./)) && !l.includes('hindi')) tags.push('sdh');
  if (l.includes('.cc.') || l.match(/[\._-]cc[\._-]/) || l.match(/[\._-]cc\./)) tags.push('cc');
  if (l.includes('forced') || l.match(/[\._-]forc(ed)?[\._-]/)) tags.push('forced');
  return [...new Set(tags)];
}

// ========== Job processor ==========

async function processJob(job, store) {
  try {
    const steps = [];
    if (job.options.target === 'pc') {
      // MyPC mode: just send magnet to PC qBit
      steps.push('sending_to_pc');
    } else {
      // Media mode: full pipeline
      if (job.options.grabUrl) steps.push('grabbing');
      if (job.options.torrentHash || job.options.grabUrl) steps.push('waiting_torrent');
      steps.push('delivering');
    }

    let startIdx = 0;
    if (job.step) {
      const failedIdx = steps.indexOf(job.step);
      if (failedIdx >= 0) startIdx = failedIdx;
    }

    for (let i = startIdx; i < steps.length; i++) {
      const step = steps[i];
      if (job.status === 'cancelled') return;
      job.step = step; job.status = 'running'; job.progress = ''; broadcast();

      if (step === 'sending_to_pc') {
        job.progress = 'Sending to PC qBittorrent...';
        broadcast();
        await stepPcGrab(job, store);

      } else if (step === 'grabbing') {
        job.progress = 'Adding torrent to qBittorrent...';
        broadcast();
        const result = await _addAndDetect(store, ensureTrackers(job.options.grabUrl), job.name);
        if (!result.success) throw new Error('Failed to add torrent: ' + (result.error || 'Unknown'));
        if (!result.hash) throw new Error('Torrent added but could not detect hash');
        job.options.torrentHash = result.hash;
        job.name = result.name || job.name;
        if (job.options.longSeed && result.hash) {
          try {
            await _qbitRequest(store, '/api/v2/torrents/createCategory', 'POST', 'category=Long%20Seed&savePath=%2Fdownloads%2FLong%20Seed');
            await _qbitRequest(store, '/api/v2/torrents/setCategory', 'POST', `hashes=${result.hash}&category=Long%20Seed`);
          } catch (e) {}
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

      } else if (step === 'delivering') {
        await stepDeliver(job, store);
        // Auto-delete torrent from qBit (unless Long Seed)
        if (job.options.torrentHash) {
          try {
            const { base, ck } = await qbitAuth(store);
            const tr = await fetch(`${base}/api/v2/torrents/info?hashes=${job.options.torrentHash}`, { headers: { 'Cookie': ck } });
            const ts = await tr.json();
            if (ts.length && ts[0].category !== 'Long Seed') {
              await fetch(`${base}/api/v2/torrents/delete`, { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `hashes=${job.options.torrentHash}&deleteFiles=true` });
              console.log(`[pipeline] Auto-deleted torrent: ${job.name}`);
            }
          } catch (e) { console.log(`[pipeline] Failed to auto-delete: ${e.message}`); }
        }
      }
    }
    job.status = 'done'; job.step = 'complete'; job.progress = 'All steps complete';
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
    const job = {
      id: jobId++, name: opts.name || 'Unnamed', status: 'queued', step: '', progress: '', error: null,
      renamePreview: null, torrentFiles: null,
      options: {
        torrentHash: opts.torrentHash || null, localPath: null,
        grabUrl: opts.grabUrl || null, longSeed: opts.longSeed || false,
        target: opts.target || 'media',
        doRename: opts.doRename !== false,
        renameType: opts.renameType || 'movie', renameQuery: opts.renameQuery || '',
        renameDb: opts.renameDb || '', episodeOverrides: {},
        doMove: opts.doMove !== false, moveType: opts.moveType || 'movies'
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

  app.get('/status', (req, res) => {
    try { res.json({ status: 'ok', jobs: jobs.map(serializeJob) }); }
    catch (e) { res.json({ status: 'ok', jobs: [], error: e.message }); }
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
    j.status = 'queued'; j.error = null; j.progress = `Retrying from ${j.step}...`;
    broadcast();
    processJob(j, store);
    res.json({ success: true });
  });

  app.post('/api/pipeline/updateOptions', auth, async (req, res) => {
    const { id, options: opts } = req.body;
    const j = jobs.find(x => x.id === id);
    if (!j) return res.json({ success: false, error: 'Not found' });
    const STEPS = ['waiting_torrent', 'delivering', 'complete'];
    const ci = STEPS.indexOf(j.step);
    let changed = false;
    if (opts.renameType !== undefined && ci < STEPS.indexOf('delivering')) { j.options.renameType = opts.renameType; changed = true; }
    if (opts.renameQuery !== undefined && ci < STEPS.indexOf('delivering')) { j.options.renameQuery = opts.renameQuery; changed = true; }
    if (opts.renameDb !== undefined && ci < STEPS.indexOf('delivering')) { j.options.renameDb = opts.renameDb; changed = true; }
    if (opts.moveType !== undefined && ci < STEPS.indexOf('delivering')) { j.options.moveType = opts.moveType; }
    if (changed && j.options.doRename && j.torrentFiles && j.torrentFiles.length > 0) {
      await generatePreview(j, store, j.torrentFiles.map(f => f.name));
    }
    broadcast();
    res.json({ success: true });
  });

  app.post('/api/pipeline/clearFinished', auth, async (req, res) => {
    jobs = jobs.filter(j => j.status === 'queued' || j.status === 'running');
    broadcast();
    res.json({ success: true });
  });

  app.post('/auto-grab', auth, async (req, res) => {
    try {
      const { url, title, type } = req.body;
      if (!url) return res.status(400).json({ error: 'No URL provided' });
      const renameType = (type === 'tv') ? 'tv' : 'movie';
      const moveType = (type === 'tv') ? 'tv' : 'movies';
      const job = {
        id: jobId++, name: title || 'Auto Grab', status: 'queued', step: '', progress: '', error: null,
        renamePreview: null, torrentFiles: null,
        options: { torrentHash: null, localPath: null, grabUrl: url, longSeed: false,
          doRename: true, renameType, renameQuery: '', renameDb: '', episodeOverrides: {},
          doMove: true, moveType, target: 'media' }
      };
      jobs.push(job); broadcast();
      processJob(job, store);
      res.json({ success: true, message: `Queued: ${title}` });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { setupPipelineRoutes, getJobs: () => jobs.map(serializeJob) };

