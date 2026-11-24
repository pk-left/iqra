// Phone sync over the local Wi-Fi. While the desktop app is open it answers the phone app on this
// port. A phone gets in only after you press "Allow" on the laptop; it then keeps a private token.
// The phone does the merging; the laptop just hands over and takes back its data.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function startSyncServer({ dialog, BrowserWindow, name, port, dataDir, getState, putState, routes = {} }) {
  const cfgFile = path.join(dataDir, 'phone-sync.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* first run */ }
  if (!Array.isArray(cfg.devices)) cfg.devices = [];
  const saveCfg = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1)); } catch (e) { console.error(e); } };
  const authed = (req) => {
    const t = req.headers['x-pk-token'];
    return !!t && cfg.devices.some((d) => d.token === t);
  };
  const send = (res, code, obj) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
    res.end(b);
  };
  const body = (req, limit = 256 * 1024 * 1024) => new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { bad(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
  const json = async (req, limit) => { const b = await body(req, limit); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

  let pairing = false;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/ping') return send(res, 200, { app: name, host: os.hostname(), v: 1, paired: authed(req) });
      if (url.pathname === '/pair' && req.method === 'POST') {
        if (pairing) return send(res, 409, { error: 'busy' });
        pairing = true;
        try {
          const { device = 'Phone' } = await json(req, 4096);
          const win = BrowserWindow.getAllWindows()[0];
          if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
          const r = await dialog.showMessageBox(win, {
            type: 'question', buttons: ['Allow', "Don't allow"], defaultId: 0, cancelId: 1, noLink: true,
            title: `${name} sync`,
            message: `Let "${String(device).slice(0, 60)}" sync with ${name}?`,
            detail: `Your phone will be able to read and update your ${name} data while both are on the same Wi-Fi.`,
          });
          if (r.response !== 0) return send(res, 403, { error: 'denied' });
          const token = crypto.randomBytes(24).toString('hex');
          cfg.devices.push({ token, device: String(device).slice(0, 60), added: Date.now() });
          saveCfg();
          return send(res, 200, { token, host: os.hostname() });
        } finally { pairing = false; }
      }
      if (!authed(req)) return send(res, 401, { error: 'not paired' });
      if (url.pathname === '/rev') return send(res, 200, { rev: (await getState(true)).rev });
      if (url.pathname === '/state' && req.method === 'GET') return send(res, 200, await getState(false));
      if (url.pathname === '/state' && req.method === 'PUT') {
        const b = await json(req);
        const r = await putState(b.data, b.rev);
        return send(res, r.ok ? 200 : 409, r);
      }
      const h = routes[url.pathname];
      if (h) return await h(req, res, url, { send, body, json });
      send(res, 404, { error: 'not found' });
    } catch (e) {
      try { send(res, 500, { error: String((e && e.message) || e) }); } catch { /* closed */ }
    }
  });
  server.on('error', (e) => console.error('phone sync server:', e.message));
  server.listen(port, '0.0.0.0');
  return server;
};
