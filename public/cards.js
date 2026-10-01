'use strict';

(function () {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RED = new Set(['♥', '♦']);

  function createCardEl(card, opts = {}) {
    const el = document.createElement('div');
    el.className = 'mini-card' + (opts.dealt ? ' dealt' : '');
    if (!card || card.hidden) {
      el.classList.add('hidden-face');
    }

    const face = document.createElement('div');
    face.className = 'face front';
    if (card && !card.hidden) {
      face.classList.add(RED.has(card.suit) ? 'red' : 'black');
      face.innerHTML = `<div class="r">${card.rank}</div><div class="s">${card.suit}</div>`;
    } else {
      // hidden — but front still exists for flip animation
      face.innerHTML = `<div class="r">?</div><div class="s">🂠</div>`;
    }

    const back = document.createElement('div');
    back.className = 'face back';

    el.appendChild(face);
    el.appendChild(back);
    return el;
  }

  function cardLabel(card) {
    if (!card || card.hidden) return '?';
    return card.rank + card.suit;
  }

  window.Cards = { createCardEl, cardLabel, RED };
})();
