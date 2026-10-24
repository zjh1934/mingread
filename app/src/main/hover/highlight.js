// 悬停朗读的高亮层：读到哪一块，屏幕上就框出哪一块。
//
// 为什么必须有它（不是锦上添花）：
//   macOS 的 Hover Text / 朗读指针下的项目都有 element highlight，
//   同类产品（NVDA 视觉高亮、SightSpeak 的 outline、Speechify 的逐句高亮）也都有。
//   对低视力用户，「刚才读的是屏幕上哪一块」这件事**只有看见才能建立对应关系**，
//   光靠声音无法把听觉和版面重新对齐。
//
// 实现取舍：
//   · 用一个常驻的透明置顶窗口画框，而不是 GDI 直接画屏——
//     避免 hook/DC 那些会被安全软件盯上的操作，也方便用 CSS 控制样式与淡出；
//   · 窗口鼠标穿透 + 不抢焦点：绝不能干扰用户正常操作；
//   · 只画描边不填色：填色会盖住文字，低视力用户反而看不清。
'use strict';

const { BrowserWindow, screen } = require('electron');

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;pointer-events:none}
  #layer{position:fixed;inset:0;opacity:0;transition:opacity .12s ease-out}
  #layer.on{opacity:1}
  .m{position:absolute;box-sizing:border-box;border:2px solid #7c6cff;border-radius:4px;
     box-shadow:0 0 0 2px rgba(124,108,255,.22), 0 0 12px rgba(124,108,255,.35)}
</style></head><body><div id="layer"></div>
<script>
  var layer = document.getElementById('layer');
  window.__render = function (rects) {
    layer.innerHTML = '';
    if (!rects || !rects.length) { layer.classList.remove('on'); return; }
    rects.forEach(function (r) {
      if (!(r.w > 2 && r.h > 2)) return;
      var d = document.createElement('div');
      d.className = 'm';
      d.style.left = r.x + 'px';
      d.style.top = r.y + 'px';
      d.style.width = r.w + 'px';
      d.style.height = r.h + 'px';
      layer.appendChild(d);
    });
    layer.classList.add('on');
  };
  window.__clear = function () { layer.classList.remove('on'); };
</script></body></html>`;

let win = null;
let hideTimer = null;

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    // 不进入 Alt+Tab、不抢激活：它只是画框，不是窗口
    webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true },
  });
  try {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    /* 某些环境下不支持，忽略 */
  }
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/**
 * 显示高亮框
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects 屏幕物理像素
 * @param {number} [holdMs] 多久后自动隐藏（默认 4500ms，覆盖一句话的朗读时间）
 */
function show(rects, holdMs) {
  if (!Array.isArray(rects) || !rects.length) return false;
  let w;
  try {
    w = ensure();
  } catch (e) {
    return false;
  }

  // 把物理像素换算成窗口内的 DIP 坐标：窗口覆盖指针所在显示器
  const cx = rects[0].x;
  const cy = rects[0].y;
  const display = screen.getDisplayNearestPoint({ x: Math.round(cx / 1), y: Math.round(cy / 1) });
  const sf = (display && display.scaleFactor) || 1;
  const b = display.bounds;

  const local = rects.map((r) => ({
    x: Math.round(r.x / sf - b.x),
    y: Math.round(r.y / sf - b.y),
    w: Math.round(r.w / sf),
    h: Math.round(r.h / sf),
  }));

  try {
    w.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    if (!w.isVisible()) w.showInactive(); // 不抢焦点
    w.webContents.executeJavaScript(`window.__render && window.__render(${JSON.stringify(local)})`).catch(() => {});
  } catch (e) {
    return false;
  }

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(), holdMs || 4500);
  return true;
}

function hide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.executeJavaScript('window.__clear && window.__clear()').catch(() => {});
    setTimeout(() => {
      try {
        if (win && !win.isDestroyed()) win.hide();
      } catch (e) {
        /* 已销毁 */
      }
    }, 160); // 等淡出过渡结束再隐藏窗口
  } catch (e) {
    /* 忽略 */
  }
}

function dispose() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch (e) {
    /* 忽略 */
  }
  win = null;
}

module.exports = { show, hide, dispose };
