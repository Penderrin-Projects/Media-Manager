// ═══════════════════════════════════════════════════════════════════
// Shared utility functions for Media Manager
// ═══════════════════════════════════════════════════════════════════

function formatBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(b)) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function formatDuration(s) {
  if (!s || s <= 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

/**
 * Recursively walk a remote SFTP directory and collect all file paths with sizes.
 * @param {SftpClient} sftp - connected SFTP client
 * @param {string} remotePath - remote directory to walk
 * @param {string} localBase - corresponding local base path
 * @returns {Promise<Array<{remote, local, name, size}>>}
 */
async function collectRemoteFiles(sftp, remotePath, localBase) {
  const path = require('path');
  const result = [];
  const items = await sftp.list(remotePath);
  for (const item of items) {
    const rp = `${remotePath}/${item.name}`;
    const lp = path.join(localBase, item.name);
    if (item.type === 'd') {
      const subFiles = await collectRemoteFiles(sftp, rp, lp);
      result.push(...subFiles);
    } else {
      result.push({ remote: rp, local: lp, name: item.name, size: item.size });
    }
  }
  return result;
}

module.exports = { formatBytes, formatDuration, formatUptime, collectRemoteFiles };
