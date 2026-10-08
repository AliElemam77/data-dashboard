const fs = require('fs');
let code = fs.readFileSync('src/app.js', 'utf8');

// Add COLUMN_MAPPINGS before handleExcelFileSelect
const mappingDef = `// ----------------- CONFIGURABLE EXCEL / CSV IMPORT ENGINE -----------------
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
`;

code = code.replace('// ----------------- EXCEL / CSV IMPORT ENGINE -----------------', mappingDef);

// Replace item mapping inside handleExcelFileSelect
const sLoop = code.indexOf('json.forEach(item => {');
const eLoop = code.indexOf('parsedImportRows.push(row);\n      });');

if (sLoop !== -1 && eLoop !== -1) {
  const newLoop = `json.forEach(item => {
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
      });`;
  code = code.slice(0, sLoop) + newLoop + code.slice(eLoop + 'parsedImportRows.push(row);\n      });'.length);
}

// Remove localStorage of customer data
const sStorage = code.indexOf('// Save to local cache');
const eStorage = code.indexOf('markFirstOccurrences();\n  $(\'modal-excel-import\')');
if (sStorage !== -1 && eStorage !== -1) {
  code = code.slice(0, sStorage) + '// Security: Customer data kept purely in JS memory, NEVER stored unencrypted\n  ' + code.slice(eStorage);
}

// Replace old scroll listener with resize listener
const sScroll = code.indexOf('// Virtual Table Scroll');
const eScroll = code.indexOf('// Floating Selection Dock Buttons');
if (sScroll !== -1 && eScroll !== -1) {
  const newScroll = `// Canvas Table Window Resize Listener
  window.addEventListener('resize', () => {
    if (state.canvasTable) state.canvasTable.handleResize();
  });\n\n  `;
  code = code.slice(0, sScroll) + newScroll + code.slice(eScroll);
}

// Ensure select-all-leads is safe
code = code.replace(
  "  $('select-all-leads').onchange = (e) => {\n    handleSelectAllToggle(e.target.checked);\n  };",
  "  if ($('select-all-leads')) {\n    $('select-all-leads').onchange = (e) => {\n      handleSelectAllToggle(e.target.checked);\n    };\n  }"
);

fs.writeFileSync('src/app.js', code, 'utf8');
console.log('Update app.js executed successfully!');
