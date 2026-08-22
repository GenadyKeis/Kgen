(function () {
  'use strict';

  // ─── Service Worker registration ──────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  }

  // ─── Helpers ──────────────────────────────────────────────
  var DATA = {};

  function jstNow() {
    var now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  }

  function jstToday() {
    var jst = jstNow();
    return new Date(jst.getFullYear(), jst.getMonth(), jst.getDate());
  }

  function tripDayNumber(meta) {
    var today = jstToday();
    var start = new Date(meta.start_date + 'T00:00:00');
    var end = new Date(meta.end_date + 'T23:59:59');
    if (today < start) return -Math.ceil((start - today) / 86400000);
    if (today > end) return meta.total_days + 1;
    return Math.floor((today - start) / 86400000) + 1;
  }

  // textContent -> innerHTML escapes & < > but NOT the double quote, and this
  // app puts esc() output inside double-quoted attributes everywhere
  // (data-copy, data-speak, data-fs-jp, href="tel:…"). Five data strings today
  // contain a quote — a map note, two place notes, a closed_notes, an SOS
  // note_en — and all five happen to render as text, so nothing is broken. The
  // next prose field bound to an attribute would be. In text position the
  // browser renders &quot; as ", and getAttribute() returns it decoded, so this
  // is invisible on every string in the dataset.
  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;');
  }

  function placeById(id) {
    if (!DATA.places) return null;
    for (var i = 0; i < DATA.places.length; i++) {
      if (DATA.places[i].id === id) return DATA.places[i];
    }
    return null;
  }

  // ─── Map URL helpers (coordinate-anchored, never text queries) ──
  function mapsPinUrl(place) {
    return 'https://www.google.com/maps/search/?api=1&query=' +
      place.lat + ',' + place.lon;
  }

  function mapsWalkUrl(place) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' +
      place.lat + ',' + place.lon + '&travelmode=walking';
  }

  // Organic Maps, raw-coordinate form. 🔴 VERIFIED ON HIS HANDSET
  // 2026-08-22 before a single button was built, because a URL scheme's
  // REGISTRATION is a property of his phone that nothing here can see:
  // `geo:35.62523,139.24369?z=15` fell back to a Safari web search (geo: is
  // an Android convention Organic Maps does not claim on iOS), while
  // `om://map?v=1&ll=...&n=...` opened the app on Mount Takao.
  // ⛔ Do NOT switch this to the om://o4B4pYZsRs point form — that is a ge0
  // short code this app would have to ENCODE, and encoding it wrong produces
  // a button that opens the right app at the wrong place, which is worse
  // than no button. The ll= form needs no encoding at all.
  // The n= label is the Japanese name so the pin reads like the map around
  // it; Organic Maps labels its Japanese data in Japanese.
  function organicMapsUrl(place) {
    return 'om://map?v=1&ll=' + place.lat + ',' + place.lon +
      '&n=' + encodeURIComponent(place.search_jp || place.name_jp || place.name || '');
  }

  function mapsTransitUrl(originPlace, destPlace) {
    return 'https://www.google.com/maps/dir/?api=1' +
      '&origin=' + originPlace.lat + ',' + originPlace.lon +
      '&destination=' + destPlace.lat + ',' + destPlace.lon +
      '&travelmode=transit';
  }

  // ─── Display helpers ──────────────────────────────────────
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    return MONTHS[parseInt(iso.slice(5, 7), 10) - 1] + ' ' + parseInt(iso.slice(8, 10), 10);
  }

  var WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Local wall-clock datetime → "Wed 21 Oct · 19:45" (times are as authored, i.e. the
  // airport's local time on the ticket; weekday derived UTC-safe to avoid TZ drift).
  function fmtDateTime(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return iso || '';
    var wd = WEEKDAYS_SHORT[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return wd + ' ' + (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' · ' + m[4] + ':' + m[5];
  }

  function isoDate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // mode → [badge class, badge label]; "transit" = multi-modal/generic
  var MODE_BADGES = {
    walking: ['walk', 'Walk'], train: ['transit', 'Train'], bus: ['transit', 'Bus'],
    tram: ['transit', 'Tram'], ferry: ['transit', 'Ferry'], cablecar: ['transit', 'Cable Car'],
    taxi: ['private', 'Taxi'], transit: ['transit', 'Transit']
  };

  function legBadge(leg) {
    var m = MODE_BADGES[leg.mode] || MODE_BADGES.transit;
    return { cls: m[0], label: m[1] };
  }

  function legCostText(leg) {
    if (leg.covered_by_pass) return 'JR Pass';
    if (typeof leg.cost_jpy === 'number') {
      return '¥' + leg.cost_jpy.toLocaleString() +
        (leg.cost_note ? ' (' + leg.cost_note + ')' : '');
    }
    return '';
  }

  // ─── Tap-to-copy ─────────────────────────────────────────
  // The toast carries the affordance, because the alternative was a printed
  // line on every one of 21 days. Item 1 asked what the copyables are FOR and
  // the answer turned out to be two different answers (§X.74.7): a booking
  // number is for pasting into Booking.com, a Japanese place name is for
  // pasting into the OFFLINE map — measured at 82% of sights findable that
  // way, 93% once `search_jp` strips our own decoration, and only 26% of
  // restaurants, which is why restaurants no longer offer it at all.
  // A toast fires at the exact moment the answer is needed and costs no layout.
  function copyText(text, hint) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    }
    if (navigator.vibrate) navigator.vibrate(10);
    showCopyToast(hint);
  }

  // ─── Long prose, collapsed behind a tap ──────────────────
  // Walkthrough finding, 2026-08-22: "The prose is all over the place… it
  // takes the whole screen. It's hard to see the important parts." Measured
  // before changing anything: 322 prose fields on the food cards carrying
  // 107,505 characters — 85 over 400, 16 over 700, worst 1,650. The card he
  // photographed is 1,634, about 36 lines on his handset, and is the 2nd
  // worst of 322 rather than an outlier.
  // ⚑ The prose pass ALREADY RAN and this is what survived it, so the fix is
  // not more editing — the RENDERER has to separate the action from the
  // reasoning. First sentence always visible, the rest one tap away.
  // ⛔ Deletes nothing and re-researches nothing: every character is still
  // on the card, which is why this was the first thing to do and the
  // 322-field schema sweep was refused.
  var PROSE_LIMIT = 320;

  function longProse(text) {
    if (!text) return '';
    if (text.length <= PROSE_LIMIT) return esc(text);
    // Cut at the end of a sentence so the visible half is never a fragment.
    // Japanese full stops count: several fields end a clause with 。
    var m = /^[\s\S]{40,}?[.!?。？！](\s|$)/.exec(text);
    var head = m ? m[0].trim() : text.slice(0, 200);
    if (head.length > PROSE_LIMIT) head = text.slice(0, PROSE_LIMIT);
    var rest = text.slice(head.length).trim();
    if (!rest) return esc(text);
    return esc(head) +
      ' <span class="prose-rest" hidden>' + esc(rest) + '</span>' +
      '<button type="button" class="prose-toggle">more</button>';
  }

  function bindProseToggles(root) {
    var els = root.querySelectorAll('.prose-toggle');
    for (var i = 0; i < els.length; i++) {
      els[i].addEventListener('click', function (e) {
        e.stopPropagation();
        var rest = this.previousElementSibling;
        if (!rest) return;
        var isOpen = !rest.hidden;
        rest.hidden = isOpen;
        this.textContent = isOpen ? 'more' : 'less';
      });
    }
  }

  function showCopyToast(hint) {
    var existing = document.querySelector('.copy-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = hint ? 'Copied — ' + hint : 'Copied';
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 1900);
  }

  // ─── Fullscreen overlay ───────────────────────────────────
  // This is the one surface in the app built to be turned around and shown to
  // another person, so it is also where the two Japanese controls belong. One
  // branch serves the 41 phrases AND the six SOS show-to-staff cards — building
  // it for phrases alone and again for SOS later is the §X.31.8 defect, and the
  // SOS lines are the ones that most need to be audible: 助けてください、救急車を
  // 呼んでください is not a line to mispronounce at someone.
  //
  // ⚠ Gated on opts.speakable, NOT on opts.jp, and the difference is the hotel
  // card: its overlay carries name + newline + ADDRESS, which is a place, not an
  // utterance. A speaker button there would offer to read a Japanese address
  // aloud at a taxi driver — a use nobody has tested and a pronunciation nobody
  // has checked. That card is a deliberate exclusion, not an oversight.
  function showFullscreen(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'fs-overlay';
    var html = '';
    html += '<button class="fs-close" aria-label="Close">✕</button>';
    if (opts.jp) html += '<div class="fs-jp">' + esc(opts.jp) + '</div>';
    if (opts.romaji) html += '<div class="fs-romaji">' + esc(opts.romaji) + '</div>';
    if (opts.en) html += '<div class="fs-en">' + esc(opts.en) + '</div>';
    if (opts.context) html += '<div class="fs-context">' + esc(opts.context) + '</div>';
    if (opts.jp && opts.speakable) {
      html += '<div class="fs-actions">';
      html += '<button type="button" class="jp-btn fs-btn" data-speak="' + esc(opts.jp) + '">🔊 Say it</button>';
      // sl=ja puts the Japanese in Translate's SOURCE pane, where Translate's
      // own speaker plays it back IN JAPANESE — which is the point: he is
      // playing this at a listener. A tl=ja construction would render the line
      // as translation OUTPUT and the speaker would read the wrong side.
      // tl=en gives him the reading back. Same URL the food card ships.
      // A real anchor, not window.open: in an iOS standalone PWA window.open
      // is popup-blocked or lands in a view with no way back.
      html += '<a class="jp-btn fs-btn" target="_blank" rel="noopener" href="https://translate.google.com/?sl=ja&amp;tl=en&amp;op=translate&amp;text=' +
        esc(encodeURIComponent(opts.jp)) + '">🌐 Translate</a>';
      html += '</div>';
      // An offline-first app cannot ship a button that needs signal without
      // saying so. 🔊 is speechSynthesis on the handset and works with none;
      // 🌐 leaves the app for a server.
      html += '<div class="fs-hint">🔊 plays on this phone, no signal needed. 🌐 opens Google Translate and needs a connection.</div>';
    }
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    var fsClose = overlay.querySelector('.fs-close');
    fsClose.addEventListener('click', function () { overlay.remove(); });
    // Same insurance as the almanac Back button: this overlay scrolls too (a
    // long SOS card overflows a small viewport), and §X.73.8 already caught
    // this control being stranded once. `overlay.remove()` on an already
    // removed node is a no-op, so a double fire costs nothing.
    fsClose.addEventListener('touchend', function (e) {
      e.preventDefault();
      overlay.remove();
    });
    bindJpSay(overlay);
    if (navigator.vibrate) navigator.vibrate(10);
  }

  // ─── Collapsible toggle ───────────────────────────────────
  function toggleCard(el) {
    el.classList.toggle('card-open');
    if (navigator.vibrate) navigator.vibrate(10);
  }

  // ─── Place card renderer ──────────────────────────────────
  // Recurring-closure / exception check shared by the badge and the hours summary,
  // so the two can never contradict each other.
  function closedTodayByRule(place, now) {
    if (!place.hours) return null;
    var todayISO = isoDate(now);
    if (place.hours.exceptions) {
      for (var e = 0; e < place.hours.exceptions.length; e++) {
        var exc = place.hours.exceptions[e];
        if (exc.date === todayISO && exc.closed) {
          return { note: exc.note || null };
        }
      }
    }
    var recurring = place.hours.recurring_closed || [];
    var todayKey = WEEKDAY_KEYS[now.getDay()];
    for (var rc = 0; rc < recurring.length; rc++) {
      var rule = recurring[rc];
      if (rule.weekday !== todayKey) continue;
      if (!rule.nth) return { note: null };
      var nthWeek = Math.ceil(now.getDate() / 7);
      for (var n = 0; n < rule.nth.length; n++) {
        if (rule.nth[n] === nthWeek) return { note: null };
      }
    }
    return null;
  }

  function todayHoursSummary(place) {
    if (!place || !place.hours) return '';
    var now = jstNow();
    if (closedTodayByRule(place, now)) return 'Closed today';
    var todayKey = WEEKDAY_KEYS[now.getDay()];
    var intervals = place.hours[todayKey];

    if (intervals === null || intervals === undefined) return 'Closed today';
    if (!Array.isArray(intervals) || intervals.length === 0) return '';

    var parts = [];
    for (var i = 0; i < intervals.length; i++) {
      parts.push(intervals[i][0] + '–' + intervals[i][1]);
    }
    // Hours are evaluated in Japan time (jstNow), so the label names the zone —
    // viewed from home the chip is otherwise computed in a timezone the card never states.
    return 'Today (JST): ' + parts.join(', ');
  }

  function renderPlaceCard(place, detail, opts) {
    opts = opts || {};
    var html = '';
    html += '<div class="item" data-place-id="' + esc(place.id) + '">';
    if (!opts.noName) {
      html += '<div class="item-name">' + esc(place.name_en);
      if (place.name_jp) {
        // ⚠ The copy is NOT the displayed string when they differ. `name_jp` is
        // the formal display name and the Show-to-Staff string — 「賀茂御祖神社
        // （下鴨神社）」, 「高雄山 神護寺」 — and that decoration is exactly what an
        // offline map search fails on. `search_jp` (13 places) is what the map
        // actually holds. Display stays formal; the clipboard gets the query.
        // ⛔ Restaurants get NO copy: measured 11 of 43 findable by name in OSM
        // (§X.74.9). A control that works a quarter of the time, with no way to
        // tell which quarter, is worse than one that is absent.
        if (place.category === 'restaurant') {
          html += ' <span class="item-name-jp">' + esc(place.name_jp) + '</span>';
        } else {
          html += ' <span class="item-name-jp copyable" data-copy="' + esc(place.search_jp || place.name_jp) +
            '" data-copy-hint="paste into your offline map">' + esc(place.name_jp) + '</span>';
        }
      }
      html += '</div>';
    }
    if (detail) {
      html += '<div class="item-detail">' + esc(detail) + '</div>';
    }

    // Place info row (hours summary, price, address)
    var infoParts = [];
    var hoursTxt = todayHoursSummary(place);
    if (hoursTxt) infoParts.push('<span class="place-hours">' + esc(hoursTxt) + '</span>');
    if (place.price) infoParts.push('<span>' + esc(place.price) + '</span>');
    if (place.address_jp) {
      infoParts.push('<span class="copyable" data-copy="' + esc(place.address_jp) + '">' + esc(place.address_jp) + '</span>');
    }
    if (infoParts.length > 0) {
      html += '<div class="place-info">' + infoParts.join('') + '</div>';
    }

    // Action buttons
    html += '<div class="btn-row">';
    html += '<a class="btn btn-maps" href="' + mapsPinUrl(place) + '" target="_blank" rel="noopener">📍 Map</a>';
    html += '<a class="btn btn-walk" href="' + mapsWalkUrl(place) + '" target="_blank" rel="noopener">🚶 Walk</a>';
    // 🧭 Offline — only on the seven days that carry a walk.
    // ⛔ NOT on all 75 place cards, and the reason is a measurement: the
    // button count was cut 257 -> 232 an hour earlier on his own "tidy up"
    // finding, and putting this everywhere would take it to 307 — further
    // than where it started. On the 26 walking-day cards it costs 232 -> 258.
    // ⚑ The rule is POSITIONAL, not a judgement about which places are
    // remote: the day carries a `maps` array, i.e. it is a walking day.
    // That is also exactly where Organic Maps beats Google Maps — no signal
    // and a drawn path network. In a city with data, Google is the better map.
    if (opts.offlineMap) {
      html += '<a class="btn btn-maps" href="' + organicMapsUrl(place) + '">🧭 Offline</a>';
    }
    // No 📞 on a restaurant. He does not speak Japanese and cannot hold a phone
    // call with a Japanese venue — a standing constraint, restated at the R7
    // walkthrough ("make sure there are no restaurants chosen where I need to
    // call beforehand"). The number stays in places.json because it is true and
    // a hotel front desk may yet dial it; what is wrong is the button offering
    // him the call. Hotels and the medical records keep theirs: those are lines
    // he can actually use, in English or through a desk.
    if (place.phone && place.category !== 'restaurant') {
      html += '<a class="btn btn-call" href="tel:' + esc(place.phone) + '">📞 Call</a>';
    }
    if (place.url) {
      html += '<a class="btn btn-web" href="' + esc(place.url) + '" target="_blank" rel="noopener">🔗 Web</a>';
    }
    // Every sightseeing place has an almanac entry by construction — see loadAlmanac()
    if (ALMANAC_NO_ENTRY.indexOf(place.category) === -1) {
      html += '<button class="btn btn-almanac" data-almanac="' + esc(place.id) + '">📖 About</button>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ─── Transit leg renderer ─────────────────────────────────
  // `coveredNext` is the set of place ids the NEXT block renders as its own
  // card. A walking leg's button and that card's 🚶 Walk are byte-identical
  // URLs — mapsWalkUrl() takes no origin, so both route from current location
  // — so showing both puts the same control on screen twice, which is half of
  // the "inconsistency in the directions buttons" he reported 2026-08-22.
  // ⛔ Measured before cutting: of 39 walking legs with a mappable
  // destination, 25 have that destination in the very next block and 14 have
  // it NOWHERE ELSE ON THE DAY. Only the 25 are suppressed; for the other 14
  // this button is the only way there and it stays.
  // ⚠ The Transit TAB passes nothing, because it renders no place cards —
  // there the leg button is always the only control.
  function renderTransitLegs(legs, coveredNext) {
    if (!legs || legs.length === 0) return '';
    var html = '<div class="transit-box">';
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      var badge = legBadge(leg);

      html += '<div class="tleg">';
      html += '<span class="tleg-badge ' + badge.cls + '">' + esc(badge.label) + '</span>';
      html += '<div class="tleg-info">';
      html += '<div class="tleg-label">' + esc(leg.label) + '</div>';
      if (leg.detail) html += '<div class="tleg-detail">' + esc(leg.detail) + '</div>';
      // Board-and-pay: which door · when you pay · one tap or two · what if the card fails.
      // Its own row, never folded into detail — a prose pass must not be able to trim it.
      if (leg.payment) {
        html += '<div class="tleg-payment"><span class="tleg-payment-label">Boarding &amp; paying</span>' +
          esc(leg.payment) + '</div>';
      }
      var costTxt = legCostText(leg);
      if (costTxt) html += '<div class="tleg-cost">' + esc(costTxt) + '</div>';

      // Transit directions link
      var origin = placeById(leg.origin_id);
      var dest = placeById(leg.destination_id);
      var duplicated = leg.mode === 'walking' && coveredNext &&
        coveredNext.indexOf(leg.destination_id) !== -1;
      if (origin && dest && !duplicated) {
        var tUrl = leg.mode === 'walking' ? mapsWalkUrl(dest) : mapsTransitUrl(origin, dest);
        html += '<a class="btn btn-transit" href="' + tUrl + '" target="_blank" rel="noopener" style="margin-top:6px;display:inline-flex;">' + (leg.mode === 'walking' ? '🚶 Walk' : '🚉 Directions') + '</a>';
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── Days section renderer ────────────────────────────────
  function renderDays() {
    var container = document.getElementById('section-days');
    if (!DATA.days || DATA.days.length === 0) {
      container.innerHTML = '<div class="section-empty">No days loaded yet</div>';
      return;
    }
    var currentDayNum = DATA.meta ? tripDayNumber(DATA.meta) : NaN;
    var totalDays = DATA.meta ? DATA.meta.total_days : 0;
    var html = '';

    // ⚑ The affordance line §X.50.4 ruled for, finally on the tab that needed it
    // most. The Japanese place names have been tap-to-copy since §X.74 and this
    // tab never said so: the toast was the whole affordance, and a toast only
    // fires AFTER the tap, so the control could only be found by accident.
    // ⛔ It was found by NOT being found — 2026-08-22 the user asked for a
    // "clickable Japanese name to copy for Organic Maps" while holding a build
    // that had shipped exactly that. `A CONTROL BEHIND AN UNDISCOVERED TAP IS
    // NOT SHIPPED` — the same sentence already written about the phrase rows.
    // ⚠ It says PLACE NAME on purpose. Trail names are NOT copyable and must
    // not be implied here: tested on his handset 2026-08-22, 「6号路」 resolves
    // to the wrong mountain and 「山の辺の道」 returns a long ambiguous list.
    // A path is a named way, not a POI, and the search does not resolve it.
    html += '<div class="info-copy-hint">Tap any Japanese place name to copy it — then paste it into your offline map.</div>';

    for (var d = 0; d < DATA.days.length; d++) {
      var day = DATA.days[d];
      var tripInProgress = currentDayNum >= 1 && currentDayNum <= totalDays;
      var isPast = tripInProgress && day.day < currentDayNum;
      var isToday = tripInProgress && day.day === currentDayNum;
      var cls = 'day-card';
      if (isPast) cls += ' past';
      if (isToday) cls += ' today card-open';
      else if (!isPast && DATA.days.length <= 3) cls += ' card-open';

      html += '<div class="' + cls + '">';

      // Header
      html += '<div class="card-header" data-toggle>';
      html += '<div class="day-num">' + day.day + '</div>';
      html += '<div class="day-meta">';
      html += '<div class="day-title">' + esc(day.title) + '</div>';
      html += '<div class="day-sub">' + esc(day.weekday + ', ' + fmtDate(day.date) + ' — ' + day.city) + '</div>';
      html += '</div>';
      if (day.tags && day.tags.length > 0) {
        html += '<div class="day-tags">';
        for (var t = 0; t < day.tags.length; t++) {
          html += '<span class="tag tag-' + esc(day.tags[t]) + '">' + esc(day.tags[t]) + '</span>';
        }
        html += '</div>';
      }
      html += '<span class="chevron">▶</span>';
      html += '</div>';

      // Body
      html += '<div class="card-body">';

      // Notes that govern the day before it starts — rendered ABOVE every block
      if (day.notes_top && day.notes_top.length > 0) {
        html += '<div class="day-notes day-notes-top">';
        for (var nt = 0; nt < day.notes_top.length; nt++) {
          html += '<div class="day-note">📌 ' + esc(day.notes_top[nt]) + '</div>';
        }
        html += '</div>';
      }

      var blocks = day.blocks || [];
      // A day "carries a walk" when one of its blocks has a route-map array.
      // Same seven days the hike maps hang off: 5, 9, 11, 13, 14, 15, 18.
      var dayHasWalk = false;
      for (var hw = 0; hw < blocks.length; hw++) {
        if (blocks[hw].maps && blocks[hw].maps.length > 0) { dayHasWalk = true; break; }
      }
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        html += '<div class="block">';
        html += '<div class="block-title ' + esc(block.type) + '">' + esc(block.title) + '</div>';

        // Route maps. They hang off the FIRST hike block of a walking day, not off
        // every one — day 5 has five hike blocks and one mountain. Two artefacts by
        // ruling (2026-08-18): the official course map, which matches the signage and
        // the line we actually composed, and the AllTrails entry, which is English.
        // `note` says what each one really covers — three of the AllTrails routes are
        // partial or reversed, and a label that hid that would be the defect.
        // ⚠ ONLINE-ONLY BY DECISION: offline was settled as "link + a pre-trip save
        // list", so these open nothing without signal. Do not let a later pass imply
        // otherwise; the save list is the mitigation and it lives outside the app.
        if (block.maps && block.maps.length > 0) {
          html += '<div class="block-maps">';
          for (var m = 0; m < block.maps.length; m++) {
            var bm = block.maps[m];
            if (!bm || !bm.url) continue;
            html += '<a class="btn btn-map-route" href="' + esc(bm.url) + '" target="_blank" rel="noopener">' +
              '📄 ' + esc(bm.label || 'Route map') + '</a>';
            if (bm.note) html += '<div class="block-map-note">' + esc(bm.note) + '</div>';
          }
          html += '</div>';
        }

        // Transit legs in this block
        if (block.transit && block.transit.length > 0) {
          var nextItems = [];
          var nextBlock = blocks[b + 1];
          if (nextBlock && nextBlock.items) {
            for (var ni = 0; ni < nextBlock.items.length; ni++) {
              if (nextBlock.items[ni].place_id) nextItems.push(nextBlock.items[ni].place_id);
            }
          }
          html += renderTransitLegs(block.transit, nextItems);
        }

        // Items in this block
        var items = block.items || [];
        for (var it = 0; it < items.length; it++) {
          var item = items[it];
          var place = item.place_id ? placeById(item.place_id) : null;

          if (place) {
            html += renderPlaceCard(place, item.detail, { offlineMap: dayHasWalk });
          } else if (item.label) {
            html += '<div class="item">';
            html += '<div class="item-name">' + esc(item.label) + '</div>';
            if (item.detail) html += '<div class="item-detail">' + esc(item.detail) + '</div>';
            html += '</div>';
          }
        }

        html += '</div>';
      }

      // Notes that only make sense once the day is over (evening errands)
      if (day.notes && day.notes.length > 0) {
        html += '<div class="day-notes">';
        for (var n = 0; n < day.notes.length; n++) {
          html += '<div class="day-note">📌 ' + esc(day.notes[n]) + '</div>';
        }
        html += '</div>';
      }

      // Backup plan
      if (day.backup) {
        html += '<div class="day-backup">';
        html += '<div class="day-backup-title">🔄 ' + esc(day.backup.title) + '</div>';
        html += '<div class="day-backup-detail">' + esc(day.backup.detail) + '</div>';
        html += '</div>';
      }

      html += '</div>';
      html += '</div>';
    }
    container.innerHTML = html;
    bindCardToggles(container);
    bindCopyables(container);
  }

  // ─── SOS section renderer ─────────────────────────────────
  function renderSOS() {
    var container = document.getElementById('section-sos');
    if (!DATA.sos) {
      container.innerHTML = '<div class="section-empty">SOS data not loaded</div>';
      return;
    }
    var sos = DATA.sos;
    var html = '';

    // Emergency numbers
    html += '<div class="sos-group">';
    html += '<div class="sos-group-title">🚨 Emergency Numbers</div>';
    for (var i = 0; i < sos.emergency_numbers.length; i++) {
      var num = sos.emergency_numbers[i];
      html += '<div class="sos-card">';
      html += '<div class="sos-card-label">' + esc(num.label) + '</div>';
      html += '<a class="sos-number" href="' + esc(num.tel) + '">' + esc(num.number) + '</a>';
      if (num.note_en) html += '<div class="sos-card-detail">' + esc(num.note_en) + '</div>';
      html += '</div>';
    }
    html += '</div>';

    // Embassy
    if (sos.embassy) {
      var emb = sos.embassy;
      html += '<div class="sos-group">';
      html += '<div class="sos-group-title">🏛 Embassy</div>';
      html += '<div class="sos-card">';
      html += '<div class="sos-card-label">' + esc(emb.name_en) + '</div>';
      html += '<div class="sos-card-detail copyable" data-copy="' + esc(emb.address_jp) + '">' + esc(emb.address_en) + '</div>';
      html += '<div class="sos-card-detail">' + esc(emb.consular_hours) + '</div>';
      if (emb.after_hours) html += '<div class="sos-card-detail">' + esc(emb.after_hours) + '</div>';
      html += '<div class="btn-row" style="margin-top:8px">';
      html += '<a class="btn btn-call" href="' + esc(emb.tel) + '">📞 Call</a>';
      if (emb.lat && emb.lon) {
        html += '<a class="btn btn-maps" href="' + mapsPinUrl(emb) + '" target="_blank" rel="noopener">📍 Map</a>';
      }
      if (emb.website) {
        html += '<a class="btn btn-web" href="' + esc(emb.website) + '" target="_blank" rel="noopener">🔗 Web</a>';
      }
      html += '</div>';
      html += '</div>';
      html += '</div>';
    }

    // Hotels — resolved from places.json (single source of truth, audit C2)
    if (sos.hotels && sos.hotels.length > 0) {
      html += '<div class="sos-group">';
      html += '<div class="sos-group-title">🏨 Hotels</div>';
      for (var h = 0; h < sos.hotels.length; h++) {
        var hotel = sos.hotels[h];
        var hp = placeById(hotel.place_id);
        if (!hp) continue;
        var staffJp = hp.name_jp + (hp.address_jp ? '\n' + hp.address_jp : '');
        html += '<div class="hotel-card">';
        html += '<div class="hotel-dates">' + esc(hotel.dates) + ' — ' + esc(hotel.city) + '</div>';
        html += '<div class="hotel-name">' + esc(hp.name_en) + '</div>';
        if (hp.name_jp) html += '<div class="hotel-name-jp copyable" data-copy="' + esc(hp.name_jp) + '">' + esc(hp.name_jp) + '</div>';
        if (hp.address_jp) html += '<div class="hotel-address copyable" data-copy="' + esc(hp.address_jp) + '">' + esc(hp.address_jp) + '</div>';
        html += '<div class="btn-row" style="margin-top:8px">';
        if (hp.phone) {
          html += '<a class="btn btn-call" href="tel:' + esc(hp.phone.replace(/[^+\d]/g, '')) + '">📞 Call</a>';
        }
        html += '<button class="show-staff-btn" data-jp="' + esc(staffJp) + '" data-en="' + esc(hp.name_en) + '">📱 Show to Staff</button>';
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Medical
    if (sos.medical && sos.medical.length > 0) {
      html += '<div class="sos-group">';
      html += '<div class="sos-group-title">🏥 Medical</div>';
      for (var m = 0; m < sos.medical.length; m++) {
        var med = sos.medical[m];
        html += '<div class="medical-card">';
        html += '<div class="medical-city">' + esc(med.city) + ' — ' + esc(med.dates) + '</div>';
        if (med.hospital) {
          html += '<div class="medical-name">' + esc(med.hospital.name_en) + '</div>';
          if (med.hospital.name_jp) html += '<div class="medical-detail copyable" data-copy="' + esc(med.hospital.name_jp) + '">' + esc(med.hospital.name_jp) + '</div>';
          if (med.hospital.address) html += '<div class="medical-detail copyable" data-copy="' + esc(med.hospital.address) + '">' + esc(med.hospital.address) + '</div>';
          if (med.hospital.note) html += '<div class="medical-detail">' + esc(med.hospital.note) + '</div>';
          if (med.hospital.hours) html += '<div class="medical-detail">' + esc(med.hospital.hours) + '</div>';
          if (med.hospital.distance) html += '<div class="medical-detail">' + esc(med.hospital.distance) + '</div>';
          if (med.hospital.tel || (med.hospital.lat && med.hospital.lon)) {
            html += '<div class="btn-row" style="margin-top:6px">';
            if (med.hospital.tel) {
              html += '<a class="btn btn-call" href="' + esc(med.hospital.tel) + '">📞 ' + esc(med.hospital.phone) + '</a>';
            }
            if (med.hospital.lat && med.hospital.lon) {
              html += '<a class="btn btn-maps" href="' + mapsPinUrl(med.hospital) + '" target="_blank" rel="noopener">📍 Map</a>';
            }
            html += '</div>';
          }
        }
        if (med.pharmacy) {
          html += '<div class="medical-detail" style="margin-top:8px;font-weight:600">💊 ' + esc(med.pharmacy.name) + '</div>';
          if (med.pharmacy.location) html += '<div class="medical-detail">' + esc(med.pharmacy.location) + '</div>';
          if (med.pharmacy.hours) html += '<div class="medical-detail">' + esc(med.pharmacy.hours) + '</div>';
          if (med.pharmacy.note) html += '<div class="medical-detail">' + esc(med.pharmacy.note) + '</div>';
          if (med.pharmacy.lat && med.pharmacy.lon) {
            html += '<div class="btn-row" style="margin-top:6px">';
            html += '<a class="btn btn-maps" href="' + mapsPinUrl(med.pharmacy) + '" target="_blank" rel="noopener">📍 Map</a>';
            html += '</div>';
          }
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // Pharmacy tip
    if (sos.pharmacy_tip) {
      html += '<div class="sos-group">';
      html += '<div class="sos-group-title">💊 Pharmacy Tips</div>';
      html += '<div class="pharmacy-tip">' + esc(sos.pharmacy_tip) + '</div>';
      html += '</div>';
    }

    // Show-to-staff cards
    if (sos.show_to_staff_cards && sos.show_to_staff_cards.length > 0) {
      html += '<div class="sos-group">';
      html += '<div class="sos-group-title">📱 Show to Staff</div>';
      // Same reason as the phrases intro: these six now carry 🔊 behind the tap,
      // and this is the tab where nobody will be exploring.
      html += '<div class="phrase-intro">Tap a card to show it full-screen, with 🔊 to play it aloud.</div>';
      for (var s = 0; s < sos.show_to_staff_cards.length; s++) {
        var card = sos.show_to_staff_cards[s];
        html += '<div class="sos-card" style="cursor:pointer" data-fs-jp="' + esc(card.jp) + '" data-fs-en="' + esc(card.en) + '" data-fs-romaji="' + esc(card.romaji || '') + '">';
        html += '<div class="sos-card-label">' + esc(card.en) + '</div>';
        html += '<div class="sos-card-detail">' + esc(card.jp) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    container.innerHTML = html;
    bindShowToStaff(container);
    bindCopyables(container);
  }

  // ─── Phrases section renderer ─────────────────────────────
  function renderPhrases() {
    var container = document.getElementById('section-phrases');
    if (!DATA.phrases || !DATA.phrases.groups) {
      container.innerHTML = '<div class="section-empty">Phrases not loaded</div>';
      return;
    }
    var ICONS = {
      utensils: '🍽', train: '🚃', hotel: '🏨', hiking: '🥾',
      shopping: '🛍', emergency: '🚨'
    };
    var groups = DATA.phrases.groups;
    var html = '';
    // The rows have been tappable since the app was built and nothing ever said
    // so — the same defect item 1 reported about the copyables: not purposeless,
    // undiscoverable. The controls now live behind that tap, so the affordance
    // has to be stated or they ship invisible.
    html += '<div class="phrase-intro">Tap any phrase to show it full-screen — big enough to read across a counter, with 🔊 to play it aloud.</div>';

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var icon = ICONS[group.icon] || '💬';
      html += '<div class="phrase-group">';
      html += '<div class="card-header" data-toggle>';
      html += '<span class="phrase-group-icon">' + icon + '</span>';
      html += '<span class="phrase-group-title">' + esc(group.title) + '</span>';
      html += '<span class="phrase-group-count">' + group.phrases.length + '</span>';
      html += '<span class="chevron">▶</span>';
      html += '</div>';
      html += '<div class="card-body">';
      for (var p = 0; p < group.phrases.length; p++) {
        var phrase = group.phrases[p];
        html += '<div class="phrase-item" data-fs-jp="' + esc(phrase.jp) + '" data-fs-en="' + esc(phrase.en) + '" data-fs-romaji="' + esc(phrase.romaji) + '" data-fs-context="' + esc(phrase.context || '') + '">';
        html += '<div class="phrase-en">' + esc(phrase.en) + '</div>';
        html += '<div class="phrase-jp">' + esc(phrase.jp) + '</div>';
        html += '<div class="phrase-romaji">' + esc(phrase.romaji) + '</div>';
        if (phrase.context) html += '<div class="phrase-context">' + esc(phrase.context) + '</div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }
    container.innerHTML = html;
    bindCardToggles(container);
    bindPhraseItems(container);
  }

  // A venue's order block (Tabelog link, dish, Japanese, why, backup) is a
  // property of the VENUE, not of the meal — 64 entries share 43 venues, and
  // three of the days serve mendokoro-honda. It lives once in food.venues and
  // is merged in here, so it cannot drift between days. A per-entry field still
  // wins, for the case where lunch and dinner really are different orders.
  function foodEntry(food, rest) {
    var shared = (food.venues || {})[rest.place_id];
    if (!shared) return rest;
    var merged = {};
    for (var k in shared) { if (shared.hasOwnProperty(k)) merged[k] = shared[k]; }
    for (var j in rest) { if (rest.hasOwnProperty(j) && rest[j] !== undefined) merged[j] = rest[j]; }
    return merged;
  }

  // ─── Food section renderer ─────────────────────────────────
  function renderFood() {
    var container = document.getElementById('section-food');
    if (!DATA.food) {
      container.innerHTML = '<div class="section-empty">Food data not loaded</div>';
      return;
    }
    var food = DATA.food;
    var html = '';

    // There was a 💡 ekiben tips card here, at the head of this tab and above all
    // twenty day cards. It is gone, with `food.json`'s `tips` key: every fact in
    // it was already on the day it applies to, and the user ruled it out at the
    // R7 walkthrough. `solo_tips` and `coin_locker_tip` went with it — both were
    // April-fixture branches that no autumn data had fed since B6. The Food tab
    // now opens on day 1. Do not reintroduce a head-of-tab block without a fact
    // that belongs to no single day; that was the whole reason this one failed.

    // Per-day food cards
    if (food.days && food.days.length > 0) {
      for (var d = 0; d < food.days.length; d++) {
        var day = food.days[d];
        html += '<div class="food-day">';
        html += '<div class="card-header" data-toggle>';
        html += '<div class="day-num">' + day.day + '</div>';
        html += '<div class="day-meta">';
        html += '<div class="day-title">' + esc(day.city) + (day.subtitle ? ' — ' + day.subtitle : '') + '</div>';
        html += '<div class="day-sub">Day ' + day.day + ' · ' + esc(fmtDate(day.date)) + '</div>';
        html += '</div>';
        html += '<span class="chevron">▶</span>';
        html += '</div>';
        html += '<div class="card-body">';

        // Meals
        for (var m = 0; m < day.meals.length; m++) {
          var meal = day.meals[m];
          var slotLabel = meal.slot.charAt(0).toUpperCase() + meal.slot.slice(1);
          html += '<div class="food-meal">';
          html += '<div class="food-meal-header">';
          html += '<span class="food-meal-slot">' + esc(slotLabel) + '</span>';
          if (meal.time_hint) html += '<span class="food-meal-hint">' + esc(meal.time_hint) + '</span>';
          html += '</div>';

          // Exactly one meal in the trip carries two backups — day 5's dinner,
          // ethiopia-akihabara then fish-shinjuku — and their order IS the
          // ranking, because it is the only signal there is. Two identical
          // "Backup" badges hid that, and the second one reads as the stronger
          // of the pair (it carries a tabelog score and an award line; the
          // first carries neither). Numbering them only when there is more than
          // one leaves the other 31 meals byte-identical on screen.
          var backupTotal = 0;
          for (var bc = 0; bc < meal.restaurants.length; bc++) {
            if (meal.restaurants[bc].role === 'backup') backupTotal++;
          }
          var backupSeen = 0;

          // Restaurants
          for (var r = 0; r < meal.restaurants.length; r++) {
            var rest = foodEntry(food, meal.restaurants[r]);
            var place = rest.place_id ? placeById(rest.place_id) : null;

            html += '<div class="food-restaurant' + (rest.role === 'backup' ? ' food-backup' : '') + '">';

            // Role + badges row
            html += '<div class="food-badges">';
            if (rest.role === 'backup') {
              backupSeen++;
              html += '<span class="food-badge backup">' +
                (backupTotal > 1 ? 'Backup ' + backupSeen : 'Backup') + '</span>';
            }
            if (rest.badges) {
              for (var bg = 0; bg < rest.badges.length; bg++) {
                if (rest.tabelog_url && rest.badges[bg].indexOf('tabelog') === 0) {
                  html += '<a class="food-badge rating" href="' + esc(rest.tabelog_url) + '" target="_blank" rel="noopener">' + esc(rest.badges[bg]) + '</a>';
                } else {
                  html += '<span class="food-badge rating">' + esc(rest.badges[bg]) + '</span>';
                }
              }
            }
            if (rest.cuisine) {
              html += '<span class="food-cuisine">' + esc(rest.cuisine) + '</span>';
            }
            html += '</div>';

            // Place card (reuse component)
            if (place) {
              html += renderPlaceCard(place, null);
            }

            // Food-specific details (skip price if place card already shows it)
            if (rest.price && (!place || rest.price !== place.price)) {
              html += '<div class="food-price">' + esc(rest.price) + '</div>';
            }
            // How you order — the mechanism (ticket machine, counter, table).
            // Renders ABOVE the dish, because it governs the moment before it.
            if (rest.order_how) {
              html += '<div class="food-how">';
              html += '<span class="food-order-label">How to order:</span> ' + longProse(rest.order_how);
              html += '</div>';
            }
            if (rest.order) {
              html += '<div class="food-order">';
              html += '<span class="food-order-label">Order:</span> ' + esc(rest.order);
              html += '</div>';
            }
            // The show-the-screen block. Large JP so it can be turned around at a
            // counter, romaji so it can be attempted aloud, and three controls.
            if (rest.order_jp) {
              html += '<div class="jp-say">';
              // Tap the Japanese to blow it up full-screen (user, 2026-08-19):
              // "large letters and easy to show rather than people try to read it
              // amongst english text in small font." Same overlay the phrases and
              // SOS cards use — one branch, not a third implementation.
              // ⚠ Bound on the TEXT, not the .jp-say container: the three buttons
              // live in that container and a container handler would fire on them
              // too. They already stopPropagation, but the narrower target is the
              // one that cannot go wrong.
              html += '<div class="jp-say-text jp-say-tap" role="button" tabindex="0"' +
                ' data-fs-jp="' + esc(rest.order_jp) + '"' +
                // Dish NAME only, not the description. All 42 `order` strings are
                // "Name — description" and the longest runs 277 chars; the overlay
                // exists to be turned around at a counter, and a paragraph of
                // English under the Japanese is both noise and a real overflow
                // risk on a small handset (§X.73.3 measured that failure).
                ' data-fs-en="' + esc((rest.order || '').split('—')[0].trim()) + '"' +
                ' data-fs-romaji="' + esc(rest.order_romaji || '') + '">' +
                esc(rest.order_jp) + '</div>';
              if (rest.order_romaji) {
                html += '<div class="jp-say-romaji">' + esc(rest.order_romaji) + '</div>';
              }
              html += '<div class="jp-say-actions">';
              html += '<button type="button" class="jp-btn" data-speak="' + esc(rest.order_jp) + '">🔊 Say it</button>';
              // A real anchor, not window.open. In an iOS standalone PWA — which
              // is how he opens this, from a home-screen icon — window.open is
              // popup-blocked or lands in a view with no way back. The badge
              // link three blocks up already does it this way; match it.
              // sl=ja puts the Japanese in Translate's SOURCE pane, where its
              // own speaker button plays it; tl=en gives him the reading back.
              html += '<a class="jp-btn" target="_blank" rel="noopener" href="https://translate.google.com/?sl=ja&amp;tl=en&amp;op=translate&amp;text=' +
                esc(encodeURIComponent(rest.order_jp)) + '">🌐 Translate</a>';
              html += '<button type="button" class="jp-btn" data-copy="' + esc(rest.order_jp) + '">📋 Copy</button>';
              html += '</div>';
              html += '<div class="jp-say-hint">Tap the Japanese to show it full-screen in large type, or tap 🔊 to play it aloud.</div>';
              html += '</div>';
            }
            if (rest.order_why) {
              html += '<div class="food-why"><span class="food-order-label">Why this one:</span> ' + longProse(rest.order_why) + '</div>';
            }
            if (rest.order_backup) {
              html += '<div class="food-why"><span class="food-order-label">If not that:</span> ' + longProse(rest.order_backup) + '</div>';
            }
            if (rest.note) {
              html += '<div class="food-note">' + longProse(rest.note) + '</div>';
            }

            html += '</div>';
          }

          html += '</div>';
        }

        html += '</div>';
        html += '</div>';
      }
    }

    container.innerHTML = html;
    bindCardToggles(container);
    bindCopyables(container);
    bindJpSay(container);
    bindProseToggles(container);
  }

  // ─── Transit section renderer ──────────────────────────────
  function renderTransit() {
    var container = document.getElementById('section-transit');
    if (!DATA.days || DATA.days.length === 0) {
      container.innerHTML = '<div class="section-empty">No transit data loaded</div>';
      return;
    }

    var html = '';
    var totalCost = 0;
    var anyPassLeg = false;

    // Standing payment rules. They live here rather than in Food (where they were shipped by
    // mistake) because this is the tab he is already in when the question comes up — and the
    // ones that survive per-leg `payment` are the ones no leg owns: temple gates take cash,
    // and how much cash to land with.
    var pr = DATA.meta && DATA.meta.payment_rules;
    if (pr && pr.items && pr.items.length > 0) {
      // ⛔ Collapsed by default (user, 2026-08-19). It is reference material he
      // consults at a gate, not something he needs open every time he checks a
      // departure — and it sat above 21 days of legs, pushing them down.
      html += '<div class="payment-rules">';
      html += '<div class="card-header" data-toggle>';
      html += '<span class="payment-rules-icon">💴</span>';
      html += '<span class="payment-rules-title">' + esc(pr.title) + '</span>';
      html += '<span class="chevron">▶</span>';
      html += '</div>';
      html += '<div class="card-body">';
      for (var pi = 0; pi < pr.items.length; pi++) {
        html += '<div class="payment-rule">';
        html += '<div class="payment-rule-heading">' + esc(pr.items[pi].heading) + '</div>';
        html += '<div class="payment-rule-detail">' + esc(pr.items[pi].detail) + '</div>';
        html += '</div>';
      }
      html += '</div></div>';
    }

    for (var d = 0; d < DATA.days.length; d++) {
      var day = DATA.days[d];
      var legs = [];

      // Collect all transit legs from all blocks
      var blocks = day.blocks || [];
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        if (block.transit) {
          for (var t = 0; t < block.transit.length; t++) {
            legs.push(block.transit[t]);
          }
        }
      }

      if (legs.length === 0) continue;

      // Day cost subtotal (numeric; JR-Pass-covered legs shown separately, audit S2)
      var dayCost = 0;
      var hasPassLeg = false;
      for (var c = 0; c < legs.length; c++) {
        if (typeof legs[c].cost_jpy === 'number') dayCost += legs[c].cost_jpy;
        if (legs[c].covered_by_pass) hasPassLeg = true;
      }
      totalCost += dayCost;
      if (hasPassLeg) anyPassLeg = true;

      var costSub = '';
      if (dayCost > 0) costSub = ' · ¥' + dayCost.toLocaleString() + (hasPassLeg ? ' + JR Pass' : '');
      else if (hasPassLeg) costSub = ' · JR Pass';

      html += '<div class="transit-day">';
      html += '<div class="card-header" data-toggle>';
      html += '<div class="day-num">' + day.day + '</div>';
      html += '<div class="day-meta">';
      html += '<div class="day-title">' + esc(day.city) + '</div>';
      html += '<div class="day-sub">' + esc(day.weekday + ', ' + fmtDate(day.date)) + esc(costSub) + '</div>';
      html += '</div>';
      html += '<span class="transit-leg-count">' + legs.length + ' leg' + (legs.length !== 1 ? 's' : '') + '</span>';
      html += '<span class="chevron">▶</span>';
      html += '</div>';
      html += '<div class="card-body">';

      for (var i = 0; i < legs.length; i++) {
        var leg = legs[i];
        var badge = legBadge(leg);

        html += '<div class="transit-leg">';
        html += '<span class="tleg-badge ' + badge.cls + '">' + esc(badge.label) + '</span>';
        html += '<div class="transit-leg-content">';
        html += '<div class="transit-leg-label">' + esc(leg.label) + '</div>';
        if (leg.detail) html += '<div class="transit-leg-detail">' + esc(leg.detail) + '</div>';
        if (leg.payment) {
          html += '<div class="tleg-payment"><span class="tleg-payment-label">Boarding &amp; paying</span>' +
            esc(leg.payment) + '</div>';
        }

        var meta = [];
        if (leg.duration_min) meta.push(leg.duration_min + ' min');
        var legCost = legCostText(leg);
        if (legCost) meta.push(legCost);
        if (meta.length > 0) {
          html += '<div class="transit-leg-meta">' + esc(meta.join(' · ')) + '</div>';
        }

        // Directions link
        var origin = placeById(leg.origin_id);
        var dest = placeById(leg.destination_id);
        if (origin && dest) {
          var tUrl = leg.mode === 'walking' ? mapsWalkUrl(dest) : mapsTransitUrl(origin, dest);
          html += '<a class="btn btn-transit" href="' + tUrl + '" target="_blank" rel="noopener">' + (leg.mode === 'walking' ? '🚶 Walk' : '🚉 Directions') + '</a>';
        }

        html += '</div>';
        html += '</div>';
      }

      html += '</div>';
      html += '</div>';
    }

    // Trip total
    // The "excl. JR-Pass-covered legs" note was printed unconditionally and no leg in this
    // itinerary is pass-covered — so the total read as partial when it is in fact complete,
    // and implied a pass purchase that was never part of the trip. Now it follows the data,
    // the same test the per-day subtotal at :717 already applies.
    if (totalCost > 0) {
      html += '<div class="transit-total">Estimated transit cost: ¥' + totalCost.toLocaleString() +
        (anyPassLeg ? ' <span class="transit-total-note">(excl. JR-Pass-covered legs)</span>' : '') +
        '</div>';
    }

    container.innerHTML = html;
    bindCardToggles(container);
  }

  // ─── Info / Reservations section renderer ──────────────────
  // One label/value row; copyable=true makes the value tap-to-copy (see bindCopyables).
  function infoField(label, value, copyable) {
    if (value === undefined || value === null || value === '') return '';
    var cls = 'info-value' + (copyable ? ' copyable' : '');
    var attr = copyable ? ' data-copy="' + esc(value) + '"' : '';
    return '<div class="info-field"><span class="info-label">' + esc(label) + '</span>' +
      '<span class="' + cls + '"' + attr + '>' + esc(value) + '</span></div>';
  }

  function renderInfo() {
    var container = document.getElementById('section-info');
    if (!DATA.reservations) {
      container.innerHTML = '<div class="section-empty">No reservation data loaded</div>';
      return;
    }

    var html = '';
    var flights = DATA.reservations.flights || [];
    var hotels = DATA.reservations.hotels || [];
    var documents = DATA.reservations.documents || [];

    // ⚑ The one printed affordance line of §X.74's item-1 fix, and it sits ONCE
    // at the top of the tab rather than on each booking. This is the copyable
    // class with no alternative control beside it — a Japanese place name also
    // has 📍 Map and Show to Staff, a confirmation number has nothing but a
    // silent tap. ⛔ First draft put it inside the hotel block and covered 4 of
    // 12 copyable numbers: the other 8 come through infoField() from the
    // FLIGHTS block. `FIND THE SURFACE, NOT THE COUNT` — the surface is the tab.
    // ⚠ Gated on there actually BEING a copyable number. The credential-free
    // build (published copy, where confirmations/PINs/ticket numbers are
    // stripped so they never sit on a public URL) renders this tab with none,
    // and an unconditional hint would promise a control that is not there.
    var hasCopyableNumber = flights.some(function (f) { return f.confirmation || f.ticket_no; }) ||
      hotels.some(function (h) { return h.pin || h.confirmation; });
    if (hasCopyableNumber) {
      html += '<div class="info-copy-hint">Any number in a box here copies when you tap it — confirmations, ticket numbers, check-in PINs.</div>';
    }

    // Flights
    if (flights.length > 0) {
      html += '<h2 class="info-heading">Flights</h2>';
      for (var fi = 0; fi < flights.length; fi++) {
        var fl = flights[fi];
        html += '<div class="info-flight">';
        html += '<div class="info-flight-head">';
        html += '<div class="item-name">' + esc(fl.from) + ' → ' + esc(fl.to);
        if (fl.flight_no) html += ' <span class="flight-no">' + esc(fl.flight_no) + '</span>';
        html += '</div>';
        if (fl.from_name || fl.to_name) {
          html += '<div class="info-dates">' + esc((fl.from_name || fl.from) + ' → ' + (fl.to_name || fl.to)) + '</div>';
        }
        html += '</div>';

        html += '<div class="info-booking">';
        html += infoField('Depart', fmtDateTime(fl.depart));
        html += infoField('Arrive', fmtDateTime(fl.arrive));
        if (fl.seat) html += infoField('Seat', fl.seat);
        if (fl.baggage) html += infoField('Baggage', fl.baggage);
        if (fl.confirmation) html += infoField('Confirmation', fl.confirmation, true);
        if (fl.ticket_no) html += infoField('Ticket', fl.ticket_no, true);
        html += '</div>';
        if (fl.cabin) html += '<div class="info-notes">' + esc(fl.cabin) + '</div>';
        if (fl.pdf) {
          html += '<a class="btn btn-pdf" href="' + esc(fl.pdf) + '" target="_blank" rel="noopener">📄 Ticket PDF</a>';
        }
        html += '</div>';
      }
    }

    if (hotels.length > 0) {
      html += '<h2 class="info-heading">Hotel Reservations</h2>';

      for (var i = 0; i < hotels.length; i++) {
        var booking = hotels[i];
        var place = placeById(booking.place_id);
        if (!place) continue;

        var checkin = fmtDate(booking.check_in) || '';
        var checkout = fmtDate(booking.check_out) || '';
        var nightsLabel = booking.nights ? booking.nights + ' night' + (booking.nights !== 1 ? 's' : '') : '';

        html += '<div class="info-hotel card-open">';
        html += '<div class="card-header" data-toggle>';
        html += '<div class="info-hotel-head">';
        html += '<div class="item-name">' + esc(place.name_en);
        if (place.name_jp) {
          html += ' <span class="item-name-jp">' + esc(place.name_jp) + '</span>';
        }
        html += '</div>';
        html += '<div class="info-dates">' + esc(checkin + ' → ' + checkout) +
          (nightsLabel ? ' · ' + esc(nightsLabel) : '') + '</div>';
        html += '</div>';
        html += '<span class="chevron">▶</span>';
        html += '</div>';

        html += '<div class="card-body">';

        // Booking details
        html += '<div class="info-booking">';
        if (booking.pin) {
          html += '<div class="info-field">';
          html += '<span class="info-label">Check-in PIN</span>';
          html += '<span class="info-value copyable" data-copy="' + esc(booking.pin) + '">' + esc(booking.pin) + '</span>';
          html += '</div>';
        }
        if (booking.confirmation) {
          html += '<div class="info-field">';
          html += '<span class="info-label">Confirmation</span>';
          html += '<span class="info-value copyable" data-copy="' + esc(booking.confirmation) + '">' + esc(booking.confirmation) + '</span>';
          html += '</div>';
        }
        if (booking.room_notes) {
          html += '<div class="info-notes">' + esc(booking.room_notes) + '</div>';
        }
        html += '</div>';

        // Place card (address, map, phone) — name suppressed, header already shows it
        html += renderPlaceCard(place, null, { noName: true });

        // PDF link
        if (booking.pdf) {
          html += '<a class="btn btn-pdf" href="' + esc(booking.pdf) + '" target="_blank" rel="noopener">📄 Confirmation PDF</a>';
        }

        html += '</div>';
        html += '</div>';
      }
    }

    // Documents (owner-less: insurance, standalone itinerary/route PDFs)
    if (documents.length > 0) {
      html += '<h2 class="info-heading">Documents</h2>';
      for (var di = 0; di < documents.length; di++) {
        var doc = documents[di];
        if (!doc.file) continue;
        var docLabel = (doc.title || 'Document') + (doc.date ? ' · ' + fmtDate(doc.date) : '');
        html += '<a class="btn btn-pdf btn-pdf-block" href="' + esc(doc.file) + '" target="_blank" rel="noopener">📄 ' + esc(docLabel) + '</a>';
      }
    }

    if (html === '') {
      html = '<div class="section-empty">No reservations yet</div>';
    }

    // "Data as of" stamp (REDESIGN.md §0) — shown once wired by the verification pass
    if (DATA.meta && DATA.meta.data_built_on) {
      html += '<div class="data-stamp">Data built ' + esc(fmtDate(DATA.meta.data_built_on)) +
        (DATA.meta.trip_name ? ' · ' + esc(DATA.meta.trip_name) : '') + '</div>';
    }

    container.innerHTML = html;
    bindCardToggles(container);
    bindCopyables(container);
  }

  // ─── Event binding helpers ────────────────────────────────
  function bindCardToggles(root) {
    var headers = root.querySelectorAll('[data-toggle]');
    for (var i = 0; i < headers.length; i++) {
      headers[i].addEventListener('click', function () {
        toggleCard(this.parentElement);
      });
    }
  }

  function bindCopyables(root) {
    var els = root.querySelectorAll('.copyable');
    for (var i = 0; i < els.length; i++) {
      els[i].addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(this.getAttribute('data-copy'), this.getAttribute('data-copy-hint'));
      });
    }
  }

  // ─── Speak Japanese aloud ────────────────────────────────
  // Two mechanisms ship side by side until the user reports which one
  // works on his own handset: in-app speech synthesis (works offline, no
  // app switch) and a Google Translate link (leaves the app, needs signal).
  // The loser is deleted, not left as dead weight.
  function speakJapanese(text, btn) {
    if (!text) return;
    if (!('speechSynthesis' in window)) {
      flashButton(btn, '✗ no voice');
      return;
    }
    try {
      // Only cancel when something is actually queued. An unconditional
      // cancel() immediately before speak() is a known iOS footgun: it can
      // swallow the new utterance and leave the button reporting "playing"
      // in silence, which is the one failure that looks like success.
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = 0.85;
      // Prefer an actual Japanese voice if the handset exposes one; without
      // it iOS falls back to the system voice and reads kanji as nonsense.
      var voices = window.speechSynthesis.getVoices() || [];
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang && voices[i].lang.toLowerCase().indexOf('ja') === 0) {
          u.voice = voices[i];
          break;
        }
      }
      u.onerror = function () { flashButton(btn, '✗ failed'); };
      window.speechSynthesis.speak(u);
      flashButton(btn, '🔊 playing');
    } catch (err) {
      flashButton(btn, '✗ failed');
    }
  }

  function flashButton(btn, label) {
    if (!btn) return;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = label;
    setTimeout(function () { btn.textContent = original; }, 1400);
  }

  function bindJpSay(root) {
    var speakers = root.querySelectorAll('[data-speak]');
    for (var i = 0; i < speakers.length; i++) {
      speakers[i].addEventListener('click', function (e) {
        e.stopPropagation();
        speakJapanese(this.getAttribute('data-speak'), this);
      });
    }
    // The Translate control is a plain anchor and needs no handler — it only
    // has to stop the click reaching the card-collapse toggle above it.
    var links = root.querySelectorAll('a.jp-btn');
    for (var t = 0; t < links.length; t++) {
      links[t].addEventListener('click', function (e) { e.stopPropagation(); });
    }
    var copiers = root.querySelectorAll('.jp-btn[data-copy]');
    for (var c = 0; c < copiers.length; c++) {
      copiers[c].addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(this.getAttribute('data-copy'));
      });
    }
    // The order line itself opens the shared full-screen overlay.
    var taps = root.querySelectorAll('.jp-say-tap');
    for (var s = 0; s < taps.length; s++) {
      taps[s].addEventListener('click', function (e) {
        e.stopPropagation();
        showFullscreen({
          jp: this.getAttribute('data-fs-jp'),
          en: this.getAttribute('data-fs-en'),
          romaji: this.getAttribute('data-fs-romaji'),
          speakable: true
        });
      });
    }
  }

  function bindShowToStaff(root) {
    // Show-to-staff buttons on hotel cards
    var btns = root.querySelectorAll('.show-staff-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.stopPropagation();
        showFullscreen({
          jp: this.getAttribute('data-jp'),
          en: this.getAttribute('data-en')
        });
      });
    }
    // Show-to-staff emergency cards (tappable)
    var cards = root.querySelectorAll('[data-fs-jp]');
    for (var j = 0; j < cards.length; j++) {
      if (cards[j].classList.contains('phrase-item')) continue;
      cards[j].addEventListener('click', function () {
        showFullscreen({
          jp: this.getAttribute('data-fs-jp'),
          en: this.getAttribute('data-fs-en'),
          romaji: this.getAttribute('data-fs-romaji'),
          speakable: true
        });
      });
    }
  }

  function bindPhraseItems(root) {
    var items = root.querySelectorAll('.phrase-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        showFullscreen({
          jp: this.getAttribute('data-fs-jp'),
          en: this.getAttribute('data-fs-en'),
          romaji: this.getAttribute('data-fs-romaji'),
          context: this.getAttribute('data-fs-context'),
          speakable: true
        });
      });
    }
  }

  // ─── Open/closed badge logic ───────────────────────────────
  var WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function placeStatus(place) {
    if (!place || !place.hours) return null;

    var now = jstNow();
    var todayKey = WEEKDAY_KEYS[now.getDay()];
    var yesterdayKey = WEEKDAY_KEYS[(now.getDay() + 6) % 7];
    var currentMin = now.getHours() * 60 + now.getMinutes();

    // closed_notes: suppress all badges (honest uncertainty per REDESIGN.md §2)
    if (place.hours.closed_notes) {
      return null;
    }

    // Recurring closures / exceptions (shared with todayHoursSummary)
    var closedRule = closedTodayByRule(place, now);
    if (closedRule) {
      return { status: 'closed', label: 'CLOSED TODAY', note: closedRule.note };
    }

    var openResult = function (minutesToClose) {
      if (minutesToClose <= 60) {
        return { status: 'closing', label: 'CLOSING SOON' };
      }
      // Peak only means something for restaurants
      var isLunchPeak = currentMin >= 11 * 60 + 30 && currentMin < 13 * 60;
      var isDinnerPeak = currentMin >= 18 * 60 && currentMin < 19 * 60 + 30;
      return {
        status: 'open',
        label: 'OPEN NOW',
        peak: place.category === 'restaurant' && (isLunchPeak || isDinnerPeak)
      };
    };

    // Spillover from yesterday's overnight intervals (e.g. sat 18:00–02:00 at sun 01:00)
    var yIntervals = place.hours[yesterdayKey];
    if (Array.isArray(yIntervals)) {
      for (var y = 0; y < yIntervals.length; y++) {
        var yOpen = parseTimeToMin(yIntervals[y][0]);
        var yClose = parseTimeToMin(yIntervals[y][1]);
        if (yOpen === null || yClose === null || yClose > yOpen) continue; // not overnight
        if (currentMin < yClose) return openResult(yClose - currentMin);
      }
    }

    // Check weekly hours
    var intervals = place.hours[todayKey];
    if (intervals === null || intervals === undefined) {
      return { status: 'closed', label: 'CLOSED TODAY' };
    }

    if (!Array.isArray(intervals) || intervals.length === 0) {
      return null;
    }

    // Check if currently within any interval (close <= open means overnight)
    for (var i = 0; i < intervals.length; i++) {
      var open = parseTimeToMin(intervals[i][0]);
      var close = parseTimeToMin(intervals[i][1]);
      if (open === null || close === null) continue;

      if (close > open) {
        if (currentMin >= open && currentMin < close) {
          return openResult(close - currentMin);
        }
      } else {
        // Overnight: open today, closes after midnight (tomorrow's spillover
        // before `open` is handled by the yesterday check above)
        if (currentMin >= open) {
          return openResult(close + 24 * 60 - currentMin);
        }
      }
    }

    return { status: 'closed', label: 'CLOSED' };
  }

  function parseTimeToMin(str) {
    if (!str) return null;
    var parts = str.split(':');
    if (parts.length < 2) return null;
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function applyBadges() {
    var placeEls = document.querySelectorAll('[data-place-id]');
    for (var i = 0; i < placeEls.length; i++) {
      var el = placeEls[i];
      var id = el.getAttribute('data-place-id');
      var place = placeById(id);
      if (!place) continue;

      // Remove existing badges
      var existing = el.querySelectorAll('.status-badge');
      for (var r = 0; r < existing.length; r++) existing[r].remove();

      var result = placeStatus(place);
      if (!result) continue;

      var nameEl = el.querySelector('.item-name');
      if (!nameEl) continue;

      var badge = document.createElement('span');
      badge.className = 'status-badge badge-' + result.status;
      badge.textContent = result.label;
      nameEl.appendChild(badge);

      if (result.peak) {
        var peakBadge = document.createElement('span');
        peakBadge.className = 'status-badge badge-peak';
        peakBadge.textContent = 'Peak';
        nameEl.appendChild(peakBadge);
      }
    }
  }

  // ─── Weather bar ─────────────────────────────────────────────
  var WX_ICONS = {
    0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌦️', 55: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️',
    71: '🌨️', 73: '🌨️', 75: '🌨️', 77: '🌨️',
    80: '🌦️', 81: '🌧️', 82: '🌧️',
    85: '🌨️', 86: '🌨️',
    95: '⛈️', 96: '⛈️', 99: '⛈️'
  };

  var WX_DESC = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm + hail', 99: 'Thunderstorm + hail'
  };

  var WX_CACHE_KEY = 'japan_trip_v2_weather';

  function wxGetCache() {
    try {
      var raw = localStorage.getItem(WX_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function wxSetCache(data) {
    try {
      localStorage.setItem(WX_CACHE_KEY, JSON.stringify({
        fetched: new Date().toISOString(),
        days: data
      }));
    } catch (e) { /* quota exceeded */ }
  }

  function wxFormatStale(isoStr) {
    if (!isoStr) return '';
    var diff = Date.now() - new Date(isoStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + 'min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  function renderWeatherBar(dayEl, data, staleTime, emptyMsg) {
    var body = dayEl.querySelector('.card-body');
    if (!body) return;

    var existing = body.querySelector('.weather-bar');
    if (existing) existing.remove();
    var existingAlert = body.querySelector('.rain-alert');
    if (existingAlert) existingAlert.remove();

    var bar = document.createElement('div');

    if (!data) {
      if (!emptyMsg) return; // past days: no bar at all
      bar.className = 'weather-bar wx-unavailable';
      bar.textContent = emptyMsg;
    } else {
      bar.className = 'weather-bar';
      var icon = WX_ICONS[data.code] || '🌡️';
      var desc = WX_DESC[data.code] || 'Unknown';
      var hasRain = typeof data.rain === 'number';
      var staleHtml = staleTime
        ? ' <span class="wx-stale">(fetched ' + esc(staleTime) + ')</span>' : '';

      bar.innerHTML =
        '<span class="wx-icon">' + icon + '</span>' +
        '<span class="wx-temps"><span class="wx-hi">' + Math.round(data.hi) + '°</span> / ' +
        '<span class="wx-lo">' + Math.round(data.lo) + '°</span></span>' +
        '<span class="wx-desc">' + esc(desc) + '</span>' +
        (hasRain ? '<span class="wx-rain">💧' + data.rain + '%</span>' : '') +
        staleHtml;

      if (hasRain && data.rain >= 60) {
        var alert = document.createElement('div');
        alert.className = 'rain-alert';
        var tags = dayEl.querySelectorAll('.tag-hike');
        if (tags.length > 0) {
          alert.textContent = '⚠ Heavy rain expected on hike day — consider alternatives';
        } else {
          alert.textContent = '🌧 ' + data.rain + '% chance of rain — pack umbrella';
        }
        body.insertBefore(alert, body.firstChild);
      }
    }

    body.insertBefore(bar, body.firstChild);
  }

  // Honest per-day message when there is no forecast (audit S8)
  function wxEmptyMessage(dayDate) {
    var todayStr = isoDate(jstNow());
    if (dayDate < todayStr) return null; // past day — show nothing
    var horizon = new Date(jstNow());
    horizon.setDate(horizon.getDate() + 15);
    if (dayDate > isoDate(horizon)) return '🌏 Forecast available ~2 weeks before this day';
    return '🌏 Forecast unavailable — offline?';
  }

  function renderAllWeather(weatherData, staleTime) {
    if (!DATA.days) return;
    for (var d = 0; d < DATA.days.length; d++) {
      var day = DATA.days[d];
      var dayEl = document.querySelector('.day-card:nth-child(' + (d + 1) + ')');
      if (!dayEl) {
        var dayCards = document.querySelectorAll('.day-card');
        for (var j = 0; j < dayCards.length; j++) {
          var numEl = dayCards[j].querySelector('.day-num');
          if (numEl && numEl.textContent.trim() === String(day.day)) {
            dayEl = dayCards[j];
            break;
          }
        }
      }
      if (!dayEl) continue;
      var dayData = weatherData ? weatherData[day.day] : null;
      renderWeatherBar(dayEl, dayData, staleTime, dayData ? null : wxEmptyMessage(day.date));
    }
  }

  var WX_MAX_CACHE_AGE_MS = 48 * 3600 * 1000;

  function wxRenderFromCache() {
    var cached = wxGetCache();
    if (!cached) return false;
    // A forecast older than 48h is more misleading than none (audit N8)
    if (cached.fetched && Date.now() - new Date(cached.fetched).getTime() > WX_MAX_CACHE_AGE_MS) {
      return false;
    }
    var stale = wxFormatStale(cached.fetched);
    renderAllWeather(cached.days, stale);
    return true;
  }

  function wxFetch() {
    if (!DATA.days || !DATA.meta) return Promise.resolve(false);

    var locGroups = {};
    for (var d = 0; d < DATA.days.length; d++) {
      var day = DATA.days[d];
      var loc = day.location;
      if (!loc) continue;
      var key = loc.lat + ',' + loc.lon;
      if (!locGroups[key]) locGroups[key] = { lat: loc.lat, lon: loc.lon, days: [] };
      locGroups[key].days.push({ num: day.day, date: day.date });
    }

    // JST calendar dates throughout — toISOString() is UTC and can be a day off (audit S8)
    var todayStr = isoDate(jstNow());
    var maxForecast = jstNow();
    maxForecast.setDate(maxForecast.getDate() + 15);
    var maxStr = isoDate(maxForecast);

    var keys = Object.keys(locGroups);
    var results = {};
    var fetches = [];

    for (var k = 0; k < keys.length; k++) {
      (function (g) {
        var dates = g.days.map(function (d) { return d.date; });
        var startDate = dates.reduce(function (a, b) { return a < b ? a : b; });
        var endDate = dates.reduce(function (a, b) { return a > b ? a : b; });

        if (startDate < todayStr) startDate = todayStr;
        if (endDate > maxStr) endDate = maxStr;
        if (startDate > maxStr || endDate < todayStr) return;

        var url = 'https://api.open-meteo.com/v1/forecast?' +
          'latitude=' + g.lat + '&longitude=' + g.lon +
          '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
          '&timezone=Asia/Tokyo&start_date=' + startDate + '&end_date=' + endDate;

        fetches.push(
          fetch(url).then(function (resp) {
            if (!resp.ok) return;
            return resp.json().then(function (json) {
              if (json.daily && json.daily.time) {
                var dateMap = {};
                for (var i = 0; i < json.daily.time.length; i++) {
                  dateMap[json.daily.time[i]] = {
                    hi: json.daily.temperature_2m_max[i],
                    lo: json.daily.temperature_2m_min[i],
                    rain: json.daily.precipitation_probability_max[i],
                    code: json.daily.weather_code[i]
                  };
                }
                for (var j = 0; j < g.days.length; j++) {
                  if (dateMap[g.days[j].date]) {
                    results[g.days[j].num] = dateMap[g.days[j].date];
                  }
                }
              }
            });
          }).catch(function () { /* network error */ })
        );
      })(locGroups[keys[k]]);
    }

    return Promise.all(fetches).then(function () {
      if (Object.keys(results).length > 0) {
        wxSetCache(results);
        renderAllWeather(results, null);
        return true;
      }
      return false;
    });
  }

  // ─── Almanac ──────────────────────────────────────────────
  // almanac.html is the single source of truth and stays editable standalone.
  // It is fetched once, parsed with DOMParser, and indexed by the data-place-id
  // each entry carries. The invariant the file guarantees: every places.json entry
  // whose category is not hotel/station/restaurant has exactly one almanac entry,
  // which is why the 📖 button gates on category alone and never has to check the
  // map (which is empty until the lazy load resolves).
  var ALMANAC_NO_ENTRY = ['hotel', 'station', 'restaurant'];
  var almanacPromise = null;
  var almanacRendered = false;
  var almanacPushedState = false;

  function loadAlmanac() {
    if (almanacPromise) return almanacPromise;
    almanacPromise = fetch('./almanac.html').then(function (resp) {
      if (!resp.ok) throw new Error('almanac HTTP ' + resp.status);
      return resp.text();
    }).then(function (text) {
      var doc = new DOMParser().parseFromString(text, 'text/html');

      var map = {};
      var entries = doc.querySelectorAll('.place[data-place-id]');
      for (var i = 0; i < entries.length; i++) {
        var el = entries[i];
        var body = el.querySelector('.place-body');
        var sub = el.querySelector('.place-id-line');
        map[el.getAttribute('data-place-id')] = {
          html: body ? body.innerHTML : '',
          sub: sub ? sub.textContent.trim() : '',
          text: (body ? body.textContent : '').replace(/\s+/g, ' ').toLowerCase()
        };
      }
      DATA.almanac = map;

      // Group by day, walking the document in order so a place belongs to the
      // day header above it. data-day is a days.json day number, or "substitutes".
      var groups = [];
      var current = null;
      var nodes = doc.body.children;
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (node.classList.contains('day-header')) {
          var h2 = node.querySelector('h2');
          var dsub = node.querySelector('.day-sub');
          current = {
            day: node.getAttribute('data-day') || '',
            date: node.getAttribute('data-date') || '',
            title: h2 ? h2.textContent.trim() : '',
            sub: dsub ? dsub.textContent.trim() : '',
            placeIds: []
          };
          groups.push(current);
        } else if (node.classList.contains('place') && current) {
          var pid = node.getAttribute('data-place-id');
          if (pid) current.placeIds.push(pid);
        }
      }
      DATA.almanacDays = groups;
      return map;
    }).catch(function (err) {
      almanacPromise = null;   // a failed load must not poison later attempts
      DATA.almanac = null;
      DATA.almanacDays = null;
      throw err;
    });
    return almanacPromise;
  }

  function openAlmanac(placeId) {
    var modal = document.getElementById('almanac-modal');
    var content = document.getElementById('almanac-content');
    if (!modal || !content) return;

    var place = placeById(placeId);
    content.innerHTML = '<div class="section-empty">Loading the almanac…</div>';
    modal.hidden = false;
    document.body.classList.add('modal-open');
    if (!almanacPushedState) {
      history.pushState({ almanac: true }, '');
      almanacPushedState = true;
    }

    loadAlmanac().then(function (map) {
      var entry = map[placeId];
      var html = '';
      if (place) {
        html += '<div class="almanac-name">' + esc(place.name_en);
        if (place.name_jp) {
          html += '<span class="almanac-name-jp copyable" data-copy="' + esc(place.search_jp || place.name_jp) +
            '" data-copy-hint="paste into your offline map">' + esc(place.name_jp) + '</span>';
        }
        html += '</div>';
      }
      if (entry && entry.sub) {
        html += '<div class="almanac-sub">' + esc(entry.sub) + '</div>';
      }
      if (entry) {
        html += '<div class="almanac-entry">' + entry.html + '</div>';
      } else {
        html += '<div class="section-empty">No almanac entry for this place.</div>';
      }
      content.innerHTML = html;
      bindCopyables(content);
      content.scrollTop = 0;
    }).catch(function () {
      content.innerHTML = '<div class="section-empty">The almanac could not be loaded. ' +
        'Open the app online once and it will be cached for offline use.</div>';
    });
  }

  function closeAlmanac(fromPopstate) {
    var modal = document.getElementById('almanac-modal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    var pushed = almanacPushedState;
    almanacPushedState = false;
    if (pushed && !fromPopstate) history.back();
  }

  function renderAlmanac() {
    var container = document.getElementById('section-almanac');
    if (!container) return;
    container.innerHTML = '<div class="section-empty">Loading the almanac…</div>';

    loadAlmanac().then(function () {
      var groups = DATA.almanacDays || [];
      var currentDayNum = DATA.meta ? tripDayNumber(DATA.meta) : NaN;
      var html = '';

      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var isToday = String(grp.day) === String(currentDayNum);
        html += '<div class="day-card' + (isToday ? ' today card-open' : '') + '">';
        html += '<div class="card-header" data-toggle>';
        html += '<div class="day-num">' + (grp.day === 'substitutes' ? '☂' : esc(grp.day)) + '</div>';
        html += '<div class="day-meta">';
        html += '<div class="day-title">' + esc(grp.title) + '</div>';
        html += '<div class="day-sub">' + esc(grp.sub) + '</div>';
        html += '</div>';
        html += '<span class="chevron">▶</span>';
        html += '</div>';

        html += '<div class="card-body">';
        for (var p = 0; p < grp.placeIds.length; p++) {
          var pid = grp.placeIds[p];
          var place = placeById(pid);
          var entry = DATA.almanac[pid];
          html += '<div class="item almanac-link" data-almanac="' + esc(pid) + '">';
          html += '<div class="item-name">📖 ' + esc(place ? place.name_en : pid) + '</div>';
          if (entry && entry.sub) {
            html += '<div class="item-detail">' + esc(entry.sub) + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
        html += '</div>';
      }

      container.innerHTML = html || '<div class="section-empty">No almanac entries found.</div>';
      bindCardToggles(container);
    }).catch(function () {
      container.innerHTML = '<div class="section-empty">The almanac could not be loaded. ' +
        'Open the app online once and it will be cached for offline use.</div>';
    });
  }

  // ─── Header subtitle (trip countdown / current day) ───────
  function updateHeaderSub() {
    var sub = document.getElementById('header-sub');
    if (!sub || !DATA.meta) return;
    var meta = DATA.meta;
    var currentDay = tripDayNumber(meta);

    if (currentDay < 0) {
      var diff = -currentDay;
      sub.textContent = diff + ' day' + (diff !== 1 ? 's' : '') + ' until departure';
    } else if (currentDay <= meta.total_days) {
      var city = null;
      for (var i = 0; i < meta.cities.length; i++) {
        if (meta.cities[i].days.indexOf(currentDay) !== -1) {
          city = meta.cities[i];
          break;
        }
      }
      sub.textContent = 'Day ' + currentDay + ' of ' + meta.total_days +
        (city ? ' — ' + city.name : '');
    } else {
      sub.textContent = meta.route_summary;
    }
  }

  // ─── Theme toggle (dark ↔ OLED) ───────────────────────────
  var themeBtn = document.getElementById('theme-toggle');
  var MODES = ['dark', 'oled'];
  var THEME_ICONS = { dark: '◐', oled: '⬛' };
  var LABELS = { dark: 'Dark theme', oled: 'OLED theme' };

  function applyTheme(mode) {
    document.body.classList.remove('oled-mode');
    if (mode === 'oled') document.body.classList.add('oled-mode');
    themeBtn.textContent = THEME_ICONS[mode];
    themeBtn.title = LABELS[mode];
    localStorage.setItem('theme_mode', mode);

    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = mode === 'oled' ? '#000000' : '#1a1a1a';
  }

  // Guarded: a missing header element must not kill the whole app (audit N5)
  if (themeBtn) {
    var savedTheme = localStorage.getItem('theme_mode') || 'dark';
    if (MODES.indexOf(savedTheme) === -1) savedTheme = 'dark';
    applyTheme(savedTheme);

    themeBtn.addEventListener('click', function () {
      var current = localStorage.getItem('theme_mode') || 'dark';
      var next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
      applyTheme(next);
      if (navigator.vibrate) navigator.vibrate(10);
    });
  }

  // ─── Bottom nav — section switching ───────────────────────
  var navLinks = document.querySelectorAll('.bottom-nav a');
  var sections = document.querySelectorAll('.content-section');

  var VALID_SECTIONS = ['days', 'food', 'transit', 'phrases', 'sos', 'info', 'almanac'];

  function switchSection(target) {
    if (VALID_SECTIONS.indexOf(target) === -1) target = 'days';

    // The almanac tab is built the first time it is opened, not at startup.
    // ⚠ switchSection also runs from the initial #section-almanac hash, BEFORE the
    // data promise resolves — rendering then would print raw place ids instead of
    // names. Skip it here and let the init block render it once places exist.
    if (target === 'almanac' && !almanacRendered && DATA.places) {
      almanacRendered = true;
      renderAlmanac();
    }

    sections.forEach(function (s) { s.classList.remove('active'); });
    navLinks.forEach(function (a) { a.classList.remove('nav-active'); });

    var section = document.getElementById('section-' + target);
    var link = document.querySelector('.bottom-nav a[data-section="' + target + '"]');
    if (section) section.classList.add('active');
    if (link) link.classList.add('nav-active');

    history.replaceState(null, '', '#section-' + target);
    window.scrollTo({ top: 0 });
  }

  var initialSection = (location.hash || '').replace('#section-', '') || 'days';
  switchSection(initialSection);

  navLinks.forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      switchSection(this.getAttribute('data-section'));
      if (navigator.vibrate) navigator.vibrate(10);
    });
  });

  // ─── Search toggle ────────────────────────────────────────
  var searchContainer = document.getElementById('search-container');
  var searchInput = document.getElementById('search-input');
  var searchToggle = document.getElementById('search-toggle');
  var searchClear = document.getElementById('search-clear');

  if (searchToggle && searchContainer && searchInput && searchClear) {
    searchToggle.addEventListener('click', function () {
      var isHidden = searchContainer.hidden;
      searchContainer.hidden = !isHidden;
      if (!isHidden) {
        searchInput.value = '';
        searchClear.style.display = 'none';
        runSearch('');
      } else {
        searchInput.focus();
      }
    });
  }

  // ─── Search engine ─────────────────────────────────────────
  var searchIndex = [];
  var searchResultsEl = null;

  function buildSearchIndex() {
    searchIndex = [];

    // Restaurants only deep-link to Food if the food guide actually contains them;
    // otherwise route to Days where their place card lives (audit S10)
    var foodPlaceIds = {};
    if (DATA.food && DATA.food.days) {
      for (var fdi = 0; fdi < DATA.food.days.length; fdi++) {
        var fdd = DATA.food.days[fdi];
        for (var fmi = 0; fmi < (fdd.meals || []).length; fmi++) {
          for (var fri = 0; fri < (fdd.meals[fmi].restaurants || []).length; fri++) {
            var fpid = fdd.meals[fmi].restaurants[fri].place_id;
            if (fpid) foodPlaceIds[fpid] = true;
          }
        }
      }
    }

    // The rain and closure substitutes are in places.json but on no day, so routing
    // them to Days scrolls to a card that was never rendered. They have almanac
    // entries; send them there instead.
    var dayPlaceIds = {};
    if (DATA.days) {
      for (var dpi = 0; dpi < DATA.days.length; dpi++) {
        var dpBlocks = DATA.days[dpi].blocks || [];
        for (var dpb = 0; dpb < dpBlocks.length; dpb++) {
          var dpItems = dpBlocks[dpb].items || [];
          for (var dpt = 0; dpt < dpItems.length; dpt++) {
            if (dpItems[dpt].place_id) dayPlaceIds[dpItems[dpt].place_id] = true;
          }
        }
      }
    }

    // Places
    if (DATA.places) {
      for (var i = 0; i < DATA.places.length; i++) {
        var p = DATA.places[i];
        if (p.category === 'station') continue;
        var isFoodPlace = p.category === 'restaurant' && foodPlaceIds[p.id];
        var onlyInAlmanac = !isFoodPlace && !dayPlaceIds[p.id] &&
          ALMANAC_NO_ENTRY.indexOf(p.category) === -1;
        var pText = [p.name_en, p.name_jp, p.address_jp, p.category, p.cuisine, p.notes, p.price]
          .filter(Boolean).join(' ');
        searchIndex.push({
          text: pText.toLowerCase(),
          section: isFoodPlace ? 'food' : (onlyInAlmanac ? 'almanac' : 'days'),
          icon: p.category === 'restaurant' ? '🍜' : (onlyInAlmanac ? '📖' : '📅'),
          title: p.name_en,
          detail: (p.name_jp ? p.name_jp + ' · ' : '') + (p.category || ''),
          place_id: p.id
        });
      }
    }

    // Days
    if (DATA.days) {
      for (var d = 0; d < DATA.days.length; d++) {
        var day = DATA.days[d];
        var dayParts = [day.title, day.city, day.date];
        var dBlocks = day.blocks || [];
        for (var b = 0; b < dBlocks.length; b++) {
          var block = dBlocks[b];
          dayParts.push(block.title);
          var bItems = block.items || [];
          for (var it = 0; it < bItems.length; it++) {
            var item = bItems[it];
            if (item.label) dayParts.push(item.label);
            if (item.detail) dayParts.push(item.detail);
          }
        }
        if (day.notes_top) dayParts = dayParts.concat(day.notes_top);
        if (day.notes) dayParts = dayParts.concat(day.notes);
        if (day.backup) dayParts.push(day.backup.title, day.backup.detail);
        searchIndex.push({
          text: dayParts.filter(Boolean).join(' ').toLowerCase(),
          section: 'days',
          icon: '📅',
          title: 'Day ' + day.day + ' — ' + day.title,
          detail: day.city + ' · ' + day.date,
          day_num: day.day
        });
      }
    }

    // Food
    if (DATA.food) {
      // The food.tips ekiben card was deleted at the R7 walkthrough — it repeated
      // the day cards it sat above, and the user ruled it out ("you can delete the
      // ekiben card and just fold the info onto the relevant day cards"). Both
      // stops keep everything on their own day: day 7 carries the 09:10→09:30
      // clock and the transfer-gate rule, day 19 the ~90 minutes, the gate and the
      // box. food.json no longer has a `tips` key at all.
      if (DATA.food.days) {
        for (var fd = 0; fd < DATA.food.days.length; fd++) {
          var fday = DATA.food.days[fd];
          var fParts = [fday.city, fday.subtitle, fday.date];
          for (var fm = 0; fm < fday.meals.length; fm++) {
            var meal = fday.meals[fm];
            fParts.push(meal.slot, meal.time_hint);
            for (var fr = 0; fr < meal.restaurants.length; fr++) {
              // Merged, so the venue-level order block is searchable too —
              // indexing the raw entry would silently miss every venue field.
              var rest = foodEntry(DATA.food, meal.restaurants[fr]);
              // Every prose field on the entry joins the index. Adding text the
              // search cannot see is presence without correctness — order_jp is
              // included so a dish can be found by its Japanese name too.
              fParts.push(rest.cuisine, rest.order, rest.note, rest.price,
                rest.order_how, rest.order_jp, rest.order_romaji,
                rest.order_why, rest.order_backup);
              var rPlace = rest.place_id ? placeById(rest.place_id) : null;
              if (rPlace) fParts.push(rPlace.name_en, rPlace.name_jp);
            }
          }
          searchIndex.push({
            text: fParts.filter(Boolean).join(' ').toLowerCase(),
            section: 'food',
            icon: '🍜',
            title: fday.city + (fday.subtitle ? ' — ' + fday.subtitle : ''),
            detail: 'Day ' + fday.day + ' food',
            day_num: fday.day
          });
        }
      }
    }

    // Phrases
    if (DATA.phrases && DATA.phrases.groups) {
      for (var g = 0; g < DATA.phrases.groups.length; g++) {
        var group = DATA.phrases.groups[g];
        for (var ph = 0; ph < group.phrases.length; ph++) {
          var phrase = group.phrases[ph];
          searchIndex.push({
            text: [phrase.en, phrase.jp, phrase.romaji, phrase.context].filter(Boolean).join(' ').toLowerCase(),
            section: 'phrases',
            icon: '🗣',
            title: phrase.en,
            detail: phrase.jp + (phrase.romaji ? ' · ' + phrase.romaji : '')
          });
        }
      }
    }

    // SOS
    if (DATA.sos) {
      var sos = DATA.sos;
      if (sos.emergency_numbers) {
        for (var en = 0; en < sos.emergency_numbers.length; en++) {
          var num = sos.emergency_numbers[en];
          searchIndex.push({
            text: ['emergency', num.label, num.number, num.note_en].filter(Boolean).join(' ').toLowerCase(),
            section: 'sos',
            icon: '🚨',
            title: num.label,
            detail: num.number
          });
        }
      }
      if (sos.embassy) {
        searchIndex.push({
          text: ['embassy', sos.embassy.name_en, sos.embassy.address_en, sos.embassy.address_jp, sos.embassy.consular_hours].filter(Boolean).join(' ').toLowerCase(),
          section: 'sos',
          icon: '🏛',
          title: sos.embassy.name_en,
          detail: sos.embassy.consular_hours || ''
        });
      }
      if (sos.hotels) {
        for (var h = 0; h < sos.hotels.length; h++) {
          var hotel = sos.hotels[h];
          var hpl = placeById(hotel.place_id);
          if (!hpl) continue;
          searchIndex.push({
            text: ['hotel', hpl.name_en, hpl.name_jp, hotel.city, hpl.address_jp, hotel.dates].filter(Boolean).join(' ').toLowerCase(),
            section: 'sos',
            icon: '🏨',
            title: hpl.name_en,
            detail: hotel.city + ' · ' + hotel.dates
          });
        }
      }
      if (sos.medical) {
        for (var md = 0; md < sos.medical.length; md++) {
          var med = sos.medical[md];
          var medParts = ['medical', 'hospital', 'pharmacy', med.city, med.dates];
          if (med.hospital) medParts.push(med.hospital.name_en, med.hospital.name_jp, med.hospital.note);
          if (med.pharmacy) medParts.push(med.pharmacy.name, med.pharmacy.location);
          searchIndex.push({
            text: medParts.filter(Boolean).join(' ').toLowerCase(),
            section: 'sos',
            icon: '🏥',
            title: med.hospital ? med.hospital.name_en : 'Medical — ' + med.city,
            detail: med.city + ' · ' + med.dates
          });
        }
      }
      if (sos.show_to_staff_cards) {
        for (var sc = 0; sc < sos.show_to_staff_cards.length; sc++) {
          var card = sos.show_to_staff_cards[sc];
          searchIndex.push({
            text: ['show to staff', card.en, card.jp, card.romaji].filter(Boolean).join(' ').toLowerCase(),
            section: 'sos',
            icon: '📱',
            title: card.en,
            detail: card.jp
          });
        }
      }
    }

    // Flights
    if (DATA.reservations && DATA.reservations.flights) {
      for (var fx = 0; fx < DATA.reservations.flights.length; fx++) {
        var flx = DATA.reservations.flights[fx];
        searchIndex.push({
          text: ['flight', flx.flight_no, flx.airline, flx.from, flx.to, flx.from_name, flx.to_name, flx.confirmation]
            .filter(Boolean).join(' ').toLowerCase(),
          section: 'info',
          icon: '✈️',
          title: (flx.flight_no || 'Flight') + ' · ' + (flx.from || '') + ' → ' + (flx.to || ''),
          detail: fmtDateTime(flx.depart)
        });
      }
    }

    // Documents
    if (DATA.reservations && DATA.reservations.documents) {
      for (var dx = 0; dx < DATA.reservations.documents.length; dx++) {
        var docx = DATA.reservations.documents[dx];
        searchIndex.push({
          text: ['document', docx.title].filter(Boolean).join(' ').toLowerCase(),
          section: 'info',
          icon: '📄',
          title: docx.title || 'Document',
          detail: docx.date ? fmtDate(docx.date) : ''
        });
      }
    }

    // Reservations
    if (DATA.reservations && DATA.reservations.hotels) {
      for (var ri = 0; ri < DATA.reservations.hotels.length; ri++) {
        var rbk = DATA.reservations.hotels[ri];
        var rpl = rbk.place_id ? placeById(rbk.place_id) : null;
        var rParts = ['hotel', 'reservation', 'booking', rbk.check_in, rbk.check_out, rbk.room_notes,
          rbk.confirmation, rbk.pin];
        if (rpl) rParts.push(rpl.name_en, rpl.name_jp, rpl.address_jp);
        searchIndex.push({
          text: rParts.filter(Boolean).join(' ').toLowerCase(),
          section: 'info',
          icon: '🏨',
          title: rpl ? rpl.name_en : 'Hotel Reservation',
          detail: rbk.check_in + ' → ' + rbk.check_out
        });
      }
    }
  }

  // The almanac is loaded after first paint, so its prose joins the index late.
  // Every almanac-routed row is dropped first — both rows added by a previous call
  // and the substitutes' own place rows, which this supersedes by folding their
  // notes into the prose row. That keeps one result per place, and makes the
  // function safe to call again after a rebuild of the base index.
  function addAlmanacToSearchIndex() {
    if (!DATA.almanac) return;
    searchIndex = searchIndex.filter(function (row) { return row.section !== 'almanac'; });
    for (var pid in DATA.almanac) {
      if (!Object.prototype.hasOwnProperty.call(DATA.almanac, pid)) continue;
      var place = placeById(pid);
      var entry = DATA.almanac[pid];
      var parts = [];
      if (place) parts.push(place.name_en, place.name_jp, place.address_jp, place.category, place.notes);
      parts.push(entry.text);
      searchIndex.push({
        text: parts.filter(Boolean).join(' ').toLowerCase(),
        section: 'almanac',
        icon: '📖',
        title: place ? place.name_en : pid,
        detail: entry.sub || 'Almanac entry',
        place_id: pid
      });
    }
  }

  function revealAndScroll(el) {
    if (!el) return;
    var node = el.parentElement;
    while (node && node !== document.body) {
      if (node.classList.contains('card-body')) {
        var card = node.parentElement;
        if (card && !card.classList.contains('card-open')) {
          card.classList.add('card-open');
        }
      }
      node = node.parentElement;
    }
    setTimeout(function () {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid var(--accent)';
      el.style.outlineOffset = '2px';
      setTimeout(function () {
        el.style.outline = '';
        el.style.outlineOffset = '';
      }, 2000);
    }, 100);
  }

  function findSearchTarget(match, sectionEl) {
    if (match.place_id) {
      return sectionEl.querySelector('[data-place-id="' + match.place_id + '"]');
    }
    if (match.day_num) {
      var dayCards = sectionEl.querySelectorAll('.day-num');
      for (var i = 0; i < dayCards.length; i++) {
        if (dayCards[i].textContent.trim() === String(match.day_num)) {
          return dayCards[i].closest('.day-card, .food-day, .transit-day');
        }
      }
    }
    return null;
  }

  function runSearch(query) {
    var countEl = document.getElementById('search-count');
    if (!searchResultsEl) {
      searchResultsEl = document.createElement('div');
      searchResultsEl.id = 'search-results';
      searchResultsEl.className = 'search-results';
      document.getElementById('main').appendChild(searchResultsEl);
    }

    if (!query) {
      searchResultsEl.style.display = 'none';
      countEl.textContent = '';
      sections.forEach(function (s) { s.style.display = ''; });
      return;
    }

    var q = query.toLowerCase().trim();
    var words = q.split(/\s+/);
    var matches = [];
    for (var i = 0; i < searchIndex.length; i++) {
      var entry = searchIndex[i];
      var hit = true;
      for (var w = 0; w < words.length; w++) {
        if (entry.text.indexOf(words[w]) === -1) { hit = false; break; }
      }
      if (hit) matches.push(entry);
    }

    sections.forEach(function (s) { s.style.display = 'none'; });
    countEl.textContent = matches.length + ' result' + (matches.length !== 1 ? 's' : '');

    if (matches.length === 0) {
      searchResultsEl.innerHTML = '<div class="section-empty">No results for "' + esc(query) + '"</div>';
      searchResultsEl.style.display = 'block';
      return;
    }

    var html = '';
    for (var m = 0; m < matches.length; m++) {
      var match = matches[m];
      html += '<div class="search-result" data-section="' + esc(match.section) + '" data-match-idx="' + m + '">';
      html += '<span class="search-result-icon">' + match.icon + '</span>';
      html += '<div class="search-result-body">';
      html += '<div class="search-result-title">' + esc(match.title) + '</div>';
      html += '<div class="search-result-detail">' + esc(match.detail) + '</div>';
      html += '</div>';
      html += '</div>';
    }
    searchResultsEl.innerHTML = html;
    searchResultsEl.style.display = 'block';

    var currentMatches = matches;
    var resultCards = searchResultsEl.querySelectorAll('.search-result');
    for (var r = 0; r < resultCards.length; r++) {
      resultCards[r].addEventListener('click', function () {
        var targetSection = this.getAttribute('data-section');
        var matchIdx = parseInt(this.getAttribute('data-match-idx'), 10);
        var match = currentMatches[matchIdx];

        searchInput.value = '';
        searchClear.style.display = 'none';
        countEl.textContent = '';
        searchResultsEl.style.display = 'none';
        sections.forEach(function (s) { s.style.display = ''; });
        switchSection(targetSection);

        // An almanac hit is an entry, not a position in a list — open it directly.
        // Closing the modal then leaves you on the almanac tab.
        if (targetSection === 'almanac' && match && match.place_id) {
          openAlmanac(match.place_id);
          return;
        }

        var sectionEl = document.getElementById('section-' + targetSection);
        if (sectionEl && match) {
          var target = findSearchTarget(match, sectionEl);
          revealAndScroll(target);
        }
      });
    }
  }

  var searchDebounce = null;
  if (searchInput && searchClear) {
    searchInput.addEventListener('input', function () {
      searchClear.style.display = this.value ? 'block' : 'none';
      var val = this.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(function () { runSearch(val); }, 150);
    });

    searchClear.addEventListener('click', function () {
      searchInput.value = '';
      searchClear.style.display = 'none';
      runSearch('');
      searchInput.focus();
    });
  }

  // ─── Back to top ──────────────────────────────────────────
  var backToTop = document.getElementById('back-to-top');

  if (backToTop) {
    window.addEventListener('scroll', function () {
      backToTop.hidden = window.scrollY < 300;
    }, { passive: true });

    backToTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (navigator.vibrate) navigator.vibrate(10);
    });
  }

  // ─── Load data and render ─────────────────────────────────
  // Each file degrades independently — one bad/missing JSON must not blank
  // the whole app (audit C1). Renderers handle a null DATA.x already.
  // no-store: the SW is network-first for data, but the browser's own HTTP cache sits
  // BELOW that fetch and can serve a stale JSON through a reload on a header-less server.
  // Offline is unaffected — the SW falls back to Cache Storage, which this does not touch.
  function loadJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.json();
    }).catch(function (err) {
      console.error('Data load failed:', url, err);
      return null;
    });
  }

  function scrollToToday() {
    var todayCard = document.querySelector('#section-days.active .day-card.today');
    if (!todayCard) return;
    setTimeout(function () {
      todayCard.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, 50);
  }

  // ─── Almanac triggers (delegated — cards are re-rendered) ──
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    var trigger = e.target.closest('[data-almanac]');
    if (trigger) {
      e.preventDefault();
      e.stopPropagation();
      openAlmanac(trigger.getAttribute('data-almanac'));
    }
  });

  var almanacCloseBtn = document.getElementById('almanac-close');
  if (almanacCloseBtn) {
    almanacCloseBtn.addEventListener('click', function () { closeAlmanac(false); });
    // ⚑ Belt and braces for the iOS report (2026-08-19): after scrolling the
    // entry, the Back button sometimes did not register. If what iOS is eating
    // is the synthesized `click` — which is what the first tap after momentum
    // scrolling gets consumed by — then `touchend` still arrives. Double-firing
    // is harmless: closeAlmanac() returns immediately when the modal is already
    // hidden. preventDefault stops the same tap also producing a click.
    almanacCloseBtn.addEventListener('touchend', function (e) {
      e.preventDefault();
      closeAlmanac(false);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAlmanac(false);
  });

  window.addEventListener('popstate', function () {
    closeAlmanac(true);
  });

  Promise.all([
    loadJSON('./data/meta.json'),
    loadJSON('./data/days.json'),
    loadJSON('./data/places.json'),
    loadJSON('./data/food.json'),
    loadJSON('./data/phrases.json'),
    loadJSON('./data/sos.json'),
    loadJSON('./data/reservations.json')
  ]).then(function (results) {
    DATA.meta = results[0];
    DATA.days = results[1];
    DATA.places = results[2];
    DATA.food = results[3];
    DATA.phrases = results[4];
    DATA.sos = results[5];
    DATA.reservations = results[6];

    var failed = results.filter(function (r) { return r === null; }).length;
    if (failed > 0) {
      var sub = document.getElementById('header-sub');
      if (sub) sub.textContent = failed === results.length
        ? 'Could not load trip data'
        : 'Some data failed to load (' + failed + ' file' + (failed !== 1 ? 's' : '') + ')';
    }

    if (DATA.meta) updateHeaderSub();
    renderDays();
    renderFood();
    renderTransit();
    renderPhrases();
    renderSOS();
    renderInfo();
    buildSearchIndex();
    scrollToToday();

    // Deep link straight to #section-almanac: switchSection ran before this promise
    // resolved and deliberately skipped the render, so do it now that places exist.
    var almanacSection = document.getElementById('section-almanac');
    if (almanacSection && almanacSection.classList.contains('active') && !almanacRendered) {
      almanacRendered = true;
      renderAlmanac();
    }

    // Almanac: parsed after first paint so 640 KB of HTML never delays the itinerary,
    // and its prose is searchable even if the tab is never opened. A failure here is
    // silent by design — the 📖 buttons report it themselves when tapped.
    setTimeout(function () {
      loadAlmanac().then(addAlmanacToSearchIndex).catch(function () { });
    }, 0);

    // Open/closed badges
    applyBadges();
    setInterval(applyBadges, 60000);

    // Weather
    var hadCache = wxRenderFromCache();
    if (navigator.onLine) {
      wxFetch().catch(function () { return false; }).then(function (fetched) {
        if (!fetched && !hadCache) {
          renderAllWeather(null, null);
        }
      });
    } else if (!hadCache) {
      renderAllWeather(null, null);
    }
  });

})();
