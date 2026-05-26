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

  function esc(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
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

  function mapsTransitUrl(originPlace, destPlace) {
    return 'https://www.google.com/maps/dir/?api=1' +
      '&origin=' + originPlace.lat + ',' + originPlace.lon +
      '&destination=' + destPlace.lat + ',' + destPlace.lon +
      '&travelmode=transit';
  }

  // ─── Tap-to-copy ─────────────────────────────────────────
  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    }
    if (navigator.vibrate) navigator.vibrate(10);
    showCopyToast();
  }

  function showCopyToast() {
    var existing = document.querySelector('.copy-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = 'Copied';
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 1300);
  }

  // ─── Fullscreen overlay ───────────────────────────────────
  function showFullscreen(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'fs-overlay';
    var html = '';
    html += '<button class="fs-close" aria-label="Close">✕</button>';
    if (opts.jp) html += '<div class="fs-jp">' + esc(opts.jp) + '</div>';
    if (opts.romaji) html += '<div class="fs-romaji">' + esc(opts.romaji) + '</div>';
    if (opts.en) html += '<div class="fs-en">' + esc(opts.en) + '</div>';
    if (opts.context) html += '<div class="fs-context">' + esc(opts.context) + '</div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    overlay.querySelector('.fs-close').addEventListener('click', function () {
      overlay.remove();
    });
    if (navigator.vibrate) navigator.vibrate(10);
  }

  // ─── Collapsible toggle ───────────────────────────────────
  function toggleCard(el) {
    el.classList.toggle('card-open');
    if (navigator.vibrate) navigator.vibrate(10);
  }

  // ─── Place card renderer ──────────────────────────────────
  function renderPlaceCard(place, detail) {
    var html = '';
    html += '<div class="item" data-place-id="' + esc(place.id) + '">';
    html += '<div class="item-name">' + esc(place.name_en);
    if (place.name_jp) {
      html += ' <span class="item-name-jp copyable" data-copy="' + esc(place.name_jp) + '">' + esc(place.name_jp) + '</span>';
    }
    html += '</div>';
    if (detail) {
      html += '<div class="item-detail">' + esc(detail) + '</div>';
    }

    // Place info row (hours summary, price, address)
    var infoParts = [];
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
    if (place.phone) {
      html += '<a class="btn btn-call" href="tel:' + esc(place.phone) + '">📞 Call</a>';
    }
    if (place.url) {
      html += '<a class="btn btn-web" href="' + esc(place.url) + '" target="_blank" rel="noopener">🔗 Web</a>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ─── Transit leg renderer ─────────────────────────────────
  function renderTransitLegs(legs) {
    if (!legs || legs.length === 0) return '';
    var html = '<div class="transit-box">';
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      var badgeClass = leg.mode === 'walking' ? 'walk' :
        (leg.payment === 'private' ? 'private' : 'transit');
      var badgeLabel = leg.mode === 'walking' ? 'Walk' :
        (leg.payment === 'private' ? 'Private' : 'Train');

      html += '<div class="tleg">';
      html += '<span class="tleg-badge ' + badgeClass + '">' + esc(badgeLabel) + '</span>';
      html += '<div class="tleg-info">';
      html += '<div class="tleg-label">' + esc(leg.label) + '</div>';
      if (leg.detail) html += '<div class="tleg-detail">' + esc(leg.detail) + '</div>';
      if (leg.cost) html += '<div class="tleg-cost">' + esc(leg.cost) + '</div>';

      // Transit directions link
      var origin = placeById(leg.origin_id);
      var dest = placeById(leg.destination_id);
      if (origin && dest) {
        var tUrl = leg.mode === 'walking' ? mapsWalkUrl(dest) : mapsTransitUrl(origin, dest);
        html += '<a class="btn btn-transit" href="' + tUrl + '" target="_blank" rel="noopener" style="margin-top:6px;display:inline-flex;">🗺 Directions</a>';
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
    var currentDayNum = tripDayNumber(DATA.meta);
    var html = '';

    for (var d = 0; d < DATA.days.length; d++) {
      var day = DATA.days[d];
      var tripInProgress = currentDayNum >= 1 && currentDayNum <= DATA.meta.total_days;
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
      html += '<div class="day-sub">' + esc(day.weekday + ', ' + day.date + ' — ' + day.city) + '</div>';
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
      for (var b = 0; b < day.blocks.length; b++) {
        var block = day.blocks[b];
        html += '<div class="block">';
        html += '<div class="block-title ' + esc(block.type) + '">' + esc(block.title) + '</div>';

        // Transit legs in this block
        if (block.transit && block.transit.length > 0) {
          html += renderTransitLegs(block.transit);
        }

        // Items in this block
        for (var it = 0; it < block.items.length; it++) {
          var item = block.items[it];
          var place = item.place_id ? placeById(item.place_id) : null;

          if (place) {
            html += renderPlaceCard(place, item.detail);
          } else if (item.label) {
            html += '<div class="item">';
            html += '<div class="item-name">' + esc(item.label) + '</div>';
            if (item.detail) html += '<div class="item-detail">' + esc(item.detail) + '</div>';
            html += '</div>';
          }
        }

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

    // Hotels
    if (sos.hotels && sos.hotels.length > 0) {
      html += '<div class="sos-group">';
      html += '<div class="sos-group-title">🏨 Hotels</div>';
      for (var h = 0; h < sos.hotels.length; h++) {
        var hotel = sos.hotels[h];
        html += '<div class="hotel-card">';
        html += '<div class="hotel-dates">' + esc(hotel.dates) + ' — ' + esc(hotel.city) + '</div>';
        html += '<div class="hotel-name">' + esc(hotel.name_en) + '</div>';
        if (hotel.name_jp) html += '<div class="hotel-name-jp copyable" data-copy="' + esc(hotel.name_jp) + '">' + esc(hotel.name_jp) + '</div>';
        if (hotel.address_jp) html += '<div class="hotel-address copyable" data-copy="' + esc(hotel.address_jp) + '">' + esc(hotel.address_jp) + '</div>';
        html += '<div class="btn-row" style="margin-top:8px">';
        if (hotel.tel) {
          html += '<a class="btn btn-call" href="' + esc(hotel.tel) + '">📞 Call</a>';
        }
        if (hotel.show_to_staff) {
          html += '<button class="show-staff-btn" data-jp="' + esc(hotel.show_to_staff.jp) + '" data-en="' + esc(hotel.show_to_staff.en) + '">📱 Show to Staff</button>';
        }
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
          if (med.hospital.address) html += '<div class="medical-detail">' + esc(med.hospital.address) + '</div>';
          if (med.hospital.note) html += '<div class="medical-detail">' + esc(med.hospital.note) + '</div>';
          if (med.hospital.hours) html += '<div class="medical-detail">' + esc(med.hospital.hours) + '</div>';
          if (med.hospital.distance) html += '<div class="medical-detail">' + esc(med.hospital.distance) + '</div>';
          if (med.hospital.tel) {
            html += '<a class="btn btn-call" href="' + esc(med.hospital.tel) + '" style="margin-top:6px">📞 ' + esc(med.hospital.phone) + '</a>';
          }
        }
        if (med.pharmacy) {
          html += '<div class="medical-detail" style="margin-top:8px;font-weight:600">💊 ' + esc(med.pharmacy.name) + '</div>';
          if (med.pharmacy.location) html += '<div class="medical-detail">' + esc(med.pharmacy.location) + '</div>';
          if (med.pharmacy.hours) html += '<div class="medical-detail">' + esc(med.pharmacy.hours) + '</div>';
          if (med.pharmacy.note) html += '<div class="medical-detail">' + esc(med.pharmacy.note) + '</div>';
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

  // ─── Food section renderer ─────────────────────────────────
  function renderFood() {
    var container = document.getElementById('section-food');
    if (!DATA.food) {
      container.innerHTML = '<div class="section-empty">Food data not loaded</div>';
      return;
    }
    var food = DATA.food;
    var html = '';

    // Tips section (collapsible)
    if (food.tips && food.tips.ekiben) {
      var ek = food.tips.ekiben;
      html += '<div class="food-tips card-open">';
      html += '<div class="card-header" data-toggle>';
      html += '<span class="food-tips-icon">🍱</span>';
      html += '<span class="food-tips-title">' + esc(ek.title) + '</span>';
      html += '<span class="chevron">▶</span>';
      html += '</div>';
      html += '<div class="card-body">';

      // Ekiben locations with picks
      for (var e = 0; e < ek.items.length; e++) {
        var ekItem = ek.items[e];
        html += '<div class="ekiben-location">';
        html += '<div class="ekiben-loc-name">' + esc(ekItem.location) + '</div>';
        if (ekItem.detail) html += '<div class="ekiben-loc-detail">' + esc(ekItem.detail) + '</div>';
        for (var p = 0; p < ekItem.picks.length; p++) {
          var pick = ekItem.picks[p];
          html += '<div class="ekiben-pick">';
          html += '<span class="ekiben-pick-name">' + esc(pick.name) + '</span>';
          if (pick.price) html += '<span class="ekiben-pick-price">' + esc(pick.price) + '</span>';
          if (pick.note) html += '<div class="ekiben-pick-note">' + esc(pick.note) + '</div>';
          html += '</div>';
        }
        html += '</div>';
      }

      // Solo tips
      if (ek.solo_tips && ek.solo_tips.length > 0) {
        html += '<div class="food-solo-tips">';
        html += '<div class="food-solo-title">Solo Dining Tips</div>';
        for (var st = 0; st < ek.solo_tips.length; st++) {
          html += '<div class="food-solo-item">' + esc(ek.solo_tips[st]) + '</div>';
        }
        html += '</div>';
      }

      // Coin locker tip
      if (ek.coin_locker_tip) {
        html += '<div class="food-locker-tip">' + esc(ek.coin_locker_tip) + '</div>';
      }

      html += '</div>';
      html += '</div>';
    }

    // Per-day food cards
    if (food.days && food.days.length > 0) {
      for (var d = 0; d < food.days.length; d++) {
        var day = food.days[d];
        html += '<div class="food-day">';
        html += '<div class="card-header" data-toggle>';
        html += '<div class="day-num">' + day.day + '</div>';
        html += '<div class="day-meta">';
        html += '<div class="day-title">' + esc(day.city) + (day.subtitle ? ' — ' + day.subtitle : '') + '</div>';
        html += '<div class="day-sub">Day ' + day.day + ' · ' + esc(day.date) + '</div>';
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

          // Restaurants
          for (var r = 0; r < meal.restaurants.length; r++) {
            var rest = meal.restaurants[r];
            var place = rest.place_id ? placeById(rest.place_id) : null;

            html += '<div class="food-restaurant' + (rest.role === 'backup' ? ' food-backup' : '') + '">';

            // Role + badges row
            html += '<div class="food-badges">';
            if (rest.role === 'backup') {
              html += '<span class="food-badge backup">Backup</span>';
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
            if (rest.order) {
              html += '<div class="food-order">';
              html += '<span class="food-order-label">Order:</span> ' + esc(rest.order);
              html += '</div>';
            }
            if (rest.note) {
              html += '<div class="food-note">' + esc(rest.note) + '</div>';
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
  }

  // ─── Transit section (stub — Phase 4 second pass) ─────────
  function renderTransit() {
    var container = document.getElementById('section-transit');
    container.innerHTML = '<div class="section-empty">Transit section — coming next</div>';
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
        copyText(this.getAttribute('data-copy'));
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
          romaji: this.getAttribute('data-fs-romaji')
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
          context: this.getAttribute('data-fs-context')
        });
      });
    }
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

  var savedTheme = localStorage.getItem('theme_mode') || 'dark';
  if (MODES.indexOf(savedTheme) === -1) savedTheme = 'dark';
  applyTheme(savedTheme);

  themeBtn.addEventListener('click', function () {
    var current = localStorage.getItem('theme_mode') || 'dark';
    var next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
    applyTheme(next);
    if (navigator.vibrate) navigator.vibrate(10);
  });

  // ─── Bottom nav — section switching ───────────────────────
  var navLinks = document.querySelectorAll('.bottom-nav a');
  var sections = document.querySelectorAll('.content-section');

  var VALID_SECTIONS = ['days', 'food', 'transit', 'phrases', 'sos'];

  function switchSection(target) {
    if (VALID_SECTIONS.indexOf(target) === -1) target = 'days';

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

  searchToggle.addEventListener('click', function () {
    var isHidden = searchContainer.hidden;
    searchContainer.hidden = !isHidden;
    if (!isHidden) {
      searchInput.value = '';
      searchClear.style.display = 'none';
      document.getElementById('search-count').textContent = '';
    } else {
      searchInput.focus();
    }
  });

  searchInput.addEventListener('input', function () {
    searchClear.style.display = this.value ? 'block' : 'none';
  });

  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    searchClear.style.display = 'none';
    document.getElementById('search-count').textContent = '';
    searchInput.focus();
  });

  // ─── Back to top ──────────────────────────────────────────
  var backToTop = document.getElementById('back-to-top');

  window.addEventListener('scroll', function () {
    backToTop.hidden = window.scrollY < 300;
  }, { passive: true });

  backToTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (navigator.vibrate) navigator.vibrate(10);
  });

  // ─── Load data and render ─────────────────────────────────
  function loadJSON(url) {
    return fetch(url).then(function (r) { return r.json(); });
  }

  Promise.all([
    loadJSON('./data/meta.json'),
    loadJSON('./data/days.json'),
    loadJSON('./data/places.json'),
    loadJSON('./data/food.json'),
    loadJSON('./data/phrases.json'),
    loadJSON('./data/sos.json')
  ]).then(function (results) {
    DATA.meta = results[0];
    DATA.days = results[1];
    DATA.places = results[2];
    DATA.food = results[3];
    DATA.phrases = results[4];
    DATA.sos = results[5];

    updateHeaderSub();
    renderDays();
    renderFood();
    renderTransit();
    renderPhrases();
    renderSOS();
  }).catch(function (err) {
    console.error('Data load failed:', err);
    document.getElementById('header-sub').textContent = 'Offline — cached data';
  });

})();
