import { decryptAll, hpw, mkCred, b2u } from './crypto.js';
import { db, dbManager } from './storage.js';
import { CanvasCustomerTable } from './canvasTable.js';
import * as XLSX from 'xlsx';

// Global application state
const state = {
  me: null, // { id, name, isOwner }
  role: '', // 'owner' | 'sales' | 'seo' | 'media' | 'social' | 'dev' | 'ui'
  sess: '', // username or 'admin'
  D: null,  // Decrypted database { rows, nc }
  S: [],    // Active leads rows
  A: new Map(),  // leadId -> assignedUsername
  AS: new Map(), // asgDocId -> asgDocData
  L: new Map(),  // leadId -> statusData ({ s, r, j, sBy, ... })
  C: new Map(),  // leadId -> deliveryClientData
  R: new Map(),  // username -> profileData ({ name, role })
  N: {},         // username -> displayName
  byCid: new Map(), // leadId -> leadRow
  selectedCids: new Set(), // Set of selected lead IDs for specific assignment
  activeNoteCid: null,
  canvasTable: null,
  view: 'leads',
  filteredIndices: [],
  tableRowHeight: 46,
  asgUnsubscribe: null,
  isThemeDark: true
};

const ROLES = {
  sales: 'سيلز (مبيعات)',
  seo: 'SEO (تهيئة محركات البحث)',
  media: 'ميديا باير',
  social: 'سوشيال ميديا',
  dev: 'برمجة وتطوير',
  ui: 'UI/UX تصميم'
};

const DEPTS = ['seo', 'media', 'social', 'dev', 'ui'];
const DEPT_LABELS = {
  seo: 'SEO',
  media: 'ميديا',
  social: 'سوشيال',
  dev: 'برمجة',
  ui: 'UI'
};

const CHUNK_SIZE = 150;

// Utility functions
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nm = (id) => state.N[id] || (state.R.get(id)?.name) || id || '—';
const fmt = (t) => t ? new Date(t).toLocaleString('ar-EG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

// Toast Notification
export function toast(msg, type = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  el.innerHTML = `<span>${icon}</span> <span>${esc(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    el.style.transition = 'all 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// Confirmation Dialog Modal
export function ask(question, confirmText = 'تأكيد', cancelText = 'إلغاء') {
  return new Promise((resolve) => {
    const overlay = $('modal-confirm');
    $('confirm-msg').textContent = question;
    $('btn-confirm-yes').textContent = confirmText;
    $('btn-confirm-no').textContent = cancelText;
    overlay.classList.add('active');

    const handleYes = () => {
      cleanup();
      resolve(true);
    };
    const handleNo = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      overlay.classList.remove('active');
      $('btn-confirm-yes').removeEventListener('click', handleYes);
      $('btn-confirm-no').removeEventListener('click', handleNo);
    };

    $('btn-confirm-yes').addEventListener('click', handleYes);
    $('btn-confirm-no').addEventListener('click', handleNo);
  });
}

// ----------------- DATA PROTECTION & ANTI-COPY SECURITY -----------------
function setupSecurityProtection() {
  // 1. Prevent copy, cut, contextmenu (right-click), dragstart, selectstart
  ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      // Allow user to select/copy/cut ONLY inside input or textarea
      if (e.target.closest && e.target.closest('input, textarea')) {
        return;
      }
      e.preventDefault();
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', '');
      }
      toast('نسخ أو استخراج بيانات العملاء غير مسموح لدواعي الأمان والسرية 🔒', 'warning');
    }, { capture: true });
  });

  // 2. Prevent keyboard shortcuts: Ctrl+C, Ctrl+A (on table), Ctrl+X, Ctrl+S, Ctrl+U, Ctrl+P, F12, DevTools
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a', 's', 'p', 'u'].includes(k) && !isInput) {
      e.preventDefault();
      toast('النسخ والطباعة وحفظ الصفحة معطل للحفاظ على سرية العملاء 🔒', 'warning');
      return;
    }

    if (
      e.key === 'F12' ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(k))
    ) {
      e.preventDefault();
    }
  });

  // 3. Screen privacy blur when window loses focus
  const app = $('app');
  window.addEventListener('blur', () => {
    if (app) app.classList.add('hid');
  });
  window.addEventListener('focus', () => {
    if (app) app.classList.remove('hid');
  });
}

// ----------------- Core Initialization -----------------
export async function initApp() {
  setupTheme();
  setupSecurityProtection();
  setupEventListeners();

  // Initialize storage manager (handles local or firebase)
  await dbManager.init();
  await seedDefaultUsers();

  // Listen to storage status
  dbManager.onStatusChange((status) => {
    const badge = $('sync-status-badge');
    if (badge) {
      badge.className = 'sync-badge ' + (status.isCloud ? 'cloud' : 'local');
      $('sync-status-text').textContent = status.modeText;
    }
  });

  // Only decrypt master dataset if an authenticated admin password exists in this active session
  const savedPw = sessionStorage.getItem('crm_admin_pw');
  if (savedPw) {
    try {
      const data = await decryptAll(savedPw);
      state.D = data;
      state.S = [...data.rows];
      markFirstOccurrences();
    } catch (e) {
      console.warn('Session decryption error:', e);
      sessionStorage.removeItem('crm_admin_pw');
      state.D = null;
      state.S = [];
    }
  }

  // Check saved session
  try {
    state.sess = sessionStorage.getItem('crm_sess') || '';
    const savedOwner = sessionStorage.getItem('crm_is_owner');
    if (state.sess === 'admin' || savedOwner === 'true') {
      state.me = { id: 'admin', name: 'سوبر أدمن', isOwner: true };
      state.sess = 'admin';
      sessionStorage.setItem('crm_sess', 'admin');
      sessionStorage.setItem('crm_is_owner', 'true');
    } else if (state.sess) {
      state.me = { id: state.sess, name: nm(state.sess), isOwner: false };
    }
  } catch (e) {
    console.error(e);
  }

  // Real-time Firestore/Local collection listeners
  db.collection('profiles').onSnapshot((snap) => {
    state.R.clear();
    snap.docs.forEach((d) => {
      const x = d.data();
      state.R.set(d.id, x);
      state.N[d.id] = x.name || d.id;
    });
    renderLater();
  });

  db.collection('leads').onSnapshot((snap) => {
    state.L.clear();
    snap.docs.forEach((d) => {
      state.L.set(d.id, d.data());
    });
    renderLater();
  });

  db.collection('clients').onSnapshot((snap) => {
    state.C.clear();
    snap.docs.forEach((d) => {
      state.C.set(d.id, d.data());
    });
    renderLater();
  });

  renderApp();
}

async function seedDefaultUsers() {
  try {
    const existing = await db.doc('users/ahmed').get();
    if (!existing.exists) {
      await db.doc('users/ahmed').set(await mkCred('123456'));
      await db.doc('profiles/ahmed').set({ name: 'أحمد (سيلز)', role: 'sales' });
      await db.doc('users/sara').set(await mkCred('123456'));
      await db.doc('profiles/sara').set({ name: 'سارة (سيلز)', role: 'sales' });
      await db.doc('users/omar').set(await mkCred('123456'));
      await db.doc('profiles/omar').set({ name: 'عمر (برمجة)', role: 'dev' });
    }
  } catch (err) {
    console.warn('Seed users error:', err);
  }
}

function loadInitialLeads() {
  if (state.D && state.D.rows) {
    state.S = [...state.D.rows];
    markFirstOccurrences();
    return;
  }

  const pw = sessionStorage.getItem('crm_admin_pw');
  if (pw) {
    decryptAll(pw).then((data) => {
      state.D = data;
      state.S = [...data.rows];
      markFirstOccurrences();
      renderLater();
    }).catch(console.error);
  }
}

let renderTimer = 0;
function renderLater() {
  if (renderTimer) return;
  renderTimer = requestAnimationFrame(() => {
    renderTimer = 0;
    renderApp();
  });
}

// Theme setup
function setupTheme() {
  const saved = localStorage.getItem('crm_theme') || 'dark';
  state.isThemeDark = saved === 'dark';
  document.documentElement.setAttribute('data-theme', state.isThemeDark ? 'dark' : 'light');
  $('btn-theme-toggle').onclick = () => {
    state.isThemeDark = !state.isThemeDark;
    const t = state.isThemeDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('crm_theme', t);
    $('theme-icon').textContent = state.isThemeDark ? '🌙' : '☀️';
    if (state.canvasTable) state.canvasTable.setTheme(state.isThemeDark);
  };
  $('theme-icon').textContent = state.isThemeDark ? '🌙' : '☀️';
}

// ----------------- Authentication & Roles -----------------
function getMyRole() {
  if (state.me?.isOwner || state.sess === 'admin') return 'owner';
  if (!state.sess) return '';
  const prof = state.R.get(state.sess);
  return prof ? prof.role : '';
}

function renderApp() {
  state.role = getMyRole();

  // If not logged in, show login view
  if (!state.me?.isOwner && !state.sess) {
    showView('login');
    $('nav-tabs-container').style.display = 'none';
    $('header-user-info').style.display = 'none';
    $('btn-logout').style.display = 'none';
    return;
  }

  $('btn-logout').style.display = 'flex';
  $('header-user-info').style.display = 'flex';
  $('nav-tabs-container').style.display = 'flex';

  const userDisplayName = state.me?.isOwner ? 'سوبر أدمن' : nm(state.sess);
  const roleTitle = state.role === 'owner' ? 'المالك / Super Admin' : (ROLES[state.role] || state.role);
  $('user-name-display').textContent = userDisplayName;
  $('user-role-badge').textContent = roleTitle;

  setupAssignmentListener();
  renderTabs();
  showView(state.view);

  // Render current tab contents
  if (state.view === 'leads') renderLeadsView();
  else if (state.view === 'clients') renderClientsView();
  else if (state.view === 'stats') renderStatsView();
  else if (state.view === 'users') renderUsersView();
  else if (state.view === 'settings') renderSettingsView();
}

function renderTabs() {
  const container = $('nav-tabs-container');
  const tabs = [];

  if (state.role === 'owner') {
    tabs.push(
      { id: 'leads', label: 'العملاء المحتملين', icon: '👥' },
      { id: 'clients', label: 'التنفيذ والمشاريع', icon: '🚀' },
      { id: 'stats', label: 'الإحصائيات', icon: '📊' },
      { id: 'users', label: 'فريق العمل', icon: '👤' },
      { id: 'settings', label: 'إعدادات السحابة', icon: '⚙️' }
    );
  } else if (state.role === 'sales') {
    tabs.push({ id: 'leads', label: 'عملاء المبيعات المحتملين', icon: '👥' });
  } else if (DEPTS.includes(state.role)) {
    tabs.push({ id: 'clients', label: 'مشاريع التنفيذ', icon: '🚀' });
  }

  if (!tabs.some(t => t.id === state.view)) {
    state.view = tabs[0]?.id || 'leads';
  }

  container.innerHTML = tabs.map(t => `
    <button class="tab-btn ${t.id === state.view ? 'active' : ''}" data-tab="${t.id}">
      <span>${t.icon}</span>
      <span>${t.label}</span>
    </button>
  `).join('');

  container.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      state.view = btn.dataset.tab;
      renderApp();
    };
  });
}

function showView(viewId) {
  document.querySelectorAll('.view-container').forEach(el => {
    el.classList.toggle('active', el.id === `view-${viewId}`);
  });
  if (viewId === 'leads' && state.canvasTable) {
    requestAnimationFrame(() => state.canvasTable.handleResize());
  }
}

// ----------------- Assignment Listener -----------------
let asgListeningFor = '';
function setupAssignmentListener() {
  if (asgListeningFor === state.role || !(state.role === 'owner' || state.role === 'sales')) return;
  asgListeningFor = state.role;

  if (state.asgUnsubscribe) {
    state.asgUnsubscribe();
    state.asgUnsubscribe = null;
  }

  const query = state.role === 'owner'
    ? db.collection('asg')
    : db.collection('asg').where('u', '==', state.sess);

  state.asgUnsubscribe = query.onSnapshot((snap) => {
    state.AS.clear();
    snap.docs.forEach(d => state.AS.set(d.id, d.data()));
    state.A.clear();

    if (state.role === 'owner') {
      state.AS.forEach(x => {
        (x.rows || []).forEach(r => state.A.set(r[0], x.u));
      });
      // Do not overwrite state.S for owner (owner retains all decrypted leads)
    } else if (state.role === 'sales') {
      const rows = [];
      [...state.AS.values()]
        .sort((a, b) => a.k - b.k)
        .forEach(x => {
          (x.rows || []).forEach(r => {
            r.first = true;
            rows.push(r);
          });
        });
      state.S = rows;
    }
    renderLater();
  });
}

// ----------------- LEADS VIEW & SPECIFIC SELECTION -----------------
function renderLeadsView() {
  // If Super Admin has not decrypted the leads yet, display Lock Screen (No leads in DOM)
  if (state.role === 'owner' && !state.D) {
    $('leads-main-content').style.display = 'none';
    let lockEl = $('leads-lock-container');
    if (!lockEl) {
      lockEl = document.createElement('div');
      lockEl.id = 'leads-lock-container';
      lockEl.className = 'lock-screen-container';
      lockEl.innerHTML = `
        <div class="lock-screen-card">
          <div style="font-size: 52px; margin-bottom: 14px;">🔒</div>
          <h2 style="font-size: 21px; font-weight: 800; margin-bottom: 8px;">بيانات العملاء مشفرة بالكامل</h2>
          <p style="color: var(--text-muted); font-size: 13.5px; line-height: 1.6; margin-bottom: 22px;">
            لحماية البيانات ومنع استخراجها أو نسخها، تم قفل الـ 11,149 عميل بتشفير عسكري (AES-256-GCM). لن يتم تحميل أي صفوف في الـ DOM إلا بعد إدخال الباسورد.
          </p>
          <div style="display: flex; gap: 8px; max-width: 380px; margin: 0 auto;">
            <input id="leads-unlock-pw" type="password" placeholder="اكتب الباسورد لفك التشفير..." style="flex: 1; margin-bottom: 0;" autocomplete="off" />
            <button id="btn-leads-unlock" class="btn-primary" style="height: 44px; padding: 0 22px; flex-shrink: 0;">فتح 🔓</button>
          </div>
          <div id="leads-unlock-msg" class="msg" style="color: var(--danger); font-size: 13px; margin-top: 12px; min-height: 20px;"></div>
        </div>
      `;
      $('view-leads').appendChild(lockEl);

      const unlockAction = async () => {
        const pw = $('leads-unlock-pw').value.trim();
        const msg = $('leads-unlock-msg');
        msg.textContent = '';
        if (!pw) { msg.textContent = 'اكتب كلمة المرور أولاً'; return; }
        const btn = $('btn-leads-unlock');
        btn.disabled = true;
        btn.textContent = '⏳ جاري الفك...';
        try {
          const data = await decryptAll(pw);
          state.D = data;
          state.S = [...data.rows];
          markFirstOccurrences();
          sessionStorage.setItem('crm_admin_pw', pw);
          toast(`تم فك تشفير ${state.S.length.toLocaleString('en')} عميل بنجاح! 🎉`, 'success');
          lockEl.remove();
          $('leads-main-content').style.display = 'flex';
          renderLeadsView();
        } catch (e) {
          msg.textContent = '❌ كلمة المرور غير صحيحة! لن يتم عرض أي بيانات.';
        } finally {
          btn.disabled = false;
          btn.textContent = 'فتح 🔓';
        }
      };

      $('btn-leads-unlock').onclick = unlockAction;
      $('leads-unlock-pw').onkeydown = (e) => { if (e.key === 'Enter') unlockAction(); };
    } else {
      lockEl.style.display = 'flex';
    }
    return;
  }

  // When unlocked, ensure lock screen is removed and content is displayed
  const lockEl = $('leads-lock-container');
  if (lockEl) lockEl.remove();
  $('leads-main-content').style.display = 'flex';

  const tv = $('canvas-table-viewport');
  const es = $('leads-empty-state');

  if (state.role !== 'owner' && (!state.S || !state.S.length)) {
    if (es) es.style.display = 'block';
    if (tv) tv.style.display = 'none';
    return;
  }

  if (es) es.style.display = 'none';
  if (tv) tv.style.display = 'block';

  populateFilterDropdowns();
  filterLeads();
  renderKPIs();
  renderSelectionDock();
  if (state.canvasTable) {
    requestAnimationFrame(() => state.canvasTable.handleResize());
  }
}

// Mark first occurrences to detect duplicate leads
function markFirstOccurrences() {
  const seen = new Set();
  state.byCid.clear();
  state.S.forEach(r => {
    r.first = !seen.has(r[0]);
    if (r.first) state.byCid.set(r[0], r);
    seen.add(r[0]);
  });
}

function populateFilterDropdowns() {
  const sheets = [...new Set(state.S.map(r => r[1]))];
  const fs = $('filter-sheet');
  const prevFs = fs.value;
  fs.innerHTML = '<option value="">كل الشيتات والمصادر (' + sheets.length + ')</option>' + sheets.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  fs.value = prevFs;

  // Populate sales reps in filter & bulk modals
  const salesUsers = [...state.R.entries()].filter(x => x[1].role === 'sales');
  const fa = $('filter-assignee');
  if (fa) {
    const prevFa = fa.value;
    fa.innerHTML = '<option value="">كل المسؤولين (المعيّن والحر)</option><option value="none">غير معيّن فقط</option>' +
      salesUsers.map(x => `<option value="${x[0]}">${esc(nm(x[0]))}</option>`).join('');
    fa.value = prevFa;
  }

  // Populate floating dock sales dropdown
  const dockSelect = $('dock-sales-select');
  if (dockSelect) {
    dockSelect.innerHTML = '<option value="">اختر مسؤول المبيعات...</option>' +
      salesUsers.map(x => `<option value="${x[0]}">${esc(nm(x[0]))}</option>`).join('');
  }

  // Populate bulk modal sales dropdown
  const bulkSelect = $('modal-bulk-user');
  if (bulkSelect) {
    bulkSelect.innerHTML = '<option value="">اختر مندوب المبيعات...</option>' +
      salesUsers.map(x => `<option value="${x[0]}">${esc(nm(x[0]))}</option>`).join('');
  }
}

// Filtering leads list
function filterLeads() {
  const q = $('search-leads').value.trim().toLowerCase();
  const fs = $('filter-sheet').value;
  const fweb = $('filter-website') ? $('filter-website').value : '';
  const fnotes = $('filter-notes') ? $('filter-notes').value : '';
  const ft = $('filter-status').value;
  const fd = $('filter-duplicate').value;
  const fa = $('filter-assignee') ? $('filter-assignee').value : '';
  const fsel = $('filter-selected') ? $('filter-selected').value : '';

  state.filteredIndices = [];

  for (let i = 0; i < state.S.length; i++) {
    const r = state.S[i];
    const cid = r[0];
    const st = state.L.get(cid) || {};

    // Sheet filter
    if (fs && r[1] !== fs) continue;

    // Website presence filter (r[12] is boolean hasWebsite)
    if (fweb === 'has_web' && !r[12]) continue;
    if (fweb === 'no_web' && r[12]) continue;

    // Notes filter
    if (fnotes === 'has_notes' && !st.notes) continue;
    if (fnotes === 'no_notes' && st.notes) continue;

    // Duplicate filter
    if (fd === 'unique' && !r.first) continue;
    if (fd === 'dup' && r.first) continue;

    // Assignee filter (Super Admin)
    if (fa) {
      const assignedTo = state.A.get(cid);
      if (fa === 'none') {
        if (assignedTo) continue;
      } else if (assignedTo !== fa) {
        continue;
      }
    }

    // Selected filter
    if (fsel === 'selected' && !state.selectedCids.has(cid)) continue;

    // Status filter
    if (ft) {
      if (ft === 'not_sent' && st.s) continue;
      if (ft === 'sent' && !(st.s && !st.r)) continue;
      if (ft === 'replied' && !(st.r && !st.j)) continue;
      if (ft === 'joined' && !st.j) continue;
    }

    // Search query (name, category, city, phone, sheet, notes)
    if (q) {
      if (!r._searchText) {
        r._searchText = [r[3], r[4], r[5], r[6], r[1]].filter(Boolean).join(' ').toLowerCase();
      }
      const matchText = r._searchText.includes(q);
      const matchNotes = st.notes && st.notes.toLowerCase().includes(q);
      if (!matchText && !matchNotes) continue;
    }

    state.filteredIndices.push(i);
  }

  $('leads-count-badge').textContent = `${state.filteredIndices.length.toLocaleString('en')} صفوف`;
  updateSelectAllCheckbox();
  renderCanvasTable();
}

function initCanvasTableIfNeeded() {
  if (!state.canvasTable) {
    const vp = $('canvas-table-viewport');
    const sp = $('canvas-table-spacer');
    const cv = $('customer-canvas');
    if (!vp || !cv || !sp) return;

    state.canvasTable = new CanvasCustomerTable({
      onSelectRow: (cid, isChecked) => {
        toggleClientSelection(cid, isChecked);
      },
      onSelectAll: (isChecked) => {
        handleSelectAllToggle(isChecked);
      },
      onOpenWebsite: (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      onOpenMaps: (mapsUrl) => {
        window.open(mapsUrl, '_blank', 'noopener,noreferrer');
      },
      onOpenWhatsApp: (waUrl) => {
        window.open(waUrl, '_blank', 'noopener,noreferrer');
      },
      onOpenInstagram: (igUrl) => {
        window.open(igUrl, '_blank', 'noopener,noreferrer');
      },
      onOpenNotes: (cid, r) => {
        openNotesModal(cid, r);
      },
      onToggleStage: (r, stageKey) => {
        toggleStage(r, stageKey);
      },
      onOpenAssign: (cid, r) => {
        openQuickAssignDialog(cid, r[3]);
      },
      onSort: (colId, asc) => {
        sortLeadsByColumn(colId, asc);
      }
    });

    state.canvasTable.init(vp, sp, cv);
    state.canvasTable.setTheme(state.isThemeDark);
  }
}

function renderCanvasTable() {
  initCanvasTableIfNeeded();
  if (!state.canvasTable) return;
  state.canvasTable.setData({
    filteredIndices: state.filteredIndices,
    allLeads: state.S,
    statuses: state.L,
    assignments: state.A,
    selectedCids: state.selectedCids,
    userRole: state.role,
    currentUsername: state.sess,
    isOwner: state.role === 'owner'
  });
}

function sortLeadsByColumn(colId, asc) {
  state.filteredIndices.sort((idxA, idxB) => {
    const rA = state.S[idxA];
    const rB = state.S[idxB];
    if (!rA || !rB) return 0;
    let valA = '';
    let valB = '';

    switch (colId) {
      case 'name':
        valA = rA[3] || '';
        valB = rB[3] || '';
        break;
      case 'category':
        valA = rA[4] || '';
        valB = rB[4] || '';
        break;
      case 'city':
        valA = rA[5] || '';
        valB = rB[5] || '';
        break;
      case 'sheet':
        valA = rA[1] || '';
        valB = rB[1] || '';
        break;
      case 'website':
        valA = rA[12] ? (rA[8] || '1') : '';
        valB = rB[12] ? (rB[8] || '1') : '';
        break;
      case 'duplicate':
        valA = rA[14] ? '1' : '0';
        valB = rB[14] ? '1' : '0';
        break;
      case 'assignee':
        valA = state.A.get(rA[0]) || '';
        valB = state.A.get(rB[0]) || '';
        break;
      case 'notes':
        valA = state.L.get(rA[0])?.notes || '';
        valB = state.L.get(rB[0])?.notes || '';
        break;
      default:
        valA = rA[3] || '';
        valB = rB[3] || '';
    }

    const cmp = String(valA).localeCompare(String(valB), 'ar', { numeric: true });
    return asc ? cmp : -cmp;
  });

  renderCanvasTable();
}

// ----------------- SPECIFIC LEADS SELECTION HANDLERS -----------------
function toggleClientSelection(cid, isChecked) {
  if (isChecked) {
    state.selectedCids.add(cid);
  } else {
    state.selectedCids.delete(cid);
  }
  updateSelectAllCheckbox();
  renderSelectionDock();
  renderCanvasTable();
}

function updateSelectAllCheckbox() {
  const masterChk = $('select-all-leads');
  if (!masterChk) return;
  const visibleCids = state.filteredIndices.map(idx => state.S[idx][0]);
  if (!visibleCids.length) {
    masterChk.checked = false;
    masterChk.indeterminate = false;
    return;
  }

  const selectedVisibleCount = visibleCids.filter(id => state.selectedCids.has(id)).length;
  if (selectedVisibleCount === 0) {
    masterChk.checked = false;
    masterChk.indeterminate = false;
  } else if (selectedVisibleCount === visibleCids.length) {
    masterChk.checked = true;
    masterChk.indeterminate = false;
  } else {
    masterChk.checked = false;
    masterChk.indeterminate = true;
  }
}

function handleSelectAllToggle(checked) {
  state.filteredIndices.forEach(idx => {
    const cid = state.S[idx][0];
    if (checked) {
      state.selectedCids.add(cid);
    } else {
      state.selectedCids.delete(cid);
    }
  });
  updateSelectAllCheckbox();
  renderSelectionDock();
  renderCanvasTable();
}

function renderSelectionDock() {
  const dock = $('selection-dock');
  if (!dock) return;
  const count = state.selectedCids.size;

  if (count > 0 && state.role === 'owner') {
    dock.classList.add('active');
    $('dock-count-number').textContent = count.toLocaleString('en');
  } else {
    dock.classList.remove('active');
  }
}

// Quick Assign dialog for a single lead
function openQuickAssignDialog(cid, clientName) {
  const salesUsers = [...state.R.entries()].filter(x => x[1].role === 'sales');
  if (!salesUsers.length) {
    toast('لا يوجد مندوبي مبيعات حالياً، أنشئ مستخدم أولاً من تبويب فريق العمل', 'error');
    return;
  }

  const options = salesUsers.map(x => `<option value="${x[0]}" ${state.A.get(cid) === x[0] ? 'selected' : ''}>${esc(nm(x[0]))}</option>`).join('');
  const modal = $('modal-quick-assign');
  $('quick-assign-client-name').textContent = clientName || 'عميل';
  $('quick-assign-user-select').innerHTML = `<option value="">-- غير معيّن (إلغاء التعيين) --</option>` + options;
  modal.classList.add('active');

  $('btn-quick-assign-save').onclick = async () => {
    const targetUser = $('quick-assign-user-select').value;
    modal.classList.remove('active');
    toast('جاري تحديث الإسناد...');
    try {
      await applyAssign([cid], targetUser || null);
      toast('تم تحديث التعيين بنجاح ✓', 'success');
    } catch {
      toast('تعذّر حفظ التعيين', 'error');
    }
  };

  $('btn-quick-assign-cancel').onclick = () => {
    modal.classList.remove('active');
  };
}

// ----------------- SALES LEAD NOTES MODAL -----------------
function openNotesModal(cid, r) {
  state.activeNoteCid = cid;
  const st = state.L.get(cid) || {};

  const nameEl = $('modal-notes-client-name');
  if (nameEl) nameEl.textContent = r[3] || 'عميل';

  const catEl = $('modal-notes-cat');
  if (catEl) catEl.textContent = r[4] || '—';

  const cityEl = $('modal-notes-city');
  if (cityEl) cityEl.textContent = r[5] || '—';

  const phoneEl = $('modal-notes-phone');
  if (phoneEl) phoneEl.textContent = r[6] || '—';

  const textarea = $('modal-notes-textarea');
  if (textarea) textarea.value = st.notes || '';

  const metaEl = $('modal-notes-meta');
  if (metaEl) {
    if (st.notes && st.noteBy) {
      metaEl.textContent = `آخر تعديل بواسطة: ${nm(st.noteBy)} · ${fmt(st.noteAt)}`;
    } else {
      metaEl.textContent = 'لا توجد ملاحظات مسجلة مسبقاً لهذا العميل.';
    }
  }

  const modal = $('modal-lead-notes');
  if (modal) {
    modal.classList.add('active');
    setTimeout(() => {
      if (textarea) textarea.focus();
    }, 50);
  }
}

function setupNotesModalEvents() {
  const modal = $('modal-lead-notes');
  if (!modal) return;

  const closeModal = () => modal.classList.remove('active');

  const btnClose = $('btn-close-notes-modal');
  if (btnClose) btnClose.onclick = closeModal;

  const btnCancel = $('btn-cancel-lead-notes');
  if (btnCancel) btnCancel.onclick = closeModal;

  // Quick note tag buttons
  modal.querySelectorAll('.quick-note-tag').forEach(btn => {
    btn.onclick = () => {
      const tag = btn.dataset.tag;
      const ta = $('modal-notes-textarea');
      if (!ta || !tag) return;
      if (ta.value.trim()) {
        ta.value = ta.value.trim() + ' | ' + tag;
      } else {
        ta.value = tag;
      }
      ta.focus();
    };
  });

  const btnSave = $('btn-save-lead-notes');
  if (btnSave) {
    btnSave.onclick = async () => {
      const cid = state.activeNoteCid;
      if (!cid) {
        closeModal();
        return;
      }

      const text = ($('modal-notes-textarea').value || '').trim();
      const currentSt = state.L.get(cid) || {};
      const currentUid = state.me?.isOwner ? 'admin' : state.sess;
      const now = Date.now();

      const updated = {
        ...currentSt,
        notes: text,
        noteBy: currentUid,
        noteAt: now
      };

      state.L.set(cid, updated);
      closeModal();
      renderCanvasTable();

      try {
        await db.doc(`leads/${cid}`).set({
          notes: text,
          noteBy: currentUid,
          noteAt: now
        }, { merge: true });
        toast('تم حفظ ملاحظات العميل بنجاح ✓', 'success');
      } catch (err) {
        console.error('Error saving notes:', err);
        toast('تم الحفظ في الجلسة المحلية (غير متصل بالسحاب)', 'info');
      }
    };
  }
}

// ----------------- ASSIGNMENT LOGIC (Single, Bulk, & Specific) -----------------
async function applyAssign(cids, targetUid) {
  const affectedUsers = new Set();
  if (targetUid) affectedUsers.add(targetUid);

  cids.forEach((cid) => {
    const previousOwner = state.A.get(cid);
    if (previousOwner) affectedUsers.add(previousOwner);
  });

  const nextAssignments = new Map(state.A);
  cids.forEach((cid) => {
    if (targetUid) nextAssignments.set(cid, targetUid);
    else nextAssignments.delete(cid);
  });

  const jobs = [];

  affectedUsers.forEach((u) => {
    const rows = [];
    nextAssignments.forEach((assignedUser, cid) => {
      if (assignedUser === u && state.byCid.get(cid)) {
        rows.push(state.byCid.get(cid).slice(0, 16));
      }
    });

    const chunkCount = Math.ceil(rows.length / CHUNK_SIZE);
    for (let k = 0; k < chunkCount; k++) {
      jobs.push(() =>
        db.doc(`asg/${u}__${k}`).set({
          u,
          k,
          rows: rows.slice(k * CHUNK_SIZE, (k + 1) * CHUNK_SIZE)
        })
      );
    }

    state.AS.forEach((x, id) => {
      if (x.u === u && x.k >= chunkCount) {
        jobs.push(() => db.doc(`asg/${id}`).delete());
      }
    });
  });

  // Run jobs in batches of 4
  for (let i = 0; i < jobs.length; i += 4) {
    await Promise.all(jobs.slice(i, i + 4).map(fn => fn()));
  }
}

// Dock Action: Assign Selected Specific Leads
async function handleDockAssignSelected() {
  const targetUser = $('dock-sales-select').value;
  if (!targetUser) {
    toast('الرجاء اختيار مندوب المبيعات أولاً', 'error');
    return;
  }
  const count = state.selectedCids.size;
  if (!count) return;

  const confirmed = await ask(
    `هل أنت متأكد من إسناد ${count} عميل محدد إلى "${nm(targetUser)}"؟`,
    'تأكيد الإسناد',
    'إلغاء'
  );
  if (!confirmed) return;

  toast('جاري إسناد العملاء المحددين...');
  try {
    await applyAssign(Array.from(state.selectedCids), targetUser);
    state.selectedCids.clear();
    renderSelectionDock();
    renderCanvasTable();
    toast(`تم إسناد ${count} عميل بنجاح إلى ${nm(targetUser)} ✓`, 'success');
  } catch (err) {
    console.error(err);
    toast('حدث خطأ أثناء الإسناد، يرجى المحاولة مرة أخرى', 'error');
  }
}

// Dock Action: Unassign Selected
async function handleDockUnassignSelected() {
  const count = state.selectedCids.size;
  if (!count) return;

  const confirmed = await ask(
    `هل تريد إلغاء تعيين ${count} عميل محدد وجعلهم غير معيّنين؟`,
    'إلغاء التعيين',
    'تراجع'
  );
  if (!confirmed) return;

  toast('جاري إلغاء تعيين العملاء المحددين...');
  try {
    await applyAssign(Array.from(state.selectedCids), null);
    state.selectedCids.clear();
    renderSelectionDock();
    renderCanvasTable();
    toast(`تم إلغاء تعيين ${count} عميل بنجاح ✓`, 'success');
  } catch {
    toast('حدث خطأ أثناء العملية', 'error');
  }
}

// Bulk Modal Assignment by Count
async function handleBulkCountAssign() {
  const targetUser = $('modal-bulk-user').value;
  const countInput = parseInt($('modal-bulk-count').value, 10) || 0;
  const onlyUnassigned = $('modal-bulk-unassigned-only').checked;

  if (!targetUser) {
    toast('يرجى اختيار مندوب المبيعات', 'error');
    return;
  }

  const seen = new Set();
  const pool = [];

  for (const idx of state.filteredIndices) {
    const cid = state.S[idx][0];
    if (seen.has(cid)) continue;
    seen.add(cid);

    if (onlyUnassigned) {
      if (!state.A.has(cid)) pool.push(cid);
    } else {
      pool.push(cid);
    }
  }

  const toAssign = countInput > 0 ? pool.slice(0, countInput) : pool;
  if (!toAssign.length) {
    toast('لا يوجد عملاء يطابقون شروط التوزيع في النتائج الحالية', 'error');
    return;
  }

  const confirmed = await ask(
    `هل تريد إسناد ${toAssign.length} عميل إلى "${nm(targetUser)}"؟`,
    'بدء التعيين',
    'إلغاء'
  );
  if (!confirmed) return;

  $('modal-bulk-assign').classList.remove('active');
  toast('جاري حفظ التعيينات...');
  try {
    await applyAssign(toAssign, targetUser);
    toast(`تم إسناد ${toAssign.length} عميل بنجاح ✓`, 'success');
  } catch {
    toast('فشلت العملية', 'error');
  }
}

// ----------------- STAGES / STATUS UPDATES -----------------
async function toggleStage(row, stageKey) {
  const cid = row[0];
  const oldState = state.L.get(cid) || {};
  const newState = { ...oldState };
  const now = Date.now();
  const isCurrentlyOn = !!oldState[stageKey];
  const willTurnOn = !isCurrentlyOn;
  const currentUid = state.me?.isOwner ? 'admin' : state.sess;

  const setFlag = (k, val) => {
    if (val && !newState[k]) {
      newState[k] = true;
      newState[`${k}By`] = currentUid;
      newState[`${k}At`] = now;
    } else if (!val) {
      newState[k] = false;
      delete newState[`${k}By`];
      delete newState[`${k}At`];
    }
  };

  let shouldCreateClient = false;
  let shouldDeleteClient = false;

  if (willTurnOn) {
    setFlag('s', true);
    if (stageKey !== 's') setFlag('r', true);
    if (stageKey === 'j') {
      setFlag('j', true);
      shouldCreateClient = !oldState.j;
    }
  } else {
    if (stageKey === 's' || stageKey === 'r' || stageKey === 'j') {
      if (oldState.j) {
        const proceed = await ask('هذا العميل متعلّم "دخل معانا". إلغاء هذه العلامة سيحذفه من جدول التنفيذ، هل تريد الاستمرار؟');
        if (!proceed) return;
      }
      if (stageKey === 's') {
        setFlag('s', false);
        setFlag('r', false);
        setFlag('j', false);
      } else if (stageKey === 'r') {
        setFlag('r', false);
        setFlag('j', false);
      } else {
        setFlag('j', false);
      }
      shouldDeleteClient = !!oldState.j;
    }
  }

  try {
    await db.doc(`leads/${cid}`).set(newState);
    if (shouldCreateClient) {
      await db.doc(`clients/${cid}`).set({
        name: row[3],
        cat: row[4],
        city: row[5],
        phone: row[6],
        wa: row[7],
        site: row[8],
        ig: row[9],
        plat: row[10],
        by: currentUid,
        at: now,
        seo: 0,
        media: 0,
        social: 0,
        dev: 0,
        ui: 0
      });
      toast(`تمت إضافة ${row[3]} إلى جدول التنفيذ ✓`, 'success');
    }
    if (shouldDeleteClient) {
      await db.doc(`clients/${cid}`).delete();
      toast('تم الحذف من جدول التنفيذ', 'info');
    }
  } catch (err) {
    console.error(err);
    toast('تعذّر حفظ التحديث', 'error');
  }
}

// ----------------- KPIS -----------------
function renderKPIs() {
  let sentCount = 0, repliedCount = 0, joinedCount = 0;
  const countStats = (st) => {
    if (st.s) sentCount++;
    if (st.r) repliedCount++;
    if (st.j) joinedCount++;
  };

  if (state.role === 'owner') {
    state.L.forEach(countStats);
  } else {
    state.S.forEach(r => countStats(state.L.get(r[0]) || {}));
  }

  const cards = [];
  if (state.role === 'owner') {
    cards.push(
      { label: 'إجمالي العملاء', val: state.S.length, color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.15)', icon: '👥' },
      { label: 'العملاء المعيّنون', val: state.A.size, color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.15)', icon: '⚡' }
    );
  } else {
    cards.push(
      { label: 'العملاء المعيّنون لك', val: state.S.length, color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.15)', icon: '📋' }
    );
  }

  cards.push(
    { label: 'تم التواصل (اتبعت)', val: sentCount, color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.15)', icon: '📤' },
    { label: 'تفاعلوا (ردوا)', val: repliedCount, color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', icon: '💬' },
    { label: 'تعاقدوا (دخلوا معانا)', val: joinedCount, color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)', icon: '🎉' }
  );

  $('leads-kpis').innerHTML = cards.map(c => `
    <div class="kpi-card" style="--kpi-color: ${c.color}; --kpi-bg: ${c.bg}">
      <div class="kpi-icon">${c.icon}</div>
      <div class="kpi-info">
        <span>${c.label}</span>
        <b>${c.val.toLocaleString('en')}</b>
      </div>
    </div>
  `).join('');
}

// ----------------- DELIVERY VIEW (Clients) -----------------
function renderClientsView() {
  const container = $('clients-content');
  const rows = [...state.C.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

  if (!rows.length) {
    container.innerHTML = `
      <div class="card" style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:36px;margin-bottom:10px">🚀</div>
        <b>لا يوجد عملاء منضمين حالياً.</b>
        <p style="margin-top:6px;font-size:13px">بمجرد قيام السيلز بتعليم عميل "معانا"، سيظهر هنا لتبدأ أقسام التنفيذ العمل عليه.</p>
      </div>`;
    return;
  }

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <span style="font-weight:700">${rows.length} عميل في مرحلة التنفيذ</span>
      <span style="font-size:12.5px;color:var(--text-muted)">الحالات: 0 = لسه | 1 = شغّال | 2 = خلص</span>
    </div>
    <div class="standard-table-wrapper">
      <table class="standard-table">
        <thead>
          <tr>
            <th>العميل</th>
            <th>النشاط</th>
            <th>المدينة</th>
            <th>الرقم</th>
            <th>روابط سريعة</th>
            <th>بواسطة</th>
            ${DEPTS.map(d => `<th>${DEPT_LABELS[d]}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
  `;

  rows.forEach(([id, x]) => {
    const waLink = x.wa ? `<a href="${x.wa.startsWith('http') ? x.wa : 'https://wa.me/' + x.wa.replace(/[^0-9]/g, '')}" target="_blank" class="link-btn wa" title="واتساب">💬</a>` : '';
    const siteLink = x.site ? `<a href="${x.site}" target="_blank" class="link-btn web" title="الموقع">🌐</a>` : '';
    const igLink = x.ig ? `<a href="${x.ig}" target="_blank" class="link-btn ig" title="انستجرام">📷</a>` : '';

    html += `
      <tr>
        <td><b>${esc(x.name || 'بدون اسم')}</b></td>
        <td>${esc(x.cat || '—')}</td>
        <td>${esc(x.city || '—')}</td>
        <td style="direction:ltr;font-family:var(--font-latin)">${esc(x.phone || '—')}</td>
        <td><div style="display:flex;gap:4px">${waLink}${siteLink}${igLink}</div></td>
        <td style="font-size:12px;color:var(--text-dim)">${esc(nm(x.by))} · ${fmt(x.at)}</td>
    `;

    DEPTS.forEach(d => {
      const val = x[d] || 0;
      const canEdit = state.role === 'owner' || state.role === d;

      if (canEdit) {
        html += `
          <td>
            <select class="dept-status-select dept-status-${val}" data-client-id="${id}" data-dept="${d}">
              <option value="0" ${val === 0 ? 'selected' : ''}>لسه</option>
              <option value="1" ${val === 1 ? 'selected' : ''}>شغّال</option>
              <option value="2" ${val === 2 ? 'selected' : ''}>خلص</option>
            </select>
          </td>`;
      } else {
        const text = ['لسه', 'شغّال', 'خلص'][val];
        html += `<td><span class="dept-status-select dept-status-${val}">${text}</span></td>`;
      }
    });

    html += '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  container.querySelectorAll('.dept-status-select').forEach(sel => {
    sel.onchange = async () => {
      const cid = sel.dataset.clientId;
      const dept = sel.dataset.dept;
      const val = parseInt(sel.value, 10);
      try {
        await db.doc(`clients/${cid}`).update({ [dept]: val });
        sel.className = `dept-status-select dept-status-${val}`;
        toast('تم تحديث حالة القسم ✓', 'success');
      } catch {
        toast('تعذّر حفظ التحديث', 'error');
      }
    };
  });
}

// ----------------- STATS VIEW -----------------
function renderStatsView() {
  const container = $('stats-content');
  const perUser = {};

  state.A.forEach((u) => {
    perUser[u] = perUser[u] || { assigned: 0, s: 0, r: 0, j: 0 };
    perUser[u].assigned++;
  });

  state.L.forEach((x) => {
    if (x.s && x.sBy) {
      perUser[x.sBy] = perUser[x.sBy] || { assigned: 0, s: 0, r: 0, j: 0 };
      perUser[x.sBy].s++;
    }
    if (x.r && x.rBy) {
      perUser[x.rBy] = perUser[x.rBy] || { assigned: 0, s: 0, r: 0, j: 0 };
      perUser[x.rBy].r++;
    }
    if (x.j && x.jBy) {
      perUser[x.jBy] = perUser[x.jBy] || { assigned: 0, s: 0, r: 0, j: 0 };
      perUser[x.jBy].j++;
    }
  });

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <h3 style="font-weight:800;font-size:18px">📊 تقرير أداء فريق المبيعات (Sales Leaderboard)</h3>
      <button id="btn-export-stats-csv" class="btn-secondary">📥 تصدير التقرير (Excel / CSV)</button>
    </div>
    <div class="standard-table-wrapper" style="margin-bottom:28px">
      <table class="standard-table">
        <thead>
          <tr>
            <th>مسؤول المبيعات</th>
            <th>إجمالي المعيّن</th>
            <th>تم التواصل (اتبعت)</th>
            <th>الردود والتفاعل</th>
            <th>تم التعاقد (معانا)</th>
            <th>نسبة الإغلاق (Conversion)</th>
          </tr>
        </thead>
        <tbody>
  `;

  const userEntries = Object.entries(perUser).sort((a, b) => b[1].j - a[1].j);
  if (!userEntries.length) {
    html += `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">لا توجد بيانات تعيينات أو تفاعل حتى الآن</td></tr>`;
  } else {
    userEntries.forEach(([uid, p]) => {
      const convRate = p.assigned > 0 ? ((p.j / p.assigned) * 100).toFixed(1) + '%' : '0%';
      html += `
        <tr>
          <td><b>${esc(nm(uid))}</b></td>
          <td>${p.assigned.toLocaleString('en')}</td>
          <td><span style="color:var(--info);font-weight:700">${p.s.toLocaleString('en')}</span></td>
          <td><span style="color:var(--warning);font-weight:700">${p.r.toLocaleString('en')}</span></td>
          <td><span style="color:var(--success);font-weight:700">${p.j.toLocaleString('en')}</span></td>
          <td><span style="font-family:var(--font-latin);font-weight:700;color:var(--primary)">${convRate}</span></td>
        </tr>`;
    });
  }

  html += `
        </tbody>
      </table>
    </div>
    <h3 style="font-weight:800;font-size:18px;margin-bottom:14px">🚀 تقدم أقسام التنفيذ</h3>
    <div class="standard-table-wrapper">
      <table class="standard-table">
        <thead>
          <tr>
            <th>القسم</th>
            <th>لم يبدأ (لسه)</th>
            <th>جاري العمل (شغّال)</th>
            <th>مكتمل (خلص)</th>
            <th>نسبة الإنجاز</th>
          </tr>
        </thead>
        <tbody>
  `;

  DEPTS.forEach(d => {
    const counts = [0, 0, 0];
    state.C.forEach(x => counts[x[d] || 0]++);
    const total = counts[0] + counts[1] + counts[2];
    const completionRate = total > 0 ? ((counts[2] / total) * 100).toFixed(1) + '%' : '0%';

    html += `
      <tr>
        <td><b>${DEPT_LABELS[d]}</b></td>
        <td><span style="color:var(--text-muted)">${counts[0]}</span></td>
        <td><span style="color:var(--warning);font-weight:700">${counts[1]}</span></td>
        <td><span style="color:var(--success);font-weight:700">${counts[2]}</span></td>
        <td><span style="font-family:var(--font-latin);font-weight:700;color:var(--primary)">${completionRate}</span></td>
      </tr>`;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  const btnExport = $('btn-export-stats-csv');
  if (btnExport) {
    btnExport.onclick = () => exportStatsToCSV(perUser);
  }
}

function exportStatsToCSV(perUser) {
  let csv = '\uFEFF'; // UTF-8 BOM for Arabic support in Excel
  csv += 'المندوب,المعين,اتبعت,رد,دخل معانا,نسبة الاغلاق\n';
  Object.entries(perUser).forEach(([uid, p]) => {
    const rate = p.assigned > 0 ? ((p.j / p.assigned) * 100).toFixed(1) + '%' : '0%';
    csv += `"${nm(uid)}",${p.assigned},${p.s},${p.r},${p.j},"${rate}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `تقرير_المبيعات_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('تم تحميل ملف التقرير بنجاح ✓', 'success');
}

// ----------------- USERS VIEW (Management) -----------------
function renderUsersView() {
  const container = $('users-content');
  const roleOptions = Object.entries(ROLES)
    .map(([k, t]) => `<option value="${k}">${t}</option>`)
    .join('');

  let html = `
    <div class="modal-card" style="max-width:100%;margin-bottom:24px">
      <h3 style="font-size:16px;font-weight:800">➕ إضافة عضو جديد لفريق العمل</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
        قم بإنشاء حسابات لمناديب المبيعات وفريق التنفيذ حتى يتمكنوا من تسجيل الدخول والاطلاع على المهام الموكلة إليهم فقط.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;align-items:end">
        <div class="form-group" style="margin:0">
          <label>اسم الدخول (إنجليزي بدون مسافات):</label>
          <input id="new-user-id" placeholder="ahmed_sales" style="direction:ltr" />
        </div>
        <div class="form-group" style="margin:0">
          <label>الاسم الظاهر:</label>
          <input id="new-user-name" placeholder="أحمد مبيعات" />
        </div>
        <div class="form-group" style="margin:0">
          <label>كلمة المرور (6 حروف فأكثر):</label>
          <input id="new-user-pw" type="password" placeholder="••••••••" style="direction:ltr" />
        </div>
        <div class="form-group" style="margin:0">
          <label>الدور الوظيفي / القسم:</label>
          <select id="new-user-role">${roleOptions}</select>
        </div>
        <div>
          <button id="btn-create-user" class="btn-primary" style="width:100%;height:42px;justify-content:center">
            إنشاء الحساب
          </button>
        </div>
      </div>
      <div id="new-user-msg" style="color:var(--danger);font-size:12.5px;margin-top:8px"></div>
    </div>

    <div class="standard-table-wrapper">
      <table class="standard-table">
        <thead>
          <tr>
            <th>اسم الدخول</th>
            <th>الاسم الظاهر</th>
            <th>الدور الوظيفي</th>
            <th>تغيير كلمة المرور</th>
            <th>إجراءات</th>
          </tr>
        </thead>
        <tbody>
  `;

  const usersList = [...state.R.entries()];
  if (!usersList.length) {
    html += `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">لا يوجد مستخدمون حالياً</td></tr>`;
  } else {
    usersList.forEach(([uid, u]) => {
      const sel = roleOptions.replace(`value="${u.role}"`, `value="${u.role}" selected`);
      html += `
        <tr data-user-id="${esc(uid)}">
          <td style="direction:ltr;font-family:var(--font-latin)"><b>${esc(uid)}</b></td>
          <td><input class="user-edit-name" value="${esc(u.name || '')}" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border-subtle);background:var(--bg-canvas);color:var(--text-main)" /></td>
          <td><select class="user-edit-role filter-select" style="padding:6px 10px">${sel}</select></td>
          <td><input class="user-edit-pw" type="password" placeholder="فارغ = بدون تغيير" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border-subtle);background:var(--bg-canvas);color:var(--text-main);direction:ltr" /></td>
          <td>
            <div style="display:flex;gap:6px">
              <button class="btn-primary btn-save-user" style="padding:6px 12px;font-size:12px">حفظ التعديل</button>
              <button class="btn-danger btn-delete-user" style="padding:6px 12px;font-size:12px">حذف</button>
            </div>
          </td>
        </tr>`;
    });
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // New user creation
  $('btn-create-user').onclick = async () => {
    const uid = $('new-user-id').value.trim().toLowerCase();
    const name = $('new-user-name').value.trim();
    const pw = $('new-user-pw').value;
    const role = $('new-user-role').value;
    const msg = $('new-user-msg');
    msg.textContent = '';

    if (!/^[a-z0-9_.-]{3,30}$/.test(uid)) {
      msg.textContent = 'اسم الدخول: 3-30 حرف إنجليزي أو أرقام (_ . -) بدون مسافات';
      return;
    }
    if (!name) {
      msg.textContent = 'الرجاء إدخال الاسم الظاهر';
      return;
    }
    if (pw.length < 6) {
      msg.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
      return;
    }
    if (state.R.has(uid)) {
      msg.textContent = 'اسم الدخول هذا مستخدم بالفعل';
      return;
    }

    try {
      await db.doc(`users/${uid}`).set(await mkCred(pw));
      await db.doc(`profiles/${uid}`).set({ name, role });
      $('new-user-id').value = '';
      $('new-user-name').value = '';
      $('new-user-pw').value = '';
      toast(`تم إنشاء حساب "${name}" بنجاح ✓`, 'success');
    } catch {
      msg.textContent = 'تعذّر حفظ بيانات المستخدم';
    }
  };

  // Row update & delete
  container.querySelectorAll('tr[data-user-id]').forEach(tr => {
    const uid = tr.dataset.userId;

    tr.querySelector('.btn-save-user').onclick = async () => {
      const name = tr.querySelector('.user-edit-name').value.trim() || uid;
      const role = tr.querySelector('.user-edit-role').value;
      const pw = tr.querySelector('.user-edit-pw').value;

      try {
        await db.doc(`profiles/${uid}`).set({ name, role });
        if (pw) {
          if (pw.length < 6) {
            toast('كلمة المرور 6 أحرف على الأقل', 'error');
            return;
          }
          await db.doc(`users/${uid}`).set(await mkCred(pw));
          tr.querySelector('.user-edit-pw').value = '';
        }
        toast('تم حفظ التعديلات بنجاح ✓', 'success');
      } catch {
        toast('تعذّر الحفظ', 'error');
      }
    };

    tr.querySelector('.btn-delete-user').onclick = async () => {
      const confirmed = await ask(
        `هل تريد مسح المستخدم "${nm(uid)}"؟ العملاء المعيّنون له سيصبحون غير معيّنين.`,
        'مسح المستخدم',
        'تراجع'
      );
      if (!confirmed) return;

      try {
        const deleteOps = [];
        state.AS.forEach((x, docId) => {
          if (x.u === uid) deleteOps.push(db.doc(`asg/${docId}`).delete());
        });
        await Promise.all(deleteOps);
        await db.doc(`profiles/${uid}`).delete();
        await db.doc(`users/${uid}`).delete();
        toast('تم حذف المستخدم بنجاح', 'info');
      } catch {
        toast('تعذّر حذف المستخدم', 'error');
      }
    };
  });
}

// ----------------- SETTINGS & CLOUD SYNC VIEW -----------------
function renderSettingsView() {
  const container = $('settings-content');
  const status = dbManager.getStatus();
  const cfg = dbManager.getFirebaseConfig() || {};

  container.innerHTML = `
    <div style="max-width:750px;margin:0 auto">
      <div class="modal-card" style="max-width:100%;margin-bottom:20px">
        <h3 style="font-size:17px;font-weight:800;display:flex;align-items:center;gap:8px">
          <span>☁️</span> الربط السحابي (Firebase Live Sync)
        </h3>
        <p style="font-size:13px;color:var(--text-muted);line-height:1.7">
          يمكّنك الربط مع فايربيز من مشاركة الداشبورد بين السوبر أدمن وفريق المبيعات والتنفيذ مباشرة عبر الإنترنت في الوقت الفعلي ومن أي جهاز أو هاتف.
        </p>

        <div style="display:flex;align-items:center;gap:10px;padding:12px;border-radius:var(--radius-md);background:var(--bg-canvas);margin-bottom:16px;border:1px solid var(--border-subtle)">
          <span style="font-size:22px">${status.isCloud ? '🟢' : '🟡'}</span>
          <div>
            <b style="display:block;font-size:14px">${status.isCloud ? 'متصل بالسحابة (Firebase Live)' : 'الوضع الحالي: تخزين محلي (Offline)'}</b>
            <span style="font-size:12px;color:var(--text-dim)">
              ${status.isCloud ? 'جميع التحديثات تُحفظ وتُزامن سحابياً فوراً.' : 'البيانات تُحفظ في متصفحك الحالي فقط حتى تقوم بربط مشروع فايربيز.'}
            </span>
          </div>
        </div>

        <div class="form-group">
          <label>Project ID (معرّف المشروع):</label>
          <input id="cfg-projectId" value="${esc(cfg.projectId || '')}" placeholder="my-crm-project" style="direction:ltr" />
        </div>
        <div class="form-group">
          <label>API Key:</label>
          <input id="cfg-apiKey" value="${esc(cfg.apiKey || '')}" placeholder="AIzaSy..." style="direction:ltr" />
        </div>
        <div class="form-group">
          <label>Auth Domain (اختياري):</label>
          <input id="cfg-authDomain" value="${esc(cfg.authDomain || '')}" placeholder="my-crm-project.firebaseapp.com" style="direction:ltr" />
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px">
          <button id="btn-save-cloud-config" class="btn-primary">
            ⚡ تفعيل وربط فايربيز الآن
          </button>
          ${status.isCloud ? `
            <button id="btn-migrate-to-cloud" class="btn-secondary">
              ⬆️ نقل البيانات المحلية إلى السحابة
            </button>
            <button id="btn-disconnect-cloud" class="btn-danger">
              قطع الاتصال والعودة للمحلي
            </button>
          ` : ''}
        </div>
      </div>

      <div class="modal-card" style="max-width:100%">
        <h3 style="font-size:17px;font-weight:800">💾 النسخ الاحتياطي وإعادة التعيين</h3>
        <p style="font-size:13px;color:var(--text-muted)">
          يمكنك تحميل نسخة احتياطية كاملة من جميع الحسابات، التعيينات، والبيانات كملف JSON واستعادتها في أي وقت.
        </p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <button id="btn-download-backup" class="btn-secondary">
            📥 تنزيل نسخة احتياطية (JSON)
          </button>
          <label class="btn-secondary" style="cursor:pointer">
            📤 استعادة نسخة من ملف
            <input type="file" id="input-restore-backup" accept=".json" style="display:none" />
          </label>
          <button id="btn-reset-default-leads" class="btn-secondary" style="color:var(--warning)">
            🔄 إعادة تحميل الداتا الأصلية (11,149 عميل)
          </button>
        </div>
      </div>
    </div>
  `;

  $('btn-save-cloud-config').onclick = async () => {
    const projectId = $('cfg-projectId').value.trim();
    const apiKey = $('cfg-apiKey').value.trim();
    const authDomain = $('cfg-authDomain').value.trim();

    if (!projectId || !apiKey) {
      toast('الرجاء إدخال Project ID و API Key على الأقل', 'error');
      return;
    }

    toast('جاري الاتصال بـ Firebase...');
    try {
      await dbManager.connectFirebase({ projectId, apiKey, authDomain });
      toast('تم الاتصال بالسحابة بنجاح! 🚀', 'success');
      renderApp();
    } catch (e) {
      console.error(e);
      toast('فشل الاتصال بـ Firebase، تأكد من صحة المفاتيح وإعدادات Firestore', 'error');
    }
  };

  const btnMigrate = $('btn-migrate-to-cloud');
  if (btnMigrate) {
    btnMigrate.onclick = async () => {
      const ok = await ask('هل تريد رفع ونقل جميع البيانات المحلية الحالية إلى قاعدة بيانات فايربيز السحابية؟');
      if (!ok) return;
      toast('جاري نقل البيانات...');
      try {
        const count = await dbManager.migrateLocalToCloud();
        toast(`تم رفع ${count} سجل بنجاح إلى السحابة ✓`, 'success');
      } catch (e) {
        toast('حدث خطأ أثناء النقل', 'error');
      }
    };
  }

  const btnDisconnect = $('btn-disconnect-cloud');
  if (btnDisconnect) {
    btnDisconnect.onclick = async () => {
      const ok = await ask('هل تريد فصل السحابة والعودة للتخزين المحلي؟ لن تُحذف بيانات فايربيز.');
      if (!ok) return;
      dbManager.disconnectCloud();
      toast('تم التبديل للتخزين المحلي', 'info');
      renderApp();
    };
  }

  $('btn-download-backup').onclick = () => {
    const data = dbManager.localDb.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `نسخة_احتياطية_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('تم تنزيل النسخة الاحتياطية بنجاح ✓', 'success');
  };

  $('input-restore-backup').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const json = JSON.parse(reader.result);
        const ok = await ask('استعادة النسخة ستستبدل البيانات الحالية، هل تريد الاستمرار؟');
        if (!ok) return;
        dbManager.localDb.importAll(json);
        toast('تم استعادة البيانات بنجاح ✓', 'success');
        renderApp();
      } catch {
        toast('ملف النسخة غير صالح', 'error');
      }
    };
    reader.readAsText(file);
  };

  $('btn-reset-default-leads').onclick = async () => {
    const ok = await ask('هل تريد إعادة تعيين قائمة العملاء إلى الـ 11,149 عميل الأصليين من الشيت؟');
    if (!ok) return;
    localStorage.removeItem('crm_custom_leads');
    if (state.D && state.D.rows) {
      state.S = [...state.D.rows];
    } else {
      const pw = sessionStorage.getItem('crm_admin_pw');
      if (pw) {
        state.D = await decryptAll(pw);
        state.S = [...state.D.rows];
      }
    }
    markFirstOccurrences();
    toast('تمت استعادة الداتا الأصلية من الشيت بنجاح ✓', 'success');
    renderApp();
  };
}

// ----------------- CONFIGURABLE EXCEL / CSV IMPORT ENGINE -----------------
const COLUMN_MAPPINGS = {
  name: ['Arabic Name', 'Business Name', 'storeName', 'English Name', 'الاسم', 'اسم العميل', 'العميل', 'اسم المنشأة', 'Name', 'name', 'Company', 'الشركة'],
  phone: ['Phone', 'phone', 'WhatsApp', 'whatsapp', 'الهاتف', 'التليفون', 'الموبايل', 'رقم الهاتف', 'الجوال', 'Mobile', 'mobile'],
  category: ['Category', 'Type', 'themeName', 'النشاط', 'المجال', 'التصنيف', 'النوع', 'category', 'Industry'],
  city: ['City', 'District', 'Country', 'المدينة', 'المحافظة', 'المنطقة', 'العنوان', 'city', 'Location'],
  email: ['Email', 'email', 'البريد', 'البريد الإلكتروني', 'الايميل', 'e-mail'],
  website: ['Website', 'storeUrl', 'الموقع', 'المتجر', 'الموقع الإلكتروني', 'website', 'Site', 'site', 'URL', 'url'],
  maps: ['Google Maps', 'Maps', 'رابط الخريطة', 'اللوكيشن', 'maps', 'location_url', 'google_maps', 'maps_link'],
  instagram: ['Instagram', 'instagram', 'انستقرام', 'انستجرام', 'حساب انستجرام', 'IG', 'ig'],
  platform: ['Platform', 'platform', 'المنصة', 'المصدر', 'Source', 'source']
};

function extractMappedField(item, mappingKeys) {
  for (const k of mappingKeys) {
    if (item[k] !== undefined && item[k] !== null && String(item[k]).trim() !== '') {
      return String(item[k]).trim();
    }
  }
  return '';
}

let parsedImportRows = [];

function processWorkbook(workbook, statusEl) {
  parsedImportRows = [];
  let globalId = state.S.length + 1;
  const seenPhones = new Set();
  state.S.forEach(r => { if (r[6]) seenPhones.add(r[6]); });

  workbook.SheetNames.forEach(sheetName => {
    if (sheetName === 'ملخص') return;
    const worksheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(worksheet);

    json.forEach(item => {
      const name = extractMappedField(item, COLUMN_MAPPINGS.name);
      const rawPhone = extractMappedField(item, COLUMN_MAPPINGS.phone).replace(/[^0-9+]/g, '');
      if (!name && !rawPhone) return;

      let phone = rawPhone;
      if (phone.startsWith('00')) phone = '+' + phone.slice(2);

      const cat = extractMappedField(item, COLUMN_MAPPINGS.category);
      const city = extractMappedField(item, COLUMN_MAPPINGS.city);
      const wa = extractMappedField(item, COLUMN_MAPPINGS.phone) ? ('https://wa.me/' + phone.replace(/[^0-9]/g, '')) : '';
      const site = extractMappedField(item, COLUMN_MAPPINGS.website);
      const ig = extractMappedField(item, COLUMN_MAPPINGS.instagram);
      const plat = extractMappedField(item, COLUMN_MAPPINGS.platform) || sheetName;
      const maps = extractMappedField(item, COLUMN_MAPPINGS.maps);

      const mapsUrl = maps || (name && city ? ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name + ' ' + city)) : '');
      const hasWeb = !!site && site.length > 3;

      const hasDupFlag = !!(item['تكرار'] || item['سبب التكرار'] || item['مكرر مع']);
      const isPhoneDup = phone.length > 7 && seenPhones.has(phone);
      if (phone.length > 7) seenPhones.add(phone);

      const row = [
        'c_' + globalId++,
        sheetName,
        globalId,
        name,
        cat,
        city,
        phone,
        wa,
        site,
        ig,
        mapsUrl,
        plat,
        hasWeb,
        item['Lead Reason'] || '',
        hasDupFlag || isPhoneDup,
        Date.now()
      ];
      parsedImportRows.push(row);
    });
  });

  if (!parsedImportRows.length) {
    statusEl.textContent = 'لم يتم العثور على أي صفوف صالحة في هذا الملف!';
    statusEl.style.color = 'var(--danger)';
    $('btn-confirm-excel-import').disabled = true;
    return;
  }

  statusEl.innerHTML = `
    <b style="color:var(--success)">✓ تم تحليل البيانات بنجاح!</b>
    <br>تم استخراج <b>${parsedImportRows.length.toLocaleString('en')}</b> عميل صالح عبر <b>${workbook.SheetNames.length}</b> شيت.
  `;
  $('btn-confirm-excel-import').disabled = false;
}

async function handleExcelFileSelect(file) {
  if (!file) return;
  const fileName = file.name;
  const statusEl = $('excel-import-status');
  statusEl.textContent = `جاري قراءة الملف "${fileName}"...`;
  statusEl.style.color = 'var(--text-muted)';

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    processWorkbook(workbook, statusEl);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'حدث خطأ أثناء قراءة ملف الإكسيل. تأكد من سلامة الملف وصيغته (.xlsx أو .csv)';
    statusEl.style.color = 'var(--danger)';
    $('btn-confirm-excel-import').disabled = true;
  }
}

async function handleOnlineExcelFetch(rawUrl) {
  const url = (rawUrl || '').trim();
  const statusEl = $('excel-import-status');
  if (!url) {
    statusEl.textContent = 'من فضلك الصق رابط الشيت أولاً.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  statusEl.textContent = 'جاري محاولة الاتصال وقراءة البيانات من الرابط...';
  statusEl.style.color = 'var(--text-muted)';
  $('btn-confirm-excel-import').disabled = true;

  // Detect OneDrive link
  if (url.includes('1drv.ms') || url.includes('onedrive.live.com')) {
    statusEl.innerHTML = `
      <b style="color:var(--warning)">⚠️ تنبيه بخصوص رابط OneDrive:</b><br>
      مايكروسوفت OneDrive تمنع المتصفحات من سحب الملفات المباشرة لحماية الخصوصية (CORS).<br>
      <br>
      <b>✅ الخطوة البسيطة للحل (ثواني معدودة):</b><br>
      1. افتح رابط الـ OneDrive في نافذة جديدة.<br>
      2. اضغط من الأعلى: <b>ملف (File) &gt; حفظ باسم (Save As) &gt; تنزيل نسخة (Download a Copy)</b>.<br>
      3. ارجع هنا لتبويب <b>"رفع ملف من الجهاز"</b> واسحب الملف المحمل.<br>
      <br>
      <small style="color:var(--text-dim)">💡 لو بترفع الملف على Google Sheets بدلاً من OneDrive، تقدر تنشره على الويب (File &gt; Share &gt; Publish to web) وتسحبه أونلاين مباشرة بدون تحميل.</small>
    `;
    return;
  }

  let fetchUrl = url;
  if (url.includes('docs.google.com/spreadsheets')) {
    if (!url.includes('output=csv') && !url.includes('export?format=')) {
      fetchUrl = url.replace(/\/edit.*$/, '/export?format=xlsx');
    }
  }

  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    processWorkbook(workbook, statusEl);
  } catch (err) {
    console.error(err);
    statusEl.innerHTML = `
      <b style="color:var(--danger)">تعذّر جلب الملف من هذا الرابط مباشرة عبر المتصفح (CORS).</b><br>
      الرجاء تنزيل الملف على جهازك وسحبه في تبويب "رفع ملف من الجهاز".
    `;
    $('btn-confirm-excel-import').disabled = true;
  }
}

async function confirmExcelImport() {
  if (!parsedImportRows.length) return;
  const isAppend = $('excel-import-mode-append').checked;

  if (isAppend) {
    state.S = [...state.S, ...parsedImportRows];
  } else {
    state.S = parsedImportRows;
  }

  // Security: Customer data kept purely in JS memory, NEVER stored unencrypted
  markFirstOccurrences();
  $('modal-excel-import').classList.remove('active');
  parsedImportRows = [];
  $('excel-file-input').value = '';

  toast(`تم استيراد ${state.S.length.toLocaleString('en')} عميل بنجاح إلى الداشبورد! 🎉`, 'success');
  renderApp();
}

// ----------------- GLOBAL EVENT LISTENERS -----------------
function setupEventListeners() {
  // Login Submissions
  $('btn-admin-login').onclick = handleAdminLogin;
  $('admin-login-pw').onkeydown = (e) => { if (e.key === 'Enter') handleAdminLogin(); };

  $('btn-team-login').onclick = handleTeamLogin;
  $('team-login-pw').onkeydown = (e) => { if (e.key === 'Enter') handleTeamLogin(); };

  // Logout
  $('btn-logout').onclick = async () => {
    state.me = null;
    state.sess = '';
    state.D = null;
    state.S = [];
    state.selectedCids.clear();
    sessionStorage.removeItem('crm_sess');
    sessionStorage.removeItem('crm_is_owner');
    sessionStorage.removeItem('crm_admin_pw');
    if (state.asgUnsubscribe) {
      state.asgUnsubscribe();
      state.asgUnsubscribe = null;
    }
    renderApp();
    toast('تم تسجيل الخروج بنجاح', 'info');
  };

  // Leads View Filters
  $('search-leads').addEventListener('input', debounce(filterLeads, 150));
  $('clear-search-btn').onclick = () => {
    $('search-leads').value = '';
    filterLeads();
  };
  $('filter-sheet').onchange = filterLeads;
  if ($('filter-website')) $('filter-website').onchange = filterLeads;
  $('filter-status').onchange = filterLeads;
  if ($('filter-notes')) $('filter-notes').onchange = filterLeads;
  $('filter-duplicate').onchange = filterLeads;
  if ($('filter-assignee')) $('filter-assignee').onchange = filterLeads;
  if ($('filter-selected')) $('filter-selected').onchange = filterLeads;

  // Master Checkbox in Leads Table Header
  if ($('select-all-leads')) {
    $('select-all-leads').onchange = (e) => {
      handleSelectAllToggle(e.target.checked);
    };
  }

  // Canvas Table Window Resize Listener
  window.addEventListener('resize', () => {
    if (state.canvasTable) state.canvasTable.handleResize();
  });

  // Floating Selection Dock Buttons
  $('btn-dock-assign').onclick = handleDockAssignSelected;
  $('btn-dock-unassign').onclick = handleDockUnassignSelected;
  $('btn-dock-clear').onclick = () => {
    state.selectedCids.clear();
    updateSelectAllCheckbox();
    renderSelectionDock();
    renderCanvasTable();
  };

  // Bulk Modal Triggers
  $('btn-open-bulk-modal').onclick = () => {
    $('modal-bulk-assign').classList.add('active');
  };
  $('btn-bulk-modal-cancel').onclick = () => {
    $('modal-bulk-assign').classList.remove('active');
  };
  $('btn-bulk-modal-submit').onclick = handleBulkCountAssign;

  // Excel Import Modal Triggers
  $('btn-open-excel-import').onclick = () => {
    $('modal-excel-import').classList.add('active');
    $('excel-import-status').textContent = 'اختر ملف إكسيل (.xlsx, .xls, .csv) للبدء في تحليله.';
    $('excel-import-status').style.color = 'var(--text-muted)';
    $('btn-confirm-excel-import').disabled = true;
  };
  $('btn-excel-import-cancel').onclick = () => {
    $('modal-excel-import').classList.remove('active');
  };
  $('excel-file-input').onchange = (e) => {
    handleExcelFileSelect(e.target.files[0]);
  };
  $('btn-confirm-excel-import').onclick = confirmExcelImport;

  // Drag and drop in import dropzone
  const dropzone = $('excel-dropzone');
  if (dropzone) {
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--primary)'; };
    dropzone.ondragleave = () => { dropzone.style.borderColor = 'var(--border-medium)'; };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border-medium)';
      if (e.dataTransfer.files.length) {
        handleExcelFileSelect(e.dataTransfer.files[0]);
      }
    };
  }

  // Excel import tab switching
  const tabImportFile = $('tab-import-file');
  const tabImportUrl = $('tab-import-url');
  if (tabImportFile && tabImportUrl) {
    tabImportFile.onclick = () => {
      tabImportFile.classList.add('active');
      tabImportUrl.classList.remove('active');
      if ($('section-import-file')) $('section-import-file').style.display = 'block';
      if ($('section-import-url')) $('section-import-url').style.display = 'none';
    };
    tabImportUrl.onclick = () => {
      tabImportUrl.classList.add('active');
      tabImportFile.classList.remove('active');
      if ($('section-import-url')) $('section-import-url').style.display = 'block';
      if ($('section-import-file')) $('section-import-file').style.display = 'none';
    };
  }

  const btnFetchOnline = $('btn-fetch-online-excel');
  if (btnFetchOnline) {
    btnFetchOnline.onclick = () => {
      handleOnlineExcelFetch($('excel-url-input').value);
    };
  }

  // Setup lead notes modal interactions
  setupNotesModalEvents();
}

// ----------------- LOGIN LOGIC -----------------
async function handleAdminLogin() {
  const pw = $('admin-login-pw').value.trim();
  const msg = $('admin-login-msg');
  msg.textContent = '';

  if (!pw) {
    msg.textContent = 'من فضلك اكتب كلمة مرور السوبر أدمن';
    return;
  }

  const btn = $('btn-admin-login');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.textContent = '⏳ جاري فك التشفير والتحقق من الشيت...';

  try {
    const data = await decryptAll(pw);
    state.D = data;
    state.S = [...data.rows];
    markFirstOccurrences();
    state.me = { id: 'admin', name: 'سوبر أدمن', isOwner: true };
    state.sess = 'admin';
    sessionStorage.setItem('crm_sess', 'admin');
    sessionStorage.setItem('crm_is_owner', 'true');
    sessionStorage.setItem('crm_admin_pw', pw);

    $('admin-login-pw').value = '';
    toast(`تم فك التشفير بنجاح! تم تحميل ${state.S.length.toLocaleString('en')} عميل من الشيت جاهزين للإسناد 🎉`, 'success');
    renderApp();
  } catch (err) {
    console.error('Decryption failed:', err);
    msg.textContent = '❌ كلمة المرور غير صحيحة! لم نتمكن من فك تشفير بيانات الشيت.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

async function handleTeamLogin() {
  const u = $('team-login-user').value.trim().toLowerCase();
  const p = $('team-login-pw').value;
  const msg = $('team-login-msg');
  msg.textContent = '';

  if (!u || !p) {
    msg.textContent = 'اكتب اسم الدخول وكلمة المرور';
    return;
  }

  msg.textContent = 'جاري التحقق...';
  try {
    const userDoc = await db.doc(`users/${u}`).get();
    if (!userDoc.exists) {
      msg.textContent = 'بيانات الدخول غير صحيحة';
      return;
    }
    const cred = userDoc.data();
    const hashed = await hpw(p, b2u(cred.salt), cred.it);

    if (hashed !== cred.hash) {
      msg.textContent = 'بيانات الدخول غير صحيحة';
      return;
    }

    state.sess = u;
    state.me = { id: u, name: nm(u), isOwner: false };
    sessionStorage.setItem('crm_sess', u);
    sessionStorage.setItem('crm_is_owner', 'false');

    $('team-login-pw').value = '';
    toast(`أهلاً بك ${nm(u)} ✓`, 'success');
    renderApp();
  } catch (err) {
    console.error(err);
    msg.textContent = 'تعذّر تسجيل الدخول';
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
