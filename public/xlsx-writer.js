/* =========================================================
   xlsx-writer.js — minimal, dependency-free .xlsx writer.
   Produces a real Office Open XML workbook (ZIP container, "stored"
   entries, inline strings). No third-party code, no CDN. Verified
   with openpyxl in tests/xlsx.test.js.

   XlsxWriter.build({
     sheets: [{
       name: "History",
       columns: [{ header: "Date", width: 20, type: "datetime" | "text" | "number" }, ...],
       rows: [[value, ...], ...],        // datetime values = Excel serial numbers
     }, {
       name: "Info", kv: [["Label", "Value"], ...]   // simple two-column sheet
     }]
   }) -> Uint8Array
   ========================================================= */
(function (root) {
  "use strict";

  /* ---------- CRC-32 ---------- */
  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* ---------- ZIP (stored, no compression) ---------- */
  function zip(files, when) {
    const enc = new TextEncoder();
    const d = when instanceof Date ? when : new Date();
    const dosTime = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    const dosDate = (((Math.max(1980, d.getFullYear()) - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);

    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (v) => [v & 255, (v >>> 8) & 255];
    const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
      ]);
      chunks.push(local, nameBytes, data);
      const cdir = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]);
      central.push(cdir, nameBytes);
      offset += local.length + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(offset), ...u16(0),
    ]);
    const all = [...chunks, ...central, end];
    const total = all.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of all) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  /* ---------- XML helpers ---------- */
  // Remove characters that are illegal in XML 1.0, then escape.
  function xmlText(v) {
    return String(v)
      .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function colLetter(i) {
    let s = "";
    i++;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  // Style indexes (see styles.xml below): 0 default, 1 header, 2 datetime, 3 wrapped text, 4 bold label
  function cellXml(ref, value, type, style) {
    if (value === null || value === undefined || value === "") return `<c r="${ref}" s="${style}"/>`;
    if ((type === "datetime" || type === "number") && typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
    }
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');

    let cols;
    let rowsXml = [];
    if (sheet.kv) {
      cols = [{ width: 26 }, { width: 90 }];
      sheet.kv.forEach((pair, i) => {
        const r = i + 1;
        rowsXml.push(
          `<row r="${r}">${cellXml("A" + r, pair[0], "text", 4)}${cellXml("B" + r, pair[1], "text", 3)}</row>`
        );
      });
      out.push(`<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join("")}</cols>`);
      out.push(`<sheetData>${rowsXml.join("")}</sheetData>`);
    } else {
      cols = sheet.columns;
      out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
      out.push(
        `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join("")}</cols>`
      );
      rowsXml.push(
        `<row r="1">${cols.map((c, i) => cellXml(colLetter(i) + "1", c.header, "text", 1)).join("")}</row>`
      );
      sheet.rows.forEach((row, ri) => {
        const r = ri + 2;
        rowsXml.push(
          `<row r="${r}">${cols
            .map((c, i) => {
              const style = c.type === "datetime" ? 2 : c.type === "number" ? 0 : 3;
              return cellXml(colLetter(i) + r, row[i], c.type, style);
            })
            .join("")}</row>`
        );
      });
      out.push(`<sheetData>${rowsXml.join("")}</sheetData>`);
      const lastRow = sheet.rows.length + 1;
      out.push(`<autoFilter ref="A1:${colLetter(cols.length - 1)}${lastRow}"/>`);
    }
    out.push("</worksheet>");
    return out.join("");
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6EEF3"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function safeSheetName(name, used) {
    let n = String(name || "Sheet").replace(/[\\\/\?\*\[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
    let candidate = n;
    let i = 2;
    while (used.has(candidate.toLowerCase())) candidate = (n.slice(0, 28) + " " + i++).slice(0, 31);
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function build(spec, when) {
    const used = new Set();
    const sheets = spec.sheets.map((s) => Object.assign({}, s, { name: safeSheetName(s.name, used) }));

    const files = [];
    files.push({
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join("") +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    });
    files.push({
      name: "_rels/.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    });
    files.push({
      name: "xl/workbook.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets></workbook>",
    });
    files.push({
      name: "xl/_rels/workbook.xml.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    });
    files.push({ name: "xl/styles.xml", data: STYLES });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));

    return zip(files, when);
  }

  const api = { build, crc32, colLetter };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XlsxWriter = api;
})(typeof self !== "undefined" ? self : globalThis);
