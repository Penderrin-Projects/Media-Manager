// ═══════════════════════════════════════════════════════════════════
// Smart Grab Handler — Automated torrent search, scoring, and grab
// Moved from Companion to centralize torrent intelligence on the server
// ═══════════════════════════════════════════════════════════════════

function scoreTorrent(torrent, prefs, type, requestYear) {
  let score = 0;
  const title = torrent.title;
  const is4K = /2160p|4k|uhd/i.test(title);
  const is1080 = /1080p/i.test(title);
  const is720 = /720p/i.test(title);

  if (prefs.quality === '4k' && is4K) score += 100;
  else if (prefs.quality === '1080p' && is1080) score += 100;
  else if (prefs.quality === '720p' && is720) score += 100;
  else if (prefs.quality === 'any') { if (is1080) score += 80; else if (is4K) score += 70; else if (is720) score += 60; }
  else { if (is1080) score += 50; else if (is4K) score += 40; else if (is720) score += 30; }

  if (/bluray|bdrip|remux/i.test(title)) score += 20;
  if (/web[\.\-\s]?dl|webrip|amzn|nf|dsnp/i.test(title)) score += 15;
  if (/hdtv/i.test(title)) score += 5;
  if (/cam|ts|telesync|hdts/i.test(title)) score -= 100;

  score += Math.min(Math.log2(torrent.seeders + 1) * 8, 50);

  const sizeGB = torrent.size / 1073741824;
  const maxSize = type === 'tv' ? (prefs.maxSizeGBTV || 60) : (prefs.maxSizeGB || 4);
  if (maxSize && sizeGB > maxSize) score -= 50;
  if (sizeGB < 0.3 && type === 'movie') score -= 30;
  if (sizeGB > 1 && sizeGB <= maxSize) score += 10;

  if (type === 'tv' && /complete|season.?pack/i.test(title)) score += 25;
  if (type === 'tv' && /S\d{1,2}E\d{1,2}/i.test(title) && !/complete|season/i.test(title)) score -= 20;

  if ((torrent.indexer || '').toLowerCase().includes('1337x')) score += 15;
  if (/FLUX|NTb|SPARKS|RARBG|YTS|YIFY|EVO|AMIABLE/i.test(title)) score += 10;

  if (/\b(kor|jpn|chi|hin|fra|deu|ita|spa|rus|ara|tur|tha)\b/i.test(title)) score -= 30;
  if (/dubbed|multi/i.test(title) && !/english/i.test(title)) score -= 15;

  const hasEnglishMarker = /\bENG(?:lish)?\b/i.test(title) || /\bEnG\b/.test(title) || /\bDUAL\b/i.test(title);
  const foreignRelease =
    /\bLektor\s*(PL|CZ|HU)\b/i.test(title) || /\bNapisy\s*PL\b/i.test(title) ||
    /\bTRUEFRENCH\b/i.test(title) || /\bFRENCH\b/i.test(title) || /\bLATINO\b/i.test(title) ||
    /\bGerman\s*DL\b/i.test(title) || /\biTALiAN\b/i.test(title) || /\bRUSSIAN\b/i.test(title) ||
    /\bPOLISH\b/i.test(title) || /\bCZECH\b/i.test(title) || /\bHINDI\b/i.test(title) ||
    /\bTAMiL\b/i.test(title) || /\bTELUGU\b/i.test(title) || /\bKOREAN\b/i.test(title) ||
    /\bCHINESE\b/i.test(title) || /\bJAPANESE\b/i.test(title) || /\bARABIC\b/i.test(title) ||
    /\bTURKISH\b/i.test(title) || /\bVFF\b/i.test(title) || /\bVFQ\b/i.test(title) ||
    /\bHC\b/.test(title) || /\bITA(?:\s|$|\b)/i.test(title) || /\bRUS(?:\s|$|\b)/i.test(title) ||
    /^(?:Slepa|La|Le|El|Der|Das|Die)\s\w+\s\//i.test(title);
  if (foreignRelease && !hasEnglishMarker) score -= 500;
  if (hasEnglishMarker && !foreignRelease) score += 5;

  // Year mismatch penalty — critical for disambiguating remakes (e.g. Scrubs 2001 vs 2026)
  if (requestYear) {
    const yearStr = String(requestYear);
    const titleHasYear = new RegExp('\\b' + yearStr + '\\b').test(title);
    const titleHasOtherYear = title.match(/\b(19|20)\d{2}\b/);
    if (titleHasYear) score += 50; // matches requested year
    else if (titleHasOtherYear && titleHasOtherYear[0] !== yearStr) score -= 500; // wrong year
  }

  if (torrent.seeders < (prefs.minSeeders || 5)) score -= 200;
  return score;
}

function selectBestTorrent(results, type, prefs, tvMode, tvSeason, requestYear, tvEpisode) {
  if (!results.length) return null;

  let filtered = results;
  if (type === 'movie') {
    filtered = results.filter(r => r.categories.some(c => c >= 2000 && c < 3000) || !r.categories.length);
  } else if (type === 'tv') {
    filtered = results.filter(r => r.categories.some(c => c >= 5000 && c < 6000) || !r.categories.length);
  }
  if (!filtered.length) filtered = results;

  if (type === 'tv' && tvMode) {
    const sNum = tvSeason ? String(tvSeason).padStart(2, '0') : null;
    if (tvMode === 'full') {
      const fullPacks = filtered.filter(r => /complete|all.?seasons|s01.*s\d{2}|season.?1.*season.?\d/i.test(r.title.toLowerCase()) || r.size > 10 * 1024 * 1024 * 1024);
      if (fullPacks.length) filtered = fullPacks;
    } else if (tvMode === 'season' && sNum) {
      const seasonPacks = filtered.filter(r => new RegExp(`S${sNum}(?!E\\d)`, 'i').test(r.title) || new RegExp(`Season.?${parseInt(sNum)}(?!\\s*E)`, 'i').test(r.title));
      if (seasonPacks.length) filtered = seasonPacks;
    } else if ((tvMode === 'episode' || tvMode === 'latest') && sNum && tvEpisode) {
      const eNum = String(tvEpisode).padStart(2, '0');
      const episodeMatches = filtered.filter(r => new RegExp('S' + sNum + 'E' + eNum + '\\b', 'i').test(r.title));
      if (episodeMatches.length) filtered = episodeMatches;
    }
  }

  const scored = filtered.map(r => ({ ...r, _score: scoreTorrent(r, prefs, type, requestYear) }));
  scored.sort((a, b) => b._score - a._score);
  const best = scored[0];
  if (best._score < 0) return null;
  return best;
}

async function prowlarrSearch(store, query, searchType = 'search', primaryIndexer, exclusiveIndexer) {
  // Route through MM's own /api/prowlarr/search — handles Hunterr + Prowlarr auto-detection
  const port = store.get('server.port') || process.env.PORT || 9876;
  const body = { query, primaryIndexer: primaryIndexer || null, exclusiveIndexer: !!exclusiveIndexer };
  const res = await fetch('http://127.0.0.1:' + port + '/api/prowlarr/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('Search failed: ' + res.status);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Search failed');
  console.log('[smart-grab] "' + query + '" => ' + (data.results || []).length + ' results');
  return data.results || [];
}

function setupSmartGrabRoutes(app, store, auth) {
  // The main smart-grab endpoint: search → score → select → send to pipeline
  app.post('/api/smart-grab', auth, async (req, res) => {
    try {
      let { title, year, type, tmdbId, tvMode, tvSeason, tvEpisode, preferences, skipPlexCheck, primaryIndexer, exclusiveIndexer } = req.body;
      if (!title) return res.status(400).json({ error: 'Title required' });

      const contentType = type || 'movie';
      const prefs = preferences || { quality: '1080p', maxSizeGB: 4, maxSizeGBTV: 60, minSeeders: 5 };

      // Check pipeline queue for duplicates
      const { getJobs } = require('./pipeline');
      const jobs = (getJobs() || []).filter(j => j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled');
      if (jobs.length) {
        const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const reqTitle = normalize(title);
        let matchLabel = null;
        if (contentType === 'tv' && tvMode === 'episode' && tvSeason && tvEpisode) {
          matchLabel = `s${String(tvSeason).padStart(2, '0')}e${String(tvEpisode).padStart(2, '0')}`;
        } else if (contentType === 'tv' && tvMode === 'season' && tvSeason) {
          matchLabel = `s${String(tvSeason).padStart(2, '0')}`;
        }
        for (const job of jobs) {
          const jobName = normalize(job.name);
          if (!jobName.includes(reqTitle)) continue;
          if (contentType === 'movie' && (!year || jobName.includes(String(year)))) {
            return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
          }
          if (contentType === 'tv' && matchLabel && jobName.includes(matchLabel)) {
            return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
          }
          if (contentType === 'tv' && tvMode === 'full') {
            return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
          }
        }
      }

      // Resolve "latest" to actual season/episode BEFORE Plex check
      if (contentType === 'tv' && tvMode === 'latest' && tmdbId && !tvEpisode) {
        try {
          const tmdbCfg = store.get('tmdb') || {};
          if (tmdbCfg.apiKey) {
            const showRes = await fetch('https://api.themoviedb.org/3/tv/' + tmdbId + '?api_key=' + tmdbCfg.apiKey);
            if (showRes.ok) {
              const show = await showRes.json();
              const lastEp = show.last_episode_to_air;
              if (lastEp) {
                tvSeason = lastEp.season_number;
                tvEpisode = lastEp.episode_number;
                console.log('[smart-grab] Latest resolved via TMDB: S' + String(tvSeason).padStart(2,'0') + 'E' + String(tvEpisode).padStart(2,'0'));
              }
            }
          }
        } catch (e) { console.log('[smart-grab] TMDB latest resolve failed:', e.message); }
      }

      // Plex duplicate check — movies, full shows, seasons, and episodes
      if (!skipPlexCheck) {
        try {
          const plexCfg = store.get('plex') || {};
          if (plexCfg.url && plexCfg.token) {
            const plexBase = plexCfg.url.replace(/\/$/, '');
            const plexHeaders = { 'X-Plex-Token': plexCfg.token, Accept: 'application/json' };
            const plexR = await fetch(plexBase + '/search?query=' + encodeURIComponent(title), { headers: plexHeaders, signal: AbortSignal.timeout(5000) });
            if (plexR.ok) {
              const plexData = await plexR.json();
              const items = plexData.MediaContainer?.Metadata || [];
              const found = items.find(i => {
                const t = (i.title || '').toLowerCase();
                if (!t.includes(title.toLowerCase().slice(0, 10))) return false;
                if (year && i.year && String(i.year) !== String(year)) return false;
                return true;
              });

              if (found) {
                // Movies and full shows: just finding the title is enough
                if (contentType === 'movie' || (contentType === 'tv' && tvMode === 'full')) {
                  return res.status(409).json({ error: 'already_in_plex', message: 'Already in Plex: ' + found.title + (found.year ? ' (' + found.year + ')' : '') });
                }

                // TV episodes/seasons/latest: check if the specific season+episode exists
                if (contentType === 'tv' && found.ratingKey) {
                  try {
                    // Get seasons
                    const seasonsR = await fetch(plexBase + '/library/metadata/' + found.ratingKey + '/children', { headers: plexHeaders, signal: AbortSignal.timeout(5000) });
                    if (seasonsR.ok) {
                      const seasonsData = await seasonsR.json();
                      const seasons = seasonsData.MediaContainer?.Metadata || [];
                      const targetSeason = tvSeason ? seasons.find(s => s.index === parseInt(tvSeason)) : null;

                      if (tvMode === 'season' && targetSeason) {
                        return res.status(409).json({ error: 'already_in_plex', message: 'Already in Plex: ' + found.title + ' Season ' + tvSeason });
                      }

                      if ((tvMode === 'episode' || tvMode === 'latest') && targetSeason && tvEpisode) {
                        // Get episodes in that season
                        const epsR = await fetch(plexBase + '/library/metadata/' + targetSeason.ratingKey + '/children', { headers: plexHeaders, signal: AbortSignal.timeout(5000) });
                        if (epsR.ok) {
                          const epsData = await epsR.json();
                          const episodes = epsData.MediaContainer?.Metadata || [];
                          const targetEp = episodes.find(e => e.index === parseInt(tvEpisode));
                          if (targetEp) {
                            return res.status(409).json({ error: 'already_in_plex', message: 'Already in Plex: ' + found.title + ' S' + String(tvSeason).padStart(2,'0') + 'E' + String(tvEpisode).padStart(2,'0') });
                          }
                        }
                      }
                    }
                  } catch (e2) { console.log('[smart-grab] Plex episode check failed:', e2.message); }
                }
              }
            }
          }
        } catch (e) { console.log('[smart-grab] Plex check failed (non-fatal):', e.message); }
      }

      // Build search query based on TV mode
      let searchQuery;
      let requestLabel = title;
      if (contentType === 'tv' && tvMode) {
        if (tvMode === 'full') { searchQuery = `${title} complete series`; requestLabel = `${title} (Complete Series)`; }
        else if (tvMode === 'season' && tvSeason) {
          const sNum = String(tvSeason).padStart(2, '0');
          searchQuery = year ? `${title} ${year} S${sNum}` : `${title} S${sNum}`; requestLabel = `${title} Season ${tvSeason}`;
        } else if (tvMode === 'episode' && tvSeason && tvEpisode) {
          const sNum = String(tvSeason).padStart(2, '0');
          const eNum = String(tvEpisode).padStart(2, '0');
          searchQuery = year ? `${title} ${year} S${sNum}E${eNum}` : `${title} S${sNum}E${eNum}`; requestLabel = `${title} S${sNum}E${eNum}`;
        } else if (tvMode === 'latest' && tmdbId) {
          try {
            const tmdbCfg = store.get('tmdb') || {};
            if (tmdbCfg.apiKey) {
              const showRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbCfg.apiKey}`);
              if (showRes.ok) {
                const show = await showRes.json();
                const lastEp = show.last_episode_to_air;
                if (lastEp) {
                  tvSeason = lastEp.season_number; tvEpisode = lastEp.episode_number;
                  const sNum = String(tvSeason).padStart(2, '0');
                  const eNum = String(tvEpisode).padStart(2, '0');
                  searchQuery = year ? `${title} ${year} S${sNum}E${eNum}` : `${title} S${sNum}E${eNum}`; requestLabel = `${title} S${sNum}E${eNum} (Latest)`;
                } else {
                  const today = new Date().toISOString().slice(0, 10);
                  const aired = (show.seasons || []).filter(s => s.season_number > 0 && s.air_date && s.air_date <= today);
                  if (aired.length) {
                    const sNum = String(aired[aired.length - 1].season_number).padStart(2, '0');
                    searchQuery = `${title} S${sNum}`; requestLabel = `${title} Season ${aired[aired.length - 1].season_number} (Latest)`;
                  } else { searchQuery = title; requestLabel = `${title} (Latest)`; }
                }
              } else { searchQuery = title; requestLabel = `${title} (Latest)`; }
            } else { searchQuery = title; requestLabel = `${title} (Latest)`; }
          } catch { searchQuery = title; requestLabel = `${title} (Latest)`; }
        } else { searchQuery = title; requestLabel = tvMode === 'latest' ? `${title} (Latest)` : title; }
      } else {
        searchQuery = year ? `${title} ${year}` : title;
      }

      // Search Prowlarr
      let torrents = await prowlarrSearch(store, searchQuery, 'search', primaryIndexer, exclusiveIndexer);
      console.log(`[smart-grab] "${searchQuery}" => ${torrents.length} results`);

      // TV fallback searches
      if (contentType === 'tv' && !torrents.length) {
        if (tvMode === 'episode' && tvSeason && tvEpisode) {
          const fallback = `${title} S${String(tvSeason).padStart(2, '0')}`;
          console.log(`[smart-grab] No episode found, trying season: "${fallback}"`);
          torrents = await prowlarrSearch(store, fallback, 'search', primaryIndexer, exclusiveIndexer);
          if (torrents.length) { tvMode = 'season'; requestLabel += ' (via season pack)'; }
        } else if (tvMode === 'latest' && tvSeason) {
          torrents = await prowlarrSearch(store, year ? `${title} ${year} S${String(tvSeason).padStart(2, '0')}` : `${title} S${String(tvSeason).padStart(2, '0')}`, 'search', primaryIndexer, exclusiveIndexer);
        } else if (tvMode === 'full') {
          torrents = await prowlarrSearch(store, `${title} complete`, 'search', primaryIndexer, exclusiveIndexer);
          if (!torrents.length) torrents = await prowlarrSearch(store, `${title} all seasons`, 'search', primaryIndexer, exclusiveIndexer);
        }
      }
      if (contentType === 'tv' && !torrents.length) {
        console.log(`[smart-grab] Trying bare title: "${title}"`);
        torrents = await prowlarrSearch(store, title, 'search', primaryIndexer, exclusiveIndexer);
      }
      if (!torrents.length) return res.status(404).json({ error: 'No torrents found', query: searchQuery });

      // Select best torrent
      const best = selectBestTorrent(torrents, contentType, prefs, tvMode, tvSeason, year, tvEpisode);
      console.log(`[smart-grab] Best: ${best ? best.title + ' score:' + best._score : 'NONE'}`);
      if (!best) return res.status(404).json({ error: 'No suitable torrents found', query: searchQuery });

      // Resolve magnet if needed
      let grabUrl = (best.magnetUrl && best.magnetUrl.startsWith('magnet:')) ? best.magnetUrl : best.downloadUrl;
      if (!grabUrl || !grabUrl.startsWith('magnet:')) {
        try {
          const port = parseInt(process.env.PORT) || 9876;
          const resolveRes = await fetch('http://127.0.0.1:' + port + '/api/prowlarr/resolve-magnet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: best.title, guid: best.guid, infoUrl: best.infoUrl }),
            signal: AbortSignal.timeout(60000),
          });
          if (resolveRes.ok) {
            const rData = await resolveRes.json();
            if (rData.success && rData.downloadUrl) grabUrl = rData.downloadUrl;
          }
        } catch (e) { console.log('[smart-grab] Magnet resolution failed:', e.message); }
      }

      // Send to pipeline via auto-grab
      const renameType = contentType === 'tv' ? 'tv' : 'movie';
      const moveType = contentType === 'tv' ? 'tv' : 'movies';

      // Internal call to our own /auto-grab endpoint
      const port = parseInt(process.env.PORT) || 9876;
      const grabRes = await fetch(`http://127.0.0.1:${port}/auto-grab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: grabUrl, title: best.title, type: contentType, infoUrl: best.infoUrl }),
        signal: AbortSignal.timeout(10000),
      });
      if (!grabRes.ok) {
        const errData = await grabRes.json().catch(() => ({}));
        return res.status(500).json({ error: 'Failed to start pipeline: ' + (errData.error || grabRes.status) });
      }

      // Get current pipeline job count for tracking
      const { getJobs: getPJ } = require('./pipeline');
      const currentJobs = getPJ() || [];
      const minPipelineJobId = currentJobs.length ? Math.max(...currentJobs.map(j => j.id || 0)) : 0;

      res.json({
        success: true,
        message: `Queued: ${best.title}`,
        requestLabel,
        torrent: { title: best.title, size: best.size, seeders: best.seeders, indexer: best.indexer, score: best._score },
        tvMode: tvMode || null, tvSeason: tvSeason || null, tvEpisode: tvEpisode || null,
        minPipelineJobId,
      });
    } catch (e) {
      console.error('[smart-grab] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { setupSmartGrabRoutes };
