/**
 * OpenTenders — Frontend
 * Open source global government procurement intelligence
 */

const STATUS_LABELS = {
  claimed: 'Claimed', in_progress: 'In Progress', submitted: 'Submitted', won: 'Won', lost: 'Lost'
};
const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

const state = { tenders: [], sources: [], meta: {}, currentUser: '', isMaster: false, activity: [], teamData: [], knownUsers: [], schedule: null };
let currentPage = 1;

const els = {
  verifiedCount: document.getElementById('verifiedCount'),
  sourceCount: document.getElementById('sourceCount'),
  lastRefresh: document.getElementById('lastRefresh'),
  tenderList: document.getElementById('tenderList'),
  sourcesList: document.getElementById('sourcesList'),
  refreshBtn: document.getElementById('refreshBtn'),
  searchInput: document.getElementById('searchInput'),
  categoryFilter: document.getElementById('categoryFilter'),
  provinceFilter: document.getElementById('provinceFilter'),
  sourceFilter: document.getElementById('sourceFilter'),
  sortFilter: document.getElementById('sortFilter'),
  deadlineFilter: document.getElementById('deadlineFilter'),
  perPageFilter: document.getElementById('perPageFilter'),
  pagination: document.getElementById('pagination'),
  scoreFilter: document.getElementById('scoreFilter'),
  assignFilter: document.getElementById('assignFilter'),
  messageBar: document.getElementById('messageBar'),
  resultsHint: document.getElementById('resultsHint'),
  userBar: document.getElementById('userBar'),
  userName: document.getElementById('userName'),
  logoutBtn: document.getElementById('logoutBtn'),
  exportBtn: document.getElementById('exportBtn'),
  activityList: document.getElementById('activityList'),
  teamDashboard: document.getElementById('teamDashboard'),
  teamGrid: document.getElementById('teamGrid'),
  scheduleInfo: document.getElementById('scheduleInfo'),
  scheduleLabel: document.getElementById('scheduleLabel'),
  scheduleEditBtn: document.getElementById('scheduleEditBtn'),
  scheduleEditor: document.getElementById('scheduleEditor'),
  scheduleSelect: document.getElementById('scheduleSelect'),
  scheduleSaveBtn: document.getElementById('scheduleSaveBtn'),
  scheduleCancelBtn: document.getElementById('scheduleCancelBtn'),
  previewModal: document.getElementById('previewModal'),
  previewTitle: document.getElementById('previewTitle'),
  previewBody: document.getElementById('previewBody'),
  previewDownload: document.getElementById('previewDownload'),
  previewClose: document.getElementById('previewClose'),
  changePasswordBtn: document.getElementById('changePasswordBtn'),
  manageUsersBtn: document.getElementById('manageUsersBtn'),
  userModal: document.getElementById('userModal'),
  userModalClose: document.getElementById('userModalClose'),
  userTableBody: document.getElementById('userTableBody'),
  newUsername: document.getElementById('newUsername'),
  newPassword: document.getElementById('newPassword'),
  newRole: document.getElementById('newRole'),
  addUserBtn: document.getElementById('addUserBtn'),
  userFormError: document.getElementById('userFormError')
};

boot();

async function boot() {
  // sessionStorage is cleared when the tab closes — if the flag is missing, log out
  if (!sessionStorage.getItem('ot_session')) {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login.html';
    return;
  }

  try {
    const me = await fetch('/api/me');
    if (me.status === 401) {
      sessionStorage.removeItem('ot_session');
      window.location.href = '/login.html';
      return;
    }
    const data = await me.json();
    state.currentUser = data.username;
    state.isMaster = !!data.isMaster;
    if (els.userName) els.userName.textContent = data.username + (data.isMaster ? ' (Master)' : '');
    if (els.userBar) els.userBar.hidden = false;
    if (els.manageUsersBtn && data.isMaster) els.manageUsersBtn.hidden = false;
  } catch {
    sessionStorage.removeItem('ot_session');
    window.location.href = '/login.html';
    return;
  }
  attachEvents();
  await Promise.all([loadUsers(), loadSchedule()]);
  await loadState();
  await loadActivity();
  await loadTeamDashboard();
  setupDeadlineAlerts();
}

function attachEvents() {
  els.refreshBtn.addEventListener('click', handleRefresh);
  // Debounce search — server-side filtering
  let searchTimer;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    currentPage = 1;
    searchTimer = setTimeout(loadState, 500);
  });
  if (els.categoryFilter) els.categoryFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  els.provinceFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  els.sourceFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  els.sortFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  if (els.deadlineFilter) els.deadlineFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  if (els.perPageFilter) els.perPageFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  if (els.scoreFilter) els.scoreFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  if (els.assignFilter) els.assignFilter.addEventListener('change', () => { currentPage = 1; loadState(); });
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', handleLogout);
  if (els.exportBtn) els.exportBtn.addEventListener('click', handleExport);

  // Schedule UI
  if (els.scheduleEditBtn) els.scheduleEditBtn.addEventListener('click', () => {
    els.scheduleInfo.hidden = true;
    els.scheduleEditor.hidden = false;
  });
  if (els.scheduleCancelBtn) els.scheduleCancelBtn.addEventListener('click', () => {
    els.scheduleEditor.hidden = true;
    els.scheduleInfo.hidden = false;
  });
  if (els.scheduleSaveBtn) els.scheduleSaveBtn.addEventListener('click', saveSchedule);

  // Change own password
  if (els.changePasswordBtn) els.changePasswordBtn.addEventListener('click', handleChangeOwnPassword);

  // User management modal
  if (els.manageUsersBtn) els.manageUsersBtn.addEventListener('click', openUserModal);
  if (els.userModalClose) els.userModalClose.addEventListener('click', closeUserModal);
  if (els.userModal) els.userModal.addEventListener('click', (e) => {
    if (e.target === els.userModal) closeUserModal();
  });
  if (els.addUserBtn) els.addUserBtn.addEventListener('click', handleAddUser);

  // Preview modal
  if (els.previewClose) els.previewClose.addEventListener('click', closePreview);
  if (els.previewModal) els.previewModal.addEventListener('click', (e) => {
    if (e.target === els.previewModal) closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.userModal && !els.userModal.hidden) closeUserModal();
      else if (els.previewModal && !els.previewModal.hidden) closePreview();
    }
  });

  // Event delegation for claim/unclaim/notes (click)
  els.tenderList.addEventListener('click', async (e) => {
    const bookmarkBtn = e.target.closest('[data-bookmark]');
    const claimBtn = e.target.closest('[data-claim]');
    const unclaimBtn = e.target.closest('[data-unclaim]');
    const noteBtn = e.target.closest('[data-add-note]');
    const delNoteBtn = e.target.closest('[data-del-note]');
    const toggleNotes = e.target.closest('[data-toggle-notes]');

    // Toggle details panel
    const expandBtn = e.target.closest('[data-toggle-details]');
    if (expandBtn) {
      const card = expandBtn.closest('.tender-card');
      const details = card?.querySelector('.tc-details');
      if (details) {
        const isHidden = details.hidden;
        details.hidden = !isHidden;
        expandBtn.classList.toggle('expanded', isHidden);
      }
      return;
    }

    // Intercept doc preview clicks
    const previewLink = e.target.closest('[data-preview]');
    if (previewLink) {
      e.preventDefault();
      openPreview(previewLink.dataset.preview, previewLink.dataset.previewTitle || 'Document');
      return;
    }

    if (bookmarkBtn) {
      bookmarkBtn.disabled = true;
      await toggleBookmark(bookmarkBtn.dataset.bookmark);
    } else if (claimBtn) {
      claimBtn.disabled = true;
      await claimTender(claimBtn.dataset.claim);
    } else if (unclaimBtn) {
      unclaimBtn.disabled = true;
      await unclaimTender(unclaimBtn.dataset.unclaim);
    } else if (noteBtn) {
      const tenderId = noteBtn.dataset.addNote;
      const input = document.querySelector(`[data-note-input="${tenderId}"]`);
      if (input && input.value.trim()) {
        noteBtn.disabled = true;
        await addNote(tenderId, input.value.trim());
      }
    } else if (delNoteBtn) {
      delNoteBtn.disabled = true;
      await deleteNote(delNoteBtn.dataset.tenderId, delNoteBtn.dataset.delNote);
    } else if (toggleNotes) {
      const panel = document.querySelector(`[data-notes-panel="${toggleNotes.dataset.toggleNotes}"]`);
      if (panel) panel.hidden = !panel.hidden;
    }
  });

  // Event delegation for status/priority/reassign (change)
  els.tenderList.addEventListener('change', async (e) => {
    const statusSelect = e.target.closest('[data-status-select]');
    const prioritySelect = e.target.closest('[data-priority-select]');
    const reassignSelect = e.target.closest('[data-reassign-select]');

    if (statusSelect) {
      await updateStatus(statusSelect.dataset.statusSelect, statusSelect.value);
    } else if (prioritySelect) {
      await updatePriority(prioritySelect.dataset.prioritySelect, prioritySelect.value);
    } else if (reassignSelect && reassignSelect.value) {
      if (confirm(`Reassign this tender to ${reassignSelect.value}?`)) {
        await reassignTender(reassignSelect.dataset.reassignSelect, reassignSelect.value);
      } else {
        reassignSelect.value = '';
      }
    }
  });

  // Submit note on Enter
  els.tenderList.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-note-input]')) {
      e.preventDefault();
      const tenderId = e.target.dataset.noteInput;
      if (e.target.value.trim()) {
        await addNote(tenderId, e.target.value.trim());
      }
    }
  });
}

async function handleLogout() {
  sessionStorage.removeItem('ot_session');
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

function handleExport() {
  window.location.href = '/api/export/csv';
}

// ── API calls ──

async function claimTender(id) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(id)}/claim`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showMessage(data.error || 'Failed to claim', 'error'); return; }
    await reloadAll();
  } catch { showMessage('Failed to claim tender', 'error'); }
}

async function unclaimTender(id) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(id)}/unclaim`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showMessage(data.error || 'Failed to unclaim', 'error'); return; }
    await reloadAll();
  } catch { showMessage('Failed to unclaim tender', 'error'); }
}

async function addNote(tenderId, text) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(tenderId)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) { showMessage('Failed to add note', 'error'); return; }
    await loadState();
    await loadActivity();
  } catch { showMessage('Failed to add note', 'error'); }
}

async function deleteNote(tenderId, noteId) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(tenderId)}/notes/${noteId}`, { method: 'DELETE' });
    if (!res.ok) { showMessage('Failed to delete note', 'error'); return; }
    await loadState();
  } catch { showMessage('Failed to delete note', 'error'); }
}

async function updateStatus(tenderId, status) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(tenderId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) { showMessage('Failed to update status', 'error'); return; }
    await reloadAll();
  } catch { showMessage('Failed to update status', 'error'); }
}

async function updatePriority(tenderId, priority) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(tenderId)}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority })
    });
    if (!res.ok) { showMessage('Failed to update priority', 'error'); return; }
    await reloadAll();
  } catch { showMessage('Failed to update priority', 'error'); }
}

async function reassignTender(tenderId, assignTo) {
  try {
    const res = await fetch(`/api/tenders/${encodeURIComponent(tenderId)}/reassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignTo })
    });
    if (!res.ok) { const d = await res.json(); showMessage(d.error || 'Failed to reassign', 'error'); return; }
    showMessage('Tender reassigned', 'success');
    await reloadAll();
  } catch { showMessage('Failed to reassign', 'error'); }
}

async function toggleBookmark(id) {
  try {
    const res = await fetch(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'POST' });
    if (!res.ok) { showMessage('Failed to bookmark', 'error'); return; }
    await loadState();
  } catch { showMessage('Failed to bookmark', 'error'); }
}

function openPreview(url, title) {
  if (!els.previewModal) return;
  els.previewTitle.textContent = title;
  els.previewDownload.href = url;

  const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(url);
  if (isImage) {
    els.previewBody.innerHTML = `<img src="${esc(url)}" class="preview-image" alt="${esc(title)}" />`;
  } else {
    els.previewBody.innerHTML = `<iframe src="${esc(url)}" class="preview-iframe" title="${esc(title)}"></iframe>`;
  }
  els.previewModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePreview() {
  if (!els.previewModal) return;
  els.previewModal.hidden = true;
  els.previewBody.innerHTML = '';
  document.body.style.overflow = '';
}

async function handleChangeOwnPassword() {
  const newPw = prompt('Enter your new password (min 6 chars):');
  if (!newPw) return;
  if (newPw.length < 6) { showMessage('Password must be at least 6 characters', 'error'); return; }
  try {
    const res = await fetch('/api/me/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPw })
    });
    const data = await res.json();
    if (!res.ok) { showMessage(data.error || 'Failed to change password', 'error'); return; }
    showMessage('Password changed successfully', 'success');
  } catch { showMessage('Failed to change password', 'error'); }
}

// ── User Management ──

async function openUserModal() {
  if (!els.userModal) return;
  els.userModal.hidden = false;
  document.body.style.overflow = 'hidden';
  await loadAdminUsers();
}

function closeUserModal() {
  if (!els.userModal) return;
  els.userModal.hidden = true;
  document.body.style.overflow = '';
  if (els.userFormError) els.userFormError.hidden = true;
}

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) return;
    const data = await res.json();
    renderAdminUsers(data.users || []);
  } catch { /* ignore */ }
}

function renderAdminUsers(users) {
  if (!els.userTableBody) return;
  els.userTableBody.innerHTML = users.map(u => {
    const isSelf = u.username === state.currentUser;
    const roleClass = u.role === 'master' ? 'role-master' : 'role-member';
    const created = u.createdAt ? fmtDate(u.createdAt) : 'N/A';
    return `<tr>
      <td class="ut-user">${esc(u.username)}${isSelf ? ' <span class="ut-you">(you)</span>' : ''}</td>
      <td><span class="user-role-badge ${roleClass}">${esc(u.role)}</span></td>
      <td class="ut-date">${created}</td>
      <td class="ut-actions">
        ${!isSelf ? `
          <select class="user-role-select" data-role-user="${esc(u.username)}" data-current-role="${esc(u.role)}">
            <option value="member"${u.role === 'member' ? ' selected' : ''}>Member</option>
            <option value="master"${u.role === 'master' ? ' selected' : ''}>Master</option>
          </select>
          <button class="user-pw-btn" data-pw-user="${esc(u.username)}">Password</button>
          <button class="user-del-btn" data-del-user="${esc(u.username)}">Delete</button>
        ` : '<span class="ut-na">—</span>'}
      </td>
    </tr>`;
  }).join('');

  // Wire role change
  els.userTableBody.querySelectorAll('[data-role-user]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const username = sel.dataset.roleUser;
      const newRole = sel.value;
      if (newRole === sel.dataset.currentRole) return;
      if (!confirm(`Change ${username}'s role to ${newRole}?`)) {
        sel.value = sel.dataset.currentRole;
        return;
      }
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole })
        });
        const data = await res.json();
        if (!res.ok) { showMessage(data.error || 'Failed to change role', 'error'); sel.value = sel.dataset.currentRole; return; }
        showMessage(`${username} is now ${newRole}`, 'success');
        await loadAdminUsers();
        await loadUsers();
      } catch { showMessage('Failed to change role', 'error'); sel.value = sel.dataset.currentRole; }
    });
  });

  // Wire password reset
  els.userTableBody.querySelectorAll('[data-pw-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.pwUser;
      const newPw = prompt(`Enter new password for "${username}" (min 6 chars):`);
      if (!newPw) return;
      if (newPw.length < 6) { showMessage('Password must be at least 6 characters', 'error'); return; }
      btn.disabled = true;
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/password`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPw })
        });
        const data = await res.json();
        if (!res.ok) { showMessage(data.error || 'Failed to reset password', 'error'); btn.disabled = false; return; }
        showMessage(`Password reset for "${username}"`, 'success');
      } catch { showMessage('Failed to reset password', 'error'); }
      btn.disabled = false;
    });
  });

  // Wire delete
  els.userTableBody.querySelectorAll('[data-del-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.delUser;
      if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) { showMessage(data.error || 'Failed to delete user', 'error'); btn.disabled = false; return; }
        showMessage(`User "${username}" deleted`, 'success');
        await loadAdminUsers();
        await loadUsers();
      } catch { showMessage('Failed to delete user', 'error'); btn.disabled = false; }
    });
  });
}

async function handleAddUser() {
  const username = els.newUsername.value.trim().toLowerCase();
  const password = els.newPassword.value;
  const role = els.newRole.value;

  if (els.userFormError) els.userFormError.hidden = true;

  if (!username || !password) {
    showUserFormError('Username and password required');
    return;
  }
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    showUserFormError('Username: 3-30 chars, lowercase letters/numbers/underscore');
    return;
  }
  if (password.length < 6) {
    showUserFormError('Password must be at least 6 characters');
    return;
  }

  els.addUserBtn.disabled = true;
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });
    const data = await res.json();
    if (!res.ok) {
      showUserFormError(data.error || 'Failed to add user');
      els.addUserBtn.disabled = false;
      return;
    }
    showMessage(`User "${username}" added as ${role}`, 'success');
    els.newUsername.value = '';
    els.newPassword.value = '';
    els.newRole.value = 'member';
    await loadAdminUsers();
    await loadUsers();
  } catch {
    showUserFormError('Failed to add user');
  }
  els.addUserBtn.disabled = false;
}

function showUserFormError(msg) {
  if (els.userFormError) {
    els.userFormError.textContent = msg;
    els.userFormError.hidden = false;
  }
}

/** Reload tenders, activity, and team dashboard together */
async function reloadAll() {
  await Promise.all([loadState(), loadActivity(), loadTeamDashboard()]);
}

async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    state.knownUsers = data.users || [];
  } catch { /* ignore */ }
}

async function loadSchedule() {
  try {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    state.schedule = data;
    renderSchedule();
  } catch { /* ignore */ }
}

async function saveSchedule() {
  const value = els.scheduleSelect.value;
  const enabled = value !== 'disabled';
  try {
    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: enabled ? value : state.schedule.cron, enabled })
    });
    if (!res.ok) { const d = await res.json(); showMessage(d.error || 'Failed to save', 'error'); return; }
    const data = await res.json();
    state.schedule = { ...state.schedule, ...data };
    showMessage('Schedule updated', 'success');
    els.scheduleEditor.hidden = true;
    els.scheduleInfo.hidden = false;
    renderSchedule();
  } catch { showMessage('Failed to save schedule', 'error'); }
}

function renderSchedule() {
  if (!state.schedule || !els.scheduleInfo) return;
  const s = state.schedule;
  els.scheduleLabel.textContent = s.enabled ? `Auto: ${s.label}` : 'Auto-refresh off';
  els.scheduleInfo.hidden = false;

  if (state.isMaster && els.scheduleEditBtn) els.scheduleEditBtn.hidden = false;

  // Populate preset dropdown
  if (els.scheduleSelect && s.presets) {
    els.scheduleSelect.innerHTML = s.presets.map(p =>
      `<option value="${esc(p.value)}"${p.value === s.cron ? ' selected' : ''}>${esc(p.label)}</option>`
    ).join('') + `<option value="disabled"${!s.enabled ? ' selected' : ''}>Disabled</option>`;
  }
}

async function loadState() {
  try {
    const params = buildFilterParams();
    const res = await fetch('/api/tenders?' + params.toString());
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    state.tenders = data.tenders || [];
    state.sources = data.sources || [];
    state.meta = data.meta || {};
    state.pagination = data.pagination || {};
    state.filterOptions = data.filterOptions || {};
    syncFilters();
    renderFromServer();
    if (!state.meta.lastRefreshAt) {
      showMessage('No data yet. Press Refresh to scan all portals.', 'info');
    }
  } catch (err) {
    showMessage(`Failed to load: ${err.message}`, 'error');
  }
}

function buildFilterParams() {
  const params = new URLSearchParams();
  const q = els.searchInput.value.trim();
  if (q) params.set('q', q);
  const cat = els.categoryFilter ? els.categoryFilter.value : 'all';
  if (cat !== 'all') params.set('category', cat);
  const prov = els.provinceFilter.value;
  if (prov !== 'all') params.set('province', prov);
  const src = els.sourceFilter.value;
  if (src !== 'all') params.set('source', src);
  const dl = els.deadlineFilter ? els.deadlineFilter.value : 'all';
  if (dl !== 'all') params.set('deadline', dl);
  const sort = els.sortFilter.value;
  if (sort) params.set('sort', sort);
  const sc = els.scoreFilter ? els.scoreFilter.value : 'all';
  if (sc !== 'all') params.set('score', sc);
  const assign = els.assignFilter ? els.assignFilter.value : 'all';
  if (assign !== 'all') params.set('assign', assign);
  // Country filter from pill selector
  if (activeCountries.size > 0) {
    params.set('countries', [...activeCountries].join(','));
  }
  params.set('page', String(currentPage));
  const perPageVal = els.perPageFilter ? els.perPageFilter.value : '50';
  params.set('limit', perPageVal);
  return params;
}

async function loadActivity() {
  try {
    const res = await fetch('/api/activity');
    state.activity = await res.json();
    renderActivity();
  } catch { /* ignore */ }
}

async function loadTeamDashboard() {
  try {
    const res = await fetch('/api/team-dashboard');
    const data = await res.json();
    state.teamData = data.team || [];
    renderTeamDashboard();
  } catch { /* ignore */ }
}

async function handleRefresh() {
  const startTime = Date.now();
  let timerInterval = null;
  let evtSource = null;

  // Build overlay
  const overlay = document.createElement('div');
  overlay.className = 'refresh-overlay';
  overlay.innerHTML = `
    <div class="refresh-panel">
      <div class="refresh-panel-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--pink)" stroke-width="2.5" class="spin"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        <span>Refreshing Tender Data</span>
        <span class="refresh-timer" id="refreshTimer">0s</span>
        <button class="refresh-close-btn" id="refreshCloseBtn" title="Minimize">&times;</button>
      </div>
      <div class="refresh-progress-bar"><div class="refresh-progress-fill" id="refreshFill"></div></div>
      <div class="refresh-status" id="refreshStatus">Connecting...</div>
      <div class="refresh-log" id="refreshLog"></div>
    </div>`;
  document.body.appendChild(overlay);

  const timerEl = overlay.querySelector('#refreshTimer');
  const fillEl = overlay.querySelector('#refreshFill');
  const statusEl = overlay.querySelector('#refreshStatus');
  const logEl = overlay.querySelector('#refreshLog');
  const closeBtn = overlay.querySelector('#refreshCloseBtn');
  closeBtn.addEventListener('click', () => {
    overlay.classList.add('refresh-overlay--closing');
    setTimeout(() => overlay.remove(), 400);
  });

  function fmtTime() {
    const s = Math.floor((Date.now() - startTime) / 1000);
    return s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
  }

  function addLog(text, type) {
    const div = document.createElement('div');
    div.className = 'refresh-log-item' + (type ? ' refresh-log--' + type : '');
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  try {
    els.refreshBtn.disabled = true;
    timerInterval = setInterval(() => { timerEl.textContent = fmtTime(); }, 1000);

    // Open SSE stream for live progress
    statusEl.textContent = 'Starting refresh...';
    addLog('Starting refresh...', null);

    // Fire POST to start refresh (server responds immediately, runs refresh async)
    const refreshRes = await fetch('/api/refresh', { method: 'POST' });
    const refreshData = await refreshRes.json();
    if (!refreshRes.ok || !refreshData.ok) throw new Error(refreshData.error || 'Refresh failed');

    // Small delay, then connect SSE for live progress
    await new Promise(r => setTimeout(r, 200));

    // Wait for the SSE "done" event to know refresh actually completed
    await new Promise((resolve, reject) => {
      evtSource = new EventSource('/api/refresh/progress');
      let gotFirstEvent = false;
      const sseTimeout = setTimeout(() => {
        // Safety: if no done event after 15 min, assume failure
        reject(new Error('Refresh timed out'));
      }, 15 * 60 * 1000);

      evtSource.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          gotFirstEvent = true;
          statusEl.textContent = d.detail;
          addLog(d.detail, d.step === 'done' ? 'ok' : null);
          if (d.total) {
            const pct = Math.round((d.done / d.total) * 60);
            fillEl.style.width = pct + '%';
          }
          if (d.step === 'parsing') fillEl.style.width = '65%';
          if (d.step === 'dedup') fillEl.style.width = '67%';
          if (d.step === 'scoring') fillEl.style.width = '70%';
          if (d.step === 'pdf') fillEl.style.width = '75%';
          if (d.step === 'ai') fillEl.style.width = '82%';
          if (d.step === 'ai-pdf') fillEl.style.width = '90%';
          if (d.step === 'saving') fillEl.style.width = '95%';
          if (d.step === 'done') {
            fillEl.style.width = '100%';
            clearTimeout(sseTimeout);
            resolve();
          }
        } catch {}
      };
      evtSource.onerror = () => {
        if (!gotFirstEvent) { /* SSE reconnects automatically */ }
      };
    });

    // Refresh done — reload data
    await loadState();
    await loadActivity();
    await loadTeamDashboard();

    const totalTenders = state.pagination?.totalAll || state.tenders.length;
    statusEl.textContent = `Done in ${fmtTime()} — ${totalTenders} tenders`;
    addLog(`Refresh complete in ${fmtTime()}`, 'ok');

    // Auto-close overlay after 1.5s
    setTimeout(() => { overlay.classList.add('refresh-overlay--closing'); }, 1200);
    setTimeout(() => { overlay.remove(); }, 1600);
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    addLog(`Error: ${err.message}`, 'error');
    setTimeout(() => { overlay.classList.add('refresh-overlay--closing'); }, 3000);
    setTimeout(() => { overlay.remove(); }, 3400);
  } finally {
    if (timerInterval) clearInterval(timerInterval);
    if (evtSource) evtSource.close();
    els.refreshBtn.disabled = false;
    els.refreshBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg> Refresh`;
  }
}

function syncFilters() {
  const fo = state.filterOptions || {};
  const categories = ['all', ...(fo.categories || [])];
  const provinces = ['all', ...(fo.provinces || [])];
  const sources = ['all', ...(fo.sources || [])];

  if (els.categoryFilter) syncSelect(els.categoryFilter, categories, 'All categories');
  syncSelect(els.provinceFilter, provinces, 'All provinces');
  syncSelect(els.sourceFilter, sources, 'All sources');
}

function syncSelect(el, values, allLabel) {
  const cur = el.value || 'all';
  el.innerHTML = values.map(v => `<option value="${esc(v)}">${v === 'all' ? allLabel : esc(v)}</option>`).join('');
  el.value = values.includes(cur) ? cur : 'all';
}

// Server-side render: tenders are already filtered, sorted, paginated by the API
function renderFromServer() {
  const pg = state.pagination || {};
  const totalFiltered = pg.totalFiltered || state.tenders.length;
  const totalAll = pg.totalAll || totalFiltered;
  const totalPages = pg.totalPages || 1;
  currentPage = pg.page || 1;

  els.verifiedCount.textContent = totalAll;
  const onlineCount = state.sources.filter(s => s.ok).length;
  els.sourceCount.textContent = `${onlineCount}/${state.sources.length}`;
  els.lastRefresh.textContent = state.meta.lastRefreshAt ? fmtDateTime(state.meta.lastRefreshAt) : 'Never';

  // Country count
  const countryCountEl = document.getElementById('countryCount');
  if (countryCountEl) {
    const countries = new Set(state.sources.map(s => s.country || s.province || 'Pakistan').filter(Boolean));
    countryCountEl.textContent = countries.size;
  }

  renderCountrySelector();

  if (els.resultsHint) {
    const perPageVal = els.perPageFilter ? els.perPageFilter.value : '50';
    const hasActiveFilter = els.searchInput.value.trim() ||
      (els.categoryFilter && els.categoryFilter.value !== 'all') ||
      els.provinceFilter.value !== 'all' ||
      els.sourceFilter.value !== 'all' ||
      (els.deadlineFilter && els.deadlineFilter.value !== 'all') ||
      (els.scoreFilter && els.scoreFilter.value !== 'all') ||
      (els.assignFilter && els.assignFilter.value !== 'all');
    if (!hasActiveFilter && perPageVal === 'all') {
      els.resultsHint.textContent = `Showing all ${totalFiltered} tenders`;
    } else if (!hasActiveFilter) {
      els.resultsHint.textContent = `Page ${currentPage} of ${totalPages} · ${totalFiltered} tenders`;
    } else {
      els.resultsHint.textContent = `Page ${currentPage} of ${totalPages} · ${totalFiltered} tenders (filtered)`;
    }
  }

  renderTenders(state.tenders);
  renderPagination(totalPages);
  renderSources();
}

// Kept for backward compat (refresh endpoint still returns full data)
function render() {
  renderFromServer();
}

function renderTenders(items) {
  if (!items.length) {
    const hasFilters = els.searchInput.value || (els.categoryFilter && els.categoryFilter.value !== 'all') || els.provinceFilter.value !== 'all' || els.sourceFilter.value !== 'all' || (els.deadlineFilter && els.deadlineFilter.value !== 'all') || (els.scoreFilter && els.scoreFilter.value !== 'all') || (els.assignFilter && els.assignFilter.value !== 'all');
    els.tenderList.innerHTML = `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:16px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <strong>${hasFilters ? 'No tenders match your filters' : 'No tenders yet'}</strong>
      <p>${hasFilters ? 'Try removing some filters or broadening your search query. You have ' + state.tenders.length + ' total tenders loaded.' : 'Click the Refresh button to scan all 7 government portals. First scan takes a few minutes.'}</p>
    </div>`;
    return;
  }

  const otherUsers = state.knownUsers.filter(u => u !== state.currentUser);

  els.tenderList.innerHTML = items.map(t => {
    const days = daysLeft(t.closing);
    const hasDate = !!t.closing;
    const urgency = !hasDate ? 'normal' : days <= 1 ? 'urgent' : days <= 5 ? 'soon' : 'normal';
    const urgLabel = !hasDate ? 'No date' : days < 0 ? 'Expired' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days}d left`;
    const score = Number(t.fitScore || 0);
    const sc = score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
    const rawRef = t.officialRef || t.referenceNumber || '';
    // Skip refs that are too long (likely title duplicates) or generic
    const ref = rawRef.length > 30 || /^tender\s+notice$/i.test(rawRef) ? '' : rawRef;
    const tags = (t.fitTags || []).filter(Boolean);
    const allTags = [...tags, ...(t.pdfKeywords || [])];
    const closingDate = parseDate(t.closing);
    const dayNum = closingDate ? closingDate.getDate() : '\u2014';
    const monthStr = closingDate ? closingDate.toLocaleString('en', { month: 'short' }).toUpperCase() : '';
    const portalUrl = t.sourceUrl || '';
    const tenderNotes = t.notes || [];
    const cs = t.claimStatus || null;
    const pri = t.priority || null;

    // Status + priority + duplicate pills in header
    let extraPills = '';
    if (cs) extraPills += `<span class="pill pill--status-${cs}">${esc(STATUS_LABELS[cs] || cs)}</span>`;
    if (pri) extraPills += `<span class="pill pill--priority-${pri}">${esc(PRIORITY_LABELS[pri] || pri)}</span>`;
    if (t.duplicateOf) extraPills += `<span class="pill pill--duplicate" title="Also on ${esc(t.duplicateSource)}">Duplicate</span>`;

    // Assignment / action bar
    let actionBar = '';
    const canManage = t.assignedTo === state.currentUser || (t.assignedTo && state.isMaster);
    if (canManage) {
      const statusOpts = Object.entries(STATUS_LABELS).map(([val, lbl]) =>
        `<option value="${val}"${cs === val ? ' selected' : ''}>${lbl}</option>`
      ).join('');
      const priorityOpts = `<option value=""${!pri ? ' selected' : ''}>Priority</option>` +
        Object.entries(PRIORITY_LABELS).map(([val, lbl]) =>
          `<option value="${val}"${pri === val ? ' selected' : ''}>${lbl}</option>`
        ).join('');
      const allOtherUsers = state.knownUsers.filter(u => u !== t.assignedTo);
      const reassignOpts = `<option value="">Reassign...</option>` +
        allOtherUsers.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
      const ownerLabel = t.assignedTo !== state.currentUser ? `<span class="assign-badge assign-badge--other">Owner: ${esc(t.assignedTo)}</span>` : '';

      actionBar = `<div class="tc-action-bar">
        ${ownerLabel}
        <select class="status-select" data-status-select="${esc(t.id)}">${statusOpts}</select>
        <select class="priority-select" data-priority-select="${esc(t.id)}">${priorityOpts}</select>
        ${allOtherUsers.length ? `<select class="reassign-select" data-reassign-select="${esc(t.id)}">${reassignOpts}</select>` : ''}
        <button class="assign-btn assign-btn--unclaim" data-unclaim="${esc(t.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Release
        </button>
      </div>`;
    } else if (t.assignedTo) {
      actionBar = `<div class="tc-action-bar">
        <span class="assign-badge assign-badge--other">Claimed by ${esc(t.assignedTo)}</span>
        ${cs ? `<span class="status-badge status-badge--${cs}">${esc(STATUS_LABELS[cs] || cs)}</span>` : ''}
        ${pri ? `<span class="priority-badge priority-badge--${pri}">${esc(PRIORITY_LABELS[pri] || pri)}</span>` : ''}
      </div>`;
    } else {
      actionBar = `<div class="tc-action-bar">
        <button class="assign-btn assign-btn--claim" data-claim="${esc(t.id)}" title="Assign this tender to yourself">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          Claim for Me
        </button>
      </div>`;
    }

    // Notes UI
    const noteCount = tenderNotes.length;
    const notesHtml = `<div class="notes-section">
      <button class="notes-toggle" data-toggle-notes="${esc(t.id)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        ${noteCount ? `${noteCount} note${noteCount > 1 ? 's' : ''}` : 'Add note'}
      </button>
      <div class="notes-panel" data-notes-panel="${esc(t.id)}" hidden>
        ${tenderNotes.map(n => `<div class="note-item">
          <div class="note-meta"><strong>${esc(n.user)}</strong> &middot; ${fmtRelative(n.at)}</div>
          <div class="note-text">${esc(n.text)}</div>
          ${n.user === state.currentUser ? `<button class="note-del" data-del-note="${esc(n.id)}" data-tender-id="${esc(t.id)}">&times;</button>` : ''}
        </div>`).join('')}
        <div class="note-add">
          <input class="note-input" data-note-input="${esc(t.id)}" placeholder="Add a note..." maxlength="500" />
          <button class="note-send" data-add-note="${esc(t.id)}">Add</button>
        </div>
      </div>
    </div>`;

    // Build footer links
    let footerLinks = '';
    const hasDocs = t.tenderNoticeUrl || t.biddingDocUrl;
    if (hasDocs) {
      if (portalUrl) footerLinks += `<a class="tc-link" href="${esc(portalUrl)}" target="_blank" rel="noreferrer noopener">View on Portal &rarr;</a>`;
      if (t.tenderNoticeUrl) footerLinks += `<a class="tc-link tc-link--doc" href="${esc(t.tenderNoticeUrl)}" data-preview="${esc(t.tenderNoticeUrl)}" data-preview-title="Tender Doc — ${esc(t.title.slice(0, 60))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Tender Doc</a>`;
      if (t.biddingDocUrl) footerLinks += `<a class="tc-link tc-link--doc" href="${esc(t.biddingDocUrl)}" data-preview="${esc(t.biddingDocUrl)}" data-preview-title="Bidding Doc — ${esc(t.title.slice(0, 60))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> Bidding Doc</a>`;
    } else {
      footerLinks = `<a class="tc-link" href="${esc(portalUrl)}" target="_blank" rel="noreferrer noopener">View on Portal &rarr;</a>`;
    }

    // Tags (show max 3 inline, rest in tooltip)
    const visibleTags = allTags.slice(0, 3);
    const hiddenCount = allTags.length - 3;
    let tagsHtml = visibleTags.map((tg, i) =>
      `<span class="tc-tag${i >= tags.length ? ' tc-tag--pdf' : ''}">${esc(tg)}</span>`
    ).join('');
    if (hiddenCount > 0) tagsHtml += `<span class="tc-tag tc-tag--more" title="${esc(allTags.slice(3).join(', '))}">+${hiddenCount} more</span>`;
    if (!allTags.length) tagsHtml = '';

    const starIcon = t.bookmarked
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

    // Build details — extra info not shown in the meta row
    let detailCells = '';
    if (t.organization) detailCells += detail('Organization', t.organization);
    if (t.ministry) detailCells += detail('Ministry', t.ministry);
    if (t.advertised) detailCells += detail('Published', fmtDate(t.advertised));
    if (t.sector) detailCells += detail('Sector', t.sector);
    if (t.closingTime) detailCells += detail('Closes At', t.closingTime);
    if (t.fitReason) detailCells += detail('Relevance', t.fitReason);
    if (t.type) detailCells += detail('Type', t.type);
    if (t.aiSector) detailCells += detail('AI Sector', t.aiSector);
    if (t.aiScore !== undefined && t.aiScore !== null) detailCells += detail('AI Score', `${t.aiScore}/100`);

    // PDF deep analysis fields
    const pa = t.pdfAnalysis;
    if (pa) {
      if (pa.estimatedBudget) detailCells += detail('Est. Budget', pa.estimatedBudget);
      if (pa.eligibility) detailCells += detail('Eligibility', pa.eligibility);
      if (pa.submissionMethod) detailCells += detail('Submission', pa.submissionMethod);
      if (pa.bidSecurity) detailCells += detail('Bid Security', pa.bidSecurity);
      if (pa.contactInfo) detailCells += detail('Contact', pa.contactInfo);
      if (pa.requirements && pa.requirements.length) {
        detailCells += `<div class="tc-detail tc-detail--wide"><div class="tc-detail-label">Requirements</div><div class="tc-detail-value"><ul class="tc-req-list">${pa.requirements.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div></div>`;
      }
      if (pa.relevanceFit || pa.evrimFit) detailCells += detail('Relevance', pa.relevanceFit || pa.evrimFit);
    }

    // Compact source label
    const sourceShort = (t.source || '').replace('Punjab e-Procurement', 'Punjab').replace('PPRA (EPMS)', 'PPRA').replace('PPRA (EPADS v2)', 'EPADS').replace('KPPRA KPK', 'KPPRA').replace('AJK PPRA', 'AJK');
    const catLabel = t.category && t.category !== 'General' ? t.category : '';
    const metaParts = [sourceShort, t.province || '', catLabel].filter(Boolean).join(' · ');

    return `<article class="tender-card tender-card--${urgency}${t.assignedTo ? ' tender-card--claimed' : ''}${t.bookmarked ? ' tender-card--bookmarked' : ''}">
      <div class="tc-main">
        <div class="tc-body">
          <div class="tc-header-row">
            <span class="tc-meta-line">${esc(metaParts)}</span>
            <div class="tc-deadline-inline ${urgency}">
              <span class="dl-date">${dayNum} ${monthStr}${t.closingTime ? ' · ' + esc(t.closingTime) : ''}</span>
              <span class="dl-left">${esc(urgLabel)}</span>
            </div>
          </div>
          <h3 class="tc-title">${t.isNew ? '<span class="new-badge">NEW</span>' : ''}${esc(t.title)}</h3>
          <p class="tc-org">${esc(t.organization)}${t.city ? ' · ' + esc(t.city) : ''}${ref ? ' · <code>' + esc(ref) + '</code>' : ''}</p>
          ${t.aiSummary ? `<p class="tc-ai-summary">${esc(t.aiSummary)}</p>` : (t.description ? `<p class="tc-description">${esc(t.description)}</p>` : '')}
        </div>
        <div class="tc-side">
          <button class="bookmark-btn${t.bookmarked ? ' bookmarked' : ''}" data-bookmark="${esc(t.id)}" title="${t.bookmarked ? 'Remove bookmark' : 'Bookmark'}">${starIcon}</button>
          <span class="score-badge ${sc}">${score}</span>
        </div>
      </div>
      <div class="tc-footer">
        ${actionBar}
        <div class="tc-footer-right">
          <button class="tc-expand-btn" data-toggle-details="${esc(t.id)}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            Details
          </button>
          <div class="tc-links">${footerLinks}</div>
        </div>
      </div>
      <div class="tc-details" hidden>
        ${detailCells}
      </div>
      ${notesHtml}
    </article>`;
  }).join('');
}

function renderSources() {
  if (!state.sources.length) {
    els.sourcesList.innerHTML = `<div class="empty-state"><strong>No portal data yet</strong><p>Portal status appears after you click Refresh. Each portal is scraped and verified independently.</p></div>`;
    return;
  }

  els.sourcesList.innerHTML = state.sources.map(s => {
    const ok = s.ok && s.status === 'ok';
    const portalUrl = s.sourceUrl || '';
    const errorText = s.error ? s.error.split('\n')[0].slice(0, 80) : '';
    const flag = s.flag || (s.country === 'Pakistan' ? '🇵🇰' : s.country === 'Bangladesh' ? '🇧🇩' : s.country === 'Kenya' ? '🇰🇪' : '🌍');
    const country = s.country || s.province || '';
    const isGlobal = country && !['Pakistan', 'Federal', 'Punjab', 'Khyber Pakhtunkhwa', 'AJK', 'Sindh', 'Balochistan'].includes(country);
    return `<div class="source-card ${ok ? '' : 'down'} ${isGlobal ? 'source-card-global' : ''}">
      <span class="source-flag">${flag}</span>
      <span class="src-dot ${ok ? 'ok' : 'bad'}"></span>
      <div class="src-info">
        <div class="src-name">${esc(s.label)}</div>
        <div class="src-province">${esc(country || s.province || '')}</div>
        ${errorText ? `<div class="src-error">${esc(errorText)}</div>` : ''}
        ${portalUrl ? `<a class="src-link" href="${esc(portalUrl)}" target="_blank" rel="noopener">Visit Portal &rarr;</a>` : ''}
      </div>
      <div class="src-nums">
        <div class="src-num"><strong>${s.candidateCount ?? 0}</strong><span>Scraped</span></div>
        <div class="src-num src-num--verified"><strong>${s.verifiedCount ?? 0}</strong><span>Verified</span></div>
      </div>
    </div>`;
  }).join('');
}

// ── Country Selector ─────────────────────────────────────────────────────────

let activeCountries = new Set(); // empty = show all

function renderCountrySelector() {
  const container = document.getElementById('countrySelector');
  if (!container) return;

  // Build country → tender count map from current tenders
  const countryTenderMap = {};
  for (const t of state.tenders) {
    const c = t.country || (t.province && !['Federal', 'Punjab', 'Khyber Pakhtunkhwa', 'AJK', 'Sindh', 'Balochistan'].includes(t.province) ? t.province : 'Pakistan');
    countryTenderMap[c] = (countryTenderMap[c] || 0) + 1;
  }

  // Also build from sources even if no tenders yet
  for (const s of state.sources) {
    const c = s.country || (s.province ? 'Pakistan' : 'Global');
    if (!countryTenderMap[c]) countryTenderMap[c] = 0;
  }

  const COUNTRY_FLAGS = {
    'Pakistan': '🇵🇰', 'Bangladesh': '🇧🇩', 'Kenya': '🇰🇪', 'Global': '🌍',
    'Africa (Multi)': '🌍', 'Africa': '🌍'
  };

  const countries = Object.keys(countryTenderMap).sort();
  if (!countries.length) { container.innerHTML = ''; return; }

  container.innerHTML = countries.map(country => {
    const flag = COUNTRY_FLAGS[country] || '🌐';
    const count = countryTenderMap[country] || 0;
    const active = activeCountries.has(country) || activeCountries.size === 0;
    return `<button class="country-pill ${activeCountries.has(country) ? 'active' : ''}" data-country="${esc(country)}">
      <span class="country-pill-flag">${flag}</span>
      <span>${esc(country)}</span>
      <span class="country-pill-count">${count}</span>
    </button>`;
  }).join('');

  container.querySelectorAll('.country-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const country = pill.dataset.country;
      if (activeCountries.has(country)) {
        activeCountries.delete(country);
      } else {
        activeCountries.add(country);
      }
      renderCountrySelector();
      currentPage = 1;
      loadState();
    });
  });
}

function renderPagination(totalPages) {
  if (!els.pagination) return;
  if (totalPages <= 1) { els.pagination.innerHTML = ''; return; }

  let html = '';
  // Previous button
  html += `<button class="pg-btn${currentPage === 1 ? ' disabled' : ''}" data-page="${currentPage - 1}"${currentPage === 1 ? ' disabled' : ''}>&laquo; Prev</button>`;

  // Page numbers — show first, last, current ± 2, with ellipsis
  const pages = new Set([1, totalPages]);
  for (let p = Math.max(1, currentPage - 2); p <= Math.min(totalPages, currentPage + 2); p++) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += '<span class="pg-dots">&hellip;</span>';
    html += `<button class="pg-btn${p === currentPage ? ' pg-active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }

  // Next button
  html += `<button class="pg-btn${currentPage === totalPages ? ' disabled' : ''}" data-page="${currentPage + 1}"${currentPage === totalPages ? ' disabled' : ''}>Next &raquo;</button>`;

  els.pagination.innerHTML = html;
  els.pagination.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = Number(btn.dataset.page);
      if (p >= 1 && p <= totalPages && p !== currentPage) {
        currentPage = p;
        loadState();
        window.scrollTo({ top: els.tenderList.offsetTop - 80, behavior: 'smooth' });
      }
    });
  });
}

function renderActivity() {
  if (!els.activityList) return;
  const items = state.activity.slice(0, 30);
  if (!items.length) {
    els.activityList.innerHTML = '<div class="empty-state"><strong>No activity yet</strong></div>';
    return;
  }
  els.activityList.innerHTML = items.map(a => {
    const icon = { claim: '\u2705', unclaim: '\u274c', note: '\ud83d\udcdd', refresh: '\ud83d\udd04', status_change: '\ud83d\udce6', priority_change: '\u26a1', reassign: '\ud83d\udd00', user_add: '\ud83d\udc64', user_delete: '\ud83d\udeab', user_role: '\ud83d\udd11', user_password: '\ud83d\udd12' }[a.action] || '\ud83d\udd04';
    const desc = {
      claim: 'claimed a tender',
      unclaim: 'unclaimed a tender',
      note: `added a note${a.detail ? ': "' + esc(a.detail.slice(0, 50)) + '"' : ''}`,
      refresh: `refreshed portals (${esc(a.detail || '')})`,
      status_change: `changed status: ${esc(a.detail || '')}`,
      priority_change: `set priority to ${esc(a.detail || '')}`,
      reassign: `reassigned tender ${esc(a.detail || '')}`,
      user_add: esc(a.detail || 'added a user'),
      user_delete: esc(a.detail || 'deleted a user'),
      user_role: `changed role: ${esc(a.detail || '')}`,
      user_password: esc(a.detail || 'reset a password')
    }[a.action] || a.action;
    return `<div class="activity-item">
      <span class="activity-icon">${icon}</span>
      <span class="activity-text"><strong>${esc(a.user)}</strong> ${desc}</span>
      <span class="activity-time">${fmtRelative(a.at)}</span>
    </div>`;
  }).join('');
}

function renderTeamDashboard() {
  if (!els.teamDashboard || !els.teamGrid) return;

  if (!state.teamData.length) {
    els.teamDashboard.hidden = true;
    return;
  }

  els.teamDashboard.hidden = false;
  els.teamGrid.innerHTML = state.teamData.map(u => {
    const statusPills = Object.entries(u.statuses).map(([s, count]) =>
      `<span class="status-badge status-badge--${s}">${count} ${STATUS_LABELS[s] || s}</span>`
    ).join('');

    const priorityPills = Object.entries(u.priorities).map(([p, count]) =>
      `<span class="priority-badge priority-badge--${p}">${count} ${PRIORITY_LABELS[p] || p}</span>`
    ).join('');

    const tenders = (u.tenders || u.deadlines || []);
    const tenderListHtml = tenders.length ? `<ul class="team-tender-list">${tenders.map(t => {
      const label = esc((t.title || 'Untitled').slice(0, 60)) + (t.title && t.title.length > 60 ? '…' : '');
      const statusCls = `status-badge--${t.status || 'claimed'}`;
      const priorityCls = t.priority ? `priority-badge--${t.priority}` : '';
      const deadlineStr = t.closing ? (() => { const d = daysLeft(t.closing); const urg = d <= 1 ? 'color:var(--red)' : d <= 5 ? 'color:var(--orange)' : ''; return ` <span class="team-tender-deadline" style="${urg}">${d}d</span>`; })() : '';
      const link = t.sourceUrl ? `<a href="${esc(t.sourceUrl)}" target="_blank" rel="noopener" class="team-tender-link" title="${esc(t.title || '')}">${label}</a>` : `<span class="team-tender-title">${label}</span>`;
      return `<li class="team-tender-item">
        <span class="status-dot ${statusCls}"></span>
        ${link}${priorityCls ? ` <span class="priority-pip ${priorityCls}"></span>` : ''}${deadlineStr}
      </li>`;
    }).join('')}</ul>` : '';

    return `<div class="team-card">
      <div class="team-card-header">
        <span class="team-user">${esc(u.username)}</span>
        <span class="team-count">${u.count} tender${u.count !== 1 ? 's' : ''}</span>
      </div>
      <div class="team-statuses">${statusPills}${priorityPills ? ' ' + priorityPills : ''}</div>
      ${tenderListHtml}
    </div>`;
  }).join('');
}

// ── Deadline alerts (browser notifications) ──

function setupDeadlineAlerts() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
  checkDeadlines();
  setInterval(checkDeadlines, 30 * 60 * 1000);
}

function checkDeadlines() {
  if (Notification.permission !== 'granted') return;
  const myTenders = state.tenders.filter(t => t.assignedTo === state.currentUser);
  for (const t of myTenders) {
    const days = daysLeft(t.closing);
    if (days >= 0 && days <= 2) {
      const urgLabel = days === 0 ? 'TODAY' : days === 1 ? 'TOMORROW' : 'in 2 days';
      new Notification(`Tender deadline ${urgLabel}`, {
        body: t.title.slice(0, 100),
        tag: `deadline-${t.id}`
      });
    }
  }
}

// ── Helpers ──

function detail(label, value) {
  if (!value || value === 'Not shown') return '';
  return `<div class="tc-detail"><div class="tc-detail-label">${esc(label)}</div><div class="tc-detail-value">${esc(value)}</div></div>`;
}

let _toastTimer = null;
function showMessage(text, type) {
  if (_toastTimer) clearTimeout(_toastTimer);
  els.messageBar.className = `toast ${type}`;
  els.messageBar.textContent = text;
  if (type !== 'info') {
    _toastTimer = setTimeout(() => {
      els.messageBar.className = 'toast hidden';
      _toastTimer = null;
    }, 5000);
  }
}

function daysLeft(d) {
  if (!d) return 999;
  const now = new Date(); now.setHours(0,0,0,0);
  const tgt = new Date(d); tgt.setHours(0,0,0,0);
  return Math.ceil((tgt - now) / 86400000);
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(v) {
  const d = parseDate(v);
  return d ? new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium' }).format(d) : 'N/A';
}

function fmtDateTime(v) {
  const d = parseDate(v);
  return d ? new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(d) : 'Never';
}

function fmtRelative(v) {
  const d = parseDate(v);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(v);
}

function esc(v) {
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
