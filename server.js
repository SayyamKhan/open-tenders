/**
 * OpenTenders — Server
 * Open source global government procurement intelligence
 */
import express from 'express';
import compression from 'compression';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { config } from './lib/config.js';
import { ensureDataFile, readAssignments, writeAssignments, withAssignmentLock, readNotes, writeNotes, readActivityLog, appendActivity, readBookmarks, writeBookmarks, readSchedule, writeSchedule, readUsers, writeUsers, withUserLock, hashPassword } from './lib/storage.js';
import { getCurrentState, refreshAll, refreshProgress } from './lib/refresh.js';
import { requireAuth, handleLogin, handleLogout, handleMe, requireMaster } from './lib/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_STATUSES = ['claimed', 'in_progress', 'submitted', 'won', 'lost'];
const VALID_PRIORITIES = ['high', 'medium', 'low'];

// ── In-memory caches (invalidated on refresh/mutations) ──
let _cachedState = null;         // cached readState() result
let _stateLastRead = 0;
let _duplicateMap = null;        // cached detectDuplicates() result
let _duplicateMapForHash = '';   // hash to know when to recalculate
let _filterOptionsCache = null;  // cached filter options

function invalidateCache() {
  _cachedState = null;
  _stateLastRead = 0;
  _duplicateMap = null;
  _duplicateMapForHash = '';
  _filterOptionsCache = null;
}

async function getCachedState() {
  const now = Date.now();
  if (_cachedState && (now - _stateLastRead) < 5000) return _cachedState;
  _cachedState = await getCurrentState();
  _stateLastRead = now;
  return _cachedState;
}

function getCachedDuplicateMap(tenders) {
  // Use tender count + last ID as a cheap hash
  const hash = tenders.length + ':' + (tenders[0]?.id || '') + ':' + (tenders[tenders.length - 1]?.id || '');
  if (_duplicateMap && _duplicateMapForHash === hash) return _duplicateMap;
  _duplicateMap = detectDuplicates(tenders);
  _duplicateMapForHash = hash;
  return _duplicateMap;
}

const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Serve public static files (login page assets need to load without auth)
const publicDir = path.join(__dirname, 'public');
const publicStatic = express.static(publicDir, {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (/\.(woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else {
      // Never cache JS/CSS/HTML — browser must always fetch fresh copy
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
});

// Allow login page assets through without auth
const PUBLIC_ASSETS = new Set(['/login.html', '/login.js', '/styles.css']);
app.use((req, res, next) => {
  if (PUBLIC_ASSETS.has(req.path)) return publicStatic(req, res, next);
  next();
});

// Login rate limiting — simple in-memory brute force protection
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPTS = 10;

app.post('/api/login', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && now < entry.resetAt && entry.count >= MAX_LOGIN_ATTEMPTS) {
    const retryMin = Math.ceil((entry.resetAt - now) / 60000);
    return res.status(429).json({ ok: false, error: `Too many login attempts. Try again in ${retryMin} minutes.` });
  }

  // Track attempt (cleared on success in handleLogin wrapper)
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }

  // Wrap to clear on success
  const origJson = res.json.bind(res);
  res.json = (data) => {
    if (data && data.ok) loginAttempts.delete(ip);
    return origJson(data);
  };

  next();
}, handleLogin);

// Azure health probe — must be above auth middleware
let bootstrapError = '';
app.get('/health', (_req, res) => {
  res.status(bootstrapError ? 503 : 200).send(bootstrapError ? 'ERROR' : 'OK');
});

// Auth middleware — everything below requires login
app.use(requireAuth);

// Protected static files
app.use(publicStatic);

// ── Request timeout (30s) and timing for API routes ──
app.use('/api', (req, res, next) => {
  const start = Date.now();
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(408).json({ ok: false, error: 'Request timeout' });
    }
  });
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Auth endpoints
app.post('/api/logout', handleLogout);
app.get('/api/me', handleMe);

app.get('/api/health', (_req, res) => {
  const status = bootstrapError ? 503 : 200;
  res.status(status).json({
    ok: !bootstrapError,
    app: 'OpenTenders',
    bootstrapError: bootstrapError || undefined,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576)
  });
});

// ── Users list (for reassign dropdown) ──

app.get('/api/users', async (_req, res) => {
  const users = await readUsers();
  res.json({ users: users.map(u => u.username) });
});

function isMaster(username, req) {
  // Prefer role from auth middleware, fallback to config
  if (req && req.user && req.user.role) return req.user.role === 'master';
  return config.masterUsers.includes(username);
}

/** Normalize title for duplicate comparison — strip common filler words */
function normalizeTitle(title) {
  return (title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(procurement|of|the|for|and|in|at|to|a|an|is|or|by|on|with)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Calculate word overlap ratio between two titles */
function titleSimilarity(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2));
  if (!wordsA.size || !wordsB.size) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/** Detect potential duplicates across different portals */
function detectDuplicates(tenders) {
  const normalized = tenders.map(t => ({
    id: t.id,
    source: t.source,
    title: normalizeTitle(t.title),
    org: normalizeTitle(t.organization),
    closing: t.closing,
    titleLen: normalizeTitle(t.title).split(' ').filter(w => w.length > 2).length
  }));

  const duplicateMap = {}; // tenderId -> { duplicateOf: tenderId, duplicateSource: source }

  for (let i = 0; i < normalized.length; i++) {
    if (duplicateMap[normalized[i].id]) continue;
    for (let j = i + 1; j < normalized.length; j++) {
      if (duplicateMap[normalized[j].id]) continue;
      if (normalized[i].source === normalized[j].source) continue;

      // Must have same or close closing date
      const sameDate = normalized[i].closing && normalized[j].closing &&
        Math.abs(new Date(normalized[i].closing) - new Date(normalized[j].closing)) <= 3 * 86400000;
      if (!sameDate) continue;

      const sim = titleSimilarity(normalized[i].title, normalized[j].title);

      // For short/generic titles (< 4 meaningful words), require org match too
      const isShortTitle = normalized[i].titleLen < 4 || normalized[j].titleLen < 4;
      const orgMatch = normalized[i].org && normalized[j].org && titleSimilarity(normalized[i].org, normalized[j].org) >= 0.5;

      // Require high similarity (0.75+) for regular titles, or 0.6+ with org match for short titles
      const isDuplicate = sim >= 0.85 || (sim >= 0.75 && !isShortTitle) || (sim >= 0.6 && isShortTitle && orgMatch);

      if (isDuplicate) {
        duplicateMap[normalized[j].id] = { duplicateOf: tenders[i].id, duplicateSource: tenders[i].source };
      }
    }
  }
  return duplicateMap;
}

/** Merge assignments + notes + bookmarks + duplicates onto tenders, clean stale assignments */
async function enrichTenders(tenders, username) {
  const [assignments, notes, bookmarks] = await Promise.all([readAssignments(), readNotes(), readBookmarks()]);

  // Clean stale assignments (IDs that no longer exist in tenders)
  const validIds = new Set(tenders.map(t => t.id));
  let cleaned = 0;
  for (const key of Object.keys(assignments)) {
    if (!validIds.has(key)) { delete assignments[key]; cleaned++; }
  }
  if (cleaned > 0) await writeAssignments(assignments);

  const userBookmarks = bookmarks[username] || [];
  const duplicateMap = getCachedDuplicateMap(tenders);

  return tenders.map(t => {
    const a = assignments[t.id];
    const dup = duplicateMap[t.id] || null;
    return {
      ...t,
      assignedTo: a?.assignedTo || null,
      assignedAt: a?.assignedAt || null,
      claimStatus: a?.status || null,
      priority: a?.priority || null,
      notes: notes[t.id] || [],
      bookmarked: userBookmarks.includes(t.id),
      duplicateOf: dup?.duplicateOf || null,
      duplicateSource: dup?.duplicateSource || null
    };
  });
}

app.get('/api/tenders', async (req, res) => {
  const state = await getCachedState();
  const allTenders = await enrichTenders(state.tenders, req.user.username);

  // Server-side filtering & pagination
  const { q, category, province, source, deadline, assign, sort, page, limit, score: scoreFilter, countries: countriesParam } = req.query;
  const countryFilter = countriesParam ? new Set(countriesParam.split(',').map(c => c.trim()).filter(Boolean)) : null;

  // Mark tenders added since last refresh as "new"
  const lastRefresh = state.meta.lastRefreshAt ? new Date(state.meta.lastRefreshAt) : null;
  const prevRefreshMs = lastRefresh ? lastRefresh.getTime() - (24 * 60 * 60 * 1000) : 0; // tenders added within 24h of last refresh
  for (const t of allTenders) {
    t.isNew = !!(t.firstSeenAt && prevRefreshMs && new Date(t.firstSeenAt).getTime() >= prevRefreshMs);
  }

  let filtered = allTenders.filter(t => {
    if (t.duplicateOf) return false;
    if (q) {
      const haystack = [t.title, t.description, t.organization, t.officialRef, t.referenceNumber, t.province, t.city, t.source, t.aiSummary, t.sector, t.aiSector, t.category].join(' ').toLowerCase();
      if (!haystack.includes(q.toLowerCase())) return false;
    }
    if (category && category !== 'all' && t.category !== category) return false;
    if (province && province !== 'all' && t.province !== province) return false;
    if (source && source !== 'all' && t.source !== source) return false;
    if (deadline && deadline !== 'all') {
      const days = Number(deadline);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      if (t.closing && t.closing > cutoffStr) return false;
    }
    if (scoreFilter && scoreFilter !== 'all') {
      const s = Number(t.fitScore || 0);
      if (scoreFilter === '70') { if (s < 70) return false; }
      else if (scoreFilter === '40') { if (s < 40) return false; }
      else if (scoreFilter === '1') { if (s < 1) return false; }
    }
    if (assign === 'bookmarked' && !t.bookmarked) return false;
    if (assign === 'mine' && t.assignedTo !== req.user.username) return false;
    if (assign === 'unassigned' && t.assignedTo) return false;
    if (assign === 'assigned' && !t.assignedTo) return false;
    // Country filter (from pill selector)
    if (countryFilter && countryFilter.size > 0) {
      const tCountry = t.country || (['Federal', 'Punjab', 'Khyber Pakhtunkhwa', 'AJK', 'Sindh', 'Balochistan'].includes(t.province) ? 'Pakistan' : t.province) || 'Pakistan';
      if (!countryFilter.has(tCountry)) return false;
    }
    return true;
  });

  // Sort
  const sortBy = sort || 'closing_asc';
  filtered.sort((a, b) => {
    if (a.bookmarked && !b.bookmarked) return -1;
    if (!a.bookmarked && b.bookmarked) return 1;
    if (assign === 'mine') return new Date(a.closing || '9999-12-31') - new Date(b.closing || '9999-12-31');
    if (sortBy === 'newest') return new Date(b.advertised || 0) - new Date(a.advertised || 0);
    if (sortBy === 'score') return (b.fitScore || 0) - (a.fitScore || 0);
    if (sortBy === 'closing_desc') return new Date(b.closing || '0000-01-01') - new Date(a.closing || '0000-01-01');
    return new Date(a.closing || '9999-12-31') - new Date(b.closing || '9999-12-31');
  });

  const totalFiltered = filtered.length;
  const totalAll = allTenders.filter(t => !t.duplicateOf).length;

  // Paginate
  const pageNum = Math.max(1, Number(page) || 1);
  const perPage = limit === 'all' ? filtered.length : Math.max(1, Math.min(200, Number(limit) || 50));
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const start = (pageNum - 1) * perPage;
  const paginated = filtered.slice(start, start + perPage);

  // Extract filter options (cached per refresh cycle)
  if (!_filterOptionsCache) {
    const allNonDupe = allTenders.filter(t => !t.duplicateOf);
    // Build country counts from all tenders (regardless of current filter)
    const countryCounts = {};
    for (const t of allNonDupe) {
      const c = t.country || (['Federal', 'Punjab', 'Khyber Pakhtunkhwa', 'AJK', 'Sindh', 'Balochistan'].includes(t.province) ? 'Pakistan' : t.province) || 'Pakistan';
      countryCounts[c] = (countryCounts[c] || 0) + 1;
    }
    // Ensure all portals appear even with 0 tenders
    for (const s of state.sources) {
      const c = s.country || (s.province ? 'Pakistan' : 'Global');
      if (!(c in countryCounts)) countryCounts[c] = 0;
    }
    _filterOptionsCache = {
      categories: [...new Set(allNonDupe.map(t => t.category).filter(Boolean))].sort(),
      provinces: [...new Set([...allNonDupe.map(t => t.province), ...state.sources.map(s => s.province)].filter(Boolean))],
      sources: [...new Set([...allNonDupe.map(t => t.source), ...state.sources.map(s => s.label)].filter(Boolean))],
      countryCounts
    };
  }
  const { categories, provinces, sources: sourceLabels, countryCounts } = _filterOptionsCache;

  res.json({
    tenders: paginated,
    sources: state.sources,
    meta: state.meta,
    pagination: { page: pageNum, perPage, totalPages, totalFiltered, totalAll },
    filterOptions: { categories, provinces, sources: sourceLabels, countryCounts }
  });
});

// Track in-flight refresh for graceful shutdown
let _activeRefresh = null;

app.post('/api/refresh', async (req, res) => {
  // Azure has a 230s hard timeout on HTTP requests.
  // Refresh takes 5-8 minutes, so we respond immediately and let SSE handle progress.
  // The client already opens an SSE stream and tracks completion via 'done' event.
  const username = req.user.username;
  invalidateCache();

  // Respond immediately — don't wait for refresh to finish
  res.json({ ok: true, async: true });

  // Run refresh in background
  _activeRefresh = (async () => {
    try {
      const state = await refreshAll({ manual: true });
      invalidateCache();
      await appendActivity({ action: 'refresh', user: username, detail: `${state.tenders.length} tenders` });
    } catch (error) {
      console.error('[refresh] Failed:', error.message);
    } finally {
      _activeRefresh = null;
    }
  })();
});

// ── Refresh progress SSE stream ──

app.get('/api/refresh/progress', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no', // Disable nginx/Azure proxy buffering
    Connection: 'keep-alive'
  });
  res.write(':\n\n'); // SSE comment to keep connection alive
  if (typeof res.flush === 'function') res.flush(); // force flush through compression middleware

  const onProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
    if (data.step === 'done') {
      res.end();
    }
  };

  refreshProgress.on('progress', onProgress);

  // Send a heartbeat every 15s to keep Azure proxy from closing the connection
  const heartbeat = setInterval(() => {
    res.write(':\n\n');
    if (typeof res.flush === 'function') res.flush();
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    refreshProgress.off('progress', onProgress);
  });
});

// ── Assignment routes ──

app.post('/api/tenders/:id/claim', (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;

  withAssignmentLock(async () => {
    const assignments = await readAssignments();

    if (assignments[tenderId] && assignments[tenderId].assignedTo !== username) {
      return res.status(409).json({ ok: false, error: `Already claimed by ${assignments[tenderId].assignedTo}` });
    }

    const now = new Date().toISOString();
    assignments[tenderId] = {
      assignedTo: username,
      assignedAt: now,
      status: 'claimed',
      priority: null,
      statusUpdatedAt: now,
      priorityUpdatedAt: null
    };
    await writeAssignments(assignments);
    await appendActivity({ action: 'claim', user: username, tenderId });
    res.json({ ok: true, assignedTo: username });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

app.post('/api/tenders/:id/unclaim', (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;

  withAssignmentLock(async () => {
    const assignments = await readAssignments();

    if (!assignments[tenderId]) {
      return res.status(404).json({ ok: false, error: 'Not assigned' });
    }
    if (assignments[tenderId].assignedTo !== username && !isMaster(username, req)) {
      return res.status(403).json({ ok: false, error: 'Only the assigned user or a master user can unclaim' });
    }

    delete assignments[tenderId];
    await writeAssignments(assignments);
    await appendActivity({ action: 'unclaim', user: username, tenderId });
    res.json({ ok: true });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// ── Status route ──

app.post('/api/tenders/:id/status', (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;
  const { status } = req.body || {};

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  withAssignmentLock(async () => {
    const assignments = await readAssignments();
    if (!assignments[tenderId]) return res.status(404).json({ ok: false, error: 'Tender not claimed' });
    if (assignments[tenderId].assignedTo !== username && !isMaster(username, req)) return res.status(403).json({ ok: false, error: 'Only the assigned user or a master user can change status' });

    const oldStatus = assignments[tenderId].status || 'claimed';
    assignments[tenderId].status = status;
    assignments[tenderId].statusUpdatedAt = new Date().toISOString();
    await writeAssignments(assignments);
    await appendActivity({ action: 'status_change', user: username, tenderId, detail: `${oldStatus} → ${status}` });
    res.json({ ok: true, status });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// ── Priority route ──

app.post('/api/tenders/:id/priority', (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;
  const { priority } = req.body || {};

  if (!priority || !VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ ok: false, error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
  }

  withAssignmentLock(async () => {
    const assignments = await readAssignments();
    if (!assignments[tenderId]) return res.status(404).json({ ok: false, error: 'Tender not claimed' });
    if (assignments[tenderId].assignedTo !== username && !isMaster(username, req)) return res.status(403).json({ ok: false, error: 'Only the assigned user or a master user can set priority' });

    assignments[tenderId].priority = priority;
    assignments[tenderId].priorityUpdatedAt = new Date().toISOString();
    await writeAssignments(assignments);
    await appendActivity({ action: 'priority_change', user: username, tenderId, detail: priority });
    res.json({ ok: true, priority });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// ── Reassign route ──

app.post('/api/tenders/:id/reassign', (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;
  const { assignTo } = req.body || {};

  if (!assignTo || !config.authUsernames.includes(assignTo)) {
    return res.status(400).json({ ok: false, error: 'Invalid user' });
  }
  if (assignTo === username) {
    return res.status(400).json({ ok: false, error: 'Already assigned to you' });
  }

  withAssignmentLock(async () => {
    const assignments = await readAssignments();
    if (!assignments[tenderId]) return res.status(404).json({ ok: false, error: 'Tender not claimed' });
    if (assignments[tenderId].assignedTo !== username && !isMaster(username, req)) return res.status(403).json({ ok: false, error: 'Only the assigned user or a master user can reassign' });

    assignments[tenderId].assignedTo = assignTo;
    assignments[tenderId].assignedAt = new Date().toISOString();
    // Preserve status and priority
    await writeAssignments(assignments);
    await appendActivity({ action: 'reassign', user: username, tenderId, detail: `→ ${assignTo}` });
    res.json({ ok: true, assignedTo: assignTo });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// ── Notes routes ──

app.post('/api/tenders/:id/notes', async (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'Note text required' });
  }

  const notes = await readNotes();
  if (!notes[tenderId]) notes[tenderId] = [];
  const note = { id: Date.now().toString(36), user: username, text: text.trim().slice(0, 500), at: new Date().toISOString() };
  notes[tenderId].push(note);
  await writeNotes(notes);
  await appendActivity({ action: 'note', user: username, tenderId, detail: text.trim().slice(0, 80) });
  res.json({ ok: true, note });
});

app.delete('/api/tenders/:id/notes/:noteId', async (req, res) => {
  const { id: tenderId, noteId } = req.params;
  const username = req.user.username;

  const notes = await readNotes();
  const tenderNotes = notes[tenderId] || [];
  const idx = tenderNotes.findIndex(n => n.id === noteId);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Note not found' });
  if (tenderNotes[idx].user !== username) return res.status(403).json({ ok: false, error: 'Only the author can delete' });

  tenderNotes.splice(idx, 1);
  if (!tenderNotes.length) delete notes[tenderId];
  else notes[tenderId] = tenderNotes;
  await writeNotes(notes);
  res.json({ ok: true });
});

// ── Activity log ──

app.get('/api/activity', async (_req, res) => {
  const log = await readActivityLog();
  res.json(log);
});

// ── Team dashboard ──

app.get('/api/team-dashboard', async (_req, res) => {
  const state = await getCurrentState();
  const assignments = await readAssignments();

  const byUser = {};
  for (const [tenderId, assignment] of Object.entries(assignments)) {
    const tender = state.tenders.find(t => t.id === tenderId);
    if (!tender) continue; // stale
    const user = assignment.assignedTo;
    if (!byUser[user]) byUser[user] = { username: user, count: 0, statuses: {}, priorities: {}, tenders: [] };
    byUser[user].count++;
    const s = assignment.status || 'claimed';
    byUser[user].statuses[s] = (byUser[user].statuses[s] || 0) + 1;
    if (assignment.priority) {
      byUser[user].priorities[assignment.priority] = (byUser[user].priorities[assignment.priority] || 0) + 1;
    }
    byUser[user].tenders.push({
      tenderId,
      title: tender.title,
      closing: tender.closing || null,
      status: s,
      priority: assignment.priority || null,
      sourceUrl: tender.sourceUrl || null,
      source: tender.source || null
    });
  }

  for (const u of Object.values(byUser)) {
    u.tenders.sort((a, b) => {
      if (a.closing && b.closing) return new Date(a.closing) - new Date(b.closing);
      if (a.closing) return -1;
      if (b.closing) return 1;
      return 0;
    });
  }

  res.json({ team: Object.values(byUser) });
});

// ── CSV Export ──

app.get('/api/export/csv', async (req, res) => {
  const state = await getCurrentState();
  state.tenders = await enrichTenders(state.tenders, req.user.username);

  const headers = ['Title', 'Description', 'Organization', 'Province', 'City', 'Source', 'Sector', 'Type', 'Reference', 'Published', 'Closing', 'Closing Time', 'Fit Score', 'Fit Tags', 'Assigned To', 'Claim Status', 'Priority', 'Status', 'Portal URL'];
  const rows = state.tenders.map(t => [
    t.title, t.aiSummary || t.description || '', t.organization, t.province, t.city, t.source, t.sector || '', t.type || '',
    t.officialRef || t.referenceNumber || '', t.advertised || '', t.closing || '', t.closingTime || '',
    t.fitScore || 0, (t.fitTags || []).join('; '), t.assignedTo || '',
    t.claimStatus || '', t.priority || '', t.status || '', t.sourceUrl || ''
  ]);

  // Escape cells: quote wrapping + prevent Excel formula injection (=, +, -, @, |, \t, \r, \n)
  const safeCell = (val) => {
    let s = String(val).replace(/"/g, '""');
    if (/^[=+\-@|\t\r\n]/.test(s)) s = "'" + s;
    return `"${s}"`;
  };
  const csvContent = [headers, ...rows].map(row =>
    row.map(safeCell).join(',')
  ).join('\r\n');

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="opentenders-${date}.csv"`);
  res.send('\ufeff' + csvContent); // BOM for Excel UTF-8
});

// ── Bookmark routes ──

app.post('/api/bookmarks/:id', async (req, res) => {
  const tenderId = req.params.id;
  const username = req.user.username;
  const bookmarks = await readBookmarks();
  if (!bookmarks[username]) bookmarks[username] = [];
  const idx = bookmarks[username].indexOf(tenderId);
  if (idx === -1) {
    bookmarks[username].push(tenderId);
  } else {
    bookmarks[username].splice(idx, 1);
  }
  await writeBookmarks(bookmarks);
  res.json({ ok: true, bookmarked: idx === -1 });
});

// ── Admin: User management routes ──

app.get('/api/admin/users', requireMaster, async (_req, res) => {
  const users = await readUsers();
  res.json({
    users: users.map(u => ({
      username: u.username,
      role: u.role || 'member',
      createdAt: u.createdAt || null,
      createdBy: u.createdBy || null
    }))
  });
});

app.post('/api/admin/users', requireMaster, (req, res) => {
  const { username, password, role } = req.body || {};

  // Validate
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ ok: false, error: 'Username must be 3-30 chars, lowercase letters/numbers/underscore only' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }
  if (role && !['master', 'member'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Role must be "master" or "member"' });
  }

  withUserLock(async () => {
    const users = await readUsers();
    if (users.find(u => u.username === username)) {
      return res.status(409).json({ ok: false, error: 'Username already exists' });
    }

    const { salt, hash } = hashPassword(password);
    users.push({
      username,
      salt,
      hash,
      role: role || 'member',
      createdAt: new Date().toISOString(),
      createdBy: req.user.username
    });
    await writeUsers(users);
    await appendActivity({ action: 'user_add', user: req.user.username, detail: `Added user: ${username} (${role || 'member'})` });
    res.json({ ok: true, username, role: role || 'member' });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

app.delete('/api/admin/users/:username', requireMaster, (req, res) => {
  const targetUser = req.params.username;

  if (targetUser === req.user.username) {
    return res.status(400).json({ ok: false, error: 'Cannot delete your own account' });
  }

  withUserLock(async () => {
    const users = await readUsers();
    const idx = users.findIndex(u => u.username === targetUser);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    users.splice(idx, 1);
    await writeUsers(users);
    await appendActivity({ action: 'user_delete', user: req.user.username, detail: `Deleted user: ${targetUser}` });
    res.json({ ok: true });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

app.patch('/api/admin/users/:username/role', requireMaster, (req, res) => {
  const targetUser = req.params.username;
  const { role } = req.body || {};

  if (!role || !['master', 'member'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Role must be "master" or "member"' });
  }

  withUserLock(async () => {
    const users = await readUsers();
    const user = users.find(u => u.username === targetUser);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    // Prevent demoting the last master
    if (role === 'member' && user.role === 'master') {
      const masterCount = users.filter(u => u.role === 'master').length;
      if (masterCount <= 1) {
        return res.status(400).json({ ok: false, error: 'Cannot demote the last master user' });
      }
    }

    const oldRole = user.role;
    user.role = role;
    await writeUsers(users);
    await appendActivity({ action: 'user_role', user: req.user.username, detail: `${targetUser}: ${oldRole} → ${role}` });
    res.json({ ok: true, username: targetUser, role });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// Any user can change their own password
app.patch('/api/me/password', (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  withUserLock(async () => {
    const users = await readUsers();
    const user = users.find(u => u.username === req.user.username);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const { salt, hash } = hashPassword(password);
    user.salt = salt;
    user.hash = hash;
    await writeUsers(users);
    await appendActivity({ action: 'user_password', user: req.user.username, detail: 'Changed own password' });
    res.json({ ok: true });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// Master can reset any other user's password
app.patch('/api/admin/users/:username/password', requireMaster, (req, res) => {
  const targetUser = req.params.username;
  const { password } = req.body || {};

  if (!password || password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  withUserLock(async () => {
    const users = await readUsers();
    const user = users.find(u => u.username === targetUser);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const { salt, hash } = hashPassword(password);
    user.salt = salt;
    user.hash = hash;
    await writeUsers(users);
    await appendActivity({ action: 'user_password', user: req.user.username, detail: `Reset password for: ${targetUser}` });
    res.json({ ok: true });
  }).catch(() => res.status(500).json({ ok: false, error: 'Internal error' }));
});

// ── Schedule routes ──

const SCHEDULE_PRESETS = {
  '0 */6 * * *': 'Every 6 hours',
  '0 */12 * * *': 'Every 12 hours',
  '0 8 * * *': 'Daily at 8 AM',
  '0 8,20 * * *': 'Twice daily (8 AM & 8 PM)',
};

let cronTask = null;

function setupCron(cronExpr) {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  if (!cronExpr || !cron.validate(cronExpr)) return;
  cronTask = cron.schedule(cronExpr, async () => {
    try {
      await refreshAll({ manual: false });
      console.log('Scheduled refresh complete');
    } catch (error) {
      console.error('Scheduled refresh failed:', error);
    }
  }, { timezone: config.timezone });
}

app.get('/api/schedule', async (_req, res) => {
  const schedule = await readSchedule();
  res.json({
    cron: schedule.cron,
    enabled: schedule.enabled,
    label: SCHEDULE_PRESETS[schedule.cron] || schedule.cron,
    presets: Object.entries(SCHEDULE_PRESETS).map(([value, label]) => ({ value, label }))
  });
});

app.post('/api/schedule', async (req, res) => {
  const username = req.user.username;
  if (!isMaster(username, req)) {
    return res.status(403).json({ ok: false, error: 'Only master users can change schedule' });
  }
  const { cron: cronExpr, enabled } = req.body || {};
  if (cronExpr && !cron.validate(cronExpr)) {
    return res.status(400).json({ ok: false, error: 'Invalid cron expression' });
  }
  const schedule = await readSchedule();
  if (cronExpr !== undefined) schedule.cron = cronExpr;
  if (enabled !== undefined) schedule.enabled = !!enabled;
  await writeSchedule(schedule);

  if (schedule.enabled) {
    setupCron(schedule.cron);
  } else {
    if (cronTask) { cronTask.stop(); cronTask = null; }
  }
  res.json({ ok: true, cron: schedule.cron, enabled: schedule.enabled, label: SCHEDULE_PRESETS[schedule.cron] || schedule.cron });
});

// ── SPA fallback ──

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function bootstrap() {
  try {
    await ensureDataFile();
    refreshAll({ manual: false }).catch((error) => {
      console.error('Initial refresh failed:', error);
    });

    const schedule = await readSchedule();
    if (schedule.enabled) {
      setupCron(schedule.cron);
    }
  } catch (error) {
    bootstrapError = error.message;
  }

  const server = app.listen(config.port, () => {
    console.log(`OpenTenders listening on http://localhost:${config.port}`);
  });

  // Graceful shutdown — let in-flight requests finish, clean up Playwright
  function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    if (cronTask) { cronTask.stop(); cronTask = null; }
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    // Force exit after 15s if connections hang (give refresh a moment to clean up)
    setTimeout(() => {
      console.log('Force exit — shutdown timeout');
      process.exit(1);
    }, 15000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap();
