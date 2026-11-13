const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const UI_DIR = path.join(__dirname, 'ui');
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 10;

let server;
let connectionInfo;
let receivedDir;
const sessions = new Set();
const pairingAttempts = new Map();

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
}

function safeFilename(input) {
  const leaf = String(input || 'file').replace(/\\/g, '/').split('/').pop();
  let name = (leaf || 'file')
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!name || name === '.' || name === '..') name = 'file';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
    name = `_${name}`;
  }
  return name.slice(0, 240);
}

async function reserveFile(filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = filename;
  let suffix = 1;

  while (true) {
    const filePath = path.join(receivedDir, candidate);
    try {
      const handle = await fs.promises.open(filePath, 'wx');
      return { filePath, handle };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      candidate = `${base} (${suffix})${extension}`;
      suffix += 1;
    }
  }
}

function getLanAddresses(port) {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...new Set(addresses)];
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return sessions.has(token);
}

async function listFiles() {
  const entries = await fs.promises.readdir(receivedDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(receivedDir, entry.name);
    const stat = await fs.promises.stat(fullPath);
    files.push({ name: entry.name, size: stat.size, modified: stat.mtime.toISOString() });
  }
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && requestUrl.pathname === '/api/pair') {
    const now = Date.now();
    const attempts = pairingAttempts.get(req.socket.remoteAddress) || [];
    const recentAttempts = attempts.filter((timestamp) => now - timestamp < PAIR_WINDOW_MS);
    if (recentAttempts.length >= MAX_PAIR_ATTEMPTS) {
      pairingAttempts.set(req.socket.remoteAddress, recentAttempts);
      sendJson(res, 429, { error: 'Слишком много попыток. Попробуйте через несколько минут.' });
      return;
    }
    recentAttempts.push(now);
    pairingAttempts.set(req.socket.remoteAddress, recentAttempts);

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024) {
        sendJson(res, 400, { error: 'Некорректный запрос.' });
        return;
      }
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'Некорректный запрос.' });
      return;
    }

    if (payload.code !== connectionInfo.code) {
      sendJson(res, 401, { error: 'Неверный код подключения.' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    sendJson(res, 200, { token });
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'Сначала введите код подключения.' });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/files') {
      sendJson(res, 200, { files: await listFiles() });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/files') {
      const requestedName = safeFilename(requestUrl.searchParams.get('name'));
      const reservation = await reserveFile(requestedName);
      let totalBytes = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          totalBytes += chunk.length;
          if (totalBytes > MAX_FILE_SIZE) {
            callback(new Error('FILE_TOO_LARGE'));
            return;
          }
          callback(null, chunk);
        }
      });

      try {
        await pipeline(req, limiter, reservation.handle.createWriteStream());
        sendJson(res, 201, { name: path.basename(reservation.filePath), size: totalBytes });
      } catch (error) {
        await fs.promises.rm(reservation.filePath, { force: true });
        if (error.message === 'FILE_TOO_LARGE') {
          sendJson(res, 413, { error: 'Максимальный размер файла — 10 ГБ.' });
        } else if (!res.destroyed && !res.headersSent) {
          console.error('File upload failed:', error);
          sendJson(res, 500, { error: 'Не удалось сохранить файл.' });
        }
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/download') {
      const name = requestUrl.searchParams.get('name');
      if (!name || safeFilename(name) !== name) {
        sendJson(res, 400, { error: 'Некорректное имя файла.' });
        return;
      }
      const filePath = path.join(receivedDir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('Not a file');
        const encodedName = encodeURIComponent(name).replace(/['()*]/g, (char) =>
          `%${char.charCodeAt(0).toString(16).toUpperCase()}`
        );
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`
        });
        await pipeline(fs.createReadStream(filePath), res);
      } catch (error) {
        if (!res.headersSent) sendJson(res, 404, { error: 'Файл не найден.' });
      }
      return;
    }

    sendJson(res, 404, { error: 'Маршрут не найден.' });
    return;
  }

  if (req.method === 'GET' && ['/', '/index.html', '/renderer.js', '/styles.css'].includes(requestUrl.pathname)) {
    const filename = requestUrl.pathname === '/' ? 'index.html' : path.basename(requestUrl.pathname);
    const contentTypes = {
      'index.html': 'text/html; charset=utf-8',
      'renderer.js': 'text/javascript; charset=utf-8',
      'styles.css': 'text/css; charset=utf-8'
    };
    try {
      const contents = await fs.promises.readFile(path.join(UI_DIR, filename));
      res.writeHead(200, { 'Content-Type': contentTypes[filename], 'Cache-Control': 'no-cache' });
      res.end(contents);
    } catch (error) {
      console.error('Could not serve UI file:', error);
      sendJson(res, 500, { error: 'Не удалось загрузить интерфейс.' });
    }
    return;
  }

  sendJson(res, 404, { error: 'Страница не найдена.' });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 680,
    minHeight: 560,
    title: 'lan-share — обмен файлами',
    backgroundColor: '#f4f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.loadFile(path.join(UI_DIR, 'index.html'));
}

app.whenReady().then(async () => {
  receivedDir = path.join(app.getPath('userData'), 'received');
  await fs.promises.mkdir(receivedDir, { recursive: true });

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error('Request failed:', error);
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
    });
  });
  server.on('error', (error) => {
    console.error('LAN server failed:', error);
  });
  server.listen(0, '0.0.0.0', () => {
    const port = server.address().port;
    connectionInfo = {
      port,
      code: String(crypto.randomInt(100000, 1000000)),
      addresses: getLanAddresses(port)
    };
    createWindow();
  });

  ipcMain.handle('connection-info', () => connectionInfo);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (server) server.close();
});
