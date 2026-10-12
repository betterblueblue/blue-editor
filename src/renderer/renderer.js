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
let theme = 'nordic';
let mode = 'wysiwyg';

const basename = (p) => p ? p.replace(/\\/g, '/').split('/').pop() : null;
const dirname = (p) => p ? p.replace(/[\\/][^\\/]+$/, '') : null;

// ---------- 中文排版修正 ----------
// 自写规则：先占位保护代码/数学/链接地址/URL/HTML 标签，再对正文做
// 中英文间空格 + CJK 相邻半角标点转全角（, ; : ! ?——其余符号误伤面太大不碰）
function applyCnTypography(md) {
  const slots = [];
  const stash = (s) => { slots.push(s); return '\u0000' + (slots.length - 1) + '\u0000'; };
  let t = md
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, m => stash(m)) // YAML front matter
    .replace(/```[\s\S]*?(```|$)/g, m => stash(m))
    .replace(/`[^`\n]+`/g, m => stash(m))
    .replace(/\$\$[\s\S]*?\$\$|\$[^\n$]+\$/g, m => stash(m))
    .replace(/<!--[\s\S]*?-->/g, m => stash(m))
    .replace(/^[ \t]*\[(?!\^)[^\]\n]+\]:[ \t]*\S.*$/gm, m => stash(m)) // 引用式链接定义（脚注 [^1]: 除外）
    // 链接/图片地址必须先于 `![` 占位，否则图片地址漏网（截图1.png → 截图 1.png）
    .replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (m, txt, url) => txt + '(' + stash(url) + ')')
    .replace(/!\[/g, m => stash(m)) // 图片语法的 ! 藏起来，否则中文相邻会被转全角
    .replace(/https?:\/\/[^\s)]+/g, m => stash(m))
    .replace(/<[^>\n]+>/g, m => stash(m));
  const CJK = '[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff]';
  let n = 0;
  // Lute 术语库没覆盖到的常见词补充（词边界匹配，代码/URL 已占位保护）；
  // Lute 遇到紧跟半角逗号的词（"github,"）不改，高频词这里兜底
  const TERMS = { github: 'GitHub', gitlab: 'GitLab', mysql: 'MySQL', postgresql: 'PostgreSQL',
    docker: 'Docker', linux: 'Linux', python: 'Python',
    javascript: 'JavaScript', typescript: 'TypeScript', nodejs: 'Node.js',
    vscode: 'VS Code', iphone: 'iPhone', ipad: 'iPad', ios: 'iOS', macos: 'macOS',
    android: 'Android', youtube: 'YouTube', html: 'HTML', css: 'CSS', api: 'API',
    json: 'JSON', xml: 'XML', url: 'URL', pdf: 'PDF' };
  t = t.replace(/[A-Za-z][A-Za-z0-9.+-]*/g, (w) => {
    const fix = TERMS[w.toLowerCase()];
    if (fix && fix !== w) { n++; return fix; }
    return w;
  });
  t = t.replace(new RegExp('(' + CJK + ')([A-Za-z0-9])', 'g'), (m, a, b) => { n++; return a + ' ' + b; });
  t = t.replace(new RegExp('([A-Za-z0-9])(' + CJK + ')', 'g'), (m, a, b) => { n++; return a + ' ' + b; });
  const PW = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };
  // 全角标点自带间距，前后的空格一并去掉；只吃空格/Tab，不跨行
  t = t.replace(new RegExp('(' + CJK + ')[ \\t]*([,;:!?])[ \\t]*', 'g'), (m, c, p) => { n++; return c + PW[p]; });
  t = t.replace(new RegExp('([,;:!?])(' + CJK + ')', 'g'), (m, p, c) => { n++; return PW[p] + c; });
  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[+i]);
  return { text: t, count: n };
}

// 修正前的内容留在内存，菜单可一键恢复（setValue 不进 Vditor 撤销栈，Ctrl+Z 无效）
// 等价于 vditor.getValue()（输出实测逐字节一致），但跳过 Vditor 包装层，
// 大文档下约快 3 倍（175KB：~1.7s vs ~5.2s）。sv 模式本来就是取 textarea，直接走原路
const getMd = () => {
  const el = mode !== 'sv' && vditor.vditor[mode] && vditor.vditor[mode].element;
  return el ? vditor.vditor.lute[mode === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md'](el.innerHTML)
            : vditor.getValue();
};

let lastFixBackup = null;

function fixTypography() {
  if (!vditor) return;
  const before = getMd();
  if (currentPath) bridge.invoke('hist.snap', currentPath, before); // 修正前留档
  const r = applyCnTypography(before);
  // Lute 术语库（github→GitHub 等，代码块天然不动）：借编辑器实例开一次再关
  try {
    const lute = vditor.vditor.lute;
    lute.SetFixTermTypo(true);
    vditor.setValue(r.text, false);
    lute.SetFixTermTypo(false);
  } catch (e) {
    vditor.setValue(r.text, false);
  }
  if (getMd() !== before) {
    lastFixBackup = { path: currentPath, content: before };
    markDirty();
  }
  showAlert(`排版修正完成：${r.count} 处`);
}

function undoTypography() {
  if (!lastFixBackup || lastFixBackup.path !== currentPath) { showAlert('没有可恢复的修正记录'); return; }
  vditor.setValue(lastFixBackup.content, false);
  lastFixBackup = null;
  markDirty();
}

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
  else showAlert('无法打开: ' + (r && r.error));
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
    if (!r || !r.ok) { showAlert('移动失败: ' + (r && r.error)); return; }
    // 拖的是当前文档 → 同步路径、监听、图片基准和草稿（树刷新由 dir:changed 负责）
    if (currentPath === data.path) {
      await bridge.invoke('draft.clear', data.path, null); // 旧路径的草稿身份作废
      currentPath = r.newPath;
      refreshTitle();
      setDocBase(currentPath);
      watchCurrentFile();
      if (dirty) flushDraft(); // 有修改才重建草稿——干净文档写了也只会复活成假脏窗
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
    if (!r || !r.ok) { showAlert('移动失败: ' + (r && r.error)); return; }
    if (currentPath === data.path) {
      await bridge.invoke('draft.clear', data.path, null);
      currentPath = r.newPath;
      refreshTitle();
      setDocBase(currentPath);
      watchCurrentFile();
      if (dirty) flushDraft();
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

// 自定义消息框：原生 alert/confirm 无皮肤样式且同步阻塞 JS，
// 换成走 --ui-* 变量的弹层，自动跟随皮肤。返回点击的按钮下标。
// 主进程也通过 __ed.choiceBox 复用它（更新提示、关闭确认）。
let msgPending = null; // 未决弹窗的取消函数；新弹窗到达时先把它按取消解决，防挂起
function choiceBox(text, labels, cancelIdx) {
  if (msgPending) { const p = msgPending; msgPending = null; p(); }
  return new Promise((resolve) => {
    const dlg = document.getElementById('msgdlg');
    const btns = dlg.querySelector('.dlg-btns');
    const cIdx = cancelIdx == null ? labels.length - 1 : cancelIdx;
    document.getElementById('msgdlg-text').textContent = text;
    const done = (v) => {
      msgPending = null;
      dlg.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    msgPending = () => done(cIdx);
    btns.innerHTML = '';
    const els = labels.map((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => done(i);
      btns.appendChild(b);
      return b;
    });
    dlg.classList.remove('hidden');
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(0); }
      else if (e.key === 'Escape') { e.stopPropagation(); done(cIdx); }
    };
    dlg.onclick = (e) => { if (e.target === dlg) done(cIdx); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => els[0].focus(), 0);
  });
}
const showAlert = (t) => choiceBox(t, ['确定'], 0);
const confirmBox = async (t) => (await choiceBox(t, ['确定', '取消'], 1)) === 0;

async function ctxNewFile(dir) {
  const name = await ctxPrompt('文件名（含 .md）', '未命名.md');
  if (!name) return;
  const r = await bridge.invoke('fs.createFile', dir, name);
  if (!r || !r.ok) { showAlert('新建失败: ' + (r && r.error)); return; }
  openSidebarFile(r.path); // 建完直接打开
}

async function ctxNewDir(dir) {
  const name = await ctxPrompt('文件夹名', '新建文件夹');
  if (!name) return;
  const r = await bridge.invoke('fs.createDir', dir, name);
  if (!r || !r.ok) { showAlert('新建失败: ' + (r && r.error)); return; }
  expandedDirs.add(r.path); // 顺手展开新目录
}

async function ctxRename(p) {
  const name = await ctxPrompt('新名称', basename(p));
  if (!name || name === basename(p)) return;
  const r = await bridge.invoke('fs.rename', p, name);
  if (!r || !r.ok) { showAlert('重命名失败: ' + (r && r.error)); return; }
  if (currentPath === p) {
    currentPath = r.newPath;
    refreshTitle();
    watchCurrentFile();
  }
}

async function ctxTrash(p) {
  if (!await confirmBox(`确定把「${basename(p)}」移到回收站？`)) return;
  const r = await bridge.invoke('fs.trash', p);
  if (!r || !r.ok) showAlert('删除失败: ' + (r && r.error));
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

// 收集元素内可见文本（display:none 的隐藏标记不计入——与查找同一条规则）
function visibleText(el) {
  let t = '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (p && !p.offsetWidth && !p.offsetHeight) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) t += n.nodeValue;
  return t;
}

// 大纲从 DOM 标题提取——原来走 getValue()(Lute 全量序列化，175KB 文档 ~5s)，
// 它在 input 的 400ms 防抖路径上，大文档下打字停顿就冻结
function renderOutline() {
  const ul = document.getElementById('outline-list');
  ul.innerHTML = '';
  // 与 scrollToHeading 的 #vditor hN 顺序一致（同一 DOM 枚举）
  outlineHeads = [...document.querySelectorAll(
    '#vditor h1, #vditor h2, #vditor h3, #vditor h4, #vditor h5, #vditor h6')]
    .map(el => ({
      level: +el.tagName[1],
      text: visibleText(el).replace(/^#{1,6}\s+/, '').trim() // IR 模式标记是可见文本，剥掉
    }))
    .filter(h => h.text);
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
  const md = getMd();
  const lines = md.split('\n');
  // 大纲条目已改为 DOM 提取（无行号），这里从 markdown 重新提取；
  // 正常文档两种枚举顺序一致，索引可以直接对应
  const heads = extractHeads(md);
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
// 自研查找：Chromium findInPage 在大 DOM 上同步扫描渲染主线程
// （175KB 文档 wysiwyg ~4.8 万节点，每跳卡 ~3s），改成自己索引文本节点：
// TreeWalker 收集可见文本节点 → 拼接全文 → indexOf 匹配 → Range + scrollIntoView 定位
const $find = (id) => document.getElementById(id);
let findHidSidebar = false; // 查找期间临时藏侧栏，限定搜索范围在编辑区
let findIndex = null;     // {term, nodes:[{node,s,e}], hits:[{s,e}], cur}

function buildFindIndex(term) {
  const nodes = [];
  let text = '';
  const root = document.querySelector('.vditor-reset');
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const el = n.parentElement;
        // 跳过 display:none 的节点（Vditor 会藏起未激活块的 Markdown 标记）
        if (el && !el.offsetWidth && !el.offsetHeight) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, s: text.length, e: text.length + n.nodeValue.length });
      text += n.nodeValue;
    }
  }
  const low = text.toLowerCase(), q = term.toLowerCase();
  const hits = [];
  for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + 1)) {
    hits.push({ s: i, e: i + q.length });
  }
  findIndex = { term, nodes, hits, cur: -1 };
}

// 全局偏移 → 所属文本节点（二分）
function findNodeAt(pos) {
  const ns = findIndex.nodes;
  let lo = 0, hi = ns.length - 1, ans = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ns[m].s <= pos) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ns[ans];
}

function updateFindCount() {
  const i = findIndex;
  $find('find-count').textContent = i && i.hits.length ? `${i.cur + 1}/${i.hits.length}` : '0/0';
}

function jumpFind(dir) {
  const term = $find('find-input').value;
  if (!term) { findIndex = null; updateFindCount(); return; }
  // term 变了、没建过、或文档被重建过（旧节点已脱离 DOM）都要重扫
  if (!findIndex || findIndex.term !== term || !findIndex.nodes.length || !findIndex.nodes[0].node.isConnected) {
    buildFindIndex(term);
  }
  const hits = findIndex.hits;
  if (!hits.length) { findIndex.cur = -1; updateFindCount(); return; }
  findIndex.cur = ((findIndex.cur + dir) % hits.length + hits.length) % hits.length;
  const hit = hits[findIndex.cur];
  const a = findNodeAt(hit.s), b = findNodeAt(hit.e - 1);
  const range = document.createRange();
  range.setStart(a.node, hit.s - a.s);
  range.setEnd(b.node, hit.e - b.s);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const el = a.node.parentElement;
  if (el) el.scrollIntoView({ block: 'center' });
  updateFindCount();
}

function showFind() {
  const sb = $sidebar();
  findHidSidebar = !sb.classList.contains('hidden');
  if (findHidSidebar) sb.classList.add('hidden');
  $find('findbar').classList.remove('hidden');
  $find('find-input').focus();
  $find('find-input').select();
  jumpFind(1);
}

function hideFind() {
  if (findHidSidebar) {
    $sidebar().classList.remove('hidden');
    findHidSidebar = false;
  }
  $find('findbar').classList.add('hidden');
  findIndex = null;
  getSelection().removeAllRanges();
  vditor && vditor.focus();
}

function initFindbar() {
  const input = $find('find-input');
  let debounce;
  input.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { findIndex = null; jumpFind(1); }, 150);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') jumpFind(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') hideFind();
  };
  $find('find-prev').onclick = () => jumpFind(-1);
  $find('find-next').onclick = () => jumpFind(1);
  $find('find-close').onclick = hideFind;
  $find('replace-input').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Escape') hideFind(); }
  };
  $find('replace-all').onclick = async () => {
    const from = input.value, to = $find('replace-input').value;
    if (!from || !vditor) return;
    const md = getMd();
    const cnt = md.split(from).length - 1;
    if (!cnt) { showAlert('未找到: ' + from); return; }
    if (!await confirmBox(`确定把 ${cnt} 处「${from}」替换为「${to}」？`)) return;
    vditor.setValue(md.split(from).join(to));
    markDirty();
  };
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
    } else showAlert('无法重载: ' + (r && r.error));
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
  findIndex = null; // 文本变了，查找索引作废
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 1500);
};

const flushDraft = () => {
  if (!vditor) return;
  // 未命名文档第一次写草稿时生成稳定身份；之后恢复/清理都按它走
  if (!currentPath && !draftId) draftId = 'w' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  // getValue 是 Lute 全量序列化（175KB 文档 ~5s），脏状态每 1.5s 跑一次扛不住。
  // 改存编辑器的渲染态 HTML（~几十ms），恢复时用同一个 Lute 转回 markdown。
  const el = mode !== 'sv' && vditor.vditor[mode] && vditor.vditor[mode].element;
  const content = el ? el.innerHTML : getMd();
  bridge.invoke('draft.save', { path: currentPath, draftId, content, fmt: el ? mode : 'md' });
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
    theme: theme === 'graphite' ? 'dark' : 'classic',
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
      // 深色皮肤：皮肤由构造参数带上，内容/代码高亮主题要在这里补一次
      // （包括启动和模式切换重建，两处都走到）
      if (theme === 'graphite') {
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
    else showAlert('无法打开链接: ' + href);
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
  else showAlert('无法打开链接: ' + href);
}

// 修改未保存时的护栏
async function guardDirty() {
  if (!dirty) return true;
  if (vditor) flushDraft();
  const ok = await confirmBox('当前文档有未保存修改，仍要继续吗？\n（自动草稿已写入 userData/drafts）');
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
    showAlert('该文件不是 UTF-8 编码（已按 ' + docEncoding.toUpperCase() + ' 解码显示）。\n保存时将转换为 UTF-8。');
  }
}

// 保存用的源文本：按原文件换行风格还原（Vditor 内部统一 LF）
function getSaveContent() {
  const v = getMd();
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
  } else showAlert('保存失败: ' + (r && r.error));
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
  const content = getMd();
  mode = m;
  vditor.destroy();
  vditor = createEditor(content);
}

// 皮肤：zen/graphite/swiss/nordic；旧值 dark→graphite、classic→nordic
const SKINS = ['zen', 'graphite', 'swiss', 'nordic'];
const normSkin = (t) => t === 'dark' ? 'graphite' : (SKINS.includes(t) ? t : 'nordic');

async function setTheme(t) {
  theme = normSkin(t);
  document.body.dataset.skin = theme;
  document.body.classList.toggle('dark', theme === 'graphite');
  // 三参：编辑器皮肤 + 内容主题 + 代码高亮主题；
  // graphite 复用 Vditor 深色底，其余走 classic/light
  if (theme === 'graphite') {
    vditor.setTheme('dark', 'dark', 'github-dark');
  } else {
    vditor.setTheme('classic', 'light', 'github');
  }
  await bridge.invoke('setting.put', 'theme', theme);
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
      else if (r && r.error) showAlert('无法打开: ' + r.error);
      break;
    }
    case 'file:openPath': {
      if (!(await guardDirty())) break;
      const r = await bridge.invoke('file.read', payload);
      if (r && !r.error) loadDoc(r.path, r.content, r);
      else showAlert('无法打开: ' + (r && r.error));
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
    case 'file:history': openHistory(); break;
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
          width: Math.round(box.width), height: Math.round(h) },
        exportName('.png'));
      if (r && r.ok === false) showAlert('PNG 导出失败: ' + r.error);
      break;
    }
    case 'export:pandoc': {
      const ext = payload || 'docx';
      const r = await bridge.invoke('pandoc.export', getMd(), exportName('.' + ext), payload || null, currentPath);
      if (r && r.ok === false) showAlert('导出失败: ' + r.error);
      break;
    }
    case 'import:pandoc': {
      const r = await bridge.invoke('pandoc.import');
      if (!r) break;
      if (!r.ok) { showAlert('Pandoc 导入失败: ' + r.error); break; }
      if (!(await guardDirty())) break;
      currentPath = null;          // 导入内容落在未命名文档，等用户另存
      vditor.setValue(r.content || '');
      dirty = true;
      refreshTitle();
      sidebarRefresh();
      break;
    }
    case 'edit:fixCn': fixTypography(); break;
    case 'edit:undoFixCn': undoTypography(); break;
    case 'publish:wechat': openWechatPicker(); break;
    case 'edit:undo':
      try { vditor.focus(); vditor.vditor.undo.undo(vditor.vditor); } catch (e) {}
      break;
    case 'edit:redo':
      try { vditor.focus(); vditor.vditor.undo.redo(vditor.vditor); } catch (e) {}
      break;
    case 'app:flushDraft': if (dirty) flushDraft(); break; // 更新安装前主进程要求写盘
    case 'view:sidebar': await setSidebar(payload); break;
    case 'view:toolbar': {
      document.body.classList.toggle('no-toolbar', !payload);
      await bridge.invoke('setting.put', 'toolbar', !!payload);
      break;
    }
    case 'view:remoteImg': {
      // 拦截在主进程 webRequest 层做；这里只管持久化，不主动刷新已加载的图
      await bridge.invoke('setting.put', 'remoteImg', !!payload);
      break;
    }
    case 'edit:find': showFind(); break;
    case 'draft:restore': {
      // 启动时主进程推来的未保存草稿（按文档各一份）
      currentPath = payload.path || null;
      draftId = payload.draftId || null;
      dirty = true;
      if (currentPath) setDocBase(currentPath);
      let content = payload.content || '';
      // html 格式草稿（大文档避免启动时全量序列化）：转回 markdown 再进编辑器
      if (payload.fmt === 'wysiwyg' || payload.fmt === 'ir') {
        try {
          content = vditor.vditor.lute[payload.fmt === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md'](content);
        } catch (e) {}
        // 主进程只能对 md 草稿做"与磁盘相同则跳过"；html 草稿在这里补——
        // 恢复内容跟磁盘一致说明是保存成功后的残留，清档关窗
        if (currentPath) {
          const r = await bridge.invoke('file.read', currentPath);
          const strip = (s) => (s || '').replace(/\s+$/, '');
          if (r && r.content && strip(r.content) === strip(content)) {
            dirty = false;
            bridge.invoke('draft.clear', currentPath, draftId);
            await bridge.invoke('app.closeNow');
            break;
          }
        }
      }
      vditor.setValue(content);
      dirty = true; refreshTitle(); // 草稿本身是未保存状态
      sidebarRefresh();
      watchCurrentFile();
      break;
    }
    case 'app:closeRequest': {
      if (!dirty) { await bridge.invoke('app.closeNow'); break; }
      const r = await choiceBox('文档有未保存的修改\n关闭前要保存吗？自动草稿仍会保留。',
        ['保存并关闭', '不保存', '取消'], 2);
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

// ---------- 版本历史面板 ----------
let histSnaps = [], histSel = null;

async function openHistory() {
  if (!currentPath) { showAlert('未命名文档没有版本历史（保存后开始记录）'); return; }
  const r = await bridge.invoke('hist.list', currentPath);
  histSnaps = r.snaps || [];
  document.getElementById('histdlg').classList.remove('hidden');
  renderHistList();
  if (histSnaps.length) selectHist(histSnaps[0].ts);
  else document.getElementById('hist-diff').innerHTML =
    '<div class="hist-empty">还没有历史版本。每次保存会自动留存快照。</div>';
}

function renderHistList() {
  const el = document.getElementById('hist-list');
  el.innerHTML = '';
  histSnaps.forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'hist-item' + (s.ts === histSel ? ' sel' : '') + (i === 0 ? ' latest' : '');
    d.innerHTML = '<div>' + new Date(s.ts).toLocaleString() + '</div>' +
      '<div class="sz">' + (s.size / 1024).toFixed(1) + ' KB</div>';
    d.onclick = () => selectHist(s.ts);
    el.appendChild(d);
  });
}

async function selectHist(ts) {
  histSel = ts;
  renderHistList();
  const box = document.getElementById('hist-diff');
  const r = await bridge.invoke('hist.read', currentPath, ts);
  if (!r.ok) { box.innerHTML = '<div class="hist-empty">读取快照失败</div>'; return; }
  const d = await bridge.invoke('hist.diff', r.content, getMd());
  box.innerHTML = '';
  const rows = [];
  for (const [op, text] of (d.diffs || [])) {
    for (const line of text.split('\n')) {
      if (line === '') continue;
      rows.push('<div class="dl ' + (op === 1 ? 'add' : op === -1 ? 'del' : 'same') + '">' +
        escapeHtml((op === 1 ? '+ ' : op === -1 ? '- ' : '  ') + line) + '</div>');
    }
  }
  box.innerHTML = rows.length ? rows.join('') : '<div class="hist-empty">与当前内容相同</div>';
}

document.getElementById('hist-close').onclick =
  () => document.getElementById('histdlg').classList.add('hidden');
document.getElementById('histdlg').addEventListener('click',
  e => { if (e.target.id === 'histdlg') e.currentTarget.classList.add('hidden'); });
document.getElementById('hist-restore').onclick = async () => {
  if (histSel == null) return;
  if (!await confirmBox('恢复此版本？当前内容会先留存一份快照，可再次恢复回来')) return;
  const r = await bridge.invoke('hist.read', currentPath, histSel);
  if (!r.ok) { showAlert('读取快照失败'); return; }
  await bridge.invoke('hist.snap', currentPath, getMd());
  vditor.setValue(r.content, false);
  markDirty();
  document.getElementById('histdlg').classList.add('hidden');
};
document.getElementById('hist-clear').onclick = async () => {
  if (!await confirmBox('清空此文档的全部历史版本？此操作不可撤销')) return;
  await bridge.invoke('hist.clear', currentPath);
  histSnaps = []; histSel = null;
  renderHistList();
  document.getElementById('hist-diff').innerHTML = '<div class="hist-empty">已清空</div>';
};

// ---------- 公众号复制 ----------
// hljs 高亮 class → 行内颜色（公众号删 class，颜色必须在 style 里）
const HLJS_COLORS = {
  keyword: '#d73a49', 'keyword-tag': '#22863a', string: '#032f62', comment: '#6a737d',
  number: '#005cc5', literal: '#005cc5', built_in: '#e36209', 'built-in': '#e36209',
  title: '#6f42c1', attr: '#005cc5', attribute: '#005cc5', type: '#d73a49',
  name: '#22863a', symbol: '#e36209', regexp: '#032f62', meta: '#6a737d'
};

// Vditor.preview 离屏渲染 → 外链转脚注 + 代码块保空白 + 样式全内联 + 去 class/id
// md 不传时取当前文档；传了用于预览小样
async function buildWechatHTML(themeKey, md) {
  const theme = (window.WECHAT_THEMES || {})[themeKey] || Object.values(window.WECHAT_THEMES || {})[0];
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:677px;';
  document.body.appendChild(host);
  try {
    await Vditor.preview(host, md !== undefined ? md : getMd(), { cdn: '../../node_modules/vditor' });
    // 本地图片公众号收不下 → 占位文字 + 计数提示
    // （相对路径、file://、data: 一律按本地算——离屏 preview 不会解析相对路径）
    let localImgs = 0;
    host.querySelectorAll('img').forEach(img => {
      const s = img.getAttribute('src') || '';
      if (!/^https?:/i.test(s)) {
        localImgs++;
        img.replaceWith(document.createTextNode('[图片]'));
      }
    });
    // 外链 → 正文纯文字 + 末尾"参考资料"脚注（公众号会去掉非白名单链接）
    const refs = [];
    host.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      const text = document.createTextNode(a.textContent);
      if (!/^https?:/i.test(href)) { a.replaceWith(text); return; }
      refs.push(href);
      const sup = document.createElement('sup');
      sup.textContent = ' [' + refs.length + ']';
      a.replaceWith(text, sup);
    });
    // 代码块空白保全：\n→<br>、连续空格→&nbsp;（white-space 在公众号可能被剥）
    host.querySelectorAll('pre code').forEach(c => {
      c.innerHTML = c.innerHTML.replace(/\n/g, '<br>').replace(/ {2}/g, ' &nbsp;');
    });
    // hljs class → 行内颜色
    host.querySelectorAll('span, code').forEach(el => {
      const cls = (el.getAttribute('class') || '').match(/hljs-([\w-]+)/);
      if (cls && HLJS_COLORS[cls[1]]) el.style.color = HLJS_COLORS[cls[1]];
    });
    // 参考资料区
    if (refs.length) {
      const sec = document.createElement('section');
      sec.className = 'wechat-refs';
      sec.innerHTML = '<h4>参考资料</h4>' +
        refs.map((u, i) => '<p>[' + (i + 1) + '] ' + escapeHtml(u) + '</p>').join('');
      host.appendChild(sec);
    }
    // 主题样式内联（同元素多条规则后者覆盖前者）
    for (const rule of theme.rules) {
      host.querySelectorAll(rule.s).forEach(el => { el.style.cssText += ';' + rule.c; });
    }
    // 去掉所有 class/id（公众号会删，提前清掉避免无效字节）
    host.querySelectorAll('*').forEach(el => { el.removeAttribute('class'); el.removeAttribute('id'); });
    return {
      html: '<section style="font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif">' +
        host.innerHTML + '</section>',
      text: host.textContent,
      localImgs, refCount: refs.length
    };
  } finally {
    host.remove();
  }
}

// 渲染层 Async Clipboard API 一次写 text/html + text/plain 两个格式。
// 注意别用主进程 clipboard.write：Electron 44 在 Windows 上实测静默失效
// （写返回成功但剪贴板内容不变，独立进程也复现）。
async function copyHtml(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' })
    })]);
    return true;
  } catch (e) { return false; }
}

// ---------- 公众号格式选择框 ----------
const WC_SAMPLE = '## 示例标题\n\n这是一段**加粗**和*斜体*混排的示例正文，' +
  '用来展示当前主题的排版效果。[示例链接](https://example.com) 也在这里。\n\n' +
  '> 引用块的样式\n\n- 列表项一\n- 列表项二\n\n```js\nconst hello = "代码块";\n```\n';
let wcTheme = 'blue';

async function openWechatPicker() {
  const themes = window.WECHAT_THEMES || {};
  const list = document.getElementById('wc-themes');
  list.innerHTML = '';
  for (const [key, t] of Object.entries(themes)) {
    const d = document.createElement('div');
    d.className = 'wc-theme-item' + (key === wcTheme ? ' sel' : '');
    d.textContent = t.name || key;
    d.onclick = () => { wcTheme = key; renderWechatPreview(); };
    list.appendChild(d);
  }
  document.getElementById('wcdlg').classList.remove('hidden');
  renderWechatPreview();
}

async function renderWechatPreview() {
  document.querySelectorAll('.wc-theme-item').forEach((el, i) =>
    el.classList.toggle('sel', Object.keys(window.WECHAT_THEMES)[i] === wcTheme));
  const r = await buildWechatHTML(wcTheme, WC_SAMPLE);
  // 输出已是全内联样式 + 无 class/id，直接塞进 div 即可（iframe 会被 CSP frame-src 'none' 拦）
  document.getElementById('wc-frame').innerHTML = r.html;
}

document.getElementById('wc-close').onclick =
  () => document.getElementById('wcdlg').classList.add('hidden');
document.getElementById('wcdlg').addEventListener('click',
  e => { if (e.target.id === 'wcdlg') e.currentTarget.classList.add('hidden'); });
document.getElementById('wc-copy').onclick = async () => {
  const r = await buildWechatHTML(wcTheme);
  if (!(await copyHtml(r.html, r.text))) { showAlert('复制失败，请重试'); return; }
  document.getElementById('wcdlg').classList.add('hidden');
  let msg = '已复制，请到公众号编辑器粘贴';
  if (r.localImgs) msg += `\n注意：${r.localImgs} 张本地图片已替换为占位，需在公众号后台重新插入`;
  if (r.refCount) msg += `\n${r.refCount} 个外链已转为文末参考资料`;
  showAlert(msg);
};

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
    await Vditor.preview(host, getMd(), { cdn: '../../node_modules/vditor' });
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
  theme = normSkin(await bridge.invoke('setting.get', 'theme'));
  document.body.dataset.skin = theme;
  document.body.classList.toggle('dark', theme === 'graphite');
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
  // 拖文件进窗口 → 打开（页面导航已被 will-navigate 拦死，这里给文件一个去处）
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    if (e.target.closest('#vditor')) return; // 编辑区内的投放归 Vditor（上传/插图）
    e.preventDefault();
    const p = bridge.pathOf(e.dataTransfer.files[0]);
    if (!p) return;
    const ext = (p.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
    if (!['.md', '.markdown', '.mdown', '.txt'].includes(ext)) return;
    if (!(await guardDirty())) return;
    const r = await bridge.invoke('file.read', p);
    if (r && !r.error) loadDoc(r.path, r.content, r);
    else showAlert('无法打开: ' + (r && r.error));
  });
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
  buildHTMLDoc, buildWechatHTML, fixTypography, undoTypography, openHistory, openWechatPicker, flushDraft, extractHeads, moveSection, renderTree, expandedDirs, dirCache, setTheme, showAlert, confirmBox, choiceBox, jumpFind,
  get outlineHeads() { return outlineHeads; }
};

})();
