(function () {
  'use strict';

  // ─── Service Worker registration ──────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js');
  }

  // ─── Header subtitle (trip countdown / current day) ───────
  function updateHeaderSub() {
    const sub = document.getElementById('header-sub');
    if (!sub) return;
    fetch('./data/meta.json')
      .then(r => r.json())
      .then(meta => {
        const now = new Date();
        const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const start = new Date(meta.start_date + 'T00:00:00');
        const end = new Date(meta.end_date + 'T23:59:59');
        const today = new Date(jst.getFullYear(), jst.getMonth(), jst.getDate());

        if (today < start) {
          const diff = Math.ceil((start - today) / 86400000);
          sub.textContent = diff + ' day' + (diff !== 1 ? 's' : '') + ' until departure';
        } else if (today <= end) {
          const dayNum = Math.floor((today - start) / 86400000) + 1;
          const city = meta.cities.find(c => c.days.includes(dayNum));
          sub.textContent = 'Day ' + dayNum + ' of ' + meta.total_days +
            (city ? ' — ' + city.name : '');
        } else {
          sub.textContent = meta.route_summary;
        }
      })
      .catch(() => { sub.textContent = 'Offline — cached data'; });
  }
  updateHeaderSub();

  // ─── Theme toggle (dark ↔ OLED) ───────────────────────────
  var themeBtn = document.getElementById('theme-toggle');
  var MODES = ['dark', 'oled'];
  var ICONS = { dark: '◐', oled: '⬛' };
  var LABELS = { dark: 'Dark theme', oled: 'OLED theme' };

  function applyTheme(mode) {
    document.body.classList.remove('oled-mode');
    if (mode === 'oled') document.body.classList.add('oled-mode');
    themeBtn.textContent = ICONS[mode];
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

})();
