// ═══════════════════════════════════════════════════════════════════
// 1337x Direct Scraper — popular/trending pages and magnet resolution
// Extracted from prowlarr.js
// ═══════════════════════════════════════════════════════════════════

const { isLikelyEnglish } = require('media-manager-shared');

const LEET_BASES = ['https://1337x.to', 'https://1337xx.to', 'https://1337x.st'];

async function fetchWithFallback(paths, userAgent) {
  const errors = [];
  for (const base of LEET_BASES) {
    for (const p of (Array.isArray(paths) ? paths : [paths])) {
      try {
        const url = `${base}${p}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        });
        if (res.ok) {
          const html = await res.text();
          if (html.includes('<table') && html.includes('coll-1')) {
            return html;
          }
        }
      } catch (e) {
        errors.push(`${base}${p}: ${e.message}`);
      }
    }
  }
  throw new Error(`All 1337x sources failed: ${errors.join('; ')}`);
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const match = sizeStr.replace(/\s/g, '').match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'TB') return num * 1099511627776;
  if (unit === 'GB') return num * 1073741824;
  if (unit === 'MB') return num * 1048576;
  if (unit === 'KB') return num * 1024;
  return 0;
}

function parseTimeStr(timeStr) {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  const relMatch = trimmed.match(/(\d+)\s*(h|d|m)\.?\s*ago/i);
  if (relMatch) {
    const val = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const now = Date.now();
    if (unit === 'm') return new Date(now - val * 60000).toISOString();
    if (unit === 'h') return new Date(now - val * 3600000).toISOString();
    if (unit === 'd') return new Date(now - val * 86400000).toISOString();
  }
  return null;
}

function parse1337xTable(html) {
  const results = [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return results;
  const tbody = tbodyMatch[1];

  const rows = tbody.split(/<tr[\s>]/i).filter(r => r.includes('coll-1'));

  for (const row of rows) {
    try {
      const titleCell = row.match(/class="coll-1[^"]*"[\s\S]*?<\/td>/i);
      if (!titleCell) continue;

      const links = [...titleCell[0].matchAll(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi)];
      const torrentLink = links.find(l => l[1].startsWith('/torrent/'));
      if (!torrentLink) continue;

      const title = torrentLink[2].trim();
      const infoPath = torrentLink[1];

      const seedMatch = row.match(/class="coll-2[^"]*"[^>]*>(\d+)<\/td>/i) ||
                        row.match(/seeds[^>]*>(\d+)</i);
      const seeders = seedMatch ? parseInt(seedMatch[1]) : 0;

      const leechMatch = row.match(/class="coll-3[^"]*"[^>]*>(\d+)<\/td>/i) ||
                         row.match(/leech[^>]*>(\d+)</i);
      const leechers = leechMatch ? parseInt(leechMatch[1]) : 0;

      const timeMatch = row.match(/class="coll-date[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const timeStr = timeMatch ? timeMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const sizeMatch = row.match(/class="coll-4[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const sizeStr = sizeMatch ? sizeMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      if (title) {
        results.push({
          title,
          infoPath,
          seeders,
          leechers,
          size: parseSize(sizeStr),
          sizeStr,
          timeStr,
          publishDate: parseTimeStr(timeStr),
        });
      }
    } catch (e) {
      // Skip malformed rows
    }
  }

  return results;
}

async function scrape1337xMagnet(infoPath) {
  for (const base of LEET_BASES) {
    try {
      const url = `${base}${infoPath}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const html = await res.text();
      const magnetMatch = html.match(/href="(magnet:\?[^"]+)"/i);
      const imdbMatch = html.match(/tt(\d{7,9})/);
      if (magnetMatch) return { magnet: magnetMatch[1], imdbId: imdbMatch ? `tt${imdbMatch[1]}` : null };
    } catch {}
  }
  return { magnet: null, imdbId: null };
}

async function get1337xPopular(type, period) {
  const paths = [];
  const category = type === 'tv' ? 'tv' : type === 'anime' ? 'anime' : 'movies';

  if (category === 'anime') return [];

  if (period === 'day') {
    paths.push(`/popular-${category}`);
    paths.push(`/trending/d/${category}/`);
  } else if (period === 'week') {
    paths.push(`/popular-${category}-week`);
    paths.push(`/trending/w/${category}/`);
  } else if (period === 'month') {
    paths.push(`/popular-${category}-week`);
    paths.push(`/popular-${category}`);
    paths.push(`/trending/w/${category}/`);
  } else {
    paths.push(`/top-100-${category}`);
  }

  const allResults = [];
  const seenTitles = new Set();

  for (const p of paths) {
    try {
      const html = await fetchWithFallback(p);
      const parsed = parse1337xTable(html);
      for (const r of parsed) {
        const key = r.title.toLowerCase();
        if (!seenTitles.has(key)) {
          seenTitles.add(key);
          allResults.push(r);
        }
      }
    } catch (e) {
      // If one page fails, continue with others
    }
  }

  allResults.sort((a, b) => b.seeders - a.seeders);
  return allResults.slice(0, 20);
}

module.exports = {
  LEET_BASES,
  parse1337xTable,
  scrape1337xMagnet,
  get1337xPopular,
  fetchWithFallback,
  parseSize,
};
