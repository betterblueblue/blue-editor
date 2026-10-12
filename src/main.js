// 主进程：薄壳——窗口、文件读写、设置、最近文档、草稿备份、argv/单实例、导出、pandoc
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const userData = () => app.getPath('userData');
const confPath = () => path.join(userData(), 'conf', 'conf.user.json');
const assetsDirOf = (p) => p.replace(/\.[^.\\]+$/, '') + '.assets';

// ---------- 设置 ----------
function readConf() {
  try {
    return JSON.parse(fs.readFileSync(confPath(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeConf(conf) {
  fs.mkdirSync(path.dirname(confPath()), { recursive: true });
  fs.writeFileSync(confPath(), JSON.stringify(conf, null, 2));
}

const setting = {
  get: (k) => readConf()[k],
  put: (k, v) => {
    const c = readConf();
    c[k] = v;
    writeConf(c);
  }
};

// ---------- argv 文件路径 ----------
function getFilePath(argv, cwd) {
  let p;
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i][0] === '-') continue;
    if (argv[i] === process.execPath) continue; // 打包后 argv[0] 是自身 exe
    p = argv[i];
    break;
  }
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    try { p = decodeURI(p); } catch (e) {}
  }
  p = path.resolve(cwd || process.cwd(), p);
  // 自身入口（dev 模式 "."）或目录不算
  if (p === path.resolve(cwd || process.cwd(), '.') || isDir(p)) return null;
  return p;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

const MD_EXT = ['.md', '.markdown', '.mdown', '.txt'];
// 与 src/renderer/wechat-themes.js 的 key 一一对应（菜单文案在主进程维护）
const WECHAT_MENU_THEMES = { blue: 'Blue 经典', simple: '简约', tech: '技术风' };
function isOpenable(p) {
  return MD_EXT.includes(path.extname(p).toLowerCase());
}

// ---------- 窗口 ----------
let win;                 // 最近聚焦窗口（菜单动作默认路由目标）
const wins = new Set();  // 全部窗口（每文档一窗口）

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

function createWindow() {
  const w = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 500,
    minHeight: 400,
    backgroundColor: setting.get('theme') === 'dark' ? '#1f1f1f' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // preload 只用 contextBridge+ipcRenderer，可以全开沙箱
    }
  });
  wins.add(w);
  w.on('focus', () => { win = w; });
  w.on('closed', () => {
    wins.delete(w);
    if (win === w) win = null;
    // 释放该窗口持有的监听
    const dw = dirWatchers.get(w.id);
    if (dw) { try { dw.watcher.close(); } catch (err) {} dirWatchers.delete(w.id); }
    const fw = fileWatchers.get(w.id);
    if (fw) { try { fs.unwatchFile(fw.path, fw.listener); } catch (err) {} fileWatchers.delete(w.id); }
  });
  // 关窗前先问渲染层 dirty（未保存 → 三选一对话框）
  w.on('close', (e) => {
    if (!w._allowClose && !app._installing) {
      e.preventDefault();
      w.webContents.send('menu:action', { action: 'app:closeRequest' });
    }
  });
  w.webContents.on('found-in-page', (e, r) => {
    if (!w.isDestroyed()) {
      w.webContents.send('find:result', { matches: r.matches, active: r.activeMatchOrdinal });
    }
  });
  // 导航/新窗口拦截：一切导航都拦（loadFile 不走这个事件，页面内跳转/拖拽文件
  // 掉落都会触发）；http(s)/mailto 转系统浏览器，其余一律拒绝
  w.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) shell.openExternal(url);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win = w;
  buildMenu();
  return w;
}

function send(action, payload) {
  const w = win || wins.values().next().value;
  w && w.webContents.send('menu:action', { action, payload });
}

// 把 argv 文件投递给指定窗口（等页面就绪）
function deliverTo(w, argv, cwd) {
  const p = getFilePath(argv, cwd);
  const go = () => {
    if (p && isOpenable(p)) {
      if (fs.existsSync(p)) {
        w.webContents.send('menu:action', { action: 'file:openPath', payload: p });
      } else {
        w.webContents.send('menu:action', { action: 'file:newPath', payload: p });
      }
    } else if (p) {
      dialog.showErrorBox('Blue Editor', '不支持的文件类型：' + p);
    }
  };
  if (w.webContents.isLoading()) {
    w.webContents.once('did-finish-load', go);
  } else {
    go();
  }
  w.focus();
}

// ---------- 菜单 ----------
let pandocVersion = null; // null = 未检测/不可用

function buildMenu() {
  const recent = setting.get('recentFiles') || [];
  const exportSub = [
    { label: 'PDF…', click: () => send('export:pdf') },
    { label: 'HTML 网页…', click: () => send('export:html') },
    { label: 'PNG 图片（全文长图）…', click: () => send('export:png') },
  ];
  if (pandocVersion) {
    exportSub.push(
      { type: 'separator' },
      { label: 'Word 文档 (.docx)…', click: () => send('export:pandoc', 'docx') },
      { label: '电子书 (.epub)…', click: () => send('export:pandoc', 'epub') },
      { label: '更多格式（ODT / LaTeX / RST）…', click: () => send('export:pandoc') }
    );
  }
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
        {
          label: '最近文件',
          submenu: recent.length
            ? recent.map(p => ({ label: p, click: () => send('file:openPath', p) }))
            : [{ label: '（空）', enabled: false }]
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file:saveAs') },
        { type: 'separator' },
        { label: '导入文档（Word / EPUB 等）…', enabled: !!pandocVersion, click: () => send('import:pandoc') },
        { label: '导出为', submenu: exportSub },
        { type: 'separator' },
        {
          label: '复制为公众号格式',
          submenu: Object.entries(WECHAT_MENU_THEMES).map(([key, name]) => ({
            label: name, click: () => send('publish:wechat', key)
          }))
        },
        { label: '版本历史…', click: () => send('file:history') },
        { type: 'separator' },
        { label: '打印…', accelerator: 'CmdOrCtrl+P', click: () => { const w = win; w && w.webContents.print(); } },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('edit:undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('edit:redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { label: '查找 / 替换…', accelerator: 'CmdOrCtrl+F', click: () => send('edit:find') },
        { type: 'separator' },
        { label: '中文排版修正', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('edit:fixCn') },
        { label: '撤销排版修正', click: () => send('edit:undoFixCn') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '所见即所得', click: () => send('view:mode', 'wysiwyg') },
        { label: '即时渲染', click: () => send('view:mode', 'ir') },
        { label: '分屏预览', click: () => send('view:mode', 'sv') },
        { type: 'separator' },
        { label: '侧边栏', type: 'checkbox', checked: setting.get('sidebar') !== false, click: (i) => send('view:sidebar', i.checked) },
        { label: '工具栏', type: 'checkbox', checked: setting.get('toolbar') === true, click: (i) => send('view:toolbar', i.checked) },
        { label: '深色主题', type: 'checkbox', checked: setting.get('theme') === 'dark', click: (i) => send('view:theme', i.checked ? 'dark' : 'classic') },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' }
      ]
    },
    {
      label: '关于',
      submenu: [
        { label: 'Blue Editor v' + app.getVersion(), enabled: false },
        { label: '检查更新…', click: () => checkUpdates(true) },
        { label: '自动检查更新', type: 'checkbox', checked: setting.get('autoUpdate') !== false,
          click: (i) => setting.put('autoUpdate', i.checked) },
        { label: '开源许可…', click: () => {
          // 打包后 licenses/ 在 resources/ 下；开发时用构建脚本生成的目录
          const dir = app.isPackaged
            ? path.join(process.resourcesPath, 'licenses')
            : path.join(__dirname, '..', 'licenses');
          shell.openPath(dir);
        } }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function addRecent(p) {
  let r = setting.get('recentFiles') || [];
  r = [p, ...r.filter(x => x !== p)].slice(0, 10);
  setting.put('recentFiles', r);
  buildMenu();
}

// ---------- pandoc ----------
function runPandoc(args, input, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pandoc', args, { windowsHide: true, cwd: (opts && opts.cwd) || undefined });
    const out = [], err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(Buffer.concat(err).toString('utf8') || 'pandoc exit ' + code));
    });
    if (input !== undefined) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

function versionGte(v, min) {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

async function detectPandoc() {
  try {
    const out = await runPandoc(['--version']);
    const m = String(out).match(/pandoc(?:\.exe)?\s+([\d.]+)/i);
    if (m && versionGte(m[1], '1.16')) {
      pandocVersion = m[1];
    }
  } catch (e) {
    pandocVersion = null;
  }
  buildMenu();
}

const PANDOC_IMPORT_FILTERS = [
  { name: 'All Supported Formats', extensions: ['docx', 'latex', 'tex', 'ltx', 'rst', 'rest', 'org', 'wiki', 'dokuwiki', 'mediawiki', 'textile', 'opml', 'epub'] },
  { name: 'MS Word', extensions: ['docx'] },
  { name: 'TeX/LaTeX', extensions: ['latex', 'tex', 'ltx'] },
  { name: 'reStructuredText', extensions: ['rst', 'rest'] },
  { name: 'org-mode', extensions: ['org'] },
  { name: 'Wiki', extensions: ['wiki', 'dokuwiki', 'mediawiki'] },
  { name: 'Epub', extensions: ['epub'] },
  { name: 'Textile', extensions: ['textile'] },
  { name: 'OPML', extensions: ['opml'] }
];

// ---------- IPC ----------
ipcMain.handle('setting.get', (e, k) => setting.get(k));
ipcMain.handle('setting.put', (e, k, v) => setting.put(k, v));
ipcMain.handle('recent.get', () => setting.get('recentFiles') || []);

// 侧栏文件树：列目录（子目录 + md 文件）
ipcMain.handle('dir.list', (e, dir) => {
  try {
    const dirs = [], files = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(ent => {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        dirs.push({ name: ent.name, path: full });
      } else if (ent.isFile() && MD_EXT.includes(path.extname(ent.name).toLowerCase())) {
        files.push({ name: ent.name, path: full });
      }
    });
    const byName = (a, b) => a.name.localeCompare(b.name);
    return { path: dir, dirs: dirs.sort(byName), files: files.sort(byName) };
  } catch (err) {
    return { path: dir, error: err.message, dirs: [], files: [] };
  }
});

// 目录监听：按窗口各持一个（外部增删改 → 推 dir:changed，防抖合并）
const dirWatchers = new Map(); // winId → {watcher, win, dir, timer}
ipcMain.handle('dir.watch', (e, dir) => {
  const w = winOf(e);
  const prev = dirWatchers.get(w.id);
  if (prev && prev.dir === dir) return; // 同一个根 → 不动
  if (prev) { try { prev.watcher.close(); } catch (err) {} }
  if (!dir) { dirWatchers.delete(w.id); return; }
  try {
    const watcher = fs.watch(dir, { recursive: true }, () => {
      const rec = dirWatchers.get(w.id);
      if (!rec) return;
      clearTimeout(rec.timer); // 防抖按窗口各自隔离，不能共用全局定时器
      rec.timer = setTimeout(() => {
        !rec.win.isDestroyed() && rec.win.webContents.send('dir:changed');
      }, 300);
    });
    dirWatchers.set(w.id, { watcher, win: w, dir, timer: null });
  } catch (err) {
    dirWatchers.delete(w.id);
  }
});

// 当前文件外部修改监听：按窗口各持一个（轮询；自己保存按 mtime+窗口抑制）
const fileWatchers = new Map(); // winId → {path, win, listener}
let lastSavedMtime = 0;
let lastSavedWinId = 0;
ipcMain.handle('file.watch', (e, p) => {
  const w = winOf(e);
  const prev = fileWatchers.get(w.id);
  if (prev && prev.path === p) return;
  // unwatchFile 必须带上自己的 listener——不带参数会把别的窗口对同一文件的监听也摘掉
  if (prev) { try { fs.unwatchFile(prev.path, prev.listener); } catch (err) {} fileWatchers.delete(w.id); }
  if (!p) return;
  const listener = (cur) => {
    // 本窗口自己刚写入的不算外部修改
    if (cur.mtimeMs === lastSavedMtime && w.id === lastSavedWinId) return;
    w && !w.isDestroyed() && w.webContents.send('file:changed', p);
  };
  fileWatchers.set(w.id, { path: p, win: w, listener });
  try {
    fs.watchFile(p, { interval: 800 }, listener);
  } catch (err) {}
});

// 侧栏文件操作：新建/重命名/删除（进回收站）/移动
ipcMain.handle('fs.createFile', (e, dir, name) => {
  try {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { ok: false, error: '已存在同名项' };
    fs.writeFileSync(p, '', 'utf8');
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs.createDir', (e, dir, name) => {
  try {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return { ok: false, error: '已存在同名项' };
    fs.mkdirSync(p);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs.rename', (e, from, newName) => {
  try {
    const to = path.join(path.dirname(from), newName);
    if (fs.existsSync(to)) return { ok: false, error: '已存在同名项' };
    fs.renameSync(from, to);
    // md 重命名时同步重命名 assets 目录
    if (MD_EXT.includes(path.extname(from).toLowerCase())) {
      const assets = assetsDirOf(from);
      if (fs.existsSync(assets)) {
        try { fs.renameSync(assets, assetsDirOf(to)); } catch (e2) {}
      }
      histMove(from, to);
    }
    return { ok: true, newPath: to };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs.trash', async (e, p) => {
  try {
    await shell.trashItem(path.normalize(p));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('file.move', (e, src, destDir) => {
  try {
    const normSrc = path.normalize(src), normDest = path.normalize(destDir);
    if (normSrc === normDest) return { ok: false, error: '目标即自身' };
    // 不能把目录移到自己里面
    if (normDest.toLowerCase().startsWith(normSrc.toLowerCase() + path.sep)) {
      return { ok: false, error: '不能移动到自身子目录' };
    }
    const newPath = path.join(normDest, path.basename(normSrc));
    if (fs.existsSync(newPath)) return { ok: false, error: '目标位置已存在同名项' };
    fs.renameSync(normSrc, newPath);
    // md 文件随迁 <stem>.assets/ 图片目录
    if (MD_EXT.includes(path.extname(normSrc).toLowerCase())) {
      const assets = assetsDirOf(normSrc);
      if (fs.existsSync(assets)) {
        try { fs.renameSync(assets, assetsDirOf(newPath)); } catch (e) {}
      }
      histMove(normSrc, newPath);
    }
    return { ok: true, newPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('file.openDialog', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readFileResult(r.filePaths[0]);
});

ipcMain.handle('file.read', (e, p) => readFileResult(p));

// 渲染层请求用系统浏览器打开链接（只允许 http/https/mailto）
ipcMain.handle('shell.openExternal', (e, url) => {
  if (/^(https?:|mailto:)/i.test(url || '')) shell.openExternal(url);
});

function readFileResult(p) {
  try {
    p = path.resolve(p); // 规范成绝对路径，渲染层拿到的 path 才能用于监听/对比
    const buf = fs.readFileSync(p);
    let content, encoding = 'utf8';
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      content = new TextDecoder('utf-16le').decode(buf); encoding = 'utf-16le'; // BOM 由解码器剥离
    } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      content = new TextDecoder('utf-16be').decode(buf); encoding = 'utf-16be';
    } else if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      content = new TextDecoder('utf-8').decode(buf.subarray(3)); // 去 BOM
    } else {
      try {
        // GBK 等 ANSI 编码按 utf-8 强解会得到一堆替换符——fatal 探一下再回退
        content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        try { content = new TextDecoder('gbk').decode(buf); encoding = 'gbk'; }
        catch (e2) { content = buf.toString('utf8'); }
      }
    }
    const r = { path: p, content, name: path.basename(p), encoding };
    addRecent(p);
    return r;
  } catch (e) {
    return { path: p, error: e.message };
  }
}

// 导出 HTML 时把图片内嵌成 data: URI（file:// 绝对路径发出去就是裂图）
ipcMain.handle('file.readBase64', (e, p) => {
  try {
    const buf = fs.readFileSync(path.resolve(p));
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon'
    }[ext] || 'application/octet-stream';
    return { ok: true, base64: buf.toString('base64'), mime };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 粘贴/拖入图片 → 落到 <文档名>.assets/，返回相对路径
ipcMain.handle('asset.save', (e, docPath, fileName, bytes) => {
  try {
    const dir = docPath.replace(/\.[^.\\]+$/, '') + '.assets';
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(fileName || 'img').replace(/[^\w.\-一-龥]/g, '_');
    const dest = path.join(dir, Date.now() + '-' + safe);
    fs.writeFileSync(dest, Buffer.from(bytes));
    return path.basename(dir) + '/' + path.basename(dest);
  } catch (err) {
    throw new Error('asset.save failed: ' + err.message);
  }
});

function rememberMtime(p, winId) {
  try {
    lastSavedMtime = fs.statSync(p).mtimeMs;
    lastSavedWinId = winId;
  } catch (e) {}
}

ipcMain.handle('file.save', (e, p, content) => {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 保存前先把旧磁盘内容留一份快照，这样能回到"本次修改前"
    try { histSnap(p, fs.readFileSync(p, 'utf8')); } catch (e) {}
    fs.writeFileSync(p, content, 'utf8');
    rememberMtime(p, winOf(e).id);
    addRecent(p);
    histSnap(p, content);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// pandoc 导入等留下的 file:/// 图片引用 → 搬进 <新文档>.assets/，改回相对路径
async function relocateFileImages(dstPath, md) {
  const re = /file:\/\/\/([^")\s]+)/g;
  const map = new Map(); let i = 0;
  const jobs = [];
  md.replace(re, (m, raw) => {
    const p = decodeURIComponent(raw);
    if (map.has(p)) return;
    map.set(p, null);
    const n = ++i;
    jobs.push((async () => {
      try {
        const buf = fs.readFileSync(p);
        const dir = dstPath.replace(/\.[^.\\]+$/, '') + '.assets';
        fs.mkdirSync(dir, { recursive: true });
        const safe = path.basename(p).replace(/[^\w.\-一-龥]/g, '_');
        const dest = path.join(dir, Date.now() + '-' + n + '-' + safe);
        fs.writeFileSync(dest, buf);
        map.set(p, path.basename(dir) + '/' + path.basename(dest));
      } catch (e) { /* 读不到就保留原 file:// 引用 */ }
    })());
    return m;
  });
  await Promise.all(jobs);
  return md.replace(re, (m, raw) => map.get(decodeURIComponent(raw)) || m);
}

ipcMain.handle('file.saveAs', async (e, content, defaultPath) => {
  const r = await dialog.showSaveDialog(winOf(e), {
    defaultPath: defaultPath || 'untitled.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (r.canceled || !r.filePath) return null;
  try {
    content = await relocateFileImages(r.filePath, content);
    fs.writeFileSync(r.filePath, content, 'utf8');
    rememberMtime(r.filePath, winOf(e).id);
    addRecent(r.filePath);
    histSnap(r.filePath, content);
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- 草稿备份（按文档路径 hash 存档；未命名文档按 draftId）----------
const draftName = (p, draftId) =>
  (p ? 'p-' + crypto.createHash('sha1').update(p).digest('hex') : 'u-' + (draftId || 'x')) + '.json';
const draftFile = (p, draftId) => path.join(userData(), 'drafts', draftName(p, draftId));

ipcMain.handle('draft.save', (e, payload) => {
  try {
    const f = draftFile(payload.path, payload.draftId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...payload, savedAt: Date.now() }));
    return true;
  } catch (err) {
    return false;
  }
});

// 只有保存成功后渲染层才调：按草稿身份（path 或 draftId）精确删除
ipcMain.handle('draft.clear', (e, p, draftId) => {
  try { fs.unlinkSync(draftFile(p || null, draftId)); } catch (err) {}
});

// 启动时把 drafts/ 里每个草稿恢复到独立窗口（多文档未保存不串档）
function restoreDrafts() {
  const dir = path.join(userData(), 'drafts');
  let drafts = [];
  try {
    drafts = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          // u-<draftId>.json 的旧草稿可能没有 draftId 字段，从文件名补出来
          if (d) d.draftId = d.draftId || (f.match(/^u-(.+)\.json$/) || [])[1];
          return d;
        } catch (e) { return null; }
      })
      .filter(d => d && d.content)
      .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
  } catch (e) {}
  drafts.forEach(d => {
    // 磁盘内容与草稿一致 → 是已保存后的残留，直接删掉，不再弹脏窗口
    if (d.path) {
      try {
        if (fs.existsSync(d.path) && fs.readFileSync(d.path, 'utf8') === d.content) {
          fs.unlinkSync(draftFile(d.path, d.draftId));
          return;
        }
      } catch (e) {}
    }
    const w = createWindow();
    const go = () => w.webContents.send('menu:action', { action: 'draft:restore', payload: d });
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go);
    else go();
  });
  return drafts.length;
}

// ---------- 导出 ----------
ipcMain.handle('export.pdf', async (e, defaultName) => {
  const w = winOf(e);
  const r = await dialog.showSaveDialog(w, {
    defaultPath: defaultName || 'untitled.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return null;
  const data = await w.webContents.printToPDF({ printBackground: true });
  fs.writeFileSync(r.filePath, data);
  return { ok: true, path: r.filePath };
});

ipcMain.handle('export.html', async (e, html, defaultName) => {
  const r = await dialog.showSaveDialog(winOf(e), {
    defaultPath: defaultName || 'untitled.html',
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, html, 'utf8');
  return { ok: true, path: r.filePath };
});

ipcMain.handle('export.png', async (e, clip, defaultName) => {
  const w = winOf(e);
  if (!w) return null;
  const r = await dialog.showSaveDialog(w, {
    defaultPath: defaultName || 'untitled.png',
    filters: [{ name: 'PNG', extensions: ['png'] }]
  });
  if (r.canceled || !r.filePath) return null;
  const [ow, oh] = w.getSize();
  try {
    // captureBeyondViewport 对懒渲染合成层不稳定——直接把窗口拉到内容全高，
    // 让全文落在真实视口内，重排 + 懒渲染走正常路径，再整窗截取编辑区
    w.setContentSize(clip.x + clip.width + 1, Math.min(clip.height, 16000));
    await new Promise(res => setTimeout(res, 900));
    const image = await w.webContents.capturePage();
    // HiDPI：capturePage 返回物理像素图，crop 用 CSS 坐标会切少——按实际倍率换算
    const sf = image.getSize().width / (clip.x + clip.width + 1);
    const cropped = image.crop({
      x: Math.round(clip.x * sf), y: 0,
      width: Math.round(clip.width * sf),
      height: Math.round(Math.min(clip.height, 16000) * sf)
    });
    fs.writeFileSync(r.filePath, cropped.toPNG());
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    w.setSize(ow, oh);
  }
});

// HTML 导出用的样式包：内联 Vditor 排版 + KaTeX + 代码高亮 css，
// css 里的 url(font/…) 全部读成 data:base64（asar 内也能工作）
ipcMain.handle('export.cssBundle', () => {
  const base = path.join(__dirname, '..', 'node_modules', 'vditor', 'dist');
  const files = [
    'index.css',
    'css/content-theme/light.css',
    'js/katex/katex.min.css',
    'js/highlight.js/styles/github.min.css'
  ];
  let css = '';
  for (const rel of files) {
    const fp = path.join(base, rel);
    try {
      let c = fs.readFileSync(fp, 'utf8');
      const dir = path.dirname(fp);
      c = c.replace(/url\(["']?(?!data:|https?:|file:)([^"')]+)["']?\)/g, (m, u) => {
        try {
          const p = path.resolve(dir, u);
          const ext = path.extname(p).slice(1) || 'woff2';
          return 'url(data:font/' + ext + ';base64,' + fs.readFileSync(p).toString('base64') + ')';
        } catch (e) { return m; }
      });
      css += '\n' + c;
    } catch (e) { /* 文件缺了就跳过 */ }
  }
  return css;
});

ipcMain.handle('clipboard.write', (e, payload) => {
  clipboard.write({ text: payload.text || '', html: payload.html || '' });
  return { ok: true };
});

// ---------- 版本历史 ----------
// userData/history/<sha1(路径)>/ 下存 <ts>.md 快照 + index.json；与草稿互不相干
const histDir = (p) => path.join(userData(), 'history', crypto.createHash('sha1').update(path.normalize(p)).digest('hex'));
const HIST_KEEP = 100, HIST_MAX_AGE = 90 * 864e5;

function histSnap(p, content) {
  try {
    const dir = histDir(p);
    fs.mkdirSync(dir, { recursive: true });
    const idxF = path.join(dir, 'index.json');
    let idx = { path: p, snaps: [] };
    try { idx = JSON.parse(fs.readFileSync(idxF, 'utf8')); } catch (e) {}
    const last = idx.snaps[idx.snaps.length - 1];
    if (last !== undefined) {
      try { if (fs.readFileSync(path.join(dir, last + '.md'), 'utf8') === content) return; } catch (e) {}
    }
    const ts = Date.now();
    fs.writeFileSync(path.join(dir, ts + '.md'), content, 'utf8');
    idx.snaps.push(ts); idx.path = p;
    const now = Date.now();
    idx.snaps = idx.snaps.filter(t => now - t < HIST_MAX_AGE).slice(-HIST_KEEP);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md') && !idx.snaps.includes(+f.slice(0, -3))) fs.unlinkSync(path.join(dir, f));
    }
    fs.writeFileSync(idxF, JSON.stringify(idx));
  } catch (e) { /* 历史是附属功能，失败不阻塞保存 */ }
}

// 文档重命名/移动时把历史一起带走
function histMove(from, to) {
  try {
    const a = histDir(from), b = histDir(to);
    if (!fs.existsSync(a)) return;
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    try {
      const idxF = path.join(b, 'index.json');
      const idx = JSON.parse(fs.readFileSync(idxF, 'utf8'));
      idx.path = to;
      fs.writeFileSync(idxF, JSON.stringify(idx));
    } catch (e) {}
  } catch (e) {}
}

ipcMain.handle('hist.snap', (e, p, content) => { histSnap(p, content); return { ok: true }; });
ipcMain.handle('hist.list', (e, p) => {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(histDir(p), 'index.json'), 'utf8'));
    const snaps = idx.snaps.slice().reverse().map(ts => {
      try { return { ts, size: fs.statSync(path.join(histDir(p), ts + '.md')).size }; }
      catch (e) { return null; }
    }).filter(Boolean);
    return { ok: true, snaps };
  } catch (err) { return { ok: true, snaps: [] }; }
});
ipcMain.handle('hist.read', (e, p, ts) => {
  try { return { ok: true, content: fs.readFileSync(path.join(histDir(p), ts + '.md'), 'utf8') }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('hist.clear', (e, p) => {
  try { fs.rmSync(histDir(p), { recursive: true, force: true }); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
// 行级 diff（diff-match-patch 的 linesToChars 模式），a=旧 b=新
ipcMain.handle('hist.diff', (e, a, b) => {
  const DMP = require('diff-match-patch');
  const dmp = new DMP();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  return { ok: true, diffs };
});

// ---------- 查找 ----------
ipcMain.handle('find', (e, text, forward, findNext) => {
  const w = winOf(e);
  if (!text) {
    w.webContents.stopFindInPage('clearSelection');
    return -1;
  }
  return w.webContents.findInPage(text, { forward: forward !== false, findNext: !!findNext });
});

ipcMain.handle('find.stop', (e) => {
  winOf(e).webContents.stopFindInPage('clearSelection');
});

// ---------- 关闭流程 ----------
ipcMain.handle('app.confirmClose', async (e) => {
  const w = winOf(e);
  const r = await dialog.showMessageBox(w, {
    type: 'warning',
    message: '文档有未保存的修改',
    detail: '关闭前要保存吗？自动草稿仍会保留。',
    buttons: ['保存并关闭', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2
  });
  return r.response;
});

ipcMain.handle('app.closeNow', (e) => {
  const w = winOf(e);
  if (w) { w._allowClose = true; w.close(); }
});

// ---------- pandoc ----------
ipcMain.handle('pandoc.isValid', () => pandocVersion);

ipcMain.handle('pandoc.import', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), {
    properties: ['openFile'],
    filters: PANDOC_IMPORT_FILTERS
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  try {
    // 内嵌图片解到临时目录；引用改 file:// 绝对路径（编辑器可显示，
    // 另存为时 relocateFileImages 会把它们搬进 .assets 改回相对路径）
    // --extract-media 的引用路径 = 传入的参数原样（Windows 下会带上反斜杠绝对路径），
    // 所以传相对目录名 + cwd=其父目录，引用才是干净的 <目录名>/media/x.png
    const mediaDir = path.join(app.getPath('temp'), 'blue-import-' + Date.now());
    const mediaBase = path.basename(mediaDir);
    const out = await runPandoc([
      src, '-f', path.extname(src).slice(1).replace(/^(ltx|tex)$/, 'latex').replace(/^(rest)$/, 'rst').replace(/^(wiki|dokuwiki|mediawiki)$/, 'mediawiki'),
      '-t', 'gfm', '--extract-media', mediaBase
    ], undefined, { cwd: path.dirname(mediaDir) });
    // <mediaBase>/media/x.png → file:// 绝对路径（编辑器可显示，另存为时搬进 .assets）
    const re = new RegExp('(src="|!\\[[^\\]]*\\]\\()\\s*' + mediaBase + '\\/', 'g');
    const content = out.toString('utf8').replace(re, (m, pre) =>
      pre + 'file:///' + mediaDir.replace(/\\/g, '/') + '/');
    return { ok: true, content, fromPath: src };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const PANDOC_EXPORT_FILTERS = [
  { name: 'Word docx', extensions: ['docx'] },
  { name: 'OpenDocument odt', extensions: ['odt'] },
  { name: 'EPUB', extensions: ['epub'] },
  { name: 'LaTeX', extensions: ['latex', 'tex'] },
  { name: 'reStructuredText', extensions: ['rst'] }
];

ipcMain.handle('pandoc.export', async (e, content, defaultName, forceExt, docPath) => {
  const filters = forceExt
    ? PANDOC_EXPORT_FILTERS.filter(f => f.extensions.includes(forceExt))
    : PANDOC_EXPORT_FILTERS;
  const r = await dialog.showSaveDialog(winOf(e), {
    defaultPath: defaultName || 'untitled.docx',
    filters: filters.length ? filters : PANDOC_EXPORT_FILTERS
  });
  if (r.canceled || !r.filePath) return null;
  const dst = r.filePath;
  const fmt = { '.docx': 'docx', '.odt': 'odt', '.epub': 'epub', '.latex': 'latex', '.tex': 'latex', '.rst': 'rst' }[path.extname(dst).toLowerCase()];
  if (!fmt) return { ok: false, error: '不支持的导出格式' };
  const tmp = path.join(app.getPath('temp'), 'blue-editor-export-' + Date.now() + '.md');
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    // 相对路径图片按文档所在目录解析——md 写在 temp 里，必须把 cwd 指过去
    const cwd = docPath ? path.dirname(docPath) : undefined;
    await runPandoc([tmp, '-f', 'gfm', '-t', fmt, '-o', dst], undefined, { cwd });
    return { ok: true, path: dst };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

// ---------- 自动更新（仅安装版；绿色版/开发模式跳过）----------
let autoUpdater = null;
let manualUpdateCheck = false;

function msgBox(w, opts) {
  return dialog.showMessageBox(w || win || wins.values().next().value, opts);
}

function checkUpdates(manual) {
  if (!autoUpdater) {
    msgBox(null, { type: 'info', message: '当前版本不支持在线更新', detail: '绿色版请前往发布页下载新版。' });
    return;
  }
  manualUpdateCheck = !!manual;
  // 失败走 error 事件提示；这里吞掉 rejection 避免 unhandled rejection
  autoUpdater.checkForUpdates().catch(() => {});
}

function initAutoUpdater() {
  // PORTABLE_EXECUTABLE_DIR 只在绿色版运行时存在
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    return;
  }
  autoUpdater.autoDownload = false; // 110MB 不能偷偷下——先问用户
  autoUpdater.on('update-available', (info) => {
    const manual = manualUpdateCheck;
    manualUpdateCheck = false;
    // 跳过列表里的版本：手动检查仍提示，启动检查静默
    if (!manual && setting.get('skipUpdateVersion') === info.version) return;
    msgBox(null, {
      type: 'info',
      message: `发现新版本 v${info.version}`,
      detail: '是否下载并安装？（约 110MB，增量更新会更小）',
      buttons: ['下载并安装', '跳过此版本', '稍后'],
      defaultId: 0, cancelId: 2
    }).then(r => {
      if (r.response === 0) autoUpdater.downloadUpdate();
      else if (r.response === 1) setting.put('skipUpdateVersion', info.version);
    });
  });
  autoUpdater.on('update-not-available', () => {
    if (manualUpdateCheck) {
      msgBox(null, { type: 'info', message: '已是最新版本' });
      manualUpdateCheck = false;
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    msgBox(null, {
      type: 'info',
      message: `新版本 v${info.version} 已下载完成`,
      detail: '重启应用即可完成安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0, cancelId: 1
    }).then(r => {
      if (r.response !== 0) return;
      // 安装前先让各窗口把草稿写盘——quitAndInstall 跳过未保存确认，
      // 不写的话防抖窗口期内的输入会丢
      wins.forEach(w => {
        try { w.webContents.send('menu:action', { action: 'app:flushDraft' }); } catch (e) {}
      });
      setTimeout(() => {
        app._installing = true; // 跳过各窗口的未保存确认
        autoUpdater.quitAndInstall();
      }, 600);
    });
  });
  autoUpdater.on('error', (err) => {
    if (manualUpdateCheck) {
      msgBox(null, { type: 'error', message: '检查更新失败', detail: String(err && err.message || err) });
      manualUpdateCheck = false;
    }
  });
  if (setting.get('autoUpdate') !== false) {
    autoUpdater.checkForUpdates().catch(() => {}); // 断网/代理失败静默
  }
}

// ---------- 生命周期 ----------
// setName 必须在 ready 前调用：userData 路径由 app name 决定，
// 迟了会落到 %APPDATA%/<package name>（'blue-editor'）而不是 'Blue Editor'
app.setName('Blue Editor');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, cwd) => {
    const p = getFilePath(argv, cwd);
    if (p && isOpenable(p)) {
      // 新文件开新窗
      deliverTo(createWindow(), argv, cwd);
    } else {
      const w = win || createWindow();
      if (w.isMinimized()) w.restore();
      w.focus();
      if (p) dialog.showErrorBox('Blue Editor', '不支持的文件类型：' + p);
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('blue.editor');
    initAutoUpdater();
    detectPandoc();
    const w = createWindow();
    deliverTo(w, process.argv, process.cwd());
    restoreDrafts();
  });
}

app.on('window-all-closed', () => app.quit());
