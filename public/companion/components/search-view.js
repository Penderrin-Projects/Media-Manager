// ═══════════════════════════════════════════════════════════════
// Search View — TMDB search, results grid, TV episode picker
// ═══════════════════════════════════════════════════════════════

class SearchView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._results = [];
    this._searchType = '';
    this._searchTimeout = null;
    this._indexer = AppShell.getIndexer();
  }

  connectedCallback() {
    this._render();
    this._setupListeners();
  }

  onActivated() {}
  onDeactivated() {}

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${SearchView._styles()}</style>
      <div class="search-container">
        <!-- Search Bar -->
        <div class="search-bar">
          <div class="search-input-wrap">
            <mm-icon name="search" size="18"></mm-icon>
            <input
              type="text"
              id="searchInput"
              placeholder="Movie or TV show name..."
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              class="search-input"
            />
            <button id="searchClear" class="search-clear" aria-label="Clear">
              <mm-icon name="x" size="14"></mm-icon>
            </button>
          </div>
        </div>

        <!-- Results -->
        <div class="results-scroll" id="resultsScroll">
          <div id="searchResults" class="results-container"></div>
        </div>
      </div>

      <!-- TV Popup overlay (teleported here) -->
      <div id="tvOverlay"></div>
      <!-- Detail sheet overlay -->
      <div id="detailOverlay"></div>
    `;
    this._showEmpty();
  }

  _setupListeners() {
    const input = this.shadowRoot.querySelector('#searchInput');
    const clear = this.shadowRoot.querySelector('#searchClear');

    // Search input
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clear.classList.toggle('visible', q.length > 0);
      clearTimeout(this._searchTimeout);
      if (q.length === 0) {
        this._showTrending();
        return;
      }
      const delay = q.length < 3 ? 600 : 300;
      this._searchTimeout = setTimeout(() => this._doSearch(q), delay);
    });

    // Clear
    clear.addEventListener('click', () => {
      input.value = '';
      clear.classList.remove('visible');
      this._showTrending();
      input.focus();
    });

    // Type cycle from header
    window.addEventListener('mm-type-changed', (e) => {
      this._searchType = e.detail.type;
      const q = input.value.trim();
      if (q.length >= 2) this._doSearch(q);
    });

    // Indexer change from header
    window.addEventListener('mm-indexer-changed', (e) => {
      this._indexer = e.detail.id;
    });
  }

  _showEmpty() {
    this._results = [];
    const container = this.shadowRoot.querySelector('#searchResults');
    container.innerHTML = `
      <div class="home-idle">
        <img class="idle-gif" src="https://images.steamusercontent.com/ugc/854976916434675605/0A7FF9FDC45305AB9F1B4F51DCAC315274B28F96/?imw=5000&imh=5000&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false" alt="" />
      </div>
    `;
  }

  async _doSearch(query) {
    const container = this.shadowRoot.querySelector('#searchResults');
    const esc = AppShell.escHtml;

    // IMDB ID?
    const imdbMatch = query.match(/tt\d{7,}/);
    if (imdbMatch) {
      container.innerHTML = '<div class="loading-state"><mm-spinner size="24"></mm-spinner></div>';
      try {
        const data = await AppShell.api(`/companion/api/imdb/${imdbMatch[0]}`);
        if (data.error) {
          container.innerHTML = `<div class="empty-state"><p class="empty-error">${esc(data.error)}</p></div>`;
        } else if (data.success && data.result) {
          this._results = [data.result];
          this._renderResults();
        } else {
          container.innerHTML = '<div class="empty-state"><p class="empty-title">Not found on IMDB</p></div>';
        }
      } catch (e) {
        container.innerHTML = `<div class="empty-state"><p class="empty-error">${esc(e.message)}</p></div>`;
      }
      return;
    }

    container.innerHTML = '<div class="loading-state"><mm-spinner size="24"></mm-spinner></div>';
    try {
      const typeParam = this._searchType ? `&type=${this._searchType}` : '';
      const data = await AppShell.api(`/companion/api/search?q=${encodeURIComponent(query)}${typeParam}`);
      if (data.error) {
        container.innerHTML = `<div class="empty-state"><p class="empty-error">${esc(data.error)}</p></div>`;
      } else if (data.success && data.results && data.results.length) {
        this._results = data.results;
        this._renderResults();
      } else {
        container.innerHTML = '<div class="empty-state"><p class="empty-title">No results found</p></div>';
      }
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p class="empty-error">${esc(e.message)}</p></div>`;
    }
  }

  _renderResults() {
    const container = this.shadowRoot.querySelector('#searchResults');
    const esc = AppShell.escHtml;

    container.innerHTML = `<div class="poster-grid">
      ${this._results.map((r, i) => `
        <div class="poster-card" data-idx="${i}">
          ${r.poster
            ? `<img class="poster-img" src="${r.poster}" alt="${esc(r.title)}" loading="lazy">`
            : `<div class="poster-placeholder"><mm-icon name="film" size="28"></mm-icon></div>`
          }
          <div class="poster-info">
            <div class="poster-title">${esc(r.title)}</div>
            <div class="poster-meta">
              ${r.year ? `<span>${r.year}</span>` : ''}
              <span class="poster-type">${r.type === 'tv' ? 'TV' : 'Movie'}</span>
              ${r.rating && r.rating !== '0.0' ? `<span class="poster-rating">★ ${r.rating}</span>` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>`;

    // Card tap => show detail sheet
    container.querySelectorAll('.poster-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx);
        this._showDetailSheet(idx);
      });
    });
  }

  _showDetailSheet(idx) {
    const r = this._results[idx];
    if (!r) return;
    const esc = AppShell.escHtml;
    const overlay = this.shadowRoot.querySelector('#detailOverlay');

    overlay.innerHTML = `
      <div class="sheet-overlay" id="sheetOverlay">
        <div class="detail-sheet">
          <div class="sheet-handle"></div>
          <div class="sheet-poster-row">
            ${r.poster
              ? `<img class="sheet-poster" src="${r.poster}" alt="">`
              : `<div class="sheet-poster-placeholder"><mm-icon name="film" size="28"></mm-icon></div>`
            }
            <div class="sheet-meta">
              <div class="sheet-title">${esc(r.title)}</div>
              <div class="sheet-sub">
                ${r.year ? r.year + ' · ' : ''}${r.type === 'tv' ? 'TV Show' : 'Movie'}
              </div>
              ${r.rating && r.rating !== '0.0' ? `<div class="sheet-rating">★ ${r.rating}</div>` : ''}
            </div>
          </div>
          ${r.overview ? `<p class="sheet-overview">${esc(r.overview)}</p>` : ''}
          <button class="sheet-get-btn" id="sheetGetBtn">
            <mm-icon name="download" size="18"></mm-icon>
            Get It
          </button>
          <button class="sheet-cancel" id="sheetCancel">Cancel</button>
        </div>
      </div>
    `;

    const overlayEl = overlay.querySelector('#sheetOverlay');
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) overlay.innerHTML = '';
    });
    overlay.querySelector('#sheetCancel').addEventListener('click', () => overlay.innerHTML = '');
    overlay.querySelector('#sheetGetBtn').addEventListener('click', () => {
      overlay.innerHTML = '';
      this._getMedia(idx);
    });
  }

  async _getMedia(idx, skipPlexCheck = false, tvMode = null, tvSeason = null, tvEpisode = null) {
    const r = this._results[idx];
    if (!r) return;

    // TV show without mode selected => show TV popup
    if (r.type === 'tv' && !tvMode) {
      this._showTVPopup(idx);
      return;
    }

    AppShell.toast('Sending request...', 'info');

    try {
      const smsPhone = localStorage.getItem('sms_phone') || '';
      const smsCarrier = localStorage.getItem('sms_carrier') || '';
      const body = {
        title: r.title, year: r.year, type: r.type, tmdbId: r.id,
        skipPlexCheck,
        pushSubscription: AppShell.pushSubscription,
        smsPhone, smsCarrier,
        primaryIndexer: AppShell.getIndexer(),
        exclusiveIndexer: true,
      };

      // Re-subscribe if lost
      if (!AppShell.pushSubscription && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { await AppShell.subscribePush(); } catch {}
        body.pushSubscription = AppShell.pushSubscription;
      }

      if (tvMode) body.tvMode = tvMode;
      if (tvSeason) body.tvSeason = parseInt(tvSeason);
      if (tvEpisode) body.tvEpisode = parseInt(tvEpisode);

      const data = await AppShell.api('/companion/api/get', { method: 'POST', body: JSON.stringify(body) });

      if (data.error === 'already_in_plex') {
        this._showPlexToast(data.message || `Already in Plex: ${r.title}`, idx);
        return;
      }
      if (data.error === 'already_in_queue') {
        AppShell.toast(data.message || `Already in pipeline: ${r.title}`, 'info');
        return;
      }
      if (data.success) {
        const sNum = tvSeason ? String(tvSeason).padStart(2, '0') : '';
        const eNum = tvEpisode ? String(tvEpisode).padStart(2, '0') : '';
        const label = tvMode === 'season' ? ` S${sNum}` : tvMode === 'episode' ? ` S${sNum}E${eNum}` : tvMode === 'latest' ? ' (Latest)' : tvMode === 'full' ? ' (Full)' : '';
        AppShell.toast(`${r.title}${label} — downloading!`, 'success');
      } else {
        throw new Error(data.error || 'Failed');
      }
    } catch (e) {
      AppShell.toast(e.message || 'Failed to get media', 'error');
    }
  }

  _showPlexToast(msg, idx) {
    // Use a special toast with "Get Anyway" option
    const overlay = this.shadowRoot.querySelector('#detailOverlay');
    overlay.innerHTML = `
      <div class="sheet-overlay" id="plexOverlay" style="align-items:flex-end">
        <div class="plex-toast-card">
          <div class="plex-toast-content">
            <mm-icon name="tv" size="24"></mm-icon>
            <div class="plex-toast-text">
              <strong>Already in Plex</strong>
              <span>${AppShell.escHtml(msg)}</span>
            </div>
          </div>
          <div class="plex-toast-actions">
            <button class="plex-dismiss" id="plexDismiss">Dismiss</button>
            <button class="plex-get-anyway" id="plexGetAnyway">Get Anyway</button>
          </div>
        </div>
      </div>
    `;
    const overlayEl = overlay.querySelector('#plexOverlay');
    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) overlay.innerHTML = ''; });
    overlay.querySelector('#plexDismiss').addEventListener('click', () => overlay.innerHTML = '');
    overlay.querySelector('#plexGetAnyway').addEventListener('click', () => {
      overlay.innerHTML = '';
      this._getMedia(idx, true);
    });
    setTimeout(() => overlay.innerHTML = '', 8000);
  }

  // ── TV Popup ────────────────────────────────────────────────
  _closeTVPopup() {
    this.shadowRoot.querySelector('#tvOverlay').innerHTML = '';
  }

  _showTVPopup(idx) {
    const r = this._results[idx];
    const esc = AppShell.escHtml;
    const overlay = this.shadowRoot.querySelector('#tvOverlay');

    overlay.innerHTML = `
      <div class="sheet-overlay" id="tvPopupOverlay">
        <div class="detail-sheet tv-sheet">
          <div class="sheet-handle"></div>
          <h3 class="tv-title">${esc(r.title)}</h3>
          <p class="tv-sub">${r.year || ''} · TV Show</p>

          <button class="tv-option" data-action="full">
            <span class="tv-option-icon"><mm-icon name="download" size="18"></mm-icon></span>
            <div class="tv-option-text">
              <strong>Full Show</strong>
              <span>Find a complete series torrent</span>
            </div>
          </button>

          <button class="tv-option" data-action="season">
            <span class="tv-option-icon"><mm-icon name="hash" size="18"></mm-icon></span>
            <div class="tv-option-text">
              <strong>Season</strong>
              <span>Pick a specific season</span>
            </div>
          </button>

          <button class="tv-option" data-action="episode">
            <span class="tv-option-icon"><mm-icon name="play" size="18"></mm-icon></span>
            <div class="tv-option-text">
              <strong>Episode</strong>
              <span>Pick a specific episode</span>
            </div>
          </button>

          <button class="tv-option" data-action="latest">
            <span class="tv-option-icon"><mm-icon name="refresh-cw" size="18"></mm-icon></span>
            <div class="tv-option-text">
              <strong>Latest</strong>
              <span>Download episodes not in Plex</span>
            </div>
          </button>

          <button class="sheet-cancel" data-action="cancel">Cancel</button>
        </div>
      </div>
    `;

    const overlayEl = overlay.querySelector('#tvPopupOverlay');
    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) this._closeTVPopup(); });

    overlay.querySelectorAll('.tv-option, .sheet-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'cancel') { this._closeTVPopup(); return; }
        if (action === 'full') { this._closeTVPopup(); this._getMedia(idx, false, 'full'); return; }
        if (action === 'latest') { this._closeTVPopup(); this._getMedia(idx, false, 'latest'); return; }
        if (action === 'season') { this._showSeasonPicker(idx); return; }
        if (action === 'episode') { this._showEpisodePicker(idx); return; }
      });
    });
  }

  async _showSeasonPicker(idx) {
    const r = this._results[idx];
    const esc = AppShell.escHtml;
    if (!r.id) { AppShell.toast('No TMDB ID for this show', 'error'); return; }
    const overlay = this.shadowRoot.querySelector('#tvOverlay');
    const sheet = overlay.querySelector('.tv-sheet');
    if (!sheet) return;

    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <h3 class="tv-title">${esc(r.title)}</h3>
      <p class="tv-sub">Loading seasons...</p>
      <div class="loading-state"><mm-spinner size="24"></mm-spinner></div>
    `;

    try {
      const data = await AppShell.api(`/companion/api/tv/${r.id}`);
      if (!data.success || !data.seasons.length) {
        sheet.innerHTML = `
          <div class="sheet-handle"></div>
          <h3 class="tv-title">${esc(r.title)}</h3>
          <p class="tv-sub">No seasons found on TMDB</p>
          <button class="sheet-cancel" id="tvBack">Close</button>
        `;
        sheet.querySelector('#tvBack').addEventListener('click', () => this._closeTVPopup());
        return;
      }

      const airedSeasons = data.seasons.filter(s => s.aired);
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <h3 class="tv-title">${esc(r.title)}</h3>
        <p class="tv-sub">${airedSeasons.length} season${airedSeasons.length !== 1 ? 's' : ''} · ${data.status || ''}</p>
        <div class="tv-list">
          ${airedSeasons.map(s => `
            <button class="tv-option" data-season="${s.number}">
              <span class="tv-option-icon season-num">S${String(s.number).padStart(2, '0')}</span>
              <div class="tv-option-text">
                <strong>${esc(s.name || 'Season ' + s.number)}</strong>
                <span>${s.episodeCount} episode${s.episodeCount !== 1 ? 's' : ''}${s.airDate ? ' · ' + s.airDate.slice(0, 4) : ''}</span>
              </div>
            </button>
          `).join('')}
        </div>
        <button class="sheet-cancel tv-back" id="tvBack">Back</button>
      `;

      sheet.querySelectorAll('.tv-option').forEach(btn => {
        btn.addEventListener('click', () => {
          this._closeTVPopup();
          this._getMedia(idx, false, 'season', btn.dataset.season);
        });
      });
      sheet.querySelector('#tvBack').addEventListener('click', () => this._showTVPopup(idx));
    } catch (e) {
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <h3 class="tv-title">${esc(r.title)}</h3>
        <p class="tv-sub" style="color:var(--mm-danger)">Failed to load seasons: ${esc(e.message)}</p>
        <button class="sheet-cancel" id="tvBack">Close</button>
      `;
      sheet.querySelector('#tvBack').addEventListener('click', () => this._closeTVPopup());
    }
  }

  async _showEpisodePicker(idx) {
    const r = this._results[idx];
    const esc = AppShell.escHtml;
    if (!r.id) { AppShell.toast('No TMDB ID for this show', 'error'); return; }
    const overlay = this.shadowRoot.querySelector('#tvOverlay');
    const sheet = overlay.querySelector('.tv-sheet');
    if (!sheet) return;

    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <h3 class="tv-title">${esc(r.title)}</h3>
      <p class="tv-sub">Loading seasons...</p>
      <div class="loading-state"><mm-spinner size="24"></mm-spinner></div>
    `;

    try {
      const data = await AppShell.api(`/companion/api/tv/${r.id}`);
      if (!data.success || !data.seasons.length) {
        sheet.innerHTML = `
          <div class="sheet-handle"></div>
          <h3 class="tv-title">${esc(r.title)}</h3>
          <p class="tv-sub">No seasons found</p>
          <button class="sheet-cancel" id="tvBack">Close</button>
        `;
        sheet.querySelector('#tvBack').addEventListener('click', () => this._closeTVPopup());
        return;
      }

      const airedSeasons = data.seasons.filter(s => s.aired);
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <h3 class="tv-title">${esc(r.title)} — Pick Season</h3>
        <p class="tv-sub">Then pick an episode</p>
        <div class="tv-list">
          ${airedSeasons.map(s => `
            <button class="tv-option" data-season="${s.number}">
              <span class="tv-option-icon season-num">S${String(s.number).padStart(2, '0')}</span>
              <div class="tv-option-text">
                <strong>${esc(s.name || 'Season ' + s.number)}</strong>
                <span>${s.episodeCount} episode${s.episodeCount !== 1 ? 's' : ''}</span>
              </div>
            </button>
          `).join('')}
        </div>
        <button class="sheet-cancel tv-back" id="tvBack">Back</button>
      `;

      sheet.querySelectorAll('.tv-option').forEach(btn => {
        btn.addEventListener('click', () => this._showEpisodesForSeason(idx, parseInt(btn.dataset.season)));
      });
      sheet.querySelector('#tvBack').addEventListener('click', () => this._showTVPopup(idx));
    } catch (e) {
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <h3 class="tv-title">${esc(r.title)}</h3>
        <p class="tv-sub" style="color:var(--mm-danger)">Failed: ${esc(e.message)}</p>
        <button class="sheet-cancel" id="tvBack">Close</button>
      `;
      sheet.querySelector('#tvBack').addEventListener('click', () => this._closeTVPopup());
    }
  }

  async _showEpisodesForSeason(idx, seasonNum) {
    const r = this._results[idx];
    const esc = AppShell.escHtml;
    const overlay = this.shadowRoot.querySelector('#tvOverlay');
    const sheet = overlay.querySelector('.tv-sheet');
    if (!sheet) return;

    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <h3 class="tv-title">${esc(r.title)} — S${String(seasonNum).padStart(2, '0')}</h3>
      <p class="tv-sub">Loading episodes...</p>
      <div class="loading-state"><mm-spinner size="24"></mm-spinner></div>
    `;

    try {
      const data = await AppShell.api(`/companion/api/tv/${r.id}/season/${seasonNum}`);
      if (!data.success || !data.episodes.length) {
        sheet.innerHTML = `
          <div class="sheet-handle"></div>
          <h3 class="tv-title">${esc(r.title)} — S${String(seasonNum).padStart(2, '0')}</h3>
          <p class="tv-sub">No episodes found</p>
          <button class="sheet-cancel" id="tvBack">Back</button>
        `;
        sheet.querySelector('#tvBack').addEventListener('click', () => this._showEpisodePicker(idx));
        return;
      }

      const airedEps = data.episodes.filter(ep => ep.aired);
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <h3 class="tv-title">${esc(r.title)} — Season ${seasonNum}</h3>
        <p class="tv-sub">${airedEps.length} aired episode${airedEps.length !== 1 ? 's' : ''}</p>
        <div class="tv-list">
          ${airedEps.map(ep => `
            <button class="tv-option" data-episode="${ep.number}">
              <span class="tv-option-icon season-num">E${String(ep.number).padStart(2, '0')}</span>
              <div class="tv-option-text">
                <strong>${esc(ep.name || 'Episode ' + ep.number)}</strong>
                ${ep.overview ? `<span>${esc(ep.overview.slice(0, 80))}${ep.overview.length > 80 ? '...' : ''}</span>` : ''}
              </div>
            </button>
          `).join('')}
        </div>
        <button class="sheet-cancel tv-back" id="tvBack">Back</button>
      `;

      sheet.querySelectorAll('.tv-option').forEach(btn => {
        btn.addEventListener('click', () => {
          this._closeTVPopup();
          this._getMedia(idx, false, 'episode', seasonNum, btn.dataset.episode);
        });
      });
      sheet.querySelector('#tvBack').addEventListener('click', () => this._showEpisodePicker(idx));
    } catch (e) {
      sheet.innerHTML = `
        <div class="sheet-handle"></div>
        <h3 class="tv-title">${esc(r.title)}</h3>
        <p class="tv-sub" style="color:var(--mm-danger)">Failed: ${esc(e.message)}</p>
        <button class="sheet-cancel" id="tvBack">Back</button>
      `;
      sheet.querySelector('#tvBack').addEventListener('click', () => this._showEpisodePicker(idx));
    }
  }

  // ── Styles ──────────────────────────────────────────────────
  static _styles() {
    return `
      :host {
        display: flex; flex-direction: column; height: 100%;
        overflow: hidden;
        color: var(--mm-text-primary, #e2e4ed);
        font-family: var(--mm-font-sans, -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif);
      }

      .search-container { display: flex; flex-direction: column; height: 100%; }

      /* ── Search Bar ──────────────────────────────────────── */
      .search-bar {
        flex-shrink: 0; padding: 12px 20px 10px;
        background: var(--mm-bg-base, #08090d);
      }
      .search-input-wrap {
        display: flex; align-items: center; gap: 10px;
        background: var(--mm-bg-surface, #10121a);
        border: 1.5px solid var(--mm-border, #1e2030);
        border-radius: 14px; padding: 0 14px;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .search-input-wrap:focus-within {
        border-color: var(--mm-accent, #6c5ce7);
        box-shadow: 0 0 0 3px var(--mm-accent-glow, rgba(108,92,231,0.18));
      }
      .search-input-wrap mm-icon { color: var(--mm-text-muted, #4a4d5e); flex-shrink: 0; }
      .search-input {
        flex: 1; background: none; border: none; color: var(--mm-text-primary, #e2e4ed);
        font-size: 16px; padding: 14px 0; outline: none; font-family: inherit;
      }
      .search-input::placeholder { color: var(--mm-text-muted, #4a4d5e); }
      .search-clear {
        width: 28px; height: 28px; border-radius: 50%; border: none;
        background: var(--mm-bg-elevated, #181b27);
        color: var(--mm-text-secondary, #8b8fa3);
        cursor: pointer; display: none; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .search-clear.visible { display: flex; }

      /* ── Idle state (gif) ────────────────────────────────── */
      .home-idle {
        display: flex; align-items: center; justify-content: center;
        height: 100%; padding: 20px;
      }
      .idle-gif {
        max-width: 280px; width: 80%;
        opacity: 0.5;
        mix-blend-mode: lighten;
        pointer-events: none;
      }

      /* ── Results Scroll ──────────────────────────────────── */
      .results-scroll {
        flex: 1; overflow-y: auto; padding: 8px 20px 24px;
        -webkit-overflow-scrolling: touch;
      }

      /* ── Poster Grid ─────────────────────────────────────── */
      .poster-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      @media (min-width: 480px) { .poster-grid { grid-template-columns: repeat(4, 1fr); } }
      @media (min-width: 768px) { .poster-grid { grid-template-columns: repeat(5, 1fr); } }

      .poster-card {
        cursor: pointer; border-radius: 12px; overflow: hidden;
        background: var(--mm-bg-surface, #10121a);
        border: 1px solid var(--mm-border, #1e2030);
        transition: transform 0.15s, box-shadow 0.15s;
      }
      .poster-card:active {
        transform: scale(0.96);
      }
      .poster-card:hover {
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      }
      .poster-img {
        width: 100%; aspect-ratio: 2/3; object-fit: cover;
        display: block; background: var(--mm-bg-elevated, #181b27);
      }
      .poster-placeholder {
        width: 100%; aspect-ratio: 2/3;
        display: flex; align-items: center; justify-content: center;
        background: var(--mm-bg-elevated, #181b27);
        color: var(--mm-text-muted, #4a4d5e);
      }
      .poster-info { padding: 8px 10px 10px; }
      .poster-title {
        font-size: 12px; font-weight: 600; line-height: 1.3;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .poster-meta {
        display: flex; align-items: center; gap: 6px; margin-top: 3px;
        font-size: 10px; color: var(--mm-text-secondary, #8b8fa3);
      }
      .poster-type {
        font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
        padding: 1px 5px; border-radius: 4px;
        background: var(--mm-accent-glow, rgba(108,92,231,0.18));
        color: var(--mm-accent, #6c5ce7); font-size: 9px;
      }
      .poster-rating { color: var(--mm-warning, #d29922); font-weight: 700; }

      /* ── Detail Sheet ────────────────────────────────────── */
      .sheet-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.65);
        z-index: 100;
        display: flex; align-items: flex-end; justify-content: center;
        animation: overlayFadeIn 0.15s ease;
      }
      @keyframes overlayFadeIn { from { opacity: 0; } }

      .detail-sheet {
        background: var(--mm-bg-surface, #10121a);
        border: 1px solid var(--mm-border, #1e2030);
        border-radius: 20px 20px 0 0;
        padding: 12px 20px calc(20px + env(safe-area-inset-bottom, 0px));
        width: 100%; max-width: 480px;
        animation: sheetSlideUp 0.25s cubic-bezier(0.22, 1, 0.36, 1);
        max-height: 85vh; overflow-y: auto;
      }
      @keyframes sheetSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

      .sheet-handle {
        width: 36px; height: 4px; border-radius: 2px;
        background: var(--mm-text-muted, #4a4d5e);
        margin: 0 auto 16px;
      }
      .sheet-poster-row { display: flex; gap: 14px; margin-bottom: 14px; }
      .sheet-poster {
        width: 100px; height: 150px; border-radius: 12px; object-fit: cover;
        flex-shrink: 0; background: var(--mm-bg-elevated, #181b27);
      }
      .sheet-poster-placeholder {
        width: 100px; height: 150px; border-radius: 12px;
        background: var(--mm-bg-elevated, #181b27);
        display: flex; align-items: center; justify-content: center;
        color: var(--mm-text-muted, #4a4d5e); flex-shrink: 0;
      }
      .sheet-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
      .sheet-title { font-size: 18px; font-weight: 700; line-height: 1.3; }
      .sheet-sub { font-size: 13px; color: var(--mm-text-secondary, #8b8fa3); }
      .sheet-rating { font-size: 14px; color: var(--mm-warning, #d29922); font-weight: 700; margin-top: 4px; }
      .sheet-overview {
        font-size: 14px; color: var(--mm-text-secondary, #8b8fa3);
        line-height: 1.6; margin-bottom: 18px;
      }
      .sheet-get-btn {
        width: 100%; padding: 16px; border: none; border-radius: 14px;
        background: var(--mm-accent, #6c5ce7); color: #fff;
        font-size: 16px; font-weight: 700; cursor: pointer;
        font-family: inherit; display: flex; align-items: center;
        justify-content: center; gap: 8px;
        transition: all 0.15s;
        box-shadow: 0 4px 20px rgba(108,92,231,0.3);
      }
      .sheet-get-btn:active { transform: scale(0.97); opacity: 0.9; }
      .sheet-cancel {
        width: 100%; padding: 14px; margin-top: 8px; border: none;
        background: none; color: var(--mm-text-muted, #4a4d5e);
        font-size: 14px; cursor: pointer; font-family: inherit;
      }

      /* ── TV Popup ────────────────────────────────────────── */
      .tv-sheet { padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
      .tv-title { font-size: 18px; font-weight: 700; margin-bottom: 2px; }
      .tv-sub { font-size: 13px; color: var(--mm-text-secondary, #8b8fa3); margin-bottom: 16px; }
      .tv-option {
        width: 100%; padding: 14px; margin-bottom: 6px;
        border-radius: 12px; border: 1px solid var(--mm-border, #1e2030);
        background: var(--mm-bg-base, #08090d);
        color: var(--mm-text-primary, #e2e4ed);
        font-size: 14px; text-align: left; cursor: pointer;
        display: flex; align-items: center; gap: 12px;
        font-family: inherit; transition: background 0.15s;
      }
      .tv-option:active { background: var(--mm-bg-elevated, #181b27); }
      .tv-option-icon {
        width: 36px; height: 36px; border-radius: 10px;
        background: var(--mm-accent-glow, rgba(108,92,231,0.18));
        color: var(--mm-accent, #6c5ce7);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .tv-option-icon.season-num {
        font-size: 12px; font-weight: 700;
        color: var(--mm-accent, #6c5ce7);
      }
      .tv-option-text { display: flex; flex-direction: column; gap: 2px; }
      .tv-option-text strong { font-size: 14px; }
      .tv-option-text span { font-size: 12px; color: var(--mm-text-secondary, #8b8fa3); }
      .tv-list { max-height: 320px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
      .tv-back { margin-top: 4px; }

      /* ── Plex Toast ──────────────────────────────────────── */
      .plex-toast-card {
        background: var(--mm-bg-surface, #10121a);
        border: 1px solid rgba(108,92,231,0.25);
        border-radius: 16px; padding: 16px 18px;
        margin: 16px; width: calc(100% - 32px); max-width: 420px;
        animation: sheetSlideUp 0.25s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .plex-toast-content {
        display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px;
        color: var(--mm-accent, #6c5ce7);
      }
      .plex-toast-text { display: flex; flex-direction: column; gap: 4px; }
      .plex-toast-text strong { font-size: 15px; }
      .plex-toast-text span { font-size: 12px; color: var(--mm-text-secondary, #8b8fa3); }
      .plex-toast-actions { display: flex; gap: 8px; }
      .plex-dismiss {
        flex: 1; padding: 10px; border-radius: 10px; border: 1px solid var(--mm-border, #1e2030);
        background: none; color: var(--mm-text-secondary, #8b8fa3);
        font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
      }
      .plex-get-anyway {
        flex: 1; padding: 10px; border-radius: 10px; border: none;
        background: var(--mm-accent, #6c5ce7); color: #fff;
        font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
      }

      /* ── States ──────────────────────────────────────────── */
      .empty-state {
        text-align: center; padding: 60px 20px;
        color: var(--mm-text-muted, #4a4d5e);
        display: flex; flex-direction: column; align-items: center; gap: 8px;
      }
      .empty-state mm-icon { opacity: 0.4; }
      .empty-title { font-size: 15px; font-weight: 500; }
      .empty-sub { font-size: 12px; color: var(--mm-text-muted, #4a4d5e); }
      .empty-sub strong { color: var(--mm-accent, #6c5ce7); }
      .empty-error { font-size: 14px; color: var(--mm-danger, #f85149); }
      .loading-state {
        display: flex; justify-content: center; padding: 40px;
      }
    `;
  }
}

customElements.define('search-view', SearchView);
