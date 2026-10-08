/**
 * Storage and Database engine for Sales & Delivery Dashboard
 * Supports:
 * 1. Cloud Mode: Real-time Cloud Firestore across multiple devices
 * 2. Local Mode: High-performance IndexedDB/LocalStorage with BroadcastChannel cross-tab live sync
 */

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
