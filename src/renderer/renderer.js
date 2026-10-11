(() => {
// 渲染层：Vditor 接入 + 文件生命周期 + 草稿
const bridge = window.bridge;

let vditor = null;
let currentPath = null;
let dirty = false;
let draftTimer = null;
let draftId = null; // 未命名文档的草稿身份（窗口无关，恢复后可续用）
let docEol = 'LF';   // 原文件的换行风格，保存时还原（否则一次保存全文件换行 diff）
let docEncoding = 'utf8'; // GBK 打开的文件保存时转 UTF-8 并提示
let theme = 'classic';
let mode = 'wysiwyg';

const basename = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : null;
const dirname = (p) => p ? p.replace(/[\\/][^\\/]+$/, '') : null;

// ---------- 侧栏 ----------
const $sidebar = () => document.getElementById('sidebar');
let treeRoot = null;
const dirCache = new Map();     // path → {dirs, files}
const expandedDirs = new Set(); // 展开中的目录（内存态，重启不记）

function switchTab(name) {
  document.querySelectorAll('#sidebar-tabs .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('sidebar-files').classList.toggle('hidden', name !== 'files');
  document.getElementById('sidebar-outline').classList.toggle('hidden', name !== 'outline');
}

async function dirList(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  const r = await bridge.invoke('dir.list', dir);
  if (r && !r.error) dirCache.set(dir, r);
  return r;
}

// ---------- 文件树（就地展开式，懒加载）----------
async function renderTree(rootDir) {
  const changed = rootDir !== treeRoot;
  treeRoot = rootDir;
  document.getElementById('dir-current').textContent = rootDir || '未打开文件';
  document.getElementById('dir-current').title = rootDir || '';
  const ul = document.getElementById('dir-list');
  ul.innerHTML = '';
  if (!rootDir) {
    ul.innerHTML = '<li class="empty">打开文档后显示同目录文件</li>';
    return;
  }
  if (changed) await bridge.invoke('dir.watch', rootDir); // 换根才换监听
  await appendDirItems(ul, rootDir, 0);
  if (!ul.children.length) ul.innerHTML = '<li class="empty">（无 md 文件）</li>';
}

async function appendDirItems(ul, dirPath, depth) {
  const r = await dirList(dirPath);
  if (!r || r.error) return;
  for (const d of r.dirs) {
    ul.appendChild(treeNode(d.name, d.path, 'dir', depth));
    if (expandedDirs.has(d.path)) await appendDirItems(ul, d.path, depth + 1);
  }
  for (const f of r.files) {
    ul.appendChild(treeNode(f.name, f.path, 'file', depth));
  }
}

function treeNode(name, p, type, depth) {
  const li = document.createElement('li');
  li.className = 'tree-node ' + type;
  li.style.paddingLeft = (10 + depth * 14) + 'px';
  li.dataset.path = p;
  li.dataset.type = type;
  if (type === 'dir') {
    const expanded = expandedDirs.has(p);
    li.innerHTML = `<span class="twistie">${expanded ? '▾' : '▸'}</span><span class="icon">�</span>`;
    li.appendChild(document.createTextNode(name));
    li.onclick = async () => {
      if (expandedDirs.has(p)) expandedDirs.delete(p); else expandedDirs.add(p);
      await renderTree(treeRoot);
    };
  } else {
    li.innerHTML = '<span class="twistie"></span><span class="icon">📄</span>';
    li.appendChild(document.createTextNode(name));
    if (currentPath === p) li.classList.add('current');
    li.onclick = () => openSidebarFile(p);
  }

  // 拖拽：文件和目录都可拖
  li.draggable = true;
  li.ondragstart = (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ path: p, type }));
    e.dataTransfer.effectAllowed = 'move';
  };
  // 目录是可投放目标（文件节点不接受，投到根走 dir-current）
  if (type === 'dir') attachDropTarget(li, p);

  // 右键菜单
  li.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (type === 'dir') {
      showCtxMenu(e.clientX, e.clientY, [
        ['新建 md 文件', () => ctxNewFile(p)],
        ['新建文件夹', () => ctxNewDir(p)],
        ['-'],
        ['重命名', () => ctxRename(p)],
        ['移到回收站', () => ctxTrash(p)]
      ]);
    } else {
      showCtxMenu(e.clientX, e.clientY, [
        ['打开', () => openSidebarFile(p)],
        ['重命名', () => ctxRename(p)],
        ['移到回收站', () => ctxTrash(p)]
      ]);
    }
  };
  return li;
}

async function openSidebarFile(p) {
  if (currentPath === p) return;
  if (!(await guardDirty())) return;
  const r = await bridge.invoke('file.read', p);
  if (r && !r.error) loadDoc(r.path, r.content, r);
  else alert('无法打开: ' + (r && r.error));
}

// ---------- 拖拽移动 ----------
function attachDropTarget(el, dirPath) {
  el.ondragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  };
  el.ondragleave = () => el.classList.remove('drop-target');
  el.ondrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
    if (!data || !data.path || data.path === dirPath) return;
    const r = await bridge.invoke('file.move', data.path, dirPath);
    if (!r || !r.ok) { alert('移动失败: ' + (r && r.error)); return; }
    // 拖的是当前文档 → 同步路径、监听、图片基准和草稿（树刷新由 dir:changed 负责）
    if (currentPath === data.path) {
      await bridge.invoke('draft.clear', data.path, null); // 旧路径的草稿身份作废
      currentPath = r.newPath;
      refreshTitle();
      setDocBase(currentPath);
      watchCurrentFile();
      flushDraft(); // 以新路径重建草稿
    }
  };
}

// 根目录头也可接投放（投到树根部）
function initSidebarDnD() {
  const el = document.getElementById('dir-current');
  el.ondragover = (e) => {
    if (!treeRoot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  };
  el.ondragleave = () => el.classList.remove('drop-target');
  el.ondrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
    if (!data || !data.path || !treeRoot) return;
    const r = await bridge.invoke('file.move', data.path, treeRoot);
    if (!r || !r.ok) { alert('移动失败: ' + (r && r.error)); return; }
    if (currentPath === data.path) {
      await bridge.invoke('draft.clear', data.path, null);
      currentPath = r.newPath;
      refreshTitle();
      setDocBase(currentPath);
      watchCurrentFile();
      flushDraft();
    }
  };
}

// ---------- 侧栏右键菜单 / 文件操作 ----------
function showCtxMenu(x, y, items) {
  const menu = document.getElementById('ctxmenu');
  menu.innerHTML = '';
  items.forEach(([label, fn]) => {
    if (label === '-') {
      const hr = document.createElement('div');
      hr.className = 'sep';
      menu.appendChild(hr);
      return;
    }
    const item = document.createElement('div');
    item.className = 'ctx-item';
    item.textContent = label;
    item.onclick = () => { hideCtxMenu(); fn(); };
    menu.appendChild(item);
  });
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctxmenu').classList.add('hidden');
}

// 简易输入框（Electron 渲染层没有 window.prompt）
function ctxPrompt(placeholder, def) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('inputdlg');
    const input = document.getElementById('inputdlg-input');
    input.placeholder = placeholder || '';
    input.value = def || '';
    dlg.classList.remove('hidden');
    input.focus();
    input.select();
    const done = (v) => { dlg.classList.add('hidden'); resolve(v); };
    document.getElementById('inputdlg-ok').onclick = () => done(input.value.trim() || null);
    document.getElementById('inputdlg-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    };
  });
}

async function ctxNewFile(dir) {
  const name = await ctxPrompt('文件名（含 .md）', '未命名.md');
  if (!name) return;
  const r = await bridge.invoke('fs.createFile', dir, name);
  if (!r || !r.ok) { alert('新建失败: ' + (r && r.error)); return; }
  openSidebarFile(r.path); // 建完直接打开
}

async function ctxNewDir(dir) {
  const name = await ctxPrompt('文件夹名', '新建文件夹');
  if (!name) return;
  const r = await bridge.invoke('fs.createDir', dir, name);
  if (!r || !r.ok) { alert('新建失败: ' + (r && r.error)); return; }
  expandedDirs.add(r.path); // 顺手展开新目录
}

async function ctxRename(p) {
  const name = await ctxPrompt('新名称', basename(p));
  if (!name || name === basename(p)) return;
  const r = await bridge.invoke('fs.rename', p, name);
  if (!r || !r.ok) { alert('重命名失败: ' + (r && r.error)); return; }
  if (currentPath === p) {
    currentPath = r.newPath;
    refreshTitle();
    watchCurrentFile();
  }
}

async function ctxTrash(p) {
  if (!window.confirm(`确定把「${basename(p)}」移到回收站？`)) return;
  const r = await bridge.invoke('fs.trash', p);
  if (!r || !r.ok) alert('删除失败: ' + (r && r.error));
}

function initCtxMenu() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtxMenu();
  });
  // 目录头/空白区的右键 → 在树根新建
  const newInRoot = (e) => {
    e.preventDefault();
    if (!treeRoot) return;
    showCtxMenu(e.clientX, e.clientY, [
      ['新建 md 文件', () => ctxNewFile(treeRoot)],
      ['新建文件夹', () => ctxNewDir(treeRoot)]
    ]);
  };
  document.getElementById('dir-current').oncontextmenu = newInRoot;
  document.getElementById('dir-list').oncontextmenu = (e) => {
    if (e.target.closest('li')) return; // 节点自己处理
    newInRoot(e);
  };
}

// ---------- 大纲 ----------
let outlineHeads = [];   // [{level,text,line}] 供拖拽定位
let outlineTimer = null;
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 400);
}

function extractHeads(md) {
  const heads = [];
  let inFence = false;
  md.split('\n').forEach((line, i) => {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (inFence) return;
    const m = line.match(/^(#{1,6})\s+(.+)/);
    if (m) heads.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  return heads;
}

function renderOutline() {
  const ul = document.getElementById('outline-list');
  ul.innerHTML = '';
  const md = vditor ? vditor.getValue() : '';
  outlineHeads = extractHeads(md);
  if (!outlineHeads.length) {
    ul.innerHTML = '<li class="empty">（无标题）</li>';
    return;
  }
  outlineHeads.forEach((h, i) => {
    const li = document.createElement('li');
    li.className = 'lv' + h.level;
    li.textContent = h.text;
    li.title = h.text;
    li.draggable = true;
    li.onclick = () => scrollToHeading(i);
    li.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
    };
    li.ondragover = (e) => {
      e.preventDefault();
      const r = li.getBoundingClientRect();
      li.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
      li.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
    };
    li.ondragleave = () => li.classList.remove('drop-before', 'drop-after');
    li.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const before = li.classList.contains('drop-before');
      li.classList.remove('drop-before', 'drop-after');
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (Number.isInteger(from)) moveSection(from, i, before);
    };
    ul.appendChild(li);
  });
}

// 标题 i 的 section = [head.line, 下一个 level<=它的标题行)，含全部子级
function sectionRange(lines, heads, i) {
  const start = heads[i].line;
  let end = lines.length;
  for (let j = i + 1; j < heads.length; j++) {
    if (heads[j].level <= heads[i].level) { end = heads[j].line; break; }
  }
  return [start, end];
}

function moveSection(fromIdx, toIdx, before) {
  if (fromIdx === toIdx) return;
  const md = vditor.getValue();
  const lines = md.split('\n');
  const heads = outlineHeads;
  if (fromIdx < 0 || fromIdx >= heads.length || toIdx >= heads.length) return;

  const [srcStart, srcEnd] = sectionRange(lines, heads, fromIdx);
  // 拖到自己 section 内部 = 无操作
  const [tgtStart, tgtEnd] = sectionRange(lines, heads, toIdx);
  if (before && tgtStart === srcStart) return;
  if (!before && tgtEnd === srcEnd) return;

  const insertLine = before ? tgtStart : tgtEnd;
  if (insertLine >= srcStart && insertLine < srcEnd) return; // 投进自身区间
  const moving = lines.slice(srcStart, srcEnd);
  const rest = lines.slice(0, srcStart).concat(lines.slice(srcEnd));
  const adj = insertLine > srcEnd ? insertLine - (srcEnd - srcStart) : insertLine;
  if (adj === srcStart || adj < 0 || adj > rest.length) return; // 原地或越界
  const out = rest.slice(0, adj).concat(moving, rest.slice(adj)).join('\n');
  vditor.setValue(out);
  markDirty();
  scheduleOutline();
}

function scrollToHeading(index) {
  const heads = document.querySelectorAll(
    '#vditor h1, #vditor h2, #vditor h3, #vditor h4, #vditor h5, #vditor h6');
  const el = heads[index];
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sidebarRefresh() {
  renderTree(currentPath ? dirname(currentPath) : null);
  scheduleOutline();
}

// 目录内容变化（外部增删改 / 拖拽移动后）→ 清缓存重画
bridge.onDirChanged(() => {
  dirCache.clear();
  if (treeRoot) renderTree(treeRoot);
});

async function setSidebar(visible) {
  $sidebar().classList.toggle('hidden', !visible);
  await bridge.invoke('setting.put', 'sidebar', visible);
}

// ---------- 查找/替换 ----------
const $find = (id) => document.getElementById(id);
let findHidSidebar = false; // 查找期间临时藏侧栏，限定搜索范围在编辑区

function showFind() {
  const sb = $sidebar();
  findHidSidebar = !sb.classList.contains('hidden');
  if (findHidSidebar) sb.classList.add('hidden');
  $find('findbar').classList.remove('hidden');
  $find('find-input').focus();
  $find('find-input').select();
}

function hideFind() {
  if (findHidSidebar) {
    $sidebar().classList.remove('hidden');
    findHidSidebar = false;
  }
  $find('findbar').classList.add('hidden');
  bridge.invoke('find.stop');
  vditor && vditor.focus();
}

function initFindbar() {
  const input = $find('find-input');
  input.oninput = () => bridge.invoke('find', input.value, true, false);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') bridge.invoke('find', input.value, !e.shiftKey, true);
    if (e.key === 'Escape') hideFind();
  };
  $find('find-prev').onclick = () => bridge.invoke('find', input.value, false, true);
  $find('find-next').onclick = () => bridge.invoke('find', input.value, true, true);
  $find('find-close').onclick = hideFind;
  $find('replace-input').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Escape') hideFind(); }
  };
  $find('replace-all').onclick = async () => {
    const from = input.value, to = $find('replace-input').value;
    if (!from || !vditor) return;
    const md = vditor.getValue();
    const cnt = md.split(from).length - 1;
    if (!cnt) { alert('未找到: ' + from); return; }
    if (!window.confirm(`确定把 ${cnt} 处「${from}」替换为「${to}」？`)) return;
    vditor.setValue(md.split(from).join(to));
    markDirty();
  };
  bridge.onFindResult((r) => {
    $find('find-count').textContent = r.matches ? `${r.active}/${r.matches}` : '0/0';
  });
}

// ---------- 外部修改 ----------
function initFileWatch() {
  bridge.onFileChanged(async (p) => {
    if (p !== currentPath) return;
    if (!dirty) {
      // 干净文档 → 直接重载
      const r = await bridge.invoke('file.read', p);
      if (r && !r.error) loadDoc(r.path, r.content);
    } else {
      // 有未保存修改 → 横幅提示
      document.getElementById('conflictbar').classList.remove('hidden');
    }
  });
  document.getElementById('cf-reload').onclick = async () => {
    const r = await bridge.invoke('file.read', currentPath);
    if (r && !r.error) {
      loadDoc(r.path, r.content);
      document.getElementById('conflictbar').classList.add('hidden');
    } else alert('无法重载: ' + (r && r.error));
  };
  document.getElementById('cf-ignore').onclick = () => {
    document.getElementById('conflictbar').classList.add('hidden');
  };
}

async function watchCurrentFile() {
  await bridge.invoke('file.watch', currentPath);
}

const refreshTitle = () => {
  document.title = (basename(currentPath) || 'untitled') + (dirty ? ' •' : '') + ' — Blue Editor';
};

const markDirty = () => {
  if (!dirty) { dirty = true; refreshTitle(); }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 1500);
};

const flushDraft = () => {
  if (!vditor) return;
  // 未命名文档第一次写草稿时生成稳定身份；之后恢复/清理都按它走
  if (!currentPath && !draftId) draftId = 'w' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  bridge.invoke('draft.save', { path: currentPath, draftId, content: vditor.getValue() });
};

const markClean = async () => {
  dirty = false;
  refreshTitle();
  clearTimeout(draftTimer);
  // 草稿只在保存成功后清（见 save/saveAs）；loadDoc 不清，避免丢恢复数据
};

async function uploadHandler(files) {
  const succMap = {};
  const errFiles = [];
  for (const f of files) {
    try {
      if (currentPath) {
        const buf = await f.arrayBuffer();
        succMap[f.name] = await bridge.invoke('asset.save', currentPath, f.name, Array.from(new Uint8Array(buf)));
      } else {
        succMap[f.name] = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
      }
    } catch (e) {
      errFiles.push(f.name);
    }
  }
  return JSON.stringify({ msg: '', code: 0, data: { errFiles, succMap } });
}

let editorReady = Promise.resolve();
let bootResolve;
const bootReady = new Promise((r) => { bootResolve = r; });

function createEditor(initialValue) {
  editorReady = new Promise((resolve) => {
    vditor = new Vditor('vditor', {
    cdn: '../../node_modules/vditor',
    height: '100%',
    mode,
    theme,
    value: initialValue,
    cache: { enable: false },
    toolbar: [
      'undo', 'redo', '|',
      'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'quote', 'line', 'code', 'inline-code', 'table', '|',
      'upload', '|',
      'edit-mode', 'preview', 'fullscreen', 'outline', '|',
      'export', 'devtools'
    ],
    toolbarConfig: { pin: true },
    counter: { enable: true },
    outline: { enable: false, position: 'left' },
    link: { isOpen: false },
    upload: { handler: uploadHandler },
    input: () => { markDirty(); scheduleOutline(); },
    blur: () => { if (dirty) flushDraft(); },
    after: () => {
      // 深色主题：皮肤由构造参数带上，内容/代码高亮主题要在这里补一次
      // （包括启动和模式切换重建，两处都走到）
      if (theme === 'dark') {
        try { vditor.setTheme('dark', 'dark', 'github-dark'); } catch (e) {}
      }
      // link.click 选项在合并时被丢弃，只能在 inner 就绪后手动挂上
      try {
        vditor.vditor.options.link = vditor.vditor.options.link || {};
        vditor.vditor.options.link.click = (a) => openLink(a.getAttribute('href'));
      } catch (e) {}
      resolve();
    }
    });
  });
  return vditor;
}

// 相对路径图片/链接按文档所在目录解析（Lute 渲染前设好 base；
// 新建、另存为、移动文档都要重新指）
function setDocBase(p) {
  try { if (p && vditor.vditor.lute) vditor.vditor.lute.SetLinkBase('file:///' + dirname(p).replace(/\\/g, '/') + '/'); } catch (e) {}
}

// 文档内链接点击：http(s)/mailto 交系统浏览器；#anchor 页内跳转；
// 相对 .md 链接按文档目录解析后在编辑器里打开；其余一律不理
async function openLink(href) {
  if (!href) return;
  if (/^https?:/i.test(href) || href.startsWith('mailto:')) {
    bridge.invoke('shell.openExternal', href);
    return;
  }
  if (href.startsWith('#')) {
    const el = document.getElementById(decodeURIComponent(href.slice(1)));
    if (el) el.scrollIntoView();
    return;
  }
  if (/^file:/i.test(href)) {
    // linkBase 会把相对链接改写成 file:/// 绝对路径——md 系当文档打开，其余不理
    const p = decodeURIComponent(href.replace(/^file:\/+/, '').replace(/\//g, '\\'));
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (!['.md', '.markdown', '.mdown', '.txt'].includes(ext)) return;
    if (!(await guardDirty())) return;
    const r = await bridge.invoke('file.read', p);
    if (r && !r.error) loadDoc(r.path, r.content);
    else alert('无法打开链接: ' + href);
    return;
  }
  if (!currentPath) return;
  const base = href.split('#')[0];
  const full = dirname(currentPath).replace(/\\/g, '/') + '/' + base;
  const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
  if (!['.md', '.markdown', '.mdown', '.txt'].includes(ext)) return;
  if (!(await guardDirty())) return;
  const r = await bridge.invoke('file.read', full);
  if (r && !r.error) loadDoc(r.path, r.content);
  else alert('无法打开链接: ' + href);
}

// 修改未保存时的护栏
async function guardDirty() {
  if (!dirty) return true;
  if (vditor) flushDraft();
  const ok = window.confirm('当前文档有未保存修改，仍要继续吗？\n（自动草稿已写入 userData/drafts）');
  if (ok) {
    // 用户明确放弃修改 → 把草稿也清掉，否则下次启动又复活成脏窗口
    await bridge.invoke('draft.clear', currentPath, draftId);
    draftId = null;
  }
  return ok;
}

function loadDoc(path, content, meta) {
  currentPath = path;
  dirty = false;
  docEol = /\r\n/.test(content) ? 'CRLF' : 'LF';
  docEncoding = (meta && meta.encoding) || 'utf8';
  setDocBase(path);
  vditor.setValue(content);
  markClean();
  sidebarRefresh();
  watchCurrentFile();
  if (docEncoding !== 'utf8') {
    alert('该文件不是 UTF-8 编码（已按 ' + docEncoding.toUpperCase() + ' 解码显示）。\n保存时将转换为 UTF-8。');
  }
}

// 保存用的源文本：按原文件换行风格还原（Vditor 内部统一 LF）
function getSaveContent() {
  const v = vditor.getValue();
  return docEol === 'CRLF' ? v.replace(/\n/g, '\r\n') : v;
}

async function save() {
  if (!currentPath) return saveAs();
  const r = await bridge.invoke('file.save', currentPath, getSaveContent());
  if (r && r.ok) {
    await bridge.invoke('draft.clear', currentPath, draftId);
    draftId = null;
    docEncoding = 'utf8'; // 保存后盘上就是 UTF-8
    markClean();
  } else alert('保存失败: ' + (r && r.error));
}

async function saveAs() {
  const prevPath = currentPath, prevDraft = draftId;
  const r = await bridge.invoke('file.saveAs', getSaveContent(), currentPath || 'untitled.md');
  if (r && r.ok) {
    await bridge.invoke('draft.clear', prevPath, prevDraft); // 清旧身份的草稿
    currentPath = r.path;
    draftId = null;
    docEncoding = 'utf8';
    setDocBase(currentPath); // 目录变了，图片/链接的相对路径基准跟着换
    markClean();
    watchCurrentFile();
  }
}

function setMode(m) {
  const content = vditor.getValue();
  mode = m;
  vditor.destroy();
  vditor = createEditor(content);
}

async function setTheme(t) {
  theme = t;
  document.body.classList.toggle('dark', t === 'dark');
  // 三参：编辑器皮肤 + 内容主题 + 代码高亮主题（之前只传了编辑器皮肤，
  // 深色下代码块/正文样式没跟着换 → 白块）
  if (t === 'dark') {
    vditor.setTheme('dark', 'dark', 'github-dark');
  } else {
    vditor.setTheme('classic', 'light', 'github');
  }
  await bridge.invoke('setting.put', 'theme', t);
}

bridge.onMenuAction(async (action, payload) => {
  await bootReady;      // 等 IIFE 完成（createEditor 已就位）
  await editorReady;    // 再等编辑器 after 回调

  switch (action) {
    case 'file:new':
      if (await guardDirty()) {
        currentPath = null;
        vditor.setValue('');
        markClean();
        sidebarRefresh();
      }
      break;
    case 'file:open': {
      if (!(await guardDirty())) break;
      const r = await bridge.invoke('file.openDialog');
      if (r && !r.error) loadDoc(r.path, r.content, r);
      else if (r && r.error) alert('无法打开: ' + r.error);
      break;
    }
    case 'file:openPath': {
      if (!(await guardDirty())) break;
      const r = await bridge.invoke('file.read', payload);
      if (r && !r.error) loadDoc(r.path, r.content, r);
      else alert('无法打开: ' + (r && r.error));
      break;
    }
    case 'file:newPath': {
      // argv 指定的尚不存在的路径 → 新建到该路径
      if (!(await guardDirty())) break;
      currentPath = payload;
      dirty = true;
      docEol = 'LF'; docEncoding = 'utf8';
      setDocBase(currentPath);
      vditor.setValue('');
      refreshTitle();
      sidebarRefresh();
      watchCurrentFile();
      break;
    }
    case 'file:save': await save(); break;
    case 'file:saveAs': await saveAs(); break;
    case 'view:mode': setMode(payload); break;
    case 'view:theme': await setTheme(payload); break;
    case 'export:pdf':
      await bridge.invoke('export.pdf', exportName('.pdf'));
      break;
    case 'export:html':
      await bridge.invoke('export.html', buildHTMLDoc(), exportName('.html'));
      break;
    case 'export:png': {
      const vd = document.getElementById('vditor');
      const box = vd.getBoundingClientRect();
      // 真正的滚动容器是 .vditor-reset（scrollHeight=全文高），不是 .vditor-content
      const content = document.querySelector('#vditor .vditor-reset')
        || document.querySelector('#vditor .vditor-content');
      // mermaid/echarts 等是视口懒渲染——先滚到底触发，再回顶
      if (content) {
        content.scrollTop = content.scrollHeight;
        await new Promise(r => setTimeout(r, 800));
        content.scrollTop = 0;
      }
      // clip = 编辑区完整高度（含滚动外内容，上限 16383 受纹理限制）
      const h = Math.min((content ? content.scrollHeight : box.height) + 20, 16383);
      const r = await bridge.invoke('export.png',
        { x: Math.round(box.left), y: 0,
          width: Math.round(box.width), height: Math.round(h), testPath: null },
        exportName('.png'));
      if (r && r.ok === false) alert('PNG 导出失败: ' + r.error);
      break;
    }
    case 'export:pandoc': {
      const ext = payload || 'docx';
      const r = await bridge.invoke('pandoc.export', vditor.getValue(), exportName('.' + ext), payload || null, currentPath);
      if (r && r.ok === false) alert('导出失败: ' + r.error);
      break;
    }
    case 'import:pandoc': {
      const r = await bridge.invoke('pandoc.import');
      if (!r) break;
      if (!r.ok) { alert('Pandoc 导入失败: ' + r.error); break; }
      if (!(await guardDirty())) break;
      currentPath = null;          // 导入内容落在未命名文档，等用户另存
      vditor.setValue(r.content || '');
      dirty = true;
      refreshTitle();
      sidebarRefresh();
      break;
    }
    case 'edit:undo':
      try { vditor.focus(); vditor.vditor.undo.undo(vditor.vditor); } catch (e) {}
      break;
    case 'edit:redo':
      try { vditor.focus(); vditor.vditor.undo.redo(vditor.vditor); } catch (e) {}
      break;
    case 'app:flushDraft': flushDraft(); break; // 更新安装前主进程要求写盘
    case 'view:sidebar': await setSidebar(payload); break;
    case 'view:toolbar': {
      document.body.classList.toggle('no-toolbar', !payload);
      await bridge.invoke('setting.put', 'toolbar', !!payload);
      break;
    }
    case 'edit:find': showFind(); break;
    case 'draft:restore': {
      // 启动时主进程推来的未保存草稿（按文档各一份）
      currentPath = payload.path || null;
      draftId = payload.draftId || null;
      dirty = true;
      if (currentPath) setDocBase(currentPath);
      vditor.setValue(payload.content || '');
      dirty = true; refreshTitle(); // 草稿本身是未保存状态
      sidebarRefresh();
      watchCurrentFile();
      break;
    }
    case 'app:closeRequest': {
      if (!dirty) { await bridge.invoke('app.closeNow'); break; }
      const r = await bridge.invoke('app.confirmClose');
      if (r === 0) {          // 保存并关闭
        await save();
        if (!dirty) await bridge.invoke('app.closeNow'); // 保存成功才关
      } else if (r === 1) {   // 不保存
        // 明确放弃修改 → 草稿一并清掉，否则下次启动复活成脏窗口
        await bridge.invoke('draft.clear', currentPath, draftId);
        draftId = null;
        await bridge.invoke('app.closeNow');
      }
      // 2 = 取消 → 留在原地
      break;
    }
  }
});

const exportName = (ext) =>
  (basename(currentPath) || 'untitled').replace(/\.[^.]+$/, '') + ext;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 用 Vditor.preview 离屏渲染整篇（数学/图表/代码高亮全部落 DOM），
// 本地图片内嵌为 data: URI（file:// 绝对路径发出去就是裂图），
// 样式经 export.cssBundle 全内联 → 单文件可移植
async function buildHTMLDoc() {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:860px;';
  document.body.appendChild(host);
  try {
    await Vditor.preview(host, vditor.getValue(), { cdn: '../../node_modules/vditor' });
    const base = currentPath ? dirname(currentPath).replace(/\\/g, '/') : null;
    await Promise.all([...host.querySelectorAll('img')].map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || /^(data:|https?:)/i.test(src)) return;
      // linkBase 已把相对路径改成 file:///，两种形式都认
      const p = /^file:/i.test(src)
        ? decodeURIComponent(src.replace(/^file:\/+/, ''))
        : (base ? base + '/' + src : null);
      if (!p) return;
      const r = await bridge.invoke('file.readBase64', p);
      if (r && r.ok) img.setAttribute('src', `data:${r.mime};base64,${r.base64}`);
    }));
    const css = await bridge.invoke('export.cssBundle');
    return '<!doctype html><html><head><meta charset="utf-8"><title>' +
      escapeHtml(basename(currentPath) || 'untitled') +
      '</title><style>' + css +
      '\nbody{max-width:860px;margin:2em auto;padding:0 1em}' +
      '</style></head><body class="vditor-reset">' + host.innerHTML + '</body></html>';
  } finally {
    host.remove();
  }
}

(async () => {
  theme = (await bridge.invoke('setting.get', 'theme')) || 'classic';
  document.body.classList.toggle('dark', theme === 'dark');
  if ((await bridge.invoke('setting.get', 'sidebar')) === false) {
    $sidebar().classList.add('hidden');
  }
  // 工具栏默认隐藏（视图菜单勾选显示）
  if ((await bridge.invoke('setting.get', 'toolbar')) !== true) {
    document.body.classList.add('no-toolbar');
  }
  document.querySelectorAll('#sidebar-tabs .tab').forEach(t => {
    t.onclick = () => switchTab(t.dataset.tab);
  });
  initSidebarDnD();
  initFindbar();
  initFileWatch();
  initCtxMenu();
  // 未保存草稿由主进程启动时经 draft:restore 推送到本窗口
  vditor = createEditor('');
  refreshTitle();
  bootResolve();
  sidebarRefresh();
})();

// 调试/自动化句柄
window.__ed = {
  get vditor() { return vditor; },
  get path() { return currentPath; },
  get dirty() { return dirty; },
  save, saveAs, setMode,
  // 测试句柄
  buildHTMLDoc, flushDraft, extractHeads, moveSection, renderTree, expandedDirs, dirCache,
  get outlineHeads() { return outlineHeads; }
};

})();
