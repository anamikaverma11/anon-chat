// public/client.js
(() => {
  function uuid() {
    const c = (typeof window !== "undefined" && window.crypto && window.crypto.randomUUID)
      ? window.crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    const r = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return `${Date.now().toString(16)}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
  }

  const $ = (s) => document.querySelector(s);

  const messagesEl = $('#messages');
  const inputEl    = $('#messageInput');
  const sendBtn    = $('#sendBtn');
  const anonBanner = $('#anonBanner');

  const slug = location.pathname.replace(/^\/+/, '') || 'fun-friday';
  const socket = io();

  // fresh anonymous identity each reload
  const anonId   = 'anon-' + uuid();
  const anonName = 'Anonymous-' + anonId.slice(5, 11);
  anonBanner.innerHTML = `Now you’re appearing as <strong>${anonName}</strong>!`;

  let myUserId = null;

  // Keep reference to the latest optimistic bubble so we can "upgrade" it
  let lastPending = null;
  let sendLock = false;

  function renderMessage(m, opts = {}) {
    const mine = (m.user_id && myUserId && m.user_id === myUserId) || opts.mine;

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (mine ? 'me' : 'peer');

    if (!mine) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = m.is_anonymous ? 'Anonymous' : (m.user_name || 'User');
      wrap.appendChild(who);
    }

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = m.text;
    wrap.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const ts = document.createElement('span');
    ts.className = 'time';
    ts.textContent = new Date(m.created_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    meta.appendChild(ts);

    const ticks = document.createElement('span');
    ticks.className = 'ticks ' + (opts.pending ? 'single' : 'double');
    if (!mine) ticks.style.visibility = 'hidden';
    meta.appendChild(ticks);

    wrap.appendChild(meta);

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    return { bubble: wrap, ticksEl: ticks, timeEl: ts };
  }

  async function loadHistory() {
    try {
      const res  = await fetch(`/api/rooms/${encodeURIComponent(slug)}/messages?limit=60`);
      const rows = await res.json();
      messagesEl.innerHTML = '';
      rows.forEach(renderMessage);
    } catch (e) { console.error('history error', e); }
  }

  // Join as anonymous always
  socket.emit('join', {
    room: slug,
    user: { external_id: anonId, display_name: anonName },
    anonymous: true
  });

  socket.once('joined', ({ ok, user }) => {
    if (ok && user && user.id) myUserId = user.id;
    loadHistory();
  });

  // When server broadcasts a message back:
  socket.on('message', (m) => {
    const isMine = (m.user_id && myUserId && m.user_id === myUserId);
    if (isMine && lastPending) {
      // upgrade the optimistic bubble instead of adding a new one
      lastPending.ticksEl.className = 'ticks double';
      lastPending.timeEl.textContent = new Date(m.created_at)
        .toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      lastPending = null;
      return; // IMPORTANT: don't render a second bubble
    }
    renderMessage(m, { mine: isMine, pending: false });
  });

  socket.on('error', (e) => alert(e?.error || 'Socket error'));

  function send() {
    if (sendLock) return;            // debounce rapid clicks
    const text = (inputEl.value || '').trim();
    if (!text) return;

    sendLock = true;
    setTimeout(() => (sendLock = false), 250);

    // optimistic bubble (single tick)
    const optimistic = {
      id: 'tmp-' + uuid(),
      user_id: myUserId,                 // may still be null on very first message
      user_name: anonName,
      text,
      is_anonymous: true,
      created_at: new Date().toISOString()
    };
    lastPending = renderMessage(optimistic, { mine: true, pending: true });

    socket.emit('message', { text, isAnonymous: true });
    inputEl.value = '';
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
})();
