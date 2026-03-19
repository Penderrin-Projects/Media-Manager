// ═══════════════════════════════════════════════════════════════════
// Pipeline Step: Torrent — hash resolution, file list, progress/ETA
// Extracted from pipeline.js stepTorrent()
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const { formatBytes: fmtB, formatDuration: fmtSec } = require('../../../utils');
const { normalizeName } = require('media-manager-shared');

/**
 * Wait for a torrent to finish downloading in qBittorrent.
 *
 * Resolves the torrent hash if not yet known (matches by name),
 * collects the file list for rename preview, tracks progress/ETA,
 * and pauses the torrent once complete (unless Long Seed).
 *
 * @param {Object} job - Pipeline job
 * @param {Object} store - Config store
 * @param {Function} broadcast - WebSocket broadcast function
 * @param {Object} helpers - { generatePreview }
 * @returns {boolean} true when torrent is 100% downloaded
 */
async function stepTorrent(job, store, broadcast, helpers) {
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
      if (job.options.doRename && job.torrentFiles.length > 0 && helpers.generatePreview) {
        await helpers.generatePreview(job, store, job.torrentFiles.map(f => f.name));
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
      try {
        await fetch(base + '/api/v2/torrents/pause', { method: 'POST', headers: { 'Cookie': ck, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'hashes=' + job.options.torrentHash });
        console.log('[pipeline] Paused torrent: ' + job.name);
      } catch (e) { console.log('[pipeline] Failed to pause: ' + e.message); }
    }
    return true;
  }

  // Calculate total ETA = qBit download ETA + post-download work estimate
  const sizeMB = (t.size || 0) / (1024 * 1024);
  const isTV = (job.options?.renameType === 'tv') || (job.options?.moveType === 'tv');
  const sftpSpeed = isTV ? 65 : 25;
  const sftpEst = Math.round(sizeMB / sftpSpeed);
  const fileCount = isTV ? Math.max(Math.round(sizeMB / 400), 1) : 1;
  const renameEst = 10 + (fileCount * 2);
  const moveEst = Math.round(sizeMB / 100);
  const postDlEst = sftpEst + renameEst + moveEst;
  const dlEta = (t.eta > 0 && t.eta < 8640000) ? t.eta : 0;
  const totalEta = dlEta > 0 ? dlEta + postDlEst : 0;
  const etaStr = totalEta > 0 ? ` — ETA ${fmtSec(totalEta)}` : '';
  job.progress = `Torrent: ${Math.round(t.progress * 100)}% — ↓ ${fmtB(t.dlspeed)}/s${etaStr}`;
  return false;
}

module.exports = { stepTorrent };
