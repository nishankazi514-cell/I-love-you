'use strict';

(function () {
  const toastLayer = () => document.getElementById('toast-layer');

  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' err' : '');
    el.textContent = text;
    toastLayer().appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  // Fly a chip from (x1,y1) -> (x2,y2)
  function chipFly(fromEl, toEl) {
    const layer = document.getElementById('fx-layer');
    if (!layer || !fromEl || !toEl) return;
    const r1 = fromEl.getBoundingClientRect();
    const r2 = toEl.getBoundingClientRect();
    const chip = document.createElement('div');
    chip.className = 'fx-chip';
    chip.style.left = (r1.left + r1.width / 2 - 11) + 'px';
    chip.style.top = (r1.top + r1.height / 2 - 11) + 'px';
    layer.appendChild(chip);
    requestAnimationFrame(() => {
      const dx = (r2.left + r2.width / 2) - (r1.left + r1.width / 2);
      const dy = (r2.top + r2.height / 2) - (r1.top + r1.height / 2);
      chip.style.transform = `translate(${dx}px, ${dy}px) scale(0.6)`;
      chip.style.opacity = '0.3';
    });
    setTimeout(() => chip.remove(), 720);
  }

  function flyEmoji(fromEl, emoji) {
    const layer = document.getElementById('fx-layer');
    if (!layer || !fromEl) return;
    const r = fromEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'fx-emoji';
    el.textContent = emoji;
    el.style.left = (r.left + r.width / 2 - 14) + 'px';
    el.style.top = (r.top - 10) + 'px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  window.UI = { toast, chipFly, flyEmoji };
})();
