/* NGWorship optional live announcements (v2-v4 backport).
   The songbook never waits for this module or announcements.json. */
(function () {
  'use strict';
  const INTERVAL_MS = 5 * 60 * 1000;
  const TIMEOUT_MS = 5000;
  const SEEN_KEY = 'ngw_seen_announcements';
  const sessionShown = new Set();
  const dismissed = new Set();
  let entries = [];
  let lastAttemptAt = 0;
  let pendingRequest = false;
  let timer = null;
  let banner = null;

  function labels() {
    const lang = document.documentElement.lang || 'mn';
    if (lang === 'kr' || lang === 'ko') return { heading: '공지', close: '공지 닫기', done: '확인' };
    if (lang.startsWith('mn')) return { heading: 'Мэдээлэл', close: 'Мэдээллийг хаах', done: 'Болсон' };
    return { heading: 'Announcements', close: 'Dismiss announcement', done: 'Done' };
  }

  function seenSet() {
    try {
      const list = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
      return new Set(Array.isArray(list) ? list.filter(id => typeof id === 'string') : []);
    } catch (_) { return new Set(); }
  }

  function markDisplayed(item, seen) {
    sessionShown.add(item.id);
    if (item.mode === 'once' && !seen.has(item.id)) {
      seen.add(item.id);
      try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch (_) { /* local only */ }
    }
  }

  function validItems() {
    const now = Date.now();
    const unique = new Set();
    const seen = seenSet();
    const result = [];
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() ||
          typeof item.text !== 'string' || !item.text.trim() ||
          !['once', 'every-open'].includes(item.mode) ||
          (item.display && !['dialog', 'banner'].includes(item.display)) || unique.has(item.id)) continue;
      unique.add(item.id);
      if (dismissed.has(item.id)) continue;
      if (item.startsAt && (!Number.isFinite(Date.parse(item.startsAt)) || now < Date.parse(item.startsAt))) continue;
      if (item.endsAt && (!Number.isFinite(Date.parse(item.endsAt)) || now >= Date.parse(item.endsAt))) continue;
      if (item.mode === 'once' && seen.has(item.id) && !sessionShown.has(item.id)) continue;
      result.push(item);
    }
    return { items: result, seen };
  }

  function buildContent(item) {
    const wrap = document.createElement('div');
    if (typeof item.title === 'string' && item.title.trim()) {
      const heading = document.createElement('h2');
      heading.textContent = item.title;
      wrap.appendChild(heading);
    }
    const paragraph = document.createElement('p');
    paragraph.textContent = item.text;
    wrap.appendChild(paragraph);
    return wrap;
  }

  function refreshBanner(items, seen) {
    const nav = document.getElementById('bottom-nav');
    if (!banner || !nav) return;
    const shouldShow = !nav.hidden && !document.hidden;
    const messages = shouldShow ? items.filter(item => item.display === 'banner') : [];
    // Do not steal focus or rebuild the banner when a periodic check finds no change.
    const signature = messages.map(x => JSON.stringify([x.id, x.title, x.text])).join('|');
    if (banner.dataset.signature !== signature) {
      banner.replaceChildren();
      banner.dataset.signature = signature;
      for (const item of messages) {
        const article = document.createElement('article');
        article.className = 'ngw-announcement';
        article.appendChild(buildContent(item));
        const dismiss = document.createElement('button');
        dismiss.className = 'ngw-announcement-dismiss';
        dismiss.type = 'button';
        dismiss.textContent = '×';
        dismiss.setAttribute('aria-label', labels().close);
        dismiss.addEventListener('click', () => { dismissed.add(item.id); render(); });
        article.appendChild(dismiss);
        banner.appendChild(article);
        markDisplayed(item, seen);
      }
    }
    banner.hidden = messages.length === 0;
    // The content must remain scrollable above a visible banner, not behind it.
    document.documentElement.style.setProperty('--ngw-announcement-space',
      banner.hidden ? '0px' : (Math.ceil(banner.getBoundingClientRect().height) + 4) + 'px');
  }

  function openDialog(items, seen) {
    if (!items.length || document.hidden ||
        document.getElementById('splash-screen') ||
        !document.getElementById('page-songs') ||
        document.getElementById('page-songs').hidden) return;
    const modal = document.getElementById('modal-overlay');
    if (!modal || !modal.hidden || typeof openModal !== 'function') return;
    const body = document.createElement('div');
    body.className = 'ngw-announcement-messages';
    items.forEach((item) => {
      body.appendChild(buildContent(item));
      markDisplayed(item, seen);
    });
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn-primary';
    done.textContent = typeof t === 'function' && t('doneBtn') !== 'doneBtn' ? t('doneBtn') : labels().done;
    done.addEventListener('click', () => closeModal());
    actions.appendChild(done); body.appendChild(actions);
    openModal(labels().heading, body);
  }

  function render() {
    if (!document.getElementById('bottom-nav')) return;
    const { items, seen } = validItems();
    refreshBanner(items, seen);
    // A dialog can only open after the launch splash, on Songbook, and with
    // no other modal active. Already shown IDs never reopen in this session.
    openDialog(items.filter(item => item.display !== 'banner' && !sessionShown.has(item.id)), seen);
  }

  async function check(force = false) {
    if (document.hidden || pendingRequest) return;
    if (!force && Date.now() - lastAttemptAt < INTERVAL_MS) return;
    pendingRequest = true;
    lastAttemptAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch('announcements.json', { cache: 'no-store', signal: controller.signal });
      const next = response.ok ? await response.json() : [];
      entries = Array.isArray(next) ? next : [];
    } catch (_) {
      // No cached fallback: never show obsolete maintenance notices offline.
      entries = [];
    } finally {
      clearTimeout(timeout);
      pendingRequest = false;
      render();
    }
  }

  function start() {
    banner = document.createElement('section');
    banner.id = 'ngw-announcements';
    banner.className = 'ngw-announcements';
    banner.setAttribute('aria-label', labels().heading);
    banner.setAttribute('aria-live', 'polite');
    banner.hidden = true;
    document.body.appendChild(banner);

    const observer = new MutationObserver(render);
    for (const id of ['bottom-nav', 'page-songs', 'modal-overlay']) {
      const node = document.getElementById(id);
      if (node) observer.observe(node, { attributes: true, attributeFilter: ['hidden'] });
    }
    // The splash is removed from body after the initial fade.
    observer.observe(document.body, { childList: true });
    window.addEventListener('resize', render, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { check(); render(); }
      else refreshBanner([], seenSet());
    });
    window.addEventListener('focus', () => { if (!document.hidden) check(); });
    window.addEventListener('online', () => { if (!document.hidden) check(true); });
    timer = setInterval(() => check(), INTERVAL_MS);
    check(true); // fire-and-forget; the songbook startup never awaits this.
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.NGWAnnouncements = { check, render };
})();
