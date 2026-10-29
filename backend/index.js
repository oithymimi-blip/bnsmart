'use strict';

const express = require('express');
const app     = express();
const path    = require('path');
const fs      = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const cors = require('cors');

const publicRoutes = require('./src/routes/public');
const adminRoutes  = require('./src/routes/admin');

const PORT = Number(process.env.PORT || 8787);

app.use(cors({ origin: '*' }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', publicRoutes);
app.use('/api/super', adminRoutes);

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.startsWith('/ref') || req.path.startsWith('/super') || req.path.startsWith('/admin')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

function getFrontendDir() {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
    path.join(__dirname, '..', 'frontend'),
    path.join(__dirname, 'src', 'public')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return path.join(__dirname, 'public');
}

const frontendDir = getFrontendDir();

const _htmlCache = {};
function safeSend(res, filename) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (_htmlCache[filename]) {
    return res.send(_htmlCache[filename]);
  }
  const candidatePaths = [
    path.join(frontendDir, filename),
    path.join(__dirname, 'public', filename),
    path.join(__dirname, '..', 'public', filename),
    path.join(__dirname, '..', 'frontend', filename),
    path.join(process.cwd(), 'public', filename),
    path.join(process.cwd(), 'backend', 'public', filename),
    path.join(process.cwd(), 'frontend', filename)
  ];
  for (const fp of candidatePaths) {
    try {
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf8');
        _htmlCache[filename] = content;
        return res.send(content);
      }
    } catch (_) {}
  }
  return res.status(200).send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/"></head><body>Loading...</body></html>`);
}

app.get(['/admin', '/admin/', '/admin.html'], (_req, res) => {
  safeSend(res, 'admin.html');
});

app.get(['/super', '/super/', '/super.html'], (_req, res) => {
  safeSend(res, 'super.html');
});

app.get(['/ref', '/ref/*', '/ref*'], (_req, res) => {
  safeSend(res, 'index.html');
});

app.use(express.static(frontendDir, { etag: false, maxAge: 0 }));

app.get(['/', '/index.html'], (_req, res) => {
  safeSend(res, 'index.html');
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 BNSmart Server running on http://localhost:${PORT}`);
    console.log(`   ├─ User Portal : http://localhost:${PORT}/`);
    console.log(`   ├─ Admin Logs  : http://localhost:${PORT}/admin`);
    console.log(`   ├─ Super Portal: http://localhost:${PORT}/super`);
    console.log(`   └─ Health Check: http://localhost:${PORT}/health\n`);
  });
}

module.exports = app;
module.exports.default = app;
