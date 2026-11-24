// Логика страницы «Остатки» без DOM: разбор файла остатков и массовые действия.
(function (root) {
  'use strict';

  var MAX_AMOUNT = 100000;

  function norm(value) {
    return String(value == null ? '' : value).replace(/[ \s]+/g, ' ').trim().toLowerCase();
  }

  // Баркод из ячейки: Excel мог сохранить его числом, в т. ч. «2.06E+12» или «2062619127170.0».
  function normBarcode(value) {
    var text = String(value == null ? '' : value).replace(/[ \s]/g, '').trim();
    if (/^\d+([.,]\d+)?e\+\d+$/i.test(text)) {
      var num = Number(text.replace(',', '.'));
      if (Number.isSafeInteger(num)) return String(num);
    }
    if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
    return text;
  }

  function normSize(value) {
    var size = norm(value);
    return size === '0' ? '' : size;
  }

  // Количество: целое 0…100 000; «1 200», «5,0» — допустимо. null — пусто, NaN — ошибка.
  function parseAmount(value) {
    var text = String(value == null ? '' : value).replace(/[ \s]/g, '').replace(',', '.');
    if (text === '') return null;
    if (!/^\d+(\.0+)?$/.test(text)) return NaN;
    var amount = Number(text);
    return Number.isSafeInteger(amount) && amount <= MAX_AMOUNT ? amount : NaN;
  }

  var COLUMN_RULES = {
    barcode: [/баркод/, /штрих-?код/, /barcode/, /^sku$/, /^ean/],
    nmId: [/артикул\s*wb/, /артикул\s*вб/, /^nm\s*id$/, /^nmid$/, /номенклатур/, /^код\s*wb/],
    vendorCode: [/артикул\s*продавца/, /артикул\s*поставщика/, /vendor\s*code/, /^артикул$/],
    size: [/размер/, /^size$/, /techsize/],
    amount: [/нов\S*\s*остат/, /^количество/, /кол-?во/, /^остат/, /amount/, /^qty$/, /^stock$/]
  };

  // Номера колонок по заголовку. Для количества — правило с меньшим номером важнее.
  function detectColumns(header) {
    var columns = {};
    Object.keys(COLUMN_RULES).forEach(function (key) {
      var best = null;
      header.forEach(function (cell, index) {
        var text = norm(cell);
        if (!text) return;
        COLUMN_RULES[key].forEach(function (rule, priority) {
          if (rule.test(text) && (best === null || priority < best.priority)) best = { index: index, priority: priority };
        });
      });
      if (best) columns[key] = best.index;
    });
    // «Артикул WB» не должен считаться артикулом продавца.
    if (columns.vendorCode !== undefined && columns.vendorCode === columns.nmId) delete columns.vendorCode;
    return columns;
  }

  // rows — строки файла; items — позиции склада { chrtId, nmId, vendorCode, size, skus, sku, amount }.
  function matchImport(rows, items) {
    rows = (rows || []).filter(function (row) { return row && row.some(function (v) { return String(v == null ? '' : v).trim() !== ''; }); });
    var result = { matched: [], notFound: [], invalid: [], empty: 0, duplicates: 0, columns: null, headerRow: null };
    if (!rows.length) return result;

    var columns = null, start = 0;
    for (var h = 0; h < Math.min(rows.length, 10); h++) {
      var found = detectColumns(rows[h]);
      if (found.amount !== undefined && (found.barcode !== undefined || found.vendorCode !== undefined || found.nmId !== undefined)) {
        columns = found; start = h + 1; result.headerRow = h + 1; break;
      }
    }
    // Без заголовка: как шаблон WB — баркод в первой колонке, количество во второй.
    if (!columns) {
      if (rows[0].length >= 2 && /^\d{5,}$/.test(normBarcode(rows[0][0]))) columns = { barcode: 0, amount: 1 };
      else {
        result.error = 'Не нашли колонки. Нужны «Баркод» (или «Артикул продавца» и «Размер») и «Количество».';
        return result;
      }
    }
    result.columns = columns;

    var bySku = {}, byNmSize = {}, byVendorSize = {}, vendorSizes = {};
    items.forEach(function (item) {
      (item.skus && item.skus.length ? item.skus : [item.sku]).forEach(function (sku) { if (sku) bySku[normBarcode(sku)] = item; });
      byNmSize[item.nmId + '|' + normSize(item.size)] = item;
      var vendor = norm(item.vendorCode);
      byVendorSize[vendor + '|' + normSize(item.size)] = item;
      (vendorSizes[vendor] = vendorSizes[vendor] || []).push(item);
    });

    var seen = {};
    for (var r = start; r < rows.length; r++) {
      var row = rows[r], line = r + 1;
      var cell = function (key) { return columns[key] === undefined ? '' : row[columns[key]]; };
      var barcode = normBarcode(cell('barcode'));
      var vendor = norm(cell('vendorCode'));
      var nmId = String(cell('nmId') == null ? '' : cell('nmId')).replace(/\D/g, '');
      var size = normSize(cell('size'));
      var label = barcode || [String(cell('vendorCode') || '').trim() || nmId, String(cell('size') || '').trim()].filter(Boolean).join(' · ') || 'строка ' + line;
      var amount = parseAmount(cell('amount'));
      if (amount === null) { result.empty++; continue; }
      if (Number.isNaN(amount)) { result.invalid.push({ line: line, label: label, reason: 'Количество «' + String(cell('amount')).trim() + '» — нужно целое число от 0 до 100 000' }); continue; }

      var item = null;
      if (barcode) item = bySku[barcode] || null;
      if (!item && nmId) item = byNmSize[nmId + '|' + size] || null;
      if (!item && vendor) {
        item = byVendorSize[vendor + '|' + size] || null;
        // Размер не указан, а у товара он один — берём его.
        if (!item && !size && vendorSizes[vendor] && vendorSizes[vendor].length === 1) item = vendorSizes[vendor][0];
      }
      if (!item) { result.notFound.push({ line: line, label: label }); continue; }
      if (seen[item.chrtId] !== undefined) {
        result.duplicates++;
        result.matched[seen[item.chrtId]].amount = amount;
        result.matched[seen[item.chrtId]].line = line;
        continue;
      }
      seen[item.chrtId] = result.matched.length;
      result.matched.push({ chrtId: item.chrtId, amount: amount, line: line });
    }
    return result;
  }

  // Массовое действие над остатком: поставить, прибавить, убавить, обнулить.
  function applyBulk(op, value, current) {
    var n = Number(value) || 0, cur = Number(current) || 0, next;
    if (op === 'set') next = n;
    else if (op === 'add') next = cur + n;
    else if (op === 'sub') next = cur - n;
    else if (op === 'zero') next = 0;
    else next = cur;
    return Math.max(0, Math.min(MAX_AMOUNT, Math.round(next)));
  }

  var api = { matchImport: matchImport, applyBulk: applyBulk, parseAmount: parseAmount, normBarcode: normBarcode, detectColumns: detectColumns, MAX_AMOUNT: MAX_AMOUNT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WbaiStocks = api;
})(typeof window !== 'undefined' ? window : this);
