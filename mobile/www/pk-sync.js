// PK Sync: keeps a phone app and its laptop twin in step over the same Wi-Fi.
// The laptop app answers on a port; the phone finds it, asks once to be allowed, then merges.
// Merging is three-way: what each side changed since the last sync is kept, edits beat deletes,
// lists of things with ids (sessions, tasks, highlights...) are combined item by item.
(function () {
  'use strict'
  const P = window.Capacitor.Plugins
  const Http = P.CapacitorHttp, FS = P.Filesystem, App = P.App, PkNet = P.PkNet

  // ---------- merge ----------
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
    if (isObj(v)) return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
    return v === undefined ? 'null' : JSON.stringify(v)
  }
  const same = (a, b) => stable(a) === stable(b)
  const idList = x => Array.isArray(x) && x.length > 0 && x.every(e => isObj(e) && (typeof e.id === 'string' || typeof e.id === 'number'))
  const plainList = x => Array.isArray(x) && x.every(e => !isObj(e) && !Array.isArray(e))
  function mergeById(base, a, b, preferA) {
    const bm = new Map((Array.isArray(base) ? base : []).filter(isObj).map(e => [e.id, e]))
    const am = new Map(a.map(e => [e.id, e])), bb = new Map(b.map(e => [e.id, e]))
    const out = []
    const seen = new Set()
    for (const e of [...a, ...b]) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      const inA = am.has(e.id), inB = bb.has(e.id), old = bm.get(e.id)
      if (inA && inB) out.push(merge3(old, am.get(e.id), bb.get(e.id), preferA))
      else if (inA) { if (old && same(old, am.get(e.id))) continue; out.push(am.get(e.id)) } // b deleted it
      else { if (old && same(old, bb.get(e.id))) continue; out.push(bb.get(e.id)) }
    }
    return out
  }
  function mergePlain(base, a, b) {
    const bs = new Set((Array.isArray(base) ? base : []).map(stable))
    const as = new Set(a.map(stable)), bset = new Set(b.map(stable))
    const out = [], seen = new Set()
    for (const e of [...a, ...b]) {
      const k = stable(e)
      if (seen.has(k)) continue
      seen.add(k)
      if (bs.has(k) && (!as.has(k) || !bset.has(k))) continue // one side removed it
      out.push(e)
    }
    return out
  }
  function merge3(base, a, b, preferA) {
    if (same(a, b)) return a
    if (base !== undefined && same(a, base)) return b
    if (base !== undefined && same(b, base)) return a
    if (isObj(a) && isObj(b)) {
      const bo = isObj(base) ? base : {}
      const out = {}
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const inA = k in a, inB = k in b
        if (inA && inB) out[k] = merge3(bo[k], a[k], b[k], preferA)
        else if (inA) { if (k in bo && same(a[k], bo[k])) continue; out[k] = a[k] }
        else { if (k in bo && same(b[k], bo[k])) continue; out[k] = b[k] }
      }
      return out
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if ((idList(a) || !a.length) && (idList(b) || !b.length) && (idList(a) || idList(b))) return mergeById(base, a, b, preferA)
      if (plainList(a) && plainList(b)) return mergePlain(base, a, b)
    }
    return preferA ? a : b
  }

  // ---------- helpers ----------
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  function deviceName() {
    const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/)
    const model = m && m[1] && !/^K$/.test(m[1].trim()) ? m[1].trim() : ''
    return model ? `Android phone (${model})` : 'Android phone'
  }

  window.PKSync = function create(opts) {
    const { app, label, port, adapter } = opts
    const CFG = 'pksync:' + app
    const BASE = `pksync-${app}-base.json`
    let cfg = {}
    try { cfg = JSON.parse(localStorage.getItem(CFG) || '{}') } catch { cfg = {} }
    const saveCfg = () => { try { localStorage.setItem(CFG, JSON.stringify(cfg)) } catch { /* full */ } }
    let busy = false, again = false, dirty = false, localChangedAt = 0, lastRev = null, applying = false, lastSearch = 0
    let status = { text: cfg.token ? 'Waiting to sync' : 'Not set up', kind: cfg.token ? 'idle' : 'off', detail: '' }
    const subs = new Set()
    const setStatus = (text, kind = 'idle', detail = '') => { status = { text, kind, detail }; subs.forEach(f => { try { f(status) } catch { /* ignore */ } }) }

    async function req(method, path, data, timeout = 15000, host = cfg.host) {
      const r = await Http.request({
        url: `http://${host}:${port}${path}`, method,
        headers: { 'Content-Type': 'application/json', 'X-PK-Token': cfg.token || '' },
        data, connectTimeout: timeout, readTimeout: timeout, responseType: 'json',
      })
      let body = r.data
      if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* text */ } }
      return { status: r.status, data: body }
    }
    async function loadBase() {
      try { return JSON.parse((await FS.readFile({ path: BASE, directory: 'DATA', encoding: 'utf8' })).data) } catch { return {} }
    }
    const saveBase = s => FS.writeFile({ path: BASE, directory: 'DATA', encoding: 'utf8', data: JSON.stringify(s) })

    // ---------- finding and pairing ----------
    async function probe(ip, timeout = 900) {
      try {
        const r = await req('GET', '/ping', undefined, timeout, ip)
        return r.status === 200 && r.data && r.data.app === label ? { ip, host: r.data.host } : null
      } catch { return null }
    }
    async function findLaptops(onProgress) {
      let addrs = []
      try { addrs = (await PkNet.lanInfo()).addresses || [] } catch (e) { console.warn(e) }
      if (cfg.host) { const hit = await probe(cfg.host, 1500); if (hit) return [hit] }
      const mine = new Set(addrs.map(a => a.ip))
      const prefixes = [...new Set(addrs.map(a => a.ip.split('.').slice(0, 3).join('.')))]
      if (!prefixes.length) throw new Error('This phone is not on Wi-Fi (or a hotspot) right now.')
      const ips = []
      for (const p of prefixes) for (let i = 1; i < 255; i++) if (!mine.has(`${p}.${i}`)) ips.push(`${p}.${i}`)
      const found = []
      let done = 0
      const queue = ips.slice()
      await Promise.all(Array.from({ length: 48 }, async () => {
        while (queue.length) {
          const ip = queue.shift()
          const hit = await probe(ip)
          if (hit) found.push(hit)
          onProgress && onProgress(++done / ips.length)
        }
      }))
      return found
    }
    async function pair(ip) {
      setStatus(`Check your laptop and press "Allow"`, 'busy')
      const r = await req('POST', '/pair', { device: deviceName() }, 120000, ip)
      if (r.status === 403) throw new Error('The laptop said no.')
      if (r.status !== 200 || !r.data || !r.data.token) throw new Error((r.data && r.data.error) || 'Pairing failed')
      cfg = { host: ip, token: r.data.token, hostName: r.data.host, pairedAt: Date.now() }
      saveCfg()
      lastRev = null
      setStatus('Paired', 'ok')
      return cfg
    }
    async function forget() {
      cfg = {}; saveCfg(); lastRev = null
      try { await FS.deleteFile({ path: BASE, directory: 'DATA' }) } catch { /* none */ }
      setStatus('Not set up', 'off')
    }

    // ---------- syncing ----------
    async function reach() {
      try {
        const r = await req('GET', '/rev', undefined, 3000)
        if (r.status === 200) return r
        if (r.status === 401) return r
      } catch { /* try to find it again: the laptop's address may have changed */ }
      // a full search of the network at most every 2 minutes, to spare the battery
      if (Date.now() - lastSearch < 120000) return null
      lastSearch = Date.now()
      const found = await findLaptops().catch(() => [])
      for (const f of found) {
        const r = await req('GET', '/rev', undefined, 3000, f.ip).catch(() => null)
        if (r && r.status === 200) { cfg.host = f.ip; saveCfg(); return r }
      }
      return null
    }
    async function syncNow(force) {
      if (!cfg.token) return
      if (busy || transferring) { again = true; return }
      busy = true
      try {
        const r = await reach()
        if (!r) { setStatus('Laptop not found', 'warn', `Open ${label} on your laptop, on the same Wi-Fi as this phone.`); return }
        if (r.status === 401) { await forget(); setStatus('The laptop no longer knows this phone', 'warn', 'Set up sync again.'); return }
        if (!force && r.data.rev === lastRev && !dirty) { setStatus(lastText(), 'ok'); return }
        setStatus('Syncing…', 'busy')
        for (let attempt = 0; attempt < 3; attempt++) {
          const st = (await req('GET', '/state', undefined, 60000)).data
          const lapDoc = adapter.laptopDoc(st)
          const local = adapter.getLocal()
          if (!local) return
          const saved = await loadBase()
          const ctx = { extra: saved.extra || {}, st, req, port, cfg, label }
          const Pw = await adapter.toWire(local, 'phone', ctx)
          const Lw = lapDoc ? await adapter.toWire(lapDoc, 'laptop', ctx) : null
          let M
          if (!Lw) M = Pw
          else if (!saved.base && adapter.isFresh(local)) M = Lw
          else M = merge3(saved.base, Pw, Lw, saved.base ? localChangedAt > (st.changedAt || 0) : false)
          if (adapter.afterMerge) await adapter.afterMerge(M, ctx, local, lapDoc)
          const newL = await adapter.fromWire(M, 'laptop', lapDoc || {}, ctx)
          const newP = await adapter.fromWire(M, 'phone', local, ctx)
          let rev = st.rev
          if (!lapDoc || !same(newL, lapDoc)) {
            const put = await req('PUT', '/state', { data: newL, rev: st.rev }, 60000)
            if (put.status === 409) { await sleep(400); continue }
            if (put.status !== 200) throw new Error((put.data && put.data.error) || `laptop said ${put.status}`)
            rev = put.data.rev
          }
          dirty = false
          if (!same(newP, local)) { applying = true; try { await adapter.applyLocal(newP) } finally { setTimeout(() => { applying = false }, 600) } }
          await saveBase({ base: M, extra: ctx.extra })
          lastRev = rev
          cfg.lastSync = Date.now(); saveCfg()
          setStatus(lastText(), 'ok')
          if (adapter.transfers) setTimeout(() => runTransfers(), 50)
          return
        }
        setStatus('Laptop was busy, will try again', 'warn')
      } catch (e) {
        console.warn('sync', e)
        setStatus('Sync failed', 'warn', String((e && e.message) || e))
      } finally {
        busy = false
        if (again) { again = false; setTimeout(() => syncNow(), 300) }
      }
    }
    let transferring = false
    async function runTransfers() {
      if (transferring || !adapter.transfers) return
      transferring = true
      try {
        const saved = await loadBase()
        const ctx = { extra: saved.extra || {}, req, port, cfg, label, setStatus, save: () => saveBase({ base: saved.base, extra: ctx.extra }) }
        const changed = await adapter.transfers(ctx)
        await ctx.save()
        if (changed) { lastRev = null; dirty = true; setTimeout(() => syncNow(true), 200) }
        else setStatus(lastText(), 'ok')
      } catch (e) {
        console.warn('transfer', e)
        setStatus('Copying books stopped', 'warn', String((e && e.message) || e))
      } finally { transferring = false }
    }
    function lastText() {
      if (!cfg.lastSync) return 'Paired'
      const s = Math.round((Date.now() - cfg.lastSync) / 1000)
      return s < 60 ? 'Synced just now' : s < 3600 ? `Synced ${Math.round(s / 60)} min ago` : `Synced at ${new Date(cfg.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    }

    // local edits: sync a few seconds later
    let dirtyTimer
    function markDirty() {
      if (applying) return
      dirty = true; localChangedAt = Date.now()
      clearTimeout(dirtyTimer)
      dirtyTimer = setTimeout(() => syncNow(), 4000)
    }

    let foreground = true
    if (App) {
      App.addListener('resume', () => { foreground = true; setTimeout(() => syncNow(), 800) })
      App.addListener('pause', () => { foreground = false })
    }
    setInterval(() => { if (foreground && cfg.token) syncNow() }, 20000)
    setTimeout(() => syncNow(), 3000)

    // ---------- the sync sheet ----------
    function openSheet() {
      const wrap = document.createElement('div')
      wrap.className = 'pks-wrap'
      wrap.innerHTML = `<div class="pks-box" role="dialog">
        <div class="pks-head"><b>Sync with your laptop</b><button class="pks-x" aria-label="Close">✕</button></div>
        <div class="pks-status"><i></i><div><div class="pks-text"></div><div class="pks-detail"></div></div></div>
        <div class="pks-body"></div></div>`
      const body = wrap.querySelector('.pks-body')
      const close = () => { wrap.remove(); subs.delete(paint); document.removeEventListener('pks-back', close) }
      wrap.querySelector('.pks-x').onclick = close
      wrap.addEventListener('click', e => { if (e.target === wrap) close() })
      document.addEventListener('pks-back', close)
      const paint = s => {
        wrap.querySelector('.pks-status').dataset.kind = s.kind
        wrap.querySelector('.pks-text').textContent = s.text
        wrap.querySelector('.pks-detail').textContent = s.detail || ''
      }
      subs.add(paint); paint(status)
      const btn = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'pks-btn ' + (cls || ''); b.textContent = text; b.onclick = fn; return b }
      const p = (text, cls) => { const e = document.createElement('p'); e.className = cls || 'pks-note'; e.textContent = text; return e }
      function render() {
        body.innerHTML = ''
        if (cfg.token) {
          body.append(p(`Paired with ${cfg.hostName || 'your laptop'} (${cfg.host}).`))
          body.append(p(`Syncs on its own every few seconds while ${label} is open on both, on the same Wi-Fi.`))
          if (opts.extraSettings) body.append(opts.extraSettings())
          body.append(btn('Sync now', 'primary', () => syncNow(true)))
          body.append(btn('Forget this laptop', 'quiet', async () => { if (confirm('Stop syncing with this laptop? Your data stays on both.')) { await forget(); render() } }))
        } else {
          body.append(p(`1. Open ${label} on your laptop.`), p('2. Connect this phone to the same Wi-Fi as the laptop (or the laptop to your hotspot).'), p('3. Tap Find my laptop, then press Allow on the laptop.'))
          const find = btn('Find my laptop', 'primary', async () => {
            find.disabled = true
            try {
              setStatus('Looking for your laptop…', 'busy')
              const list = await findLaptops(f => setStatus(`Looking for your laptop… ${Math.round(f * 100)}%`, 'busy'))
              if (!list.length) { setStatus('No laptop found', 'warn', `Is ${label} open on the laptop, on the same Wi-Fi? If Windows asked about the firewall, it needs "Allow".`); return }
              await pair(list[0].ip)
              render()
              syncNow(true)
            } catch (e) { setStatus('Could not pair', 'warn', String((e && e.message) || e)) } finally { find.disabled = false }
          })
          body.append(find)
          const manual = document.createElement('div')
          manual.className = 'pks-manual'
          manual.innerHTML = '<input placeholder="or type the laptop\'s IP, e.g. 192.168.1.20" inputmode="decimal">'
          const ip = manual.querySelector('input')
          manual.append(btn('Connect', '', async () => {
            const v = ip.value.trim()
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(v)) return setStatus('That does not look like an IP address', 'warn')
            try {
              setStatus('Connecting…', 'busy')
              if (!(await probe(v, 3000))) return setStatus(`${label} is not answering at ${v}`, 'warn', 'Check that the app is open on the laptop.')
              await pair(v); render(); syncNow(true)
            } catch (e) { setStatus('Could not pair', 'warn', String((e && e.message) || e)) }
          }))
          body.append(manual)
        }
      }
      render()
      document.body.appendChild(wrap)
    }

    return { syncNow, markDirty, openSheet, onStatus: f => { subs.add(f); f(status) }, get paired() { return !!cfg.token }, merge3, stable, same }
  }

  // styles for the sheet and the little sync button
  const css = document.createElement('style')
  css.textContent = `
  .pks-wrap{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center}
  .pks-box{width:100%;max-width:520px;max-height:88dvh;overflow:auto;background:#1b1d23;color:#eceae4;border-radius:18px 18px 0 0;padding:16px 16px calc(18px + env(safe-area-inset-bottom));font:15px/1.45 system-ui,sans-serif;box-shadow:0 -10px 40px rgba(0,0,0,.45)}
  .pks-head{display:flex;justify-content:space-between;align-items:center;font-size:17px;margin-bottom:10px}
  .pks-x{background:none;border:0;color:inherit;font-size:18px;padding:6px 10px}
  .pks-status{display:flex;gap:12px;align-items:flex-start;background:#25282f;border-radius:12px;padding:12px;margin-bottom:12px}
  .pks-status i{width:10px;height:10px;border-radius:50%;margin-top:7px;flex:none;background:#8a8d96}
  .pks-status[data-kind=ok] i{background:#4cc38a}.pks-status[data-kind=busy] i{background:#e0b341;animation:pks-p 1s infinite}.pks-status[data-kind=warn] i{background:#e5654b}
  @keyframes pks-p{50%{opacity:.3}}
  .pks-text{font-weight:600}.pks-detail{color:#a9abb3;font-size:13px;margin-top:2px}
  .pks-note{margin:6px 0;color:#c9c8c3;font-size:14px}
  .pks-btn{display:block;width:100%;margin-top:10px;padding:12px;border-radius:12px;border:1px solid #3a3d46;background:#25282f;color:inherit;font:600 15px system-ui,sans-serif}
  .pks-btn.primary{background:#e0b341;border-color:#e0b341;color:#1b1d23}.pks-btn.quiet{background:none;color:#e5654b;border-color:transparent}
  .pks-btn:disabled{opacity:.5}
  .pks-manual{display:flex;gap:8px;margin-top:14px}.pks-manual input{flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid #3a3d46;background:#111317;color:inherit;font-size:16px}
  .pks-manual .pks-btn{width:auto;margin:0;padding:10px 14px}
  .pks-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0;font-size:14px}
  .pks-fab{position:relative;display:inline-grid;place-items:center;width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:inherit;opacity:.85;flex:none}
  .pks-fab svg{width:20px;height:20px}.pks-fab::after{content:"";position:absolute;right:5px;top:5px;width:8px;height:8px;border-radius:50%;background:#8a8d96;display:none}
  .pks-fab[data-kind=ok]::after{display:block;background:#4cc38a}.pks-fab[data-kind=busy]::after{display:block;background:#e0b341}.pks-fab[data-kind=warn]::after{display:block;background:#e5654b}`
  document.head.appendChild(css)
  window.PKSync.icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/></svg>'
})()
