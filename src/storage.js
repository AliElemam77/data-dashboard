/**
 * Storage and Database engine for Sales & Delivery Dashboard
 * Supports:
 * 1. Cloud Mode: Real-time Cloud Firestore across multiple devices
 * 2. Local Mode: High-performance IndexedDB/LocalStorage with BroadcastChannel cross-tab live sync
 */

import { getSupabaseClient, getSupabaseConfig } from './supabase.js';

const STORAGE_KEY_PREFIX = 'sales_crm_';
const BROADCAST_CHANNEL = 'sales_crm_channel';

class LocalDatabase {
  constructor() {
    this.listeners = new Map(); // colName -> Set of callbacks
    this.memStore = new Map();  // in-memory fallback
    this.bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(BROADCAST_CHANNEL) : null;
    if (this.bc) {
      this.bc.onmessage = (event) => {
        if (event.data && event.data.type === 'change') {
          this._notify(event.data.col);
        }
      };
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith(STORAGE_KEY_PREFIX)) {
          const col = e.key.replace(STORAGE_KEY_PREFIX, '');
          this._notify(col);
        }
      });
    }

    if (typeof fetch !== 'undefined') {
      fetch('/api/storage/clients')
        .then(r => r.ok ? r.json() : null)
        .then(remote => {
          if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
            const local = this._getColData('clients');
            const merged = { ...remote, ...local };
            this._setColData('clients', merged);
          } else {
            const local = this._getColData('clients');
            if (Object.keys(local).length > 0) {
              fetch('/api/storage/clients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(local)
              }).catch(() => {});
            }
          }
        }).catch(() => {});
    }

    // Connect to Supabase Realtime if configured
    this._initSupabaseSync();
  }

  _initSupabaseSync() {
    try {
      const sb = getSupabaseClient();
      if (!sb) return;

      // 1. Initial Pull from Supabase
      sb.from('clients').select('*').then(({ data, error }) => {
        if (!error && data && data.length > 0) {
          const local = this._getColData('clients');
          let modified = false;
          data.forEach(row => {
            local[row.id] = {
              ...(local[row.id] || {}),
              name: row.name || '',
              cat: row.cat || '',
              city: row.city || '',
              phone: row.phone || '',
              wa: row.wa || '',
              site: row.site || '',
              ig: row.ig || '',
              plat: row.plat || '',
              by: row.by || '',
              at: row.at || Date.now(),
              portalActive: row.portal_active ?? true,
              portalUsername: row.portal_username || '',
              portalPassword: row.portal_password || '',
              seo: row.seo || 0,
              media: row.media || 0,
              social: row.social || 0,
              dev: row.dev || 0,
              ui: row.ui || 0,
              deptDetails: row.dept_details || {},
              clientNote: row.client_note || '',
              expectedDelivery: row.expected_delivery || ''
            };
            modified = true;
          });
          if (modified) {
            this.memStore.set('clients', local);
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(STORAGE_KEY_PREFIX + 'clients', JSON.stringify(local));
            }
            this._notify('clients');
          }
        }
      }).catch(err => console.warn('Supabase initial pull error:', err));

      // 2. Realtime Subscription
      sb.channel('crm_clients_realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, (payload) => {
          if (payload.new && payload.new.id) {
            const row = payload.new;
            const local = this._getColData('clients');
            local[row.id] = {
              ...(local[row.id] || {}),
              name: row.name || '',
              cat: row.cat || '',
              city: row.city || '',
              phone: row.phone || '',
              wa: row.wa || '',
              site: row.site || '',
              ig: row.ig || '',
              plat: row.plat || '',
              by: row.by || '',
              at: row.at || Date.now(),
              portalActive: row.portal_active ?? true,
              portalUsername: row.portal_username || '',
              portalPassword: row.portal_password || '',
              seo: row.seo || 0,
              media: row.media || 0,
              social: row.social || 0,
              dev: row.dev || 0,
              ui: row.ui || 0,
              deptDetails: row.dept_details || {},
              clientNote: row.client_note || '',
              expectedDelivery: row.expected_delivery || ''
            };
            this.memStore.set('clients', local);
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(STORAGE_KEY_PREFIX + 'clients', JSON.stringify(local));
            }
            this._notify('clients');
          }
        })
        .subscribe();
    } catch (e) {
      console.warn('Error setting up Supabase sync:', e);
    }
  }

  _getColData(col) {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY_PREFIX + col);
        return raw ? JSON.parse(raw) : {};
      }
      return this.memStore.get(col) || {};
    } catch (e) {
      console.warn('Error reading storage', e);
      return this.memStore.get(col) || {};
    }
  }

  _setColData(col, data) {
    try {
      this.memStore.set(col, data);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY_PREFIX + col, JSON.stringify(data));
      }
      this._notify(col);
      if (this.bc) {
        this.bc.postMessage({ type: 'change', col });
      }
      if (col === 'clients' && typeof fetch !== 'undefined') {
        fetch('/api/storage/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        }).catch(() => {});
      }
      if (col === 'clients') {
        const sb = getSupabaseClient();
        if (sb) {
          const rows = Object.entries(data).map(([id, val]) => ({
            id,
            name: val.name || '',
            cat: val.cat || '',
            city: val.city || '',
            phone: val.phone || '',
            wa: val.wa || '',
            site: val.site || '',
            ig: val.ig || '',
            plat: val.plat || '',
            by: val.by || '',
            at: val.at || Date.now(),
            portal_active: val.portalActive ?? true,
            portal_username: val.portalUsername || '',
            portal_password: val.portalPassword || '',
            seo: val.seo || 0,
            media: val.media || 0,
            social: val.social || 0,
            dev: val.dev || 0,
            ui: val.ui || 0,
            dept_details: val.deptDetails || {},
            client_note: val.clientNote || '',
            expected_delivery: val.expectedDelivery || ''
          }));
          if (rows.length) {
            sb.from('clients').upsert(rows).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error('Error writing storage', e);
      this.memStore.set(col, data);
      this._notify(col);
    }
  }

  _notify(col) {
    const list = this.listeners.get(col);
    if (!list) return;
    const data = this._getColData(col);
    const docs = Object.entries(data).map(([id, val]) => ({
      id,
      data: () => val,
      exists: true
    }));
    const snapshot = {
      docs,
      forEach: (fn) => docs.forEach(fn),
      size: docs.length
    };
    list.forEach(cb => {
      try { cb(snapshot); } catch (err) { console.error(err); }
    });
  }

  collection(col) {
    const self = this;
    return {
      onSnapshot(cb, errCb) {
        if (!self.listeners.has(col)) {
          self.listeners.set(col, new Set());
        }
        self.listeners.get(col).add(cb);
        // Trigger initial callback asynchronously
        setTimeout(() => {
          try {
            const data = self._getColData(col);
            const docs = Object.entries(data).map(([id, val]) => ({
              id,
              data: () => val,
              exists: true
            }));
            cb({
              docs,
              forEach: (fn) => docs.forEach(fn),
              size: docs.length
            });
          } catch (e) {
            if (errCb) errCb(e);
          }
        }, 0);

        // Return unsubscribe
        return () => {
          if (self.listeners.has(col)) {
            self.listeners.get(col).delete(cb);
          }
        };
      },
      where(field, op, val) {
        return {
          onSnapshot(cb, errCb) {
            const filteredCb = (snap) => {
              const matched = snap.docs.filter(d => {
                const dData = d.data();
                if (op === '==') return dData[field] === val;
                return true;
              });
              cb({
                docs: matched,
                forEach: (fn) => matched.forEach(fn),
                size: matched.length
              });
            };
            return self.collection(col).onSnapshot(filteredCb, errCb);
          }
        };
      }
    };
  }

  doc(path) {
    const parts = path.split('/');
    const col = parts[0];
    const id = parts.slice(1).join('/');
    const self = this;

    return {
      async get() {
        const colData = self._getColData(col);
        const exists = Object.prototype.hasOwnProperty.call(colData, id);
        return {
          id,
          exists,
          data: () => (exists ? colData[id] : undefined)
        };
      },
      async set(data) {
        const colData = self._getColData(col);
        colData[id] = { ...data };
        self._setColData(col, colData);
      },
      async update(partial) {
        const colData = self._getColData(col);
        if (!colData[id]) colData[id] = {};
        colData[id] = { ...colData[id], ...partial };
        self._setColData(col, colData);

        if (col === 'clients') {
          const sb = getSupabaseClient();
          if (sb) {
            const val = colData[id];
            sb.from('clients').upsert({
              id,
              name: val.name || '',
              cat: val.cat || '',
              city: val.city || '',
              phone: val.phone || '',
              wa: val.wa || '',
              site: val.site || '',
              ig: val.ig || '',
              plat: val.plat || '',
              by: val.by || '',
              at: val.at || Date.now(),
              portal_active: val.portalActive ?? true,
              portal_username: val.portalUsername || '',
              portal_password: val.portalPassword || '',
              seo: Number(val.seo || 0),
              media: Number(val.media || 0),
              social: Number(val.social || 0),
              dev: Number(val.dev || 0),
              ui: Number(val.ui || 0),
              dept_details: val.deptDetails || val.dept_details || {},
              client_note: val.clientNote || val.client_note || '',
              expected_delivery: val.expectedDelivery || val.expected_delivery || '',
              updated_at: new Date().toISOString()
            }).then(({ error }) => {
              if (error) console.error('Supabase direct update error:', error);
            }).catch(() => {});
          }
        }
      },
      async delete() {
        const colData = self._getColData(col);
        delete colData[id];
        self._setColData(col, colData);
      }
    };
  }

  exportAll() {
    const cols = ['profiles', 'users', 'leads', 'clients', 'asg'];
    const dump = {};
    cols.forEach(c => {
      dump[c] = this._getColData(c);
    });
    return dump;
  }

  importAll(dump) {
    if (!dump || typeof dump !== 'object') return false;
    Object.entries(dump).forEach(([col, val]) => {
      if (typeof val === 'object' && val !== null) {
        this._setColData(col, val);
      }
    });
    return true;
  }
}

class StorageManager {
  constructor() {
    this.localDb = new LocalDatabase();
    this.activeDb = this.localDb;
    this.firebaseApp = null;
    this.firestoreDb = null;
    this.isCloud = false;
    this.statusListeners = new Set();
  }

  onStatusChange(cb) {
    this.statusListeners.add(cb);
    cb(this.getStatus());
    return () => this.statusListeners.delete(cb);
  }

  _notifyStatus() {
    const status = this.getStatus();
    this.statusListeners.forEach(cb => cb(status));
  }

  getStatus() {
    const sbConfig = getSupabaseConfig();
    const hasSb = !!(sbConfig && sbConfig.url && sbConfig.key);
    if (hasSb) {
      return {
        isCloud: true,
        hasConfig: true,
        modeText: 'سحابي (Supabase متصل ⚡)'
      };
    }
    return {
      isCloud: this.isCloud,
      hasConfig: !!this.getFirebaseConfig(),
      modeText: this.isCloud ? 'سحابي (Firebase متصل)' : 'محلي (تخزين الجهاز)'
    };
  }

  getFirebaseConfig() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem('crm_firebase_config');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  setFirebaseConfig(cfg) {
    if (typeof localStorage === 'undefined') return;
    if (!cfg) {
      localStorage.removeItem('crm_firebase_config');
    } else {
      localStorage.setItem('crm_firebase_config', JSON.stringify(cfg));
    }
  }

  async init() {
    const cfg = this.getFirebaseConfig();
    if (cfg && cfg.apiKey && cfg.projectId) {
      try {
        await this.connectFirebase(cfg);
        return;
      } catch (err) {
        console.warn('Firebase init failed, using local fallback:', err);
      }
    }
    this.activeDb = this.localDb;
    this.isCloud = false;
    this._notifyStatus();
  }

  async connectFirebase(cfg) {
    // Dynamic import of Firebase SDK via CDN (compatible with pure client bundles)
    if (!window.firebaseAppLoaded) {
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');
      window.firebaseAppLoaded = true;
    }

    if (!window.firebase.apps.length) {
      this.firebaseApp = window.firebase.initializeApp(cfg);
    } else {
      this.firebaseApp = window.firebase.app();
    }
    this.firestoreDb = window.firebase.firestore();

    // Wrap firestore compat in standard interface
    this.activeDb = {
      collection: (col) => this.firestoreDb.collection(col),
      doc: (path) => this.firestoreDb.doc(path)
    };

    this.setFirebaseConfig(cfg);
    this.isCloud = true;
    this._notifyStatus();
    return true;
  }

  disconnectCloud() {
    this.activeDb = this.localDb;
    this.isCloud = false;
    this.setFirebaseConfig(null);
    this._notifyStatus();
  }

  async migrateLocalToCloud() {
    if (!this.isCloud || !this.firestoreDb) {
      throw new Error('السحابة غير متصلة');
    }
    const data = this.localDb.exportAll();
    const batchOps = [];

    for (const [col, docs] of Object.entries(data)) {
      for (const [id, val] of Object.entries(docs)) {
        batchOps.push(this.firestoreDb.collection(col).doc(id).set(val));
      }
    }
    await Promise.all(batchOps);
    return batchOps.length;
  }

  // Database proxy methods
  collection(col) {
    return this.activeDb.collection(col);
  }

  doc(path) {
    return this.activeDb.doc(path);
  }
}

export const dbManager = new StorageManager();
export const db = dbManager;
