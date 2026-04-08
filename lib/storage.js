import fs from 'fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';

// Atomic write: write to temp file in same dir, then rename (same-filesystem rename is atomic on POSIX)
async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Simple promise-chain mutex to serialize assignment file writes
let _assignmentLock = Promise.resolve();
let _userLock = Promise.resolve();

export function withAssignmentLock(fn) {
  const prev = _assignmentLock;
  let resolve;
  _assignmentLock = new Promise(r => { resolve = r; });
  return prev.then(fn).finally(resolve);
}

const EMPTY_STATE = {
  meta: {
    appName: 'OpenTenders',
    verificationMode: 'deterministic-official-only',
    lastRefreshAt: null,
    nextRefreshHint: 'Daily at 08:00 UTC',
    totals: { tenders: 0, sources: 0 }
  },
  sources: [],
  tenders: []
};

let _initialized = false;
export async function ensureDataFile() {
  if (_initialized) return;
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    await fs.access(config.cacheFile);
  } catch {
    await atomicWrite(config.cacheFile, JSON.stringify(EMPTY_STATE));
  }
  _initialized = true;
}

export async function readState() {
  await ensureDataFile();
  const raw = await fs.readFile(config.cacheFile, 'utf8');
  return JSON.parse(raw);
}

export async function writeState(state) {
  await ensureDataFile();
  await atomicWrite(config.cacheFile, JSON.stringify(state, null, 2));
}

export async function readAssignments() {
  try {
    const raw = await fs.readFile(config.assignmentsFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeAssignments(assignments) {
  await atomicWrite(config.assignmentsFile, JSON.stringify(assignments, null, 2));
}

export async function readNotes() {
  try {
    const raw = await fs.readFile(config.notesFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeNotes(notes) {
  await atomicWrite(config.notesFile, JSON.stringify(notes, null, 2));
}

export async function readActivityLog() {
  try {
    const raw = await fs.readFile(config.activityFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function archiveOldTenders() {
  const state = await readState();
  if (!state.tenders || !state.tenders.length) return;

  const today = new Date().toISOString().slice(0, 10);

  const active = [];
  const toArchive = [];

  // Expired tenders get archived regardless of bookmark status
  for (const tender of state.tenders) {
    if (tender.closing && tender.closing < today) {
      toArchive.push(tender);
    } else {
      active.push(tender);
    }
  }

  if (!toArchive.length) return;

  // Read existing archive
  let archive = [];
  try {
    const raw = await fs.readFile(config.archiveFile, 'utf8');
    archive = JSON.parse(raw);
  } catch { /* no archive yet */ }

  // Dedupe by id
  const existingIds = new Set(archive.map(t => t.id));
  for (const tender of toArchive) {
    if (!existingIds.has(tender.id)) {
      archive.push({ ...tender, archivedAt: new Date().toISOString() });
    }
  }

  // Cap archive at 500 entries (keep newest)
  if (archive.length > 500) {
    archive = archive.slice(archive.length - 500);
  }

  await atomicWrite(config.archiveFile, JSON.stringify(archive, null, 2));

  // Update state with only active tenders
  state.tenders = active;
  state.meta.totals.tenders = active.length;
  await writeState(state);
}

export async function readBookmarks() {
  try {
    const raw = await fs.readFile(config.bookmarksFile, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

export async function writeBookmarks(bookmarks) {
  await atomicWrite(config.bookmarksFile, JSON.stringify(bookmarks, null, 2));
}

export async function readSchedule() {
  try {
    const raw = await fs.readFile(config.scheduleFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { cron: config.refreshCron, enabled: true };
  }
}

export async function writeSchedule(schedule) {
  await atomicWrite(config.scheduleFile, JSON.stringify(schedule, null, 2));
}

// ── User management ──

export function withUserLock(fn) {
  const prev = _userLock;
  let resolve;
  _userLock = new Promise(r => { resolve = r; });
  return prev.then(fn).finally(resolve);
}

export async function readUsers() {
  try {
    const raw = await fs.readFile(config.usersFile, 'utf8');
    const data = JSON.parse(raw);
    return data.users || [];
  } catch {
    // Bootstrap: migrate from AUTH_USERS env var
    const users = migrateFromEnv();
    if (users.length) {
      await writeUsers(users);
    }
    return users;
  }
}

export async function writeUsers(users) {
  await atomicWrite(config.usersFile, JSON.stringify({ users }, null, 2));
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function migrateFromEnv() {
  const raw = config.authUsers || '';
  if (!raw) return [];
  const masterSet = new Set(config.masterUsers || []);
  const users = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const firstColon = trimmed.indexOf(':');
    if (firstColon === -1) continue;
    const username = trimmed.slice(0, firstColon);
    const rest = trimmed.slice(firstColon + 1);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) continue;
    const salt = rest.slice(0, colonIdx);
    const hash = rest.slice(colonIdx + 1);
    users.push({
      username,
      salt,
      hash,
      role: masterSet.has(username) ? 'master' : 'member',
      createdAt: new Date().toISOString(),
      createdBy: 'system'
    });
  }
  return users;
}

export async function appendActivity(entry) {
  const log = await readActivityLog();
  log.unshift({ ...entry, at: new Date().toISOString() });
  // Keep last 200 entries
  if (log.length > 200) log.length = 200;
  await atomicWrite(config.activityFile, JSON.stringify(log, null, 2));
}

