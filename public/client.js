'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const AVATARS = ['🙂','😎','🤠','👑','🦁','🐯','🐼','🦊','🤴','👸','😺','🐲'];

  const state = {
    token: null,
    userId: null,
    name: '',
    avatar: '🙂',
    seat: -1,
    balance: 0,
    cards: [],
    seenCards: false,
    packed: false,
    publicState: null,
    ws: null,
    connected: false,
    reconnectTimer: null,
    lastHello: null,
    timerRAF: null,
    lastTurnSeat: -1,
    warned: {}
  };

  // ---------- Token / persistence ----------
  function getToken() {
    let t = localStorage.getItem('tp_token');
    if (!t) {
      t = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('tp_token', t);
    }
    return t;
  }
  state.token = getToken();

  // ---------- Login UI ----------
  function buildAvatarChoices() {
    const wrap = $('#avatar-choices');
    wrap.innerHTML = '';
    AVATARS.forEach(a => {
      const b = document.createElement('button');
      b.textContent = a;
      if (a === state.avatar) b.classList.add('active');
      b.onclick = () => {
        state.avatar = a;
        $$('#avatar-choices button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
      wrap.appendChild(b);
    });
  }

  function initLogin() {
    const savedName = localStorage.getItem('tp_name') || '';
    const savedAvatar = localStorage.getItem('tp_avatar') || '🙂';
    $('#name-input').value = savedName;
    state.avatar = savedAvatar;
    buildAvatarChoices();

    $('#enter-btn').onclick = () => {
      const name = $('#name-input').value.trim() || ('Player' + Math.floor(Math.random()*9000+1000));
      state.name = name;
      localStorage.setItem('tp_name', name);
      localStorage.setItem('tp_avatar', state.avatar);
      Audio2.resume();
      connect();
      $('#login-screen').classList.add('hidden');
      $('#game-screen').classList.remove('hidden');
      if (Audio2.isMusicOn()) Audio2.startMusic();
      UI.toast('Connecting...');
    };
  }

  // ---------- WebSocket ----------
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) return;

    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      updateConnStatus(true);
      send('hello', {
        token: state.token,
        name: state.name,
        avatar: state.avatar
      });
      UI.toast('Connected');
      startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      state.connected = false;
      updateConnStatus(false);
      UI.toast('Disconnected. Reconnecting...', 'error');
      scheduleReconnect();
    };

    ws.onerror = () => {
      UI.toast('Connection error', 'error');
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, 1800);
  }

  let hbTimer = null;
  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        send('action', { action: 'ping' });
      }
    }, 15000);
  }

  function send(type, payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try { state.ws.send(JSON.stringify({ type, payload })); } catch (e) {}
    }
  }

  function sendAction(action, payload) {
    send('action', { action, ...(payload || {}) });
  }

  // ---------- Message handling ----------
  function handleMessage(msg) {
    const { type, payload } = msg || {};
    switch (type) {
      case 'hello_ok':
        state.userId = payload.userId;
        state.name = payload.name;
        state.avatar = payload.avatar;
        state.balance = payload.balance;
        state.seat = payload.seat;
        updateMyProfile();
        break;

      case 'state':
        handleState(payload);
        break;

      case 'deal':
        Audio2.play('deal');
        animateDeal(payload);
        break;

      case 'shuffle':
        Audio2.play('shuffle');
        shuffleDeckAnim();
        break;

      case 'private_card':
        // Cards are already in state via `you.cards`
        break;

      case 'see_cards':
        state.seenCards = true;
        state.cards = payload.cards;
        Audio2.play('flip');
        renderMyCards();
        break;

      case 'turn':
        break;

      case 'chips':
        Audio2.play('chip');
        flyChipsToPot(payload.seat);
        break;

      case 'sfx':
        if (payload && payload.sound) Audio2.play(payload.sound);
        break;

      case 'chat':
        appendChat(payload);
        break;

      case 'emoji': {
        const seatEl = document.querySelector(`.seat[data-seat="${payload.seat}"]`);
        if (seatEl) UI.flyEmoji(seatEl, payload.emoji);
        break;
      }

      case 'player_joined':
        UI.toast(`${payload.name} joined the table`);
        Audio2.play('join');
        break;

      case 'player_left':
      case 'player_disconnected':
        UI.toast(`${payload.name} left the table`);
        Audio2.play('leave');
        break;

      case 'profile_updated':
        break;

      case 'side_show_request':
        showSideShowRequest(payload);
        break;

      case 'side_show_resolved':
        hideSideShowModal();
        if (payload.accepted) UI.toast('Side Show resolved');
        else UI.toast('Side Show declined');
        break;

      case 'showdown':
        handleShowdown(payload);
        break;

      case 'error':
        handleError(payload);
        break;

      case 'profile':
        fillProfilePanel(payload);
        break;

      case 'history':
        fillHistory(payload.items);
        break;

      case 'ranking':
        fillRanking(payload.items);
        break;

      case 'left_table':
        UI.toast('You left the table');
        state.seat = -1;
        state.cards = [];
        break;

      case 'log_history':
        break;
    }
  }

  function handleError(payload) {
    Audio2.play('error');
    const map = {
      not_your_turn: 'Not your turn',
      packed: 'You are packed',
      insufficient: 'Not enough balance',
      sideshow_unavailable: 'Side Show unavailable',
      table_full: 'Table is full',
      show_unavailable: 'Show unavailable',
      not_authenticated: 'Not authenticated'
    };
    UI.toast(map[payload?.code] || 'Invalid action', 'error');
  }

  // ---------- Public state rendering ----------
  function handleState(s) {
    const prev = state.publicState;
    state.publicState = s;

    // MY info
    if (s.you) {
      state.seat = s.you.seat;
      state.balance = s.you.balance;
      state.cards = s.you.cards || [];
      state.seenCards = !!s.you.seenCards;
      state.packed = !!s.you.packed;
    }

    // Phase
    const phaseNames = {
      waiting: 'Waiting for players',
      starting: 'Starting...',
      dealing: 'Dealing cards...',
      playing: 'Place your bets',
      showdown: 'Showdown',
      finished: 'Round finished'
    };
    $('#phase-label').textContent = phaseNames[s.phase] || s.phase;

    // Pot
    $('#pot-amount').textContent = s.pot || 0;

    // Deck count
    $('#deck-count-badge').textContent = s.deckCount ?? 0;

    // Stake labels
    const isSeen = state.seenCards;
    const base = s.currentStake || 100;
    $('#chaal-amt').textContent = isSeen ? base * 2 : base;
    $('#chaal2x-amt').textContent = isSeen ? base * 4 : base * 2;

    // Render seats
    renderSeats(s);

    // My profile bar
    updateMyProfile();

    // My cards
    renderMyCards();

    // Turn banner
    const yourTurn = s.phase === 'playing' && s.turnSeat === state.seat && !state.packed;
    if (yourTurn && state.lastTurnSeat !== state.seat) {
      Audio2.play('yourturn');
      flashTurnBanner();
    }
    state.lastTurnSeat = s.turnSeat;
    $('#turn-banner').classList.toggle('hidden', !yourTurn);

    // Buttons enabled only on your turn
    const canAct = yourTurn;
    $$('#action-bar .action-btn').forEach(b => {
      b.disabled = !canAct;
      b.classList.toggle('pulse', canAct);
    });

    // Start timer RAF
    if (s.phase === 'playing') startTimerTick();
    else stopTimerTick();

    // Side show request UI
    if (s.sideShowRequest && s.sideShowRequest.toSeat === state.seat) {
      showSideShowRequest(s.sideShowRequest);
    } else if (!s.sideShowRequest) {
      hideSideShowModal();
    }

    // Result banner
    if (s.winner && (s.phase === 'finished' || s.phase === 'showdown')) {
      showResultBanner(s.winner);
    } else {
      hideResultBanner();
    }
  }

  function renderSeats(s) {
    const wrap = $('#seats');
    const existing = {};
    wrap.querySelectorAll('.seat').forEach(el => {
      existing[el.dataset.seat] = el;
    });

    const seats = s.players || [];
    const usedSeats = new Set();

    for (const p of seats) {
      usedSeats.add(p.seat);
      let el = existing[p.seat];
      if (!el) {
        el = document.createElement('div');
        el.className = 'seat';
        el.dataset.seat = p.seat;
        el.innerHTML = `
          <div class="seat-cards"></div>
          <div class="seat-profile">
            <div class="seat-avatar"></div>
            <div class="seat-info">
              <div class="seat-name"></div>
              <div class="seat-meta">
                <span class="seat-online-dot"></span>
                <span class="seat-balance"></span>
                <span class="seat-vip"></span>
              </div>
            </div>
          </div>
        `;
        wrap.appendChild(el);
      }

      const isYou = p.seat === state.seat;
      const isTurn = s.turnSeat === p.seat && s.phase === 'playing';
      const profile = el.querySelector('.seat-profile');
      profile.classList.toggle('active', isTurn);
      profile.classList.toggle('packed', !!p.packed);
      profile.classList.toggle('disconnected', !p.connected);
      el.querySelector('.seat-avatar').textContent = p.avatar || '🙂';
      el.querySelector('.seat-name').textContent = (isYou ? '⭐ ' : '') + p.name;
      el.querySelector('.seat-balance').textContent = '🪙 ' + (p.balance || 0);
      el.querySelector('.seat-vip').textContent = p.level >= 3 ? '👑' : '';
      el.querySelector('.seat-online-dot').classList.toggle('off', !p.connected);

      // Cards
      const cardsWrap = el.querySelector('.seat-cards');
      renderSeatCards(cardsWrap, p.cards, isYou);
    }

    // Remove stale seats
    Object.keys(existing).forEach(seatKey => {
      if (!usedSeats.has(Number(seatKey))) existing[seatKey].remove();
    });
  }

  function renderSeatCards(wrap, cards, isYou) {
    // Determine desired card count
    const desired = cards ? cards.length : 0;
    const existing = wrap.querySelectorAll('.mini-card');
    if (existing.length === desired) {
      // Update faces
      cards.forEach((c, i) => {
        const el = existing[i];
        updateCardFace(el, c);
      });
      return;
    }
    wrap.innerHTML = '';
    if (!cards) return;
    cards.forEach((c, i) => {
      const el = Cards.createCardEl(c, { dealt: true });
      wrap.appendChild(el);
    });
  }

  function updateCardFace(el, card) {
    const front = el.querySelector('.front');
    if (!front) return;
    if (!card || card.hidden) {
      el.classList.add('hidden-face');
    } else {
      el.classList.remove('hidden-face');
      front.classList.remove('red', 'black');
      front.classList.add(Cards.RED.has(card.suit) ? 'red' : 'black');
      front.innerHTML = `<div class="r">${card.rank}</div><div class="s">${card.suit}</div>`;
      // flip sound
    }
  }

  // ---------- My cards in bottom bar ----------
  function renderMyCards() {
    const wrap = $('#my-cards-inline');
    wrap.innerHTML = '';
    if (!state.cards || !state.cards.length) return;
    state.cards.forEach(c => {
      const hidden = !state.seenCards;
      const el = Cards.createCardEl(hidden ? { hidden: true } : c);
      el.style.width = '34px';
      el.style.height = '50px';
      wrap.appendChild(el);
    });
  }

  function updateMyProfile() {
    $('#my-avatar').textContent = state.avatar;
    $('#my-name').textContent = state.name;
    $('#my-balance').textContent = state.balance;
  }

  // ---------- Animations ----------
  function animateDeal(payload) {
    const seatEl = document.querySelector(`.seat[data-seat="${payload.seat}"] .seat-cards`);
    const deck = $('#deck-area');
    if (!seatEl || !deck) return;
    // create temp card flying
    const layer = $('#fx-layer');
    const r1 = deck.getBoundingClientRect();
    const r2 = seatEl.getBoundingClientRect();
    const tmp = document.createElement('div');
    tmp.className = 'mini-card';
    tmp.style.position = 'absolute';
    tmp.style.left = (r1.left + r1.width/2 - 23) + 'px';
    tmp.style.top = (r1.top + r1.height/2 - 34) + 'px';
    tmp.style.zIndex = 40;
    tmp.innerHTML = '<div class="face back"></div><div class="face front"></div>';
    layer.appendChild(tmp);
    requestAnimationFrame(() => {
      const dx = (r2.left + r2.width/2) - (r1.left + r1.width/2);
      const dy = (r2.top + r2.height/2) - (r1.top + r1.height/2);
      tmp.style.transition = 'transform 0.42s cubic-bezier(0.2,0.9,0.3,1.2)';
      tmp.style.transform = `translate(${dx}px, ${dy}px) scale(0.85)`;
    });
    setTimeout(() => { tmp.remove(); Audio2.play('deal'); }, 450);
  }

  function flyChipsToPot(seat) {
    const seatEl = document.querySelector(`.seat[data-seat="${seat}"]`);
    const pot = $('#pot-box');
    if (seatEl && pot) UI.chipFly(seatEl, pot);
  }

  function shuffleDeckAnim() {
    const deck = $('#deck-area');
    if (!deck) return;
    deck.animate([
      { transform: 'translateX(-50%) rotate(0deg)' },
      { transform: 'translateX(-50%) rotate(6deg)' },
      { transform: 'translateX(-50%) rotate(-6deg)' },
      { transform: 'translateX(-50%) rotate(0deg)' }
    ], { duration: 500, iterations: 2 });
  }

  function flashTurnBanner() {
    const banner = $('#turn-banner');
    banner.classList.remove('hidden');
    banner.animate([
      { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.15)', opacity: 1, offset: 0.6 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }
    ], { duration: 600 });
  }

  // ---------- Timer ----------
  function startTimerTick() {
    if (state.timerRAF) return;
    const tick = () => {
      const s = state.publicState;
      if (!s || s.phase !== 'playing' || !s.turnDeadline) {
        state.timerRAF = null; return;
      }
      const remaining = Math.max(0, Math.ceil((s.turnDeadline - (Date.now() + (s.serverNow ? 0 : 0))) / 1000));
      // Better: use server-side offset
      const serverOffset = s.serverNow ? (Date.now() - s.serverNow) : 0;
      const rem = Math.max(0, Math.ceil((s.turnDeadline - (Date.now() - serverOffset)) / 1000));
      $('#turn-timer').textContent = rem;
      const yourTurn = s.turnSeat === state.seat && !state.packed;
      if (yourTurn && rem <= 5 && rem > 0 && !state.warned[rem]) {
        state.warned[rem] = true;
        Audio2.play('warning');
      }
      state.timerRAF = requestAnimationFrame(tick);
    };
    state.timerRAF = requestAnimationFrame(tick);
  }
  function stopTimerTick() {
    if (state.timerRAF) { cancelAnimationFrame(state.timerRAF); state.timerRAF = null; }
  }

  // ---------- Result banner ----------
  function showResultBanner(winner) {
    const b = $('#result-banner');
    const isMe = winner.seats && winner.seats.includes(state.seat);
    b.innerHTML = `
      <div class="rb-title">${isMe ? '🎉 YOU WIN!' : 'WINNER'}</div>
      <div class="rb-name">${winner.names || ''}</div>
      <div class="rb-hand">${winner.handName || ''}</div>
      <div class="rb-pot">🪙 ${winner.pot}${winner.potShare ? ' → ' + winner.potShare : ''}</div>
    `;
    b.classList.remove('hidden');
  }
  function hideResultBanner() {
    $('#result-banner').classList.add('hidden');
  }

  function handleShowdown(payload) {
    Audio2.play('show');
    // Reveal is applied via state; just make sure UI shows categories
    if (payload && payload.results) {
      for (const r of payload.results) {
        const el = document.querySelector(`.seat[data-seat="${r.seat}"] .seat-cards`);
        if (!el) continue;
        const cards = el.querySelectorAll('.mini-card');
        r.cards.forEach((c, i) => {
          if (cards[i]) updateCardFace(cards[i], c);
        });
      }
    }
  }

  // ---------- Side show ----------
  function showSideShowRequest(req) {
    if (!req) return;
    if (req.toSeat === state.seat) {
      $('#sideshow-modal').classList.remove('hidden');
      $('#ss-text').textContent = `${req.fromName || 'Player'} wants a Side Show`;
    } else if (req.fromSeat === state.seat) {
      UI.toast(`Waiting for ${req.toName || 'opponent'} to respond...`);
    }
  }
  function hideSideShowModal() {
    $('#sideshow-modal').classList.add('hidden');
  }

  // ---------- Chat ----------
  function appendChat(msg) {
    const list = $('#chat-list');
    if (!list) return;
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="who">${escapeHtml(msg.name)}</span>: ${escapeHtml(msg.text)}`;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    while (list.children.length > 200) list.removeChild(list.firstChild);
  }

  function escapeHtml(s) {
    return String(s).replace(/[<>&"']/g, c => ({
      '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ---------- Profile/history/ranking ----------
  function fillProfilePanel(p) {
    $('#p-avatar').textContent = p.avatar;
    $('#p-name').textContent = p.name;
    $('#p-level').textContent = p.level;
    $('#p-balance').textContent = p.balance;
    $('#p-games').textContent = p.gamesPlayed;
    $('#p-wins').textContent = p.wins;
    $('#p-winrate').textContent = p.winRate + '%';
    $('#edit-name').value = p.name;
    $('#edit-avatar').value = p.avatar;
  }

  function fillHistory(items) {
    const ul = $('#history-list');
    ul.innerHTML = '';
    if (!items || !items.length) {
      ul.innerHTML = '<li>No games yet</li>';
      return;
    }
    for (const h of items) {
      const li = document.createElement('li');
      const when = new Date(h.created_at).toLocaleTimeString();
      li.innerHTML = `<span class="who">${escapeHtml(h.winner_name)}</span> won ${h.pot} (${escapeHtml(h.winning_hand)}) <span class="when">${when}</span>`;
      ul.appendChild(li);
    }
  }

  function fillRanking(items) {
    const ul = $('#ranking-list');
    ul.innerHTML = '';
    if (!items || !items.length) {
      ul.innerHTML = '<li>No rankings yet</li>';
      return;
    }
    items.forEach((p, i) => {
      const li = document.createElement('li');
      li.innerHTML = `#${i+1} ${p.avatar} <span class="who">${escapeHtml(p.name)}</span> — 🏆 ${p.wins} wins, 🪙 ${p.balance}`;
      ul.appendChild(li);
    });
  }

  // ---------- Panel ----------
  function openPanel(tab) {
    $('#side-panel').classList.remove('hidden');
    if (tab) activateTab(tab);
  }
  function closePanel() {
    $('#side-panel').classList.add('hidden');
  }
  function activateTab(name) {
    $$('.ptab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.ptab-content').forEach(c => c.classList.toggle('hidden', c.dataset.tab !== name));
    if (name === 'profile') send('get_profile');
    if (name === 'history') send('get_history');
    if (name === 'ranking') send('get_ranking');
  }

  function updateConnStatus(ok) {
    const el = $('#conn-status');
    if (!el) return;
    el.textContent = ok ? 'Connected' : 'Reconnecting...';
    el.className = ok ? 'conn-ok' : 'conn-bad';
  }

  // ---------- Wire up UI ----------
  function bindUI() {
    // Action buttons
    $$('#action-bar .action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Audio2.resume();
        Audio2.play('click');
        sendAction(btn.dataset.action);
      });
    });

    // Quick bar
    $$('#quick-bar .quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        Audio2.resume(); Audio2.play('click');
        if (btn.dataset.quick === 'see') {
          sendAction('see_cards');
        } else if (btn.dataset.quick) {
          sendAction('chat', { text: btn.dataset.quick });
        } else if (btn.dataset.emoji) {
          sendAction('emoji', { emoji: btn.dataset.emoji });
        }
      });
    });

    // Side show modal
    $('#ss-accept').onclick = () => {
      Audio2.play('click');
      sendAction('side_show_response', { accept: true });
      hideSideShowModal();
    };
    $('#ss-reject').onclick = () => {
      Audio2.play('click');
      sendAction('side_show_response', { accept: false });
      hideSideShowModal();
    };

    // Profile / menu
    $('#profile-btn').onclick = () => { Audio2.play('click'); openPanel('profile'); };
    $('#menu-btn').onclick = () => { Audio2.play('click'); openPanel('settings'); };
    $('#panel-close').onclick = () => { Audio2.play('click'); closePanel(); };

    $$('.ptab').forEach(t => {
      t.onclick = () => { Audio2.play('click'); activateTab(t.dataset.tab); };
    });

    // Chat
    $('#chat-send').onclick = () => {
      const text = $('#chat-input').value.trim();
      if (!text) return;
      sendAction('chat', { text });
      $('#chat-input').value = '';
    };
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#chat-send').click();
    });
    $$('.chat-quick button').forEach(b => {
      b.onclick = () => {
        sendAction('chat', { text: b.dataset.quickMsg });
      };
    });

    // Save profile
    $('#save-profile').onclick = () => {
      const name = $('#edit-name').value.trim();
      const avatar = $('#edit-avatar').value.trim() || '🙂';
      if (!name) { UI.toast('Name required', 'error'); return; }
      state.name = name; state.avatar = avatar;
      localStorage.setItem('tp_name', name);
      localStorage.setItem('tp_avatar', avatar);
      sendAction('set_profile', { name, avatar });
      UI.toast('Profile saved');
      updateMyProfile();
    };

    // Leave table
    $('#leave-table-btn').onclick = () => {
      if (!confirm('Leave the table?')) return;
      sendAction('leave_table');
      state.seat = -1;
      state.cards = [];
      closePanel();
    };

    // Settings toggles
    const soundBtn = $('#toggle-sound');
    const musicBtn = $('#toggle-music');
    function syncToggles() {
      soundBtn.classList.toggle('on', Audio2.isSoundOn());
      soundBtn.textContent = Audio2.isSoundOn() ? 'ON' : 'OFF';
      musicBtn.classList.toggle('on', Audio2.isMusicOn());
      musicBtn.textContent = Audio2.isMusicOn() ? 'ON' : 'OFF';
    }
    syncToggles();
    soundBtn.onclick = () => { Audio2.setSound(!Audio2.isSoundOn()); syncToggles(); };
    musicBtn.onclick = () => {
      Audio2.setMusic(!Audio2.isMusicOn());
      syncToggles();
    };

    // Invite
    $('#invite-btn').onclick = () => {
      const url = location.origin;
      if (navigator.share) {
        navigator.share({ title: 'Royal Teen Patti', text: 'Join my table!', url }).catch(() => {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => UI.toast('Link copied!'));
      } else {
        UI.toast(url);
      }
    };

    // Init audio on first interaction
    const initAudio = () => {
      Audio2.resume();
      if (Audio2.isMusicOn()) Audio2.startMusic();
      document.removeEventListener('touchstart', initAudio);
      document.removeEventListener('click', initAudio);
    };
    document.addEventListener('touchstart', initAudio, { once: true });
    document.addEventListener('click', initAudio, { once: true });
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    initLogin();
    bindUI();
    // Auto login if name saved? Skip; always show login for clarity.
    window.addEventListener('beforeunload', () => {
      try { state.ws && state.ws.close(); } catch (e) {}
    });
  });

  // Prevent context menu long press on cards
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.mini-card')) e.preventDefault();
  });
})();
