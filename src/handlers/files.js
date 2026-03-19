// ═══════════════════════════════════════════════════════════════════
// Files Handler — REST API version
// Staging file listing and NAS move operations
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, hasForeignFilenameMarker, hasEnglishFilenameMarker } = require('media-manager-shared');

function isVid(f) { return VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()); }
function isEngSub(f) {
  const e = path.extname(f).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.includes(e)) return false;
  if (hasEnglishFilenameMarker(f)) return true;
  if (hasForeignFilenameMarker(f)) return false;
  return true;
}
function keep(f) { if (/sample/i.test(f)) return false; return isVid(f) || isEngSub(f); }

function filesRec(dir, base) {
  const r = [];
  if (!fs.existsSync(dir)) return r;
  base = base || dir;
  for (const i of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, i.name);
    if (i.isDirectory()) r.push(...filesRec(fp, base));
    else if (keep(i.name)) {
      const s = fs.statSync(fp);
      r.push({ name: i.name, path: fp, relativePath: path.relative(base, fp), size: s.size, type: isVid(i.name) ? 'video' : 'subtitle' });
    }
  }
  return r;
}

function asyncCopyFile(src, dest) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

function collectKeepFiles(srcPath) {
  const results = [];
  if (!fs.existsSync(srcPath)) return results;
  const stat = fs.statSync(srcPath);
  if (!stat.isDirectory()) {
    if (keep(path.basename(srcPath))) results.push({ src: srcPath, rel: path.basename(srcPath), size: stat.size });
    return results;
  }
  function walk(dir, relBase) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, item.name);
      const relPath = path.join(relBase, item.name);
      if (item.isDirectory()) walk(fullPath, relPath);
      else if (keep(item.name)) results.push({ src: fullPath, rel: relPath, size: fs.statSync(fullPath).size });
    }
  }
  walk(srcPath, '');
  return results;
}

function rmrf(d) {
  if (!fs.existsSync(d)) return;
  for (const i of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, i.name);
    i.isDirectory() ? rmrf(fp) : fs.unlinkSync(fp);
  }
  fs.rmdirSync(d);
}

function cleanEmpty(d) {
  if (!fs.existsSync(d)) return;
  for (const i of fs.readdirSync(d)) {
    const fp = path.join(d, i);
    if (fs.statSync(fp).isDirectory()) {
      cleanEmpty(fp);
      if (fs.readdirSync(fp).length === 0) fs.rmdirSync(fp);
    }
  }
}

function setupFilesRoutes(app, store, auth) {
  app.get('/api/files/listStaging', auth, async (req, res) => {
    try {
      const sp = store.get('paths.staging');
      if (!sp || !fs.existsSync(sp)) return res.json({ success: false, error: 'Staging not configured' });
      const top = fs.readdirSync(sp, { withFileTypes: true });
      const dirs = top.filter(d => d.isDirectory()).map(d => {
        const dp = path.join(sp, d.name), files = filesRec(dp, dp);
        return { name: d.name, path: dp, files, fileCount: files.length, totalSize: files.reduce((a, f) => a + f.size, 0), isFolder: true };
      }).filter(d => d.fileCount > 0);
      const loose = top.filter(f => f.isFile() && keep(f.name)).map(f => {
        const fp = path.join(sp, f.name), s = fs.statSync(fp);
        return { name: f.name, path: fp, size: s.size, type: isVid(f.name) ? 'video' : 'subtitle', isFolder: false };
      });
      res.json({ success: true, files: filesRec(sp, sp), dirs, looseFiles: loose });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/files/moveToNas', auth, async (req, res) => {
    try {
      const { paths: movePaths, type } = req.body;
      const pm = { movies: 'paths.nasMovies', tv: 'paths.nasTVShows', kidsMovies: 'paths.nasKidsMovies',
        asianMovies: 'paths.nasAsianMovies', asianShows: 'paths.nasAsianShows',
        animeMovies: 'paths.nasAnimeMovies', animeShows: 'paths.nasAnimeShows' };
      const np = store.get(pm[type]);
      if (!np) throw new Error(`NAS path for "${type}" not configured`);

      const allFiles = [];
      for (const ip of movePaths) {
        const baseName = path.basename(ip);
        const stat = fs.statSync(ip);
        if (stat.isDirectory()) {
          const files = collectKeepFiles(ip);
          allFiles.push(...files.map(f => ({ src: f.src, dest: path.join(np, baseName, f.rel), name: path.basename(f.rel), srcRoot: ip })));
        } else if (keep(baseName)) {
          allFiles.push({ src: ip, dest: path.join(np, baseName), name: baseName, srcRoot: null });
        }
      }

      let done = 0;
      for (const f of allFiles) {
        const destDir = path.dirname(f.dest);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        // Try rename first (instant on same filesystem)
        try {
          await fs.promises.rename(f.src, f.dest);
        } catch (renameErr) {
          if (renameErr.code !== 'EXDEV') throw renameErr;
          await asyncCopyFile(f.src, f.dest);
          fs.unlinkSync(f.src);
        }
        done++;
      }

      const srcRoots = [...new Set(allFiles.filter(f => f.srcRoot).map(f => f.srcRoot))];
      for (const d of srcRoots) { try { rmrf(d); } catch (x) {} }
      cleanEmpty(store.get('paths.staging'));

      res.json({ success: true, moved: done });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });
}

module.exports = { setupFilesRoutes };
