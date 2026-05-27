#!/usr/bin/env node
// Deterministic sanity checks over v2/data/*.json
// Run: node v2/tools/sanity-check.js

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(__dirname, '_out');

const VALID_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const VALID_CATEGORIES = ['temple', 'shrine', 'hike', 'garden', 'museum', 'restaurant', 'station', 'hotel', 'onsen', 'market', 'park', 'viewpoint'];
const CATEGORIES_REQUIRING_HOURS = ['temple', 'shrine', 'garden', 'museum', 'restaurant'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
const JAPAN_BBOX = { latMin: 24, latMax: 46, lonMin: 122, lonMax: 154 };

const flags = [];

function flag(tool, placeId, severity, code, message, suggestion) {
  flags.push({ tool, place_id: placeId || null, severity, code, message, suggestion: suggestion || null });
}

function loadJson(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    flag('sanity-check', null, 'error', 'FILE_MISSING', `${filename} not found`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    flag('sanity-check', null, 'error', 'JSON_PARSE', `${filename}: ${e.message}`);
    return null;
  }
}

function isValidTime(t) {
  if (typeof t !== 'string') return false;
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function checkPlaces(places) {
  if (!Array.isArray(places)) {
    flag('sanity-check', null, 'error', 'PLACES_NOT_ARRAY', 'places.json root is not an array');
    return new Set();
  }

  const ids = new Set();
  const dupes = new Set();

  for (const p of places) {
    // ID uniqueness
    if (ids.has(p.id)) {
      dupes.add(p.id);
      flag('sanity-check', p.id, 'error', 'DUPLICATE_ID', `Duplicate place ID: ${p.id}`);
    }
    ids.add(p.id);

    // Required fields
    for (const field of ['id', 'name_en', 'name_jp', 'lat', 'lon', 'address_jp', 'category', 'confidence']) {
      if (p[field] === undefined || p[field] === null || p[field] === '') {
        flag('sanity-check', p.id, 'error', 'MISSING_FIELD', `Missing required field: ${field}`);
      }
    }

    // Category
    if (p.category && !VALID_CATEGORIES.includes(p.category)) {
      flag('sanity-check', p.id, 'warn', 'UNKNOWN_CATEGORY', `Unknown category: ${p.category}`, `Valid: ${VALID_CATEGORIES.join(', ')}`);
    }

    // Confidence
    if (p.confidence && !VALID_CONFIDENCE.includes(p.confidence)) {
      flag('sanity-check', p.id, 'error', 'INVALID_CONFIDENCE', `Invalid confidence: ${p.confidence}`, `Valid: ${VALID_CONFIDENCE.join(', ')}`);
    }

    // Bounding box
    if (typeof p.lat === 'number' && typeof p.lon === 'number') {
      if (p.lat < JAPAN_BBOX.latMin || p.lat > JAPAN_BBOX.latMax ||
          p.lon < JAPAN_BBOX.lonMin || p.lon > JAPAN_BBOX.lonMax) {
        flag('sanity-check', p.id, 'error', 'OUTSIDE_JAPAN', `Coordinates (${p.lat}, ${p.lon}) outside Japan bbox`);
      }
    }

    // Hours validation
    if (CATEGORIES_REQUIRING_HOURS.includes(p.category) && p.hours === undefined) {
      flag('sanity-check', p.id, 'warn', 'MISSING_HOURS', `Category "${p.category}" normally requires hours`);
    }

    if (p.hours && typeof p.hours === 'object') {
      const HOURS_META_KEYS = ['closed_notes', 'recurring_closed', 'exceptions'];
      for (const [key, ranges] of Object.entries(p.hours)) {
        if (HOURS_META_KEYS.includes(key)) continue;
        if (!VALID_WEEKDAYS.includes(key)) {
          flag('sanity-check', p.id, 'error', 'INVALID_HOURS_KEY', `Invalid hours key: "${key}"`, `Use weekday keys: ${VALID_WEEKDAYS.join(', ')}`);
        }
        if (ranges === null) continue; // null = closed that day
        if (!Array.isArray(ranges)) {
          flag('sanity-check', p.id, 'error', 'HOURS_FORMAT', `hours.${key} must be array or null, got ${typeof ranges}`);
          continue;
        }
        for (const range of ranges) {
          if (!Array.isArray(range) || range.length !== 2) {
            flag('sanity-check', p.id, 'error', 'HOURS_RANGE', `hours.${key} contains invalid range (must be [open, close])`);
            continue;
          }
          const [open, close] = range;
          if (!isValidTime(open)) {
            flag('sanity-check', p.id, 'error', 'INVALID_TIME', `hours.${key} has invalid open time: ${open}`);
          }
          if (!isValidTime(close)) {
            flag('sanity-check', p.id, 'error', 'INVALID_TIME', `hours.${key} has invalid close time: ${close}`);
          }
          if (isValidTime(open) && isValidTime(close) && open >= close) {
            flag('sanity-check', p.id, 'warn', 'HOURS_OVERNIGHT', `hours.${key} open (${open}) >= close (${close}) — overnight?`);
          }
        }
      }
    }

    // Phone format
    if (p.phone && typeof p.phone === 'string') {
      if (!p.phone.startsWith('+81')) {
        flag('sanity-check', p.id, 'warn', 'PHONE_FORMAT', `Phone "${p.phone}" doesn't start with +81`);
      }
    }
  }

  return ids;
}

function checkRefs(data, filename, placeIds) {
  // Recursively find all place_id references and verify they resolve
  const check = (obj, path) => {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') return;
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => check(item, `${path}[${i}]`));
      return;
    }
    if (typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        if (key === 'place_id' && typeof val === 'string') {
          if (!placeIds.has(val)) {
            flag('sanity-check', val, 'error', 'UNRESOLVED_REF', `${filename} at ${path}.place_id references unknown place: "${val}"`);
          }
        }
        check(val, `${path}.${key}`);
      }
    }
  };
  check(data, filename);
}

function checkMeta(meta) {
  if (!meta) return;
  if (!meta.start_date || !meta.end_date) {
    flag('sanity-check', null, 'error', 'META_DATES', 'meta.json missing start_date or end_date');
  }
  if (meta.dates && meta.total_days && meta.dates.length !== meta.total_days) {
    flag('sanity-check', null, 'error', 'META_DAYS_MISMATCH', `meta.json total_days (${meta.total_days}) != dates array length (${meta.dates.length})`);
  }
  if (meta.cities) {
    for (const city of meta.cities) {
      if (!city.name || typeof city.lat !== 'number' || typeof city.lon !== 'number') {
        flag('sanity-check', null, 'warn', 'META_CITY', `City entry missing name/lat/lon: ${JSON.stringify(city)}`);
      }
    }
  }
}

function checkPhrases(phrases) {
  if (!phrases || !phrases.groups) return;
  for (const group of phrases.groups) {
    if (!group.id || !group.title) {
      flag('sanity-check', null, 'error', 'PHRASE_GROUP', `Phrase group missing id or title`);
    }
    if (!Array.isArray(group.phrases)) continue;
    for (const phrase of group.phrases) {
      for (const field of ['en', 'jp', 'romaji']) {
        if (!phrase[field]) {
          flag('sanity-check', null, 'error', 'PHRASE_FIELD', `Phrase in group "${group.id}" missing ${field}: "${phrase.en || '?'}"`);
        }
      }
    }
  }
}

function checkSos(sos) {
  if (!sos) return;
  if (sos.emergency_numbers) {
    for (const num of sos.emergency_numbers) {
      for (const field of ['label', 'number', 'tel']) {
        if (!num[field]) {
          flag('sanity-check', null, 'error', 'SOS_NUMBER', `Emergency number missing ${field}: "${num.label || '?'}"`);
        }
      }
    }
  }
  if (sos.hotels) {
    for (const hotel of sos.hotels) {
      for (const field of ['city', 'name_en', 'phone', 'tel']) {
        if (!hotel[field]) {
          flag('sanity-check', null, 'warn', 'SOS_HOTEL', `Hotel "${hotel.name_en || '?'}" missing ${field}`);
        }
      }
    }
  }
}

// --- Main ---
console.log('sanity-check: loading data files...');

const places = loadJson('places.json');
const days = loadJson('days.json');
const food = loadJson('food.json');
const phrases = loadJson('phrases.json');
const sos = loadJson('sos.json');
const meta = loadJson('meta.json');

let placeIds = new Set();
if (places) placeIds = checkPlaces(places);
if (days) checkRefs(days, 'days.json', placeIds);
if (food) checkRefs(food, 'food.json', placeIds);
checkMeta(meta);
checkPhrases(phrases);
checkSos(sos);

// Merge flags into flags.json (preserve other tools' flags)
let existingFlags = [];
const flagsPath = path.join(OUT_DIR, 'flags.json');
if (fs.existsSync(flagsPath)) {
  try { existingFlags = JSON.parse(fs.readFileSync(flagsPath, 'utf-8')); } catch {}
}
const merged = existingFlags.filter(f => f.tool !== 'sanity-check').concat(flags);
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(flagsPath, JSON.stringify(merged, null, 2), 'utf-8');

// Summary
const errors = flags.filter(f => f.severity === 'error');
const warns = flags.filter(f => f.severity === 'warn');
const infos = flags.filter(f => f.severity === 'info');

console.log(`\nsanity-check complete: ${errors.length} errors, ${warns.length} warnings, ${infos.length} info`);
if (errors.length > 0) {
  console.log('\nERRORS:');
  for (const f of errors) console.log(`  [${f.code}] ${f.place_id || '-'}: ${f.message}`);
}
if (warns.length > 0) {
  console.log('\nWARNINGS:');
  for (const f of warns) console.log(`  [${f.code}] ${f.place_id || '-'}: ${f.message}`);
}

process.exit(errors.length > 0 ? 1 : 0);
