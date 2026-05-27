#!/usr/bin/env node
// Validate all external URLs in v2/data/*.json
// Run: node v2/tools/check-links.js
// Follows redirects (reports final URL). Flags: 4xx/5xx, timeouts, failed Maps searches.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(__dirname, '_out');
const FLAGS_FILE = path.join(OUT_DIR, 'flags.json');
const RATE_LIMIT_MS = 1100;

const flags = [];

function flag(placeId, severity, code, message, suggestion) {
  flags.push({ tool: 'check-links', place_id: placeId || null, severity, code, message, suggestion: suggestion || null });
}

function extractUrls(obj, context, results) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (obj.match(/^https?:\/\//)) {
      results.push({ url: obj, context });
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => extractUrls(item, context, results));
    return;
  }
  if (typeof obj === 'object') {
    const id = obj.id || obj.place_id || null;
    const ctx = id ? `${context}#${id}` : context;
    for (const [key, val] of Object.entries(obj)) {
      extractUrls(val, ctx, results);
    }
  }
}

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'japan-trip-app-tools/0.1 (link checker)' },
      timeout: 10000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        let next = res.headers.location;
        if (next.startsWith('/')) {
          const parsed = new URL(url);
          next = `${parsed.protocol}//${parsed.host}${next}`;
        }
        res.resume();
        resolve(fetchUrl(next, maxRedirects - 1));
        return;
      }
      res.resume();
      resolve({ status: res.statusCode, finalUrl: url, redirected: maxRedirects < 5 });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, finalUrl: url }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', finalUrl: url }); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('check-links: extracting URLs from data files...');

  const urls = [];
  const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));

  for (const file of dataFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    extractUrls(data, file, urls);
  }

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const entry of urls) {
    if (!seen.has(entry.url)) {
      seen.add(entry.url);
      unique.push(entry);
    }
  }

  console.log(`Found ${unique.length} unique URLs across ${dataFiles.length} data files.`);

  let checked = 0;
  let broken = 0;

  for (const entry of unique) {
    checked++;
    process.stdout.write(`  [${checked}/${unique.length}] ${entry.url.substring(0, 70)}...`);

    const result = await fetchUrl(entry.url);

    if (result.status === 0) {
      flag(null, 'error', 'LINK_UNREACHABLE', `${entry.url} — ${result.error}`, `Found in ${entry.context}`);
      console.log(` FAIL (${result.error})`);
      broken++;
    } else if (result.status >= 400) {
      flag(null, 'error', 'LINK_HTTP_ERROR', `${entry.url} — HTTP ${result.status}`, `Found in ${entry.context}`);
      console.log(` FAIL (${result.status})`);
      broken++;
    } else {
      // Check for Maps failed search
      if (entry.url.includes('google.com/maps') && result.finalUrl === 'https://www.google.com/maps') {
        flag(null, 'warn', 'MAPS_FAILED_SEARCH', `${entry.url} resolved to generic Maps page`, `Found in ${entry.context}`);
        console.log(' WARN (maps generic)');
      } else {
        console.log(` OK (${result.status})`);
      }
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Append flags to existing flags file or create
  let existingFlags = [];
  if (fs.existsSync(FLAGS_FILE)) {
    try { existingFlags = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf-8')); } catch {}
  }
  // Remove old check-links flags, add new ones
  const merged = existingFlags.filter(f => f.tool !== 'check-links').concat(flags);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');

  console.log(`\ncheck-links complete: ${checked} checked, ${broken} broken, ${flags.length} flags total.`);
  process.exit(broken > 0 ? 1 : 0);
}

main();
