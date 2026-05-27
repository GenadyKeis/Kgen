#!/usr/bin/env node
// Reverse-geocode + pin self-test for v2/data/places.json
// Run: node v2/tools/geo-check.js
// Uses Nominatim (free, 1 req/sec, requires User-Agent).

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const PLACES_FILE = path.join(DATA_DIR, 'places.json');
const OUT_DIR = path.join(__dirname, '_out');
const FLAGS_FILE = path.join(OUT_DIR, 'flags.json');

const USER_AGENT = 'japan-trip-app-tools/0.1 (genadykeis@gmail.com)';
const RATE_LIMIT_MS = 1100;

// Per-category distance thresholds (meters) for pin self-test
const PROXIMITY_THRESHOLDS = {
  restaurant: 100,
  station: 200,
  hotel: 150,
  temple: 300,
  shrine: 300,
  garden: 200,
  museum: 200,
  hike: 500,
  default: 300
};

const flags = [];

function flag(placeId, severity, code, message, suggestion) {
  flags.push({ tool: 'geo-check', place_id: placeId || null, severity, code, message, suggestion: suggestion || null });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildCityLookup(meta) {
  const lookup = {};
  if (!meta || !meta.cities) return lookup;
  for (const city of meta.cities) {
    lookup[city.name.toLowerCase()] = city;
  }
  return lookup;
}

function expectedCityForPlace(place, meta) {
  if (!meta || !meta.cities) return null;
  // Find the closest city from meta
  let closest = null;
  let minDist = Infinity;
  for (const city of meta.cities) {
    const dist = haversineMeters(place.lat, place.lon, city.lat, city.lon);
    if (dist < minDist) {
      minDist = dist;
      closest = city.name;
    }
  }
  return closest;
}

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&addressdetails=1&accept-language=en`;
  return fetchJson(url);
}

async function forwardSearch(name, lat, lon) {
  const bbox = 0.01; // ~1km box
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&addressdetails=1&limit=3&viewbox=${lon - bbox},${lat + bbox},${lon + bbox},${lat - bbox}&bounded=1&accept-language=en`;
  return fetchJson(url);
}

async function main() {
  console.log('geo-check: loading data...');

  if (!fs.existsSync(PLACES_FILE)) {
    console.error('places.json not found');
    process.exit(1);
  }

  const places = JSON.parse(fs.readFileSync(PLACES_FILE, 'utf-8'));
  let meta = null;
  if (fs.existsSync(META_FILE)) {
    meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  }

  console.log(`Checking ${places.length} places against Nominatim...\n`);

  for (const place of places) {
    if (typeof place.lat !== 'number' || typeof place.lon !== 'number') {
      flag(place.id, 'error', 'NO_COORDS', `${place.name_en}: missing coordinates`);
      continue;
    }

    process.stdout.write(`  ${place.id}: `);

    // --- GEO-CHECK: reverse geocode, assert locality ---
    try {
      const rev = await reverseGeocode(place.lat, place.lon);
      const addr = rev.address || {};
      const locality = addr.city || addr.town || addr.village || addr.county || '';
      const expectedCity = expectedCityForPlace(place, meta);
      const displayName = rev.display_name || '';

      const inJapan = (addr.country_code === 'jp');
      if (!inJapan) {
        flag(place.id, 'error', 'NOT_IN_JAPAN', `Reverse geocode says country=${addr.country_code}, not Japan`);
        console.log(`FAIL (not in Japan: ${addr.country_code})`);
      } else if (expectedCity && !locality.toLowerCase().includes(expectedCity.toLowerCase().replace(' / ', '').replace('/', ''))) {
        // Fuzzy: check if the expected city name appears in any address field
        const allAddr = Object.values(addr).join(' ').toLowerCase();
        const cityVariants = [expectedCity.toLowerCase(), expectedCity.toLowerCase().replace(' ', '')];
        const found = cityVariants.some(v => allAddr.includes(v));
        if (!found) {
          flag(place.id, 'warn', 'LOCALITY_MISMATCH', `Expected near "${expectedCity}", reverse geocode says: ${locality || displayName.substring(0, 80)}`, 'Coordinates may be off — verify manually');
          console.log(`WARN (locality: ${locality || '?'}, expected: ${expectedCity})`);
        } else {
          console.log(`OK (locality: ${locality || addr.province || '?'})`);
        }
      } else {
        console.log(`OK (locality: ${locality || addr.province || '?'})`);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (e) {
      flag(place.id, 'warn', 'REVERSE_FAILED', `Reverse geocode failed: ${e.message}`);
      console.log(`SKIP (${e.message})`);
      await sleep(RATE_LIMIT_MS);
    }

    // --- PIN SELF-TEST: forward search near coords, check proximity + name ---
    try {
      const results = await forwardSearch(place.name_en, place.lat, place.lon);
      const threshold = PROXIMITY_THRESHOLDS[place.category] || PROXIMITY_THRESHOLDS.default;

      if (results.length === 0) {
        // Try Japanese name
        const jpResults = await forwardSearch(place.name_jp, place.lat, place.lon);
        await sleep(RATE_LIMIT_MS);

        if (jpResults.length === 0) {
          flag(place.id, 'info', 'PIN_NO_MATCH', `No Nominatim results for "${place.name_en}" or "${place.name_jp}" near coords`, 'Place may not be indexed in OSM — verify coordinates manually');
          process.stdout.write(`    pin-test: no OSM match\n`);
        } else {
          const best = jpResults[0];
          const dist = haversineMeters(place.lat, place.lon, parseFloat(best.lat), parseFloat(best.lon));
          if (dist > threshold) {
            flag(place.id, 'warn', 'PIN_DISTANCE', `"${place.name_jp}" found ${Math.round(dist)}m from stored coords (threshold: ${threshold}m)`, `OSM result at ${best.lat},${best.lon}: ${best.display_name}`);
            process.stdout.write(`    pin-test: JP match ${Math.round(dist)}m away (WARN)\n`);
          } else {
            process.stdout.write(`    pin-test: JP match ${Math.round(dist)}m away (OK)\n`);
          }
        }
      } else {
        const best = results[0];
        const dist = haversineMeters(place.lat, place.lon, parseFloat(best.lat), parseFloat(best.lon));
        if (dist > threshold) {
          flag(place.id, 'warn', 'PIN_DISTANCE', `"${place.name_en}" found ${Math.round(dist)}m from stored coords (threshold: ${threshold}m)`, `OSM result at ${best.lat},${best.lon}: ${best.display_name}`);
          process.stdout.write(`    pin-test: ${Math.round(dist)}m away (WARN)\n`);
        } else {
          process.stdout.write(`    pin-test: ${Math.round(dist)}m away (OK)\n`);
        }
      }

      await sleep(RATE_LIMIT_MS);
    } catch (e) {
      flag(place.id, 'info', 'PIN_FAILED', `Pin self-test failed: ${e.message}`);
      process.stdout.write(`    pin-test: SKIP (${e.message})\n`);
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Merge flags into flags.json
  let existingFlags = [];
  if (fs.existsSync(FLAGS_FILE)) {
    try { existingFlags = JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf-8')); } catch {}
  }
  const merged = existingFlags.filter(f => f.tool !== 'geo-check').concat(flags);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');

  const errors = flags.filter(f => f.severity === 'error');
  const warns = flags.filter(f => f.severity === 'warn');
  const infos = flags.filter(f => f.severity === 'info');
  console.log(`\ngeo-check complete: ${errors.length} errors, ${warns.length} warnings, ${infos.length} info`);

  if (errors.length > 0) {
    console.log('\nERRORS:');
    for (const f of errors) console.log(`  [${f.code}] ${f.place_id}: ${f.message}`);
  }
  if (warns.length > 0) {
    console.log('\nWARNINGS:');
    for (const f of warns) console.log(`  [${f.code}] ${f.place_id}: ${f.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
