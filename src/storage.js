/**
 * Storage and Database engine for Sales & Delivery Dashboard
 * Supports:
 * 1. Cloud Mode: Supabase (cross-device realtime)
 * 2. Local Mode: localStorage with BroadcastChannel cross-tab live sync
 *
 * FIX (2026-10-13): profiles/users/leads/asg/audit were localStorage-only,
 * so a team member created on mobile never appeared on laptop.
 * Now every collection syncs to Supabase:
 *  - clients  -> dedicated columns table (legacy, kept as-is)
 *  - profiles, users, leads, asg, audit -> generic {id, data, updated_at} tables
 *    (see supabase-schema.sql — must be run once in Supabase SQL Editor)
 */

import { getSupabaseClient, getSupabaseConfig } from './supabase.js';

const STORAGE_KEY_PREFIX = 'sales_crm_';
const BROADCAST_CHANNEL = 'sales_crm_channel';

// Generic tables (id TEXT PK, data JSONB). `clients` has its own column layout.
const GENERIC_COLS = ['profiles', 'users', 'leads', 'asg', 'audit'];
const ALL_SYNCED_COLS = [...GENERIC_COLS, 'clients'];

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

    const hasSb = !!getSupabaseConfig();
    if (!hasSb && typeof fetch !== 'undefined') {
      fetch('/api/storage/clients')
        .then(r => r.ok ? r.json() : null)
        .then(remote => {
          if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
            const local = this._getColData('clients');
            const merged = { ...remote, ...local };
            this._setColData('clients', merged, true);
          }
        }).catch(() => {});
    }

    // Connect to Supabase Realtime if configured
    this._initSupabaseSync();
  }

  // ================= Supabase sync =================

  _initSupabaseSync() {
    try {
      const sb = getSupabaseClient();
      if (!sb) return;

      this._syncClientsFromSupabase(sb);
      GENERIC_COLS.forEach((col) => {
        this._pullGenericCol(sb, col);
        this._subscribeGenericCol(sb, col);
      });
    } catch (e) {
      console.warn('Error setting up Supabase sync:', e);
    }
  }

  _saveColLocal(col, data) {
    this.memStore.set(col, data);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_PREFIX + col, JSON.stringify(data));
      } catch {}
    }
    this._notify(col);
  }

  // ---- clients (dedicated columns, legacy) ----
  _rowToClientVal(row) {
    return {
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
  }

  _clientValToRow(id, val) {
    return {
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
      portal_active: (val.portalActive !== undefined ? val.portalActive : val.portal_active) ?? true,
      portal_username: val.portalUsername || val.portal_username || '',
      portal_password: val.portalPassword || val.portal_password || '',
      seo: Number(val.seo !== undefined ? val.seo : 0),
      media: Number(val.media !== undefined ? val.media : 0),
      social: Number(val.social !== undefined ? val.social : 0),
      dev: Number(val.dev !== undefined ? val.dev : 0),
      ui: Number(val.ui !== undefined ? val.ui : 0),
      dept_details: val.deptDetails || val.dept_details || {},
      client_note: val.clientNote || val.client_note || '',
      expected_delivery: val.expectedDelivery || val.expected_delivery || '',
      updated_at: new Date().toISOString()
    };
  }

  _syncClientsFromSupabase(sb) {
    // 1. Initial Pull from Supabase
    sb.from('clients').select('*').then(({ data, error }) => {
      if (error) {
        console.warn('Supabase clients pull skipped:', error.message);
        return;
      }
      const cloudRows = data || [];
      const cloudMap = {};
      cloudRows.forEach(row => {
        cloudMap[row.id] = this._rowToClientVal(row);
      });

      const local = this._getColData('clients');
      const localKeys = Object.keys(local);
      const cloudKeys = Object.keys(cloudMap);

      if (cloudKeys.length > 0) {
        // Cloud is authoritative
        this._saveColLocal('clients', cloudMap);
      } else if (localKeys.length > 0) {
        // Cloud is empty. If local only has demo items, clear them
        const isOnlyDemo = localKeys.every(k => ['demo_1', 'c_4393', 'c_27'].includes(k));
        if (isOnlyDemo) {
          this._saveColLocal('clients', {});
        } else {
          const rows = Object.entries(local)
            .filter(([id]) => !['demo_1', 'c_4393', 'c_27'].includes(id))
            .map(([id, val]) => this._clientValToRow(id, val));
          if (rows.length) {
            sb.from('clients').upsert(rows).catch(() => {});
          }
        }
      } else {
        this._saveColLocal('clients', {});
      }
    }).catch(err => console.warn('Supabase initial pull error:', err));

    // 2. Realtime Subscription
    sb.channel('crm_clients_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const oldId = payload.old?.id;
          if (oldId) {
            const local = this._getColData('clients');
            if (local[oldId] !== undefined) {
              delete local[oldId];
              this._saveColLocal('clients', local);
            }
          }
          return;
        }
        if (payload.new && payload.new.id) {
          const row = payload.new;
          const local = this._getColData('clients');
          local[row.id] = this._rowToClientVal(row);
          this._saveColLocal('clients', local);
        }
      })
      .subscribe();
  }

  // ---- generic cols (profiles/users/leads/asg/audit) ----
  _pullGenericCol(sb, col) {
    sb.from(col).select('id,data').then(({ data, error }) => {
      if (error) {
        // Table probably doesn't exist yet -> user must run supabase-schema.sql
        console.warn(`Supabase pull [${col}] skipped:`, error.message);
        return;
      }
      const cloudRows = data || [];
      const cloudMap = {};
      cloudRows.forEach(row => {
        if (row && row.id !== undefined) {
          cloudMap[row.id] = row.data || {};
        }
      });

      const local = this._getColData(col);
      const localKeys = Object.keys(local);
      const cloudKeys = Object.keys(cloudMap);

      if (cloudKeys.length > 0) {
        // Cloud has data -> cloud is authoritative!
        this._saveColLocal(col, cloudMap);
      } else if (localKeys.length > 0) {
        // Cloud is empty, but local has data: first-time sync push
        console.log(`Supabase push-up [${col}]: uploading initial ${localKeys.length} docs`);
        this._pushGenericBulk(col, local);
      } else {
        this._saveColLocal(col, {});
      }
    }).catch(err => console.warn(`Supabase pull [${col}] error:`, err));
  }

  _subscribeGenericCol(sb, col) {
    sb.channel(`crm_${col}_realtime`)
      .on('postgres_changes', { event: '*', schema: 'public', table: col }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const oldId = payload.old?.id;
          if (oldId) {
            const local = this._getColData(col);
            if (local[oldId] !== undefined) {
              delete local[oldId];
              this._saveColLocal(col, local);
            }
          }
          return;
        }
        if (payload.new && payload.new.id !== undefined) {
          const local = this._getColData(col);
          local[payload.new.id] = { ...(local[payload.new.id] || {}), ...(payload.new.data || {}) };
          this._saveColLocal(col, local);
        }
      })
      .subscribe();
  }

  _pushGenericDoc(col, id, docData) {
    const sb = getSupabaseClient();
    if (!sb) return;
    sb.from(col).upsert({
      id,
      data: docData || {},
      updated_at: new Date().toISOString()
    }).then(({ error }) => {
      if (error) console.warn(`Supabase push [${col}/${id}] skipped:`, error.message);
    }).catch(() => {});
  }

  _pushGenericBulk(col, data) {
    const sb = getSupabaseClient();
    if (!sb) return;
    const rows = Object.entries(data).map(([id, val]) => ({
      id,
      data: val || {},
      updated_at: new Date().toISOString()
    }));
    if (!rows.length) return;
    // chunk to avoid payload limits
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      sb.from(col).upsert(rows.slice(i, i + CHUNK)).then(({ error }) => {
        if (error) console.warn(`Supabase bulk push [${col}] skipped:`, error.message);
      }).catch(() => {});
    }
  }

  async _fetchRemoteDoc(col, id) {
    const sb = getSupabaseClient();
    if (!sb) return null;
    try {
      if (col === 'clients') {
        const { data, error } = await sb.from('clients').select('*').eq('id', id).maybeSingle();
        if (!error && data) {
          const val = this._rowToClientVal(data);
          const local = this._getColData('clients');
          local[id] = { ...(local[id] || {}), ...val };
          this._saveColLocal('clients', local);
          return val;
        }
        return null;
      }
      if (GENERIC_COLS.includes(col)) {
        const { data, error } = await sb.from(col).select('id,data').eq('id', id).maybeSingle();
        if (!error && data) {
          const val = data.data || {};
          const local = this._getColData(col);
          local[id] = { ...(local[id] || {}), ...val };
          this._saveColLocal(col, local);
          return val;
        }
      }
    } catch (e) {
      console.warn(`Supabase fetch [${col}/${id}] error:`, e);
    }
    return null;
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

  _setColData(col, data, skipSupabaseSync = false) {
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
      if (!skipSupabaseSync) {
        const sb = getSupabaseClient();
        if (sb) {
          if (col === 'clients') {
            const rows = Object.entries(data).map(([id, val]) => this._clientValToRow(id, val));
            if (rows.length) {
              sb.from('clients').upsert(rows).then(({ error }) => {
                if (error) console.warn('Supabase bulk clients push skipped:', error.message);
              }).catch(() => {});
            }
          } else if (GENERIC_COLS.includes(col)) {
            this._pushGenericBulk(col, data);
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
      // One-shot read of the whole collection (same snapshot shape as onSnapshot)
      async get() {
        // Refresh generic/client cols from cloud in background so a fresh
        // device sees data created elsewhere even before realtime arrives.
        const sb = getSupabaseClient();
        if (sb && ALL_SYNCED_COLS.includes(col)) {
          try {
            if (col === 'clients') {
              const { data, error } = await sb.from('clients').select('*');
              if (!error && data) {
                const cloudMap = {};
                data.forEach(row => {
                  cloudMap[row.id] = self._rowToClientVal(row);
                });
                self._saveColLocal(col, cloudMap);
              }
            } else {
              const { data, error } = await sb.from(col).select('id,data');
              if (!error && data) {
                const cloudMap = {};
                data.forEach(row => {
                  if (row && row.id !== undefined) cloudMap[row.id] = row.data || {};
                });
                self._saveColLocal(col, cloudMap);
              }
            }
          } catch {}
        }
        const docs = Object.entries(self._getColData(col)).map(([id, val]) => ({
          id,
          data: () => val,
          exists: true
        }));
        return { docs, forEach: (fn) => docs.forEach(fn), size: docs.length };
      },
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
        if (exists) {
          return {
            id,
            exists,
            data: () => colData[id]
          };
        }
        // Fallback: fresh device (e.g. laptop) may not have local copy yet
        // of a doc created on another device (e.g. mobile). Try cloud once.
        if (ALL_SYNCED_COLS.includes(col)) {
          const remote = await self._fetchRemoteDoc(col, id);
          if (remote !== null && remote !== undefined) {
            return { id, exists: true, data: () => remote };
          }
        }
        return {
          id,
          exists: false,
          data: () => undefined
        };
      },
      async set(data) {
        const colData = self._getColData(col);
        colData[id] = { ...data };
        self._setColData(col, colData, true);

        if (col === 'clients') {
          const sb = getSupabaseClient();
          if (sb) {
            const val = colData[id];
            try {
              const { error } = await sb.from('clients').upsert(self._clientValToRow(id, val));
              if (error) console.error('Supabase direct set error:', error.message);
            } catch (err) {
              console.error('Supabase set exception:', err);
            }
          }
        } else if (GENERIC_COLS.includes(col)) {
          self._pushGenericDoc(col, id, colData[id]);
        }
      },
      async update(partial) {
        const colData = self._getColData(col);
        if (!colData[id]) colData[id] = {};
        colData[id] = { ...colData[id], ...partial };
        // Save locally and broadcast, skip bulk sync to avoid race condition
        self._setColData(col, colData, true);

        if (col === 'clients') {
          const sb = getSupabaseClient();
          if (sb) {
            const val = colData[id];
            try {
              const { error } = await sb.from('clients').upsert(self._clientValToRow(id, val));
              if (error) console.error('Supabase direct update error:', error.message);
            } catch (err) {
              console.error('Supabase update exception:', err);
            }
          }
        } else if (GENERIC_COLS.includes(col)) {
          self._pushGenericDoc(col, id, colData[id]);
        }
      },
      async delete() {
        const colData = self._getColData(col);
        delete colData[id];
        self._setColData(col, colData, true);
        const sb = getSupabaseClient();
        if (sb && ALL_SYNCED_COLS.includes(col)) {
          sb.from(col).delete().eq('id', id).then(({ error }) => {
            if (error) console.warn(`Supabase delete [${col}/${id}] skipped:`, error.message);
          }).catch((e) => console.error(e));
        }
      }
    };
  }

  exportAll() {
    const cols = ['profiles', 'users', 'leads', 'clients', 'asg', 'audit'];
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
        modeText: 'سحابي (Supabase متصل)'
      };
    }
    return {
      isCloud: false,
      hasConfig: false,
      modeText: 'محلي (تخزين الجهاز)'
    };
  }

  async init() {
    // Clean up any legacy Firebase config
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('crm_firebase_config');
      }
    } catch {}
    this.activeDb = this.localDb;
    this._notifyStatus();
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
