// Lead row layout shared by the encrypted dataset builder (scratch/build_data.mjs)
// and the in-app Excel/CSV importer.
// Indices 0-15 are the original layout:
//   0 cid, 1 sheet, 2 seq, 3 name, 4 category, 5 city, 6 phone, 7 whatsapp,
//   8 website, 9 instagram, 10 maps, 11 platform, 12 hasWeb, 13 opening line, 14 dup, 15 ts
// Indices 16+ carry the leads-hub enrichment columns.
export const LX = {
  SECTOR: 16,      // القطاع
  SERVICE: 17,     // الخدمة المقترحة
  ERP_GRADE: 18,   // تصنيف ERP (A-D)
  ERP_SCORE: 19,   // نقاط ERP
  REACH: 20,       // سهولة التواصل (0-100)
  OTHER_OPPS: 21,  // فرص أخرى
  EMAIL: 22,       // البريد
  RATING: 23,      // التقييم
  REVIEWS: 24,     // عدد التقييمات
};
export const ROW_LEN = 25;

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v) => {
  const s = str(v);
  if (!s) return '';
  const n = Number(s);
  return Number.isFinite(n) ? n : '';
};

/** Enrichment fields (indices 16..24) from a leads-hub sheet row keyed by its Arabic headers. */
export function leadExtras(item) {
  return [
    str(item['القطاع']),
    str(item['الخدمة المقترحة']),
    str(item['تصنيف ERP']).toUpperCase(),
    num(item['نقاط ERP']),
    num(item['سهولة التواصل']),
    str(item['فرص أخرى']),
    str(item['البريد']),
    num(item['التقييم']),
    num(item['عدد التقييمات']),
  ];
}
