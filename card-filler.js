(function() {
  if (window.__wbCardLoaded) return;
  window.__wbCardLoaded = true;

  async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function setVal(el, value) {
    if (!el || !value) return false;
    el.removeAttribute('readonly');
    el.removeAttribute('disabled');
    el.focus();
    el.click();
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(value) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/[()\/]/g, '').replace(/[.,]/g, '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function cleanVal(v) {
    var s = String(v).trim();
    // Сохраняем единицы времени — они важны для выбора правильного варианта в дропдауне
    // НЕ стрипаем: ч (часы), мин (минуты) — чтобы "3 ч" не превращалось в "3"
    if (/^\d[\d\s,.]*\s*(Вт|В|А\/ч|Ач|мАч|мА\*ч|об\/мин|мм|см|кг|г|шт|год|лет|атм|л\/мин|дБ|дб|rpm|Hz|Гц|мл|мкФ|Ом)$/i.test(s)) {
      return s.replace(/\s*(Вт|В|А\/ч|Ач|мАч|мА\*ч|об\/мин|мм|см|кг|г|шт|год|лет|атм|л\/мин|дБ|дб|rpm|Hz|Гц|мл|мкФ|Ом)$/i, '').trim();
    }
    return s;
  }

  function getCategory() {
    try {
      var el = document.querySelector('[class*="subject"], [class*="Subject"]');
      if (el) {
        var parts = (el.innerText || '').trim().split('/').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 2; });
        if (parts.length > 0) return parts[parts.length - 1];
        var lines = (el.innerText || '').trim().split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 2 && s !== '/'; });
        if (lines.length > 0) return lines[lines.length - 1];
      }
    } catch(e) {}
    return '';
  }

  function parseChars(text) {
    var pairs = [];
    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var skipHeaders = ['общие характеристики', 'питание', 'дополнительная информация', 'технические особенности', 'материалы', 'габариты', 'основные'];

    function isValue(s) {
      if (s.length > 80) return true;
      if (/шт/.test(s)) return true;
      if (s.includes('—') && s.includes(';')) return true;
      if (/^\d+([.,]\d+)?$/.test(s.trim())) return true;
      return false;
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (skipHeaders.indexOf(norm(line)) >= 0) { i++; continue; }
      if (line.indexOf(':') >= 0 && line.indexOf(':') < 80) {
        var idx = line.indexOf(':');
        var key = line.slice(0, idx).trim();
        var val = line.slice(idx + 1).trim();
        if (key && val && key.length < 80) { pairs.push([key, val]); i++; continue; }
      }
      if (line.length < 80 && !isValue(line) && i + 1 < lines.length) {
        var next = lines[i + 1];
        if (skipHeaders.indexOf(norm(next)) < 0) { pairs.push([line, next]); i += 2; continue; }
      }
      i++;
    }
    return pairs;
  }

  function getAllFields() {
    var fields = [];
    var seen = new Set();
    document.querySelectorAll('input:not([type="hidden"]):not([id="editable-title"]), textarea:not([id="editable-title"])').forEach(function(inp) {
      if (inp.getAttribute('data-testid') === 'card-form-main-field-title') return;
      if ((inp.id || '').includes('vendorCode')) return;
      if (seen.has(inp)) return;
      seen.add(inp);
      var wrapper = inp.closest('[class*="Field-wrapper__ChpbLLvc2p"]') || inp.closest('[class*="Field-wrapper__"][id]') || inp.closest('[class*="field-wrapper"]') || inp.closest('[class*="FieldWrapper"]');
      var label = wrapper ? (wrapper.getAttribute('id') || '') : '';
      // Fallback: ищем видимый текст лейбла рядом с полем
      if (!label) {
        var labelEl = null;
        var parent = inp.parentElement;
        for (var d = 0; d < 5 && parent; d++) {
          labelEl = parent.querySelector('label, [class*="label"], [class*="Label"]');
          if (labelEl && labelEl !== inp && labelEl.innerText && labelEl.innerText.trim().length > 1) break;
          labelEl = null;
          parent = parent.parentElement;
        }
        if (labelEl) label = labelEl.innerText.trim().split('\n')[0].trim();
      }
      fields.push({ label: label, inputId: inp.id || '', input: inp });
    });
    return fields;
  }

  function matchField(key, fields) {
    var nk = norm(key);
    var isDim = ['длина', 'ширина', 'высота'].some(function(k) { return nk.startsWith(k); }) && !nk.includes('предмет') && !nk.includes('шнур');
    if (isDim) {
      var map = { 'длина': 'dimensions.length', 'ширина': 'dimensions.width', 'высота': 'dimensions.height' };
      for (var k in map) {
        if (nk.startsWith(k)) {
          var f = fields.find(function(f) { return (f.inputId || '').toLowerCase().includes(map[k]); });
          if (f) return f.input;
        }
      }
    }
    if (nk.includes('вес с упак') || nk.includes('вес упак')) {
      var f = fields.find(function(f) { return (f.inputId || '').toLowerCase().includes('weightbrutto'); });
      if (f) return f.input;
    }
    if (nk === 'цена' || nk.startsWith('цена ')) {
      var f = fields.find(function(f) { return (f.inputId || '').toLowerCase().includes('price') || f.label === 'price'; });
      if (f) return f.input;
    }
    for (var i = 0; i < fields.length; i++) {
      if (norm(fields[i].label) === nk) return fields[i].input;
    }
    if (nk.length >= 4) {
      for (var i = 0; i < fields.length; i++) {
        var nl = norm(fields[i].label);
        if (nl && nl.includes(nk)) return fields[i].input;
      }
      for (var i = 0; i < fields.length; i++) {
        var nl = norm(fields[i].label);
        if (nl && nl.length >= 4 && nk.includes(nl)) return fields[i].input;
      }
    }
    return null;
  }

  async function clickDropdown(value) {
    await wait(400);
    var vt = norm(value);
    var allEl = Array.from(document.querySelectorAll('*')).filter(function(el) {
      if (el.children.length > 0) return false;
      var t = (el.innerText || '').trim();
      if (!t || t.length > 200) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    // 1. Точное совпадение в первую очередь (включая единицы: "3 ч", "48 В")
    for (var i = 0; i < allEl.length; i++) {
      if (norm(allEl[i].innerText || '') === vt) { allEl[i].click(); await wait(200); return true; }
    }
    // 2. Числовое значение + единица измерения (без времени — время уже совпало выше)
    var units = ['ма*ч', 'а/ч', 'вт', ' в', 'об/мин', 'мм', 'см', 'кг'];
    var numOnly = vt.replace(/\s*(вт|в|а\/ч|ма\*ч|об\/мин|мм|см|кг|г|шт|год|лет|ч|мин|атм|л\/мин)$/i, '').trim();
    if (numOnly !== vt) {
      for (var u = 0; u < units.length; u++) {
        for (var i = 0; i < allEl.length; i++) {
          var ot = norm(allEl[i].innerText || '');
          if (ot === numOnly + ' ' + units[u] || ot === numOnly + units[u]) { allEl[i].click(); await wait(200); return true; }
        }
      }
      // Число без единиц — последний вариант
      for (var i = 0; i < allEl.length; i++) {
        if (norm(allEl[i].innerText || '') === numOnly) { allEl[i].click(); await wait(200); return true; }
      }
    }
    // 3. Нечёткое совпадение
    for (var i = 0; i < allEl.length; i++) {
      var ot = norm(allEl[i].innerText || '');
      if (ot && ot.length > 2 && (ot.includes(vt) || vt.includes(ot))) { allEl[i].click(); await wait(200); return true; }
    }
    return false;
  }

  function getTemplates() {
    try { return JSON.parse(localStorage.getItem('wb_templates') || '{}'); } catch(e) { return {}; }
  }
  function saveTemplate(name, data) {
    try {
      var t = getTemplates();
      t[name] = Object.assign({}, data, { date: new Date().toLocaleDateString('ru') });
      localStorage.setItem('wb_templates', JSON.stringify(t));
    } catch(e) {}
  }
  function delTemplate(name) {
    try { var t = getTemplates(); delete t[name]; localStorage.setItem('wb_templates', JSON.stringify(t)); } catch(e) {}
  }

  function showToast(msg, ok) {
    var t = document.getElementById('wb-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'wb-toast';
      t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;z-index:999999;font-family:-apple-system,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.15);max-width:500px;text-align:center;transition:opacity 0.3s;';
      document.body.appendChild(t);
    }
    t.style.background = ok ? '#1a2d1a' : '#2a1a1a';
    t.style.border = ok ? '1px solid #4caf50' : '1px solid #c0392b';
    t.style.color = ok ? '#7ed47e' : '#ff8888';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._tm);
    if (!msg.includes('\u2699\ufe0f')) t._tm = setTimeout(function() { t.style.opacity = '0'; }, 7000);
  }

  function showSaveDialog(data) {
    return new Promise(function(resolve) {
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000001;display:flex;align-items:center;justify-content:center;';
      var m = document.createElement('div');
      m.style.cssText = 'background:#fff;border-radius:14px;padding:20px;width:380px;font-family:-apple-system,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.2);';
      m.innerHTML = '<div style="font-size:15px;font-weight:700;color:#1a1a1a;margin-bottom:8px;">\uD83D\uDCBE \u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0448\u0430\u0431\u043b\u043e\u043d?</div>' +
        '<div style="font-size:12px;color:#888;margin-bottom:14px;">\u0421\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0440\u0430\u0437 \u043c\u043e\u0436\u043d\u043e \u0432\u044b\u0431\u0440\u0430\u0442\u044c \u0438\u0437 \u0441\u043f\u0438\u0441\u043a\u0430</div>' +
        '<input id="wb-sname" type="text" placeholder="\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0448\u0430\u0431\u043b\u043e\u043d\u0430" style="width:100%;box-sizing:border-box;border:1px solid #e0d4f7;border-radius:8px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;color:#333;margin-bottom:12px;">' +
        '<div style="display:flex;gap:8px;">' +
        '<button id="wb-sno" style="flex:1;padding:9px;border:1px solid #ddd;border-radius:8px;background:#f5f5f5;color:#555;font-size:13px;font-weight:600;cursor:pointer;">\u041d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u044c</button>' +
        '<button id="wb-syes" style="flex:1.5;padding:9px;border:none;border-radius:8px;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;font-size:13px;font-weight:700;cursor:pointer;">\uD83D\uDCBE \u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c</button>' +
        '</div>';
      ov.appendChild(m);
      document.body.appendChild(ov);
      document.getElementById('wb-sno').onclick = function() { ov.remove(); resolve(null); };
      document.getElementById('wb-syes').onclick = function() {
        var name = document.getElementById('wb-sname').value.trim();
        if (!name) { document.getElementById('wb-sname').style.borderColor = '#ff4444'; return; }
        saveTemplate(name, data);
        ov.remove();
        resolve(name);
      };
    });
  }

  function showModal(productName) {
    return new Promise(function(resolve) {
      var templates = getTemplates();
      var cat = getCategory();
      var tNames = Object.keys(templates).filter(function(n) {
        var t = templates[n];
        if (!t.category || !cat) return true;
        return t.category.toLowerCase() === cat.toLowerCase();
      });

      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000000;display:flex;align-items:center;justify-content:center;';
      var m = document.createElement('div');
      m.style.cssText = 'background:#fff;border-radius:16px;padding:24px;width:560px;max-width:95vw;font-family:-apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.3);max-height:90vh;overflow-y:auto;';

      var tmplHtml = '';
      if (tNames.length > 0) {
        var btns = tNames.map(function(n) {
          var t = templates[n];
          return '<div style="display:inline-flex;align-items:center;gap:3px;margin:3px;">' +
            '<button class="wb-tl" data-n="' + n + '" style="padding:4px 10px;border:1px solid #b3d4ff;border-radius:20px;background:#e8f0ff;color:#1a56db;font-size:11px;font-weight:600;cursor:pointer;">' + n + (t.date ? ' (' + t.date + ')' : '') + '</button>' +
            '<button class="wb-td" data-n="' + n + '" style="padding:2px 5px;border:none;background:none;color:#aaa;font-size:11px;cursor:pointer;">\u2715</button>' +
            '</div>';
        }).join('');
        tmplHtml = '<div style="background:#f0f7ff;border:1px solid #b3d4ff;border-radius:8px;padding:10px 14px;margin-bottom:12px;">' +
          '<div style="font-size:12px;font-weight:600;color:#1a56db;margin-bottom:6px;">\uD83D\uDCBE \u0428\u0430\u0431\u043b\u043e\u043d\u044b' + (cat ? ' \u2014 ' + cat : '') + ':</div>' +
          '<div>' + btns + '</div></div>';
      }

      m.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
          '<div><div style="font-size:16px;font-weight:700;color:#1a1a1a;">\u2728 AI \u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0438</div>' +
          '<div style="font-size:12px;color:#888;margin-top:2px;">\u0422\u043e\u0432\u0430\u0440: <b>' + productName + '</b>' + (cat ? ' \u00b7 ' + cat : '') + '</div></div>' +
          '<button id="wb-cls" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1;">\u00d7</button>' +
        '</div>' +
        tmplHtml +
        '<div style="margin-bottom:12px;">' +
          '<label style="font-size:12px;font-weight:600;color:#555;display:block;margin-bottom:6px;">\u0425\u0410\u0420\u0410\u041a\u0422\u0415\u0420\u0418\u0421\u0422\u0418\u041a\u0418 <span style="color:#888;font-weight:400">(\u043b\u044e\u0431\u043e\u0439 \u0444\u043e\u0440\u043c\u0430\u0442)</span></label>' +
          '<textarea id="wb-chars" rows="8" placeholder="\u0412\u0441\u0442\u0430\u0432\u044c\u0442\u0435 \u0441 \u0441\u0430\u0439\u0442\u0430 WB \u0438\u043b\u0438 \u0432\u0432\u0435\u0434\u0438\u0442\u0435:\n\n\u041c\u043e\u0449\u043d\u043e\u0441\u0442\u044c (\u0412\u0442): 1600\n\u0422\u0438\u043f \u0430\u043a\u043a\u0443\u043c\u0443\u043b\u044f\u0442\u043e\u0440\u0430: Li-Ion\n\u0421\u0442\u0440\u0430\u043d\u0430 \u043f\u0440\u043e\u0438\u0437\u0432\u043e\u0434\u0441\u0442\u0432\u0430: \u041a\u0438\u0442\u0430\u0439" style="width:100%;box-sizing:border-box;border:1px solid #e0d4f7;border-radius:8px;padding:10px;font-size:12px;font-family:-apple-system,sans-serif;resize:vertical;line-height:1.6;outline:none;color:#333;"></textarea>' +
        '</div>' +
        '<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:10px 14px;margin-bottom:12px;">' +
          '<div style="font-size:12px;font-weight:600;color:#f57f17;margin-bottom:8px;">\u26a0\ufe0f \u041e\u0411\u042f\u0417\u0410\u0422\u0415\u041b\u042c\u041d\u041e</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
            '<div><label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">\u0414\u043b\u0438\u043d\u0430 \u0443\u043f\u0430\u043a\u043e\u0432\u043a\u0438 (\u0441\u043c)</label><input id="wb-len" type="number" placeholder="31" style="width:100%;box-sizing:border-box;border:1px solid #ffe082;border-radius:6px;padding:6px 8px;font-size:13px;outline:none;"></div>' +
            '<div><label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">\u0428\u0438\u0440\u0438\u043d\u0430 \u0443\u043f\u0430\u043a\u043e\u0432\u043a\u0438 (\u0441\u043c)</label><input id="wb-wid" type="number" placeholder="27" style="width:100%;box-sizing:border-box;border:1px solid #ffe082;border-radius:6px;padding:6px 8px;font-size:13px;outline:none;"></div>' +
            '<div><label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">\u0412\u044b\u0441\u043e\u0442\u0430 \u0443\u043f\u0430\u043a\u043e\u0432\u043a\u0438 (\u0441\u043c)</label><input id="wb-hei" type="number" placeholder="10" style="width:100%;box-sizing:border-box;border:1px solid #ffe082;border-radius:6px;padding:6px 8px;font-size:13px;outline:none;"></div>' +
            '<div><label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">\u0412\u0435\u0441 \u0441 \u0443\u043f\u0430\u043a\u043e\u0432\u043a\u043e\u0439 (\u043a\u0433)</label><input id="wb-wei" type="number" step="0.1" placeholder="2.1" style="width:100%;box-sizing:border-box;border:1px solid #ffe082;border-radius:6px;padding:6px 8px;font-size:13px;outline:none;"></div>' +
            '<div style="grid-column:1/-1;"><label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">\u0426\u0435\u043d\u0430 (\u20bd)</label><input id="wb-pri" type="number" placeholder="3900" style="width:100%;box-sizing:border-box;border:1px solid #ffe082;border-radius:6px;padding:6px 8px;font-size:13px;outline:none;"></div>' +
          '</div>' +
        '</div>' +
        '<div id="wb-err" style="display:none;background:#fff0f0;border:1px solid #ffcccc;border-radius:8px;padding:8px 12px;color:#cc0000;font-size:12px;margin-bottom:10px;"></div>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="wb-cancel" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;background:#f5f5f5;color:#555;font-size:14px;font-weight:600;cursor:pointer;">\u041e\u0442\u043c\u0435\u043d\u0430</button>' +
          '<button id="wb-ok" style="flex:2;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;font-size:14px;font-weight:700;cursor:pointer;">\uD83D\uDE80 \u0417\u0430\u043f\u043e\u043b\u043d\u0438\u0442\u044c \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443</button>' +
        '</div>';

      ov.appendChild(m);
      document.body.appendChild(ov);

      var fromTmpl = false;

      m.querySelectorAll('.wb-tl').forEach(function(btn) {
        btn.onclick = function() {
          var n = btn.getAttribute('data-n');
          var t = templates[n];
          if (!t) return;
          var charsEl = document.getElementById('wb-chars');
          var lenEl = document.getElementById('wb-len');
          var widEl = document.getElementById('wb-wid');
          var heiEl = document.getElementById('wb-hei');
          var weiEl = document.getElementById('wb-wei');
          var priEl = document.getElementById('wb-pri');
          if (charsEl && t.chars) charsEl.value = t.chars;
          if (lenEl && t.length) lenEl.value = t.length;
          if (widEl && t.width) widEl.value = t.width;
          if (heiEl && t.height) heiEl.value = t.height;
          if (weiEl && t.weight) weiEl.value = t.weight;
          if (priEl && t.price) priEl.value = t.price;
          m.querySelectorAll('.wb-tl').forEach(function(b) { b.style.background = '#e8f0ff'; });
          btn.style.background = '#b3d4ff';
          fromTmpl = true;
        };
      });

      m.querySelectorAll('.wb-td').forEach(function(btn) {
        btn.onclick = function() {
          var n = btn.getAttribute('data-n');
          if (confirm('Удалить шаблон "' + n + '"?')) { delTemplate(n); btn.closest('div').remove(); }
        };
      });

      document.getElementById('wb-cls').onclick = function() { ov.remove(); resolve(null); };
      document.getElementById('wb-cancel').onclick = function() { ov.remove(); resolve(null); };

      document.getElementById('wb-ok').onclick = function() {
        var lenEl = document.getElementById('wb-len');
        var widEl = document.getElementById('wb-wid');
        var heiEl = document.getElementById('wb-hei');
        var weiEl = document.getElementById('wb-wei');
        var priEl = document.getElementById('wb-pri');
        var charsEl = document.getElementById('wb-chars');
        var len = lenEl ? lenEl.value.trim() : '';
        var wid = widEl ? widEl.value.trim() : '';
        var hei = heiEl ? heiEl.value.trim() : '';
        var wei = weiEl ? weiEl.value.trim() : '';
        var pri = priEl ? priEl.value.trim() : '';
        if (!len || !wid || !hei || !wei || !pri) {
          var e = document.getElementById('wb-err');
          if (e) { e.textContent = 'Заполните габариты, вес и цену!'; e.style.display = 'block'; }
          return;
        }
        var chars = charsEl ? charsEl.value.trim() : '';
        ov.remove();
        resolve({ chars: chars, kw: '', length: len, width: wid, height: hei, weight: wei, price: pri, fromTemplate: fromTmpl });
      };
    });
  }

  async function callClaude(prompt, feature) {
    return new Promise(function(resolve) {
      var done = false;
      // Таймаут 40 сек: Railway cold start + Claude + буфер
      var timer = setTimeout(function() {
        if (done) return;
        done = true;
        window.__wbLastCallError = 'Сервер не ответил за 40 секунд. Обновите страницу и попробуйте снова.';
        resolve(null);
      }, 40000);

      chrome.runtime.sendMessage({ action: 'callAI', prompt: prompt, feature: feature || 'reviews' }, function(resp) {
        clearTimeout(timer);
        if (done) return;
        done = true;
        // SW умер или перезапустился — lastError будет установлен
        if (chrome.runtime.lastError) {
          window.__wbLastCallError = 'Расширение временно недоступно. Обновите страницу.';
          resolve(null);
          return;
        }
        if (resp && resp.error) {
          window.__wbLastCallError = resp.error;
          resolve(null);
          return;
        }
        resolve(resp && resp.text ? resp.text : null);
      });
    });
  }

  // Читаем заполненные поля через innerText
  function readFilledFields() {
    var pairs = [];
    var data = { length: '', width: '', height: '', weight: '', price: '' };

    // Поля которые пропускаем
    var skipIds = ['subjectInfo.supplierSubject', 'brand', 'description', 'editable-description', 'skus', 'swatch', 'photo', 'upload-by-link'];

    document.querySelectorAll('[class*="Field-wrapper__ChpbLLvc2p"][id]').forEach(function(wrapper) {
      var id = wrapper.id;
      if (!id) return;
      if (skipIds.indexOf(id) >= 0) return;

      if (id === 'length' || id === 'width' || id === 'height' || id === 'weightBrutto' || id === 'price') {
        var inp = wrapper.querySelector('input');
        if (inp && inp.value) {
          if (id === 'length') data.length = inp.value;
          if (id === 'width') data.width = inp.value;
          if (id === 'height') data.height = inp.value;
          if (id === 'weightBrutto') data.weight = inp.value;
          if (id === 'price') data.price = inp.value;
        }
        return;
      }

      // Читаем через input value напрямую
      var inp2 = wrapper.querySelector('input:not([type="hidden"])');
      if (inp2 && inp2.value && inp2.value.trim()) {
        var val = inp2.value.trim();
        // Пропускаем поля с placeholder текстом
        if (val === 'Выбрать' || val === 'Укажите' || val.startsWith('Укажите цвет')) return;
        pairs.push(id + ': ' + val);
        return;
      }

      // Читаем chips через innerText только значимые строки
      var text = (wrapper.innerText || '').trim();
      var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
      if (lines.length >= 2) {
        // Убираем первую строку (название поля) и мусорные строки
        var vals = lines.slice(1).filter(function(l) {
          if (l === 'x' || l === '+' || l === 'Выбрать') return false;
          if (/^\d+\s*\/\s*\d+$/.test(l)) return false;
          if (l.includes('Доступно') || l.includes('Сгенерировать')) return false;
          if (l.includes('поставьте галочку') || l.includes('воспользуйтесь')) return false;
          if (l.includes('Изменить') || l.includes('18+')) return false;
          if (l.length > 150) return false;
          return true;
        });
        if (vals.length > 0 && vals[0] !== lines[0]) {
          pairs.push(id + ': ' + vals.join('; '));
        }
      }
    });
    data.chars = pairs.join('\n');
    return data;
  }

  async function fillCard() {
    // Проверяем план через background (не прямой fetch — CSP WB блокирует)
    var planCheck = await new Promise(function(resolve) {
      var timer = setTimeout(function() { resolve('start'); }, 5000);
      chrome.runtime.sendMessage({ action: 'getPlan' }, function(resp) {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve('start'); return; }
        resolve(resp && resp.plan ? resp.plan : 'start');
      });
    });
    if (planCheck === 'start') {
      showToast('❌ Заполнение карточек доступно на тарифе Про и выше. Обновите подписку.', false);
      return;
    }

    var nameEl = document.getElementById('editable-title');
    var productName = nameEl ? (nameEl.value || nameEl.innerText || '') : '';
    productName = productName.trim() || 'товар';

    var showBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
      return (b.innerText || '').trim().includes('Показать все');
    });
    if (showBtn) { showBtn.click(); await wait(800); }

    var userInput = await showModal(productName);
    if (!userInput) return;

    var fields = getAllFields();
    var filled = 0;

    showToast('Заполняю характеристики...', true);

    if (userInput.chars) {
      var pairs = parseChars(userInput.chars);
      for (var i = 0; i < pairs.length; i++) {
        var key = pairs[i][0];
        var raw = pairs[i][1];
        var val = cleanVal(raw);
        var inp = matchField(key, fields);
        if (!inp) continue;
        setVal(inp, val);
        filled++;
        var nk = norm(key);
        var isDim = ['длина', 'ширина', 'высота'].some(function(k) { return nk.startsWith(k); }) && !nk.includes('предмет') && !nk.includes('шнур');
        var isKomplekt = nk.includes('комплект');
        var noDropdown = isDim || nk.includes('вес с упак') || nk === 'цена' || nk.includes('артикул') || nk === 'модель';

        if (isKomplekt) {
          await wait(800);
          var tnvedOpts = document.querySelectorAll('[class*="Tnved-option-component__label"]');
          if (tnvedOpts.length > 0) { tnvedOpts[0].click(); await wait(300); }
        } else if (!noDropdown) {
          // Поле с несколькими значениями через `;` — кликаем каждое отдельно
          // Но только если это не длинная строка комплектации (текстовое поле)
          var isSemicolon = raw.includes(';') && raw.split(';').length > 1 && raw.length < 200;
          var isTextOnly = nk.includes('комплект') || nk.includes('описан') || nk.includes('состав');
          if (isSemicolon && !isTextOnly) {
            var parts = raw.split(';').map(function(s) { return s.trim(); }).filter(Boolean);
            for (var p = 0; p < parts.length; p++) {
              // Кликаем чтобы открыть dropdown (важно для полей типа "0/10")
              inp.click(); inp.focus();
              await wait(400);
              // Передаём оригинальное значение с единицами: "3 мм" не "3"
              setVal(inp, parts[p]);
              await wait(800);
              var clicked = await clickDropdown(parts[p]);
              // Если не нашло с единицами — пробуем без
              if (!clicked) await clickDropdown(cleanVal(parts[p]));
              await wait(400);
            }
          } else {
            await wait(raw.length > 30 ? 1200 : 600);
            await clickDropdown(raw); // передаём оригинал чтобы точно совпал "48 В", "3 ч" и т.д.
          }
        } else {
          inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', keyCode: 9 }));
        }
        await wait(250);
      }
    }

    var dimMap = [
      ['dimensions.length', userInput.length],
      ['dimensions.width', userInput.width],
      ['dimensions.height', userInput.height],
      ['dimensions.weightbrutto', userInput.weight]
    ];
    for (var i = 0; i < dimMap.length; i++) {
      var f = fields.find(function(f) { return (f.inputId || '').toLowerCase().includes(dimMap[i][0]); });
      if (f) { setVal(f.input, dimMap[i][1]); filled++; await wait(150); }
    }
    var pf = fields.find(function(f) { return (f.inputId || '').toLowerCase().includes('price') || f.label === 'price'; });
    if (pf) { setVal(pf.input, userInput.price); filled++; await wait(150); }

    var barcodeBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
      return (b.innerText || '').toLowerCase().includes('баркод');
    });
    if (barcodeBtn) { barcodeBtn.click(); filled++; await wait(500); }

    showToast('Готово! Заполнено ' + filled + ' полей.', true);

    if (!userInput.fromTemplate) {
      await wait(800);
      var name = await showSaveDialog({
        chars: userInput.chars, length: userInput.length, width: userInput.width,
        height: userInput.height, weight: userInput.weight, price: userInput.price,
        kw: userInput.kw, category: getCategory()
      });
      if (name) showToast('Шаблон "' + name + '" сохранён!', true);
    }
  }

  // Получаем данные с WB через background (обход CSP)
  function fetchWBData(query) {
    return new Promise(function(resolve) {
      var timer = setTimeout(function() { resolve({ products: [] }); }, 12000);
      chrome.runtime.sendMessage({ action: 'fetchWBSearch', query: query }, function(resp) {
        clearTimeout(timer);
        resolve(resp || { products: [] });
      });
    });
  }

  // Модальное окно: ключевые слова + конкуренты
  function showKeywordModal(productName, onConfirm) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000000;display:flex;align-items:center;justify-content:center;';
    var m = document.createElement('div');
    m.style.cssText = 'background:#fff;border-radius:14px;width:500px;max-height:88vh;overflow-y:auto;font-family:-apple-system,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.25);';

    m.innerHTML =
      '<div style="background:linear-gradient(135deg,#7b2ff7,#5a1fc7);padding:13px 16px;border-radius:14px 14px 0 0;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:1;">' +
        '<div style="color:#fff;font-size:14px;font-weight:700;">✨ AI Описание</div>' +
        '<button id="wb-kw-x" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:20px;cursor:pointer;line-height:1;">×</button>' +
      '</div>' +
      '<div style="padding:14px 16px;">' +
        '<div style="font-size:12px;color:#888;margin-bottom:12px;">Товар: <b style="color:#333;">' + productName + '</b></div>' +

        // Ключевые слова
        '<div style="font-size:11px;color:#555;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">🔑 Ключевые слова</div>' +
        '<div id="wb-kw-loading" style="font-size:12px;color:#7b2ff7;margin-bottom:8px;">⏳ Загружаю популярные запросы с WB...</div>' +
        '<div id="wb-kw-chips" style="display:none;margin-bottom:10px;"></div>' +
        '<textarea id="wb-kw-input" placeholder="Из Sellego или вставьте свои ключевые слова через запятую..." style="width:100%;min-height:65px;border:1px solid #e0d4f7;border-radius:8px;padding:9px;font-size:13px;font-family:inherit;box-sizing:border-box;outline:none;resize:vertical;margin-bottom:14px;"></textarea>' +

        // Конкуренты
        '<div style="font-size:11px;color:#555;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">🔍 Конкуренты на WB</div>' +
        '<div id="wb-comp-loading" style="font-size:12px;color:#7b2ff7;margin-bottom:8px;">⏳ Загружаю...</div>' +
        '<div id="wb-comp-list" style="display:none;max-height:220px;overflow-y:auto;margin-bottom:14px;border:1px solid #f0ebff;border-radius:8px;"></div>' +

        '<div style="display:flex;gap:8px;">' +
          '<button id="wb-kw-cancel" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;background:#f5f5f5;color:#555;font-size:13px;cursor:pointer;font-family:inherit;">Отмена</button>' +
          '<button id="wb-kw-ok" style="flex:2;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">✨ Сгенерировать описание</button>' +
        '</div>' +
      '</div>';

    ov.appendChild(m);
    document.body.appendChild(ov);

    // Загружаем данные
    fetchWBData(productName).then(function(resp) {
      var products = (resp.products || []).slice(0, 15);

      // Ключевые слова — чипы из названий конкурентов
      var loading = document.getElementById('wb-kw-loading');
      var chips = document.getElementById('wb-kw-chips');
      if (loading) loading.style.display = 'none';
      if (chips) {
        chips.style.display = 'block';
        if (products.length > 0) {
          chips.innerHTML = '<div style="font-size:11px;color:#aaa;margin-bottom:6px;">Популярные запросы (нажми чтобы добавить):</div>';
          var words = new Set();
          products.slice(0, 8).forEach(function(p) {
            (p.name || '').toLowerCase().split(/[\s,\/\-]+/).forEach(function(w) {
              w = w.trim();
              if (w.length > 3 && !/^\d+$/.test(w)) words.add(w);
            });
          });
          Array.from(words).slice(0, 16).forEach(function(kw) {
            var chip = document.createElement('button');
            chip.textContent = kw;
            chip.style.cssText = 'padding:4px 10px;border-radius:20px;border:1.5px solid #ddd;background:#fafafa;color:#555;font-size:12px;cursor:pointer;margin:2px 3px 2px 0;font-family:inherit;';
            chip.onclick = function() {
              var inp = document.getElementById('wb-kw-input');
              if (!inp) return;
              var cur = inp.value.trim();
              inp.value = cur ? cur + ', ' + kw : kw;
              chip.style.borderColor = '#7b2ff7';
              chip.style.color = '#7b2ff7';
              chip.style.background = '#f0ebff';
            };
            chips.appendChild(chip);
          });
        } else {
          chips.innerHTML = '<div style="font-size:12px;color:#aaa;">Не удалось загрузить подсказки</div>';
        }
      }

      // Конкуренты
      var cLoading = document.getElementById('wb-comp-loading');
      var cList = document.getElementById('wb-comp-list');
      if (cLoading) cLoading.style.display = 'none';
      if (cList) {
        cList.style.display = 'block';
        if (!products.length) {
          cList.innerHTML = '<div style="padding:10px;font-size:12px;color:#aaa;">Ничего не найдено</div>';
        } else {
          cList.innerHTML = products.map(function(p, i) {
            var price = p.salePriceU ? Math.round(p.salePriceU / 100).toLocaleString() + ' ₽' : '—';
            var rating = p.reviewRating ? p.reviewRating.toFixed(1) : '—';
            var reviews = (p.feedbacks || 0).toLocaleString();
            var rColor = rating >= 4.5 ? '#22c55e' : rating >= 4 ? '#f59e0b' : '#999';
            return '<div style="padding:8px 12px;border-bottom:1px solid #f5f0ff;display:flex;gap:8px;align-items:flex-start;">' +
              '<span style="font-size:11px;color:#bbb;flex-shrink:0;margin-top:2px;">#' + (i+1) + '</span>' +
              '<div style="flex:1;">' +
                '<div style="font-size:12px;font-weight:600;color:#1a1a1a;line-height:1.4;margin-bottom:3px;">' + (p.name || '—') + '</div>' +
                '<div style="font-size:11px;color:#888;display:flex;gap:8px;">' +
                  '<span style="font-weight:700;color:#1a1a1a;">' + price + '</span>' +
                  '<span style="color:' + rColor + ';">★ ' + rating + '</span>' +
                  '<span>' + reviews + ' отз.</span>' +
                '</div>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }
    });

    document.getElementById('wb-kw-x').onclick = function() { ov.remove(); };
    document.getElementById('wb-kw-cancel').onclick = function() { ov.remove(); };
    document.getElementById('wb-kw-ok').onclick = function() {
      var kw = (document.getElementById('wb-kw-input').value || '').trim();
      ov.remove();
      onConfirm(kw);
    };
  }

  async function generateDescription() {
    var planCheck = await new Promise(function(resolve) {
      var timer = setTimeout(function() { resolve('start'); }, 5000);
      chrome.runtime.sendMessage({ action: 'getPlan' }, function(resp) {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve('start'); return; }
        resolve(resp && resp.plan ? resp.plan : 'start');
      });
    });
    if (planCheck === 'start') {
      showToast('❌ Генерация описания доступна на тарифе Про и выше.', false);
      return;
    }

    var nameEl = document.getElementById('editable-title');
    var productName = nameEl ? (nameEl.value || nameEl.innerText || '') : '';
    productName = productName.trim() || 'товар';

    // Показываем модалку с подсказками ключевых слов
    var kw = await new Promise(function(resolve) {
      showKeywordModal(productName, resolve);
    });
    if (kw === undefined || kw === null) return;

    showToast('Генерирую SEO описание...', true);

    // Читаем характеристики карточки
    var cardData = readFilledFields ? readFilledFields() : { chars: '' };
    var charsText = cardData.chars ? 'ХАРАКТЕРИСТИКИ ТОВАРА:\n' + cardData.chars + '\n\n' : '';

    var kwBlock = kw.trim()
      ? 'КЛЮЧЕВЫЕ СЛОВА ДЛЯ SEO (используй каждое хотя бы 1 раз):\n' + kw.trim() + '\n\n'
      : 'Самостоятельно подбери 8–12 реальных поисковых запросов покупателей WB для "' + productName + '" — от высокочастотных к низкочастотным, включи все органично.\n\n';

    var desc = await callClaude(
      'Ты опытный SEO-копирайтер для Wildberries. Пишешь описания, которые продают и хорошо индексируются.\n\n' +
      'ТОВАР: ' + productName + '\n' +
      'КАТЕГОРИЯ: ' + (getCategory() || 'не указана') + '\n\n' +
      charsText +
      kwBlock +
      'ЗАДАЧА: Напиши продающее SEO-описание товара для карточки на WB.\n\n' +
      'ЖЁСТКИЕ ПРАВИЛА:\n' +
      '• Длина: от 900 до 1600 символов с пробелами — не меньше и не больше.\n' +
      '• Каждое ключевое слово из списка — использовать ровно 1 раз, органично вписанным в текст.\n' +
      '• Словоформы и падежи менять свободно, смысл ключа сохранять.\n' +
      '• Только точки и запятые. Никаких: эмодзи, звёздочек (*), решёток (#), дефисов-списков, скобок, восклицательных знаков.\n' +
      '• Никаких маркированных и нумерованных списков — только связные абзацы.\n' +
      '• Запрещённые слова: лучший, уникальный, идеальный, эксклюзивный, революционный, инновационный, топовый, премиум (кроме случаев когда это реальная характеристика).\n' +
      '• Не начинай с названия товара. Начни с боли или потребности покупателя.\n' +
      '• Текст живой и убедительный — читатель должен захотеть купить.\n\n' +
      'СТРУКТУРА (4 абзаца):\n' +
      '1. Главная выгода и для кого товар + самые высокочастотные ключи\n' +
      '2. Сценарии использования, кому подойдёт, когда нужен + среднечастотные ключи\n' +
      '3. Материал, особенности, характеристики из карточки + низкочастотные ключи\n' +
      '4. Короткий призыв к действию (1–2 предложения)\n\n' +
      'Выведи ТОЛЬКО готовый текст описания. Без заголовков, пояснений, комментариев, кавычек.'
    , 'cards');

    if (!desc) { showToast('❌ Ошибка генерации. Попробуйте снова.', false); return; }

    var cleanDesc = desc.trim().replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
    var LIMIT = 1900;
    if (cleanDesc.length > LIMIT) {
      var cut = cleanDesc.lastIndexOf('.', LIMIT - 1);
      cleanDesc = cut > LIMIT * 0.7 ? cleanDesc.slice(0, cut + 1) : cleanDesc.slice(0, LIMIT);
    }

    var descEl = Array.from(document.querySelectorAll('textarea')).find(function(t) {
      if (t.id === 'editable-title') return false;
      if (t.getAttribute('data-testid') === 'card-form-main-field-title') return false;
      return (
        t.id === 'editable-description' ||
        t.id === 'description' ||
        t.getAttribute('data-testid') === 'card-form-main-field-description' ||
        (t.placeholder && /описани/i.test(t.placeholder))
      );
    });
    if (descEl) {
      setVal(descEl, cleanDesc);
      showToast('✅ Описание вставлено (' + cleanDesc.length + ' симв.)', true);
    } else {
      showToast('❌ Поле описания не найдено на странице.', false);
    }
  }

  // Автосохранение при ручном заполнении
  function watchCreateBtn() {
    var btn = Array.from(document.querySelectorAll('button')).find(function(b) {
      return (b.innerText || '').includes('Создать и завершить');
    });
    if (!btn || btn.__wbWatched) return;
    btn.__wbWatched = true;
    btn.addEventListener('click', function() {
      setTimeout(function() {
        var data = readFilledFields();
        if (!data.chars && !data.price) return;
        data.category = getCategory();
        showSaveDialog(data).then(function(name) {
          if (name) showToast('Шаблон "' + name + '" сохранён!', true);
        });
      }, 300);
    }, { once: true });
  }

  function isCardPage() {
    var url = window.location.href;
    return url.includes('/new-goods/card') ||
           url.includes('/new-goods/edit') ||
           url.includes('/goods/edit') || 
           url.includes('/goods/add') || 
           url.includes('/product/create') ||
           url.includes('/product/edit') ||
           url.includes('/card/edit') ||
           url.includes('/card/create') ||
           url.includes('goods/nm-detail') ||
           url.includes('/nomenclature');
  }

  function injectDescBtn() {
    if (!isCardPage()) return;
    if (document.getElementById('wb-desc-btn')) return;
    // Ищем блок с кнопкой "Сгенерировать" рядом с полем описания
    var genActions = document.querySelector('[class*="Description-generate-actions__"]');
    if (!genActions) return;
    var btn = document.createElement('button');
    btn.id = 'wb-desc-btn';
    btn.type = 'button';
    btn.textContent = '✨ AI описание';
    btn.style.cssText = 'background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;margin-left:8px;vertical-align:middle;';
    btn.onclick = generateDescription;
    genActions.appendChild(btn);
  }

  function injectInfographicBtn() {
    if (!isCardPage()) return;
    if (document.getElementById('wb-infographic-btn')) return;
    var editorBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
      return (b.innerText || '').includes('Открыть редактор');
    });
    if (!editorBtn) return;
    var imgBtn = document.createElement('button');
    imgBtn.id = 'wb-infographic-btn';
    imgBtn.type = 'button';
    imgBtn.textContent = '🖼️ AI Инфографика';
    imgBtn.style.cssText = 'background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:8px;width:100%;white-space:nowrap;display:block;';
    imgBtn.onclick = openInfographicPanel;
    editorBtn.parentElement.insertBefore(imgBtn, editorBtn.nextSibling);
  }

  function injectBtn() {
    if (!isCardPage()) return;
    if (document.getElementById('wb-card-btn')) return;
    var createBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
      if (!(b.innerText || '').includes('Создать и завершить') && !(b.innerText || '').includes('Сохранить')) return false;
      // Не вставляем внутри попапов/модальных диалогов WB
      var parent = b;
      while (parent) {
        var cls = (parent.className || '') + ' ' + (parent.getAttribute('role') || '');
        if (/modal|popup|dialog|overlay|Modal|Dialog|Popup/i.test(cls)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
    if (!createBtn) return;
    var btn = document.createElement('button');
    btn.id = 'wb-card-btn';
    btn.type = 'button';
    btn.textContent = 'AI заполнить';
    btn.style.cssText = 'background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:8px;white-space:nowrap;';
    btn.onclick = fillCard;
    createBtn.parentElement.insertBefore(btn, createBtn);
    watchCreateBtn();
  }

  function getFilledChars() {
    var chars = [];
    var rows = document.querySelectorAll('[class*="CharacteristicsFields"] [class*="field"], [class*="characteristics"] [class*="row"]');
    rows.forEach(function(row) {
      var label = row.querySelector('label, [class*="label"]');
      var input = row.querySelector('input, textarea, [class*="value"]');
      if (label && input) {
        var k = label.innerText.trim();
        var v = (input.value || input.innerText || '').trim();
        if (k && v) chars.push(k + ': ' + v);
      }
    });
    return chars.join('\n');
  }

  function getProductNameFromCard() {
    var el = document.querySelector('[class*="NomenclatureName"] input, [class*="product-name"] input, input[placeholder*="аименование"]');
    return el ? el.value.trim() : '';
  }

  function openInfographicPanel() {
    var existing = document.getElementById('wb-infographic-panel');
    if (existing) { existing.remove(); return; }

    var productName = getProductNameFromCard() || '';
    var chars = getFilledChars();
    var category = document.querySelector('[class*="subjectName"], [class*="category"]')?.innerText?.trim() || '';

    var panel = document.createElement('div');
    panel.id = 'wb-infographic-panel';
    panel.style.cssText = 'position:fixed;top:0;right:0;width:440px;height:100vh;background:#fff;border-left:1px solid #e0d4f7;box-shadow:-8px 0 32px rgba(0,0,0,0.15);z-index:999999;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;overflow:hidden;';
    panel._productImages = []; // массив base64 фото товара
    panel._styleImages = [];   // массив base64 примеров стиля
    panel._mode = 'create';    // 'create' | 'redesign'
    // Загружаем актуальные кредиты через background
    chrome.runtime.sendMessage({ action: 'getPlan' }, function(resp) {
      if (resp && resp.plan === 'max') {
        setTimeout(function() {
          var badge = document.getElementById('wb-inf-credits-badge');
          var num = document.getElementById('wb-inf-credits-num');
          if (badge && num) {
            badge.style.display = 'block';
            num.textContent = (resp.photo_credits || 0) + ' фото';
            if ((resp.photo_credits || 0) <= 5) badge.style.background = 'rgba(255,77,77,0.4)';
          }
        }, 300);
      }
    });

    panel.innerHTML =
      '<div style="background:linear-gradient(135deg,#6a1fd4,#4a0fa8);padding:14px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">' +
        '<div>' +
          '<div style="color:#fff;font-size:15px;font-weight:700;">🖼️ AI Инфографика</div>' +
          '<div style="color:rgba(255,255,255,0.75);font-size:11px;">Профессиональные фото для карточки WB</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div id="wb-inf-credits-badge" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:700;color:#fff;display:none;">📸 <span id="wb-inf-credits-num">0</span></div>' +
          '<button id="wb-inf-close" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;">×</button>' +
        '</div>' +
      '</div>' +

      '<div style="flex:1;overflow-y:auto;padding:16px;" id="wb-inf-scroll">' +


        // ── Режим генерации ─────────────────────────────────────────────────
        '<div style="margin-bottom:16px;background:#f5f0ff;border-radius:12px;padding:12px 14px;border:1px solid #e0d4f7;">' +
          '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">⚙️ Режим</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button id="wb-inf-mode-create" style="flex:1;padding:9px 6px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid #7b2ff7;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;">📸 Новая инфографика</button>' +
            '<button id="wb-inf-mode-redesign" style="flex:1;padding:9px 6px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid #ddd;background:#f5f5f5;color:#666;">🔄 Редизайн карточки</button>' +
          '</div>' +
          '<div id="wb-inf-mode-hint" style="font-size:11px;color:#7b2ff7;margin-top:7px;line-height:1.5;">Загрузите фото товара — AI создаст инфографику с нуля.</div>' +
        '</div>' +

        // Шаг 1 — Фото товара
        '<div style="margin-bottom:18px;">' +
          '<div id="wb-inf-product-label" style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">📦 Фото вашего товара <span style="color:#999;font-weight:400;text-transform:none">(до 10 фото)</span></div>' +
          '<div id="wb-inf-product-drop" style="border:2px dashed #c4a8f5;border-radius:10px;padding:16px;text-align:center;cursor:pointer;background:#f8f4ff;transition:all .2s;" onclick="document.getElementById(\'wb-inf-product-file\').click()" ondrop="window.__wbInfProductDrop(event)" ondragover="event.preventDefault()">' +
            '<div style="font-size:26px;margin-bottom:4px;">📸</div>' +
            '<div style="font-size:13px;color:#888;">Перетащите или нажмите чтобы выбрать</div>' +
            '<div style="font-size:11px;color:#bbb;margin-top:2px;">Разные ракурсы, кейс, комплектация, АКБ...</div>' +
          '</div>' +
          '<input type="file" id="wb-inf-product-file" accept="image/*" multiple style="display:none">' +
          '<div id="wb-inf-product-grid" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;"></div>' +
        '</div>' +

        // Шаг 2 — Пример стиля
        '<div style="margin-bottom:18px;">' +
          '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">🎨 Пример стиля <span style="color:#999;font-weight:400;text-transform:none">(необязательно — AI возьмёт стиль автоматически)</span></div>' +
          '<div style="font-size:12px;color:#888;margin-bottom:8px;line-height:1.5;">Загрузите инфографику с WB или любой понравившийся дизайн — AI скопирует этот стиль для вашего товара.</div>' +
          '<div id="wb-inf-style-drop" style="border:2px dashed #c4a8f5;border-radius:10px;padding:14px;text-align:center;cursor:pointer;background:#f8f4ff;transition:all .2s;" onclick="document.getElementById(\'wb-inf-style-file\').click()" ondrop="window.__wbInfStyleDrop(event)" ondragover="event.preventDefault()">' +
            '<div style="font-size:22px;margin-bottom:4px;">🖼️</div>' +
            '<div style="font-size:12px;color:#7b2ff7;font-weight:600;">Загрузить пример стиля</div>' +
            '<div style="font-size:11px;color:#aaa;margin-top:3px;">Скриншот инфографики с WB — AI скопирует её дизайн</div>' +
          '</div>' +
          '<input type="file" id="wb-inf-style-file" accept="image/*" multiple style="display:none">' +
          '<div id="wb-inf-style-grid" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;"></div>' +
          '<div id="wb-inf-auto-style" style="display:none;background:#f0fff4;border:1px solid #b7e4c7;border-radius:8px;padding:8px 10px;font-size:12px;color:#1a7a4a;margin-top:6px;">✅ <span id="wb-inf-auto-style-text">Стиль будет взят автоматически у топ конкурентов</span></div>' +
        '</div>' +

        // Шаг 3 — Характеристики
        '<div style="margin-bottom:18px;">' +
          '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">📋 Что написать в инфографике <span style="color:#999;font-weight:400;text-transform:none">(необязательно)</span></div>' +
          '<textarea id="wb-inf-chars" rows="4" style="width:100%;box-sizing:border-box;border:1px solid #e0d4f7;border-radius:8px;padding:8px 10px;font-size:12px;font-family:inherit;resize:vertical;outline:none;color:#333;" placeholder="Оставьте пустым — AI сам выберет важные характеристики из карточки">' + chars + '</textarea>' +
          '<div style="font-size:10px;color:#bbb;margin-top:3px;">Если пусто — AI возьмёт характеристики из заполненной карточки</div>' +
        '</div>' +

        // Шаг 4 — Пожелания
        '<div style="margin-bottom:18px;">' +
          '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">✏️ Дополнительные пожелания <span style="color:#999;font-weight:400;text-transform:none">(необязательно)</span></div>' +
          '<textarea id="wb-inf-prompt" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #e0d4f7;border-radius:8px;padding:8px 10px;font-size:12px;font-family:inherit;resize:vertical;outline:none;color:#333;" placeholder="Например: белый фон, синие акценты, добавить значок подарка..."></textarea>' +
        '</div>' +

        // Прогресс
        '<div id="wb-inf-progress" style="display:none;margin-bottom:14px;">' +
          '<div style="background:#f0ebff;border-radius:8px;padding:12px;text-align:center;">' +
            '<div style="font-size:13px;color:#7b2ff7;font-weight:600;" id="wb-inf-progress-text">⏳ Подготовка...</div>' +
            '<div style="background:#e0d4f7;border-radius:10px;height:4px;margin-top:8px;overflow:hidden;">' +
              '<div id="wb-inf-progress-bar" style="height:100%;background:linear-gradient(90deg,#7b2ff7,#a855f7);width:0%;transition:width .5s;border-radius:10px;"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Результат
        '<div id="wb-inf-result" style="display:none;margin-bottom:14px;">' +
          '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">✨ Готовая инфографика</div>' +
          '<canvas id="wb-inf-canvas" style="width:100%;border-radius:10px;border:1px solid #e0d4f7;display:block;"></canvas>' +
          '<div style="display:flex;gap:8px;margin-top:10px;">' +
            '<button id="wb-inf-use-btn" style="flex:1.4;padding:10px;border-radius:8px;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);border:none;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">📤 Вставить в карточку</button>' +
            '<button id="wb-inf-download-btn" style="flex:1;padding:10px;border-radius:8px;background:#f0ebff;border:1px solid #7b2ff7;color:#7b2ff7;font-size:13px;font-weight:600;cursor:pointer;">⬇️ Скачать</button>' +
          '</div>' +
          '<button id="wb-inf-regen-btn" style="width:100%;padding:8px;border-radius:8px;background:#f5f5f5;border:1px solid #ddd;color:#666;font-size:12px;cursor:pointer;margin-top:6px;">🔄 Сгенерировать ещё раз</button>' +
        '</div>' +

        // Ошибка
        '<div id="wb-inf-err" style="display:none;background:#fff0f0;border:1px solid #ffcccc;border-radius:8px;padding:10px;font-size:12px;color:#c0392b;margin-bottom:10px;line-height:1.6;"></div>' +

      '</div>' +

      '<div style="padding:12px 16px;border-top:1px solid #f0ebff;flex-shrink:0;background:#fff;">' +
        '<button id="wb-inf-gen-btn" style="width:100%;padding:14px;border-radius:10px;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);border:none;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 4px 16px rgba(123,47,247,0.35);">✨ Сгенерировать инфографику</button>' +
      '</div>';

    document.body.appendChild(panel);

    // ─── Обработчики ───────────────────────────────────────────
    document.getElementById('wb-inf-close').onclick = function() { panel.remove(); };

    // ── Переключатель режима ────────────────────────────────────────────────
    var _modeHints = {
      create:   'Загрузите фото товара — AI создаст инфографику с нуля.',
      redesign: 'Загрузите старую инфографику + пример нового стиля — AI сохранит товар и поменяет дизайн.'
    };
    var _modeProductLabels = {
      create:   '📦 Фото вашего товара <span style="color:#999;font-weight:400;text-transform:none">(до 10 фото)</span>',
      redesign: '📦 Старая инфографика или фото товара <span style="color:#999;font-weight:400;text-transform:none">(до 10 фото)</span>'
    };
    function setMode(m) {
      panel._mode = m;
      var btnCreate   = document.getElementById('wb-inf-mode-create');
      var btnRedesign = document.getElementById('wb-inf-mode-redesign');
      var hint        = document.getElementById('wb-inf-mode-hint');
      var label       = document.getElementById('wb-inf-product-label');
      if (m === 'create') {
        btnCreate.style.cssText   = 'flex:1;padding:9px 6px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid #7b2ff7;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;';
        btnRedesign.style.cssText = 'flex:1;padding:9px 6px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid #ddd;background:#f5f5f5;color:#666;';
      } else {
        btnCreate.style.cssText   = 'flex:1;padding:9px 6px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid #ddd;background:#f5f5f5;color:#666;';
        btnRedesign.style.cssText = 'flex:1;padding:9px 6px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:2px solid #7b2ff7;background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;';
      }
      if (hint)  hint.innerHTML  = _modeHints[m];
      if (label) label.innerHTML = _modeProductLabels[m];
    }
    document.getElementById('wb-inf-mode-create').onclick   = function() { setMode('create'); };
    document.getElementById('wb-inf-mode-redesign').onclick = function() { setMode('redesign'); };

    // Загрузка фото товара
    var productFile = document.getElementById('wb-inf-product-file');
    productFile.onchange = function(e) {
      addProductImages(Array.from(e.target.files), panel);
      e.target.value = ''; // Сбрасываем чтобы можно было выбрать снова
    };
    window.__wbInfProductDrop = function(e) {
      e.preventDefault();
      addProductImages(Array.from(e.dataTransfer.files), panel);
    };

    // Загрузка примера стиля
    var styleFile = document.getElementById('wb-inf-style-file');
    styleFile.onchange = function(e) {
      addStyleImages(Array.from(e.target.files), panel);
      e.target.value = ''; // Сбрасываем
    };
    window.__wbInfStyleDrop = function(e) {
      e.preventDefault();
      addStyleImages(Array.from(e.dataTransfer.files), panel);
    };

    // Генерация
    document.getElementById('wb-inf-gen-btn').onclick = function() { generateInfographic(panel); };
    document.getElementById('wb-inf-regen-btn').onclick = function() { generateInfographic(panel); };

    // Если нет примера стиля — показываем сообщение про автоматический
    updateAutoStyleMsg(panel);
  }

  function updateAutoStyleMsg(panel) {
    var autoEl = document.getElementById('wb-inf-auto-style');
    if (!panel._styleImages || panel._styleImages.length === 0) {
      autoEl.style.display = 'block';
    } else {
      autoEl.style.display = 'none';
    }
  }

  function addProductImages(files, panel) {
    files.forEach(function(file) {
      if (!file.type.startsWith('image/')) return;
      if (panel._productImages.length >= 10) { showToast('Максимум 10 фото товара', false); return; }
      var reader = new FileReader();
      reader.onload = function(ev) {
        panel._productImages.push(ev.target.result);
        var productRemoveFn = function(idx) {
          panel._productImages.splice(idx, 1);
          renderImageGrid('wb-inf-product-grid', panel._productImages, productRemoveFn);
          updateProductDropZone(panel);
        };
        renderImageGrid('wb-inf-product-grid', panel._productImages, productRemoveFn);
        updateProductDropZone(panel);
      };
      reader.readAsDataURL(file);
    });
  }

  function updateProductDropZone(panel) {
    var drop = document.getElementById('wb-inf-product-drop');
    if (!drop) return;
    if (panel._productImages.length > 0) {
      drop.innerHTML = '<div style="font-size:22px;margin-bottom:4px;">➕</div>' +
        '<div style="font-size:12px;color:#888;">Добавить ещё фото (' + panel._productImages.length + '/10)</div>';
      drop.style.padding = '10px';
    } else {
      drop.innerHTML = '<div style="font-size:26px;margin-bottom:4px;">📸</div>' +
        '<div style="font-size:13px;color:#888;">Перетащите или нажмите чтобы выбрать</div>' +
        '<div style="font-size:11px;color:#bbb;margin-top:2px;">Разные ракурсы, кейс, комплектация, АКБ...</div>';
      drop.style.padding = '16px';
    }
    drop.style.display = 'block';
  }

  function addStyleImages(files, panel) {
    files.forEach(function(file) {
      if (!file.type.startsWith('image/')) return;
      if (panel._styleImages.length >= 3) { showToast('Максимум 3 примера стиля', false); return; }
      var reader = new FileReader();
      reader.onload = function(ev) {
        panel._styleImages.push(ev.target.result);
        var styleRemoveFn = function(idx) {
          panel._styleImages.splice(idx, 1);
          renderImageGrid('wb-inf-style-grid', panel._styleImages, styleRemoveFn);
          // Показываем drop-zone обратно когда все стили удалены
          var styleDrop = document.getElementById('wb-inf-style-drop');
          if (styleDrop) styleDrop.style.display = panel._styleImages.length === 0 ? 'block' : 'none';
          updateAutoStyleMsg(panel);
        };
        renderImageGrid('wb-inf-style-grid', panel._styleImages, styleRemoveFn);
        document.getElementById('wb-inf-style-drop').style.display = 'none';
        updateAutoStyleMsg(panel);
      };
      reader.readAsDataURL(file);
    });
  }

  function renderImageGrid(containerId, images, onRemove) {
    var container = document.getElementById(containerId);
    if (!container) return;
    // Используем data-атрибуты + event delegation (избегаем дефисов в именах функций)
    container.innerHTML = images.map(function(src, i) {
      return '<div style="position:relative;width:72px;height:72px;display:inline-block;margin:2px;">' +
        '<img src="' + src + '" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #c4a8f5;" />' +
        '<button data-remove-idx="' + i + '" style="position:absolute;top:-5px;right:-5px;width:20px;height:20px;border-radius:50%;background:#ff4444;border:2px solid #fff;color:#fff;font-size:12px;cursor:pointer;line-height:16px;padding:0;font-weight:700;z-index:10;">×</button>' +
      '</div>';
    }).join('');
    // Один обработчик на весь контейнер — не теряет ref при перерисовке
    container.onclick = function(e) {
      var btn = e.target.closest('[data-remove-idx]');
      if (btn) {
        e.stopPropagation();
        onRemove(parseInt(btn.getAttribute('data-remove-idx'), 10));
      }
    };
  }

  function setProgress(text, pct) {
    var el = document.getElementById('wb-inf-progress');
    if (el) el.style.display = 'block';
    var t = document.getElementById('wb-inf-progress-text');
    if (t) t.textContent = text;
    var b = document.getElementById('wb-inf-progress-bar');
    if (b) b.style.width = pct + '%';
  }

  function compressImage(base64, maxWidth, quality) {
    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var ratio = Math.min(maxWidth / img.width, maxWidth / img.height, 1);
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality || 0.7));
      };
      img.onerror = function() { resolve(base64); };
      img.src = base64;
    });
  }

  // ===== НАЛОЖЕНИЕ РУССКОГО ТЕКСТА ЧЕРЕЗ CANVAS =====
  var _fontLoaded = false;
  async function loadCyrillicFont() {
    if (_fontLoaded) return true;
    try {
      var fontBold = new FontFace('WBInfFont',
        'url(https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM73w0aXpsog.woff2)',
        { weight: '700', style: 'normal' }
      );
      var fontMed = new FontFace('WBInfFont',
        'url(https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCtK73w0aXpsog.woff2)',
        { weight: '600', style: 'normal' }
      );
      await fontBold.load();
      await fontMed.load();
      document.fonts.add(fontBold);
      document.fonts.add(fontMed);
      _fontLoaded = true;
      return true;
    } catch(e) {
      console.warn('[WBai] Font load failed:', e.message);
      return false;
    }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function wrapTextLines(ctx, text, maxWidth) {
    var words = text.split(' ');
    var lines = [], current = '';
    for (var i = 0; i < words.length; i++) {
      var test = current ? current + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current); current = words[i];
      } else { current = test; }
    }
    if (current) lines.push(current);
    return lines;
  }

  // ═══════════════════════════════════════════════════
  // CANVAS TEXT OVERLAY — профессиональная типографика WB
  // Seedream рисует визуал, Canvas пишет текст без ошибок
  // ═══════════════════════════════════════════════════

  var _cyrFontLoaded = false;
  async function loadCyrillicFont() {
    if (_cyrFontLoaded) return;
    try {
      // Montserrat — идеален для WB: геометрический, bold, поддерживает кириллицу
      var urls = [
        ['url(https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM73w0aXpsog.woff2)', '700'],
        ['url(https://fonts.gstatic.com/s/montserrat/v26/JTUFjIg1_i6t8kCHKm4532VJ__yCmwlovlcm.woff2)', '900']
      ];
      for (var u of urls) {
        var f = new FontFace('WBFont', u[0], { weight: u[1] });
        var loaded = await f.load();
        document.fonts.add(loaded);
      }
      _cyrFontLoaded = true;
    } catch(e) { console.warn('WBFont load failed:', e.message); }
  }

  async function overlayTextOnCanvas(base64Image, title, specs, primarySpec) {
    await loadCyrillicFont();
    var FF = '"WBFont", "Arial Black", Arial, sans-serif';

    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        var C = document.createElement('canvas');
        var W = img.width, H = img.height;
        C.width = W; C.height = H;
        var ctx = C.getContext('2d');
        ctx.drawImage(img, 0, 0);

        var allSpecs = specs ? specs.split('\n').filter(function(l){ return l.trim(); }) : [];
        var prim = primarySpec || allSpecs[0] || '';
        var secs = allSpecs.slice(prim && prim === allSpecs[0] ? 1 : 0).slice(0, 5);

        // ── Helpers ──
        function rr(x, y, w, h, r) {
          ctx.beginPath();
          ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
          ctx.arcTo(x+w,y,x+w,y+r,r); ctx.lineTo(x+w,y+h-r);
          ctx.arcTo(x+w,y+h,x+w-r,y+h,r); ctx.lineTo(x+r,y+h);
          ctx.arcTo(x,y+h,x,y+h-r,r); ctx.lineTo(x,y+r);
          ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
        }
        function wt(text, maxW) {
          var words = text.split(' '), lines = [], cur = '';
          ctx.save();
          for (var i=0; i<words.length; i++) {
            var t = cur ? cur+' '+words[i] : words[i];
            if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = words[i]; }
            else cur = t;
          }
          if (cur) lines.push(cur);
          ctx.restore();
          return lines;
        }
        function shadow(blur, color, ox, oy) {
          ctx.shadowBlur = blur; ctx.shadowColor = color;
          ctx.shadowOffsetX = ox||0; ctx.shadowOffsetY = oy||0;
        }
        function noShadow() { ctx.shadowBlur=0; ctx.shadowColor='transparent'; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0; }

        var pad = W*0.042;

        // ══════════════════════════════════════
        // 1. ЗАГОЛОВОК — верхняя зона
        // ══════════════════════════════════════
        if (title && title.trim()) {
          var tfs = Math.max(24, Math.min(58, Math.round(W*0.052)));
          ctx.font = '900 '+tfs+'px '+FF;
          var tMaxW = W - pad*2 - W*0.04;
          var tLines = wt(title.trim(), tMaxW).slice(0,2);
          var tlh = tfs*1.22, tBH = tLines.length*tlh + tfs*0.55;
          var tBY = Math.round(H*0.016), tBX = Math.round(pad*0.6), tBW = W-tBX*2;

          // Фон — тёмный с градиентом
          ctx.save();
          var tg = ctx.createLinearGradient(tBX, tBY, tBX, tBY+tBH);
          tg.addColorStop(0,'rgba(0,0,0,0.87)');
          tg.addColorStop(1,'rgba(0,0,0,0.72)');
          rr(tBX, tBY, tBW, tBH, 12);
          ctx.fillStyle = tg; ctx.fill();
          // Жёлтая полоска снизу блока
          rr(tBX+16, tBY+tBH-3, tBW-32, 3, 2);
          ctx.fillStyle = '#FFD700'; ctx.fill();
          ctx.restore();

          // Текст заголовка
          ctx.save();
          ctx.font = '900 '+tfs+'px '+FF;
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          shadow(10,'rgba(0,0,0,0.95)',1,2);
          tLines.forEach(function(l,i){ ctx.fillText(l, W/2, tBY+tfs*0.82+i*tlh); });
          noShadow(); ctx.restore();
        }

        // ══════════════════════════════════════
        // 2. ГЛАВНЫЙ АРГУМЕНТ — крупный badge
        // ══════════════════════════════════════
        if (prim) {
          // Определяем размер
          var pfs = Math.max(32, Math.min(82, Math.round(W*0.08)));
          ctx.font = '900 '+pfs+'px '+FF;
          var pMaxW = W*0.46;
          var pLines = wt(prim, pMaxW).slice(0,2);
          var plh = pfs*1.18;
          var pBW = Math.round(W*0.52), pBX = Math.round(W*0.45);
          var pBH = pLines.length*plh + pfs*0.55;
          var pBY = Math.round(H*0.14);

          // Фон badge — тёмный premium
          ctx.save();
          var pg = ctx.createLinearGradient(pBX, pBY, pBX+pBW, pBY+pBH);
          pg.addColorStop(0,'rgba(10,8,0,0.93)');
          pg.addColorStop(1,'rgba(20,16,0,0.88)');
          rr(pBX, pBY, pBW, pBH, 14);
          ctx.fillStyle = pg; ctx.fill();
          // Жёлтый левый акцент — толстый
          rr(pBX, pBY+6, 5, pBH-12, 3);
          ctx.fillStyle = '#FFD700'; ctx.fill();
          // Жёлтая рамка
          rr(pBX, pBY, pBW, pBH, 14);
          ctx.strokeStyle = 'rgba(255,215,0,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.restore();

          // Текст главного аргумента
          ctx.save();
          ctx.font = '900 '+pfs+'px '+FF;
          ctx.fillStyle = '#FFD700';
          ctx.textAlign = 'left';
          shadow(12,'rgba(0,0,0,0.95)',2,2);
          pLines.forEach(function(l,i){ ctx.fillText(l, pBX+Math.round(W*0.022), pBY+pfs*0.85+i*plh); });
          noShadow(); ctx.restore();
        }

        // ══════════════════════════════════════
        // 3. ВТОРИЧНЫЕ ХАРАКТЕРИСТИКИ — снизу
        // ══════════════════════════════════════
        if (secs.length > 0) {
          var sfs = Math.max(16, Math.min(30, Math.round(W*0.029)));
          var sbH = Math.round(sfs*2.7);
          var sGap = Math.round(sbH*0.28);
          var totalH = secs.length*(sbH+sGap)-sGap;
          var sStartY = H - totalH - Math.round(H*0.022);
          var sBX = Math.round(pad*0.6), sBW = W - sBX*2;

          secs.forEach(function(spec, i) {
            var by = sStartY + i*(sbH+sGap);

            // Фон блока
            ctx.save();
            var sg = ctx.createLinearGradient(sBX, by, sBX+sBW, by+sbH);
            sg.addColorStop(0,'rgba(5,4,12,0.91)');
            sg.addColorStop(1,'rgba(10,8,20,0.85)');
            rr(sBX, by, sBW, sbH, 10);
            ctx.fillStyle = sg; ctx.fill();
            // Жёлтый левый акцент
            rr(sBX, by+5, 4, sbH-10, 2);
            ctx.fillStyle = '#FFD700'; ctx.fill();
            // Тонкая рамка
            rr(sBX, by, sBW, sbH, 10);
            ctx.strokeStyle = 'rgba(255,215,0,0.18)'; ctx.lineWidth = 1; ctx.stroke();
            ctx.restore();

            // Разбиваем характеристику на число+единицу и описание
            var parts = spec.trim().match(/^([\d.,]+\s*[а-яёА-ЯЁa-zA-Z\/]+)(.*)?$/);
            if (parts && parts[2] && parts[2].trim()) {
              // Число крупно, описание мельче
              var nfs = Math.round(sfs*1.35), lfs = Math.round(sfs*0.82);
              var tx = sBX + Math.round(W*0.038), ty = by + sbH*0.65;
              ctx.save();
              ctx.font = '900 '+nfs+'px '+FF;
              ctx.fillStyle = '#FFFFFF';
              shadow(4,'rgba(0,0,0,0.8)');
              ctx.fillText(parts[1].trim(), tx, ty);
              var nw = ctx.measureText(parts[1].trim()).width;
              noShadow();
              ctx.font = '700 '+lfs+'px '+FF;
              ctx.fillStyle = 'rgba(255,255,255,0.75)';
              ctx.fillText(parts[2].trim(), tx+nw+Math.round(W*0.012), ty);
              ctx.restore();
            } else {
              // Одна строка
              ctx.save();
              ctx.font = '700 '+sfs+'px '+FF;
              ctx.fillStyle = '#FFFFFF';
              shadow(4,'rgba(0,0,0,0.85)');
              var maxTW = sBW - Math.round(W*0.06), st = spec.trim();
              while (st.length>4 && ctx.measureText(st).width>maxTW) st=st.slice(0,-1);
              if (st!==spec.trim()) st+='…';
              ctx.fillText(st, sBX+Math.round(W*0.038), by+sbH*0.65);
              noShadow(); ctx.restore();
            }
          });
        }

        resolve(C.toDataURL('image/jpeg', 0.94));
      };
      img.onerror = function(){ resolve(base64Image); };
      img.src = base64Image;
    });
  }


  async function generateInfographic(panel) {
    var chars = document.getElementById('wb-inf-chars').value.trim();
    var userPrompt = document.getElementById('wb-inf-prompt').value.trim();
    var productName = getProductNameFromCard();
    var errEl = document.getElementById('wb-inf-err');
    errEl.style.display = 'none';
    document.getElementById('wb-inf-result').style.display = 'none';

    if (panel._productImages.length === 0) {
      errEl.textContent = 'Загрузите хотя бы одно фото товара';
      errEl.style.display = 'block';
      return;
    }

    // Пример стиля теперь необязателен — сервер использует дефолтный стиль WB
    // if (panel._styleImages.length === 0) { ... }

    // Проверяем план и кредиты через background
    var userPlanData = await new Promise(function(resolve) {
      chrome.runtime.sendMessage({ action: 'getPlan' }, function(resp) {
        resolve(resp || {});
      });
    });
    var btn = document.getElementById('wb-inf-gen-btn');
    if (btn) btn.disabled = true;

    if (userPlanData.plan !== 'max') {
      errEl.textContent = '❌ AI Инфографика доступна только на тарифе Макс.';
      errEl.style.display = 'block';
      if (btn) btn.disabled = false;
      return;
    }
    var creditsLeft = userPlanData.photo_credits || 0;
    if (creditsLeft < 1) {
      errEl.textContent = '❌ Фото-кредиты закончились. Пополните баланс у администратора.';
      errEl.style.display = 'block';
      if (btn) btn.disabled = false;
      return;
    }

    try {
      // Шаг 1 — Если нет примера стиля — ищем у конкурентов
      var styleImageBase64 = panel._styleImages.length > 0 ? panel._styleImages[0] : null;

      if (!styleImageBase64) {
        setProgress('🔍 Ищем лучший стиль у конкурентов на WB...', 15);
        var category = document.querySelector('[class*="subjectName"], [class*="Breadcrumb"] span:last-child')?.innerText?.trim() || productName || '';
        styleImageBase64 = await findCompetitorStyle(category || productName);
        if (styleImageBase64) {
          setProgress('✅ Стиль найден у топ конкурента!', 30);
        } else {
          setProgress('📐 Используем стандартный стиль WB...', 30);
        }
      } else {
        setProgress('🎨 Claude анализирует ваш стиль...', 30);
      }

      // Шаг 2 — Формируем промпт
      setProgress('✍️ Формируем задание дизайнеру AI...', 45);

      var specsToShow = chars || getFilledChars();
      var specsList = specsToShow.split('\n').filter(function(l) { return l.trim(); }).slice(0, 8).join(', ');

      var fullPrompt = styleImageBase64
        ? 'Create a professional product infographic for Wildberries marketplace. ' +
          'Copy the visual style from the first reference image: same background, layout, colors, decorative elements. ' +
          'Use ONLY the exact product from the product photos — do NOT replace it. ' +
          'Write ALL text in correct Russian language. ' +
          'Product name: ' + (productName || '') + '. ' +
          'Add these specs as text blocks in Russian: ' + (specsList || '') + '. ' +
          (userPrompt ? 'Additional: ' + userPrompt + '. ' : '') +
          'No watermarks. Vertical format.'
        : 'Create a professional product infographic for Wildberries marketplace. ' +
          'Use ONLY the exact product from the provided photos — preserve all details. ' +
          'Style: dark background, professional studio lighting, geometric decorative elements. ' +
          'Write ALL text in correct Russian language on the infographic. ' +
          'Product name in large bold text: ' + (productName || '') + '. ' +
          'Add spec blocks with these characteristics in Russian: ' + (specsList || '') + '. ' +
          (userPrompt ? 'Additional: ' + userPrompt + '. ' : '') +
          'No watermarks. Vertical format 1024x1536.';

      // Шаг 3 — Генерируем изображение
      setProgress('📐 Готовим макет: товар + аксессуары...', 60);

      var specsList = specsToShow.split('\n').filter(function(l) { return l.trim(); }).slice(0, 4).join('\n');

      // Сжимаем фото перед отправкой (только товарные — стиль анализирует сервер)
      setProgress('📦 Подготовка фото...', 55);
      var compressedProduct = await compressImage(panel._productImages[0], 800, 0.75);
      var compressedExtra = [];
      for (var i = 1; i < Math.min(panel._productImages.length, 4); i++) {
        compressedExtra.push(await compressImage(panel._productImages[i], 600, 0.65));
      }
      // Стиль передаём на сервер отдельно — Claude проанализирует и опишет текстом
      // Seedream получит только товарные фото, без reference-изображения стиля
      var compressedStyle = styleImageBase64 ? await compressImage(styleImageBase64, 700, 0.70) : null;

      setProgress('🎨 Seedream генерирует инфографику...', 65);

      // Получаем выбранную модель из UI (если есть селектор)
      var selectedModel = (function() {
        var sel = document.getElementById('wb-inf-model-select');
        return sel ? sel.value : 'gpt-image-2';
      })();

      var result = await new Promise(function(resolve, reject) {
        chrome.runtime.sendMessage({
          action: 'generateImage',
          prompt: userPrompt || '',
          imageBase64: compressedProduct,
          styleImageBase64: compressedStyle,
          extraImages: compressedExtra,
          productName: productName,
          specs: specsList,
          modelId: selectedModel,
          mode: panel._mode || 'create'
        }, function(resp) {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!resp) { reject(new Error('Нет ответа от сервера')); return; }
          if (resp.error) { reject(new Error(resp.error)); return; }
          resolve(resp);
        });
      });

      var finalBase64 = result.imageBase64;
      if (!finalBase64) throw new Error('Изображение не получено от сервера');

      setProgress('✅ Готово!', 100);

      setTimeout(function() {
        document.getElementById('wb-inf-progress').style.display = 'none';
        var resultEl = document.getElementById('wb-inf-result');
        var canvas = document.getElementById('wb-inf-canvas');
        canvas.style.display = 'none';

        var oldImg = document.getElementById('wb-inf-result-img-el');
        if (oldImg) oldImg.remove();

        var imgEl = document.createElement('img');
        imgEl.id = 'wb-inf-result-img-el';
        imgEl.style.cssText = 'width:100%;border-radius:10px;border:1px solid #e0d4f7;display:block;';
        imgEl.src = finalBase64;
        imgEl.onerror = function() { imgEl.alt = 'Не удалось отобразить'; };
        resultEl.insertBefore(imgEl, canvas);
        panel._resultBlob = finalBase64;
        resultEl.style.display = 'block';
        document.getElementById('wb-inf-scroll').scrollTop = 99999;

        // Обновляем кредиты после генерации
        if (result.credits_left !== undefined) {
          chrome.storage.local.get('user', function(d) {
            if (d && d.user) {
              d.user.photo_credits = result.credits_left;
              chrome.storage.local.set({ user: d.user });
            }
          });
          var badge = document.getElementById('wb-inf-credits-badge');
          var num = document.getElementById('wb-inf-credits-num');
          if (badge && num) {
            num.textContent = result.credits_left + ' фото';
            if (result.credits_left <= 5) badge.style.background = 'rgba(255,77,77,0.4)';
          }
        }
      }, 300);

      // Кнопки результата
      document.getElementById('wb-inf-download-btn').onclick = function() {
        var url = panel._resultBlob || finalBase64;
        var a = document.createElement('a');
        a.href = url;
        a.download = 'infographic-' + (productName || 'product') + '.jpg';
        a.click();
      };

      document.getElementById('wb-inf-use-btn').onclick = function() {
        var uploaded = tryUploadToWB(panel._resultBlob || finalBase64);
        if (uploaded) {
          showToast('✅ Фото передано в поле загрузки!', true);
        } else {
          showToast('⬇️ Скачайте фото и перетащите в поле загрузки WB', true);
          document.getElementById('wb-inf-download-btn').click();
        }
      };

    } catch(e) {
      document.getElementById('wb-inf-progress').style.display = 'none';
      errEl.textContent = 'Ошибка: ' + e.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Сгенерировать инфографику';
    }
  }

  async function findCompetitorStyle(query) {
    // Открываем WB поиск и берём фото из топ карточки
    return new Promise(function(resolve) {
      if (!query) { resolve(null); return; }
      var searchUrl = 'https://www.wildberries.ru/catalog/0/search.aspx?search=' + encodeURIComponent(query) + '&sort=popular';
      chrome.tabs.create({ url: searchUrl, active: false }, function(tab) {
        var timeout = setTimeout(function() {
          chrome.tabs.remove(tab.id).catch(function() {});
          resolve(null);
        }, 15000);

        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);
            setTimeout(function() {
              chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(function() {});
              setTimeout(function() {
                chrome.tabs.sendMessage(tab.id, { action: 'getTopProductImage' }, function(resp) {
                  chrome.tabs.remove(tab.id).catch(function() {});
                  resolve(resp && resp.imageUrl ? resp.imageUrl : null);
                });
              }, 2000);
            }, 1000);
          }
        });
      });
    });
  }

  async function overlayTextOnImage(imageUrl, productName, specs) {
    return new Promise(function(resolve) {
      // Загружаем изображение через наш сервер чтобы обойти CORS
      chrome.storage.local.get('token', function(data) {
        var token = data && data.token;
        fetch('https://wbai.up.railway.app/api/image-proxy?url=' + encodeURIComponent(imageUrl), {
          headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(resp) {
          if (!resp.base64) { resolve(imageUrl); return; }
          drawTextOnCanvas(resp.base64, productName, specs, resolve);
        })
        .catch(function() { resolve(imageUrl); });
      });
    });
  }

  function drawTextOnCanvas(base64ImageUrl, productName, specs, resolve) {
    var img = new Image();
    img.onload = function() {
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      var W = canvas.width;
      var H = canvas.height;
      var scale = W / 1000;
      var fontFamily = 'Arial, sans-serif';

      // Парсим характеристики
      var specLines = (specs || '').split('\n')
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l.length > 0; })
        .slice(0, 6);

      // Название товара вверху
      if (productName) {
        var titleSize = Math.round(52 * scale);
        ctx.font = 'bold ' + titleSize + 'px ' + fontFamily;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = titleSize * 0.08;
        ctx.textAlign = 'center';
        var titleY = Math.round(80 * scale);
        ctx.strokeText(productName.toUpperCase(), W / 2, titleY);
        ctx.fillText(productName.toUpperCase(), W / 2, titleY);
      }

      // Блоки с характеристиками
      if (specLines.length > 0) {
        var blockW = Math.round(200 * scale);
        var blockH = Math.round(70 * scale);
        var blockRadius = Math.round(14 * scale);
        var leftX = Math.round(30 * scale);
        var rightX = W - leftX - blockW;
        var startY = Math.round(H * 0.25);
        var stepY = Math.round(90 * scale);

        var leftSpecs = specLines.slice(0, Math.ceil(specLines.length / 2));
        var rightSpecs = specLines.slice(Math.ceil(specLines.length / 2));

        function drawSpecBlock(text, x, y) {
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(x, y, blockW, blockH, blockRadius);
          } else {
            ctx.rect(x, y, blockW, blockH);
          }
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          var parts = text.split(':');
          var label = parts.length > 1 ? parts[0].trim() : '';
          var value = parts.length > 1 ? parts[1].trim() : text;

          var valueSize = Math.round(22 * scale);
          var labelSize = Math.round(13 * scale);

          ctx.textAlign = 'center';
          if (label) {
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.font = labelSize + 'px ' + fontFamily;
            ctx.fillText(label, x + blockW / 2, y + blockH * 0.38);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold ' + valueSize + 'px ' + fontFamily;
            ctx.fillText(value, x + blockW / 2, y + blockH * 0.72);
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold ' + valueSize + 'px ' + fontFamily;
            ctx.fillText(value, x + blockW / 2, y + blockH * 0.6);
          }
        }

        leftSpecs.forEach(function(spec, i) {
          drawSpecBlock(spec, leftX, startY + i * stepY);
        });
        rightSpecs.forEach(function(spec, i) {
          drawSpecBlock(spec, rightX, startY + i * stepY);
        });
      }

      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = function() { resolve(base64ImageUrl); };
    img.src = base64ImageUrl;
  }

  function tryUploadToWB(imageDataUrl) {
    // Пробуем через DataTransfer вставить в поле загрузки WB
    try {
      var uploadArea = document.querySelector('[class*="upload"], [class*="Upload"], input[type="file"][accept*="image"]');
      if (!uploadArea) return false;

      var byteString = atob(imageDataUrl.split(',')[1]);
      var mimeString = imageDataUrl.split(',')[0].split(':')[1].split(';')[0];
      var ab = new ArrayBuffer(byteString.length);
      var ia = new Uint8Array(ab);
      for (var i = 0; i < byteString.length; i++) { ia[i] = byteString.charCodeAt(i); }
      var blob = new Blob([ab], { type: mimeString });
      var file = new File([blob], 'infographic.jpg', { type: 'image/jpeg' });

      var dt = new DataTransfer();
      dt.items.add(file);
      uploadArea.files = dt.files;
      uploadArea.dispatchEvent(new Event('change', { bubbles: true }));
      uploadArea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch(e) {
      return false;
    }
  }

  var obs = new MutationObserver(function() {
    if (!isCardPage()) {
      var b = document.getElementById('wb-card-btn'); if (b) b.remove();
      var db = document.getElementById('wb-desc-btn'); if (db) db.remove();
      var ib = document.getElementById('wb-infographic-btn'); if (ib) ib.remove();
      return;
    }
    var has = Array.from(document.querySelectorAll('button')).some(function(b) {
      return (b.innerText || '').includes('Создать и завершить') || (b.innerText || '').includes('Сохранить');
    });
    if (has) setTimeout(injectBtn, 400);
    else { var b = document.getElementById('wb-card-btn'); if (b) b.remove(); }

    // Кнопка AI описание рядом с полем описания
    if (document.querySelector('[class*="Description-generate-actions__"]')) setTimeout(injectDescBtn, 300);
    else { var db = document.getElementById('wb-desc-btn'); if (db) db.remove(); }

    var hasEditor = Array.from(document.querySelectorAll('button')).some(function(b) {
      return (b.innerText || '').includes('Открыть редактор');
    });
    if (hasEditor) setTimeout(injectInfographicBtn, 400);
    else { var ib = document.getElementById('wb-infographic-btn'); if (ib) ib.remove(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(injectBtn, 1000);
  setTimeout(injectDescBtn, 1500);
  setTimeout(injectInfographicBtn, 1000);
})();

// ===== ГЕНЕРАЦИЯ НАЗВАНИЯ =====
(function() {
  var titleBtnInjected = false;

  async function generateTitle() {
    var nameEl = document.getElementById('editable-title');
    if (!nameEl) { alert('Поле названия не найдено'); return; }

    var currentName = (nameEl.value || nameEl.innerText || '').trim();
    var cat = (document.querySelector('[class*="subject"], [class*="Subject"]') || {}).innerText || '';
    cat = cat.split('/').pop().trim();

    var btn = document.getElementById('wb-title-btn');
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    var prompt =
      'Придумай SEO-название товара для Wildberries.\n\n' +
      'ТОВАР: ' + (currentName || cat || 'товар') + '\n' +
      'КАТЕГОРИЯ: ' + cat + '\n\n' +
      'ПРАВИЛА:\n' +
      '- Максимум 60 символов\n' +
      '- Начни с главного высокочастотного запроса WB\n' +
      '- Добавь 2-3 важных характеристики или ключевых слова\n' +
      '- Без лишних слов и воды\n' +
      '- Пример: "Шуруповерт аккумуляторный для дома мощный 48В"\n' +
      'Напиши только название без кавычек и пояснений.';

    chrome.runtime.sendMessage({ action: 'callAI', prompt: prompt }, function(resp) {
      if (btn) { btn.textContent = '✨'; btn.disabled = false; }
      if (!resp || !resp.text) { alert('Ошибка AI'); return; }

      var title = resp.text.trim().replace(/^["«»]+|["«»]+$/g, '').trim();
      if (title.length > 60) title = title.slice(0, 60).trim();

      // Вставляем в поле названия
      nameEl.focus();
      nameEl.click();
      var proto = HTMLTextAreaElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(nameEl, title);
      else nameEl.value = title;
      nameEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: title }));
      nameEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function injectTitleBtn() {
    if (document.getElementById('wb-title-btn')) return;
    var nameEl = document.getElementById('editable-title');
    if (!nameEl) return;

    var btn = document.createElement('button');
    btn.id = 'wb-title-btn';
    btn.type = 'button';
    btn.textContent = '✨';
    btn.title = 'AI сгенерирует SEO-название';
    btn.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:linear-gradient(135deg,#7b2ff7,#5a1fc7);color:#fff;border:none;border-radius:6px;width:28px;height:28px;font-size:14px;cursor:pointer;z-index:100;display:flex;align-items:center;justify-content:center;';
    btn.onclick = generateTitle;

    var parent = nameEl.parentElement;
    if (parent) {
      parent.style.position = 'relative';
      parent.appendChild(btn);
    }
    titleBtnInjected = true;
  }

  var titleObs = new MutationObserver(function() {
    if (document.getElementById('editable-title') && !document.getElementById('wb-title-btn')) {
      setTimeout(injectTitleBtn, 500);
    }
  });
  titleObs.observe(document.body, { childList: true, subtree: true });
  setTimeout(injectTitleBtn, 1500);
})();
