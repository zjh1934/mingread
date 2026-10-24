// 临时探针：验证 Xvfb+RANDR --setmonitor 能否让 Electron screen 模块看到两个显示器
'use strict';
const fs = require('fs');
const { app, screen } = require('electron');

app.whenReady().then(() => {
  const out = [];
  out.push('DISPLAY=' + process.env.DISPLAY);
  try {
    const all = screen.getAllDisplays();
    out.push('getAllDisplays count=' + all.length);
    all.forEach((d) => out.push(`  id=${d.id} bounds=${JSON.stringify(d.bounds)} primary=${d.bounds.x === 0 && d.bounds.y === 0}`));
    const p = screen.getPrimaryDisplay();
    out.push('primary id=' + p.id + ' bounds=' + JSON.stringify(p.bounds));
  } catch (e) {
    out.push('screen error: ' + e.message);
  }
  fs.writeFileSync(__dirname + '/tmp_probe_multiscreen.txt', out.join('\n') + '\n');
  app.exit(0);
});
setTimeout(() => app.exit(1), 15000);
