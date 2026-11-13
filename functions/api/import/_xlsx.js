// Minimal .xlsx writer for the Workers runtime (no library, no bundler).
// An .xlsx is a zip of XML parts; this writes the zip uncompressed ("stored")
// with CRC-32s, inline strings (no sharedStrings part), formulas with cached
// values, merged cells, column widths and a small fixed style table.
//
//   buildXlsx({ sheets: [{ name, cols: [width…], rows: [[cell…]…], merges: ['A1:E1'], fitToPage }] })
//   cell: null | string | number | { v, f, s }   s = a STYLES key
// Returns a Uint8Array.

const enc = new TextEncoder();

// ── Zip (store only) ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);       // version needed
        local.setUint16(6, 0x0800, true);   // UTF-8 names
        local.setUint16(8, 0, true);        // stored
        local.setUint16(10, 0, true);       // time
        local.setUint16(12, 0x21, true);    // date 1980-01-01
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        parts.push(new Uint8Array(local.buffer), name, data);

        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true);
        cd.setUint16(4, 20, true);
        cd.setUint16(6, 20, true);
        cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, 0, true);
        cd.setUint16(12, 0, true);
        cd.setUint16(14, 0x21, true);
        cd.setUint32(16, crc, true);
        cd.setUint32(20, data.length, true);
        cd.setUint32(24, data.length, true);
        cd.setUint16(28, name.length, true);
        cd.setUint32(42, offset, true);
        central.push(new Uint8Array(cd.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of all) { out.set(p, o); o += p.length; }
    return out;
}

// ── Styles ───────────────────────────────────────────────────────────────
// fonts: 0 Arial 10 · 1 bold · 2 bold 15 · 3 bold 18 · 4 italic · 5 bold 12
// fills: 0 none · 1 gray125 (required) · 2 light grey
// borders: 0 none · 1 thin all round
// numFmts: 164 #,##0 · 165 #,##0" kg"
const XF = [
    // [fontId, fillId, borderId, numFmtId, align]
    ['default',   0, 0, 0, 0,   null],
    ['bold',      1, 0, 0, 0,   null],
    ['title',     2, 0, 0, 0,   'center'],
    ['name',      3, 0, 0, 0,   'center'],
    ['strap',     4, 0, 0, 0,   'center'],
    ['center',    0, 0, 0, 0,   'center'],
    ['subtitle',  5, 0, 0, 0,   'center'],
    ['th',        1, 2, 1, 0,   'center'],
    ['tdCenter',  0, 0, 1, 0,   'center'],
    ['tdKg',      0, 0, 1, 164, 'right'],
    ['label',     1, 2, 1, 0,   'left'],
    ['value',     0, 0, 1, 0,   'left'],
    ['valueKg',   0, 0, 1, 165, 'left'],
    ['valueInt',  0, 0, 1, 1,   'left'],
];
export const STYLES = Object.fromEntries(XF.map((x, i) => [x[0], i]));

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="#,##0&quot; kg&quot;"/></numFmts>
<fonts count="6">
<font><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="15"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="18"/><name val="Arial"/><family val="2"/></font>
<font><i/><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="12"/><name val="Arial"/><family val="2"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${XF.length}">
${XF.map(([, font, fill, border, fmt, align]) => `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${fmt ? ' applyNumberFormat="1"' : ''}${align ? ` applyAlignment="1"><alignment horizontal="${align}" vertical="center"/></xf>` : '/>'}`).join('\n')}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ── Sheets ───────────────────────────────────────────────────────────────
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(i) {
    let s = '', n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

function cellXml(cell, ref) {
    if (cell == null || cell === '') return '';
    const c = typeof cell === 'object' ? cell : { v: cell };
    const s = c.s != null ? ` s="${typeof c.s === 'number' ? c.s : (STYLES[c.s] ?? 0)}"` : '';
    if (c.f) {
        const v = c.v != null && c.v !== '' ? `<v>${xmlEsc(c.v)}</v>` : '';
        return `<c r="${ref}"${s}><f>${xmlEsc(c.f)}</f>${v}</c>`;
    }
    if (c.v == null || c.v === '') return s ? `<c r="${ref}"${s}/>` : '';
    if (typeof c.v === 'number' && Number.isFinite(c.v)) return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
}

function sheetXml(sheet) {
    const cols = (sheet.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = (sheet.rows || []).map((row, ri) => {
        const cells = (row || []).map((cell, ci) => cellXml(cell, colName(ci) + (ri + 1))).join('');
        return cells ? `<row r="${ri + 1}">${cells}</row>` : '';
    }).join('');
    const merges = (sheet.merges || []);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="13.5"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rows}</sheetData>
${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
<printOptions horizontalCentered="1"/>
<pageMargins left="0.6" right="0.6" top="0.55" bottom="0.55" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="1"/>
</worksheet>`;
}

export function buildXlsx({ sheets }) {
    const list = sheets.map((s, i) => ({ ...s, name: String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) }));
    const files = [
        { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>` },
        { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
        { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>` },
        { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
        { name: 'xl/styles.xml', data: STYLES_XML },
        ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
    ];
    return zipStore(files);
}
