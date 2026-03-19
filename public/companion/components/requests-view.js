// ═══════════════════════════════════════════════════════════════
// Requests View — pipeline status cards with live progress
// ═══════════════════════════════════════════════════════════════

class RequestsView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._uiInterval = null;       // 1s UI countdown
    this._fallbackInterval = null;  // 30s fallback poll
    this._lastData = null;
    this._lastFetch = 0;
    this._fetchPending = false;
    this._wsHandler = (e) => this._onWsMessage(e.detail);
  }

  connectedCallback() {
    this._render();
  }

  onActivated() {
    this._start();
  }

  onDeactivated() {
    this._stop();
  }

  _start() {
    // Fetch immediately on activation
    this._fetchFromServer();

    // UI refresh every 1s (local ETA countdown only, no server calls)
    if (!this._uiInterval) {
      this._uiInterval = setInterval(() => this._renderData(), 1000);
    }

    // Fallback server poll every 30s in case WS is down
    if (!this._fallbackInterval) {
      this._fallbackInterval = setInterval(() => this._fetchFromServer(), 30000);
    }

    // Listen for WebSocket pipeline updates
    window.addEventListener('mm-ws-message', this._wsHandler);
  }

  _stop() {
    if (this._uiInterval) { clearInterval(this._uiInterval); this._uiInterval = null; }
    if (this._fallbackInterval) { clearInterval(this._fallbackInterval); this._fallbackInterval = null; }
    window.removeEventListener('mm-ws-message', this._wsHandler);
  }

  _onWsMessage(msg) {
    if (msg.type === 'pipeline:update') {
      // Pipeline state changed — fetch enriched data from server
      this._fetchFromServer();
    }
  }

  async _fetchFromServer() {
    if (this._fetchPending) return;
    this._fetchPending = true;
    try {
      const data = await AppShell.api('/companion/api/requests');
      if (data.success) {
        this._lastData = data;
        this._lastFetch = Date.now();
        this._renderData();
      }
    } catch (e) {
      const container = this.shadowRoot.querySelector('#requestsList');
      if (!this._lastData && container) {
        container.innerHTML = '<div class="empty-state"><mm-icon name="alert-triangle" size="40"></mm-icon><p>Could not load requests</p></div>';
      }
    } finally {
      this._fetchPending = false;
    }
  }

  _renderData() {
    const container = this.shadowRoot.querySelector('#requestsList');
    if (!container) return;
    const now = Date.now();

    const data = this._lastData;
    if (!data || !data.success || !data.requests || !data.requests.length) {
      container.innerHTML = `
        <div class="empty-state">
          <mm-icon name="download" size="48"></mm-icon>
          <p class="empty-title">No requests yet</p>
          <p class="empty-sub">Search for something and tap Get</p>
        </div>
      `;
      return;
    }

    const elapsed = Math.floor((now - this._lastFetch) / 1000);
    const adjEta = (eta) => Math.max(0, (eta || 0) - elapsed);
    const esc = AppShell.escHtml;
    const fmtEta = AppShell.fmtEta;
    const fmtSize = AppShell.fmtSize;
    const fmtSpeed = AppShell.fmtSpeed;
    const timeAgo = AppShell.timeAgo;

    const PIPELINE_STEPS = ['Download', 'Transfer', 'Rename', 'Move'];

    container.innerHTML = data.requests.map(r => {
      const live = r.live;
      const eta = live ? adjEta(live.etaToPlex) : 0;

      // Determine current step index and status
      let stepIndex = -1;
      let statusLabel = 'Queued';
      let statusColor = 'var(--mm-text-secondary)';
      let progress = 0;
      let showProgress = false;
      let etaText = '';
      let speedText = '';
      let isCompleted = false;
      let isFailed = false;

      if (live) {
        if (live.completed) {
          isCompleted = true;
          stepIndex = 4;
          statusLabel = 'In Plex';
          statusColor = 'var(--mm-success, #3fb950)';
        } else if (live.pipelineStep === 'Failed') {
          isFailed = true;
          statusLabel = 'Failed';
          statusColor = 'var(--mm-danger, #f85149)';
        } else if (live.pipelineStep === 'Downloading') {
          stepIndex = 0;
          progress = live.progress || 0;
          showProgress = true;
          statusLabel = `Downloading ${progress}%`;
          statusColor = 'var(--mm-accent, #6c5ce7)';
          if (live.dlspeed > 0) speedText = fmtSpeed(live.dlspeed);
          etaText = fmtEta(eta) || '...';
        } else if (live.pipelineStep === 'Starting') {
          stepIndex = 0;
          statusLabel = 'Starting';
          statusColor = 'var(--mm-accent, #6c5ce7)';
          etaText = fmtEta(eta) || '...';
        } else if (live.pipelineStep === 'Transferring') {
          stepIndex = 1;
          progress = 100;
          showProgress = true;
          statusLabel = 'Transferring';
          statusColor = 'var(--mm-warning, #d29922)';
          etaText = fmtEta(eta) || '...';
        } else if (live.pipelineStep === 'Waiting for transfer') {
          stepIndex = 1;
          statusLabel = 'Queued for Transfer';
          statusColor = 'var(--mm-warning, #d29922)';
          etaText = fmtEta(eta) || '...';
        } else if (live.pipelineStep === 'Renaming') {
          stepIndex = 2;
          statusLabel = 'Renaming';
          statusColor = 'var(--mm-warning, #d29922)';
          etaText = fmtEta(eta) || '<1m';
        } else if (live.pipelineStep === 'Moving to NAS') {
          stepIndex = 3;
          statusLabel = 'Moving to NAS';
          statusColor = 'var(--mm-warning, #d29922)';
          etaText = fmtEta(eta) || '<30s';
        } else if (live.pipelineStep === 'Processing') {
          stepIndex = 2;
          statusLabel = 'Processing';
          statusColor = 'var(--mm-warning, #d29922)';
          etaText = fmtEta(eta) || '...';
        }
      }

      // Pipeline step dots
      const stepDots = PIPELINE_STEPS.map((name, i) => {
        let cls = 'step-dot';
        if (isCompleted || i < stepIndex) cls += ' completed';
        else if (i === stepIndex) cls += ' active';
        return `<div class="step-wrap">
          <div class="${cls}"></div>
          <span class="step-label">${name}</span>
        </div>`;
      }).join('<div class="step-line"></div>');

      return `
        <div class="request-card ${isCompleted ? 'completed' : ''} ${isFailed ? 'failed' : ''}">
          <div class="request-header">
            <div class="request-title-row">
              <span class="request-title">${esc(r.title)}</span>
              ${r.year ? `<span class="request-year">(${r.year})</span>` : ''}
            </div>
            <div class="request-badges">
              <span class="badge" style="color:${statusColor}">${esc(statusLabel)}</span>
              ${r.quality ? `<span class="badge badge-quality">${esc(r.quality)}</span>` : ''}
            </div>
          </div>

          ${showProgress ? `
            <div class="progress-bar">
              <div class="progress-fill" style="width:${progress}%; background:${stepIndex === 0 ? 'var(--mm-accent, #6c5ce7)' : 'var(--mm-warning, #d29922)'}"></div>
            </div>
          ` : ''}

          <div class="pipeline-steps">${stepDots}</div>

          <div class="request-footer">
            <div class="footer-left">
              ${speedText ? `<span class="speed">${speedText}</span>` : ''}
              <span class="meta">${fmtSize(r.size)} · ${timeAgo(r.timestamp)}</span>
            </div>
            ${etaText ? `<span class="eta">In Plex in <strong>${etaText}</strong></span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${RequestsView._styles()}</style>
      <div class="requests-container">
        <div class="requests-header">
          <h2>Recent Requests</h2>
        </div>
        <div class="requests-scroll">
          <div id="requestsList" class="requests-list">
            <div class="empty-state">
              <mm-icon name="download" size="48"></mm-icon>
              <p class="empty-title">No requests yet</p>
              <p class="empty-sub">Search for something and tap Get</p>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  static _styles() {
    return `
      :host {
        display: flex; flex-direction: column; height: 100%;
        color: var(--mm-text-primary, #e2e4ed);
        font-family: var(--mm-font-sans, -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif);
      }

      .requests-container { display: flex; flex-direction: column; height: 100%; }
      .requests-header {
        flex-shrink: 0; padding: 8px 20px 12px;
      }
      .requests-header h2 { font-size: 18px; font-weight: 700; }
      .requests-scroll {
        flex: 1; overflow-y: auto; padding: 0 20px 24px;
        -webkit-overflow-scrolling: touch;
      }
      .requests-list { display: flex; flex-direction: column; gap: 12px; }

      /* ── Request Card ────────────────────────────────────── */
      .request-card {
        padding: 16px; border-radius: 14px;
        background: var(--mm-bg-surface, #10121a);
        border: 1px solid var(--mm-border, #1e2030);
        display: flex; flex-direction: column; gap: 10px;
        transition: border-color 0.3s;
      }
      .request-card.completed {
        border-color: rgba(63,185,80,0.25);
      }
      .request-card.failed {
        border-color: rgba(248,81,73,0.25);
      }

      .request-header { display: flex; flex-direction: column; gap: 6px; }
      .request-title-row { display: flex; align-items: center; gap: 8px; }
      .request-title { font-size: 15px; font-weight: 700; }
      .request-year { font-size: 12px; color: var(--mm-text-secondary, #8b8fa3); }
      .request-badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .badge {
        font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
      }
      .badge-quality {
        padding: 2px 8px; border-radius: 6px;
        background: var(--mm-accent-glow, rgba(108,92,231,0.18));
        color: var(--mm-accent, #6c5ce7);
      }

      /* ── Progress Bar ────────────────────────────────────── */
      .progress-bar {
        height: 4px; border-radius: 2px;
        background: rgba(255,255,255,0.06); overflow: hidden;
      }
      .progress-fill {
        height: 100%; border-radius: 2px;
        transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 0 8px currentColor;
      }

      /* ── Pipeline Steps ──────────────────────────────────── */
      .pipeline-steps {
        display: flex; align-items: center; gap: 0; justify-content: space-between;
        padding: 6px 0;
      }
      .step-wrap {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        flex-shrink: 0;
      }
      .step-dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: var(--mm-bg-elevated, #181b27);
        border: 2px solid var(--mm-text-muted, #4a4d5e);
        transition: all 0.3s;
      }
      .step-dot.active {
        border-color: var(--mm-accent, #6c5ce7);
        background: var(--mm-accent, #6c5ce7);
        box-shadow: 0 0 10px var(--mm-accent-glow, rgba(108,92,231,0.4));
        animation: stepPulse 1.5s ease-in-out infinite;
      }
      .step-dot.completed {
        border-color: var(--mm-success, #3fb950);
        background: var(--mm-success, #3fb950);
      }
      .step-label {
        font-size: 9px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.3px; color: var(--mm-text-muted, #4a4d5e);
      }
      .step-line {
        flex: 1; height: 2px; margin-bottom: 16px;
        background: var(--mm-text-muted, #4a4d5e); opacity: 0.3;
      }

      @keyframes stepPulse {
        0%, 100% { box-shadow: 0 0 6px rgba(108,92,231,0.3); }
        50% { box-shadow: 0 0 16px rgba(108,92,231,0.6); }
      }

      /* ── Footer ──────────────────────────────────────────── */
      .request-footer {
        display: flex; justify-content: space-between; align-items: center;
        flex-wrap: wrap; gap: 4px;
      }
      .footer-left { display: flex; gap: 8px; align-items: center; }
      .speed { font-size: 12px; color: var(--mm-accent, #6c5ce7); font-weight: 600; }
      .meta { font-size: 11px; color: var(--mm-text-muted, #4a4d5e); }
      .eta { font-size: 12px; color: var(--mm-text-secondary, #8b8fa3); }
      .eta strong { color: var(--mm-accent, #6c5ce7); }

      /* ── States ──────────────────────────────────────────── */
      .empty-state {
        text-align: center; padding: 60px 20px;
        color: var(--mm-text-muted, #4a4d5e);
        display: flex; flex-direction: column; align-items: center; gap: 8px;
      }
      .empty-state mm-icon { opacity: 0.3; }
      .empty-title { font-size: 15px; font-weight: 500; }
      .empty-sub { font-size: 12px; }
    `;
  }
}

customElements.define('requests-view', RequestsView);
