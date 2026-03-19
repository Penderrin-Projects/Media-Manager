// ═══════════════════════════════════════════════════════════════════
// Media Manager Server — Headless Docker Edition
// Express REST API + WebSocket for real-time pipeline updates
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const webpush = require('web-push');

// Per-connection TLS bypass for self-signed certs (seedbox webUIs)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// ========== CREDENTIAL REDACTION ==========
function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
  const sensitiveKeys = ['password', 'apikey', 'api_key', 'token', 'pass', 'secret', 'smtp'];
  for (const key of Object.keys(redacted)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      redacted[key] = '***REDACTED***';
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactSensitive(redacted[key]);
    }
  }
  return redacted;
}

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
  seedbox: { qbitUrl: '', qbitUsername: '', qbitPassword: '', sftpHost: '', sftpPort: 22, sftpUsername: '', sftpPassword: '', sftpRemotePath: '' },
  paths: { staging: '/staging', nasMovies: '', nasTVShows: '', nasKidsMovies: '', nasAsianMovies: '', nasAsianShows: '', nasAnimeMovies: '', nasAnimeShows: '' },
  prowlarr: { url: '', apiKey: '' },
  tmdb: { apiKey: '' },
  plex: { url: '', token: '' },
  server: { port: 9876, apiKey: '', pin: '' },
  sms: { smtpUser: '', smtpPass: '' },
  directToPC: { enabled: false, localPath: '' }
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
// Provides the same .get()/.set() interface the handlers expect from electron-store
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

// ========== COMPANION: PIN AUTH & VAPID ==========
const { createAuthMiddleware: createPinAuth } = require('./src/companion/middleware/auth');

// Load or generate VAPID keys for web push
let vapidKeys;
const vapidPath = path.join(CONFIG_DIR, 'vapid.json');
try {
  vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(vapidPath, JSON.stringify(vapidKeys, null, 2));
  } catch (e) { log('warn', 'companion', 'Could not save VAPID keys:', e.message); }
}
webpush.setVapidDetails('mailto:media-companion@local', vapidKeys.publicKey, vapidKeys.privateKey);

// ========== EXPRESS APP ==========
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Companion PWA static files
app.use('/companion', express.static(path.join(__dirname, 'public', 'companion'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// TLS bypass is handled per-connection via insecureAgent (see top of file)

// ========== AUTH MIDDLEWARE ==========
function requireAuth(req, res, next) {
  const apiKey = config.server.apiKey;
  if (!apiKey) return next(); // no key = open access
  const provided = req.headers['x-api-key'];
  if (provided === apiKey) return next();
  res.status(401).json({ error: 'Invalid or missing API key' });
}

// ========== WEBSOCKET ==========
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const apiKey = config.server.apiKey;
  const pin = config.server.pin;

  // Accept either API key or PIN for auth
  const providedKey = url.searchParams.get('apiKey');
  const providedPin = url.searchParams.get('pin');

  if (apiKey || pin) {
    const keyOk = apiKey && providedKey === apiKey;
    const pinOk = pin && providedPin === pin;
    if (!keyOk && !pinOk) { ws.close(4001, 'Unauthorized'); return; }
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
const { setupSftpRoutes } = require('./src/handlers/sftp');
const { setupRenamerRoutes, buildRenamePlan, executeRenames, tmdbSearchApi, cleanForSearch, parseMediaFilename } = require('./src/handlers/renamer');
const { setupProwlarrRoutes } = require('./src/handlers/prowlarr');
const { setupTmdbRoutes } = require('./src/handlers/tmdb');
const { setupFilesRoutes } = require('./src/handlers/files');
const { setupPipelineRoutes, getJobs: getPipelineJobs } = require('./src/handlers/pipeline');
const { setupPlexRoutes } = require('./src/handlers/plex');
const { setupSmartGrabRoutes } = require('./src/handlers/smart-grab');

// ========== ROUTES ==========

// Health check
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', app: 'Media Manager Server', version: '2.1.0', uptime: process.uptime() });
});

// Settings
app.get('/api/settings', requireAuth, (req, res) => {
  // Redact sensitive fields
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.seedbox.qbitPassword) safe.seedbox.qbitPassword = '••••••';
  if (safe.seedbox.sftpPassword) safe.seedbox.sftpPassword = '••••••';
  if (safe.server.apiKey) safe.server.apiKey = '••••••';
  if (safe.sms && safe.sms.smtpPass) safe.sms.smtpPass = '••••••';
  res.json(safe);
});

app.get('/api/settings/raw', requireAuth, (req, res) => {
  res.json(redactSensitive(config));
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

// Diagnostics
app.get('/api/diagnostics', requireAuth, (req, res) => {
  const diag = {
    server: {
      version: '2.1.0',
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
      seedboxConfigured: !!config.seedbox.qbitUrl,
      sftpConfigured: !!config.seedbox.sftpHost,
      prowlarrConfigured: !!(config.prowlarr.url && config.prowlarr.apiKey),
      tmdbConfigured: !!config.tmdb.apiKey,
      stagingPath: config.paths.staging,
      stagingExists: fs.existsSync(config.paths.staging || ''),
      authEnabled: !!config.server.apiKey,
    },
    paths: {},
  };

  // Check all configured paths
  const pathKeys = Object.keys(config.paths);
  for (const key of pathKeys) {
    const p = config.paths[key];
    if (p) {
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

app.get('/api/test/sftp', requireAuth, async (req, res) => {
  const SftpClient = require('ssh2-sftp-client');
  const sftp = new SftpClient();
  try {
    const s = config.seedbox;
    await sftp.connect({ host: s.sftpHost, port: s.sftpPort || 22, username: s.sftpUsername, password: s.sftpPassword });
    await sftp.end();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/test/prowlarr', requireAuth, async (req, res) => {
  try {
    const cfg = config.prowlarr;
    if (!cfg.url || !cfg.apiKey) throw new Error('Prowlarr not configured');
    const r = await fetch(`${cfg.url.replace(/\/$/, '')}/api/v1/system/status`, {
      headers: { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error(`Prowlarr ${r.status}`);
    const data = await r.json();
    res.json({ success: true, version: data.version });
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

// Logs endpoint - return recent console output
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

// ========== MOUNT HANDLER ROUTES ==========
setupQbitRoutes(app, store, requireAuth);
setupSftpRoutes(app, store, requireAuth);
setupRenamerRoutes(app, store, requireAuth);
setupProwlarrRoutes(app, store, requireAuth);
setupTmdbRoutes(app, store, requireAuth);
setupFilesRoutes(app, store, requireAuth);
setupPipelineRoutes(app, store, requireAuth, broadcast, { qbitRequest, addAndDetect, buildRenamePlan, executeRenames, tmdbSearchApi, cleanForSearch, parseMediaFilename });
setupPlexRoutes(app, store, requireAuth, getPipelineJobs);
setupSmartGrabRoutes(app, store, requireAuth);

// ========== SMS (Server-side SMTP) ==========
const nodemailer = require('nodemailer');

app.post('/api/sms/send', requireAuth, async (req, res) => {
  try {
    const { phone, carrier, message } = req.body;
    if (!phone || !carrier || !message) return res.status(400).json({ error: 'phone, carrier, and message required' });
    const smtpUser = process.env.SMTP_USER || config.sms.smtpUser;
    const smtpPass = process.env.SMTP_PASS || config.sms.smtpPass;
    if (!smtpUser || !smtpPass) return res.status(500).json({ error: 'SMTP credentials not configured — set them in Media Manager settings' });
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: smtpUser, pass: smtpPass } });
    await transporter.sendMail({ from: `"Media Manager" <${smtpUser}>`, to: `${phone}@${carrier}`, subject: '', text: message });
    log('info', 'sms', `Sent to ${phone}@${carrier}`);
    res.json({ success: true });
  } catch (e) {
    log('error', 'sms', 'Send failed:', e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/sms/test', requireAuth, async (req, res) => {
  try {
    const { phone, carrier } = req.body;
    if (!phone || !carrier) return res.json({ success: false, error: 'Phone and carrier required' });
    const smtpUser = process.env.SMTP_USER || config.sms.smtpUser;
    const smtpPass = process.env.SMTP_PASS || config.sms.smtpPass;
    if (!smtpUser || !smtpPass) return res.json({ success: false, error: 'SMTP not configured in settings' });
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: smtpUser, pass: smtpPass } });
    await transporter.sendMail({ from: `"Media Manager" <${smtpUser}>`, to: `${phone}@${carrier}`, subject: '', text: '📺 Test from Media Manager — SMS notifications working!' });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== MAGNET RECEIVE (Chrome Extension compatibility) ==========
app.post('/magnet', (req, res) => {
  const { magnet, title, longSeed } = req.body;
  if (!magnet) return res.status(400).json({ error: 'No magnet provided' });
  log('info', 'magnet', `Received: ${title || 'unknown'} | longSeed: ${!!longSeed}`);
  broadcast('magnet:received', { magnet, title: title || '', longSeed: !!longSeed });
  res.json({ success: true, message: 'Magnet received' });
});

// ========== COMPANION ROUTES ==========
const companionAuth = createPinAuth(() => store.get('server.pin') || process.env.PIN || '');
const PORT = parseInt(process.env.PORT) || config.server.port || 9876;
const companionConfig = {
  ...config,
  configDir: CONFIG_DIR,
  vapidKeys,
  internalBaseUrl: `http://127.0.0.1:${PORT}`,
};

const searchRoutes = require('./src/companion/routes/search');
const mediaRoutes = require('./src/companion/routes/media');
const topRoutes = require('./src/companion/routes/top');
const configRoutes = require('./src/companion/routes/config');
const plexCompanionRoutes = require('./src/companion/routes/plex');

app.use('/companion/api', searchRoutes(companionConfig, companionAuth));
app.use('/companion/api', mediaRoutes(companionConfig, companionAuth));
app.use('/companion/api', topRoutes(companionConfig, companionAuth));
app.use('/companion/api', configRoutes(companionConfig, companionAuth, { saveConfig, vapidKeys }));
app.use('/companion/api', plexCompanionRoutes(companionConfig, companionAuth));

// Companion health
app.get('/companion/api/health', (req, res) => res.json({ status: 'ok', mode: 'integrated' }));

// PWA fallback — any /companion/* route serves index.html
app.get('/companion/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'companion', 'index.html'));
});

// ========== HELPERS ==========
const { formatBytes, formatUptime } = require('./src/utils');

// ========== START ==========
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'server', '═══════════════════════════════════════════');
  log('info', 'server', '  Media Manager Server v2.1.0');
  log('info', 'server', `  API:       http://0.0.0.0:${PORT}/api`);
  log('info', 'server', `  Admin:     http://0.0.0.0:${PORT}/admin`);
  log('info', 'server', `  Companion: http://0.0.0.0:${PORT}/companion`);
  log('info', 'server', `  WebSocket: ws://0.0.0.0:${PORT}/ws`);
  log('info', 'server', `  Auth:      ${config.server.apiKey ? 'API Key' : 'Open'} | PIN: ${config.server.pin ? 'Set' : 'None'}`);
  log('info', 'server', `  Config:    ${CONFIG_PATH}`);
  log('info', 'server', `  Staging:   ${config.paths.staging}`);
  log('info', 'server', '═══════════════════════════════════════════');
});

module.exports = { app, server, store, broadcast, log, insecureAgent };
