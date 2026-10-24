'use strict';
const { app } = require('electron');
app.whenReady().then(() => {
  const diag = require('../src/main/diag');
  const p = diag.init();
  diag.log('test', 'hello from probe');
  const fs = require('fs');
  console.log('path=' + p);
  console.log('exists=' + fs.existsSync(p));
  if (fs.existsSync(p)) console.log('content=' + JSON.stringify(fs.readFileSync(p, 'utf8').slice(0, 120)));
  app.exit(0);
});
