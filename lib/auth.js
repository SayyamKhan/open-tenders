/**
 * OpenTenders — Auth
 * Signed-cookie auth with scrypt password hashing.
 * Zero external dependencies — uses only node:crypto.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { readUsers } from './storage.js';

const TOKEN_COOKIE = 'ot_token';
const MAX_AGE_MS = (Number(process.env.AUTH_TTL_DAYS) || 7) * 86400000;

/** Load users from file (or env fallback on first run) */
async function parseUsers() {
  const users = await readUsers();
  const map = new Map();
  for (const u of users) {
    map.set(u.username, { saltAndHash: `${u.salt}:${u.hash}`, role: u.role || 'member' });
  }
  return map;
}

function verifyPassword(plaintext, saltAndHash) {
  const colonIdx = saltAndHash.indexOf(':');
  if (colonIdx === -1) return false;
  const salt = saltAndHash.slice(0, colonIdx);
  const storedHash = saltAndHash.slice(colonIdx + 1);
  const computed = crypto.scryptSync(plaintext, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

function createToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.authSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.authSecret).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - data.iat > MAX_AGE_MS) return null;
    return { username: data.u };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const map = {};
  if (!header) return map;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return map;
}

/** Paths that don't require auth */
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/styles.css', '/api/login']);

export async function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  const user = verifyToken(cookies[TOKEN_COOKIE]);
  if (user) {
    // Verify user still exists and get current role
    try {
      const users = await readUsers();
      const found = users.find(u => u.username === user.username);
      if (!found) {
        // User was deleted — force logout
        res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
        return res.redirect('/login.html');
      }
      req.user = { username: user.username, role: found.role || 'member' };
    } catch {
      req.user = { username: user.username, role: 'member' };
    }
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login.html');
}

export async function handleLogin(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  const users = await parseUsers();
  const userData = users.get(username);
  if (!userData || !verifyPassword(password, userData.saltAndHash)) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }
  const token = createToken(username);
  // Session cookie — no Max-Age so browser clears it when tab/window closes
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  return res.json({ ok: true, username });
}

export function handleLogout(_req, res) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  return res.json({ ok: true });
}

export async function handleMe(req, res) {
  return res.json({
    username: req.user.username,
    isMaster: req.user.role === 'master'
  });
}

/** Middleware: require master role */
export function requireMaster(req, res, next) {
  if (req.user.role !== 'master') {
    return res.status(403).json({ ok: false, error: 'Master access required' });
  }
  next();
}
