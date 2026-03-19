// ═══════════════════════════════════════════════════════════════════
// Nyaa.si Scraper — anime torrent browsing and parsing
// Extracted from prowlarr.js
// ═══════════════════════════════════════════════════════════════════

const { isLikelyEnglish } = require('media-manager-shared');

function parseNyaaSize(str) {
  if (!str) return 0;
  const match = str.match(/([\d.]+)\s*(GiB|MiB|KiB|TiB|GB|MB|KB|TB)/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'tib' || unit === 'tb') return num * 1099511627776;
  if (unit === 'gib' || unit === 'gb') return num * 1073741824;
  if (unit === 'mib' || unit === 'mb') return num * 1048576;
  if (unit === 'kib' || unit === 'kb') return num * 1024;
  return 0;
}

function parseNyaaTable(html) {
  const results = [];
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return results;
  const tbody = tbodyMatch[1];
  const rows = tbody.split(/<tr[\s>]/i).filter(r => r.includes('</tr>'));

  for (const row of rows) {
    try {
      // Title — last <a> in the title column that isn't a comment link
      const titleLinks = [...row.matchAll(/<a[^>]*href="\/view\/(\d+)"[^>]*(?:title="([^"]*)")?[^>]*>([^<]*)<\/a>/gi)];
      const titleLink = titleLinks[titleLinks.length - 1];
      if (!titleLink) continue;
      const title = (titleLink[2] || titleLink[3] || '').trim();
      const viewId = titleLink[1];
      if (!title) continue;

      // Magnet link
      const magnetMatch = row.match(/href="(magnet:\?[^"]+)"/i);
      const magnet = magnetMatch ? magnetMatch[1] : null;

      // Size — typically 3rd or 4th <td>
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      const sizeStr = tds.find(t => /^\d+(\.\d+)?\s*(GiB|MiB|KiB|TiB|GB|MB|KB|TB)$/i.test(t)) || '';
      const size = parseNyaaSize(sizeStr);

      // Seeders/Leechers — try styled tds first, then fall back to positional
      const seedMatch = row.match(/class="text-success[^"]*"[^>]*>(\d+)<\/td>/i);
      const leechMatch = row.match(/class="text-danger[^"]*"[^>]*>(\d+)<\/td>/i);
      let seeders = seedMatch ? parseInt(seedMatch[1]) : 0;
      let leechers = leechMatch ? parseInt(leechMatch[1]) : 0;

      if (seeders === 0 && leechers === 0) {
        const numericTds = [...row.matchAll(/<td[^>]*class="text-center"[^>]*>(\d+)<\/td>/gi)].map(m => parseInt(m[1]));
        if (numericTds.length >= 2) {
          seeders = numericTds[0];
          leechers = numericTds[1];
        }
      }

      // Date
      const dateMatch = row.match(/data-timestamp="(\d+)"/i);
      const publishDate = dateMatch ? new Date(parseInt(dateMatch[1]) * 1000).toISOString() : null;

      results.push({
        title, seeders, leechers, size, sizeStr,
        publishDate,
        downloadUrl: magnet,
        infoUrl: `https://nyaa.si/view/${viewId}`,
        guid: `nyaa-${viewId}`,
        indexer: 'Nyaa',
        categories: [5070],
        indexerFlags: [],
      });
    } catch (e) { /* skip */ }
  }
  return results;
}

async function getNyaaPopular(period) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  let url;
  if (period === 'all') {
    url = 'https://nyaa.si/?f=0&c=1_0&q=&s=seeders&o=desc';
  } else {
    url = 'https://nyaa.si/?f=0&c=1_0&q=&s=seeders&o=desc';
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const html = await res.text();
    let results = parseNyaaTable(html);

    // Date-based filtering for day/week/month
    if (period !== 'all' && results.length > 0) {
      const now = Date.now();
      const cutoffs = { day: 86400000, week: 604800000, month: 2592000000 };
      const cutoff = cutoffs[period] || cutoffs.month;
      results = results.filter(r => {
        if (!r.publishDate) return true;
        return (now - new Date(r.publishDate).getTime()) <= cutoff;
      });
    }

    results.sort((a, b) => b.seeders - a.seeders);
    return results.slice(0, 20);
  } catch (e) {
    console.error('[nyaa] Scrape error:', e.message);
    return [];
  }
}

module.exports = {
  parseNyaaTable,
  parseNyaaSize,
  getNyaaPopular,
};
