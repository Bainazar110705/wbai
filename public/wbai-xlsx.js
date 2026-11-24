// Простое чтение и запись Excel (.xlsx) и CSV без сторонних библиотек.
// Чтение: первый лист, значения ячеек (строки и числа). Запись: один лист,
// zip без сжатия. Распаковка — встроенным DecompressionStream браузера.
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8(text) { return new TextEncoder().encode(text); }

  function xmlEscape(value) {
    return String(value).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; })
      // Управляющие символы недопустимы в XML.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  function xmlUnescape(value) {
    return String(value)
      .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCodePoint(parseInt(hex, 16)); })
      .replace(/&#(\d+);/g, function (_, dec) { return String.fromCodePoint(Number(dec)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  // ── Zip ──────────────────────────────────────────────────────
  function zipStore(files) {
    var parts = [], central = [], offset = 0;
    files.forEach(function (file) {
      var name = utf8(file.name), data = file.data, crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      var entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
      entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var centralSize = central.reduce(function (sum, p) { return sum + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return concat(parts.concat(central, [new Uint8Array(end.buffer)]));
  }

  function concat(parts) {
    var size = parts.reduce(function (sum, p) { return sum + p.length; }, 0);
    var out = new Uint8Array(size), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  async function inflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Файлы zip по центральному каталогу: { имя → Uint8Array }.
  async function unzip(buffer, wanted) {
    var bytes = new Uint8Array(buffer), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var endPos = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { endPos = i; break; }
    }
    if (endPos < 0) throw new Error('Файл не похож на Excel (.xlsx)');
    var count = view.getUint16(endPos + 10, true), pos = view.getUint32(endPos + 16, true);
    var files = {}, decoder = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      var method = view.getUint16(pos + 10, true), compSize = view.getUint32(pos + 20, true);
      var nameLen = view.getUint16(pos + 28, true), extraLen = view.getUint16(pos + 30, true), commentLen = view.getUint16(pos + 32, true);
      var localPos = view.getUint32(pos + 42, true);
      var name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;
      if (wanted && !wanted(name)) continue;
      var dataStart = localPos + 30 + view.getUint16(localPos + 26, true) + view.getUint16(localPos + 28, true);
      var data = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) files[name] = data;
      else if (method === 8) files[name] = await inflateRaw(data);
    }
    return files;
  }

  // ── Чтение ───────────────────────────────────────────────────
  function columnIndex(ref) {
    var letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase(), index = 0;
    for (var i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
    return index - 1;
  }

  function textOf(xml) {
    var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g, m;
    while ((m = re.exec(xml))) out += m[1] ? xmlUnescape(m[1]) : '';
    return out;
  }

  function parseSheet(xml, shared) {
    var rows = [], rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g, rowMatch;
    while ((rowMatch = rowRe.exec(xml))) {
      var row = [], cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cellMatch, auto = 0;
      while ((cellMatch = cellRe.exec(rowMatch[1]))) {
        var attrs = cellMatch[1], body = cellMatch[2] || '';
        var ref = (attrs.match(/\br="([A-Z]+)\d*"/i) || [])[1];
        var col = ref ? columnIndex(ref) : auto;
        auto = col + 1;
        var type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
        var raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        var value = '';
        if (type === 's') value = shared[Number(raw)] || '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'str' || type === 'e') value = raw !== undefined ? xmlUnescape(raw) : '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw !== undefined) value = xmlUnescape(raw);
        row[col] = value;
      }
      for (var i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
      rows.push(row);
    }
    return rows;
  }

  async function readXlsx(buffer) {
    var files = await unzip(buffer, function (name) {
      return name === 'xl/sharedStrings.xml' || name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    });
    var decoder = new TextDecoder();
    var shared = [];
    if (files['xl/sharedStrings.xml']) {
      var sst = decoder.decode(files['xl/sharedStrings.xml']), siRe = /<si>([\s\S]*?)<\/si>/g, si;
      while ((si = siRe.exec(sst))) shared.push(textOf(si[1]));
    }
    // Первый лист книги по порядку, а не по имени файла.
    var sheetPath = null;
    if (files['xl/workbook.xml'] && files['xl/_rels/workbook.xml.rels']) {
      var wb = decoder.decode(files['xl/workbook.xml']);
      var rid = (wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || [])[1];
      var rels = decoder.decode(files['xl/_rels/workbook.xml.rels']);
      var relRe = /<Relationship\b([^>]*)\/?>/g, rel;
      while (rid && (rel = relRe.exec(rels))) {
        if ((rel[1].match(/\bId="([^"]+)"/) || [])[1] === rid) {
          var target = (rel[1].match(/\bTarget="([^"]+)"/) || [])[1] || '';
          sheetPath = target.replace(/^\/?(xl\/)?/, 'xl/');
        }
      }
    }
    if (!sheetPath || !files[sheetPath]) sheetPath = Object.keys(files).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); }).sort()[0];
    if (!sheetPath) throw new Error('В файле нет листа с данными');
    return parseSheet(decoder.decode(files[sheetPath]), shared);
  }

  function readCsv(text) {
    text = String(text).replace(/^﻿/, '');
    var firstLine = text.split(/\r?\n/, 1)[0] || '';
    var counts = { ';': (firstLine.match(/;/g) || []).length, ',': (firstLine.match(/,/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
    var sep = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    if (!counts[sep]) sep = ';';
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
  }

  // Файл (File/Blob с именем) → массив строк.
  async function readTable(file) {
    var name = String(file.name || '').toLowerCase();
    if (/\.xlsx$/.test(name)) return readXlsx(await file.arrayBuffer());
    if (/\.xls$/.test(name)) throw new Error('Старый формат .xls не поддерживается — сохраните файл как .xlsx или .csv');
    return readCsv(await file.text());
  }

  // ── Запись ───────────────────────────────────────────────────
  function colName(index) {
    var name = '';
    for (index += 1; index > 0; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + ((index - 1) % 26)) + name;
    return name;
  }

  // rows — массив строк; числа пишутся числами, остальное — текстом
  // (баркоды — текстом, чтобы Excel не превращал их в 2,06E+12).
  function writeXlsx(rows, options) {
    options = options || {};
    var widths = options.widths || [];
    var sheetRows = rows.map(function (row, r) {
      return '<row r="' + (r + 1) + '">' + row.map(function (value, c) {
        var ref = colName(c) + (r + 1);
        var style = r === 0 && options.header !== false ? ' s="1"' : '';
        if (typeof value === 'number' && isFinite(value)) return '<c r="' + ref + '"' + style + '><v>' + value + '</v></c>';
        if (value === null || value === undefined || value === '') return '';
        return '<c r="' + ref + '" t="inlineStr"' + style + '><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>';
      }).join('') + '</row>';
    }).join('');
    var cols = widths.length ? '<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>' : '';
    var freeze = options.header !== false ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    var sheetName = xmlEscape(String(options.sheetName || 'Лист1').slice(0, 31));
    var files = [
      { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + freeze + cols + '<sheetData>' + sheetRows + '</sheetData></worksheet>' }
    ];
    return zipStore(files.map(function (f) { return { name: f.name, data: utf8(f.text) }; }));
  }

  var api = { readTable: readTable, readXlsx: readXlsx, readCsv: readCsv, writeXlsx: writeXlsx, crc32: crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WbaiXlsx = api;
})(typeof window !== 'undefined' ? window : this);
