/* MYU public-site measurement. Never include this file in the client/health portal. */
(function () {
  'use strict';
  if (!['/', '/landing.html', '/book.html'].includes(location.pathname)) return;
  // Payment return URLs contain appointment identifiers; never instrument them.
  if (new URLSearchParams(location.search).has('rdv') || new URLSearchParams(location.search).has('paid')) return;
  const PIXEL = '1071187952558579';
  const KEY = 'myu_marketing_consent_v1';
  const MAX_AGE = 180 * 24 * 60 * 60 * 1000;
  let consent = null, initialized = false, pageSent = false;
  const sent = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && ['granted', 'denied'].includes(saved.value) && Date.now() - saved.at < MAX_AGE) consent = saved.value;
  } catch (_) {}
  function cleanTrackingUrl() {
    const url = new URL(location.href);
    for (const key of Array.from(url.searchParams.keys())) {
      const value = url.searchParams.get(key) || '';
      const allowed = key === 'fbclid' ? /^[A-Za-z0-9_-]{1,500}$/.test(value)
        : /^utm_(source|medium|campaign|content)$/.test(key) && /^[A-Za-z0-9_.-]{1,120}$/.test(value);
      if (!allowed) url.searchParams.delete(key);
    }
    url.hash = '';
    if (url.href !== location.href) history.replaceState(history.state, '', url.href);
  }
  function startPixel() {
    if (consent !== 'granted') return;
    cleanTrackingUrl();
    if (!initialized) {
      // Automatic matching and automatic form/button tracking are deliberately disabled.
      if (!window.fbq) {
        const fbq = window.fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
        window._fbq = fbq;
        fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
      }
      window.fbq('consent', 'grant');
      window.fbq('set', 'autoConfig', false, PIXEL);
      window.fbq('init', PIXEL);
      initialized = true;
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      document.head.appendChild(script);
    } else window.fbq('consent', 'grant');
    if (!pageSent) { window.fbq('trackSingle', PIXEL, 'PageView'); pageSent = true; }
  }
  function clearPixelCookies() {
    ['_fbp', '_fbc'].forEach(function (name) {
      const expired = name + '=; Max-Age=0; path=/; SameSite=Lax; Secure';
      document.cookie = expired;
      document.cookie = expired + '; domain=' + location.hostname;
      document.cookie = expired + '; domain=.' + location.hostname;
    });
  }
  function choose(value) {
    consent = value;
    try { localStorage.setItem(KEY, JSON.stringify({value: value, at: Date.now()})); } catch (_) {}
    if (value === 'granted') startPixel();
    else {
      if (window.fbq) window.fbq('consent', 'revoke');
      clearPixelCookies();
    }
    panel.hidden = true;
    preferences.focus({preventScroll: true});
  }
  function track(name, bookingId) {
    if (consent !== 'granted' || !initialized || !['Lead', 'InitiateCheckout'].includes(name) || !bookingId) return false;
    const key = name + ':' + bookingId;
    try { if (sessionStorage.getItem('myu_event:' + key)) return false; } catch (_) {}
    if (sent.has(key)) return false;
    sent.add(key);
    window.fbq('trackSingle', PIXEL, name);
    try { sessionStorage.setItem('myu_event:' + key, '1'); } catch (_) {}
    return true;
  }
  window.MYUTracking = Object.freeze({
    bookingCreated: function (id, hasCheckout) {
      const tracked = track('Lead', id);
      if (hasCheckout) track('InitiateCheckout', id);
      return tracked;
    }
  });
  const style = document.createElement('style');
  style.textContent = '#myu-cookie-panel[hidden]{display:none!important}#myu-cookie-panel{position:fixed;z-index:1000;left:12px;right:12px;bottom:12px;margin:auto;max-width:560px;max-height:75vh;overflow:auto;padding:20px;background:#fffaf6;color:#43291f;border:1px solid #bd8e73;border-radius:20px;box-shadow:0 10px 45px #43291f33;font:14px/1.5 Arial,sans-serif}#myu-cookie-panel h2{font:22px Georgia,serif;margin:0 0 8px}#myu-cookie-panel p{margin:0 0 14px}#myu-cookie-panel a{color:#644032;text-decoration:underline}#myu-cookie-panel .choices{display:flex;gap:10px}#myu-cookie-panel button{flex:1;width:auto;min-height:44px;padding:11px 14px;border:1px solid #704a38;background:#fffaf6;color:#43291f;font:700 14px Arial,sans-serif;border-radius:12px;cursor:pointer}#myu-cookie-panel button:focus-visible,#myu-cookie-preferences:focus-visible{outline:3px solid #b97c54;outline-offset:3px}#myu-cookie-preferences{display:block;width:auto;margin:20px auto 96px;padding:8px 12px;min-height:44px;border:1px solid #a9775d;border-radius:8px;background:#fffaf6;color:#644032;font:12px Arial,sans-serif;cursor:pointer}';
  document.head.appendChild(style);
  const panel = document.createElement('section');
  panel.id = 'myu-cookie-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Vos choix de confidentialité');
  panel.innerHTML = '<h2>Vos choix de confidentialité</h2><p>Avec votre accord, le pixel Meta mesure les visites et les demandes de rendez-vous pour évaluer nos publicités Facebook et Instagram. Vous pouvez réserver sans accepter. Votre choix peut être modifié à tout moment.</p><p><a href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noopener noreferrer">Politique de confidentialité de Meta</a></p><div class="choices"><button type="button" data-choice="denied">Refuser</button><button type="button" data-choice="granted">Accepter</button></div>';
  panel.hidden = consent !== null;
  panel.querySelectorAll('button').forEach(button => button.addEventListener('click', () => choose(button.dataset.choice)));
  document.body.appendChild(panel);
  const preferences = document.createElement('button');
  preferences.id = 'myu-cookie-preferences';
  preferences.type = 'button';
  preferences.textContent = 'Gérer mes cookies';
  preferences.addEventListener('click', function () {
    panel.hidden = false;
    panel.querySelector('button').focus();
  });
  document.body.appendChild(preferences);
  startPixel();
})();
