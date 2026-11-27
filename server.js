// Front proxy for the xray VLESS+WS node (Route B image entrypoint).
//
// Listens on $PORT (platform-injected) and:
//   - GET / (or /index.html) -> serves www/index.html, an honest status
//     page for this privately operated encrypted tunnel service.
//   - GET /health            -> plain "ok" (platform health checks).
//   - WebSocket upgrade      -> raw TCP proxy to xray on 127.0.0.1:10000.
//   - Any other HTTP request -> proxied to xray (which answers 404).
//
// Why a front is needed: xray's inbound "fallbacks" cannot serve a page
// to a browser. For a WS inbound the WS handler answers 404 for any
// non-WebSocket HTTP request before fallback is consulted (verified
// locally 2026-11-25 against xray 26.11.9: plain GET / returned 404 and
// nothing ever reached the fallback server). A visible interface
// therefore needs a real HTTP front, which this file is.
//
// Adapted from the Eurobase Node wrapper (deploy-eurobase/server.js),
// which proved the same pattern in production. Differences here:
//   - / serves www/index.html instead of plain "ok".
//   - adm-zip is required lazily, only when xray must be downloaded;
//     the Docker image pre-seeds the xray binary, so no npm install is
//     needed at image build time.

const http = require('http');
const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const XRAY_PORT = 10000;
const XRAY_VERSION = process.env.XRAY_VERSION || 'v26.11.9';
const XRAY_DIR = '/tmp/xray-core';
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const WWW_ROOT = path.join(__dirname, 'www');
const INDEX_FILE = path.join(WWW_ROOT, 'index.html');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'duer-node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error('download HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) {
    try { fs.accessSync(XRAY_BIN, fs.constants.X_OK); console.log('[front] xray already present'); return; } catch (_) {}
  }
  const AdmZip = require('adm-zip');
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  const zipPath = path.join(XRAY_DIR, 'xray.zip');
  const arch = process.arch === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
  const url = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${arch}`;
  console.log('[front] downloading ' + url);
  await download(url, zipPath);
  console.log('[front] extracting');
  new AdmZip(zipPath).extractAllTo(XRAY_DIR, true);
  fs.chmodSync(XRAY_BIN, 0o755);
  console.log('[front] xray ready');
}

function startXray() {
  const child = spawn('sh', ['entrypoint.sh'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(XRAY_PORT), XRAY_BIN }),
    stdio: 'inherit',
  });
  child.on('error', (err) => console.log('[front] entrypoint spawn error: ' + err.message));
  child.on('exit', (code) => console.log('[front] entrypoint exited code ' + code));
  return child;
}

ensureXray().then(startXray).catch((err) => console.log('[front] xray setup failed: ' + err.message));

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: XRAY_PORT, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('bad gateway');
  });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`front listening on 0.0.0.0:${PORT}, xray on 127.0.0.1:${XRAY_PORT}`);
});
