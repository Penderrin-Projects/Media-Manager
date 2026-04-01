// ═══════════════════════════════════════════════════════════════════
// Media Manager Server — Headless Docker Edition (Slim)
// Express REST API + WebSocket for real-time pipeline updates
// Stripped: prowlarr, sftp, search, top20 (now handled by Radarr/Sonarr)
// Kept: qbit, renamer, tmdb, files, pipeline (manual grab workflow)
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ========== LOGGING ==========
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? 2;

function log(level, tag, msg, data) {
  if (LOG_LEVELS[level] > LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  if (data !== undefined) console.log(`${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data) : data);
  else console.log(`${prefix} ${msg}`);
}

// ========== CONFIG ==========
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  seedbox: { qbitUrl: '', qbitUsername: '', qbitPassword: '', localDownloadPath: '' },
  paths: { libraries: [
    { name: 'Movies', path: '', isShows: false },
    { name: 'TV Shows', path: '', isShows: true }
  ] },
  tmdb: { apiKey: '' },
  pcQbit: { url: '', username: '', password: '' },
  server: { port: 9876, apiKey: '' }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Deep merge with defaults
      const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      for (const section of Object.keys(merged)) {
        if (data[section] && typeof data[section] === 'object') {
          Object.assign(merged[section], data[section]);
        } else if (data[section] !== undefined) {
          merged[section] = data[section];
        }
      }
      // Preserve any extra top-level keys (libraries, plex, pipeline_queue, etc.)
      for (const key of Object.keys(data)) {
        if (!(key in merged)) merged[key] = data[key];
      }
      return merged;
    }
  } catch (e) { log('error', 'config', 'Failed to load config:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    log('info', 'config', 'Config saved');
  } catch (e) { log('error', 'config', 'Failed to save config:', e.message); }
}

let config = loadConfig();
if (!fs.existsSync(CONFIG_PATH)) saveConfig(config);

// ========== CONFIG STORE ADAPTER ==========
const store = {
  get(key) {
    if (!key) return config;
    const parts = key.split('.');
    let val = config;
    for (const p of parts) {
      if (val === undefined || val === null) return undefined;
      val = val[p];
    }
    return val;
  },
  set(key, value) {
    const parts = key.split('.');
    let obj = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    saveConfig(config);
  },
  get store() { return config; }
};

// ========== EXPRESS APP ==========
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Allow self-signed certs (common on seedbox webUIs)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ========== AUTH MIDDLEWARE ==========
function requireAuth(req, res, next) {
  const apiKey = config.server.apiKey;
  if (!apiKey) return next(); // no key = open access
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided === apiKey) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// ========== WEBSOCKET ==========
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();
wss.on('connection', (ws, req) => {
  const apiKey = config.server.apiKey;
  if (apiKey) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const provided = url.searchParams.get('apiKey');
    if (provided !== apiKey) { ws.close(4001, 'Unauthorized'); return; }
  }
  wsClients.add(ws);
  log('info', 'ws', `Client connected (${wsClients.size} total)`);
  ws.on('close', () => { wsClients.delete(ws); });
  ws.on('error', () => { wsClients.delete(ws); });
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const ws of wsClients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  }
}

// ========== LOAD HANDLERS ==========
const { setupQbitRoutes, qbitRequest, addAndDetect } = require('./src/handlers/qbit');
const { setupRenamerRoutes, buildRenamePlan, executeRenames, tmdbSearchApi, cleanForSearch, parseMediaFilename } = require('./src/handlers/renamer');
const { setupTmdbRoutes } = require('./src/handlers/tmdb');
const { setupFilesRoutes } = require('./src/handlers/files');
const { setupPipelineRoutes } = require('./src/handlers/pipeline');

// ========== ROUTES ==========

// Health check
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', app: 'Media Manager Server', version: '3.1.0', uptime: process.uptime() });
});

// Settings
app.get('/api/settings', requireAuth, (req, res) => {
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.seedbox?.qbitPassword) safe.seedbox.qbitPassword = '••••••';
  if (safe.server?.apiKey) safe.server.apiKey = '••••••';
  res.json(safe);
});

app.get('/api/settings/raw', requireAuth, (req, res) => {
  res.json(config);
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  store.set(key, value);
  res.json({ success: true });
});

app.put('/api/settings/bulk', requireAuth, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Object required' });
  for (const [key, value] of Object.entries(updates)) {
    store.set(key, value);
  }
  res.json({ success: true });
});

// Browse directories (for library path picker)
app.get('/api/browse-dirs', requireAuth, (req, res) => {
  const base = req.query.path || '/media';
  try {
    if (!fs.existsSync(base)) return res.json({ success: false, error: 'Path not found' });
    const entries = fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, path: path.join(base, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, path: base, dirs: entries });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Libraries list (convenience for desktop app / API consumers)
app.get('/api/libraries', requireAuth, (req, res) => {
  const libs = config.paths.libraries || [];
  res.json({ success: true, libraries: libs });
});

// Diagnostics
app.get('/api/diagnostics', requireAuth, (req, res) => {
  const diag = {
    server: {
      version: '3.1.0',
      uptime: Math.round(process.uptime()),
      uptimeStr: formatUptime(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      memory: {
        rss: formatBytes(process.memoryUsage().rss),
        heapUsed: formatBytes(process.memoryUsage().heapUsed),
        heapTotal: formatBytes(process.memoryUsage().heapTotal),
      },
    },
    system: {
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: formatBytes(os.totalmem()),
      freeMemory: formatBytes(os.freemem()),
      loadAvg: os.loadavg().map(l => l.toFixed(2)),
    },
    connections: {
      wsClients: wsClients.size,
    },
    config: {
      qbitConfigured: !!config.seedbox.qbitUrl,
      tmdbConfigured: !!config.tmdb.apiKey,
      authEnabled: !!config.server.apiKey,
    },
    paths: {},
  };

  // Library paths
  const libs = config.paths.libraries || [];
  for (const lib of libs) {
    if (lib && lib.path) {
      const key = lib.name || 'unknown';
      diag.paths[key] = { path: lib.path, exists: fs.existsSync(lib.path), writable: false };
      try { fs.accessSync(lib.path, fs.constants.W_OK); diag.paths[key].writable = true; } catch (e) {}
    }
  }

  // Legacy flat keys (backwards compat)
  const pathKeys = Object.keys(config.paths);
  for (const key of pathKeys) {
    const p = config.paths[key];
    if (p && typeof p === 'string' && key !== 'staging') {
      diag.paths[key] = { path: p, exists: fs.existsSync(p), writable: false };
      try { fs.accessSync(p, fs.constants.W_OK); diag.paths[key].writable = true; } catch (e) {}
    }
  }

  res.json(diag);
});

// Connectivity tests
app.get('/api/test/qbit', requireAuth, async (req, res) => {
  try {
    const r = await qbitRequest(store, '/api/v2/app/version');
    const version = await r.text();
    res.json({ success: true, version });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/test/tmdb', requireAuth, async (req, res) => {
  try {
    const apiKey = config.tmdb.apiKey;
    if (!apiKey) throw new Error('TMDB API key not set');
    const r = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    res.json({ success: true, version: 'TMDB API v3' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Logs endpoint
const logBuffer = [];
const MAX_LOGS = 500;
const origLog = console.log;
const origError = console.error;
console.log = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  logBuffer.push({ ts: Date.now(), level: 'info', msg: line });
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  origLog.apply(console, args);
};
console.error = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  logBuffer.push({ ts: Date.now(), level: 'error', msg: line });
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  origError.apply(console, args);
};

app.get('/api/logs', requireAuth, (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const level = req.query.level || 'all';
  let logs = logBuffer.filter(l => l.ts > since);
  if (level !== 'all') logs = logs.filter(l => l.level === level);
  res.json({ logs, count: logs.length });
});


// ========== ADMIN UI ==========
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// PC qBit connectivity test
app.get('/api/test/pcqbit', requireAuth, async (req, res) => {
  try {
    const pc = config.pcQbit;
    if (!pc || !pc.url) throw new Error('PC qBit not configured');
    const base = pc.url.replace(/\/$/, '');
    const lr = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(pc.username || '')}&password=${encodeURIComponent(pc.password || '')}` });
    const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
    const vr = await fetch(`${base}/api/v2/app/version`, { headers: { 'Cookie': ck } });
    const version = await vr.text();
    res.json({ success: true, version });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ========== MOUNT HANDLER ROUTES ==========
setupQbitRoutes(app, store, requireAuth);
setupRenamerRoutes(app, store, requireAuth);
setupTmdbRoutes(app, store, requireAuth);
setupFilesRoutes(app, store, requireAuth);
setupPipelineRoutes(app, store, requireAuth, broadcast, { qbitRequest, addAndDetect, buildRenamePlan, executeRenames, tmdbSearchApi, cleanForSearch, parseMediaFilename });

// ========== MAGNET RECEIVE (Chrome Extension compatibility) ==========
app.post('/magnet', (req, res) => {
  const { magnet, title, longSeed } = req.body;
  if (!magnet) return res.status(400).json({ error: 'No magnet provided' });
  log('info', 'magnet', `Received: ${title || 'unknown'} | longSeed: ${!!longSeed}`);
  broadcast('magnet:received', { magnet, title: title || '', longSeed: !!longSeed });
  res.json({ success: true, message: 'Magnet received' });
});

// ========== HELPERS ==========
function formatBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(b)) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function formatUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ========== START ==========
const PORT = parseInt(process.env.PORT) || config.server.port || 9876;

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'server', '═══════════════════════════════════════════');
  log('info', 'server', '  Media Manager Server v3.1.0');
  log('info', 'server', `  API:       http://0.0.0.0:${PORT}`);
  log('info', 'server', `  WebSocket: ws://0.0.0.0:${PORT}/ws`);
  log('info', 'server', `  Auth:      ${config.server.apiKey ? 'Enabled' : 'Open (no API key set)'}`);
  log('info', 'server', `  Config:    ${CONFIG_PATH}`);
  log('info', 'server', `  Admin:     http://0.0.0.0:${PORT}/admin`);
  log('info', 'server', '  Mode:      Slim (manual grabs only)');
  log('info', 'server', '═══════════════════════════════════════════');
});

module.exports = { app, server, store, broadcast, log };

