// Iqra on Android: stands in for the Electron main process + preload (window.api) using Capacitor.
// Same channels as the desktop app, so the reader, library and study code run unchanged.
(function () {
  'use strict'
  const Cap = window.Capacitor
  const P = Cap.Plugins
  const FS = P.Filesystem, App = P.App, Share = P.Share, SB = P.StatusBar, Browser = P.Browser
  const Http = P.CapacitorHttp, Native = P.IqraNative
  document.documentElement.classList.add('mobile')

  const BOOK_EXT = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'kf8', 'prc', 'fb2', 'fbz', 'cbz', 'cbr', 'cb7', 'cbt', 'djvu', 'djv']
  const DOC_EXT = ['txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'docx', 'odt', 'rtf']
  const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'jxl']
  const ALL_EXT = new Set([...BOOK_EXT, ...DOC_EXT])
  const extOf = p => { const n = p.toLowerCase(); if (n.endsWith('.fb2.zip')) return 'fbz'; const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1) }
  const enc = p => p.split('/').map(encodeURIComponent).join('/')
  const furi = p => 'file://' + enc(p)
  const FILE_PREFIX = location.origin + '/_capacitor_file_'
  const b64ToBytes = b => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u }
  const bytesToB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) }
  const toBytes = d => d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : Array.isArray(d) ? Uint8Array.from(d) : new Uint8Array(Object.values(d || {}))

  // ---------- file URLs ----------
  window.__fileSrc = p => (/^(blob:|data:|https?:)/.test(p) ? p : FILE_PREFIX + enc(p))
  let DATA = '' // app-private folder (absolute path)
  window.__coverSrc = id => FILE_PREFIX + enc(`${DATA}/covers/${id}.jpg`)

  // Book files are read in pieces (zip-based formats read only what they need). The WebView's
  // local server does not do byte ranges reliably, so ranged reads go through a native call.
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url
    if (url && url.startsWith(FILE_PREFIX)) {
      const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || {})
      const range = headers.get('range')
      const path = url.slice(FILE_PREFIX.length).split('?')[0].split('/').map(decodeURIComponent).join('/')
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)
        const start = m ? +m[1] : 0
        const end = m && m[2] ? +m[2] : start + 8 * 1024 * 1024 - 1
        try {
          const r = await Native.readRange({ path, offset: start, length: end - start + 1 })
          const body = b64ToBytes(r.data)
          return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + body.length - 1}/${r.size}`, 'Content-Length': String(body.length) } })
        } catch (e) { return new Response('Not found', { status: 404 }) }
      }
      try {
        const st = await FS.stat({ path: furi(path) })
        if (st.type !== 'file') return new Response('Not found', { status: 404 })
      } catch { return new Response('Not found', { status: 404 }) }
      return nativeFetch(url.split('?')[0])
    }
    return nativeFetch(input, init)
  }

  // ---------- data stores ----------
  const STORES = ['library', 'settings', 'annotations', 'stats', 'study']
  const db = {}
  const saveTimers = {}
  const listeners = {}
  const emit = (ch, ...a) => (listeners[ch] || []).forEach(fn => { try { fn(...a) } catch (e) { console.error(e) } })
  async function readJSON(rel) {
    try { return JSON.parse((await FS.readFile({ path: rel, directory: 'DATA', encoding: 'utf8' })).data) } catch { return null }
  }
  async function saveStore(name) {
    const text = JSON.stringify(db[name] ?? {})
    try {
      // keep the previous good copy as .bak, then write
      try { await FS.deleteFile({ path: name + '.json.bak', directory: 'DATA' }) } catch { /* none yet */ }
      try { await FS.copy({ from: name + '.json', to: name + '.json.bak', directory: 'DATA', toDirectory: 'DATA' }) } catch { /* first save */ }
      await FS.writeFile({ path: name + '.json', directory: 'DATA', encoding: 'utf8', data: text })
    } catch (e) { console.error('save failed', name, e) }
  }
  function scheduleSave(name) {
    if (saveTimers[name]) return
    saveTimers[name] = setTimeout(() => { delete saveTimers[name]; saveStore(name) }, 1500)
  }
  function flushStores() {
    return Promise.all(Object.keys(saveTimers).map(name => { clearTimeout(saveTimers[name]); delete saveTimers[name]; return saveStore(name) }))
  }
  function applyPatch(root, p, value, op) {
    let o = root
    for (let i = 0; i < p.length - 1; i++) { const k = p[i]; if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k] }
    const k = p[p.length - 1]
    if (op === 'inc') o[k] = (Number(o[k]) || 0) + value
    else if (value === null || value === undefined) delete o[k]
    else o[k] = value
  }

  let ROOT = '/storage/emulated/0'
  let allFiles = false
  const ready = (async () => {
    DATA = decodeURIComponent((await FS.getUri({ path: '', directory: 'DATA' })).uri.replace(/^file:\/\//, '')).replace(/\/$/, '')
    try { await FS.mkdir({ path: 'covers', directory: 'DATA', recursive: true }) } catch { /* exists */ }
    for (const name of STORES) db[name] = (await readJSON(name + '.json')) ?? (await readJSON(name + '.json.bak')) ?? {}
    try { const s = await Native.checkAllFiles(); allFiles = s.granted; ROOT = s.root || ROOT } catch (e) { console.warn(e) }
    // on a phone the sidebar is a drawer: start closed
    if (innerWidth <= 820) ((db.settings.app ||= {}).sidebarCollapsed = true)
  })()

  // drawer: picking a shelf or tapping outside closes it
  const toggleSide = () => document.querySelector('#topbar button[title^="Show or hide sidebar"]')?.click()
  document.addEventListener('click', e => {
    if (innerWidth > 820 || document.body.classList.contains('side-collapsed')) return
    if (e.target.closest('#topbar button[title^="Show or hide sidebar"]')) return
    const inSide = e.target.closest('#sidebar')
    if (!inSide) { e.preventDefault(); e.stopPropagation(); toggleSide() }
    else if (e.target.closest('.nav')) setTimeout(toggleSide, 120)
  }, true)

  if (App) {
    App.addListener('pause', () => { flushStores() })
    App.addListener('resume', async () => {
      try {
        const s = await Native.checkAllFiles()
        if (s.granted && !allFiles) { allFiles = true; location.reload() }
      } catch { /* ignore */ }
    })
  }

  // ---------- scanning ----------
  const SKIP_DIRS = new Set(['android', 'node_modules', 'lost.dir', '.thumbnails', 'thumbnails', 'cache', 'telegram x', 'whatsapp'])
  async function readdir(dir) {
    try { return (await FS.readdir({ path: furi(dir) })).files } catch { return [] }
  }
  async function walk(dir, depth, out, exts) {
    for (const e of await readdir(dir)) {
      const full = `${dir}/${e.name}`
      if (e.type === 'directory') {
        const low = e.name.toLowerCase()
        if (low.startsWith('.') || SKIP_DIRS.has(low)) continue
        if (depth < 8) await walk(full, depth + 1, out, exts)
      } else if (exts.has(extOf(e.name)) && (e.size ?? 0) > 1024) {
        out.push({ path: full, size: e.size, mtime: Math.round(e.mtime ?? Date.now()) })
      }
    }
  }
  async function exists(p) { try { await FS.stat({ path: furi(p) }); return true } catch { return false } }

  // ---------- an in-app file and folder browser (the phone has no path-based picker) ----------
  function browse({ title, dirs, exts, multi }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div')
      wrap.className = 'm-picker'
      wrap.innerHTML = `<div class="m-pk-box"><div class="m-pk-head"><b></b><button class="m-pk-x" aria-label="Close">✕</button></div>
        <div class="m-pk-path"></div><div class="m-pk-list"></div>
        <div class="m-pk-foot"><span class="m-pk-count"></span><button class="btn m-pk-cancel">Cancel</button><button class="btn primary m-pk-ok"></button></div></div>`
      wrap.querySelector('b').textContent = title || (dirs ? 'Choose a folder' : 'Choose files')
      const list = wrap.querySelector('.m-pk-list'), pathEl = wrap.querySelector('.m-pk-path'), ok = wrap.querySelector('.m-pk-ok'), count = wrap.querySelector('.m-pk-count')
      const picked = new Set()
      let cwd = ROOT
      const done = v => { wrap.remove(); backHandlers.delete(back); resolve(v) }
      const back = () => { if (cwd !== ROOT) open(cwd.slice(0, cwd.lastIndexOf('/'))); else done([]) ; return true }
      backHandlers.add(back)
      const refresh = () => {
        ok.textContent = dirs ? 'Use this folder' : `Add ${picked.size || ''}`.trim()
        ok.disabled = !dirs && !picked.size
        count.textContent = dirs ? '' : picked.size ? `${picked.size} selected` : ''
      }
      async function open(dir) {
        cwd = dir
        pathEl.textContent = dir.replace(ROOT, 'Phone storage')
        list.innerHTML = '<div class="m-pk-empty">Loading…</div>'
        const entries = (await readdir(dir)).filter(e => !e.name.startsWith('.'))
          .filter(e => e.type === 'directory' || (!dirs && exts.has(extOf(e.name))))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'directory' ? -1 : 1))
        list.innerHTML = ''
        if (dir !== ROOT) entries.unshift({ name: '..', type: 'up' })
        if (!entries.length) list.innerHTML = `<div class="m-pk-empty">${dirs ? 'No folders here' : 'No books here'}</div>`
        for (const e of entries) {
          const full = `${dir}/${e.name}`
          const row = document.createElement('button')
          row.className = 'm-pk-row' + (picked.has(full) ? ' on' : '')
          row.innerHTML = `<span class="m-pk-ic">${e.type === 'file' ? '📄' : e.type === 'up' ? '↩' : '📁'}</span><span class="m-pk-name"></span>`
          row.querySelector('.m-pk-name').textContent = e.type === 'up' ? 'Up one level' : e.name
          row.onclick = () => {
            if (e.type === 'up') return open(dir.slice(0, dir.lastIndexOf('/')))
            if (e.type === 'directory') return open(full)
            if (!multi) picked.clear(), list.querySelectorAll('.on').forEach(x => x.classList.remove('on'))
            picked.has(full) ? picked.delete(full) : picked.add(full)
            row.classList.toggle('on', picked.has(full)); refresh()
          }
          list.appendChild(row)
        }
        refresh()
      }
      wrap.querySelector('.m-pk-x').onclick = wrap.querySelector('.m-pk-cancel').onclick = () => done([])
      ok.onclick = () => done(dirs ? [cwd] : [...picked])
      document.body.appendChild(wrap)
      open(ROOT)
    })
  }

  // ---------- comic archives (.cbr / .cb7 / .cbt) with 7-Zip compiled to WebAssembly ----------
  const arcCache = new Map()
  const natural = new Intl.Collator([], { numeric: true, sensitivity: 'base' }).compare
  const isImg = n => IMG_EXT.includes(extOf(n)) && !n.split('/').pop().startsWith('.') && !n.includes('__MACOSX')
  async function extractArchive(file, id, firstOnly) {
    const key = id + (firstOnly ? '-cover' : '')
    if (arcCache.has(key)) return arcCache.get(key)
    const { default: SevenZip } = await import(location.origin + '/vendor/7z/7zz.es6.js')
    const sz = await SevenZip({ print: () => {}, printErr: () => {}, locateFile: f => location.origin + '/vendor/7z/' + f })
    const bytes = new Uint8Array(await (await nativeFetch(window.__fileSrc(file))).arrayBuffer())
    sz.FS.mkdir('/in'); sz.FS.mkdir('/out')
    const inName = '/in/book.' + (extOf(file) || 'bin')
    sz.FS.writeFile(inName, bytes)
    sz.callMain(['x', inName, '-o/out', '-y'])
    const names = []
    const rec = d => { for (const n of sz.FS.readdir(d)) { if (n === '.' || n === '..') continue; const p = d + '/' + n; sz.FS.isDir(sz.FS.stat(p).mode) ? rec(p) : names.push(p) } }
    rec('/out')
    let imgs = names.filter(isImg).sort(natural)
    if (firstOnly) imgs = imgs.slice(0, 1)
    const urls = imgs.map(p => URL.createObjectURL(new Blob([sz.FS.readFile(p)])))
    // keep a few comics' pages in memory, drop the oldest
    arcCache.set(key, urls)
    while (arcCache.size > 4) { const [k, v] = arcCache.entries().next().value; v.forEach(u => URL.revokeObjectURL(u)); arcCache.delete(k) }
    return urls
  }

  // ---------- offline English dictionary ----------
  let dictEn = null
  async function loadDict() {
    if (dictEn) return dictEn
    const buf = new Uint8Array(await (await nativeFetch(location.origin + '/dict/en.json.gz')).arrayBuffer())
    let text
    if (buf[0] === 0x1f && buf[1] === 0x8b) text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    else text = new TextDecoder().decode(buf)
    return (dictEn = JSON.parse(text))
  }
  const IRREGULAR = { went: 'go', gone: 'go', was: 'be', were: 'be', been: 'be', is: 'be', are: 'be', am: 'be', had: 'have', has: 'have', did: 'do', does: 'do', done: 'do',
    saw: 'see', seen: 'see', took: 'take', taken: 'take', made: 'make', said: 'say', got: 'get', gotten: 'get', knew: 'know', known: 'know', thought: 'think',
    came: 'come', gave: 'give', given: 'give', found: 'find', told: 'tell', felt: 'feel', left: 'leave', brought: 'bring', began: 'begin', begun: 'begin',
    kept: 'keep', held: 'hold', stood: 'stand', heard: 'hear', ran: 'run', wrote: 'write', written: 'write', sat: 'sit', spoke: 'speak', spoken: 'speak',
    rose: 'rise', risen: 'rise', drove: 'drive', driven: 'drive', bought: 'buy', caught: 'catch', taught: 'teach', fought: 'fight', sought: 'seek',
    fell: 'fall', fallen: 'fall', ate: 'eat', eaten: 'eat', drew: 'draw', drawn: 'draw', flew: 'fly', flown: 'fly', grew: 'grow', grown: 'grow',
    threw: 'throw', thrown: 'throw', wore: 'wear', worn: 'wear', chose: 'choose', chosen: 'choose', broke: 'break', broken: 'break', forgot: 'forget',
    lay: 'lie', lain: 'lie', slept: 'sleep', swept: 'sweep', wept: 'weep', meant: 'mean', lost: 'lose', sent: 'send', spent: 'spend', built: 'build',
    men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose', people: 'person', lives: 'life',
    wives: 'wife', knives: 'knife', leaves: 'leaf', wolves: 'wolf', better: 'good', best: 'good', worse: 'bad', worst: 'bad', data: 'datum', criteria: 'criterion' }
  function lemmas(w) {
    const out = [w]
    if (IRREGULAR[w]) out.push(IRREGULAR[w])
    const rules = [['ies', 'y'], ['es', ''], ['s', ''], ['ves', 'f'], ['ied', 'y'], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e'], ['er', ''], ['er', 'e'], ['est', ''], ['est', 'e'], ['ier', 'y'], ['iest', 'y'], ['ly', ''], ['ily', 'y'], ["'s", ''], ['’s', '']]
    for (const [suf, rep] of rules) if (w.endsWith(suf) && w.length > suf.length + 1) out.push(w.slice(0, -suf.length) + rep)
    const m = w.match(/^(.*?)([bcdfgklmnprstvz])\2(ed|ing|er|est)$/)
    if (m) out.push(m[1] + m[2])
    return [...new Set(out)]
  }
  async function lookupWord(raw) {
    const d = await loadDict()
    const w = String(raw).toLowerCase().trim().replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/\s+/g, ' ')
    if (!w) return null
    for (const cand of lemmas(w)) {
      const senses = d[cand] ?? d[cand.replace(/-/g, ' ')]
      if (senses) return { word: cand, query: w, senses }
    }
    return null
  }

  // ---------- network (native, so book sites' CORS rules don't apply) ----------
  async function netFetch(url, opts = {}) {
    if (!/^https:\/\//.test(url)) throw new Error('https only')
    const t = opts.timeout ?? 15000
    try {
      const res = await Http.request({
        url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, data: opts.body,
        responseType: opts.binary ? 'arraybuffer' : 'text', connectTimeout: t, readTimeout: t,
      })
      const ok = res.status >= 200 && res.status < 300
      const type = res.headers?.['Content-Type'] ?? res.headers?.['content-type'] ?? ''
      if (opts.binary) return { ok, status: res.status, data: typeof res.data === 'string' ? b64ToBytes(res.data) : toBytes(res.data), type }
      return { ok, status: res.status, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) }
    } catch (err) {
      return { ok: false, status: 0, text: '', error: String(err?.message ?? err) }
    }
  }
  const safeName = f => String(f).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)
  const EXPORT_DIR = () => `${ROOT}/Download/Iqra`

  // ---------- full screen ----------
  let isFull = false
  async function setFull(on) {
    isFull = on ?? !isFull
    try { isFull ? await SB.hide() : await SB.show() } catch { /* ignore */ }
    document.documentElement.classList.toggle('m-full', isFull)
    emit('fullscreen', isFull)
    return isFull
  }

  // ---------- first run: ask for access to the phone's files ----------
  function askForFiles() {
    return new Promise(resolve => {
      const wrap = document.createElement('div')
      wrap.className = 'm-picker m-perm'
      wrap.innerHTML = `<div class="m-pk-box"><div class="m-pk-head"><b>Let Iqra find your books</b></div>
        <p>Iqra looks for books and comics in your phone's <b>Download</b>, <b>Documents</b> and <b>Books</b> folders, like it does on your laptop.</p>
        <p>Android calls this <b>“All files access”</b>. Tap the button, switch Iqra on, then come back.</p>
        <div class="m-pk-foot"><button class="btn m-pk-cancel">Not now</button><button class="btn primary m-pk-ok">Allow access</button></div></div>`
      wrap.querySelector('.m-pk-ok').onclick = async () => { await Native.requestAllFiles() }
      wrap.querySelector('.m-pk-cancel').onclick = () => { wrap.remove(); resolve(false) }
      document.body.appendChild(wrap)
    })
  }

  // ---------- back button ----------
  const backHandlers = new Set()
  if (App) App.addListener('backButton', () => {
    if (document.querySelector('.pks-wrap')) return document.dispatchEvent(new Event('pks-back'))
    const last = [...backHandlers].pop()
    if (last && last()) return
    const esc = () => {
      const ev = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }
      document.dispatchEvent(new KeyboardEvent('keydown', ev)) // bubbles on to window
    }
    // an open dialog or menu closes first
    if (document.querySelector('.modal-back, .menu')) return esc()
    if (isFull) return setFull(false)
    if (location.hash && !/^#\/?(home)?$/.test(location.hash)) return history.back()
    App.minimizeApp()
  })

  // ---------- channels ----------
  const H = {
    'db:get': name => db[name],
    'db:patch': (name, ops) => { if (!STORES.includes(name)) return; for (const [p, v, op] of ops) applyPatch(db[name], p, v, op); scheduleSave(name); PKS.markDirty() },
    'db:replace': (name, value) => { if (!STORES.includes(name)) return; db[name] = value; scheduleSave(name); PKS.markDirty() },
    'db:flush': () => flushStores(),
    'app:info': async () => {
      if (!allFiles && !sessionStorage.getItem('iqra:askedFiles')) { sessionStorage.setItem('iqra:askedFiles', '1'); askForFiles() }
      const cands = ['Download', 'Documents', 'Books', 'Comics'].map(n => `${ROOT}/${n}`)
      const folders = []
      for (const c of cands) if (await exists(c)) folders.push(c)
      let version = '1.2.1'
      try { version = (await App.getInfo()).version } catch { /* ignore */ }
      return { version, platform: 'android', userData: DATA, folders, home: ROOT, openFiles: [], bookExt: BOOK_EXT, docExt: DOC_EXT, test: '', isMain: true }
    },
    'scan': async folders => { if (!allFiles) return []; const out = []; for (const f of folders) await walk(f, 0, out, new Set(BOOK_EXT)); return out },
    'stat': async p => { try { const st = await FS.stat({ path: furi(p) }); return { size: st.size, mtime: Math.round(st.mtime), isDir: st.type === 'directory' } } catch { return null } },
    'exists:many': paths => Promise.all(paths.map(exists)),
    'walk:any': async dir => { const out = []; await walk(dir, 0, out, ALL_EXT); return out },
    'cover:save': async (id, data) => { await FS.writeFile({ path: `covers/${id}.jpg`, directory: 'DATA', data: bytesToB64(toBytes(data)) }); return true },
    'cover:delete': async id => { try { await FS.deleteFile({ path: `covers/${id}.jpg`, directory: 'DATA' }) } catch { /* gone */ } },
    'dialog:open': async (opts = {}) => {
      if (!allFiles) { await askForFiles(); return [] }
      const props = opts.properties ?? []
      const exts = new Set((opts.filters ?? []).flatMap(f => f.extensions ?? []).map(e => e.toLowerCase()))
      return browse({ title: opts.title, dirs: props.includes('openDirectory'), exts: exts.size ? exts : ALL_EXT, multi: props.includes('multiSelections') })
    },
    'dialog:save': async (opts = {}, content, encoding) => {
      const name = safeName((opts.defaultPath ?? 'iqra-export.txt').split(/[\\/]/).pop())
      const dest = `${EXPORT_DIR()}/${name}`
      const data = encoding === 'base64' ? content : String(content)
      try {
        await FS.writeFile({ path: furi(dest), data, encoding: encoding === 'base64' ? undefined : 'utf8', recursive: true })
      } catch {
        // no file access: hand it to the share sheet instead
        const r = await FS.writeFile({ path: name, directory: 'CACHE', data, encoding: encoding === 'base64' ? undefined : 'utf8' })
        await Share.share({ title: name, files: [r.uri] }).catch(() => {})
        return name
      }
      return dest.replace(ROOT, 'Phone storage')
    },
    'file:readText': async p => { if (!/\.(json|css|txt)$/i.test(p)) throw new Error('Not allowed'); return (await FS.readFile({ path: furi(p), encoding: 'utf8' })).data },
    'shell:show': async p => {
      try { await Share.share({ title: p.split('/').pop(), files: [furi(p)] }) } catch { alert(p.replace(ROOT, 'Phone storage')) }
    },
    'shell:open': url => { if (/^https?:\/\//.test(url)) Browser.open({ url }) },
    'net:fetch': netFetch,
    'download': async (url, folder, filename) => {
      if (!/^https:\/\//.test(url)) throw new Error('https only')
      const dest = `${folder}/${safeName(filename)}`
      await FS.downloadFile({ url, path: furi(dest), recursive: true })
      const st = await FS.stat({ path: furi(dest) })
      return { path: dest, size: st.size, mtime: Math.round(st.mtime) }
    },
    'archive:extract': extractArchive,
    'doc:text': async () => { throw new Error('Old Word .doc files only open in Iqra on the laptop. Save it as .docx to read it here.') },
    'dict:lookup': async w => { try { return await lookupWord(w) } catch (e) { console.error('dictionary', e); return null } },
    'cache:clear': async () => { for (const v of arcCache.values()) v.forEach(u => URL.revokeObjectURL(u)); arcCache.clear(); try { await FS.rmdir({ path: 'cache', directory: 'DATA', recursive: true }) } catch { /* none */ } },
    'win:new': hash => { if (hash) location.hash = hash.replace(/^#/, '') },
    'win:fullscreen': on => setFull(on),
    'win:onTop': () => {},
    'win:overlay': (color, symbolColor) => {
      if (!SB || !color) return
      SB.setBackgroundColor({ color }).catch(() => {})
      SB.setStyle({ style: symbolColor && parseInt(String(symbolColor).slice(1, 3), 16) > 128 ? 'DARK' : 'LIGHT' }).catch(() => {})
    },
    'win:title': () => {},
    'win:close': () => history.back(),
    'test:done': () => {},
    'test:shot': () => {},
  }

  // ---------- sync with the laptop (same Wi-Fi) ----------
  // Book ids are made from each device's file path, so on the wire every book is named by a
  // device-free key instead (file name + size, like Iqra's own duplicate check).
  function hashStr(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57
    for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677) }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
  }
  const baseOf = p => String(p).split(/[\\/]/).pop()
  const dupKey = (p, size) => baseOf(p).toLowerCase().replace(/\s*\(\d+\)(?=\.[a-z0-9]+$)/, '').replace(/\s+/g, ' ') + '|' + size
  const keyOfRec = r => r.syncKey || ('bk' + hashStr(dupKey(r.path, r.size)))
  const idOfPath = p => hashStr(p.toLowerCase())
  const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const LOCAL_REC = ['path', 'mtime', 'missing']
  const LOCAL_PATHS = [['settings', 'app', 'folders'], ['settings', 'app', 'downloadFolder'], ['settings', 'app', 'sidebarCollapsed'], ['library', 'lastScan'], ['settings', 'firstRunDone']]
  const getAt = (o, p) => p.reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o)
  function setAt(o, p, v) {
    let x = o
    for (let i = 0; i < p.length - 1; i++) { if (!x[p[i]] || typeof x[p[i]] !== 'object') { if (v === undefined) return; x[p[i]] = {} } x = x[p[i]] }
    if (v === undefined) delete x[p[p.length - 1]]; else x[p[p.length - 1]] = v
  }
  function mapStr(s, map) {
    if (map[s]) return map[s]
    const i = s.indexOf(':')
    return i > 0 && map[s.slice(0, i)] ? map[s.slice(0, i)] + s.slice(i) : s
  }
  function mergeDup(a, b) {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const o = { ...a }
      for (const [k, v] of Object.entries(b)) o[k] = k in o ? mergeDup(o[k], v) : v
      return o
    }
    return b ?? a
  }
  function translate(v, map) {
    if (Array.isArray(v)) return v.map(x => translate(x, map))
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) { const nk = mapStr(k, map), nx = translate(x, map); o[nk] = nk in o ? mergeDup(o[nk], nx) : nx }
      return o
    }
    return typeof v === 'string' ? mapStr(v, map) : v
  }
  const booksOf = stores => (stores && stores.library && stores.library.books) || {}
  // where each book key lives on one side: { key: { id, path, mtime, missing } }
  function located(stores, side, ctx) {
    const loc = {}
    for (const [id, r] of Object.entries(booksOf(stores))) if (r && r.path) loc[keyOfRec(r)] = { id, path: r.path, mtime: r.mtime, missing: r.missing }
    const extra = (ctx.extra[side + 'Paths']) || {}
    for (const [key, p] of Object.entries(extra)) if (!loc[key]) loc[key] = { id: idOfPath(p.path), path: p.path, mtime: p.mtime }
    return loc
  }
  const adapter = {
    laptopDoc: st => st && st.stores,
    getLocal: () => copy(db),
    isFresh: () => false, // libraries are combined book by book, so there is nothing to throw away
    toWire(stores, side, ctx) {
      const map = {}
      for (const [id, r] of Object.entries(booksOf(stores))) if (r && r.path) map[id] = keyOfRec(r)
      const w = translate(copy(stores), map)
      const books = (w.library ||= {}).books ||= {}
      for (const [key, r] of Object.entries(books)) { LOCAL_REC.forEach(k => delete r[k]); r.syncKey = key }
      // books still being copied to this side count as here, so they are not seen as deleted
      for (const [key, p] of Object.entries(ctx.extra.pending || {})) if (p.to === side && !books[key]) books[key] = copy(p.rec)
      LOCAL_PATHS.forEach(p => setAt(w, p, undefined))
      return w
    },
    fromWire(M, side, cur, ctx) {
      const loc = located(cur, side, ctx)
      const k2id = {}
      for (const [k, l] of Object.entries(loc)) k2id[k] = l.id
      const out = translate(copy(M), k2id)
      const books = {}
      for (const [key, rec] of Object.entries(booksOf(M))) {
        const l = loc[key]
        if (!l) continue // not on this device yet
        const r = translate(copy(rec), k2id)
        r.id = l.id; r.path = l.path; r.mtime = l.mtime || Date.now(); r.syncKey = key
        if (l.missing) r.missing = true
        books[l.id] = r
      }
      for (const [id, r] of Object.entries(booksOf(cur))) if (r && !r.path && !books[id]) books[id] = r
      ;(out.library ||= {}).books = books
      LOCAL_PATHS.forEach(p => setAt(out, p, getAt(cur, p)))
      return out
    },
    afterMerge(M, ctx, phone, laptop) {
      const onP = located(phone, 'phone', ctx), onL = located(laptop || {}, 'laptop', ctx)
      const pending = {}
      for (const [key, rec] of Object.entries(booksOf(M))) {
        if (!rec || rec.removed) continue
        if (onP[key] && onL[key]) continue
        if (onL[key] && onL[key].missing) continue // the laptop has lost the file itself
        if (onL[key]) pending[key] = { to: 'phone', rec, src: onL[key].path, srcId: onL[key].id, size: rec.size || 0 }
        else if (onP[key]) pending[key] = { to: 'laptop', rec, src: onP[key].path, srcId: onP[key].id, size: rec.size || 0 }
      }
      ctx.extra.pending = pending
    },
    applyLocal(stores) {
      for (const name of STORES) {
        if (!stores[name] || PKS.same(stores[name], db[name])) continue
        db[name] = stores[name]
        scheduleSave(name)
        emit('db:replaced', name, db[name])
      }
    },
    async transfers(ctx) {
      const pending = Object.entries(ctx.extra.pending || {}).filter(([, p]) => !p.done)
      if (!pending.length) return false
      const down = pending.filter(([, p]) => p.to === 'phone'), up = pending.filter(([, p]) => p.to === 'laptop')
      const mb = n => (n / 1048576).toFixed(n > 1073741824 ? 0 : 1)
      if (down.length && ctx.extra.copyDown === undefined) {
        const total = down.reduce((s, [, p]) => s + p.size, 0)
        ctx.extra.copyDown = total < 300 * 1048576 || confirm(`Copy ${down.length} books (${mb(total)} MB) from your laptop to this phone?\n\nYou can change this later in Sync.`)
        await ctx.save()
      }
      if (!allFiles) { ctx.setStatus('Books not copied', 'warn', 'Give Iqra "All files access" first.'); return false }
      let changed = false, n = 0
      const all = [...up, ...(ctx.extra.copyDown ? down : [])]
      const headers = { 'X-PK-Token': ctx.cfg.token }
      const base = `http://${ctx.cfg.host}:${ctx.port}`
      for (const [key, p] of all) {
        n++
        const name = baseOf(p.src)
        ctx.setStatus(`Copying books ${n} of ${all.length}`, 'busy', name)
        try {
          if (p.to === 'phone') {
            let dest = `${ROOT}/Download/Iqra Books/${safeName(name)}`
            const st = await FS.stat({ path: furi(dest) }).catch(() => null)
            if (!st || st.size !== p.size) {
              if (st) dest = dest.replace(/(\.[^.]+)$/, ` (${Date.now() % 1000})$1`)
              await FS.downloadFile({ url: `${base}/iqra/file?p=${encodeURIComponent(p.src)}`, path: furi(dest), recursive: true, headers, connectTimeout: 15000, readTimeout: 120000 })
            }
            const got = await FS.stat({ path: furi(dest) })
            ;(ctx.extra.phonePaths ||= {})[key] = { path: dest, mtime: Math.round(got.mtime) }
            // the cover comes along
            if (p.rec.cover) {
              const c = await ctx.req('GET', `/iqra/cover?id=${p.srcId}`, undefined, 30000).catch(() => null)
              if (c && c.status === 200 && c.data && c.data.data) await FS.writeFile({ path: `covers/${idOfPath(dest)}.jpg`, directory: 'DATA', data: c.data.data })
            }
            // show it in the library straight away
            const cur = copy(db)
            adapter.applyLocal(adapter.fromWire(adapter.toWire(cur, 'phone', ctx), 'phone', cur, ctx))
          } else {
            const total = p.size || (await FS.stat({ path: furi(p.src) })).size
            let off = 0, res = null
            const CH = 3 * 1048576
            do {
              const r = await Native.readRange({ path: p.src, offset: off, length: CH })
              res = await ctx.req('POST', `/iqra/upload?name=${encodeURIComponent(name)}&offset=${off}&total=${total}`, { data: r.data }, 120000)
              if (res.status !== 200) throw new Error((res.data && res.data.error) || `laptop said ${res.status}`)
              off += Math.floor(r.data.length * 3 / 4) - (r.data.endsWith('==') ? 2 : r.data.endsWith('=') ? 1 : 0)
            } while (!res.data.done && off < total)
            ;(ctx.extra.laptopPaths ||= {})[key] = { path: res.data.path, mtime: res.data.mtime }
            if (p.rec.cover) {
              const c = await FS.readFile({ path: `covers/${p.srcId}.jpg`, directory: 'DATA' }).catch(() => null)
              if (c && c.data) await ctx.req('PUT', `/iqra/cover?id=${idOfPath(res.data.path)}`, { data: c.data }, 30000).catch(() => null)
            }
          }
          // keep it listed (as done) until the next sync has put the record on both sides
          ctx.extra.pending[key].done = true
          await ctx.save()
          changed = true
        } catch (e) {
          console.warn('copy failed', name, e)
          ctx.setStatus('Could not copy a book', 'warn', `${name}: ${(e && e.message) || e}`)
        }
      }
      return changed
    },
  }
  const PKS = window.PKSync({
    app: 'iqra', label: 'Iqra', port: 47822, adapter,
    extraSettings: () => {
      const row = document.createElement('label')
      row.className = 'pks-row'
      row.innerHTML = '<span>Copy books from the laptop to this phone</span><input type="checkbox">'
      const box = row.querySelector('input')
      FS.readFile({ path: 'pksync-iqra-base.json', directory: 'DATA', encoding: 'utf8' })
        .then(r => { box.checked = JSON.parse(r.data).extra?.copyDown !== false }).catch(() => { box.checked = true })
      box.onchange = async () => {
        try {
          const s = JSON.parse((await FS.readFile({ path: 'pksync-iqra-base.json', directory: 'DATA', encoding: 'utf8' })).data)
          ;(s.extra ||= {}).copyDown = box.checked
          await FS.writeFile({ path: 'pksync-iqra-base.json', directory: 'DATA', encoding: 'utf8', data: JSON.stringify(s) })
          if (box.checked) PKS.syncNow(true)
        } catch { /* not synced yet */ }
      }
      return row
    },
  })
  function mountSyncButton() {
    const bar = document.querySelector('#topbar')
    if (!bar || bar.querySelector('.pks-fab')) return
    const b = document.createElement('button')
    b.className = 'pks-fab'
    b.setAttribute('aria-label', 'Sync with laptop')
    b.innerHTML = window.PKSync.icon
    b.onclick = () => PKS.openSheet()
    const tools = bar.querySelector('.tools')
    tools ? tools.prepend(b) : bar.appendChild(b)
    PKS.onStatus(s => { b.dataset.kind = PKS.paired ? s.kind : 'off' })
  }
  new MutationObserver(() => mountSyncButton()).observe(document.documentElement, { childList: true, subtree: true })

  window.api = {
    invoke: async (channel, ...args) => {
      const fn = H[channel]
      if (!fn) throw new Error(`Unknown channel ${channel}`)
      await ready
      return fn(...args)
    },
    on: (channel, fn) => { (listeners[channel] ||= []).push(fn) },
    pathForFile: () => '',
  }
})()
