// ═══════════════════════════════════════════════════════════════
// App Shell — main container, PIN gate, navigation, view switching
// ═══════════════════════════════════════════════════════════════

class AppShell extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._currentView = 'search';
    this._authenticated = false;
    this._pinRequired = false;
    this._connected = null; // null=unknown, true, false
  }

  connectedCallback() {
    this._render();
    this._checkAuth();
  }

  // ── API helper shared across views ──────────────────────────
  static get pin() { return localStorage.getItem('mc-pin') || ''; }
  static set pin(v) { localStorage.setItem('mc-pin', v); }

  static headers() {
    const h = { 'Content-Type': 'application/json' };
    if (AppShell.pin) h['X-Pin'] = AppShell.pin;
    return h;
  }

  static async api(path, opts = {}) {
    try {
      const res = await fetch(path, { headers: AppShell.headers(), ...opts });
      if (!res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { error: `Server error ${res.status}: ${text}` }; }
      }
      return await res.json();
    } catch (e) {
      console.error('[api]', path, e);
      return { error: e.message || 'Network error' };
    }
  }

  static escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  static fmtSize(b) {
    if (!b) return '\u2014';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
  }

  static fmtSpeed(b) { return AppShell.fmtSize(b) + '/s'; }

  static fmtEta(seconds) {
    if (!seconds || seconds <= 0) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  static timeAgo(ts) {
    const d = Date.now() - new Date(ts).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }

  // ── Toast (dispatch custom event; shell renders it) ─────────
  static toast(msg, type = 'success') {
    window.dispatchEvent(new CustomEvent('mm-toast', { detail: { msg, type } }));
  }

  // ── Push notification state ─────────────────────────────────
  static pushSubscription = null;
  static pushVapidKey = null;

  static async initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const keyData = await AppShell.api('/companion/api/push/vapid-public-key');
      if (keyData.publicKey) AppShell.pushVapidKey = keyData.publicKey;
    } catch {}
    if (Notification.permission === 'granted') await AppShell.subscribePush();
  }

  static async subscribePush() {
    if (!AppShell.pushVapidKey) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const raw = atob(AppShell.pushVapidKey.replace(/-/g, '+').replace(/_/g, '/'));
      const key = new Uint8Array(raw.split('').map(c => c.charCodeAt(0)));
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      AppShell.pushSubscription = sub.toJSON();
    } catch (e) { console.warn('[push] Subscribe failed:', e); }
  }

  // ── Indexer preference ──────────────────────────────────────
  static getIndexer() { return localStorage.getItem('preferred_indexer') || 'extto'; }
  static setIndexer(id) {
    localStorage.setItem('preferred_indexer', id);
    window.dispatchEvent(new CustomEvent('mm-indexer-changed', { detail: { id } }));
  }

  // ── WebSocket — real-time pipeline updates ─────────────────
  static _ws = null;
  static _wsRetryTimer = null;

  static connectWebSocket() {
    if (AppShell._ws && AppShell._ws.readyState <= 1) return; // already open/connecting
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const pin = encodeURIComponent(AppShell.pin || '');
      AppShell._ws = new WebSocket(`${proto}//${location.host}/ws?pin=${pin}`);

      AppShell._ws.onopen = () => {
        console.log('[ws] Connected');
        if (AppShell._wsRetryTimer) { clearTimeout(AppShell._wsRetryTimer); AppShell._wsRetryTimer = null; }
      };

      AppShell._ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent('mm-ws-message', { detail: msg }));
        } catch {}
      };

      AppShell._ws.onclose = () => {
        console.log('[ws] Disconnected, retrying in 5s');
        AppShell._ws = null;
        AppShell._wsRetryTimer = setTimeout(() => AppShell.connectWebSocket(), 5000);
      };

      AppShell._ws.onerror = () => {
        AppShell._ws?.close();
      };
    } catch (e) {
      console.warn('[ws] Connect failed:', e);
    }
  }

  // ── Auth check ──────────────────────────────────────────────
  async _checkAuth() {
    const data = await AppShell.api('/companion/api/config');
    if (data.error && data.error === 'Invalid PIN') {
      this._pinRequired = true;
      this._authenticated = false;
      this._render();
      return;
    }
    this._authenticated = true;
    this._connected = !!data.configured;
    this._render();
    this._initAfterAuth();
  }

  async _initAfterAuth() {
    AppShell.initPush();
    AppShell.connectWebSocket();
  }

  _submitPin() {
    const input = this.shadowRoot.querySelector('#pinInput');
    if (!input) return;
    AppShell.pin = input.value.trim();
    this._checkAuth();
  }

  // ── Navigation ──────────────────────────────────────────────
  _switchView(name) {
    if (name === this._currentView) return;
    const oldView = this.shadowRoot.querySelector(`[data-view="${this._currentView}"]`);
    const newView = this.shadowRoot.querySelector(`[data-view="${name}"]`);
    if (oldView) {
      oldView.classList.add('view-exit');
      oldView.addEventListener('animationend', () => {
        oldView.classList.remove('view-exit', 'active');
      }, { once: true });
    }
    if (newView) {
      newView.classList.add('active', 'view-enter');
      newView.addEventListener('animationend', () => {
        newView.classList.remove('view-enter');
      }, { once: true });
    }
    this._currentView = name;

    // Update nav
    this.shadowRoot.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.view === name);
    });

    // Notify view it was activated
    const viewEl = newView && newView.querySelector('search-view, requests-view, top20-view, settings-view');
    if (viewEl && typeof viewEl.onActivated === 'function') viewEl.onActivated();

    // Deactivate old view
    const oldViewEl = oldView && oldView.querySelector('search-view, requests-view, top20-view, settings-view');
    if (oldViewEl && typeof oldViewEl.onDeactivated === 'function') oldViewEl.onDeactivated();
  }

  // ── Toast listener ──────────────────────────────────────────
  _setupToast() {
    window.addEventListener('mm-toast', (e) => {
      const { msg, type } = e.detail;
      const container = this.shadowRoot.querySelector('#toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.textContent = msg;
      container.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('toast-exit');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
      }, 3500);
    });
  }

  // ── Render ──────────────────────────────────────────────────
  _render() {
    if (this._pinRequired && !this._authenticated) {
      this._renderPinScreen();
      return;
    }
    if (!this._authenticated) {
      this._renderLoading();
      return;
    }
    this._renderApp();
  }

  _renderLoading() {
    this.shadowRoot.innerHTML = `
      <style>${AppShell._shellStyles()}</style>
      <div class="loading-screen">
        <div class="loading-logo">
          <mm-icon name="film" size="32"></mm-icon>
        </div>
        <div class="loading-text">Media Companion</div>
      </div>
    `;
  }

  _renderPinScreen() {
    this.shadowRoot.innerHTML = `
      <style>${AppShell._shellStyles()}</style>
      <div class="pin-screen">
        <div class="pin-card">
          <div class="pin-icon">
            <mm-icon name="film" size="40"></mm-icon>
          </div>
          <h2 class="pin-title">Media Companion</h2>
          <p class="pin-subtitle">Enter your PIN to continue</p>
          <div class="pin-input-wrap">
            <input
              id="pinInput"
              type="password"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="10"
              placeholder="PIN"
              autocomplete="off"
              class="pin-input"
            />
          </div>
          <button id="pinSubmit" class="pin-submit">Unlock</button>
        </div>
      </div>
    `;
    const btn = this.shadowRoot.querySelector('#pinSubmit');
    const input = this.shadowRoot.querySelector('#pinInput');
    btn.addEventListener('click', () => this._submitPin());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitPin(); });
    setTimeout(() => input.focus(), 100);
  }

  _renderApp() {
    this.shadowRoot.innerHTML = `
      <style>${AppShell._shellStyles()}</style>

      <div class="app-container">
        <!-- Header -->
        <header class="app-header">
          <div class="header-logo">
            <mm-icon name="film" size="20"></mm-icon>
          </div>
          <h1 class="header-title">Media Companion</h1>
          <div class="header-status">
            <span class="status-dot ${this._connected === true ? 'ok' : this._connected === false ? 'err' : 'unknown'}"></span>
          </div>
        </header>

        <!-- Views -->
        <div class="views-container">
          <div class="view active" data-view="search">
            <search-view></search-view>
          </div>
          <div class="view" data-view="requests">
            <requests-view></requests-view>
          </div>
          <div class="view" data-view="top20">
            <top20-view></top20-view>
          </div>
          <div class="view" data-view="settings">
            <settings-view></settings-view>
          </div>
        </div>

        <!-- Bottom Navigation -->
        <nav class="bottom-nav">
          <button class="nav-item active" data-view="search" aria-label="Search">
            <mm-icon name="search" size="22"></mm-icon>
            <span>Search</span>
          </button>
          <button class="nav-item" data-view="requests" aria-label="Requests">
            <mm-icon name="download" size="22"></mm-icon>
            <span>Requests</span>
          </button>
          <button class="nav-item" data-view="top20" aria-label="Top 20">
            <mm-icon name="star" size="22"></mm-icon>
            <span>Top 20</span>
          </button>
          <button class="nav-item" data-view="settings" aria-label="Settings">
            <mm-icon name="settings" size="22"></mm-icon>
            <span>Settings</span>
          </button>
        </nav>

        <!-- Toast container -->
        <div id="toast-container"></div>
      </div>
    `;

    // Wire up nav
    this.shadowRoot.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => this._switchView(btn.dataset.view));
    });

    // Toast listener
    this._setupToast();

    // Activate search view
    const searchView = this.shadowRoot.querySelector('search-view');
    if (searchView && typeof searchView.onActivated === 'function') {
      setTimeout(() => searchView.onActivated(), 50);
    }
  }

  static _shellStyles() {
    return `
      :host {
        display: block;
        min-height: 100dvh;
        background: var(--mm-bg-base, #08090d);
        color: var(--mm-text-primary, #e2e4ed);
        font-family: var(--mm-font-sans, -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif);
      }

      /* ── Loading Screen ──────────────────────────────────── */
      .loading-screen {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        min-height: 100dvh; gap: 16px;
      }
      .loading-logo {
        width: 64px; height: 64px; border-radius: 16px;
        background: var(--mm-accent-glow, rgba(108,92,231,0.18));
        display: flex; align-items: center; justify-content: center;
        color: var(--mm-accent, #6c5ce7);
        animation: pulse 2s ease-in-out infinite;
      }
      .loading-text {
        font-size: 18px; font-weight: 600; color: var(--mm-text-secondary, #8b8fa3);
      }

      /* ── PIN Screen ──────────────────────────────────────── */
      .pin-screen {
        display: flex; align-items: center; justify-content: center;
        min-height: 100dvh; padding: 24px;
      }
      .pin-card {
        width: 100%; max-width: 340px; text-align: center;
        background: var(--mm-bg-surface, #10121a);
        border: 1px solid var(--mm-border, #1e2030);
        border-radius: 20px; padding: 40px 32px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      }
      .pin-icon {
        width: 72px; height: 72px; border-radius: 18px;
        background: var(--mm-accent-glow, rgba(108,92,231,0.18));
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 20px; color: var(--mm-accent, #6c5ce7);
        animation: pinGlow 2.5s ease-in-out infinite;
      }
      .pin-title {
        font-size: 22px; font-weight: 700; margin-bottom: 6px;
        letter-spacing: -0.3px;
      }
      .pin-subtitle {
        font-size: 14px; color: var(--mm-text-secondary, #8b8fa3); margin-bottom: 28px;
      }
      .pin-input-wrap {
        margin-bottom: 16px;
      }
      .pin-input {
        width: 100%; padding: 16px; text-align: center;
        font-size: 24px; font-weight: 600; letter-spacing: 8px;
        font-family: inherit;
        background: var(--mm-bg-base, #08090d);
        border: 2px solid var(--mm-border, #1e2030);
        border-radius: 14px; color: var(--mm-text-primary, #e2e4ed);
        outline: none; transition: border-color 0.2s;
      }
      .pin-input:focus {
        border-color: var(--mm-accent, #6c5ce7);
        box-shadow: 0 0 0 4px var(--mm-accent-glow, rgba(108,92,231,0.18));
      }
      .pin-submit {
        width: 100%; padding: 14px; border: none; border-radius: 14px;
        background: var(--mm-accent, #6c5ce7); color: #fff;
        font-size: 16px; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
      }
      .pin-submit:active { transform: scale(0.97); opacity: 0.9; }

      @keyframes pinGlow {
        0%, 100% { box-shadow: 0 0 20px var(--mm-accent-glow, rgba(108,92,231,0.18)); }
        50% { box-shadow: 0 0 40px var(--mm-accent-glow, rgba(108,92,231,0.35)), 0 0 80px rgba(108,92,231,0.08); }
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      /* ── App Container ───────────────────────────────────── */
      .app-container {
        display: flex; flex-direction: column;
        height: 100dvh; overflow: hidden;
      }

      /* ── Header ──────────────────────────────────────────── */
      .app-header {
        display: flex; align-items: center; gap: 12px;
        padding: 14px 20px 10px; flex-shrink: 0;
      }
      .header-logo {
        width: 36px; height: 36px; border-radius: 10px;
        background: var(--mm-accent-glow, rgba(108,92,231,0.18));
        display: flex; align-items: center; justify-content: center;
        color: var(--mm-accent, #6c5ce7);
      }
      .header-title {
        font-size: 20px; font-weight: 700; letter-spacing: -0.3px; flex: 1;
      }
      .header-status { display: flex; align-items: center; }
      .status-dot {
        width: 8px; height: 8px; border-radius: 50%;
      }
      .status-dot.ok { background: var(--mm-success, #3fb950); box-shadow: 0 0 6px var(--mm-success, #3fb950); }
      .status-dot.err { background: var(--mm-danger, #f85149); }
      .status-dot.unknown { background: var(--mm-text-muted, #4a4d5e); }

      /* ── Views ───────────────────────────────────────────── */
      .views-container {
        flex: 1; overflow: hidden; position: relative;
      }
      .view {
        display: none; position: absolute; inset: 0;
        overflow: hidden; flex-direction: column;
      }
      .view.active {
        display: flex;
      }

      /* View transitions */
      .view.view-enter {
        animation: viewFadeIn 0.22s ease-out both;
      }
      .view.view-exit {
        display: flex;
        animation: viewFadeOut 0.15s ease-in both;
      }
      @keyframes viewFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes viewFadeOut {
        from { opacity: 1; }
        to   { opacity: 0; }
      }

      /* ── Bottom Nav ──────────────────────────────────────── */
      .bottom-nav {
        display: flex; justify-content: space-around; align-items: center;
        flex-shrink: 0;
        padding: 6px 0 calc(8px + env(safe-area-inset-bottom, 0px));
        background: rgba(8, 9, 13, 0.88);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        border-top: 1px solid rgba(255,255,255,0.06);
        z-index: 50;
      }
      .nav-item {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        padding: 6px 16px; border: none; background: none; cursor: pointer;
        color: var(--mm-text-muted, #4a4d5e); transition: color 0.15s;
        font-family: inherit;
      }
      .nav-item span {
        font-size: 10px; font-weight: 600; letter-spacing: 0.2px;
      }
      .nav-item.active {
        color: var(--mm-accent, #6c5ce7);
      }
      .nav-item:active { opacity: 0.6; }

      /* ── Toast ────────────────────────────────────────────── */
      #toast-container {
        position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
        z-index: 999; display: flex; flex-direction: column; gap: 8px;
        align-items: center; pointer-events: none;
      }
      .toast {
        padding: 12px 22px; border-radius: 12px; font-size: 13px; font-weight: 500;
        max-width: calc(100vw - 40px);
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        animation: toastIn 0.3s ease both;
        pointer-events: auto;
      }
      .toast-success { background: #122a1e; color: var(--mm-success, #3fb950); border: 1px solid rgba(63,185,80,0.25); }
      .toast-error   { background: #2a1218; color: var(--mm-danger, #f85149); border: 1px solid rgba(248,81,73,0.25); }
      .toast-info    { background: #121a2a; color: var(--mm-accent, #6c5ce7); border: 1px solid rgba(108,92,231,0.25); }
      .toast-exit {
        animation: toastOut 0.25s ease both;
      }
      @keyframes toastIn {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes toastOut {
        from { opacity: 1; }
        to   { opacity: 0; transform: translateY(-8px); }
      }
    `;
  }
}

customElements.define('app-shell', AppShell);
