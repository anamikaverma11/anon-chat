// server.js (CommonJS) — with login/register endpoints + anonymous users
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ======== DB POOL ========
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ======== HELPERS ========
async function ensureRoom(roomName) {
  const [rows] = await pool.query('SELECT id FROM rooms WHERE name = ? LIMIT 1', [roomName]);
  if (rows.length) return rows[0].id;
  const [res] = await pool.query('INSERT INTO rooms (name) VALUES (?)', [roomName]);
  return res.insertId;
}

async function getUserByEmail(email) {
  if (!email) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  return rows[0] || null;
}

async function getUserByExternalId(externalId) {
  if (!externalId) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE external_id = ? LIMIT 1', [externalId]);
  return rows[0] || null;
}

async function createUser({ external_id, display_name, avatar_url, email, password_hash, username, full_name, phone }) {
  const [res] = await pool.query(
    `INSERT INTO users (external_id, display_name, avatar_url, email, password_hash, username, full_name, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [external_id || null, display_name || null, avatar_url || null, email || null, password_hash || null, username || null, full_name || null, phone || null]
  );
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [res.insertId]);
  return rows[0];
}

async function updateUserPassword(userId, password_hash) {
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, userId]);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    external_id: u.external_id,
    display_name: u.display_name,
    avatar_url: u.avatar_url || null,
    email: u.email || null,
    username: u.username || null,
    full_name: u.full_name || null,
    phone: u.phone || null,
  };
}

// ======== REST: FETCH MESSAGES ========
app.get('/api/rooms/:room/messages', async (req, res) => {
  const room = req.params.room;
  try {
    const roomId = await ensureRoom(room);
    const limit = Number(req.query.limit || 50);
    const [rows] = await pool.query(
      `SELECT m.id, m.text, m.is_anonymous, m.created_at,
              COALESCE(u.display_name, 'User') AS user_name,
              u.avatar_url, m.user_id
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ?
       ORDER BY m.created_at ASC
       LIMIT ?`,
      [roomId, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ======== AUTH ENDPOINTS (OPTIONAL; adapt to your users table) ========

// POST /api/register  -> {email?, username?, full_name?, phone?, password?}
app.post('/api/register', async (req, res) => {
  try {
    const { email, username, full_name, phone, password, display_name, avatar_url } = req.body || {};
    const exists = email ? await getUserByEmail(email) : null;
    if (exists && exists.password_hash) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const pwdHash = password ? await bcrypt.hash(String(password), 10) : null;
    let user;

    if (exists) {
      // If user row exists without password (or you allow update), set/upgrade password & fields
      const dn = display_name || full_name || username || email || 'User';
      await pool.query(
        `UPDATE users SET display_name = COALESCE(?, display_name),
                          avatar_url = COALESCE(?, avatar_url),
                          username = COALESCE(?, username),
                          full_name = COALESCE(?, full_name),
                          phone = COALESCE(?, phone),
                          password_hash = COALESCE(?, password_hash)
         WHERE id = ?`,
        [dn, avatar_url || null, username || null, full_name || null, phone || null, pwdHash, exists.id]
      );
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [exists.id]);
      user = rows[0];
    } else {
      const external_id = crypto.randomUUID();
      user = await createUser({
        external_id,
        display_name: display_name || full_name || username || email || 'User',
        avatar_url: avatar_url || null,
        email: email || null,
        password_hash: pwdHash,
        username: username || null,
        full_name: full_name || null,
        phone: phone || null,
      });
    }

    res.json(publicUser(user));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Register failed' });
  }
});

// POST /api/login -> {email, password}  (fallback: email-only if no password column populated)
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });

    let user = await getUserByEmail(email);

    if (user && user.password_hash) {
      if (!password) return res.status(400).json({ error: 'Password required' });
      const ok = await bcrypt.compare(String(password), user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      return res.json(publicUser(user));
    }

    // If user not found or has no password, treat as passwordless login/upsert
    if (!user) {
      user = await createUser({
        external_id: crypto.randomUUID(),
        display_name: email.split('@')[0],
        email,
      });
    }
    res.json(publicUser(user));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ======== SOCKET.IO ========
io.on('connection', (socket) => {
  // JOIN: { room, user: { id?, external_id?, name?, display_name?, avatar? }, anonymous?:bool }
  socket.on('join', async ({ room, user, anonymous }) => {
    try {
      const roomName = String(room || 'fun-friday');
      const roomId = await ensureRoom(roomName);

      // Resolve/ensure user
      let dbUser = null;

      // If client passed a known user id
      if (user?.id) {
        const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [user.id]);
        dbUser = rows[0] || null;
      }

      // else by external_id
      if (!dbUser && user?.external_id) {
        dbUser = await getUserByExternalId(user.external_id);
      }

      // else by email (if present)
      if (!dbUser && user?.email) {
        dbUser = await getUserByEmail(user.email);
      }

      // Create if missing (anonymous or newly registered)
      if (!dbUser) {
        const external_id = user?.external_id || crypto.randomUUID();
        const display_name =
          user?.display_name || user?.name || (user?.email ? user.email.split('@')[0] : `User-${external_id.slice(0, 6)}`);
        dbUser = await createUser({
          external_id,
          display_name,
          avatar_url: user?.avatar || null,
          email: user?.email || null,
          username: user?.username || null,
          full_name: user?.full_name || null,
          phone: user?.phone || null,
        });
      }

      socket.join(roomName);
      socket.data.room = roomName;
      socket.data.roomId = roomId;
      socket.data.userId = dbUser.id;
      socket.data.userName = dbUser.display_name;
      socket.data.avatar = dbUser.avatar_url || null;
      socket.data.forceAnon = !!anonymous;

      socket.emit('joined', { ok: true, user: publicUser(dbUser) });
    } catch (e) {
      console.error(e);
      socket.emit('joined', { ok: false, error: 'DB error' });
    }
  });

  // MESSAGE: { text, isAnonymous? }
  socket.on('message', async ({ text, isAnonymous }) => {
    try {
      const room = socket.data.room;
      if (!room) return;

      const roomId = socket.data.roomId || (await ensureRoom(room));
      const userId = socket.data.userId;
      const effectiveAnon = socket.data.forceAnon ? true : !!isAnonymous;

      const trimmed = String(text || '').trim();
      if (!trimmed) return;

      const [res] = await pool.query(
        'INSERT INTO messages (room_id, user_id, text, is_anonymous) VALUES (?, ?, ?, ?)',
        [roomId, userId || null, trimmed, effectiveAnon ? 1 : 0]
      );

      const message = {
        id: res.insertId,
        text: trimmed,
        is_anonymous: effectiveAnon,
        created_at: new Date(),
        user_name: effectiveAnon ? 'Anonymous' : socket.data.userName || 'User',
        avatar_url: effectiveAnon ? null : socket.data.avatar || null,
        user_id: userId || null,
      };

      io.to(room).emit('message', message);
    } catch (e) {
      console.error(e);
      socket.emit('error', { error: 'Failed to send message' });
    }
  });

  socket.on('disconnect', () => {});
});

// ======== START ========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
