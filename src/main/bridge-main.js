/**
 * BlueTalk v1 → v2 Brücken-Version (1.1.25).
 *
 * Diese Version ersetzt die alte Electron-App durch einen einmaligen Migrator:
 * Bestehende v1-Installationen bekommen sie per electron-updater. Beim Start
 * lädt sie den neuesten v2-Tauri-Installer aus dem GitHub-Release herunter,
 * startet ihn (er installiert v2 unter derselben App-ID) und beendet sich.
 *
 * Läuft der Download/Start nicht, öffnet ein Klick die Release-Seite.
 */
'use strict';

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'Bluetalk/bluetalk';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const SETUP_ASSET_RE = /_x64-setup\.exe$/i;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    title: 'BlueTalk 2.0',
    backgroundColor: '#0a0a0f',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml()));
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    html,body{height:100%}
    body{margin:0;display:flex;align-items:center;justify-content:center;
      font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#ededed}
    .card{text-align:center;padding:28px 32px;max-width:380px}
    h1{font-size:19px;margin:0 0 8px;letter-spacing:-.3px}
    p{font-size:13px;line-height:1.5;color:#a1a1aa;margin:0 0 18px}
    .status{font-size:12px;color:#71717a;min-height:16px}
    .bar{height:4px;border-radius:99px;background:#222;overflow:hidden;margin:14px 0 6px}
    .fill{height:100%;width:0;background:#fff;transition:width .2s}
    a.btn{display:none;margin-top:14px;padding:9px 16px;border-radius:8px;background:#fff;
      color:#000;text-decoration:none;font-size:13px;font-weight:600}
  </style></head><body>
  <div class="card">
    <h1>BlueTalk 2.0 wird installiert</h1>
    <p>Die neue, deutlich schnellere Version wird geladen und eingerichtet. Das dauert nur einen Moment.</p>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="status" id="status">Suche nach der neuesten Version…</div>
    <a class="btn" id="manual" href="${RELEASES_PAGE}">Manuell herunterladen</a>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('progress', (_e, p) => {
      document.getElementById('fill').style.width = Math.max(0, Math.min(100, p.percent||0) ) + '%';
      if (p.text) document.getElementById('status').textContent = p.text;
    });
    ipcRenderer.on('failed', () => {
      document.getElementById('status').textContent = 'Automatische Installation nicht möglich.';
      const b = document.getElementById('manual'); b.style.display = 'inline-block';
    });
  </script></body></html>`;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BlueTalk-Migrator', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'BlueTalk-Migrator' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) onProgress(Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    }).on('error', reject);
  });
}

async function migrate() {
  try {
    send('progress', { percent: 4, text: 'Suche nach BlueTalk 2.0…' });
    // Gezielt das neueste v2-Release suchen (unabhaengig davon, welches Release
    // als „latest" markiert ist — das kann waehrend der Migration das
    // electron-updater-Bruecken-Release sein).
    const releases = await httpJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
    const v2 = (Array.isArray(releases) ? releases : [])
      .filter((r) => !r.draft && /^v?2\./.test(String(r.tag_name || '')))
      .find((r) => (r.assets || []).some((a) => SETUP_ASSET_RE.test(a.name || '')));
    if (!v2) throw new Error('kein v2-Release mit Installer gefunden');
    const asset = (v2.assets || []).find((a) => SETUP_ASSET_RE.test(a.name || ''));
    if (!asset) throw new Error('kein Installer im Release gefunden');

    const target = path.join(os.tmpdir(), asset.name);
    send('progress', { percent: 8, text: 'Lade BlueTalk 2.0…' });
    await download(asset.browser_download_url, target, (percent) => {
      send('progress', { percent: 8 + Math.round(percent * 0.88), text: `Lade BlueTalk 2.0… ${percent}%` });
    });

    send('progress', { percent: 98, text: 'Installation wird gestartet…' });
    const child = spawn(target, [], { detached: true, stdio: 'ignore' });
    child.unref();
    send('progress', { percent: 100, text: 'Installer gestartet. Diese Version wird ersetzt.' });
    setTimeout(() => app.quit(), 1500);
  } catch (error) {
    console.error('[migration] failed:', error);
    send('failed');
  }
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  createWindow();
  win.webContents.on('did-finish-load', () => { void migrate(); });
});

app.on('window-all-closed', () => app.quit());

ipcMain.on('open-manual', () => shell.openExternal(RELEASES_PAGE));
