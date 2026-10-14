import { decryptAll, hpw, mkCred, b2u } from './crypto.js';
import { db, dbManager } from './storage.js';
import { CanvasCustomerTable } from './canvasTable.js';
import { LX, ROW_LEN, leadExtras } from './leadFields.js';
import { initIcons } from './icons.js';
import { getSupabaseConfig, saveSupabaseConfig, resetSupabaseClient } from './supabase.js';
import * as XLSX from 'xlsx';

// imgbb image hosting for lead-note screenshots (site feedback, issues, etc.)
// Key is a public client-side upload key (upload-only, safe to ship in frontend).
const IMGBB_API_KEY = '53626d4fadf063b8516406c1553a356d';
const IMGBB_UPLOAD_URL = `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`;

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
  AU: [],        // Audit log entries, newest first (Super Admin only)
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

// Toolbar attribute filters, populated from the loaded rows.
// `none` adds an option for rows without a value (selected as NO_VALUE).
const NO_VALUE = '__none__';
const PLATFORM_LABELS = { custom: 'موقع مبرمج خاص (custom)' };
const ATTR_FILTERS = [
  {
    id: 'filter-platform',
    get: r => (r[11] && !/^https?:/i.test(r[11]) ? r[11] : ''), // legacy rows may hold a maps URL here
    all: 'كل المنصات (سلة، زد...)',
    none: 'بدون منصة معروفة',
    label: v => PLATFORM_LABELS[v] || v
  },
  { id: 'filter-sector', get: r => r[LX.SECTOR], all: 'كل القطاعات' },
  { id: 'filter-service', get: r => r[LX.SERVICE], all: 'كل الخدمات المقترحة' },
  { id: 'filter-erp', get: r => r[LX.ERP_GRADE], all: 'كل تصنيفات ERP', label: v => 'ERP ' + v, sortByValue: true }
];

// Utility functions
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nm = (id) => state.N[id] || (state.R.get(id)?.name) || id || '—';
const fmt = (t) => t ? new Date(t).toLocaleString('ar-EG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

export function getPortalBaseUrl() {
  const saved = localStorage.getItem('crm_portal_url');
  if (saved) return saved.replace(/\/+$/, '');
  if (import.meta.env?.VITE_PORTAL_URL) return import.meta.env.VITE_PORTAL_URL.replace(/\/+$/, '');
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return 'https://tab3-amber.vercel.app';
  }
  return 'http://localhost:5174';
}

// Toast Notification
export function toast(msg, type = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  const icon = type === 'success' ? 'check-circle-2' : type === 'error' ? 'x-circle' : 'info';
  el.innerHTML = `<i data-lucide="${icon}"></i> <span>${esc(msg)}</span>`;
  container.appendChild(el);
  initIcons();
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

// ----------------- AUDIT LOG -----------------
// One doc per local day (audit/YYYY-MM-DD -> { entries: [...] }); days older than
// AUDIT_KEEP_DAYS are pruned when a new day starts. Writes go through a queue so two
// quick actions can't overwrite each other's read-modify-write of the day doc.
const AUDIT_KEEP_DAYS = 90;
const AUDIT_TYPES = {
  auth: 'الدخول والخروج',
  user: 'فريق العمل',
  assign: 'الإسناد',
  lead: 'التواصل والملاحظات',
  client: 'التنفيذ',
  data: 'البيانات'
};
let auditQueue = Promise.resolve();

const localDay = (t) => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

function auditActor() {
  return state.me?.isOwner ? 'admin' : (state.sess || '');
}

/** Record who did what. `by` defaults to the signed-in user ('' for anonymous, e.g. a failed login). */
function logAudit(type, summary, { by = auditActor(), target = '' } = {}) {
  const entry = { at: Date.now(), by, type, summary, target };
  auditQueue = auditQueue.then(async () => {
    const ref = db.doc(`audit/${localDay(entry.at)}`);
    const snap = await ref.get();
    const entries = snap.exists ? (snap.data().entries || []) : [];
    entries.push(entry);
    await ref.set({ entries });
    if (!snap.exists) await pruneAudit();
  }).catch(err => console.warn('Audit log write failed:', err));
  return auditQueue;
}

async function pruneAudit() {
  const cutoff = localDay(Date.now() - AUDIT_KEEP_DAYS * 86400000);
  const snap = await db.collection('audit').get();
  await Promise.all(snap.docs.filter(d => d.id < cutoff).map(d => db.doc(`audit/${d.id}`).delete()));
}

// ----------------- PASSWORD HELPERS -----------------
// Plaintext passwords the admin set during this session, so "copy login details" can include
// them. Memory only: stored credentials are PBKDF2 hashes and can never be shown again.
const sessionPasswords = new Map();

function generatePassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/l/I)
  const out = [];
  while (out.length < len) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < 256 - (256 % chars.length)) out.push(chars[b % chars.length]); // reject to avoid modulo bias
  }
  return out.join('');
}

function setPasswordVisible(input, show) {
  input.type = show ? 'text' : 'password';
  const btn = input.parentNode.querySelector('.pw-toggle');
  if (!btn) return;
  btn.title = show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
  initIcons();
}

/** Wraps a password input with a show/hide (eye) button. Safe to call more than once. */
function addPasswordToggle(input) {
  if (!input || input.dataset.pwToggle) return;
  input.dataset.pwToggle = '1';
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  btn.onclick = () => {
    setPasswordVisible(input, input.type === 'password');
    input.focus();
  };
  wrap.appendChild(btn);
  setPasswordVisible(input, false);
}

function copyText(text, successMsg) {
  return navigator.clipboard.writeText(text)
    .then(() => toast(successMsg, 'success'))
    .catch(() => prompt('انسخ البيانات:', text));
}

function teamLoginDetails(uid, pw) {
  const profile = state.R.get(uid) || {};
  return [
    `أهلاً ${profile.name || uid}`,
    'دي بيانات دخولك على داشبورد المبيعات والتنفيذ:',
    `الرابط: ${window.location.origin}`,
    'نوع الحساب: فريق العمل',
    `اسم الدخول: ${uid}`,
    `كلمة المرور: ${pw}`,
    `القسم: ${ROLES[profile.role] || profile.role || '—'}`
  ].join('\n');
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
      toast('نسخ أو استخراج بيانات العملاء غير مسموح لدواعي الأمان والسرية', 'warning');
    }, { capture: true });
  });

  // 2. Prevent keyboard shortcuts: Ctrl+C, Ctrl+A (on table), Ctrl+X, Ctrl+S, Ctrl+U, Ctrl+P, F12, DevTools
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a', 's', 'p', 'u'].includes(k) && !isInput) {
      e.preventDefault();
      toast('النسخ والطباعة وحفظ الصفحة معطل للحفاظ على سرية العملاء', 'warning');
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
  initIcons();

  // Initialize storage manager (handles local or firebase)
  await dbManager.init();

  // Listen to storage status
  dbManager.onStatusChange((status) => {
    const badge = $('sync-status-badge');
    if (badge) {
      badge.className = 'sync-badge ' + (status.isCloud ? 'cloud' : 'local');
      $('sync-status-text').textContent = status.modeText;
    }
  });

  const syncBadge = $('sync-status-badge');
  if (syncBadge) {
    syncBadge.style.cursor = 'pointer';
    syncBadge.addEventListener('click', () => {
      const isAdmin = state.role === 'owner' || state.me?.isOwner || state.sess === 'admin';
      if (isAdmin) {
        openSupabaseSettingsModal();
      }
    });
  }

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
    const icon = $('theme-icon');
    if (icon) {
      icon.setAttribute('data-lucide', state.isThemeDark ? 'moon' : 'sun');
      initIcons();
    }
    if (state.canvasTable) state.canvasTable.setTheme(state.isThemeDark);
  };
  const icon = $('theme-icon');
  if (icon) {
    icon.setAttribute('data-lucide', state.isThemeDark ? 'moon' : 'sun');
    initIcons();
  }
}

// ----------------- Authentication & Roles -----------------
function getMyRole() {
  if (state.me?.isOwner || state.sess === 'admin') return 'owner';
  if (!state.sess) return '';
  const prof = state.R.get(state.sess);
  return prof ? prof.role : '';
}

export function openMobileDrawer() {
  const drawer = $('mobile-nav-drawer');
  const overlay = $('mobile-nav-overlay');
  if (drawer) drawer.classList.add('active');
  if (overlay) overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

export function closeMobileDrawer() {
  const drawer = $('mobile-nav-drawer');
  const overlay = $('mobile-nav-overlay');
  if (drawer) drawer.classList.remove('active');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
}

function renderApp() {
  state.role = getMyRole();
  // CSS keys off this to hide [data-admin-only] controls for everyone but the Super Admin
  document.body.dataset.role = state.role || '';

  // If not logged in, show login view
  if (!state.me?.isOwner && !state.sess) {
    showView('login');
    $('nav-tabs-container').style.display = 'none';
    if ($('btn-mobile-menu')) $('btn-mobile-menu').style.display = 'none';
    $('header-user-info').style.display = 'none';
    $('btn-logout').style.display = 'none';
    if ($('sync-status-badge')) $('sync-status-badge').style.display = 'none';
    closeMobileDrawer();
    initIcons();
    return;
  }

  if ($('btn-mobile-menu')) $('btn-mobile-menu').style.display = '';
  $('btn-logout').style.display = 'flex';
  $('header-user-info').style.display = 'flex';
  $('nav-tabs-container').style.display = 'flex';

  const isAdmin = state.role === 'owner' || state.me?.isOwner || state.sess === 'admin';
  const syncBadgeEl = $('sync-status-badge');
  if (syncBadgeEl) {
    syncBadgeEl.style.display = isAdmin ? 'inline-flex' : 'none';
  }

  const userDisplayName = state.me?.isOwner ? 'سوبر أدمن' : nm(state.sess);
  const roleTitle = state.role === 'owner' ? 'المالك / Super Admin' : (ROLES[state.role] || state.role);
  $('user-name-display').textContent = userDisplayName;
  $('user-role-badge').textContent = roleTitle;

  const drawerUserInfo = $('mobile-drawer-user-info');
  if (drawerUserInfo) {
    drawerUserInfo.innerHTML = `
      <div style="width: 38px; height: 38px; border-radius: 50%; background: var(--primary-soft); display: flex; align-items: center; justify-content: center; color: var(--primary); flex-shrink: 0;">
        <i data-lucide="user"></i>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 800; font-size: 14px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(userDisplayName)}</div>
        <div style="font-size: 11.5px; color: var(--primary); font-weight: 700;">${esc(roleTitle)}</div>
      </div>
    `;
  }

  setupAssignmentListener();
  setupAuditListener();
  renderTabs();
  showView(state.view);

  // Render current tab contents
  if (state.view === 'leads') renderLeadsView();
  else if (state.view === 'clients') renderClientsView();
  else if (state.view === 'stats') renderStatsView();
  else if (state.view === 'users') renderUsersView();
  else if (state.view === 'audit') renderAuditView();

  initIcons();
}

function renderTabs() {
  const container = $('nav-tabs-container');
  const drawerLinks = $('mobile-nav-links');
  const tabs = [];

  if (state.role === 'owner') {
    tabs.push(
      { id: 'leads', label: 'العملاء المحتملين', shortLabel: 'العملاء', icon: 'users' },
      { id: 'clients', label: 'التنفيذ والمشاريع', shortLabel: 'التنفيذ', icon: 'briefcase' },
      { id: 'stats', label: 'الإحصائيات', shortLabel: 'الإحصائيات', icon: 'bar-chart-3' },
      { id: 'users', label: 'فريق العمل', shortLabel: 'الفريق', icon: 'user-check' },
      { id: 'audit', label: 'سجل النشاط', shortLabel: 'السجل', icon: 'history' }
    );
  } else if (state.role === 'sales') {
    // Sales only work their leads; execution projects are for the admin and the delivery departments
    tabs.push({ id: 'leads', label: 'عملاء المبيعات المحتملين', shortLabel: 'العملاء', icon: 'users' });
  } else if (DEPTS.includes(state.role)) {
    tabs.push({ id: 'clients', label: 'مشاريع التنفيذ', shortLabel: 'التنفيذ', icon: 'briefcase' });
  }

  if (!tabs.some(t => t.id === state.view)) {
    state.view = tabs[0]?.id || 'leads';
  }

  // 1. Desktop Nav Tabs
  if (container) {
    container.innerHTML = tabs.map(t => `
      <button class="tab-btn ${t.id === state.view ? 'active' : ''}" data-tab="${t.id}" title="${t.label}">
        <i data-lucide="${t.icon}"></i>
        <span class="tab-label-long">${t.label}</span>
        <span class="tab-label-short">${t.shortLabel}</span>
      </button>
    `).join('');

    container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.onclick = () => {
        state.view = btn.dataset.tab;
        renderApp();
      };
    });
  }

  // 2. Mobile Nav Drawer Links
  if (drawerLinks) {
    drawerLinks.innerHTML = tabs.map(t => `
      <button class="mobile-nav-item ${t.id === state.view ? 'active' : ''}" data-tab="${t.id}">
        <i data-lucide="${t.icon}"></i>
        <span>${t.label}</span>
      </button>
    `).join('');

    drawerLinks.querySelectorAll('[data-tab]').forEach(btn => {
      btn.onclick = () => {
        state.view = btn.dataset.tab;
        closeMobileDrawer();
        renderApp();
      };
    });
  }

  initIcons();
}

function showView(viewId) {
  document.querySelectorAll('.view-container').forEach(el => {
    el.classList.toggle('active', el.id === `view-${viewId}`);
  });
  // Monochrome login screen (header included); see .auth-mode in style.css
  document.body.classList.toggle('auth-mode', viewId === 'login');
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
            rows.push(r);
          });
        });
      state.S = rows;
      markFirstOccurrences();
    }
    renderLater();
  });
}

// ----------------- LEADS VIEW & SPECIFIC SELECTION -----------------
function updateToolbarForRole() {
  const isOwner = state.role === 'owner';

  // Admin-only controls are hidden by CSS (body[data-role]). Here: make sure a hidden
  // filter can't keep filtering, and that admin-only sort options can't be picked.
  document.querySelectorAll('#toolbar-filters-wrap [data-admin-only]').forEach(el => {
    if (el.tagName === 'OPTION') {
      el.hidden = !isOwner;
      el.disabled = !isOwner;
    } else if (el.tagName === 'SELECT' && !isOwner) {
      el.value = '';
    }
  });
  const sortSel = $('filter-sort');
  if (sortSel && sortSel.selectedOptions[0]?.disabled) sortSel.value = 'default';

  const search = $('search-leads');
  if (search) {
    search.placeholder = isOwner
      ? 'بحث بالاسم، الرقم، المدينة، النشاط، الشيت...'
      : 'بحث بالاسم، الرقم، المدينة، النشاط...';
  }

  const dock = $('selection-dock');
  if (dock && !isOwner) {
    dock.classList.remove('active');
  }
}

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
          <div style="width: 56px; height: 56px; margin: 0 auto 14px; border-radius: var(--radius-lg); background: var(--primary-soft); display: flex; align-items: center; justify-content: center; color: var(--primary);">
            <i data-lucide="lock" style="width: 30px; height: 30px;"></i>
          </div>
          <h2 style="font-size: 21px; font-weight: 800; margin-bottom: 8px;">بيانات العملاء مشفرة بالكامل</h2>
          <p style="color: var(--text-muted); font-size: 13.5px; line-height: 1.6; margin-bottom: 22px;">
            لحماية البيانات ومنع استخراجها أو نسخها، تم قفل الـ 11,149 عميل بتشفير عسكري (AES-256-GCM). لن يتم تحميل أي صفوف في الـ DOM إلا بعد إدخال الباسورد.
          </p>
          <div style="display: flex; gap: 8px; max-width: 380px; margin: 0 auto;">
            <input id="leads-unlock-pw" type="password" placeholder="اكتب الباسورد لفك التشفير..." style="flex: 1; margin-bottom: 0;" autocomplete="off" />
            <button id="btn-leads-unlock" class="btn-primary" style="height: 44px; padding: 0 20px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px;">
              <i data-lucide="key-round"></i>
              <span>فك القفل</span>
            </button>
          </div>
          <div id="leads-unlock-msg" class="msg" style="color: var(--danger); font-size: 13px; margin-top: 12px; min-height: 20px;"></div>
        </div>
      `;
      $('view-leads').appendChild(lockEl);
      initIcons();

      const unlockAction = async () => {
        const pw = $('leads-unlock-pw').value.trim();
        const msg = $('leads-unlock-msg');
        msg.textContent = '';
        if (!pw) { msg.textContent = 'اكتب كلمة المرور أولاً'; return; }
        const btn = $('btn-leads-unlock');
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="refresh-cw" class="spin"></i> <span>جاري فك التشفير...</span>`;
        initIcons();
        try {
          const data = await decryptAll(pw);
          state.D = data;
          state.S = [...data.rows];
          markFirstOccurrences();
          sessionStorage.setItem('crm_admin_pw', pw);
          toast(`تم فك تشفير ${state.S.length.toLocaleString('en')} عميل بنجاح`, 'success');
          lockEl.remove();
          $('leads-main-content').style.display = 'flex';
          renderLeadsView();
        } catch (e) {
          msg.textContent = 'كلمة المرور غير صحيحة! لن يتم عرض أي بيانات.';
        } finally {
          btn.disabled = false;
          btn.innerHTML = `<i data-lucide="key-round"></i> <span>فك القفل</span>`;
          initIcons();
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

  updateToolbarForRole();
  populateFilterDropdowns();
  filterLeads();
  renderKPIs();
  renderSelectionDock();
  initIcons();
  if (state.canvasTable) {
    requestAnimationFrame(() => state.canvasTable.handleResize());
  }
}

// Mark first occurrences to detect duplicate leads
function markFirstOccurrences() {
  const seenPhones = new Set();
  state.byCid.clear();
  state.S.forEach(r => {
    state.byCid.set(r[0], r);

    const rawPhone = (r[6] || '').trim();
    const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
    const isPhoneDup = cleanPhone.length > 7 && seenPhones.has(cleanPhone);
    const isMarkedDup = !!r[14];

    // Duplicate if marked in dataset or if phone number already occurred
    const isDup = isMarkedDup || isPhoneDup;
    r.first = !isDup;

    if (cleanPhone.length > 7) {
      seenPhones.add(cleanPhone);
    }
  });
}

function populateFilterDropdowns() {
  const sheets = [...new Set(state.S.map(r => r[1]))];
  const fs = $('filter-sheet');
  const prevFs = fs.value;
  fs.innerHTML = '<option value="">كل الشيتات والمصادر (' + sheets.length + ')</option>' + sheets.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  fs.value = prevFs;

  // Lead attribute filters: hidden when the loaded rows don't carry the field
  ATTR_FILTERS.forEach(({ id, get, all, none, label = v => v, sortByValue }) => {
    const sel = $(id);
    if (!sel) return;
    const counts = new Map();
    let noneCount = 0;
    state.S.forEach(r => {
      const v = get(r);
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
      else noneCount++;
    });
    const prev = sel.value;
    const opts = sortByValue
      ? [...counts.keys()].sort()
      : [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const showNone = !!(none && noneCount && counts.size);
    sel.innerHTML = `<option value="">${all}</option>` +
      opts.map(v => `<option value="${esc(v)}">${esc(label(v))} (${counts.get(v).toLocaleString('en')})</option>`).join('') +
      (showNone ? `<option value="${NO_VALUE}">${none} (${noneCount.toLocaleString('en')})</option>` : '');
    sel.value = counts.has(prev) || (prev === NO_VALUE && showNone) ? prev : '';
    sel.style.display = counts.size ? '' : 'none';
  });

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
  const fattrs = ATTR_FILTERS
    .map(f => [f.get, $(f.id) ? $(f.id).value : ''])
    .filter(([, v]) => v)
    .map(([get, v]) => [get, v === NO_VALUE ? '' : v]);

  state.filteredIndices = [];

  if (state.S.length > 0 && state.S[0]?.first === undefined) {
    markFirstOccurrences();
  }

  for (let i = 0; i < state.S.length; i++) {
    const r = state.S[i];
    const cid = r[0];
    const st = state.L.get(cid) || {};

    // Sheet filter
    if (fs && r[1] !== fs) continue;

    // Platform / sector / suggested service / ERP grade filters
    if (fattrs.some(([get, v]) => (get(r) || '') !== v)) continue;

    // Website presence filter (r[12] is boolean hasWebsite)
    if (fweb === 'has_web' && !r[12]) continue;
    if (fweb === 'no_web' && r[12]) continue;

    // Notes filter (text OR attached imgbb images count as notes)
    if (fnotes === 'has_notes' && !hasLeadNotes(st)) continue;
    if (fnotes === 'no_notes' && hasLeadNotes(st)) continue;

    // Duplicate filter
    const isDup = !!r[14] || !r.first;
    if (fd === 'unique' && isDup) continue;
    if (fd === 'dup' && !isDup) continue;

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
        r._searchText = [r[3], r[4], r[5], r[6], r[1], r[13], r[LX.SECTOR], r[LX.SERVICE], r[LX.EMAIL]].filter(Boolean).join(' ').toLowerCase();
      }
      const matchText = r._searchText.includes(q);
      const matchNotes = st.notes && st.notes.toLowerCase().includes(q);
      const matchImgs = getNoteImages(st).some(o => {
        const url = (typeof o === 'string' ? o : o.url || '').toLowerCase();
        const cap = (typeof o === 'string' ? '' : (o.caption || '')).toLowerCase();
        return url.includes(q) || (cap && cap.includes(q));
      });
      if (!matchText && !matchNotes && !matchImgs) continue;
    }

    state.filteredIndices.push(i);
  }

  // Sort filtered leads by #filter-sort
  const fsort = $('filter-sort') ? $('filter-sort').value : 'default';
  if (fsort && fsort !== 'default') {
    state.filteredIndices.sort((a, b) => {
      const ra = state.S[a];
      const rb = state.S[b];
      if (fsort === 'index_desc') return b - a;
      if (fsort === 'name_asc') return (ra[3] || '').localeCompare(rb[3] || '', 'ar');
      if (fsort === 'name_desc') return (rb[3] || '').localeCompare(ra[3] || '', 'ar');
      if (fsort === 'category') return (ra[4] || '').localeCompare(rb[4] || '', 'ar');
      if (fsort === 'city') return (ra[5] || '').localeCompare(rb[5] || '', 'ar');
      if (fsort === 'no_web_first') {
        const aNoWeb = !ra[12] ? 1 : 0;
        const bNoWeb = !rb[12] ? 1 : 0;
        return bNoWeb - aNoWeb;
      }
      if (fsort === 'has_notes_first') {
        const aNotes = hasLeadNotes(state.L.get(ra[0])) ? 1 : 0;
        const bNotes = hasLeadNotes(state.L.get(rb[0])) ? 1 : 0;
        return bNotes - aNotes;
      }
      if (fsort === 'erp_desc') return (Number(rb[LX.ERP_SCORE]) || 0) - (Number(ra[LX.ERP_SCORE]) || 0);
      if (fsort === 'reach_desc') return (Number(rb[LX.REACH]) || 0) - (Number(ra[LX.REACH]) || 0);
      return 0;
    });
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
    if (colId === 'index') {
      return asc ? (idxA - idxB) : (idxB - idxA);
    }
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
      case 'opportunity':
        valA = rA[LX.SERVICE] || '';
        valB = rB[LX.SERVICE] || '';
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
        valA = (rA[14] || !rA.first) ? '1' : '0';
        valB = (rB[14] || !rB.first) ? '1' : '0';
        break;
      case 'assignee':
        valA = state.A.get(rA[0]) || '';
        valB = state.A.get(rB[0]) || '';
        break;
      case 'notes': {
        const sa = state.L.get(rA[0]);
        const sb = state.L.get(rB[0]);
        valA = (sa?.notes || '') + (getNoteImages(sa).length ? ` 📷${getNoteImages(sa).length}` : '');
        valB = (sb?.notes || '') + (getNoteImages(sb).length ? ` 📷${getNoteImages(sb).length}` : '');
        break;
      }
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
      toast('تم تحديث التعيين بنجاح', 'success');
    } catch {
      toast('تعذّر حفظ التعيين', 'error');
    }
  };

  $('btn-quick-assign-cancel').onclick = () => {
    modal.classList.remove('active');
  };
}

// ----------------- SALES LEAD NOTES MODAL (text + imgbb images + per-image caption) -----------------
let pendingNoteImages = []; // [{ url, caption }] for the currently opened notes modal

function normalizeNoteImage(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const url = v.trim();
    return url ? { url, caption: '' } : null;
  }
  if (typeof v === 'object') {
    const url = (v.url || v.displayUrl || v.display_url || '').trim();
    if (!url) return null;
    return { url, caption: String(v.caption ?? v.note ?? v.text ?? '').trim().slice(0, 300) };
  }
  return null;
}

function getNoteImages(st) {
  if (!st) return [];
  const raw = st.noteImages ?? st.note_images ?? st.images ?? [];
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(normalizeNoteImage).filter(Boolean);
    } catch {}
    return raw.split('\n').map(s => s.trim()).filter(s => /^https?:\/\//i.test(s)).map(url => ({ url, caption: '' }));
  }
  if (Array.isArray(raw)) return raw.map(normalizeNoteImage).filter(Boolean);
  return [];
}

function getNoteImageUrl(item) {
  if (!item) return '';
  return typeof item === 'string' ? item : (item.url || '');
}

function hasLeadNotes(st) {
  if (!st) return false;
  return !!(st.notes || getNoteImages(st).length);
}

function renderNoteImagesPreview() {
  const wrap = $('modal-notes-images-preview');
  if (!wrap) return;
  if (!pendingNoteImages.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = pendingNoteImages.map((item, i) => {
    const url = getNoteImageUrl(item);
    const cap = typeof item === 'string' ? '' : (item.caption || '');
    return `
    <div class="note-img-card" data-idx="${i}">
      <div class="note-img-item" data-open="${i}" title="اضغط للعرض بالحجم الكامل">
        <img src="${esc(url)}" alt="صورة ملاحظة ${i + 1}" loading="lazy" />
        <button type="button" class="note-img-del" data-del="${i}" title="حذف الصورة">×</button>
      </div>
      <input type="text" class="note-img-caption" data-cap="${i}" placeholder="تعليق على الصورة..." value="${esc(cap)}" maxlength="300" />
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      pendingNoteImages.splice(Number(btn.dataset.del), 1);
      renderNoteImagesPreview();
    };
  });
  wrap.querySelectorAll('[data-open]').forEach(item => {
    item.onclick = () => {
      const url = getNoteImageUrl(pendingNoteImages[Number(item.dataset.open)]);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    };
  });
  // Caption inputs update state live WITHOUT re-render (so focus is never lost while typing)
  wrap.querySelectorAll('[data-cap]').forEach(inp => {
    inp.oninput = () => {
      const i = Number(inp.dataset.cap);
      const cur = pendingNoteImages[i];
      if (typeof cur === 'string') pendingNoteImages[i] = { url: cur, caption: inp.value.slice(0, 300) };
      else if (cur) cur.caption = inp.value.slice(0, 300);
    };
  });
}

function setNotesUploadStatus(msg, isError = false) {
  const el = $('notes-image-upload-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
}

async function uploadImageToImgbb(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('الملف المختار ليس صورة');
  if (file.size > 10 * 1024 * 1024) throw new Error('حجم الصورة أكبر من 10MB');
  const form = new FormData();
  form.append('image', file);
  const res = await fetch(IMGBB_UPLOAD_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`فشل الرفع (HTTP ${res.status})`);
  const json = await res.json();
  if (!json?.success || !json?.data?.url) {
    throw new Error(json?.error?.message || 'فشل الرفع على imgbb');
  }
  return json.data.display_url || json.data.url;
}

async function handleNoteImageFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const input = $('notes-image-input');
  setNotesUploadStatus(`جاري رفع ${list.length} صورة على imgbb...`);
  let ok = 0;
  for (const f of list) {
    try {
      const url = await uploadImageToImgbb(f);
      pendingNoteImages.push({ url, caption: '' });
      ok++;
      renderNoteImagesPreview();
    } catch (err) {
      console.error('imgbb upload failed:', err);
      toast(`فشل رفع ${f.name}: ${err.message}`, 'error');
    }
  }
  if (input) input.value = '';
  setNotesUploadStatus(ok ? `تم رفع ${ok} صورة بنجاح ✅ (بتتحفظ مع الملاحظة بعد الضغط على حفظ)` : '', ok === 0);
  initIcons();
}

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

  const oppEl = $('modal-notes-opp');
  if (oppEl) {
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v === '' || v === undefined || v === null ? '—' : v; };
    const showIf = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
    const hasOpp = !!(r[LX.SERVICE] || r[13]);
    oppEl.style.display = hasOpp ? 'block' : 'none';
    if (hasOpp) {
      setText('modal-notes-service', r[LX.SERVICE]);
      setText('modal-notes-sector', r[LX.SECTOR]);
      setText('modal-notes-erp', r[LX.ERP_GRADE] ? `${r[LX.ERP_GRADE]} (${r[LX.ERP_SCORE] || 0} نقطة)` : '');
      setText('modal-notes-reach', r[LX.REACH] === '' || r[LX.REACH] === undefined ? '' : `${r[LX.REACH]}%`);
      setText('modal-notes-reason', r[13]);
      setText('modal-notes-other', r[LX.OTHER_OPPS]);
      showIf('modal-notes-other-wrap', !!r[LX.OTHER_OPPS]);
      setText('modal-notes-email', r[LX.EMAIL]);
      showIf('modal-notes-email-wrap', !!r[LX.EMAIL]);
      setText('modal-notes-rating', r[LX.RATING] ? `${r[LX.RATING]} ★ (${(Number(r[LX.REVIEWS]) || 0).toLocaleString('en')} تقييم)` : '');
      showIf('modal-notes-rating-wrap', !!r[LX.RATING]);
    }
  }

  const textarea = $('modal-notes-textarea');
  if (textarea) textarea.value = st.notes || '';

  // Images (imgbb) for site-feedback screenshots
  pendingNoteImages = getNoteImages(st);
  renderNoteImagesPreview();
  setNotesUploadStatus('');
  const urlInput = $('notes-image-url-input');
  if (urlInput) urlInput.value = '';
  const fileInput = $('notes-image-input');
  if (fileInput) fileInput.value = '';

  const metaEl = $('modal-notes-meta');
  if (metaEl) {
    if ((st.notes || pendingNoteImages.length) && st.noteBy) {
      const imgPart = pendingNoteImages.length ? ` · 📷 ${pendingNoteImages.length} صورة` : '';
      metaEl.textContent = `آخر تعديل بواسطة: ${nm(st.noteBy)} · ${fmt(st.noteAt)}${imgPart}`;
    } else if (pendingNoteImages.length) {
      metaEl.textContent = `يوجد ${pendingNoteImages.length} صورة مرفقة — اضغط على أي صورة لعرضها بالحجم الكامل.`;
    } else {
      metaEl.textContent = 'لا توجد ملاحظات مسجلة مسبقاً لهذا العميل.';
    }
  }

  const isAdmin = state.role === 'owner' || state.me?.isOwner || state.sess === 'admin';
  const portalBtn = $('btn-open-portal-from-notes');
  if (portalBtn) {
    if (st.j && isAdmin) {
      portalBtn.style.display = 'inline-flex';
      portalBtn.onclick = () => {
        const modal = $('modal-lead-notes');
        if (modal) modal.classList.remove('active');
        openClientPortalModal(cid);
      };
    } else {
      portalBtn.style.display = 'none';
    }
  }

  const modal = $('modal-lead-notes');
  if (modal) {
    modal.classList.add('active');
    initIcons();
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

  const btnAddImg = $('btn-notes-add-image');
  if (btnAddImg && !btnAddImg.dataset.wired) {
    btnAddImg.dataset.wired = '1';
    btnAddImg.onclick = () => $('notes-image-input')?.click();
  }
  const fileInput = $('notes-image-input');
  if (fileInput && !fileInput.dataset.wired) {
    fileInput.dataset.wired = '1';
    fileInput.onchange = () => handleNoteImageFiles(fileInput.files);
  }
  const btnAddUrl = $('btn-notes-add-image-url');
  const urlInput = $('notes-image-url-input');
  const addUrlAction = () => {
    const v = (urlInput?.value || '').trim();
    if (!v) {
      toast('الصق رابط الصورة الأول', 'error');
      return;
    }
    if (!/^https?:\/\/.+\..+/i.test(v)) {
      toast('رابط الصورة غير صالح', 'error');
      return;
    }
    pendingNoteImages.push({ url: v, caption: '' });
    if (urlInput) urlInput.value = '';
    renderNoteImagesPreview();
    setNotesUploadStatus('تمت إضافة رابط الصورة — اضغط حفظ الملاحظة للحفظ ✅');
    urlInput?.focus();
  };
  if (btnAddUrl && !btnAddUrl.dataset.wired) {
    btnAddUrl.dataset.wired = '1';
    btnAddUrl.onclick = addUrlAction;
  }
  if (urlInput && !urlInput.dataset.wired) {
    urlInput.dataset.wired = '1';
    urlInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addUrlAction(); } };
  }

  const btnSave = $('btn-save-lead-notes');
  if (btnSave) {
    btnSave.onclick = async () => {
      const cid = state.activeNoteCid;
      if (!cid) {
        closeModal();
        return;
      }

      const text = ($('modal-notes-textarea').value || '').trim();
      // Collect latest caption inputs (in case of autofill) then normalize to [{url, caption}]
      document.querySelectorAll('#modal-notes-images-preview [data-cap]').forEach(inp => {
        const i = Number(inp.dataset.cap);
        if (pendingNoteImages[i]) {
          if (typeof pendingNoteImages[i] === 'string') pendingNoteImages[i] = { url: pendingNoteImages[i], caption: inp.value.trim().slice(0, 300) };
          else pendingNoteImages[i].caption = inp.value.trim().slice(0, 300);
        }
      });
      const noteImages = pendingNoteImages
        .map(o => typeof o === 'string' ? { url: o.trim(), caption: '' } : { url: (o?.url || '').trim(), caption: String(o?.caption || '').trim().slice(0, 300) })
        .filter(o => o.url);
      const currentSt = state.L.get(cid) || {};
      const currentUid = state.me?.isOwner ? 'admin' : state.sess;
      const now = Date.now();

      const updated = {
        ...currentSt,
        notes: text,
        noteImages,
        noteBy: currentUid,
        noteAt: now
      };

      state.L.set(cid, updated);
      closeModal();
      renderCanvasTable();

      try {
        // update() merges; the local store's set() replaces the doc and would wipe the stage flags
        await db.doc(`leads/${cid}`).update({
          notes: text,
          noteImages,
          noteBy: currentUid,
          noteAt: now
        });
        const leadName = state.byCid.get(cid)?.[3] || cid;
        const imgPart = noteImages.length ? ` + 📷 ${noteImages.length} صورة` : '';
        logAudit('lead', (text || noteImages.length)
          ? `ملاحظة على ${leadName}${imgPart}: ${text.length > 80 ? text.slice(0, 80) + '…' : (text || 'صور مرفقة')}`
          : `مسح ملاحظة ${leadName}`, { target: cid });
        toast(noteImages.length ? `تم حفظ الملاحظة مع ${noteImages.length} صورة بنجاح` : 'تم حفظ ملاحظات العميل بنجاح', 'success');
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
        rows.push(state.byCid.get(cid).slice(0, ROW_LEN));
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

  const n = cids.length;
  const which = n === 1 ? ` (${state.byCid.get(cids[0])?.[3] || cids[0]})` : '';
  logAudit('assign', targetUid
    ? `إسناد ${n.toLocaleString('en')} عميل إلى ${nm(targetUid)}${which}`
    : `إلغاء إسناد ${n.toLocaleString('en')} عميل${which}`, { target: targetUid || '' });
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
    toast(`تم إسناد ${count} عميل بنجاح إلى ${nm(targetUser)}`, 'success');
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
    toast(`تم إلغاء تعيين ${count} عميل بنجاح`, 'success');
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
    toast(`تم إسناد ${toAssign.length} عميل بنجاح`, 'success');
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
    const stageLabel = { s: 'اتبعت', r: 'رد', j: 'معانا' }[stageKey];
    logAudit('lead', willTurnOn
      ? `علّم "${stageLabel}" على ${row[3] || cid}`
      : `شال "${stageLabel}" من ${row[3] || cid}`, { target: cid });
    if (shouldCreateClient) {
      const cleanPhone = (row[6] || '').replace(/[^0-9]/g, '');
      const portalUser = cleanPhone || `client_${cid}`;
      const portalPass = Math.floor(100000 + Math.random() * 900000).toString();
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
        portalActive: true,
        portalUsername: portalUser,
        portalPassword: portalPass,
        seo: 0,
        media: 0,
        social: 0,
        dev: 0,
        ui: 0,
        deptDetails: {
          seo: { assignee: '', deadline: '', note: '' },
          media: { assignee: '', deadline: '', note: '' },
          social: { assignee: '', deadline: '', note: '' },
          dev: { assignee: '', deadline: '', note: '' },
          ui: { assignee: '', deadline: '', note: '' }
        },
        clientNote: 'أهلاً بك! تم تأكيد انضمامك ويبدأ فريق العمل في تجهيز ومتابعة مشروعك الآن.',
        expectedDelivery: ''
      });
      toast(`تمت إضافة ${row[3]} وتفعيل حسابه على منصة تابع`, 'success');
      setTimeout(() => {
        openClientPortalModal(cid);
      }, 400);
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
      { label: 'إجمالي العملاء', val: state.S.length, icon: 'users' },
      { label: 'العملاء المعيّنون', val: state.A.size, icon: 'zap' }
    );
  } else {
    cards.push(
      { label: 'العملاء المعيّنون لك', val: state.S.length, icon: 'clipboard-list' }
    );
  }

  cards.push(
    { label: 'تم التواصل (اتبعت)', val: sentCount, icon: 'share-2' },
    { label: 'تفاعلوا (ردوا)', val: repliedCount, icon: 'message-square' },
    { label: 'تعاقدوا (دخلوا معانا)', val: joinedCount, icon: 'check-circle-2' }
  );

  $('leads-kpis').innerHTML = cards.map(c => `
    <div class="kpi-card">
      <div class="kpi-icon"><i data-lucide="${c.icon}"></i></div>
      <div class="kpi-info">
        <span>${c.label}</span>
        <b>${c.val.toLocaleString('en')}</b>
      </div>
    </div>
  `).join('');
  initIcons();
}

// Helper: Ensure client has Tab3 portal credentials and task structure
function ensureClientPortalCreds(cid, client) {
  if (!client) return null;
  let modified = false;
  const copy = { ...client };

  const existingUsername = copy.portalUsername || copy.portal_username;
  if (!existingUsername) {
    const cleanPhone = (copy.phone || '').replace(/[^0-9]/g, '');
    copy.portalUsername = cleanPhone || `client_${cid}`;
    copy.portal_username = copy.portalUsername;
    modified = true;
  } else {
    copy.portalUsername = existingUsername;
    copy.portal_username = existingUsername;
  }

  const existingPassword = copy.portalPassword || copy.portal_password;
  if (!existingPassword) {
    copy.portalPassword = Math.floor(100000 + Math.random() * 900000).toString();
    copy.portal_password = copy.portalPassword;
    modified = true;
  } else {
    copy.portalPassword = existingPassword;
    copy.portal_password = existingPassword;
  }

  const existingDeptDetails = copy.deptDetails || copy.dept_details;
  if (!existingDeptDetails || Object.keys(existingDeptDetails).length === 0) {
    copy.deptDetails = {
      seo: { assignee: '', deadline: '', note: '' },
      media: { assignee: '', deadline: '', note: '' },
      social: { assignee: '', deadline: '', note: '' },
      dev: { assignee: '', deadline: '', note: '' },
      ui: { assignee: '', deadline: '', note: '' }
    };
    copy.dept_details = copy.deptDetails;
    modified = true;
  } else {
    copy.deptDetails = existingDeptDetails;
    copy.dept_details = existingDeptDetails;
  }

  const existingNote = copy.clientNote !== undefined ? copy.clientNote : copy.client_note;
  if (!existingNote && existingNote !== '') {
    copy.clientNote = 'أهلاً بك! تم تأكيد انضمامك ويبدأ فريق العمل في تجهيز ومتابعة مشروعك الآن.';
    copy.client_note = copy.clientNote;
    modified = true;
  } else {
    copy.clientNote = existingNote || '';
    copy.client_note = copy.clientNote;
  }

  if (modified) {
    db.doc(`clients/${cid}`).update(copy).catch(console.error);
  }
  return copy;
}

let activePortalCid = null;

// ----------------- DELIVERY VIEW (Clients) -----------------
function renderClientsView() {
  const container = $('clients-content');
  const rawRows = [...state.C.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const rows = rawRows.map(([id, x]) => [id, ensureClientPortalCreds(id, x)]);

  if (!rows.length) {
    container.innerHTML = `
      <div class="card" style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="width: 52px; height: 52px; margin: 0 auto 12px; border-radius: var(--radius-lg); background: var(--primary-soft); display: flex; align-items: center; justify-content: center; color: var(--primary);">
          <i data-lucide="briefcase" style="width: 28px; height: 28px;"></i>
        </div>
        <b>لا يوجد عملاء منضمين حالياً.</b>
        <p style="margin-top:6px;font-size:13px">بمجرد قيام السيلز بتعليم عميل "معانا"، سيظهر هنا لتبدأ أقسام التنفيذ العمل عليه وتفعيل حسابه في منصة تابع.</p>
      </div>`;
    initIcons();
    return;
  }

  const isAdmin = state.role === 'owner' || state.me?.isOwner || state.sess === 'admin';

  let headerSummaryHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-weight:700">${rows.length} عميل في مرحلة التنفيذ ${isAdmin ? 'ومربوطين بـ تابع' : ''}</span>
        ${isAdmin ? '<span class="badge" style="background:var(--primary-soft);color:var(--primary);font-size:11px;">مزامنة لحظية Live Sync</span>' : ''}
      </div>
      <span style="font-size:12.5px;color:var(--text-muted)">الحالات: 0 = لسه | 1 = شغّال | 2 = خلص</span>
    </div>
  `;

  // 1. Mobile Cards View (< 768px)
  let mobileCardsHtml = `<div class="delivery-mobile-cards mobile-only">`;
  rows.forEach(([id, x]) => {
    const rawP = (x.phone || '').trim();
    const maskedPhone = rawP.length > 5 ? rawP.substring(0, 3) + '••••' + rawP.slice(-2) : (rawP ? '••••••••' : '—');
    const cleanPhone = (x.phone || '').replace(/[^0-9]/g, '');
    const waMsg = `مرحباً بك ${x.name || ''}\nيسعدنا ويشرفنا انضمامك معنا!\n\nيمكنك الآن متابعة سير العمل على مشروعك لحظة بلحظة، ومعرفة تفاصيل المهام والتسليمات المكتملة ومن يعمل عليها عبر منصة "تابع":\nرابط المنصة: ${getPortalBaseUrl()}\nاسم المستخدم: ${x.portalUsername}\nكلمة المرور: ${x.portalPassword}\n\nشكراً لثقتك بنا!`;
    const waShareUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMsg)}`;

    const rawSite = (x.site || '').trim();
    const isInvalidSite = !rawSite || 
      rawSite === '—' || 
      rawSite === '-' || 
      rawSite.toLowerCase() === 'none' || 
      rawSite.toLowerCase() === 'n/a' || 
      rawSite === 'لا يوجد' || 
      rawSite === 'بدون' || 
      rawSite === 'انشاء' || 
      rawSite === 'إنشاء';
    const hasSite = !isInvalidSite;
    const siteUrl = hasSite ? (rawSite.startsWith('http') ? rawSite : 'https://' + rawSite) : '';

    mobileCardsHtml += `
      <div class="client-mobile-card">
        <div class="client-mobile-header">
          <div style="flex: 1; min-width: 0;">
            <div class="client-mobile-title">${esc(x.name || 'بدون اسم')}</div>
            <div class="client-mobile-badges">
              <span class="client-meta-chip"><i data-lucide="folder"></i> <span>${esc(x.cat || '—')}</span></span>
              <span class="client-meta-chip"><i data-lucide="map-pin"></i> <span>${esc(x.city || '—')}</span></span>
            </div>
          </div>
          <div style="flex-shrink: 0; display: flex; align-items: center; gap: 6px;">
            ${hasSite 
              ? `<a href="${siteUrl}" target="_blank" rel="noopener noreferrer" class="link-btn web" title="زيارة الموقع: ${esc(rawSite)}" style="display:inline-flex;align-items:center;gap:4px;text-decoration:none;padding:5px 10px;border-radius:6px;background:var(--primary-soft);color:var(--primary);font-size:12px;font-weight:700;border:1px solid var(--border-medium)">
                  <i data-lucide="globe"></i> <span>الموقع</span>
                </a>`
              : `<button class="btn-xs btn-secondary btn-create-site" data-client-id="${id}" title="العميل ليس لديه موقع - انقر لتسجيل رابط الموقع" style="background:transparent;color:var(--warning);border:1px dashed var(--border-medium);font-size:11.5px;font-weight:700;padding:5px 9px;border-radius:6px;cursor:pointer">
                  <i data-lucide="plus"></i> <span>إنشاء موقع</span>
                </button>`
            }
            ${isAdmin ? `
              <button class="btn-xs btn-primary btn-edit-portal" data-client-id="${id}" title="إدارة بيانات الدخول وبوابة تابع" style="padding:5px 9px;font-size:11.5px;font-weight:700;border-radius:6px;display:inline-flex;align-items:center;gap:4px">
                <i data-lucide="shield-check" style="width:13px;height:13px"></i> <span>تابع</span>
              </button>
            ` : ''}
          </div>
        </div>

        <div class="client-mobile-depts">
          ${DEPTS.map(d => {
            const val = x[d] || 0;
            const canEdit = state.role === 'owner' || state.role === d;
            const details = x.deptDetails?.[d] || {};
            let incomingFrom = null;
            let incomingNote = '';
            if (x.deptDetails) {
              for (const [fromD, info] of Object.entries(x.deptDetails)) {
                if (fromD !== d && info?.handoffTo === d && info?.note) {
                  incomingFrom = fromD;
                  incomingNote = info.note;
                  break;
                }
              }
            }
            let handoffBadge = '';
            if (incomingFrom) {
              handoffBadge += `
                <div class="btn-handoff-pill" data-client-id="${id}" data-dept="${d}" data-open-dept="${incomingFrom}" title="مهمة موجهة من ${DEPT_LABELS[incomingFrom] || incomingFrom}: ${esc(incomingNote)}" style="margin-top:3px;font-size:10px;background:var(--primary-glow);color:var(--primary);border:1px solid var(--border-medium);padding:3px 6px;border-radius:4px;cursor:pointer;display:inline-flex;align-items:center;gap:3px">
                  <i data-lucide="inbox"></i> <span>من ${DEPT_LABELS[incomingFrom] || incomingFrom}</span>
                </div>`;
            }
            if (details.note) {
              handoffBadge += `
                <div class="btn-handoff-pill" data-client-id="${id}" data-dept="${d}" data-open-dept="${d}" title="الملاحظة: ${esc(details.note)}" style="margin-top:3px;font-size:10px;background:var(--primary-soft);color:var(--success);border:1px solid var(--border-medium);padding:3px 6px;border-radius:4px;cursor:pointer;display:inline-flex;align-items:center;gap:3px">
                  <i data-lucide="file-text"></i> <span>ملاحظة ${details.handoffTo ? '→ ' + (DEPT_LABELS[details.handoffTo] || details.handoffTo) : ''}</span>
                </div>`;
            }

            return `
              <div class="client-dept-item">
                <div class="client-dept-header">
                  <span>${DEPT_LABELS[d]}</span>
                </div>
                ${canEdit ? `
                  <select class="dept-status-select dept-status-${val}" data-client-id="${id}" data-dept="${d}">
                    <option value="0" ${val === 0 ? 'selected' : ''}>لسه</option>
                    <option value="1" ${val === 1 ? 'selected' : ''}>شغّال</option>
                    <option value="2" ${val === 2 ? 'selected' : ''}>خلص</option>
                  </select>
                ` : `
                  <span class="dept-status-select dept-status-${val}">${['لسه', 'شغّال', 'خلص'][val]}</span>
                `}
                ${handoffBadge}
              </div>
            `;
          }).join('')}
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--text-dim);padding-top:4px;border-top:1px solid var(--border-subtle)">
          <div style="display:flex;align-items:center;gap:4px">
            <i data-lucide="user"></i> <span>بواسطة: ${esc(nm(x.by))}</span>
          </div>
          <div>${fmt(x.at)}</div>
        </div>
      </div>
    `;
  });
  mobileCardsHtml += `</div>`;

  // 2. Desktop Standard Table View (>= 768px)
  let desktopTableHtml = `
    <div class="standard-table-wrapper desktop-only">
      <table class="standard-table">
        <thead>
          <tr>
            <th style="width: 44px; text-align: center;">#</th>
            <th style="min-width: 220px;">العميل والتصنيف</th>
            <th style="min-width: 100px;">الموقع</th>
            <th style="min-width: 130px;">بواسطة</th>
            ${DEPTS.map(d => `<th style="text-align: center; min-width: 100px;">${DEPT_LABELS[d]}</th>`).join('')}
            ${isAdmin ? `<th style="text-align: center; min-width: 130px;">بوابة تابع</th>` : ''}
          </tr>
        </thead>
        <tbody>
  `;

  rows.forEach(([id, x], rowIdx) => {
    const rawSite = (x.site || '').trim();
    const isInvalidSite = !rawSite || 
      rawSite === '—' || 
      rawSite === '-' || 
      rawSite.toLowerCase() === 'none' || 
      rawSite.toLowerCase() === 'n/a' || 
      rawSite === 'لا يوجد' || 
      rawSite === 'بدون' || 
      rawSite === 'انشاء' || 
      rawSite === 'إنشاء';
    const hasSite = !isInvalidSite;
    const siteUrl = hasSite ? (rawSite.startsWith('http') ? rawSite : 'https://' + rawSite) : '';

    desktopTableHtml += `
      <tr>
        <td style="text-align: center; font-weight: 700; color: var(--text-dim); font-size: 12px; font-family: 'Plus Jakarta Sans', monospace;">${rowIdx + 1}</td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <span style="font-weight: 800; font-size: 13.5px; color: var(--text-main);">${esc(x.name || 'بدون اسم')}</span>
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-muted); flex-wrap: wrap;">
              <span style="display: inline-flex; align-items: center; gap: 3px;"><i data-lucide="folder" style="width: 11px; height: 11px;"></i> <span>${esc(x.cat || '—')}</span></span>
              <span style="color: var(--border-medium);">•</span>
              <span style="display: inline-flex; align-items: center; gap: 3px;"><i data-lucide="map-pin" style="width: 11px; height: 11px;"></i> <span>${esc(x.city || '—')}</span></span>
            </div>
          </div>
        </td>
        <td>
          ${hasSite 
            ? `<a href="${siteUrl}" target="_blank" rel="noopener noreferrer" class="link-btn web" title="زيارة الموقع: ${esc(rawSite)}" style="display:inline-flex;align-items:center;gap:4px;text-decoration:none;padding:5px 10px;border-radius:6px;background:var(--primary-soft);color:var(--primary);font-size:12px;font-weight:700;border:1px solid var(--border-medium)">
                <i data-lucide="globe" style="width:13px;height:13px"></i> <span>الموقع</span>
              </a>`
            : `<button class="btn-xs btn-secondary btn-create-site" data-client-id="${id}" title="العميل ليس لديه موقع - انقر لتسجيل رابط الموقع" style="background:transparent;color:var(--warning);border:1px dashed var(--border-medium);font-size:11.5px;font-weight:700;padding:5px 9px;border-radius:6px;cursor:pointer">
                <i data-lucide="plus" style="width:12px;height:12px"></i> <span>إنشاء موقع</span>
              </button>`
          }
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="font-size: 12px; color: var(--text-main); font-weight: 700;">${esc(nm(x.by))}</span>
            <span style="font-size: 11px; color: var(--text-dim);">${fmt(x.at)}</span>
          </div>
        </td>
    `;

    DEPTS.forEach(d => {
      const val = x[d] || 0;
      const canEdit = state.role === 'owner' || state.role === d;
      const details = x.deptDetails?.[d] || {};

      let incomingFrom = null;
      let incomingNote = '';
      if (x.deptDetails) {
        for (const [fromD, info] of Object.entries(x.deptDetails)) {
          if (fromD !== d && info?.handoffTo === d && info?.note) {
            incomingFrom = fromD;
            incomingNote = info.note;
            break;
          }
        }
      }

      let handoffBadge = '';
      if (incomingFrom) {
        handoffBadge += `
          <div class="btn-handoff-pill" data-client-id="${id}" data-dept="${d}" data-open-dept="${incomingFrom}" title="مهمة موجهة من ${DEPT_LABELS[incomingFrom] || incomingFrom}: ${esc(incomingNote)}" style="margin-top:3px;font-size:10px;background:var(--primary-glow);color:var(--primary);border:1px solid var(--border-medium);padding:2px 6px;border-radius:4px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            <i data-lucide="inbox" style="width:11px;height:11px"></i> <span>من ${DEPT_LABELS[incomingFrom] || incomingFrom}</span>
          </div>
        `;
      }
      if (details.note) {
        handoffBadge += `
          <div class="btn-handoff-pill" data-client-id="${id}" data-dept="${d}" data-open-dept="${d}" title="الملاحظة: ${esc(details.note)}" style="margin-top:3px;font-size:10px;background:var(--primary-soft);color:var(--success);border:1px solid var(--border-medium);padding:2px 6px;border-radius:4px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            <i data-lucide="file-text" style="width:11px;height:11px"></i> <span>ملاحظة ${details.handoffTo ? '→ ' + (DEPT_LABELS[details.handoffTo] || details.handoffTo) : ''}</span>
          </div>
        `;
      }

      if (canEdit) {
        desktopTableHtml += `
          <td style="text-align: center;">
            <div style="display: inline-flex; flex-direction: column; align-items: center; gap: 3px;">
              <select class="dept-status-select dept-status-${val}" data-client-id="${id}" data-dept="${d}">
                <option value="0" ${val === 0 ? 'selected' : ''}>لسه</option>
                <option value="1" ${val === 1 ? 'selected' : ''}>شغّال</option>
                <option value="2" ${val === 2 ? 'selected' : ''}>خلص</option>
              </select>
              ${handoffBadge}
            </div>
          </td>`;
      } else {
        const text = ['لسه', 'شغّال', 'خلص'][val];
        desktopTableHtml += `
          <td style="text-align: center;">
            <div style="display: inline-flex; flex-direction: column; align-items: center; gap: 3px;">
              <span class="dept-status-select dept-status-${val}">${text}</span>
              ${handoffBadge}
            </div>
          </td>`;
      }
    });

    if (isAdmin) {
      desktopTableHtml += `
        <td style="text-align: center;">
          <button class="btn-xs btn-primary btn-edit-portal" data-client-id="${id}" title="عرض تفاصيل العميل، الهاتف، وبيانات منصة تابع" style="padding: 6px 12px; font-size: 12px; font-weight: 800; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;">
            <i data-lucide="shield-check" style="width: 14px; height: 14px;"></i>
            <span>بوابة تابع</span>
          </button>
        </td>
      `;
    }

    desktopTableHtml += `</tr>`;
  });

  desktopTableHtml += '</tbody></table></div>';
  container.innerHTML = headerSummaryHtml + mobileCardsHtml + desktopTableHtml;

  // Status select change handlers (Works on both mobile cards and desktop table!)
  container.querySelectorAll('.dept-status-select').forEach(sel => {
    sel.onchange = async () => {
      const cid = sel.dataset.clientId;
      const dept = sel.dataset.dept;
      const val = parseInt(sel.value, 10);

      // If user selected "خلص" (2), open handoff & notes modal!
      if (val === 2) {
        openDeptHandoffModal(cid, dept, sel);
        return;
      }

      // Otherwise save directly
      await saveDeptStatus(cid, dept, val);
      sel.className = `dept-status-select dept-status-${val}`;
      // Sync other view
      container.querySelectorAll(`.dept-status-select[data-client-id="${cid}"][data-dept="${dept}"]`).forEach(s => {
        s.value = String(val);
        s.className = `dept-status-select dept-status-${val}`;
      });
    };
  });

  // Click on handoff note pill to view / edit notes and links
  container.querySelectorAll('.btn-handoff-pill').forEach(btn => {
    btn.onclick = () => {
      const cid = btn.dataset.clientId;
      const targetDept = btn.dataset.openDept || btn.dataset.dept;
      openDeptHandoffModal(cid, targetDept);
    };
  });

  // Click on create site to set website URL
  container.querySelectorAll('.btn-create-site').forEach(btn => {
    btn.onclick = async () => {
      const cid = btn.dataset.clientId;
      const cur = state.C.get(cid);
      const url = prompt(`إضافة رابط الموقع للعميل (${cur?.name || ''}):`, 'https://');
      if (url && url.trim() && url.trim() !== 'https://') {
        let clean = url.trim();
        if (!clean.startsWith('http://') && !clean.startsWith('https://')) clean = 'https://' + clean;
        await db.doc(`clients/${cid}`).update({ site: clean });
        toast('تم حفظ رابط الموقع للعميل بنجاح', 'success');
        renderClientsView();
      }
    };
  });

  // Copy portal credentials handler
  container.querySelectorAll('.btn-copy-portal').forEach(btn => {
    btn.onclick = () => {
      const cid = btn.dataset.clientId;
      const x = state.C.get(cid);
      if (!x) return;
      const text = `بيانات الدخول لمنصة تابع:\nالرابط: ${getPortalBaseUrl()}\nاسم المستخدم: ${x.portalUsername}\nكلمة المرور: ${x.portalPassword}`;
      navigator.clipboard.writeText(text).then(() => {
        toast('تم نسخ بيانات الدخول إلى الحافظة', 'success');
      }).catch(() => {
        prompt('انسخ بيانات الدخول:', text);
      });
    };
  });

  // Open portal modal handler
  container.querySelectorAll('.btn-edit-portal').forEach(btn => {
    btn.onclick = () => {
      openClientPortalModal(btn.dataset.clientId);
    };
  });

  initIcons();
}

function openClientPortalModal(cid) {
  const isAdmin = state.role === 'owner' || state.me?.isOwner || state.sess === 'admin';
  if (!isAdmin) return;

  const client = ensureClientPortalCreds(cid, state.C.get(cid));
  if (!client) return;
  activePortalCid = cid;

  const modal = $('modal-client-portal');
  if (!modal) return;

  $('portal-modal-title').textContent = `إدارة مشروع: ${client.name || 'العميل'} | منصة تابع`;
  const rawP = (client.phone || '').trim();
  const maskedP = rawP.length > 5 ? rawP.substring(0, 3) + '••••' + rawP.slice(-2) : (rawP ? '••••••••' : '—');
  $('portal-modal-subtitle').textContent = `النشاط: ${client.cat || '—'} · الهاتف: ${maskedP}`;
  
  $('portal-input-username').value = client.portalUsername || '';
  $('portal-input-password').value = client.portalPassword || '';
  const phoneInput = $('portal-input-phone');
  if (phoneInput) phoneInput.value = client.phone || '';
  $('portal-input-delivery').value = client.expectedDelivery || '';
  $('portal-input-note').value = client.clientNote || '';

  // Setup preview link with full client payload for instant zero-latency login
  const previewLink = $('btn-portal-open-preview');
  if (previewLink) {
    const dataStr = encodeURIComponent(JSON.stringify(client));
    previewLink.href = `${getPortalBaseUrl()}?u=${encodeURIComponent(client.portalUsername || '')}&p=${encodeURIComponent(client.portalPassword || '')}&cid=${cid}&data=${dataStr}`;
  }

  // Setup generate password button
  $('btn-portal-generate-pw').onclick = () => {
    const newPass = Math.floor(100000 + Math.random() * 900000).toString();
    $('portal-input-password').value = newPass;
    toast('تم توليد كلمة سر جديدة', 'info');
  };

  // Setup copy credentials button
  $('btn-portal-copy-creds').onclick = () => {
    const u = $('portal-input-username').value.trim();
    const p = $('portal-input-password').value.trim();
    const text = `بيانات الدخول لمنصة تابع:\nالرابط: ${getPortalBaseUrl()}\nاسم المستخدم: ${u}\nكلمة المرور: ${p}`;
    navigator.clipboard.writeText(text).then(() => {
      toast('تم نسخ بيانات الدخول', 'success');
    }).catch(() => {
      prompt('انسخ البيانات:', text);
    });
  };

  // Setup send WhatsApp button
  $('btn-portal-send-whatsapp').onclick = () => {
    const u = $('portal-input-username').value.trim();
    const p = $('portal-input-password').value.trim();
    const phoneInputVal = $('portal-input-phone') ? $('portal-input-phone').value.trim() : (client.phone || '');
    const cleanPhone = phoneInputVal.replace(/[^0-9]/g, '');
    const msg = `مرحباً بك ${client.name || ''}\nيسعدنا ويشرفنا انضمامك معنا!\n\nيمكنك الآن متابعة سير العمل على مشروعك لحظة بلحظة، ومعرفة تفاصيل المهام والتسليمات المكتملة عبر منصة "تابع":\nرابط المنصة: ${getPortalBaseUrl()}\nاسم المستخدم: ${u}\nكلمة المرور: ${p}\n\nشكراً لثقتك بنا!`;
    window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  // Setup save button
  $('btn-save-portal-details').onclick = async () => {
    if (!activePortalCid) return;
    const u = $('portal-input-username').value.trim();
    const p = $('portal-input-password').value.trim();
    const phoneVal = $('portal-input-phone') ? $('portal-input-phone').value.trim() : (client.phone || '');
    const delivery = $('portal-input-delivery').value.trim();
    const note = $('portal-input-note').value.trim();

    if (!u || !p) {
      toast('يرجى كتابة اسم المستخدم وكلمة المرور', 'error');
      return;
    }

    const updatePayload = {
      portalUsername: u,
      portalPassword: p,
      phone: phoneVal,
      expectedDelivery: delivery,
      clientNote: note
    };

    try {
      await db.doc(`clients/${activePortalCid}`).update(updatePayload);
      logAudit('client', `تحديث بيانات العميل ومنصة تابع لـ ${client.name || activePortalCid}`, { target: activePortalCid });
      toast('تم حفظ وتحديث بيانات العميل ومنصة تابع بنجاح', 'success');
      modal.classList.remove('active');
      renderClientsView();
    } catch (err) {
      console.error(err);
      toast('تعذّر حفظ التحديثات', 'error');
    }
  };

  const closeModal = () => modal.classList.remove('active');
  $('btn-close-portal-modal').onclick = closeModal;
  $('btn-cancel-portal-modal').onclick = closeModal;

  const btnDeleteClient = $('btn-delete-portal-client');
  if (btnDeleteClient) {
    btnDeleteClient.style.display = isAdmin ? 'inline-flex' : 'none';
    btnDeleteClient.onclick = async () => {
      if (!activePortalCid) return;
      const clientName = client.name || activePortalCid;
      const ok = await ask(`هل تريد حذف مشروع "${clientName}" نهائياً من مشاريع التنفيذ وبوابة تابع؟`, 'نعم، حذف المشروع', 'إلغاء');
      if (!ok) return;
      try {
        await db.doc(`clients/${activePortalCid}`).delete();
        logAudit('client', `حذف مشروع ${clientName} من التنفيذ`, { target: activePortalCid });
        toast(`تم حذف ${clientName} بنجاح`, 'info');
        modal.classList.remove('active');
        renderClientsView();
      } catch (err) {
        console.error(err);
        toast('تعذّر حذف العميل', 'error');
      }
    };
  }

  modal.classList.add('active');
  initIcons();
}

let activeHandoffCid = null;
let activeHandoffDept = null;
let activeHandoffSel = null;

function renderDetectedLinks(text, containerEl) {
  if (!containerEl) return;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = (text || '').match(urlRegex) || [];
  if (!matches.length) {
    containerEl.innerHTML = '';
    return;
  }
  containerEl.innerHTML = matches.map(url => {
    let label = 'رابط خارجي';
    try {
      const u = new URL(url);
      label = u.hostname.replace('www.', '');
    } catch {}
    return `
      <a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:var(--primary-soft);color:var(--primary);border:1px solid var(--border-medium);font-size:11.5px;font-weight:700;text-decoration:none;direction:ltr">
        <i data-lucide="link-2" style="width: 13px; height: 13px;"></i> <span>${esc(label)}</span>
      </a>
    `;
  }).join('');
  initIcons();
}

function openDeptHandoffModal(cid, dept, selElement = null) {
  const client = state.C.get(cid);
  if (!client) return;

  activeHandoffCid = cid;
  activeHandoffDept = dept;
  activeHandoffSel = selElement;

  const modal = $('modal-dept-handoff');
  if (!modal) return;

  const deptLabel = DEPT_LABELS[dept] || dept;
  const details = client.deptDetails?.[dept] || {};

  $('handoff-modal-client-name').textContent = client.name || 'بدون اسم';
  $('handoff-modal-dept-name').textContent = deptLabel;

  if (selElement) {
    $('handoff-modal-title').textContent = `تسليم مرحلة ${deptLabel} بنجاح`;
    $('handoff-modal-subtitle').textContent = 'سجل ملاحظات الإنجاز وروابط العمل، ووجّه المهام لباقي الأقسام';
  } else {
    $('handoff-modal-title').textContent = `ملاحظات وتوجيه مهمة: ${deptLabel}`;
    $('handoff-modal-subtitle').textContent = 'عرض أو تعديل ملاحظات الإنجاز وروابط الملفات المشتركة';
  }

  // Check incoming handoff from another dept
  let incomingFrom = null;
  let incomingNote = '';
  if (client.deptDetails) {
    for (const [fromD, info] of Object.entries(client.deptDetails)) {
      if (fromD !== dept && info?.handoffTo === dept && info?.note) {
        incomingFrom = fromD;
        incomingNote = info.note;
        break;
      }
    }
  }

  const incomingBanner = $('handoff-incoming-banner');
  if (incomingBanner) {
    if (incomingFrom) {
      incomingBanner.style.display = 'block';
      $('handoff-incoming-from-name').textContent = DEPT_LABELS[incomingFrom] || incomingFrom;
      $('handoff-incoming-note-text').textContent = incomingNote;
      renderDetectedLinks(incomingNote, $('handoff-incoming-links'));
    } else {
      incomingBanner.style.display = 'none';
    }
  }

  // Populate note
  const noteInput = $('handoff-input-note');
  noteInput.value = details.note || '';
  const detectedLinksEl = $('handoff-detected-links');
  renderDetectedLinks(details.note || '', detectedLinksEl);

  // Live URL detection as user types
  noteInput.oninput = () => {
    renderDetectedLinks(noteInput.value, detectedLinksEl);
  };

  // Populate target dept dropdown
  const DEPT_FULL_LABELS = {
    dev: 'البرمجة والتطوير (Dev)',
    ui: 'التصميم وتجربة المستخدم (UI)',
    seo: 'تهيئة محركات البحث (SEO)',
    media: 'الإعلانات والميديا باير (Media)',
    social: 'المحتوى والسوشيال ميديا (Social)'
  };
  const targetSelect = $('handoff-select-target');
  let targetOptionsHtml = `<option value="">بدون توجيه لقسم آخر</option>`;
  DEPTS.forEach(d => {
    if (d !== dept) {
      const isSelected = details.handoffTo === d ? 'selected' : '';
      targetOptionsHtml += `<option value="${d}" ${isSelected}>${DEPT_FULL_LABELS[d] || DEPT_LABELS[d] || d}</option>`;
    }
  });
  targetSelect.innerHTML = targetOptionsHtml;

  // Cancel / Close handler
  const closeModal = (isConfirm = false) => {
    modal.classList.remove('active');
    if (!isConfirm && activeHandoffSel) {
      // Revert select back to original value if canceled
      const prevVal = client[dept] !== undefined ? client[dept] : 0;
      activeHandoffSel.value = String(prevVal);
      activeHandoffSel.className = `dept-status-select dept-status-${prevVal}`;
    }
    activeHandoffCid = null;
    activeHandoffDept = null;
    activeHandoffSel = null;
  };

  $('btn-close-handoff-modal').onclick = () => closeModal(false);
  $('btn-cancel-handoff').onclick = () => closeModal(false);

  // Confirm / Save handler
  $('btn-confirm-handoff').onclick = async () => {
    const note = noteInput.value.trim();
    const targetDept = targetSelect.value;
    await saveDeptStatus(cid, dept, 2, note, targetDept);
    closeModal(true);
    renderClientsView();
  };

  modal.classList.add('active');
  initIcons();
  setTimeout(() => noteInput.focus(), 50);
}

async function saveDeptStatus(cid, dept, val, note = null, targetDept = null) {
  const client = state.C.get(cid);
  if (!client) return;

  const deptDetails = { ...(client.deptDetails || client.dept_details || {}) };
  const existingDeptInfo = deptDetails[dept] || {};

  deptDetails[dept] = {
    ...existingDeptInfo,
    status: val,
    note: note !== null ? note : (existingDeptInfo.note || ''),
    handoffTo: targetDept !== null ? targetDept : (existingDeptInfo.handoffTo || ''),
    handoffAt: Date.now(),
    handoffBy: state.sess || 'user'
  };

  const updatePayload = {
    [dept]: val,
    deptDetails: deptDetails,
    dept_details: deptDetails,
    updatedAt: Date.now()
  };

  // Update in memory immediately
  const updatedClient = {
    ...client,
    ...updatePayload
  };
  state.C.set(cid, updatedClient);

  try {
    await db.doc(`clients/${cid}`).update(updatePayload);
    const deptName = DEPT_LABELS[dept] || dept;
    const statusLabel = ['لسه', 'شغّال', 'خلص'][val] ?? val;
    logAudit('client', `${deptName} لـ ${client.name || cid}: ${statusLabel}` +
      (val === 2 && targetDept ? ` وتسليم لـ ${DEPT_LABELS[targetDept] || targetDept}` : ''), { target: cid });
    if (val === 2 && targetDept) {
      toast(`تم تسليم مرحلة ${deptName} وتوجيه المهمة إلى ${DEPT_LABELS[targetDept] || targetDept} بنجاح`, 'success');
    } else {
      toast(`تم تحديث حالة قسم ${deptName} بنجاح`, 'success');
    }
  } catch (err) {
    console.error('Failed to update dept status:', err);
    toast('تعذّر حفظ التحديث في السحابة', 'error');
  }
}

function openSupabaseSettingsModal() {
  const isAdmin = state.role === 'owner' || state.me?.isOwner || state.sess === 'admin';
  if (!isAdmin) return;

  const modal = $('modal-supabase-settings');
  if (!modal) return;
  const cfg = getSupabaseConfig();
  const urlInput = $('supabase-input-url');
  const keyInput = $('supabase-input-key');
  const msgEl = $('supabase-status-msg');

  if (urlInput) urlInput.value = cfg?.url || '';
  if (keyInput) keyInput.value = cfg?.key || '';
  if (msgEl) {
    if (cfg?.url && cfg?.key) {
      msgEl.innerHTML = '<span style="color:var(--success);font-weight:700">متصل حالياً بقاعدة بيانات Supabase السحابية</span>';
    } else {
      msgEl.innerHTML = '<span style="color:var(--text-muted)">لم يتم تفعيل اتصال Supabase بعد. أدخل الرابط والمفتاح للحفظ.</span>';
    }
  }

  const closeModal = () => modal.classList.remove('active');
  $('btn-close-supabase-modal').onclick = closeModal;
  $('btn-cancel-supabase-modal').onclick = closeModal;

  $('btn-save-supabase-config').onclick = () => {
    const url = urlInput?.value.trim();
    const key = keyInput?.value.trim();
    if (!url || !key) {
      msgEl.innerHTML = '<span style="color:var(--danger)">يرجى إدخال الرابط والمفتاح معاً</span>';
      return;
    }
    saveSupabaseConfig({ url, key });
    try {
      localStorage.setItem('crm_supabase_config', JSON.stringify({ url, key }));
    } catch {}
    resetSupabaseClient();
    toast('تم حفظ إعدادات Supabase وتفعيل الاتصال', 'success');
    closeModal();
    setTimeout(() => {
      window.location.reload();
    }, 600);
  };

  $('btn-disconnect-supabase').onclick = () => {
    saveSupabaseConfig(null);
    try {
      localStorage.removeItem('crm_supabase_config');
    } catch {}
    resetSupabaseClient();
    toast('تم إلغاء الاتصال بالسحابة', 'info');
    closeModal();
    setTimeout(() => {
      window.location.reload();
    }, 600);
  };

  modal.classList.add('active');
  initIcons();
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
      <h3 style="font-weight:800;font-size:17px;display:flex;align-items:center;gap:6px">
        <i data-lucide="bar-chart-3"></i>
        <span>تقرير أداء فريق المبيعات (Sales Leaderboard)</span>
      </h3>
      <button id="btn-export-stats-csv" class="btn-secondary" style="display:inline-flex;align-items:center;gap:6px">
        <i data-lucide="download"></i>
        <span>تصدير التقرير (Excel / CSV)</span>
      </button>
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
    <h3 style="font-weight:800;font-size:17px;margin-bottom:14px;display:flex;align-items:center;gap:6px">
      <i data-lucide="trending-up"></i>
      <span>تقدم أقسام التنفيذ</span>
    </h3>
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
  initIcons();

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
  toast('تم تحميل ملف التقرير بنجاح', 'success');
}

// ----------------- AUDIT LOG VIEW (Super Admin) -----------------
const AUDIT_MAX_ROWS = 500;
let auditUnsub = null;

function setupAuditListener() {
  const wanted = state.role === 'owner';
  if (wanted && !auditUnsub) {
    auditUnsub = db.collection('audit').onSnapshot((snap) => {
      const all = [];
      snap.forEach(d => (d.data().entries || []).forEach(e => all.push(e)));
      state.AU = all.sort((a, b) => b.at - a.at);
      if (state.view === 'audit') renderAuditView();
    });
  } else if (!wanted && auditUnsub) {
    auditUnsub();
    auditUnsub = null;
    state.AU = [];
  }
}

const auditWho = (by) => (by === 'admin' ? 'السوبر أدمن' : by ? nm(by) : '—');

function filteredAudit() {
  const q = ($('audit-search').value || '').trim().toLowerCase();
  const fu = $('audit-filter-user').value;
  const ft = $('audit-filter-type').value;
  const days = Number($('audit-filter-range').value) || 0;
  const since = days ? new Date(new Date().setHours(0, 0, 0, 0) - (days - 1) * 86400000).getTime() : 0;
  return state.AU.filter(e =>
    (!fu || e.by === fu) &&
    (!ft || e.type === ft) &&
    e.at >= since &&
    (!q || `${e.summary} ${e.target} ${e.by} ${auditWho(e.by)}`.toLowerCase().includes(q))
  );
}

function renderAuditView() {
  // Keep the selected filter values while refreshing the option lists
  const userSel = $('audit-filter-user');
  const prevUser = userSel.value;
  const users = [...new Set(state.AU.map(e => e.by).filter(Boolean))];
  userSel.innerHTML = '<option value="">كل المستخدمين</option>' +
    users.map(u => `<option value="${esc(u)}">${esc(auditWho(u))}${u === 'admin' ? '' : ` (${esc(u)})`}</option>`).join('');
  userSel.value = users.includes(prevUser) ? prevUser : '';

  const typeSel = $('audit-filter-type');
  if (typeSel.options.length === 1) {
    typeSel.innerHTML += Object.entries(AUDIT_TYPES).map(([k, t]) => `<option value="${k}">${t}</option>`).join('');
  }

  const rows = filteredAudit();
  const shown = rows.slice(0, AUDIT_MAX_ROWS);
  $('audit-tbody').innerHTML = shown.length
    ? shown.map(e => `
      <tr>
        <td class="audit-time">${esc(new Date(e.at).toLocaleString('ar-EG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
        <td><b>${esc(auditWho(e.by))}</b>${e.by && e.by !== 'admin' ? `<span class="audit-uid">${esc(e.by)}</span>` : ''}</td>
        <td><span class="audit-type">${esc(AUDIT_TYPES[e.type] || e.type)}</span></td>
        <td class="audit-summary">${esc(e.summary)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="audit-empty">${state.AU.length ? 'مفيش نتايج بالفلاتر دي' : 'لسه مفيش نشاط متسجّل'}</td></tr>`;

  $('audit-footer').textContent = rows.length > AUDIT_MAX_ROWS
    ? `معروض أحدث ${AUDIT_MAX_ROWS.toLocaleString('en')} من ${rows.length.toLocaleString('en')} عملية. ضيّق الفلاتر أو صدّر الملف عشان تشوف الكل.`
    : `${rows.length.toLocaleString('en')} عملية`;
  initIcons();
}

function exportAuditToCSV() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let csv = '﻿'; // UTF-8 BOM for Arabic support in Excel
  csv += 'الوقت,المستخدم,اسم الدخول,النوع,التفاصيل\n';
  filteredAudit().forEach(e => {
    csv += [new Date(e.at).toLocaleString('en-GB'), auditWho(e.by), e.by, AUDIT_TYPES[e.type] || e.type, e.summary].map(cell).join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `سجل_النشاط_${localDay(Date.now())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('تم تحميل سجل النشاط', 'success');
}

// ----------------- USERS VIEW (Management) -----------------
function renderUsersView() {
  const container = $('users-content');
  const roleOptions = Object.entries(ROLES)
    .map(([k, t]) => `<option value="${k}">${t}</option>`)
    .join('');

  let html = `
    <div class="modal-card" style="max-width:100%;margin-bottom:24px">
      <h3 style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:6px">
        <i data-lucide="user-plus"></i>
        <span>إضافة عضو جديد لفريق العمل</span>
      </h3>
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
              <button class="btn-secondary btn-copy-user" style="padding:6px 12px;font-size:12px" title="نسخ رسالة فيها الرابط واسم الدخول وكلمة المرور عشان تبعتها له">
                <i data-lucide="copy"></i><span>نسخ البيانات</span>
              </button>
              <button class="btn-danger btn-delete-user" style="padding:6px 12px;font-size:12px">حذف</button>
            </div>
          </td>
        </tr>`;
    });
  }

  html += '</tbody></table></div>';
  container.innerHTML = html;
  container.querySelectorAll('input[type="password"]').forEach(addPasswordToggle);
  initIcons();

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
      sessionPasswords.set(uid, pw);
      logAudit('user', `إنشاء حساب ${name} (${uid}) — ${ROLES[role] || role}`, { target: uid });
      $('new-user-id').value = '';
      $('new-user-name').value = '';
      $('new-user-pw').value = '';
      toast(`تم إنشاء حساب "${name}". دوس "نسخ البيانات" جنبه عشان تبعتهاله`, 'success');
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
      const before = state.R.get(uid) || {};

      try {
        await db.doc(`profiles/${uid}`).set({ name, role });
        const changes = [];
        if (before.name !== name) changes.push(`الاسم: ${before.name || '—'} ← ${name}`);
        if (before.role !== role) changes.push(`الدور: ${ROLES[before.role] || before.role || '—'} ← ${ROLES[role] || role}`);
        if (changes.length) logAudit('user', `تعديل ${uid}: ${changes.join('، ')}`, { target: uid });
        if (pw) {
          if (pw.length < 6) {
            toast('كلمة المرور 6 أحرف على الأقل', 'error');
            return;
          }
          await db.doc(`users/${uid}`).set(await mkCred(pw));
          sessionPasswords.set(uid, pw);
          logAudit('user', `تغيير كلمة مرور ${name} (${uid})`, { target: uid });
          tr.querySelector('.user-edit-pw').value = '';
        }
        toast('تم حفظ التعديلات بنجاح', 'success');
      } catch {
        toast('تعذّر الحفظ', 'error');
      }
    };

    tr.querySelector('.btn-copy-user').onclick = async () => {
      let pw = sessionPasswords.get(uid);
      if (!pw) {
        const ok = await ask( 
          `كلمة مرور "${nm(uid)}" محفوظة مشفّرة ومينفعش تظهر تاني. تعمل له كلمة مرور جديدة وتنسخ بياناته؟ القديمة هتبطّل تشتغل.`,
          'كلمة مرور جديدة ونسخ',
          'إلغاء'
        );
        if (!ok) return;
        pw = generatePassword();
        try {
          await db.doc(`users/${uid}`).set(await mkCred(pw));
        } catch {
          toast('تعذّر حفظ كلمة المرور الجديدة', 'error');
          return;
        }
        sessionPasswords.set(uid, pw);
        logAudit('user', `تعيين كلمة مرور جديدة لـ ${nm(uid)} (${uid})`, { target: uid });
      }
      await copyText(teamLoginDetails(uid, pw), `تم نسخ بيانات دخول ${nm(uid)}، ابعتهاله`);
      logAudit('user', `نسخ بيانات دخول ${nm(uid)} (${uid})`, { target: uid });
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
        const deletedName = nm(uid);
        await db.doc(`profiles/${uid}`).delete();
        await db.doc(`users/${uid}`).delete();
        sessionPasswords.delete(uid);
        logAudit('user', `حذف حساب ${deletedName} (${uid})`, { target: uid });
        toast('تم حذف المستخدم بنجاح', 'info');
      } catch {
        toast('تعذّر حذف المستخدم', 'error');
      }
    };
  });
}

// ----------------- CONFIGURABLE EXCEL / CSV IMPORT ENGINE -----------------
const COLUMN_MAPPINGS = {
  name: ['Arabic Name', 'Business Name', 'storeName', 'English Name', 'الاسم', 'اسم العميل', 'العميل', 'اسم المنشأة', 'Name', 'name', 'Company', 'الشركة'],
  phone: ['Phone', 'phone', 'WhatsApp', 'whatsapp', 'الهاتف', 'التليفون', 'الموبايل', 'رقم الهاتف', 'الجوال', 'Mobile', 'mobile'],
  category: ['Category', 'Type', 'themeName', 'النشاط', 'المجال', 'التصنيف', 'النوع', 'category', 'Industry'],
  city: ['City', 'District', 'Country', 'المدينة', 'المحافظة', 'المنطقة', 'العنوان', 'city', 'Location'],
  email: ['Email', 'email', 'البريد', 'البريد الإلكتروني', 'الايميل', 'e-mail'],
  website: ['Website', 'storeUrl', 'الموقع', 'المتجر', 'الموقع الإلكتروني', 'website', 'Site', 'site', 'URL', 'url'],
  maps: ['Google Maps', 'Maps', 'رابط الخريطة', 'اللوكيشن', 'خرائط جوجل', 'maps', 'location_url', 'google_maps', 'maps_link'],
  instagram: ['Instagram', 'instagram', 'انستقرام', 'انستجرام', 'إنستغرام', 'حساب انستجرام', 'IG', 'ig'],
  platform: ['Platform', 'platform', 'المنصة', 'المصدر', 'Source', 'source'],
  reason: ['Lead Reason', 'سبب الفرصة (جملة الفتح)'],
  section: ['القسم']
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
        extractMappedField(item, COLUMN_MAPPINGS.section) || sheetName,
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
        extractMappedField(item, COLUMN_MAPPINGS.reason),
        hasDupFlag || isPhoneDup,
        Date.now(),
        ...leadExtras(item)
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
    <b style="color:var(--success)">تم تحليل البيانات بنجاح!</b>
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
      <b style="color:var(--warning)">تنبيه بخصوص رابط OneDrive:</b><br>
      مايكروسوفت OneDrive تمنع المتصفحات من سحب الملفات المباشرة لحماية الخصوصية (CORS).<br>
      <br>
      <b>خطوات الحل البسيطة:</b><br>
      1. افتح رابط الـ OneDrive في نافذة جديدة.<br>
      2. اضغط من الأعلى: <b>ملف (File) &gt; حفظ باسم (Save As) &gt; تنزيل نسخة (Download a Copy)</b>.<br>
      3. ارجع هنا لتبويب <b>"رفع ملف من الجهاز"</b> واسحب الملف المحمل.<br>
      <br>
      <small style="color:var(--text-dim)">ملاحظة: لو بترفع الملف على Google Sheets بدلاً من OneDrive، يمكنك نشره على الويب (File &gt; Share &gt; Publish to web) وجلبه أونلاين مباشرة بدون تحميل.</small>
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
  logAudit('data', `استيراد ${parsedImportRows.length.toLocaleString('en')} عميل من ملف (${isAppend ? 'إضافة للموجود' : 'استبدال الكل'})`);

  // Security: Customer data kept purely in JS memory, NEVER stored unencrypted
  markFirstOccurrences();
  $('modal-excel-import').classList.remove('active');
  parsedImportRows = [];
  $('excel-file-input').value = '';

  toast(`تم استيراد ${state.S.length.toLocaleString('en')} عميل بنجاح إلى الداشبورد`, 'success');
  renderApp();
}

// ----------------- GLOBAL EVENT LISTENERS -----------------
function setupEventListeners() {
  // Login Submissions
  ['admin-login-pw', 'team-login-pw'].forEach(id => addPasswordToggle($(id)));

  // Audit log view
  $('audit-search').addEventListener('input', debounce(renderAuditView, 150));
  ['audit-filter-user', 'audit-filter-type', 'audit-filter-range'].forEach(id => { $(id).onchange = renderAuditView; });
  $('btn-audit-export').onclick = exportAuditToCSV;
  $('form-login-admin').onsubmit = (e) => { e.preventDefault(); handleAdminLogin(); };
  $('form-login-team').onsubmit = (e) => { e.preventDefault(); handleTeamLogin(); };

  // Logout
  $('btn-logout').onclick = async () => {
    if (state.me || state.sess) {
      logAudit('auth', `تسجيل خروج ${state.me?.isOwner ? 'السوبر أدمن' : nm(state.sess)}`);
    }
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
  if ($('filter-sort')) $('filter-sort').onchange = filterLeads;
  $('filter-sheet').onchange = filterLeads;
  ATTR_FILTERS.forEach(({ id }) => { if ($(id)) $(id).onchange = filterLeads; });
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
    initIcons();
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
    initIcons();
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

  // Mobile Drawer toggles
  const btnMobileMenu = $('btn-mobile-menu');
  if (btnMobileMenu) btnMobileMenu.onclick = openMobileDrawer;

  const btnCloseMobileDrawer = $('btn-close-mobile-drawer');
  if (btnCloseMobileDrawer) btnCloseMobileDrawer.onclick = closeMobileDrawer;

  const mobileNavOverlay = $('mobile-nav-overlay');
  if (mobileNavOverlay) mobileNavOverlay.onclick = closeMobileDrawer;

  const btnMobileDrawerLogout = $('btn-mobile-drawer-logout');
  if (btnMobileDrawerLogout) {
    btnMobileDrawerLogout.onclick = () => {
      closeMobileDrawer();
      $('btn-logout').click();
    };
  }

  // Mobile toolbar filters toggle
  const btnToggleToolbarFilters = $('btn-toggle-toolbar-filters');
  if (btnToggleToolbarFilters) {
    btnToggleToolbarFilters.onclick = () => {
      const wrap = $('toolbar-filters-wrap');
      if (wrap) wrap.classList.toggle('active');
    };
  }

  // Setup lead notes modal interactions
  setupNotesModalEvents();
}

// ----------------- LOGIN LOGIC -----------------
// Disables a login button with a busy label; returns a function that restores it.
function setLoginBusy(btn, busyText) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="refresh-cw" class="spin"></i> <span>${busyText}</span>`;
  initIcons();
  return () => {
    btn.disabled = false;
    btn.innerHTML = original;
  };
}

async function handleAdminLogin() {
  const pw = $('admin-login-pw').value.trim();
  const msg = $('admin-login-msg');
  msg.textContent = '';

  if (!pw) {
    msg.textContent = 'اكتب كلمة مرور السوبر أدمن';
    $('admin-login-pw').focus();
    return;
  }

  const restore = setLoginBusy($('btn-admin-login'), 'جاري فك التشفير...');

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
    logAudit('auth', 'دخول السوبر أدمن');

    $('admin-login-pw').value = '';
    setPasswordVisible($('admin-login-pw'), false);
    toast(`تم فك التشفير بنجاح! تم تحميل ${state.S.length.toLocaleString('en')} عميل من الشيت جاهزين للإسناد`, 'success');
    renderApp();
  } catch (err) {
    console.error('Decryption failed:', err);
    logAudit('auth', 'محاولة دخول فاشلة كسوبر أدمن (كلمة مرور غلط)', { by: '' });
    msg.textContent = 'كلمة المرور غير صحيحة';
    $('admin-login-pw').select();
  } finally {
    restore();
  }
}

async function handleTeamLogin() {
  const u = $('team-login-user').value.trim().toLowerCase();
  const p = $('team-login-pw').value;
  const msg = $('team-login-msg');
  msg.textContent = '';

  if (!u || !p) {
    msg.textContent = 'اكتب اسم الدخول وكلمة المرور';
    $(u ? 'team-login-pw' : 'team-login-user').focus();
    return;
  }

  const restore = setLoginBusy($('btn-team-login'), 'جاري التحقق...');
  try {
    const userDoc = await db.doc(`users/${u}`).get();
    const cred = userDoc.exists ? userDoc.data() : null;
    if (!cred || (await hpw(p, b2u(cred.salt), cred.it)) !== cred.hash) {
      logAudit('auth', `محاولة دخول فاشلة باسم الدخول "${u}"`, { by: '', target: u });
      msg.textContent = 'اسم الدخول أو كلمة المرور غير صحيحة';
      $('team-login-pw').select();
      return;
    }

    state.sess = u;
    state.me = { id: u, name: nm(u), isOwner: false };
    sessionStorage.setItem('crm_sess', u);
    sessionStorage.setItem('crm_is_owner', 'false');

    logAudit('auth', `دخول ${nm(u)}`);
    $('team-login-pw').value = '';
    setPasswordVisible($('team-login-pw'), false);
    toast(`أهلاً بك ${nm(u)}`, 'success');
    renderApp();
  } catch (err) {
    console.error(err);
    msg.textContent = 'تعذّر تسجيل الدخول، حاول مرة أخرى';
  } finally {
    restore();
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
