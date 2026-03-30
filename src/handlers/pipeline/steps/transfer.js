// ═══════════════════════════════════════════════════════════════════
// Pipeline Step: Transfer — SFTP concurrent file downloads
// Extracted from pipeline.js stepTransfer()
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const SftpClient = require('ssh2-sftp-client');
const { collectRemoteFiles } = require('../../../utils');

const MAX_CONCURRENT = 10;

/**
 * Transfer files from seedbox via SFTP using a concurrent worker pool.
 *
 * Opens a scout connection to collect the file list, then launches up to
 * MAX_CONCURRENT workers that each maintain their own SFTP connection and
 * pull files in parallel. Progress is broadcast to WebSocket clients.
 *
 * @param {Object} job - Pipeline job
 * @param {Object} store - Config store
 * @param {Function} broadcast - WebSocket broadcast function
 * @param {Object} helpers - (unused, reserved for future injection)
 */
async function stepTransfer(job, store, broadcast, helpers) {
  const s = store.get('seedbox'), sp = store.get('paths.staging');
  if (!sp) throw new Error('Staging not configured');
  // Each job gets its own staging subfolder to avoid conflicts
  const jobStaging = path.join(sp, `job-${job.id}`);
  if (!fs.existsSync(jobStaging)) fs.mkdirSync(jobStaging, { recursive: true, mode: 0o777 });
  job.options.stagingPath = jobStaging;

  // First connection: collect file list
  const scout = new SftpClient();
  await scout.connect({ host: s.sftpHost, port: s.sftpPort || 22, username: s.sftpUsername, password: s.sftpPassword, readyTimeout: 20000, algorithms: { compress: ['none'] } });
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
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
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
    await conn.connect({ host: s.sftpHost, port: s.sftpPort || 22, username: s.sftpUsername, password: s.sftpPassword, readyTimeout: 20000, algorithms: { compress: ['none'] } });

    while (fileIdx < files.length && job.status !== 'cancelled') {
      const idx = fileIdx++;
      if (idx >= files.length) break;
      const f = files[idx];
      let pB = 0, pT = Date.now();
      activeSlots[workerId] = { file: f.name, transferred: 0, total: f.size, percent: 0, speed: 0 };
      throttleBroadcast();

      await conn.fastGet(f.remote, f.local, {
        chunkSize: 65536,   // 64KB — matches PACKET_SIZE
        concurrency: 8,     // 8 parallel reads — seedbox max
        step: (x) => {
          const n = Date.now(), dt = (n - pT) / 1000;
          const spd = dt > 0 ? (x - pB) / dt : 0;
          pB = x; pT = n;
          activeSlots[workerId] = { file: f.name, transferred: x, total: f.size, percent: Math.round((x / f.size) * 100), speed: spd };
          throttleBroadcast();
        }
      });
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

module.exports = { stepTransfer };
