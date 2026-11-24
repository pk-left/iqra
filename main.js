// Iqra - main process
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, session, net, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const { Readable } = require('stream')
const crypto = require('crypto')

const APP_DIR = path.join(__dirname, 'app')
const HOST = 'iqra'
if (process.env.IQRA_DATA) app.setPath('userData', process.env.IQRA_DATA)
const DATA = () => app.getPath('userData')

// Iqra was called Inkwell until 1.1. On the first run after the rename, carry the library,
// reading positions, highlights, stats, settings and saved covers across so nothing resets.
// The cache folder is left behind: it rebuilds itself.
function migrateFromInkwell() {
    try {
        if (process.env.IQRA_DATA || fs.existsSync(path.join(DATA(), 'library.json'))) return
        const old = path.join(app.getPath('appData'), 'Inkwell')
        if (!fs.existsSync(path.join(old, 'library.json'))) return
        fs.mkdirSync(DATA(), { recursive: true })
        for (const f of fs.readdirSync(old)) {
            if (f.endsWith('.json')) fs.copyFileSync(path.join(old, f), path.join(DATA(), f))
        }
        if (fs.existsSync(path.join(old, 'covers'))) fs.cpSync(path.join(old, 'covers'), path.join(DATA(), 'covers'), { recursive: true, force: false })
    } catch (e) { console.error('Could not bring data across from Inkwell', e) }
}
migrateFromInkwell()

const BOOK_EXT = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'kf8', 'prc', 'fb2', 'fbz', 'cbz', 'cbr', 'cb7', 'cbt', 'djvu', 'djv']
const DOC_EXT = ['txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'docx', 'doc', 'odt', 'rtf']
const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'jxl']
const ALL_EXT = new Set([...BOOK_EXT, ...DOC_EXT])
const extOf = p => {
    const n = p.toLowerCase()
    if (n.endsWith('.fb2.zip')) return 'fbz'
    return path.extname(n).slice(1)
}

protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
}])

// ---------- data stores (main owns the data; windows send patches) ----------
const STORES = ['library', 'settings', 'annotations', 'stats', 'study']
const db = {}
const saveTimers = {}
const storePath = name => path.join(DATA(), `${name}.json`)

function loadStores() {
    fs.mkdirSync(path.join(DATA(), 'covers'), { recursive: true })
    for (const name of STORES) {
        db[name] = {}
        for (const p of [storePath(name), storePath(name) + '.bak']) {
            try {
                db[name] = JSON.parse(fs.readFileSync(p, 'utf8'))
                break
            } catch { /* try backup */ }
        }
    }
}
function saveStore(name) {
    const p = storePath(name)
    const tmp = p + '.tmp'
    try {
        fs.writeFileSync(tmp, JSON.stringify(db[name]))
        if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak')
        fs.renameSync(tmp, p)
    } catch (e) { console.error('save failed', name, e) }
}
function scheduleSave(name) {
    if (saveTimers[name]) return // already queued: saves happen at most every 1.5 s, even during a long import
    saveTimers[name] = setTimeout(() => { delete saveTimers[name]; saveStore(name) }, 1500)
}
function flushStores() {
    for (const name of Object.keys(saveTimers)) {
        clearTimeout(saveTimers[name]); delete saveTimers[name]; saveStore(name)
    }
}
function applyPatch(root, p, value, op) {
    let o = root
    for (let i = 0; i < p.length - 1; i++) {
        const k = p[i]
        if (o[k] == null || typeof o[k] !== 'object') o[k] = {}
        o = o[k]
    }
    const k = p[p.length - 1]
    if (op === 'inc') o[k] = (Number(o[k]) || 0) + value
    else if (value === null || value === undefined) delete o[k]
    else o[k] = value
}
function broadcast(sender, channel, ...args) {
    for (const w of BrowserWindow.getAllWindows())
        if (w.webContents !== sender && !w.isDestroyed()) w.webContents.send(channel, ...args)
}

// ---------- protocol ----------
const MIME = {
    html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
    ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', pdf: 'application/pdf', epub: 'application/epub+zip',
    bcmap: 'application/octet-stream', pfb: 'application/octet-stream',
}
const CSP = [
    "default-src 'self' blob: data:",
    `script-src 'self' 'wasm-unsafe-eval'${process.env.IQRA_TEST ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' blob: data:",
    "img-src 'self' app: blob: data: https:",
    "font-src 'self' app: blob: data:",
    "media-src 'self' blob: data:",
    "connect-src 'self' app: blob: data:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
].join('; ')

async function serveFile(file, request, extraHeaders = {}) {
    let st
    try { st = await fsp.stat(file) } catch { return new Response('Not found', { status: 404 }) }
    if (!st.isFile()) return new Response('Not found', { status: 404 })
    const type = MIME[extOf(file)] ?? 'application/octet-stream'
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...extraHeaders }
    const range = request.headers.get('range')
    if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? parseInt(m[1]) : 0
        let end = m && m[2] ? parseInt(m[2]) : st.size - 1
        if (m && !m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2])); end = st.size - 1 }
        end = Math.min(end, st.size - 1)
        if (start > end || start >= st.size)
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } })
        const len = end - start + 1
        // small ranges: read into memory (much faster than spinning up a stream)
        if (len <= 4 * 1024 * 1024) {
            const fh = await fsp.open(file, 'r')
            try {
                const buf = Buffer.allocUnsafe(len)
                await fh.read(buf, 0, len, start)
                return new Response(buf, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(len) } })
            } finally { await fh.close() }
        }
        const stream = fs.createReadStream(file, { start, end })
        return new Response(Readable.toWeb(stream), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(len) } })
    }
    if (st.size <= 8 * 1024 * 1024)
        return new Response(await fsp.readFile(file), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } })
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } })
}

function isInside(child, parent) {
    const rel = path.relative(parent, child)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function registerProtocol() {
    protocol.handle('app', async request => {
        try {
            const url = new URL(request.url)
            if (url.host !== HOST) return new Response('Bad host', { status: 400 })
            const pathname = decodeURIComponent(url.pathname)
            if (pathname === '/_file') {
                const p = url.searchParams.get('p')
                if (!p || !path.isAbsolute(p)) return new Response('Bad path', { status: 400 })
                const ext = extOf(p)
                const ok = ALL_EXT.has(ext) || (IMG_EXT.includes(ext) && isInside(p, path.join(DATA(), 'cache')))
                if (!ok) return new Response('Forbidden', { status: 403 })
                return serveFile(p, request)
            }
            if (pathname.startsWith('/_cover/')) {
                const name = path.basename(pathname)
                return serveFile(path.join(DATA(), 'covers', name), request, { 'Cache-Control': 'max-age=31536000' })
            }
            const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
            const file = path.join(APP_DIR, rel)
            if (!isInside(file, APP_DIR)) return new Response('Forbidden', { status: 403 })
            return serveFile(file, request, rel.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {})
        } catch (e) {
            console.error(e)
            return new Response(String(e), { status: 500 })
        }
    })
}

// ---------- scanning ----------
const SKIP_DIRS = new Set(['node_modules', 'appdata', 'windows', 'program files', 'program files (x86)',
    'programdata', '$recycle.bin', 'system volume information', '__pycache__', 'site-packages', 'venv', '.git',
    'autodesk', 'inventor', 'matlab', 'adobe', 'steamapps'])
async function walk(dir, depth, out, isRoot) {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    // folders that hold installed software are not book folders
    if (!isRoot && entries.some(e => e.isFile() && /\.(dll|cab|msi|sys)$/i.test(e.name))) return
    for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
            const low = e.name.toLowerCase()
            if (low.startsWith('.') || low.startsWith('$') || SKIP_DIRS.has(low)) continue
            if (/^microsoft office|^adobe |^autocad|_files$/.test(low)) continue
            if (depth < 8) await walk(full, depth + 1, out, false)
        } else if (e.isFile()) {
            const ext = extOf(e.name)
            if (!BOOK_EXT.includes(ext)) continue
            try {
                const st = await fsp.stat(full)
                if (st.size > 1024) out.push({ path: full, size: st.size, mtime: Math.round(st.mtimeMs) })
            } catch { /* unreadable */ }
        }
    }
}

// ---------- archives (cbr / cb7 / cbt) ----------
const isImg = n => IMG_EXT.includes(extOf(n)) && !path.basename(n).startsWith('.') && !n.includes('__MACOSX')
const natural = new Intl.Collator([], { numeric: true, sensitivity: 'base' }).compare
async function listFilesRec(dir, out = []) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await listFilesRec(full, out)
        else out.push(full)
    }
    return out
}
async function extractArchive(file, id, firstOnly) {
    const dest = path.join(DATA(), 'cache', 'arc', id + (firstOnly ? '-cover' : ''))
    const done = path.join(dest, '.done')
    if (!fs.existsSync(done)) {
        await fsp.rm(dest, { recursive: true, force: true })
        await fsp.mkdir(dest, { recursive: true })
        let ok = false
        const head = Buffer.alloc(8)
        const fh = await fsp.open(file, 'r'); await fh.read(head, 0, 8, 0); await fh.close()
        const isRar = head.toString('latin1', 0, 4) === 'Rar!'
        if (isRar) {
            try {
                const { createExtractorFromFile } = require('node-unrar-js')
                const ex = await createExtractorFromFile({ filepath: file, targetPath: dest })
                let names = [...ex.getFileList().fileHeaders].filter(h => !h.flags.directory).map(h => h.name).filter(isImg).sort(natural)
                if (firstOnly) names = names.slice(0, 1)
                const res = ex.extract({ files: names })
                for (const f of res.files) void f // iterating performs the extraction
                ok = true
            } catch (e) { console.error('unrar failed', e) }
        }
        if (!ok) {
            const SevenZip = require('7z-wasm')
            const sz = await SevenZip({ print: () => {}, printErr: () => {} })
            sz.FS.mkdir('/in'); sz.FS.mkdir('/out')
            sz.FS.mount(sz.NODEFS, { root: path.dirname(file) }, '/in')
            sz.FS.mount(sz.NODEFS, { root: dest }, '/out')
            sz.callMain(['x', '/in/' + path.basename(file), '-o/out', '-y'])
        }
        await fsp.writeFile(done, '')
    }
    const files = (await listFilesRec(dest)).filter(isImg).sort(natural)
    return files
}

// ---------- windows ----------
const windows = new Set()
let pendingFiles = []
function winState() {
    try { return JSON.parse(fs.readFileSync(path.join(DATA(), 'window.json'), 'utf8')) } catch { return {} }
}
function createWindow(hash = '') {
    const st = windows.size ? {} : winState()
    const win = new BrowserWindow({
        width: st.width ?? 1320, height: st.height ?? 860, x: st.x, y: st.y,
        minWidth: 640, minHeight: 440, show: false, backgroundColor: '#15171c',
        title: 'Iqra', icon: path.join(__dirname, 'build', 'icon.png'),
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#15171c', symbolColor: '#9aa0aa', height: 40 },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false,
            backgroundThrottling: false,
        },
    })
    if (st.maximized) win.maximize()
    windows.add(win)
    win.isMainLibrary = !hash && ![...windows].some(w => w !== win && w.isMainLibrary)
    let crashes = 0
    win.webContents.on('render-process-gone', () => { if (++crashes <= 3 && !win.isDestroyed()) win.webContents.reload() })
    win.once('ready-to-show', () => win.show())
    win.on('close', () => {
        if (win.isMainLibrary) {
            try {
                const b = win.getNormalBounds()
                fs.writeFileSync(path.join(DATA(), 'window.json'), JSON.stringify({ ...b, maximized: win.isMaximized() }))
            } catch { /* ignore */ }
        }
    })
    win.on('closed', () => windows.delete(win))
    win.on('enter-full-screen', () => win.webContents.send('fullscreen', true))
    win.on('leave-full-screen', () => win.webContents.send('fullscreen', false))
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url)
        return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(`app://${HOST}/`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) }
    })
    if (process.env.IQRA_TEST) win.webContents.on('console-message', (e, level, message, line, source) => console.log(`[r${level}] ${message} (${String(source).split('/').pop()}:${line})`))
    win.loadURL(`app://${HOST}/index.html${hash}`)
    if (process.env.IQRA_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' })
    return win
}
const fileArgs = argv => argv.slice(1).filter(a => !a.startsWith('-') && ALL_EXT.has(extOf(a)) && fs.existsSync(a)).map(a => path.resolve(a))

// ---------- offline English dictionary (WordNet 3.0, loaded on first lookup) ----------
let dictEn = null
function loadDict() {
    if (!dictEn) {
        const zlib = require('zlib')
        dictEn = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(APP_DIR, 'dict', 'en.json.gz'))).toString('utf8'))
    }
    return dictEn
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
    // doubled consonant: stopped -> stop, running -> run
    const m = w.match(/^(.*?)([bcdfgklmnprstvz])\2(ed|ing|er|est)$/)
    if (m) out.push(m[1] + m[2])
    return [...new Set(out)]
}
function lookupWord(raw) {
    const d = loadDict()
    const w = String(raw).toLowerCase().trim().replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/\s+/g, ' ')
    if (!w) return null
    for (const cand of lemmas(w)) {
        const senses = d[cand] ?? d[cand.replace(/-/g, ' ')]
        if (senses) return { word: cand, query: w, senses }
    }
    return null
}

// ---------- ipc ----------
function registerIpc() {
    const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => fn(e, ...a))

    handle('db:get', (e, name) => db[name])
    handle('db:patch', (e, name, ops) => {
        if (!STORES.includes(name)) return
        for (const [p, value, op] of ops) applyPatch(db[name], p, value, op)
        syncTouched()
        scheduleSave(name)
        broadcast(e.sender, 'db:patched', name, ops)
    })
    handle('db:replace', (e, name, value) => {
        if (!STORES.includes(name)) return
        db[name] = value
        syncTouched()
        scheduleSave(name)
        broadcast(e.sender, 'db:replaced', name, value)
    })
    handle('db:flush', () => flushStores())

    handle('app:info', e => {
        const win = BrowserWindow.fromWebContents(e.sender)
        const files = win?.isMainLibrary ? pendingFiles : []
        if (win?.isMainLibrary) pendingFiles = []
        return {
            version: app.getVersion(), platform: process.platform, userData: DATA(),
            folders: ['downloads', 'documents', 'desktop'].map(n => { try { return app.getPath(n) } catch { return null } }).filter(Boolean),
            home: app.getPath('home'), openFiles: files, bookExt: BOOK_EXT, docExt: DOC_EXT,
            test: process.env.IQRA_TEST || '', isMain: !!win?.isMainLibrary,
        }
    })
    handle('scan', async (e, folders) => {
        const out = []
        for (const f of folders) await walk(f, 0, out, true)
        return out
    })
    handle('stat', async (e, p) => {
        try { const st = await fsp.stat(p); return { size: st.size, mtime: Math.round(st.mtimeMs), isDir: st.isDirectory() } } catch { return null }
    })
    handle('exists:many', async (e, paths) => Promise.all(paths.map(p => fsp.access(p).then(() => true, () => false))))
    handle('walk:any', async (e, dir) => {
        // used for drag-dropped / picked folders: every supported file, documents included
        const out = []
        const rec = async (d, depth) => {
            let entries
            try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
            for (const en of entries) {
                const full = path.join(d, en.name)
                if (en.isDirectory()) { if (depth < 8 && !en.name.startsWith('.')) await rec(full, depth + 1) }
                else if (ALL_EXT.has(extOf(en.name))) {
                    try { const st = await fsp.stat(full); out.push({ path: full, size: st.size, mtime: Math.round(st.mtimeMs) }) } catch { /* skip */ }
                }
            }
        }
        await rec(dir, 0)
        return out
    })
    handle('cover:save', async (e, id, data) => {
        await fsp.writeFile(path.join(DATA(), 'covers', `${id}.jpg`), Buffer.from(data))
        return true
    })
    handle('cover:delete', async (e, id) => { await fsp.rm(path.join(DATA(), 'covers', `${id}.jpg`), { force: true }) })
    handle('dialog:open', async (e, opts) => {
        const win = BrowserWindow.fromWebContents(e.sender)
        const r = await dialog.showOpenDialog(win, opts)
        return r.canceled ? [] : r.filePaths
    })
    handle('dialog:save', async (e, opts, content, encoding) => {
        const win = BrowserWindow.fromWebContents(e.sender)
        const r = await dialog.showSaveDialog(win, opts)
        if (r.canceled || !r.filePath) return null
        await fsp.writeFile(r.filePath, encoding === 'base64' ? Buffer.from(content, 'base64') : content)
        return r.filePath
    })
    handle('file:readText', async (e, p) => {
        if (!/\.(json|css|txt)$/i.test(p)) throw new Error('Not allowed')
        return fsp.readFile(p, 'utf8')
    })
    handle('shell:show', (e, p) => shell.showItemInFolder(p))
    handle('shell:open', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url) })
    handle('net:fetch', async (e, url, opts = {}) => {
        if (!/^https:\/\//.test(url)) throw new Error('https only')
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), opts.timeout ?? 15000)
        try {
            const res = await net.fetch(url, { method: opts.method ?? 'GET', headers: opts.headers, body: opts.body, signal: ctrl.signal })
            if (opts.binary) {
                const buf = Buffer.from(await res.arrayBuffer())
                return { ok: res.ok, status: res.status, data: buf, type: res.headers.get('content-type') }
            }
            return { ok: res.ok, status: res.status, text: await res.text() }
        } catch (err) {
            return { ok: false, status: 0, text: '', error: String(err?.message ?? err) }
        } finally { clearTimeout(t) }
    })
    handle('download', async (e, url, folder, filename) => {
        if (!/^https:\/\//.test(url)) throw new Error('https only')
        await fsp.mkdir(folder, { recursive: true })
        const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)
        const dest = path.join(folder, safe)
        const res = await net.fetch(url)
        if (!res.ok) throw new Error(`Download failed (${res.status})`)
        await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()))
        const st = await fsp.stat(dest)
        return { path: dest, size: st.size, mtime: Math.round(st.mtimeMs) }
    })
    handle('archive:extract', (e, file, id, firstOnly) => extractArchive(file, id, firstOnly))
    handle('doc:text', async (e, file) => {
        const WordExtractor = require('word-extractor')
        const doc = await new WordExtractor().extract(file)
        return doc.getBody()
    })
    handle('dict:lookup', (e, word) => { try { return lookupWord(word) } catch (err) { console.error('dictionary', err); return null } })
    handle('cache:clear', async () => { await fsp.rm(path.join(DATA(), 'cache'), { recursive: true, force: true }) })
    handle('win:new', (e, hash) => { createWindow(hash) })
    handle('win:fullscreen', (e, on) => {
        const win = BrowserWindow.fromWebContents(e.sender)
        win.setFullScreen(on ?? !win.isFullScreen())
        return win.isFullScreen()
    })
    handle('win:onTop', (e, on) => { BrowserWindow.fromWebContents(e.sender).setAlwaysOnTop(!!on) })
    handle('win:overlay', (e, color, symbolColor) => {
        try { BrowserWindow.fromWebContents(e.sender).setTitleBarOverlay({ color, symbolColor, height: 40 }) } catch { /* not supported */ }
    })
    handle('win:title', (e, t) => { BrowserWindow.fromWebContents(e.sender).setTitle(t) })
    handle('win:close', e => { BrowserWindow.fromWebContents(e.sender).close() })
    handle('test:done', (e, result) => {
        if (!process.env.IQRA_TEST) return
        fs.writeFileSync(process.env.IQRA_TEST_OUT || '/tmp/iqra-test.json', JSON.stringify(result, null, 1))
        flushStores()
        app.exit(0)
    })
    handle('test:shot', async (e, file) => {
        if (!process.env.IQRA_TEST) return
        const img = await BrowserWindow.fromWebContents(e.sender).webContents.capturePage()
        fs.writeFileSync(file, img.toPNG())
    })
}

// ---------- phone sync (same Wi-Fi) ----------
const sync = { rev: Date.now(), changedAt: Date.now() }
function syncTouched() { sync.rev += 1; sync.changedAt = Date.now() }
function backupForSync() {
    const dir = path.join(DATA(), 'sync-backups', new Date().toISOString().slice(0, 10))
    if (fs.existsSync(dir)) return
    fs.mkdirSync(dir, { recursive: true })
    for (const name of STORES) { try { fs.copyFileSync(storePath(name), path.join(dir, `${name}.json`)) } catch { /* not saved yet */ } }
    const all = fs.readdirSync(path.join(DATA(), 'sync-backups')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - 7))) fs.rmSync(path.join(DATA(), 'sync-backups', old), { recursive: true, force: true })
}
const safeFileName = f => String(f).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'book'
const BOOKS_IN = () => path.join(app.getPath('documents'), 'Iqra Books')
function startPhoneSync() {
    require('./sync-server')({
        dialog, BrowserWindow, name: 'Iqra', port: 47822, dataDir: DATA(),
        getState: light => light ? { rev: sync.rev } : { rev: sync.rev, changedAt: sync.changedAt, stores: db, booksFolder: BOOKS_IN() },
        putState: (stores, rev) => {
            if (rev !== sync.rev) return { ok: false, rev: sync.rev }
            if (!stores || typeof stores !== 'object' || !stores.library) return { ok: false, error: 'bad data', rev: sync.rev }
            try { backupForSync() } catch (e) { console.error('sync backup', e) }
            for (const name of STORES) {
                if (!stores[name]) continue
                db[name] = stores[name]
                saveStore(name)
                for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('db:replaced', name, db[name])
            }
            syncTouched()
            return { ok: true, rev: sync.rev }
        },
        routes: {
            // a book file the library knows about
            '/iqra/file': async (req, res, url, { send }) => {
                const p = url.searchParams.get('p')
                const known = Object.values(db.library?.books ?? {}).some(b => b.path === p)
                if (!p || !known) return send(res, 404, { error: 'unknown book' })
                let st
                try { st = await fsp.stat(p) } catch { return send(res, 404, { error: 'missing' }) }
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size })
                fs.createReadStream(p).pipe(res)
            },
            '/iqra/cover': async (req, res, url, { send, json }) => {
                const id = String(url.searchParams.get('id') ?? '').replace(/[^a-z0-9]/gi, '')
                if (!id) return send(res, 400, { error: 'id' })
                const file = path.join(DATA(), 'covers', `${id}.jpg`)
                if (req.method === 'PUT') {
                    const { data } = await json(req, 20 * 1024 * 1024)
                    await fsp.writeFile(file, Buffer.from(data, 'base64'))
                    return send(res, 200, { ok: true })
                }
                let buf
                try { buf = await fsp.readFile(file) } catch { return send(res, 404, { error: 'no cover' }) }
                return send(res, 200, { data: buf.toString('base64') })
            },
            // a book coming from the phone, in pieces
            '/iqra/upload': async (req, res, url, { send, json }) => {
                const name = safeFileName(url.searchParams.get('name'))
                const offset = Number(url.searchParams.get('offset')) || 0
                const total = Number(url.searchParams.get('total')) || 0
                const dir = BOOKS_IN()
                await fsp.mkdir(dir, { recursive: true })
                const part = path.join(dir, name + '.part')
                const { data } = await json(req, 32 * 1024 * 1024)
                const buf = Buffer.from(data, 'base64')
                if (offset === 0) await fsp.writeFile(part, buf)
                else {
                    const st = await fsp.stat(part).catch(() => null)
                    if (!st || st.size !== offset) return send(res, 409, { error: 'out of order', have: st ? st.size : 0 })
                    await fsp.appendFile(part, buf)
                }
                if (offset + buf.length < total) return send(res, 200, { done: false, have: offset + buf.length })
                let dest = path.join(dir, name)
                const ext = path.extname(name), stem = name.slice(0, name.length - ext.length)
                for (let i = 2; fs.existsSync(dest); i++) {
                    if ((await fsp.stat(dest)).size === total) { await fsp.rm(part, { force: true }); break } // already here
                    dest = path.join(dir, `${stem} (${i})${ext}`)
                }
                if (fs.existsSync(part)) await fsp.rename(part, dest)
                const st = await fsp.stat(dest)
                return send(res, 200, { done: true, path: dest, size: st.size, mtime: Math.round(st.mtimeMs) })
            },
        },
    })
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) app.quit()
else {
    app.on('second-instance', (e, argv) => {
        const files = fileArgs(argv)
        const main = [...windows].find(w => w.isMainLibrary) ?? createWindow()
        if (main.isMinimized()) main.restore()
        main.focus()
        if (files.length) main.webContents.send('open-files', files)
    })
    app.setAppUserModelId('com.pkleft.iqra')
    app.whenReady().then(() => {
        Menu.setApplicationMenu(null)
        loadStores()
        registerProtocol()
        registerIpc()
        session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['local-fonts', 'fullscreen', 'clipboard-sanitized-write'].includes(permission)))
        session.defaultSession.setPermissionCheckHandler((wc, permission) => ['local-fonts', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read'].includes(permission))
        pendingFiles = fileArgs(process.argv)
        createWindow()
        if (!process.env.IQRA_TEST) startPhoneSync()
    })
    app.on('window-all-closed', () => { flushStores(); app.quit() })
    app.on('before-quit', flushStores)
}
