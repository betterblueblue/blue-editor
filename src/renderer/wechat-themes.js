// 公众号排版主题：选择器 → 内联样式（会逐条 append 到匹配元素的 style 上，
// 后写的规则覆盖先写的）。公众号编辑器会删 <style>/class/id，只能靠行内样式。
window.WECHAT_THEMES = {
  blue: {
    name: 'Blue 经典',
    rules: [
      { s: 'h1', c: 'font-size:22px;font-weight:bold;color:#1a56db;margin:1.6em 0 0.8em;border-bottom:2px solid #1a56db;padding-bottom:6px' },
      { s: 'h2', c: 'font-size:19px;font-weight:bold;color:#1a56db;margin:1.5em 0 0.7em;padding-left:8px;border-left:4px solid #1a56db' },
      { s: 'h3', c: 'font-size:17px;font-weight:bold;color:#2f54eb;margin:1.3em 0 0.6em' },
      { s: 'h4', c: 'font-size:16px;font-weight:bold;color:#333;margin:1.2em 0 0.5em' },
      { s: 'p', c: 'font-size:16px;color:#3f3f3f;line-height:1.75;margin:0.9em 0;letter-spacing:0.3px' },
      { s: 'strong', c: 'color:#1a56db;font-weight:bold' },
      { s: 'em', c: 'color:#1a56db;font-style:normal' },
      { s: 'blockquote', c: 'margin:1.2em 0;padding:12px 16px;background:#f0f5ff;border-left:4px solid #1a56db' },
      { s: 'blockquote p', c: 'color:#5a6b8c;margin:0.4em 0' },
      { s: 'code', c: 'font-family:Consolas,Monaco,monospace;font-size:14px;background:#f0f5ff;color:#d63384;padding:2px 6px;border-radius:4px' },
      { s: 'pre', c: 'background:#282c34;color:#abb2bf;padding:14px 16px;border-radius:8px;margin:1.2em 0;white-space:pre-wrap;word-wrap:break-word;line-height:1.6' },
      { s: 'pre code', c: 'background:transparent;color:inherit;padding:0;font-size:14px' },
      { s: 'ul,ol', c: 'margin:0.9em 0;padding-left:1.6em' },
      { s: 'li', c: 'font-size:16px;color:#3f3f3f;line-height:1.75;margin:0.3em 0' },
      { s: 'li p', c: 'margin:0.3em 0' },
      { s: 'table', c: 'border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px' },
      { s: 'th', c: 'background:#1a56db;color:#fff;padding:8px 12px;border:1px solid #d6e4ff;text-align:left' },
      { s: 'td', c: 'padding:8px 12px;border:1px solid #d6e4ff;color:#3f3f3f' },
      { s: 'hr', c: 'border:none;border-top:1px solid #d6e4ff;margin:2em 0' },
      { s: 'a', c: 'color:#1a56db' },
      { s: 'img', c: 'max-width:100%;border-radius:6px;margin:0.5em 0' },
      { s: '.wechat-refs p', c: 'font-size:13px;color:#888;line-height:1.6;margin:0.3em 0' },
      { s: '.wechat-refs h4', c: 'font-size:14px;color:#999;margin:1.5em 0 0.5em;font-weight:normal' }
    ]
  },
  simple: {
    name: '简约',
    rules: [
      { s: 'h1', c: 'font-size:20px;font-weight:bold;color:#111;margin:1.6em 0 0.8em' },
      { s: 'h2', c: 'font-size:18px;font-weight:bold;color:#111;margin:1.5em 0 0.7em;border-bottom:1px solid #eee;padding-bottom:5px' },
      { s: 'h3,h4', c: 'font-size:16px;font-weight:bold;color:#111;margin:1.3em 0 0.6em' },
      { s: 'p', c: 'font-size:16px;color:#333;line-height:1.8;margin:1em 0' },
      { s: 'strong', c: 'color:#111;font-weight:bold;background:#fff3c4' },
      { s: 'em', c: 'font-style:italic;color:#555' },
      { s: 'blockquote', c: 'margin:1.2em 0;padding:10px 14px;background:#fafafa;border-left:3px solid #ddd' },
      { s: 'blockquote p', c: 'color:#777;margin:0.4em 0' },
      { s: 'code', c: 'font-family:Consolas,Monaco,monospace;font-size:14px;background:#f5f5f5;color:#c7254e;padding:2px 5px;border-radius:3px' },
      { s: 'pre', c: 'background:#f8f8f8;color:#333;padding:14px 16px;border-radius:6px;border:1px solid #eee;margin:1.2em 0;white-space:pre-wrap;word-wrap:break-word;line-height:1.6' },
      { s: 'pre code', c: 'background:transparent;color:inherit;padding:0;font-size:14px' },
      { s: 'ul,ol', c: 'margin:1em 0;padding-left:1.6em' },
      { s: 'li', c: 'font-size:16px;color:#333;line-height:1.8;margin:0.3em 0' },
      { s: 'li p', c: 'margin:0.3em 0' },
      { s: 'table', c: 'border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px' },
      { s: 'th,td', c: 'padding:8px 12px;border:1px solid #e5e5e5;color:#333;text-align:left' },
      { s: 'th', c: 'background:#fafafa' },
      { s: 'hr', c: 'border:none;border-top:1px solid #eee;margin:2em 0' },
      { s: 'img', c: 'max-width:100%;margin:0.5em 0' },
      { s: '.wechat-refs p', c: 'font-size:13px;color:#999;line-height:1.6;margin:0.3em 0' },
      { s: '.wechat-refs h4', c: 'font-size:14px;color:#aaa;margin:1.5em 0 0.5em;font-weight:normal' }
    ]
  },
  tech: {
    name: '技术风',
    rules: [
      { s: 'h1', c: 'font-size:21px;font-weight:bold;color:#0d1117;margin:1.6em 0 0.8em' },
      { s: 'h2', c: 'font-size:18px;font-weight:bold;color:#0d1117;margin:1.5em 0 0.7em;padding:4px 10px;background:#ddf4ff;border-radius:4px' },
      { s: 'h3,h4', c: 'font-size:16px;font-weight:bold;color:#0d1117;margin:1.3em 0 0.6em' },
      { s: 'p', c: 'font-size:15px;color:#24292f;line-height:1.7;margin:0.9em 0' },
      { s: 'strong', c: 'color:#cf222e;font-weight:bold' },
      { s: 'em', c: 'font-style:italic;color:#57606a' },
      { s: 'blockquote', c: 'margin:1.2em 0;padding:10px 14px;background:#f6f8fa;border-left:4px solid #0969da' },
      { s: 'blockquote p', c: 'color:#57606a;margin:0.4em 0' },
      { s: 'code', c: 'font-family:Consolas,"Courier New",monospace;font-size:14px;background:#eff1f3;color:#0550ae;padding:2px 6px;border-radius:4px' },
      { s: 'pre', c: 'background:#0d1117;color:#c9d1d9;padding:14px 16px;border-radius:6px;margin:1.2em 0;white-space:pre-wrap;word-wrap:break-word;line-height:1.6' },
      { s: 'pre code', c: 'background:transparent;color:inherit;padding:0;font-size:13px;font-family:Consolas,"Courier New",monospace' },
      { s: 'ul,ol', c: 'margin:0.9em 0;padding-left:1.6em' },
      { s: 'li', c: 'font-size:15px;color:#24292f;line-height:1.7;margin:0.3em 0' },
      { s: 'li p', c: 'margin:0.3em 0' },
      { s: 'table', c: 'border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px' },
      { s: 'th', c: 'background:#f6f8fa;color:#0d1117;padding:8px 12px;border:1px solid #d0d7de;text-align:left' },
      { s: 'td', c: 'padding:8px 12px;border:1px solid #d0d7de;color:#24292f' },
      { s: 'hr', c: 'border:none;border-top:2px solid #d0d7de;margin:2em 0' },
      { s: 'img', c: 'max-width:100%;border:1px solid #d0d7de;border-radius:4px;margin:0.5em 0' },
      { s: '.wechat-refs p', c: 'font-size:12px;color:#57606a;line-height:1.6;margin:0.3em 0;word-break:break-all' },
      { s: '.wechat-refs h4', c: 'font-size:14px;color:#57606a;margin:1.5em 0 0.5em;font-weight:normal' }
    ]
  }
};
