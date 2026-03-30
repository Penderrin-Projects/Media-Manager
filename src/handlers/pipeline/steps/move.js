// ═══════════════════════════════════════════════════════════════════
// Pipeline Step: Move — subtitle detection, path determination,
// file moving with cross-device fallback
// Extracted from pipeline.js stepMove()
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, isForeignRelease, hasEnglishFilenameMarker, hasForeignFilenameMarker } = require('media-manager-shared');

function isVid(f) { return VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()); }
function isSub(f) { return SUBTITLE_EXTENSIONS.includes(path.extname(f).toLowerCase()); }

/**
 * Recursively remove empty directories.
 */
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

/**
 * Async file copy with progress callback.
 */
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

/**
 * Detect English by scanning subtitle file content.
 */
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

function isForced(filename) {
  const l = filename.toLowerCase();
  return l.includes('forced') || l.match(/[\._-]forc(ed)?[\._-]/);
}

/**
 * Extract subtitle tags (SDH, HI, CC, forced) from filename.
 */
function getSubTags(filename) {
  const l = filename.toLowerCase();
  const tags = [];
  if (l.includes('sdh') || l.match(/[\._-]sdh[\._-]/) || l.match(/[\._-]sdh\./)) tags.push('sdh');
  if ((l.match(/[\._-]hi[\._-]/) || l.match(/[\._-]hi\./)) && !l.includes('hindi')) tags.push('sdh');
  if (l.includes('.cc.') || l.match(/[\._-]cc[\._-]/) || l.match(/[\._-]cc\./)) tags.push('cc');
  if (isForced(filename)) tags.push('forced');
  return [...new Set(tags)];
}

/**
 * Move renamed files from staging to the NAS destination.
 *
 * Detects English subtitles (by filename markers then content scanning),
 * determines the correct NAS path based on content type, and moves files
 * using rename (fast, same filesystem) with copy+delete fallback for
 * cross-device moves.
 *
 * @param {Object} job - Pipeline job
 * @param {Object} store - Config store
 * @param {Function} broadcast - WebSocket broadcast function
 * @param {Object} helpers - (unused, reserved for future injection)
 */
async function stepMove(job, store, broadcast, helpers) {
  const sp = job.options.stagingPath || store.get('paths.staging');
  const pm = { movies: 'paths.nasMovies', tv: 'paths.nasTVShows', kidsMovies: 'paths.nasKidsMovies',
    asianMovies: 'paths.nasAsianMovies', asianShows: 'paths.nasAsianShows',
    animeMovies: 'paths.nasAnimeMovies', animeShows: 'paths.nasAnimeShows' };
  const np = store.get(pm[job.options.moveType]);
  if (!np) throw new Error(`NAS path for "${job.options.moveType}" not configured`);
  if (!fs.existsSync(sp)) throw new Error('Staging empty');

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

    // Sort: forced first, then by name
    const forced = matchedSubs.filter(s => isForced(s.name));
    const nonForced = matchedSubs.filter(s => !isForced(s.name));

    const usedNames = new Set();
    function buildSubName(sub, forceForced) {
      const subExt = path.extname(sub.name);
      const tags = getSubTags(sub.name);
      if (forceForced && !tags.includes('forced')) tags.unshift('forced');
      if (forceForced) {
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
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true, mode: 0o777 });

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

module.exports = { stepMove };
