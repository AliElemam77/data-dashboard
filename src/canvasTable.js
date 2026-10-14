/**
 * CanvasCustomerTable - High-Performance, DOM-Leak-Free Virtualized Canvas Table
 * 
 * Sensitive customer data is rendered EXCLUSIVELY via HTML5 Canvas (ctx.fillText).
 * Zero text nodes, zero <div>/<span>/<td> rows exist in the DOM for customer records.
 * 
 * Features:
 * - High-DPI / Retina devicePixelRatio scaling for razor-sharp text
 * - Virtualized rendering for tens of thousands of rows at 60 FPS
 * - Mathematical hit testing for hover, row selection, sorting, action clicks
 * - Enterprise anti-screenshot subtle diagonal watermark
 * - Native RTL (Arabic) & LTR support
 * - Frontend protections against copy, cut, contextmenu, drag, selection
 */

import { LX } from './leadFields.js';

// Canvas can't use CSS variables, so the table snapshots the theme tokens from style.css.
// setTheme() refreshes it; the app calls that after <html data-theme> changes.
function readThemePalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    bgSurface: v('--bg-surface'),
    bgRowAlt: v('--bg-card-hover'),
    bgHeader: v('--bg-surface-elevated'),
    borderSubtle: v('--border-subtle'),
    borderStrong: v('--border-medium'),
    textMain: v('--text-main'),
    textMuted: v('--text-muted'),
    textDim: v('--text-dim'),
    primary: v('--primary'),
    onPrimary: v('--on-primary'),
    soft: v('--primary-soft'),
    glow: v('--primary-glow'),
  };
}

// ERP grade badge in grays: A = solid ink, B = gray fill, C = light fill, D = outline only
function erpBadgeStyle(grade, c) {
  if (grade === 'A') return { fill: c.primary, text: c.onPrimary };
  if (grade === 'B') return { fill: c.glow, text: c.textMain };
  if (grade === 'C') return { fill: c.soft, text: c.textMuted };
  return { stroke: c.borderStrong, text: c.textDim };
}

export class CanvasCustomerTable {
  constructor(options = {}) {
    this.viewport = null;
    this.spacer = null;
    this.canvas = null;
    this.ctx = null;

    // Dimensions & Virtualization metrics
    this.rowHeight = 46;
    this.headerHeight = 44;
    this.dpr = window.devicePixelRatio || 1;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.scrollLeft = 0;
    this.scrollTop = 0;

    // Data State
    this.rows = [];          // Filtered lead indices: [0, 4, 9, ...]
    this.allLeads = [];      // Master leads array: [r0, r1, ...]
    this.statuses = new Map();     // cid -> { s, r, j, notes, noteBy, noteAt, ... }
    this.assignments = new Map();  // cid -> username
    this.selectedCids = new Set();
    this.userRole = 'owner';
    this.currentUsername = 'admin';
    this.isOwner = true;
    this.isDark = true;

    // Sorting
    this.sortCol = null;
    this.sortAsc = true;

    // Interaction State
    this.hoveredRowIdx = -1;
    this.hoveredColId = null;
    this.hoveredAction = null; // 'chk' | 'web' | 'maps' | 'wa' | 'ig' | 'note' | 's' | 'r' | 'j' | 'assign'

    // Callbacks
    this.onSelectRow = options.onSelectRow || (() => {});
    this.onSelectAll = options.onSelectAll || (() => {});
    this.onOpenWebsite = options.onOpenWebsite || (() => {});
    this.onOpenMaps = options.onOpenMaps || (() => {});
    this.onOpenWhatsApp = options.onOpenWhatsApp || (() => {});
    this.onOpenInstagram = options.onOpenInstagram || (() => {});
    this.onOpenNotes = options.onOpenNotes || (() => {});
    this.onToggleStage = options.onToggleStage || (() => {});
    this.onOpenAssign = options.onOpenAssign || (() => {});
    this.onSort = options.onSort || (() => {});

    // Watermark
    this.watermarkEnabled = true;

    // Table Column Definitions
    this.columns = [
      { id: 'select', title: '', width: 44, align: 'center', sortable: false },
      { id: 'index', title: '#', width: 46, align: 'center', sortable: true },
      { id: 'name', title: 'الاسم والنشاط', width: 230, align: 'right', sortable: true },
      { id: 'opportunity', title: 'الفرصة وجملة الفتح', width: 260, align: 'right', sortable: true },
      { id: 'category', title: 'التصنيف', width: 130, align: 'right', sortable: true },
      { id: 'city', title: 'المدينة', width: 100, align: 'right', sortable: true },
      { id: 'phone', title: 'رقم الهاتف', width: 130, align: 'ltr', sortable: false },
      { id: 'website', title: 'الموقع (الويبسايت)', width: 140, align: 'center', sortable: true },
      { id: 'contacts', title: 'اللوكيشن والتواصل', width: 140, align: 'center', sortable: false },
      { id: 'notes', title: 'ملاحظات السيلز', width: 180, align: 'right', sortable: true },
      { id: 'sheet', title: 'المصدر / الشيت', width: 110, align: 'right', sortable: true },
      { id: 'duplicate', title: 'التكرار', width: 65, align: 'center', sortable: true },
      { id: 'stages', title: 'مرحلة التواصل', width: 230, align: 'center', sortable: false },
      { id: 'updated', title: 'آخر تحديث', width: 140, align: 'right', sortable: false },
      { id: 'assignee', title: 'المسؤول (السيلز)', width: 130, align: 'center', sortable: true }
    ];

    this.totalTableWidth = this.columns.reduce((sum, c) => sum + c.width, 0);

    // Animation frame flag
    this.rafId = 0;
  }

  init(viewportEl, spacerEl, canvasEl) {
    this.viewport = viewportEl;
    this.spacer = spacerEl;
    this.canvas = canvasEl;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.updateColumnLayout();

    // Security & Anti-Copy Event Handlers directly on Canvas
    const blockEvent = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    this.canvas.addEventListener('contextmenu', blockEvent);
    this.canvas.addEventListener('copy', blockEvent);
    this.canvas.addEventListener('cut', blockEvent);
    this.canvas.addEventListener('selectstart', blockEvent);
    this.canvas.addEventListener('dragstart', blockEvent);

    this.viewport.addEventListener('contextmenu', blockEvent);
    this.viewport.addEventListener('copy', blockEvent);
    this.viewport.addEventListener('cut', blockEvent);
    this.viewport.addEventListener('selectstart', blockEvent);

    // Scroll listener
    this.viewport.addEventListener('scroll', () => {
      this.scrollTop = this.viewport.scrollTop;
      this.scheduleRender();
    }, { passive: true });

    // Mouse interactions
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    this.canvas.addEventListener('click', (e) => this.handleClick(e));

    // ResizeObserver
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.viewport);

    this.handleResize();
  }

  configureColumnsForRole() {
    // If not owner (e.g. sales rep):
    // Hide 'select', 'duplicate', 'sheet', 'assignee'
    const ownerCols = new Set(['select', 'duplicate', 'sheet', 'assignee']);
    this.columns.forEach(col => {
      col.hidden = !this.isOwner && ownerCols.has(col.id);
    });
  }

  updateColumnLayout() {
    this.configureColumnsForRole();
    const visibleCols = this.columns.filter(c => !c.hidden);
    const sumWidth = visibleCols.reduce((sum, c) => sum + c.width, 0);
    this.totalTableWidth = Math.max(sumWidth, this.viewportWidth || sumWidth);

    // In RTL, column 0 starts from the RIGHT edge
    let currentRight = this.totalTableWidth;
    for (let ci = 0; ci < this.columns.length; ci++) {
      const col = this.columns[ci];
      if (col.hidden) {
        col.x = -9999;
        continue;
      }
      currentRight -= col.width;
      col.x = currentRight;
    }
    if (this.spacer) {
      this.spacer.style.width = `${this.totalTableWidth}px`;
      this.spacer.style.minWidth = `${this.totalTableWidth}px`;
    }
  }

  handleResize() {
    if (!this.viewport || !this.canvas) return;
    this.dpr = window.devicePixelRatio || 1;
    const curW = this.viewport.clientWidth || window.innerWidth || 1200;
    const curH = this.viewport.clientHeight || Math.max(540, window.innerHeight - 200);
    this.viewportWidth = curW;
    this.viewportHeight = curH;

    this.updateColumnLayout();

    // Size internal canvas buffer by DPR with extra bottom buffer (+ rowHeight * 2) so last item is never clipped
    this.canvas.width = Math.max(1, Math.floor(this.totalTableWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.floor((this.viewportHeight + this.rowHeight * 2) * this.dpr));

    // Size CSS layout
    this.canvas.style.width = `${this.totalTableWidth}px`;
    this.canvas.style.height = `${this.viewportHeight + this.rowHeight * 2}px`;

    this.scheduleRender();
  }

  setTheme(isDark) {
    this.isDark = isDark;
    this.palette = readThemePalette();
    this.scheduleRender();
  }

  setData({ filteredIndices, allLeads, statuses, assignments, selectedCids, userRole, currentUsername, isOwner }) {
    this.rows = filteredIndices || [];
    this.allLeads = allLeads || [];
    this.statuses = statuses || new Map();
    this.assignments = assignments || new Map();
    this.selectedCids = selectedCids || new Set();
    this.userRole = userRole || 'owner';
    this.currentUsername = currentUsername || 'admin';
    this.isOwner = !!isOwner;

    this.updateColumnLayout();

    // Update total spacer height with 140px generous bottom clearance so last row is always 100% visible
    const BOTTOM_CLEARANCE = 140;
    const totalHeight = this.headerHeight + (this.rows.length * this.rowHeight) + BOTTOM_CLEARANCE;
    if (this.spacer) {
      this.spacer.style.height = `${totalHeight}px`;
    }

    this.scheduleRender();
  }

  scheduleRender() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  // ----------------- RENDERING PIPELINE -----------------
  render() {
    if (!this.viewport || !this.canvas || !this.ctx) return;
    const curW = this.viewport.clientWidth;
    const curH = this.viewport.clientHeight;
    if ((curW > 0 && curW !== this.viewportWidth) || (curH > 0 && curH !== this.viewportHeight)) {
      this.handleResize();
    }
    if (!this.viewportWidth || !this.viewportHeight) {
      this.handleResize();
    }
    const ctx = this.ctx;
    const dpr = this.dpr;
    const w = this.totalTableWidth;
    const h = this.viewportHeight;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Theme palette (from the CSS tokens)
    const colors = this.palette || (this.palette = readThemePalette());
    const { bgSurface, bgRowAlt, borderSubtle } = colors;
    const bgRowHover = colors.soft;
    const bgRowSelected = colors.glow;

    // 1. Clear background
    ctx.fillStyle = bgSurface;
    ctx.fillRect(0, 0, w, h);

    // 2. Subtle Watermark (Enterprise anti-screenshot protection)
    if (this.watermarkEnabled) {
      this.drawWatermark(ctx, w, h);
    }

    // 3. Virtualized Row Calculations
    const scrollTop = this.scrollTop;
    const headerH = this.headerHeight;
    const rowH = this.rowHeight;

    const startIdx = Math.max(0, Math.floor(scrollTop / rowH) - 2);
    const endIdx = Math.min(this.rows.length, Math.ceil((scrollTop + h) / rowH) + 4);

    // Draw visible body rows
    for (let k = startIdx; k < endIdx; k++) {
      const rowIdx = this.rows[k];
      const r = this.allLeads[rowIdx];
      if (!r) continue;

      const cid = r[0];
      const st = this.statuses.get(cid) || {};
      const isSelected = this.selectedCids.has(cid);
      const isHovered = (this.hoveredRowIdx === k);

      const rowY = headerH + (k * rowH) - scrollTop;
      if (rowY + rowH < headerH || rowY > h + rowH * 2) continue;

      // Row background
      if (isSelected) {
        ctx.fillStyle = bgRowSelected;
      } else if (isHovered) {
        ctx.fillStyle = bgRowHover;
      } else if (k % 2 === 1) {
        ctx.fillStyle = bgRowAlt;
      } else {
        ctx.fillStyle = bgSurface;
      }
      ctx.fillRect(0, rowY, w, rowH);

      // Row bottom divider
      ctx.fillStyle = borderSubtle;
      ctx.fillRect(0, rowY + rowH - 1, w, 1);

      // Render cells
      for (let ci = 0; ci < this.columns.length; ci++) {
        const col = this.columns[ci];
        if (col.hidden) continue;
        this.renderCell(ctx, col, r, st, cid, isSelected, isHovered, col.x, rowY, col.width, rowH, colors, k);
      }
    }

    // 4. Fixed Header (Rendered on top at screen y = 0)
    this.renderHeader(ctx, w, headerH, colors);

    ctx.restore();
  }

  // ----------------- CELL RENDERING -----------------
  renderCell(ctx, col, r, st, cid, isSelected, isHovered, x, y, w, h, colors, rowDisplayIndex) {
    const centerY = y + Math.floor(h / 2);

    switch (col.id) {
      case 'index': {
        // Sequential Row Number (1, 2, 3...)
        ctx.save();
        ctx.font = '600 12px "Plus Jakarta Sans", monospace';
        ctx.fillStyle = colors.textDim;
        ctx.textAlign = 'center';
        const num = (rowDisplayIndex !== undefined ? rowDisplayIndex + 1 : 1);
        ctx.fillText(String(num), x + (w / 2), centerY + 4);
        ctx.restore();
        break;
      }

      case 'select': {
        // Checkbox (Super admin only)
        if (this.isOwner) {
          const chkSize = 16;
          const chkX = x + Math.floor((w - chkSize) / 2);
          const chkY = y + Math.floor((h - chkSize) / 2);

          ctx.save();
          if (isSelected) {
            ctx.fillStyle = colors.primary;
            this.fillRoundRect(ctx, chkX, chkY, chkSize, chkSize, 4);
            ctx.strokeStyle = colors.onPrimary;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(chkX + 3.5, chkY + 8);
            ctx.lineTo(chkX + 6.5, chkY + 11.5);
            ctx.lineTo(chkX + 12.5, chkY + 4.5);
            ctx.stroke();
          } else {
            ctx.strokeStyle = colors.borderSubtle;
            ctx.lineWidth = 1.5;
            this.strokeRoundRect(ctx, chkX, chkY, chkSize, chkSize, 4);
          }
          ctx.restore();
        }
        break;
      }

      case 'name': {
        // Name & Business (Arabic RTL, bold)
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.font = '700 13px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMain;
        const nameText = r[3] || 'بدون اسم';
        this.renderTruncatedText(ctx, nameText, x + w - 12, centerY + 4.5, w - 24);
        ctx.restore();
        break;
      }

      case 'opportunity': {
        // Line 1: suggested service + ERP grade badge. Line 2: opening line.
        const service = r[LX.SERVICE] || '';
        const grade = r[LX.ERP_GRADE] || '';
        const reason = r[13] || '';
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        if (!service && !reason) {
          ctx.font = '500 12px "Cairo", sans-serif';
          ctx.fillStyle = colors.textDim;
          ctx.fillText('—', x + w - 12, centerY + 4);
          ctx.restore();
          break;
        }

        let textMaxW = w - 24;
        if (grade) {
          const badgeW = 46;
          const badgeH = 18;
          const badgeX = x + 10;
          const badgeY = y + 7;
          const badge = erpBadgeStyle(grade, colors);
          if (badge.fill) {
            ctx.fillStyle = badge.fill;
            this.fillRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, 5);
          } else {
            ctx.strokeStyle = badge.stroke;
            ctx.lineWidth = 1;
            this.strokeRoundRect(ctx, badgeX + 0.5, badgeY + 0.5, badgeW - 1, badgeH - 1, 5);
          }
          ctx.font = '700 10.5px "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = badge.text;
          ctx.textAlign = 'center';
          ctx.direction = 'ltr';
          ctx.fillText('ERP ' + grade, badgeX + badgeW / 2, badgeY + 13);
          ctx.direction = 'rtl';
          ctx.textAlign = 'right';
          textMaxW -= badgeW + 8;
        }

        ctx.font = '700 12px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMain;
        this.renderTruncatedText(ctx, service || 'فرصة', x + w - 12, y + 20, textMaxW);

        ctx.font = '500 11px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMuted;
        this.renderTruncatedText(ctx, reason, x + w - 12, y + 37, w - 24);
        ctx.restore();
        break;
      }

      case 'category': {
        // Category / Specialty
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.font = '500 12px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMuted;
        const catText = r[4] || '—';
        this.renderTruncatedText(ctx, catText, x + w - 12, centerY + 4, w - 24);
        ctx.restore();
        break;
      }

      case 'city': {
        // City / Region
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.font = '500 12.5px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMain;
        const cityText = r[5] || '—';
        this.renderTruncatedText(ctx, cityText, x + w - 12, centerY + 4, w - 24);
        ctx.restore();
        break;
      }

      case 'phone': {
        // Phone number (LTR)
        ctx.save();
        ctx.direction = 'ltr';
        ctx.textAlign = 'left';
        ctx.font = '600 12px "Plus Jakarta Sans", monospace';
        ctx.fillStyle = colors.textMuted;
        const rawP = (r[6] || '').trim();
        const phoneText = rawP.length > 5 ? rawP.substring(0, 3) + '••••' + rawP.slice(-2) : (rawP ? '••••••••' : '—');
        this.renderTruncatedText(ctx, phoneText, x + 12, centerY + 4, w - 24);
        ctx.restore();
        break;
      }

      case 'website': {
        // Website Badge (يوجد موقع / بدون موقع)
        const hasWeb = r[12] && r[8];
        const isActionHovered = isHovered && (this.hoveredAction === 'web');
        const pillW = 116;
        const pillH = 26;
        const pillX = x + Math.floor((w - pillW) / 2);
        const pillY = y + Math.floor((h - pillH) / 2);

        ctx.save();
        if (hasWeb) {
          ctx.fillStyle = isActionHovered ? colors.glow : colors.soft;
          this.fillRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.strokeStyle = colors.borderStrong;
          ctx.lineWidth = 1;
          this.strokeRoundRect(ctx, pillX, pillY, pillW, pillH, 6);

          ctx.font = '700 11.5px "Cairo", sans-serif';
          ctx.fillStyle = colors.textMain;
          ctx.textAlign = 'center';
          ctx.fillText('يوجد موقع', pillX + (pillW / 2), pillY + 17.5);
        } else {
          ctx.strokeStyle = colors.borderStrong;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          this.strokeRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.setLineDash([]);

          ctx.font = '500 11px "Cairo", sans-serif';
          ctx.fillStyle = colors.textDim;
          ctx.textAlign = 'center';
          ctx.fillText('بدون موقع', pillX + (pillW / 2), pillY + 17.5);
        }
        ctx.restore();
        break;
      }

      case 'contacts': {
        // Location & Quick Contacts: Maps, WhatsApp, Instagram
        const btnSize = 28;
        const gap = 6;
        const startX = x + Math.floor((w - (btnSize * 3 + gap * 2)) / 2);
        const btnY = y + Math.floor((h - btnSize) / 2);

        // 1. Google Maps
        const isMapsHover = isHovered && (this.hoveredAction === 'maps');
        ctx.save();
        ctx.fillStyle = isMapsHover ? colors.glow : colors.soft;
        this.fillRoundRect(ctx, startX, btnY, btnSize, btnSize, 6);
        ctx.strokeStyle = colors.borderStrong;
        ctx.lineWidth = 1;
        this.strokeRoundRect(ctx, startX, btnY, btnSize, btnSize, 6);
        ctx.font = '700 9.5px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMain;
        ctx.textAlign = 'center';
        ctx.fillText('خرائط', startX + (btnSize / 2), btnY + 18);
        ctx.restore();

        // 2. WhatsApp
        const waX = startX + btnSize + gap;
        const isWaHover = isHovered && (this.hoveredAction === 'wa');
        ctx.save();
        ctx.fillStyle = isWaHover ? colors.glow : colors.soft;
        this.fillRoundRect(ctx, waX, btnY, btnSize, btnSize, 6);
        ctx.strokeStyle = colors.borderStrong;
        ctx.lineWidth = 1;
        this.strokeRoundRect(ctx, waX, btnY, btnSize, btnSize, 6);
        ctx.font = '700 9.5px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMain;
        ctx.textAlign = 'center';
        ctx.fillText('واتس', waX + (btnSize / 2), btnY + 18);
        ctx.restore();

        // 3. Instagram (outline only when the lead has none)
        const igX = waX + btnSize + gap;
        const isIgHover = isHovered && (this.hoveredAction === 'ig');
        const hasIg = !!r[9];
        ctx.save();
        if (hasIg) {
          ctx.fillStyle = isIgHover ? colors.glow : colors.soft;
          this.fillRoundRect(ctx, igX, btnY, btnSize, btnSize, 6);
        }
        ctx.strokeStyle = hasIg ? colors.borderStrong : colors.borderSubtle;
        ctx.lineWidth = 1;
        this.strokeRoundRect(ctx, igX, btnY, btnSize, btnSize, 6);
        ctx.font = '700 9.5px "Cairo", sans-serif';
        ctx.fillStyle = hasIg ? colors.textMain : colors.textDim;
        ctx.textAlign = 'center';
        ctx.fillText('انستا', igX + (btnSize / 2), btnY + 18);
        ctx.restore();
        break;
      }

      case 'notes': {
        // Sales Notes Chip (text + imgbb images count, supports string[] and [{url,caption}])
        const _imgs = st.noteImages ?? st.note_images ?? st.images ?? [];
        const _imgCount = Array.isArray(_imgs)
          ? _imgs.filter(v => typeof v === 'string' ? !!v.trim() : !!(v && (v.url || '').trim())).length
          : 0;
        const hasNote = !!(st.notes || _imgCount);
        const isNoteHover = isHovered && (this.hoveredAction === 'note');
        const pillW = 160;
        const pillH = 26;
        const pillX = x + Math.floor((w - pillW) / 2);
        const pillY = y + Math.floor((h - pillH) / 2);

        ctx.save();
        if (hasNote) {
          ctx.fillStyle = isNoteHover ? colors.glow : colors.soft;
          this.fillRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.strokeStyle = colors.borderStrong;
          ctx.lineWidth = 1;
          this.strokeRoundRect(ctx, pillX, pillY, pillW, pillH, 6);

          ctx.font = '600 11.5px "Cairo", sans-serif';
          ctx.fillStyle = colors.textMain;
          ctx.direction = 'rtl';
          ctx.textAlign = 'right';
          const noteSnippet = (st.notes || '') + (_imgCount ? `${st.notes ? ' ' : ''}📷${_imgCount}` : '') || `📷${_imgCount}`;
          this.renderTruncatedText(ctx, noteSnippet, pillX + pillW - 8, pillY + 17, pillW - 16);
        } else {
          if (isNoteHover) {
            ctx.fillStyle = colors.soft;
            this.fillRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          }
          ctx.strokeStyle = isNoteHover ? colors.textMuted : colors.borderSubtle;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 2]);
          this.strokeRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.setLineDash([]);

          ctx.font = '500 11.5px "Cairo", sans-serif';
          ctx.fillStyle = isNoteHover ? colors.textMain : colors.textDim;
          ctx.textAlign = 'center';
          ctx.fillText('+ إضافة ملاحظة', pillX + (pillW / 2), pillY + 17);
        }
        ctx.restore();
        break;
      }

      case 'sheet': {
        // Sheet source
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.font = '500 11.5px "Cairo", sans-serif';
        ctx.fillStyle = colors.textDim;
        const sheetText = r[1] || '—';
        this.renderTruncatedText(ctx, sheetText, x + w - 12, centerY + 4, w - 24);
        ctx.restore();
        break;
      }

      case 'duplicate': {
        // Duplicate flag
        const isDup = !!r[14] || (r.first !== undefined && !r.first);
        ctx.save();
        ctx.font = '700 11px "Cairo", sans-serif';
        ctx.textAlign = 'center';
        if (isDup) {
          ctx.fillStyle = colors.textMain;
          ctx.fillText('مكرر', x + (w / 2), centerY + 4);
        } else {
          ctx.fillStyle = colors.textDim;
          ctx.fillText('فريد', x + (w / 2), centerY + 4);
        }
        ctx.restore();
        break;
      }

      case 'stages': {
        // Three stage toggle chips: اتبعت | رد | معانا
        const chipW = 68;
        const chipH = 26;
        const gap = 5;
        const startX = x + Math.floor((w - (chipW * 3 + gap * 2)) / 2);
        const chipY = y + Math.floor((h - chipH) / 2);

        // 1. Sent (اتبعت)
        const isSentOn = !!st.s;
        const isSentHover = isHovered && (this.hoveredAction === 's');
        ctx.save();
        ctx.fillStyle = isSentHover ? colors.soft : 'transparent';
        this.fillRoundRect(ctx, startX, chipY, chipW, chipH, 5);
        ctx.strokeStyle = isSentOn ? colors.textMuted : colors.borderSubtle;
        ctx.lineWidth = 1;
        this.strokeRoundRect(ctx, startX, chipY, chipW, chipH, 5);
        ctx.font = '600 11px "Cairo", sans-serif';
        ctx.fillStyle = isSentOn ? colors.textMain : colors.textMuted;
        ctx.textAlign = 'center';
        ctx.fillText('اتبعت', startX + (chipW / 2), chipY + 17);
        ctx.restore();

        // 2. Replied (رد)
        const rX = startX + chipW + gap;
        const isRepOn = !!st.r;
        const isRepHover = isHovered && (this.hoveredAction === 'r');
        ctx.save();
        ctx.fillStyle = isRepOn ? colors.glow : (isRepHover ? colors.soft : 'transparent');
        this.fillRoundRect(ctx, rX, chipY, chipW, chipH, 5);
        ctx.strokeStyle = isRepOn ? colors.borderStrong : colors.borderSubtle;
        ctx.lineWidth = 1;
        this.strokeRoundRect(ctx, rX, chipY, chipW, chipH, 5);
        ctx.font = '600 11px "Cairo", sans-serif';
        ctx.fillStyle = isRepOn ? colors.textMain : colors.textMuted;
        ctx.textAlign = 'center';
        ctx.fillText('رد', rX + (chipW / 2), chipY + 17);
        ctx.restore();

        // 3. Joined (معانا)
        const jX = rX + chipW + gap;
        const isJoinedOn = !!st.j;
        const isJoinedHover = isHovered && (this.hoveredAction === 'j');
        ctx.save();
        ctx.fillStyle = isJoinedOn ? colors.primary : (isJoinedHover ? colors.soft : 'transparent');
        this.fillRoundRect(ctx, jX, chipY, chipW, chipH, 5);
        ctx.strokeStyle = isJoinedOn ? colors.primary : colors.borderSubtle;
        ctx.lineWidth = 1;
        this.strokeRoundRect(ctx, jX, chipY, chipW, chipH, 5);
        ctx.font = '700 11px "Cairo", sans-serif';
        ctx.fillStyle = isJoinedOn ? colors.onPrimary : colors.textMuted;
        ctx.textAlign = 'center';
        ctx.fillText('معانا', jX + (chipW / 2), chipY + 17);
        ctx.restore();
        break;
      }

      case 'updated': {
        // Last update action and time
        const lastAction = st.j ? ['jBy', 'jAt'] : st.r ? ['rBy', 'rAt'] : st.s ? ['sBy', 'sAt'] : null;
        let updateText = '—';
        if (lastAction && st[lastAction[0]]) {
          const who = st[lastAction[0]] === 'admin' ? 'الأدمن' : st[lastAction[0]];
          const when = st[lastAction[1]] ? new Date(st[lastAction[1]]).toLocaleDateString('ar-EG', { month: 'numeric', day: 'numeric' }) : '';
          updateText = `${who} · ${when}`;
        }
        ctx.save();
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.font = '500 11px "Cairo", sans-serif';
        ctx.fillStyle = colors.textDim;
        this.renderTruncatedText(ctx, updateText, x + w - 12, centerY + 4, w - 24);
        ctx.restore();
        break;
      }

      case 'assignee': {
        // Assigned agent
        const assignedTo = this.assignments.get(cid);
        const isAssignHover = isHovered && (this.hoveredAction === 'assign');
        const pillW = 105;
        const pillH = 26;
        const pillX = x + Math.floor((w - pillW) / 2);
        const pillY = y + Math.floor((h - pillH) / 2);

        ctx.save();
        if (assignedTo) {
          ctx.fillStyle = isAssignHover ? colors.glow : colors.soft;
          this.fillRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.font = '700 11px "Cairo", sans-serif';
          ctx.fillStyle = colors.textMain;
          ctx.textAlign = 'center';
          ctx.fillText(assignedTo, pillX + (pillW / 2), pillY + 17);
        } else {
          ctx.fillStyle = isAssignHover ? colors.soft : 'transparent';
          this.fillRoundRect(ctx, pillX, pillY, pillW, pillH, 6);
          ctx.font = '500 11px "Cairo", sans-serif';
          ctx.fillStyle = colors.textDim;
          ctx.textAlign = 'center';
          ctx.fillText('+ تعيين', pillX + (pillW / 2), pillY + 17);
        }
        ctx.restore();
        break;
      }
    }
  }

  // ----------------- FIXED HEADER RENDERING -----------------
  renderHeader(ctx, w, headerH, colors) {
    ctx.save();

    // Header background with subtle gradient
    ctx.fillStyle = colors.bgHeader;
    ctx.fillRect(0, 0, w, headerH);

    // Header bottom border
    ctx.fillStyle = colors.borderSubtle;
    ctx.fillRect(0, headerH - 1, w, 1);

    for (let ci = 0; ci < this.columns.length; ci++) {
      const col = this.columns[ci];
      if (col.hidden) continue;
      const colX = col.x;
      const colW = col.width;

      // Column divider (left border in RTL)
      ctx.fillStyle = colors.borderSubtle;
      ctx.fillRect(colX, 0, 1, headerH);

      if (col.id === 'select') {
        // Master Select All Checkbox
        if (this.isOwner) {
          const chkSize = 16;
          const chkX = colX + Math.floor((colW - chkSize) / 2);
          const chkY = Math.floor((headerH - chkSize) / 2);

          const isAllSelected = this.rows.length > 0 && this.rows.every(idx => this.selectedCids.has(this.allLeads[idx]?.[0]));
          const isSomeSelected = !isAllSelected && this.rows.some(idx => this.selectedCids.has(this.allLeads[idx]?.[0]));

          ctx.save();
          if (isAllSelected) {
            ctx.fillStyle = colors.primary;
            this.fillRoundRect(ctx, chkX, chkY, chkSize, chkSize, 4);
            ctx.strokeStyle = colors.onPrimary;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(chkX + 3.5, chkY + 8);
            ctx.lineTo(chkX + 6.5, chkY + 11.5);
            ctx.lineTo(chkX + 12.5, chkY + 4.5);
            ctx.stroke();
          } else if (isSomeSelected) {
            ctx.fillStyle = colors.primary;
            this.fillRoundRect(ctx, chkX, chkY, chkSize, chkSize, 4);
            ctx.strokeStyle = colors.onPrimary;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(chkX + 4, chkY + 8);
            ctx.lineTo(chkX + 12, chkY + 8);
            ctx.stroke();
          } else {
            ctx.strokeStyle = colors.borderSubtle;
            ctx.lineWidth = 1.5;
            this.strokeRoundRect(ctx, chkX, chkY, chkSize, chkSize, 4);
          }
          ctx.restore();
        }
      } else {
        // Column Header Title
        ctx.save();
        ctx.font = '700 12px "Cairo", sans-serif';
        ctx.fillStyle = colors.textMain;

        if (col.align === 'center') {
          ctx.textAlign = 'center';
          ctx.fillText(col.title, colX + (colW / 2), Math.floor(headerH / 2) + 4.5);
        } else if (col.align === 'ltr') {
          ctx.direction = 'ltr';
          ctx.textAlign = 'left';
          ctx.fillText(col.title, colX + 12, Math.floor(headerH / 2) + 4.5);
        } else {
          ctx.direction = 'rtl';
          ctx.textAlign = 'right';
          ctx.fillText(col.title, colX + colW - 12, Math.floor(headerH / 2) + 4.5);
        }

        // Sorting arrow if active
        if (this.sortCol === col.id) {
          ctx.fillStyle = colors.primary;
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(this.sortAsc ? ' ▲' : ' ▼', colX + 10, Math.floor(headerH / 2) + 4);
        }

        ctx.restore();
      }
    }

    ctx.restore();
  }

  // ----------------- WATERMARK (ANTI-SCREENSHOT) -----------------
  drawWatermark(ctx, w, h) {
    ctx.save();
    ctx.rotate(-22 * Math.PI / 180);
    ctx.font = '600 12.5px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = this.isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.035)';
    ctx.textAlign = 'center';

    const user = this.currentUsername || 'Dashboard';
    const date = new Date().toLocaleDateString('en-GB');
    const text = `CONFIDENTIAL • ${user} • ${date}`;

    const stepX = 280;
    const stepY = 130;

    for (let x = -w; x < w * 2; x += stepX) {
      for (let y = -h; y < h * 2; y += stepY) {
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();
  }

  // ----------------- MATHEMATICAL HIT TESTING -----------------
  hitTest(clientX, clientY) {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    if (canvasX < 0 || canvasX > rect.width || canvasY < 0 || canvasY > rect.height) {
      return null;
    }

    // 1. Is it on the Header?
    if (canvasY <= this.headerHeight) {
      for (let ci = 0; ci < this.columns.length; ci++) {
        const col = this.columns[ci];
        if (col.hidden) continue;
        if (canvasX >= col.x && canvasX < col.x + col.width) {
          return {
            isHeader: true,
            colIndex: ci,
            col: col,
            isSelectAll: (col.id === 'select')
          };
        }
      }
      return { isHeader: true };
    }

    // 2. Is it on Body Rows?
    const bodyY = canvasY - this.headerHeight + this.scrollTop;
    const rowIdx = Math.floor(bodyY / this.rowHeight);

    if (rowIdx < 0 || rowIdx >= this.rows.length) {
      return null;
    }

    const masterRowIdx = this.rows[rowIdx];
    const r = this.allLeads[masterRowIdx];
    if (!r) return null;

    const cid = r[0];

    let targetCol = null;
    let targetColIndex = -1;
    let xInCol = 0;

    for (let ci = 0; ci < this.columns.length; ci++) {
      const col = this.columns[ci];
      if (col.hidden) continue;
      if (canvasX >= col.x && canvasX < col.x + col.width) {
        targetCol = col;
        targetColIndex = ci;
        xInCol = canvasX - col.x;
        break;
      }
    }

    if (!targetCol) return null;

    // Detect sub-actions inside the cell
    let action = null;
    const cellH = this.rowHeight;
    const yInCell = (bodyY % cellH);

    switch (targetCol.id) {
      case 'select':
        action = 'chk';
        break;
      case 'website':
        if (r[12] && r[8]) action = 'web';
        break;
      case 'contacts': {
        const btnSize = 28;
        const gap = 6;
        const startX = Math.floor((targetCol.width - (btnSize * 3 + gap * 2)) / 2);
        if (xInCol >= startX && xInCol <= startX + btnSize) {
          action = 'maps';
        } else if (xInCol >= startX + btnSize + gap && xInCol <= startX + btnSize * 2 + gap) {
          action = 'wa';
        } else if (xInCol >= startX + (btnSize + gap) * 2 && xInCol <= startX + btnSize * 3 + gap * 2) {
          if (r[9]) action = 'ig';
        }
        break;
      }
      case 'notes':
      case 'opportunity':
        action = 'note';
        break;
      case 'stages': {
        const chipW = 68;
        const gap = 5;
        const startX = Math.floor((targetCol.width - (chipW * 3 + gap * 2)) / 2);
        if (xInCol >= startX && xInCol <= startX + chipW) {
          action = 's';
        } else if (xInCol >= startX + chipW + gap && xInCol <= startX + chipW * 2 + gap) {
          action = 'r';
        } else if (xInCol >= startX + (chipW + gap) * 2 && xInCol <= startX + chipW * 3 + gap * 2) {
          action = 'j';
        }
        break;
      }
      case 'assignee':
        if (this.isOwner) action = 'assign';
        break;
    }

    return {
      isHeader: false,
      rowIdx,
      masterRowIdx,
      r,
      cid,
      colIndex: targetColIndex,
      col: targetCol,
      action
    };
  }

  handleMouseMove(e) {
    const hit = this.hitTest(e.clientX, e.clientY);

    let needsRedraw = false;
    let nextCursor = 'default';

    if (!hit) {
      if (this.hoveredRowIdx !== -1 || this.hoveredAction !== null) {
        this.hoveredRowIdx = -1;
        this.hoveredColId = null;
        this.hoveredAction = null;
        needsRedraw = true;
      }
      this.canvas.style.cursor = 'default';
      if (needsRedraw) this.scheduleRender();
      return;
    }

    if (hit.isHeader) {
      if (hit.isSelectAll || (hit.col && hit.col.sortable)) {
        nextCursor = 'pointer';
      }
      if (this.hoveredRowIdx !== -1) {
        this.hoveredRowIdx = -1;
        this.hoveredAction = null;
        needsRedraw = true;
      }
    } else {
      if (this.hoveredRowIdx !== hit.rowIdx || this.hoveredAction !== hit.action) {
        this.hoveredRowIdx = hit.rowIdx;
        this.hoveredColId = hit.col.id;
        this.hoveredAction = hit.action;
        needsRedraw = true;
      }

      if (hit.action || hit.col.id === 'select' || hit.col.id === 'name') {
        nextCursor = 'pointer';
      }
    }

    this.canvas.style.cursor = nextCursor;
    if (needsRedraw) {
      this.scheduleRender();
    }
  }

  handleMouseLeave() {
    if (this.hoveredRowIdx !== -1 || this.hoveredAction !== null) {
      this.hoveredRowIdx = -1;
      this.hoveredColId = null;
      this.hoveredAction = null;
      this.canvas.style.cursor = 'default';
      this.scheduleRender();
    }
  }

  handleClick(e) {
    const hit = this.hitTest(e.clientX, e.clientY);
    if (!hit) return;

    if (hit.isHeader) {
      if (hit.isSelectAll) {
        const isAllSelected = this.rows.length > 0 && this.rows.every(idx => this.selectedCids.has(this.allLeads[idx]?.[0]));
        this.onSelectAll(!isAllSelected);
      } else if (hit.col && hit.col.sortable) {
        if (this.sortCol === hit.col.id) {
          this.sortAsc = !this.sortAsc;
        } else {
          this.sortCol = hit.col.id;
          this.sortAsc = true;
        }
        this.onSort(this.sortCol, this.sortAsc);
      }
      return;
    }

    const { cid, r, action } = hit;

    switch (action) {
      case 'chk': {
        const nextState = !this.selectedCids.has(cid);
        this.onSelectRow(cid, nextState);
        break;
      }
      case 'web': {
        if (r[8]) {
          const url = r[8].startsWith('http') ? r[8] : 'https://' + r[8];
          this.onOpenWebsite(url);
        }
        break;
      }
      case 'maps': {
        const mapsUrl = r[10] || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((r[3] || '') + ' ' + (r[5] || '')));
        this.onOpenMaps(mapsUrl);
        break;
      }
      case 'wa': {
        if (r[7]) {
          const waUrl = r[7].startsWith('http') ? r[7] : `https://wa.me/${r[7].replace(/[^0-9]/g, '')}`;
          this.onOpenWhatsApp(waUrl);
        }
        break;
      }
      case 'ig': {
        if (r[9]) {
          this.onOpenInstagram(r[9]);
        }
        break;
      }
      case 'note': {
        this.onOpenNotes(cid, r);
        break;
      }
      case 's':
      case 'r':
      case 'j': {
        this.onToggleStage(r, action);
        break;
      }
      case 'assign': {
        this.onOpenAssign(cid, r);
        break;
      }
      default: {
        // Clicking row elsewhere toggles selection if admin
        if (this.isOwner) {
          const nextState = !this.selectedCids.has(cid);
          this.onSelectRow(cid, nextState);
        }
        break;
      }
    }
  }

  // ----------------- CANVAS DRAWING UTILITIES -----------------
  renderTruncatedText(ctx, text, x, y, maxWidth) {
    if (!text) return;
    const str = String(text);
    if (ctx.measureText(str).width <= maxWidth) {
      ctx.fillText(str, x, y);
      return;
    }

    // Binary / linear search for truncation with ellipsis
    let low = 1;
    let high = str.length;
    let best = '';

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const cand = str.slice(0, mid) + '...';
      if (ctx.measureText(cand).width <= maxWidth) {
        best = cand;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    ctx.fillText(best || '...', x, y);
  }

  fillRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  strokeRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.stroke();
  }
}
