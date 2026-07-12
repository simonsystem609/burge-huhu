/* Shared "Install App" button wiring for both game menus (card game + Ur).
 * Chrome/Edge/Android fire `beforeinstallprompt`; that event is captured and
 * replayed on click, showing the browser's own native install dialog — the
 * safest, most foolproof path since the browser itself asks for consent.
 * iOS Safari never fires that event (Apple doesn't support it), so there a
 * click instead explains the manual Share -> Add to Home Screen steps.
 * Already-installed (running standalone) hides the button — nothing to
 * install. Browser global: none — just wires up any [data-install-app]
 * button found on the page. */
(function () {
  'use strict';

  const HINTS = {
    hu: {
      ios: 'iPhone/iPad: koppints a Megosztás gombra (⬆️), majd válaszd: "Kezdőképernyőhöz adás".',
      fallback: 'Keresd a böngésző menujében (⌘) az "Alkalmazás telepítése" lehetőséget.',
    },
    en: {
      ios: 'On iPhone/iPad: tap the Share icon, then "Add to Home Screen".',
      fallback: 'Look for "Install app" in your browser’s menu or address bar.',
    },
  };

  function lang() {
    const l = (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return HINTS[l] ? l : 'en';
  }

  let deferredPrompt = null;
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream;

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 5000);
  }

  function buttons() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-install-app]'));
  }
  function setVisible(v) {
    buttons().forEach(function (b) {
      b.style.display = v ? '' : 'none';
    });
  }

  function init() {
    setVisible(!isStandalone);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone) setVisible(true);
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    setVisible(false);
  });

  document.addEventListener('click', function (e) {
    const btn = e.target.closest && e.target.closest('[data-install-app]');
    if (!btn) return;
    if (deferredPrompt) {
      const dp = deferredPrompt;
      deferredPrompt = null; // the prompt event is one-shot per spec
      dp.prompt();
      return;
    }
    const h = HINTS[lang()];
    toast(isIOS ? h.ios : h.fallback);
  });
})();
