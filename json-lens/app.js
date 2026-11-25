'use strict';

const ROW_H = 26;
const MATCH_CAP = 50000;
const STRING_PREVIEW = 200;

const $ = (id) => document.getElementById(id);
const scroller = $('scroller'), spacer = $('spacer'), rowWindow = $('rowWindow');

const state = {
  root: undefined,
  nodes: [],
  rows: [],
  rowIndex: new Map(),
  maxDepth: 0,
  fileName: '未命名.json',
  fileSize: 0,
  fileHandle: null,
  dirty: false,
  loaded: false,
  selected: -1,
  editing: -1,
  editingKey: -1,
  query: '',
  caseSensitive: false,
  scope: 'all',
  mode: 'text',
  conditions: [],
  siblingHits: new Set(),
  matches: [],
  matchSet: new Set(),
  matchPos: -1,
  view: 'tree',
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function highlight(text) {
  const q = state.query;
  if (!q) return esc(text);
  const hay = state.caseSensitive ? text : text.toLowerCase();
  const needle = state.caseSensitive ? q : q.toLowerCase();
  let out = '', i = 0;
  for (;;) {
    const hit = hay.indexOf(needle, i);
    if (hit === -1) { out += esc(text.slice(i)); break; }
    out += esc(text.slice(i, hit)) + '<mark>' + esc(text.slice(hit, hit + q.length)) + '</mark>';
    i = hit + q.length;
  }
  return out;
}

/* ---------------- 数据模型 ---------------- */

function buildModel(root) {
  const nodes = [];
  let maxDepth = 0;
  const stack = [{ val: root, parent: -1, key: null, prop: null, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    const id = nodes.length;
    const t = typeOf(item.val);
    const node = {
      id, p: item.parent, k: item.key, prop: item.prop, d: item.depth,
      t, val: item.val, c: 0, x: item.depth < 2,
    };
    nodes.push(node);
    if (item.depth > maxDepth) maxDepth = item.depth;
    if (t === 'object' || t === 'array') {
      const entries = t === 'array' ? item.val.map((v, i) => [i, v]) : Object.entries(item.val);
      node.c = entries.length;
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({ val: entries[i][1], parent: id, key: String(entries[i][0]), prop: entries[i][0], depth: item.depth + 1 });
      }
    }
  }
  state.nodes = nodes;
  state.maxDepth = maxDepth;
}

function rebuildRows() {
  const rows = [];
  const rowIndex = new Map();
  let skipBelow = Infinity;
  for (const n of state.nodes) {
    if (n.d > skipBelow) continue;
    skipBelow = Infinity;
    rowIndex.set(n.id, rows.length);
    rows.push(n.id);
    if (n.c > 0 && !n.x) skipBelow = n.d;
  }
  state.rows = rows;
  state.rowIndex = rowIndex;
  spacer.style.height = rows.length * ROW_H + 'px';
  renderVisible();
}

function pathProps(id) {
  const props = [];
  let n = state.nodes[id];
  while (n && n.p !== -1) {
    props.unshift(n.prop);
    n = state.nodes[n.p];
  }
  return props;
}

function pathString(id) {
  if (id <= 0) return '$';
  let out = '$';
  for (const prop of pathProps(id)) {
    if (typeof prop === 'number') out += '[' + prop + ']';
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop)) out += '.' + prop;
    else out += '[' + JSON.stringify(prop) + ']';
  }
  return out;
}

function findByProps(props) {
  let id = 0;
  outer: for (const prop of props) {
    const cur = state.nodes[id];
    for (let i = id + 1; i < state.nodes.length && state.nodes[i].d > cur.d; i++) {
      if (state.nodes[i].p === id && state.nodes[i].prop === prop) { id = i; continue outer; }
    }
    return -1;
  }
  return id;
}

function rebuildModel(keepPath) {
  buildModel(state.root);
  if (keepPath && keepPath.length) {
    let id = 0;
    state.nodes[0].x = true;
    for (let i = 0; i < keepPath.length; i++) {
      const next = findByProps(keepPath.slice(0, i + 1));
      if (next === -1) break;
      id = next;
      state.nodes[id].x = true;
    }
    state.selected = id;
  } else {
    state.selected = -1;
  }
  state.editing = -1;
  state.editingKey = -1;
  rebuildRows();
  updateStats();
  updateBreadcrumb();
  if (state.query || state.mode === 'sibling') runSearch();
}

/* ---------------- 渲染 ---------------- */

function valueHTML(n) {
  switch (n.t) {
    case 'object': return '<span class="val-bracket">{…}</span><span class="badge">' + n.c + ' 项</span>';
    case 'array': return '<span class="val-bracket">[…]</span><span class="badge">' + n.c + ' 项</span>';
    case 'string': {
      const full = n.val;
      const shown = full.length > STRING_PREVIEW ? full.slice(0, STRING_PREVIEW) + '…' : full;
      return '<span class="val-string" title="双击编辑值">"' + highlight(shown) + '"</span>';
    }
    case 'number': return '<span class="val-number" title="双击编辑值">' + highlight(String(n.val)) + '</span>';
    case 'boolean': return '<span class="val-boolean" title="双击编辑值">' + highlight(String(n.val)) + '</span>';
    default: return '<span class="val-null" title="双击编辑值">null</span>';
  }
}

function rowHTML(n) {
  const indent = 8 + n.d * 14;
  const caret = n.c > 0
    ? '<span class="caret' + (n.x ? ' open' : '') + '" data-act="toggle">▶</span>'
    : '<span class="caret leaf">▶</span>';
  let key = '';
  if (n.id === 0) key = '<span class="node-index">root</span>';
  else if (typeof n.prop === 'number') key = '<span class="node-index">' + n.k + '</span><span class="colon">:</span>';
  else if (state.editingKey === n.id) key = '<input class="edit-input edit-key" data-id="' + n.id + '" value="' + esc(n.k) + '" spellcheck="false"><span class="colon">:</span>';
  else key = '<span class="node-key" title="双击重命名键">"' + highlight(n.k) + '"</span><span class="colon">:</span>';

  let value;
  if (state.editing === n.id && n.t !== 'object' && n.t !== 'array') {
    const raw = n.t === 'string' ? n.val : JSON.stringify(n.val);
    value = '<input class="edit-input" data-id="' + n.id + '" value="' + esc(raw) + '" spellcheck="false">';
  } else {
    value = valueHTML(n);
  }

  const acts = [];
  acts.push('<button data-act="copy-path" title="复制路径">路径</button>');
  acts.push('<button data-act="copy-val" title="复制值">复制</button>');
  if (n.t === 'object' || n.t === 'array') acts.push('<button data-act="add" title="添加子节点">＋</button>');
  else acts.push('<button data-act="edit" title="编辑值">编辑</button>');
  if (n.id !== 0) acts.push('<button data-act="del" title="删除节点">✕</button>');

  const cls = 'row' + (state.selected === n.id ? ' selected' : '') +
    (state.siblingHits.has(n.id) ? ' sibling-hit' : '') +
    (state.matchPos >= 0 && state.matches[state.matchPos] === n.id ? ' current-match' : '');
  return '<div class="' + cls + '" data-id="' + n.id + '" style="padding-left:' + indent + 'px">' +
    caret + key + value + '<span class="row-actions">' + acts.join('') + '</span></div>';
}

let rafPending = false;
function renderVisible() {
  if (!state.loaded) return;
  const scrollTop = scroller.scrollTop;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const end = Math.min(state.rows.length, Math.ceil((scrollTop + scroller.clientHeight) / ROW_H) + 5);
  rowWindow.style.transform = 'translateY(' + start * ROW_H + 'px)';
  let html = '';
  for (let i = start; i < end; i++) html += rowHTML(state.nodes[state.rows[i]]);
  rowWindow.innerHTML = html;
  if (state.editing >= 0 || state.editingKey >= 0) {
    const input = rowWindow.querySelector('.edit-input');
    if (input) { input.focus(); input.select(); }
  }
}

scroller.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderVisible(); });
});

/* ---------------- 树交互 ---------------- */

rowWindow.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = Number(row.dataset.id);
  const actEl = e.target.closest('[data-act]');
  const act = actEl ? actEl.dataset.act : null;
  if (act === 'toggle') { toggle(id); return; }
  if (act === 'copy-path') { copyText(pathString(id), '已复制路径'); return; }
  if (act === 'copy-val') {
    const n = state.nodes[id];
    copyText(n.t === 'object' || n.t === 'array' ? JSON.stringify(n.val) : String(n.val), '已复制值');
    return;
  }
  if (act === 'edit') { startEdit(id); return; }
  if (act === 'add') { openAddModal(id); return; }
  if (act === 'del') { deleteNode(id); return; }
  if (e.target.classList.contains('edit-input')) return;
  state.selected = id;
  updateBreadcrumb();
  renderVisible();
});

rowWindow.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = Number(row.dataset.id);
  const n = state.nodes[id];
  if (e.target.closest('.node-key')) { startKeyEdit(id); return; }
  if (n.t === 'object' || n.t === 'array') toggle(id);
  else startEdit(id);
});

rowWindow.addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('edit-input')) return;
  const id = Number(e.target.dataset.id);
  const isKey = e.target.classList.contains('edit-key');
  if (e.key === 'Enter') { e.preventDefault(); if (isKey) commitKeyEdit(id, e.target.value); else commitEdit(id, e.target.value); }
  if (e.key === 'Escape') { e.preventDefault(); state.editing = -1; state.editingKey = -1; renderVisible(); }
});

rowWindow.addEventListener('focusout', (e) => {
  if (!e.target.classList.contains('edit-input')) return;
  const id = Number(e.target.dataset.id);
  if (e.target.classList.contains('edit-key')) { if (state.editingKey === id) commitKeyEdit(id, e.target.value); }
  else if (state.editing === id) commitEdit(id, e.target.value);
});

function toggle(id) {
  const n = state.nodes[id];
  if (n.c === 0) return;
  n.x = !n.x;
  rebuildRows();
}

function updateBreadcrumb() {
  $('breadcrumb').textContent = state.selected >= 0 ? pathString(state.selected) : '$';
}

function startEdit(id) {
  state.editing = id;
  state.editingKey = -1;
  state.selected = id;
  updateBreadcrumb();
  renderVisible();
}

function startKeyEdit(id) {
  const n = state.nodes[id];
  if (typeof n.prop !== 'string') { toast('数组索引不可重命名'); return; }
  state.editingKey = id;
  state.editing = -1;
  state.selected = id;
  updateBreadcrumb();
  renderVisible();
}

function commitKeyEdit(id, text) {
  state.editingKey = -1;
  const n = state.nodes[id];
  const newKey = text.trim();
  const oldKey = n.k;
  if (!newKey || newKey === oldKey) { renderVisible(); return; }
  const parent = state.nodes[n.p].val;
  if (Object.prototype.hasOwnProperty.call(parent, newKey)) {
    toast('键 "' + newKey + '" 已存在，未重命名');
    renderVisible();
    return;
  }
  const entries = Object.entries(parent);
  for (const k of Object.keys(parent)) delete parent[k];
  for (const [k, v] of entries) parent[k === oldKey ? newKey : k] = v;
  markDirty();
  rebuildModel(pathProps(n.p).concat(newKey));
  toast('已重命名为 ' + newKey);
}

function parseLoose(text) {
  try { return { ok: true, val: JSON.parse(text) }; }
  catch { return { ok: true, val: text }; }
}

function commitEdit(id, text) {
  state.editing = -1;
  const n = state.nodes[id];
  const { val } = parseLoose(text);
  const newType = typeOf(val);
  const structural = newType === 'object' || newType === 'array' || n.t === 'object' || n.t === 'array';
  const keep = pathProps(id);
  if (id === 0) state.root = val;
  else {
    const parent = state.nodes[n.p];
    parent.val[n.prop] = val;
  }
  markDirty();
  if (structural) rebuildModel(keep);
  else {
    n.val = val;
    n.t = newType;
    rebuildRows();
  }
  toast('已修改 ' + pathString(id));
}

function deleteNode(id) {
  const n = state.nodes[id];
  const path = pathString(id);
  if (!confirm('删除节点 ' + path + '？此操作可通过重新加载文件撤销。')) return;
  const parent = state.nodes[n.p];
  const keep = pathProps(n.p);
  if (Array.isArray(parent.val)) parent.val.splice(n.prop, 1);
  else delete parent.val[n.prop];
  markDirty();
  rebuildModel(keep);
  toast('已删除 ' + path);
}

/* ---------------- 弹窗 ---------------- */

let modalOk = null;
function openModal({ title, showKey, okText, text, onOk }) {
  $('modalTitle').textContent = title;
  $('modalKeyRow').hidden = !showKey;
  $('modalKey').value = '';
  $('modalText').value = text || '';
  $('modalError').hidden = true;
  $('modalOk').textContent = okText || '确定';
  modalOk = onOk;
  $('modalMask').hidden = false;
  (showKey ? $('modalKey') : $('modalText')).focus();
}

function closeModal() { $('modalMask').hidden = true; modalOk = null; }

$('modalCancel').addEventListener('click', closeModal);
$('modalMask').addEventListener('click', (e) => { if (e.target === $('modalMask')) closeModal(); });
$('modalOk').addEventListener('click', () => {
  if (!modalOk) return;
  const err = modalOk($('modalKey').value, $('modalText').value);
  if (err) { $('modalError').textContent = err; $('modalError').hidden = false; }
  else closeModal();
});

function openPasteModal() {
  openModal({
    title: '粘贴 JSON',
    okText: '加载',
    onOk: (_key, text) => {
      if (!text.trim()) return '请粘贴 JSON 内容';
      try {
        const val = JSON.parse(text);
        loadValue(val, '粘贴的 JSON.json', new Blob([text]).size, null);
        return null;
      } catch (err) { return 'JSON 解析失败：' + err.message; }
    },
  });
}

function openAddModal(id) {
  const n = state.nodes[id];
  const isObj = n.t === 'object';
  openModal({
    title: isObj ? '添加键值对到 ' + pathString(id) : '追加元素到 ' + pathString(id),
    showKey: isObj,
    okText: '添加',
    text: '""',
    onOk: (key, text) => {
      if (isObj && !key.trim()) return '请输入键名';
      if (isObj && Object.prototype.hasOwnProperty.call(n.val, key)) return '键 "' + key + '" 已存在';
      let val;
      try { val = JSON.parse(text); }
      catch (err) { return '值不是合法 JSON：' + err.message; }
      const keep = pathProps(id);
      if (isObj) n.val[key] = val;
      else n.val.push(val);
      markDirty();
      rebuildModel(keep);
      toast('已添加节点');
      return null;
    },
  });
}

/* ---------------- 搜索 ---------------- */

let searchTimer = 0;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $('searchInput').value;
    runSearch();
  }, 180);
});

$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
});

$('btnCase').addEventListener('click', () => {
  state.caseSensitive = !state.caseSensitive;
  $('btnCase').setAttribute('aria-pressed', String(state.caseSensitive));
  runSearch();
});
$('searchScope').addEventListener('change', () => { state.scope = $('searchScope').value; runSearch(); });
$('btnPrevMatch').addEventListener('click', () => gotoMatch(-1));
$('btnNextMatch').addEventListener('click', () => gotoMatch(1));
$('btnClearSearch').addEventListener('click', clearSearch);

function clearSearch() {
  $('searchInput').value = '';
  state.query = '';
  runSearch();
}

function runSearch() {
  state.matches = [];
  state.matchSet = new Set();
  state.siblingHits = new Set();
  state.matchPos = -1;
  if (state.mode === 'sibling') {
    runSiblingSearch();
    updateMatchInfo();
    renderVisible();
    return;
  }
  const q = state.query;
  if (q && state.loaded) {
    const needle = state.caseSensitive ? q : q.toLowerCase();
    for (const n of state.nodes) {
      if (n.id === 0) continue;
      let hit = false;
      if (state.scope !== 'value' && n.k != null) {
        const k = state.caseSensitive ? n.k : n.k.toLowerCase();
        hit = k.includes(needle);
      }
      if (!hit && state.scope !== 'key' && n.c === 0) {
        const s = String(n.val);
        hit = (state.caseSensitive ? s : s.toLowerCase()).includes(needle);
      }
      if (hit) {
        state.matches.push(n.id);
        state.matchSet.add(n.id);
        if (state.matches.length >= MATCH_CAP) break;
      }
    }
  }
  updateMatchInfo();
  renderVisible();
}

function valueEquals(val, text) {
  const t = text.trim();
  const s = String(val);
  const a = state.caseSensitive ? s : s.toLowerCase();
  const b = state.caseSensitive ? t : t.toLowerCase();
  return a === b;
}

function runSiblingSearch() {
  if (!state.loaded) return;
  const conds = state.conditions.filter((c) => c.key.trim() !== '');
  if (!conds.length) return;
  for (const n of state.nodes) {
    if (n.t !== 'object') continue;
    let ok = true;
    for (const c of conds) {
      if (!Object.prototype.hasOwnProperty.call(n.val, c.key) || !valueEquals(n.val[c.key], c.value)) { ok = false; break; }
    }
    if (!ok) continue;
    state.matches.push(n.id);
    state.matchSet.add(n.id);
    for (let i = n.id + 1; i < state.nodes.length && state.nodes[i].d > n.d; i++) {
      const child = state.nodes[i];
      if (child.p === n.id && conds.some((c) => child.k === c.key && valueEquals(child.val, c.value))) {
        state.siblingHits.add(child.id);
      }
    }
    if (state.matches.length >= MATCH_CAP) break;
  }
}

function renderConditions() {
  const list = $('condList');
  list.innerHTML = state.conditions.map((c, i) =>
    '<div class="cond" data-i="' + i + '">' +
    '<input class="cond-key" data-i="' + i + '" placeholder="键名 name" value="' + esc(c.key) + '" spellcheck="false" aria-label="条件键名">' +
    '<span class="cond-eq">=</span>' +
    '<input class="cond-val" data-i="' + i + '" placeholder="值 EC3" value="' + esc(c.value) + '" spellcheck="false" aria-label="条件值">' +
    '<button class="cond-del" data-i="' + i + '" title="删除条件">✕</button>' +
    '</div>'
  ).join('');
}

let condTimer = 0;
$('condList').addEventListener('input', (e) => {
  const i = Number(e.target.dataset.i);
  if (!state.conditions[i]) return;
  if (e.target.classList.contains('cond-key')) state.conditions[i].key = e.target.value;
  else if (e.target.classList.contains('cond-val')) state.conditions[i].value = e.target.value;
  clearTimeout(condTimer);
  condTimer = setTimeout(runSearch, 180);
});

$('condList').addEventListener('click', (e) => {
  const del = e.target.closest('.cond-del');
  if (!del) return;
  state.conditions.splice(Number(del.dataset.i), 1);
  renderConditions();
  runSearch();
});

$('btnAddCond').addEventListener('click', () => {
  state.conditions.push({ key: '', value: '' });
  renderConditions();
  const keys = $('condList').querySelectorAll('.cond-key');
  keys[keys.length - 1].focus();
});

$('searchMode').addEventListener('change', () => {
  state.mode = $('searchMode').value;
  const sibling = state.mode === 'sibling';
  document.querySelector('.search-input-wrap').hidden = sibling;
  $('searchScope').hidden = sibling;
  $('siblingBar').hidden = !sibling;
  if (sibling && state.conditions.length === 0) {
    state.conditions = [{ key: '', value: '' }, { key: '', value: '' }];
  }
  renderConditions();
  runSearch();
});

function updateMatchInfo() {
  const len = state.matches.length;
  const info = $('matchInfo');
  const active = state.mode === 'sibling'
    ? state.conditions.some((c) => c.key.trim() !== '')
    : !!state.query;
  if (!active) info.textContent = state.mode === 'sibling' ? '输入条件' : '输入以搜索';
  else if (len === 0) info.textContent = '无匹配';
  else {
    const cap = len >= MATCH_CAP ? '+' : '';
    info.textContent = state.matchPos >= 0
      ? (state.matchPos + 1) + ' / ' + len + cap
      : len + cap + ' 处匹配';
  }
  $('btnPrevMatch').disabled = len === 0;
  $('btnNextMatch').disabled = len === 0;
}

function gotoMatch(delta) {
  const len = state.matches.length;
  if (!len) return;
  state.matchPos = state.matchPos < 0
    ? (delta > 0 ? 0 : len - 1)
    : (state.matchPos + delta + len) % len;
  const id = state.matches[state.matchPos];
  const target = state.nodes[id];
  let changed = false;
  if (target.c > 0 && !target.x) { target.x = true; changed = true; }
  let n = target;
  while (n.p !== -1) {
    n = state.nodes[n.p];
    if (n.c > 0 && !n.x) { n.x = true; changed = true; }
  }
  if (changed) rebuildRows();
  state.selected = id;
  updateBreadcrumb();
  const idx = state.rowIndex.get(id);
  if (idx != null) {
    scroller.scrollTop = Math.max(0, idx * ROW_H - scroller.clientHeight / 2);
  }
  updateMatchInfo();
  renderVisible();
}

$('btnExpandAll').addEventListener('click', () => {
  for (const n of state.nodes) n.x = n.d < 2;
  rebuildRows();
});
$('btnCollapseAll').addEventListener('click', () => {
  for (const n of state.nodes) n.x = n.id === 0;
  rebuildRows();
});

/* ---------------- 加载 / 保存 ---------------- */

function loadValue(val, name, size, handle) {
  const t0 = performance.now();
  buildModel(val);
  const ms = performance.now() - t0;
  state.root = val;
  state.fileName = name;
  state.fileSize = size;
  state.fileHandle = handle;
  state.dirty = false;
  state.loaded = true;
  state.selected = -1;
  state.editing = -1;
  state.editingKey = -1;
  state.query = '';
  $('searchInput').value = '';
  state.matches = [];
  state.matchSet = new Set();
  state.siblingHits = new Set();
  state.matchPos = -1;
  $('emptyState').hidden = true;
  $('searchbar').hidden = false;
  $('btnSave').disabled = false;
  $('btnDownload').disabled = false;
  state.rows = [];
  state.rowIndex = new Map();
  rebuildRows();
  setView('tree');
  updateStats();
  runSearch();
  updateBreadcrumb();
  updateDirty();
  $('stParse').textContent = '建模 ' + ms.toFixed(0) + ' ms';
  $('stMsg').textContent = '';
  scroller.scrollTop = 0;
  renderVisible();
}

function loadText(text, name, size, handle) {
  let val;
  const t0 = performance.now();
  try { val = JSON.parse(text); }
  catch (err) {
    toast('JSON 解析失败：' + err.message);
    $('stMsg').textContent = '解析失败：' + err.message;
    return;
  }
  const parseMs = performance.now() - t0;
  loadValue(val, name, size, handle);
  $('stParse').textContent = '解析 ' + parseMs.toFixed(0) + ' ms · 建模 ' + $('stParse').textContent.replace('建模 ', '');
}

async function openFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON 文件', accept: { 'application/json': ['.json', '.txt'] } }],
      });
      const file = await handle.getFile();
      loadText(await file.text(), file.name, file.size, handle);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  $('fileInput').click();
}

$('fileInput').addEventListener('change', async () => {
  const file = $('fileInput').files[0];
  $('fileInput').value = '';
  if (!file) return;
  loadText(await file.text(), file.name, file.size, null);
});

function markDirty() {
  state.dirty = true;
  updateDirty();
}

function updateDirty() {
  $('stDirty').hidden = !state.dirty;
}

function serialize() {
  return JSON.stringify(state.root, null, 2);
}

function downloadCopy() {
  const blob = new Blob([serialize()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.fileName.endsWith('.json') ? state.fileName : state.fileName + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function save() {
  if (!state.loaded) return;
  const text = serialize();
  if (state.fileHandle) {
    try {
      const writable = await state.fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
      state.dirty = false;
      updateDirty();
      toast('已保存到 ' + state.fileName);
      return;
    } catch {
      toast('无法写回原文件，已改为下载副本');
    }
  }
  downloadCopy();
  state.dirty = false;
  updateDirty();
  toast('已下载 ' + state.fileName);
}

$('btnSave').addEventListener('click', save);
$('btnDownload').addEventListener('click', () => { downloadCopy(); toast('已下载副本'); });

function copyText(text, msg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(msg), () => toast('复制失败'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(msg); } catch { toast('复制失败'); }
    ta.remove();
  }
}

/* ---------------- 视图切换 ---------------- */

function setView(view) {
  state.view = view;
  $('btnTreeView').classList.toggle('active', view === 'tree');
  $('btnRawView').classList.toggle('active', view === 'raw');
  $('btnTreeView').setAttribute('aria-selected', String(view === 'tree'));
  $('btnRawView').setAttribute('aria-selected', String(view === 'raw'));
  $('treeView').hidden = view !== 'tree' || !state.loaded;
  $('rawView').hidden = view !== 'raw' || !state.loaded;
  if (view === 'raw' && state.loaded) {
    $('rawError').hidden = true;
    $('rawEditor').value = serialize();
  }
  if (view === 'tree') renderVisible();
}

$('btnTreeView').addEventListener('click', () => setView('tree'));
$('btnRawView').addEventListener('click', () => {
  if (!state.loaded) return;
  if (state.nodes.length > 300000 && !confirm('数据较大（' + state.nodes.length.toLocaleString() + ' 节点），生成源码文本可能需要几秒。继续？')) return;
  setView('raw');
});

$('btnApplyRaw').addEventListener('click', () => {
  const text = $('rawEditor').value;
  try {
    state.root = JSON.parse(text);
  } catch (err) {
    $('rawError').textContent = '解析失败：' + err.message;
    $('rawError').hidden = false;
    return;
  }
  markDirty();
  rebuildModel(null);
  setView('tree');
  toast('源码更改已应用');
});

/* ---------------- 状态栏 / 示例 ---------------- */

function updateStats() {
  $('stFile').textContent = state.fileName;
  $('stSize').textContent = fmtSize(state.fileSize);
  $('stNodes').textContent = state.nodes.length.toLocaleString() + ' 节点 · 深度 ' + state.maxDepth;
}

function sampleData() {
  return {
    service: 'order-gateway',
    version: '3.8.2',
    generatedAt: '2026-11-25T08:30:00Z',
    environment: { region: 'cn-hangzhou', cluster: 'prod-east-1', debug: false },
    limits: { qps: 12000, timeoutMs: 3000, retry: { maxAttempts: 3, backoffMs: 200 } },
    endpoints: [
      { path: '/api/orders', method: 'GET', auth: true, cacheTtlSec: 30, tags: ['read', 'hot'] },
      { path: '/api/orders', method: 'POST', auth: true, cacheTtlSec: 0, tags: ['write'] },
      { path: '/api/orders/{id}', method: 'DELETE', auth: true, cacheTtlSec: 0, tags: ['write', 'danger'] },
    ],
    features: { newCheckout: true, darkMode: true, betaSearch: false, rollout: { percent: 35, allowlist: ['u_1001', 'u_1002', 'u_2048'] } },
    recentErrors: [
      { code: 'E_TIMEOUT', count: 17, lastSeen: '2026-11-25T07:58:12Z', sample: { upstream: 'inventory-svc', latencyMs: 3021 } },
      { code: 'E_AUTH', count: 4, lastSeen: '2026-11-25T06:12:40Z', sample: { reason: 'token expired', userId: 'u_3307' } },
    ],
    channels: [
      { name: 'EC1', value: 0, unit: 'V' },
      { name: 'EC3', value: 1, unit: 'V' },
      { name: 'EC3', value: 2, unit: 'V' },
      { name: 'EC4', value: 1, unit: 'V' },
    ],
    notes: '示例数据：一个订单网关服务的配置与运行快照。试试搜索 timeout、双击键重命名、双击值编辑、或悬停行尾复制路径。',
  };
}

function stressData() {
  const cities = ['杭州', '上海', '北京', '深圳', '成都', '武汉'];
  const items = new Array(20000);
  for (let i = 0; i < items.length; i++) {
    items[i] = {
      id: i + 1,
      name: 'user_' + (100000 + i),
      active: i % 3 !== 0,
      score: Math.round((i * 37 % 1000) / 10) / 10,
      tags: ['t' + (i % 7), 't' + (i % 11), 't' + (i % 13)],
      address: { city: cities[i % cities.length], zip: String(310000 + i % 900) },
    };
  }
  return { dataset: 'stress-test', count: items.length, items };
}

function loadSample() {
  const val = sampleData();
  loadValue(val, '示例数据.json', new Blob([JSON.stringify(val)]).size, null);
  toast('已加载示例数据');
}

function loadStress() {
  const t0 = performance.now();
  const val = stressData();
  const genMs = performance.now() - t0;
  loadValue(val, '压测数据.json', new Blob([JSON.stringify(val)]).size, null);
  toast('已生成 ' + state.nodes.length.toLocaleString() + ' 节点（生成 ' + genMs.toFixed(0) + ' ms），滚动试试');
}

/* ---------------- 拖拽 ---------------- */

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('dropOverlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) { dragDepth = 0; $('dropOverlay').hidden = true; }
  else if (dragDepth > 0 && --dragDepth === 0) $('dropOverlay').hidden = true;
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  let handle = null;
  try {
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (item && item.getAsFileSystemHandle) {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === 'file') handle = h;
    }
  } catch { /* 无句柄时回退为下载保存 */ }
  loadText(await file.text(), file.name, file.size, handle);
});

/* ---------------- 快捷键 / 绑定 ---------------- */

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f' && state.loaded) {
    e.preventDefault();
    setView('tree');
    if (state.mode === 'sibling') {
      const key = $('condList').querySelector('.cond-key');
      if (key) { key.focus(); key.select(); }
    } else {
      $('searchInput').focus();
      $('searchInput').select();
    }
  }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.loaded) save(); }
  if (e.key === 'Escape' && !$('modalMask').hidden) closeModal();
});

$('btnOpen').addEventListener('click', openFile);
$('btnOpen2').addEventListener('click', openFile);
$('btnPaste').addEventListener('click', openPasteModal);
$('btnPaste2').addEventListener('click', openPasteModal);
$('btnSample').addEventListener('click', loadSample);
$('btnSample2').addEventListener('click', loadSample);
$('btnStress').addEventListener('click', loadStress);