// Opens every supported file type as a book object the reading engine understands,
// and pulls metadata + covers out of files for the library.
import { makeBook } from '../vendor/foliate-js/view.js'
import { esc } from './ui.js'

const api = window.api
export const fileURL = p => window.__fileSrc(p)
export const baseName = p => p.split(/[\\/]/).pop()
export const FIXED = new Set(['pdf', 'cbz', 'cbr', 'cb7', 'cbt', 'djvu', 'djv'])
export const COMIC = new Set(['cbz', 'cbr', 'cb7', 'cbt'])

// A file on disk that behaves like a Blob but only reads the byte ranges asked for.
export class DiskFile {
    constructor(path, size, name, type = '', start = 0, end = size) {
        this.path = path; this.fullSize = size; this.name = name; this.type = type
        this.start = start; this.end = end
    }
    get size() { return this.end - this.start }
    slice(s = 0, e = this.size, type = this.type) {
        if (s < 0) s = Math.max(0, this.size + s)
        if (e < 0) e = Math.max(0, this.size + e)
        s = Math.min(s, this.size); e = Math.min(Math.max(e, s), this.size)
        return new DiskFile(this.path, this.fullSize, this.name, type, this.start + s, this.start + e)
    }
    async arrayBuffer() {
        if (this.size <= 0) return new ArrayBuffer(0)
        const res = await fetch(fileURL(this.path), { headers: { Range: `bytes=${this.start}-${this.end - 1}` } })
        if (!res.ok) throw new Error(`Could not read file (${res.status})`)
        return res.arrayBuffer()
    }
    async text() { return new TextDecoder().decode(await this.arrayBuffer()) }
    stream() { return new Response(this.arrayBuffer().then(b => new Blob([b]))).body }
}
const nameFor = rec => {
    const n = baseName(rec.path).toLowerCase()
    // the engine sniffs some formats by extension
    if (rec.format === 'fbz' && !/\.(fbz|fb2\.zip)$/.test(n)) return n + '.fbz'
    return n
}
async function wholeFile(rec) {
    const res = await fetch(fileURL(rec.path))
    if (!res.ok) throw new Error(res.status === 404 ? 'FILE_MISSING' : `Could not read file (${res.status})`)
    return new File([await res.blob()], nameFor(rec))
}
const diskFile = rec => new DiskFile(rec.path, rec.size, nameFor(rec))

// ---------- text helpers ----------
export function decodeText(buf) {
    const u8 = new Uint8Array(buf)
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8)
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8) } catch { return new TextDecoder('windows-1252').decode(u8) }
}
const CHAPTER_RE = /^\s{0,8}((chapter|chapitre|cap[ií]tulo|kapitel|part|book|section|act)\s+([0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|[a-z-]+teen|twenty[a-z-]*)\b.{0,70}|prologue|epilogue|introduction|preface|foreword|afterword|第\s*[0-9零一二三四五六七八九十百千]+\s*[章回卷节部篇].{0,40})\s*$/i

function textToChapters(text, title) {
    text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
    const lines = text.split('\n')
    const blank = lines.filter(l => !l.trim()).length
    const hardWrapped = blank > lines.length * 0.08 && lines.filter(l => l.length > 55 && l.length < 85).length > lines.length * 0.35
    const chapters = []
    let cur = { title: '', paras: [] }, para = []
    const flushPara = () => { if (para.length) { cur.paras.push(para.join(hardWrapped ? ' ' : '\n')); para = [] } }
    const flushChap = () => { flushPara(); if (cur.paras.length || cur.title) chapters.push(cur) }
    for (const line of lines) {
        const t = line.trim()
        if (t && t.length < 90 && CHAPTER_RE.test(t)) {
            flushChap(); cur = { title: t, paras: [] }
        } else if (!t) flushPara()
        else if (hardWrapped) para.push(t)
        else { flushPara(); para.push(t) }
    }
    flushChap()
    // no chapter headings found: cut into comfortable parts
    let parts = chapters
    if (chapters.length <= 1) {
        const all = chapters[0]?.paras ?? []
        parts = []
        let acc = [], len = 0
        for (const p of all) {
            acc.push(p); len += p.length
            if (len > 30000) { parts.push({ title: '', paras: acc }); acc = []; len = 0 }
        }
        if (acc.length) parts.push({ title: '', paras: acc })
        if (parts.length > 1) parts.forEach((p, i) => p.title = `Part ${i + 1}`)
    }
    return parts.map((c, i) => ({
        title: c.title || (i === 0 ? title : `Part ${i + 1}`),
        html: (c.title ? `<h2>${esc(c.title)}</h2>` : '') + c.paras.map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n'),
    }))
}
function splitHtmlByHeadings(html, title) {
    const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}</body>`, 'text/html')
    doc.querySelectorAll('script,iframe,object,embed,link[rel=stylesheet]').forEach(e => e.remove())
    const level = doc.body.querySelector(':scope > h1') ? 'H1' : doc.body.querySelector(':scope > h2') ? 'H2' : null
    const total = doc.body.innerHTML.length
    if (!level || total < 20000) return [{ title, html: doc.body.innerHTML }]
    const chapters = []
    let cur = { title, nodes: [] }
    for (const node of Array.from(doc.body.childNodes)) {
        if (node.nodeName === level && cur.nodes.some(n => n.textContent.trim())) {
            chapters.push(cur); cur = { title: node.textContent.trim().slice(0, 120), nodes: [] }
        } else if (node.nodeName === level) cur.title = node.textContent.trim().slice(0, 120) || cur.title
        cur.nodes.push(node)
    }
    chapters.push(cur)
    return chapters.map(c => {
        const div = doc.createElement('div')
        c.nodes.forEach(n => div.append(n))
        return { title: c.title, html: div.innerHTML }
    })
}

// A reflowable book made from plain HTML chapters (used for txt, md, html, docx, odt, rtf, doc)
// Right-to-left scripts (Arabic, Hebrew, Syriac, Thaana, N'Ko): if most letters in the text are in one of
// these, the book is laid out and paged right to left
export const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he', 'iw', 'ps', 'sd', 'ug', 'yi', 'ckb', 'dv', 'syr', 'arc', 'ks', 'ku'])
export function detectScript(text) {
    const sample = String(text ?? '').slice(0, 30000)
    const rtl = (sample.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) ?? []).length
    const ltr = (sample.match(/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g) ?? []).length
    if (rtl > 40 && rtl > ltr) return (sample.match(/[\u0590-\u05FF]/g) ?? []).length > rtl / 2 ? 'he' : 'ar'
    return null
}
function makeHtmlBook({ title, author, language, chapters, css = '' }) {
    const urls = []
    if (!language) {
        const plain = chapters.slice(0, 3).map(c => c.html.replace(/<[^>]+>/g, ' ')).join(' ')
        language = detectScript(plain) ?? ''
    }
    const dir = RTL_LANGS.has(String(language).split('-')[0].toLowerCase()) ? 'rtl' : ''
    const docs = chapters.map(c => `<!DOCTYPE html><html lang="${esc(language || '')}"${dir ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><title>${esc(c.title || title)}</title><style>
body{overflow-wrap:break-word} img{max-width:100%;height:auto} table{border-collapse:collapse;max-width:100%} td,th{border:1px solid color-mix(in srgb,currentColor 25%,transparent);padding:.3em .6em}
pre{white-space:pre-wrap} blockquote{margin-inline:1.2em;opacity:.9} ${css}</style></head><body>${c.html}</body></html>`)
    const book = { metadata: { title, author, language }, rendition: {}, dir: dir || undefined }
    book.sections = docs.map((str, i) => ({
        id: i, linear: 'yes', size: str.length,
        load: () => (urls[i] ??= URL.createObjectURL(new Blob([str], { type: 'text/html' }))),
        createDocument: () => new DOMParser().parseFromString(str, 'text/html'),
    }))
    book.toc = chapters.length > 1 ? chapters.map((c, i) => ({ label: c.title || `Part ${i + 1}`, href: String(i) })) : []
    book.resolveHref = href => {
        const [a, b] = String(href).split('#')
        if (a === '' && b) return { index: -1, anchor: doc => doc.getElementById(b) }
        return { index: Number(a) || 0, anchor: doc => (b ? doc.getElementById(b) : null) ?? 0 }
    }
    book.splitTOCHref = href => { const [a, b] = String(href ?? '').split('#'); return [Number(a) || 0, b ?? null] }
    book.getTOCFragment = (doc, id) => (id ? doc.getElementById(id) : null) ?? doc.documentElement
    book.isExternal = uri => /^(?!blob:)\w+:/i.test(uri)
    book.getCover = async () => null
    book.destroy = () => urls.forEach(u => u && URL.revokeObjectURL(u))
    return book
}

// A fixed-layout book made of page images (comics, DjVu)
function makeImageBook({ title, count, getPage, labels, getCover, onDestroy }) {
    const cache = new Map()
    const book = { metadata: { title: '' }, rendition: { layout: 'pre-paginated' } }
    book.sections = Array.from({ length: count }, (_, i) => ({
        id: i, size: 1000,
        load: async () => {
            if (cache.has(i)) return cache.get(i)[1]
            const blob = await getPage(i)
            const src = URL.createObjectURL(blob)
            const page = URL.createObjectURL(new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}img{display:block}</style></head><body><img src="${src}"></body></html>`], { type: 'text/html' }))
            cache.set(i, [src, page])
            return page
        },
        unload: () => { cache.get(i)?.forEach(u => URL.revokeObjectURL(u)); cache.delete(i) },
    }))
    book.toc = labels ? labels.map((label, i) => ({ label, href: String(i) })) : []
    book.resolveHref = href => ({ index: Number(String(href).split('#')[0]) || 0 })
    book.splitTOCHref = href => [Number(href) || 0, null]
    book.getTOCFragment = doc => doc.documentElement
    book.isExternal = uri => /^(?!blob:)\w+:/i.test(uri)
    book.getCover = getCover ?? (() => getPage(0))
    book.getPageBlob = getPage // used by the comic scroll mode
    book.destroy = () => { for (const arr of cache.values()) arr.forEach(u => URL.revokeObjectURL(u)); onDestroy?.() }
    return book
}

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg|jxl)$/i
const natural = new Intl.Collator([], { numeric: true, sensitivity: 'base' }).compare
let zipMod
async function zipLib() {
    zipMod ??= await import('../vendor/foliate-js/vendor/zip.js')
    zipMod.configure({ useWebWorkers: false })
    return zipMod
}
const xmlText = (doc, tag) => doc.getElementsByTagName(tag)[0]?.textContent?.trim() || ''

async function makeCBZ(file, rec) {
    const { ZipReader, BlobReader, BlobWriter, TextWriter } = await zipLib()
    const entries = (await new ZipReader(new BlobReader(file)).getEntries()).filter(e => !e.directory)
    const pages = entries.filter(e => IMG_RE.test(e.filename) && !e.filename.includes('__MACOSX') && !e.filename.split('/').pop().startsWith('.'))
        .sort((a, b) => natural(a.filename, b.filename))
    if (!pages.length) throw new Error('No images found in this comic archive')
    const mime = n => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' })[n.split('.').pop().toLowerCase()] ?? ''
    const book = makeImageBook({
        title: baseName(rec.path), count: pages.length,
        getPage: i => pages[i].getData(new BlobWriter(mime(pages[i].filename))),
    })
    const info = entries.find(e => /(^|\/)comicinfo\.xml$/i.test(e.filename))
    if (info) {
        try {
            const doc = new DOMParser().parseFromString(await info.getData(new TextWriter()), 'application/xml')
            const series = xmlText(doc, 'Series'), number = xmlText(doc, 'Number'), t = xmlText(doc, 'Title')
            Object.assign(book.metadata, {
                fromComicInfo: true,
                title: t || (series ? `${series}${number ? ' #' + number : ''}` : book.metadata.title),
                author: xmlText(doc, 'Writer') || xmlText(doc, 'Penciller'),
                series, seriesIndex: number, subject: xmlText(doc, 'Genre').split(',').map(s => s.trim()).filter(Boolean),
                description: xmlText(doc, 'Summary'), published: xmlText(doc, 'Year'),
                publisher: xmlText(doc, 'Publisher'), language: xmlText(doc, 'LanguageISO'),
            })
        } catch { /* ignore broken ComicInfo */ }
    }
    return book
}
async function makeArchiveComic(rec, firstOnly) {
    const files = await api.invoke('archive:extract', rec.path, rec.id, !!firstOnly)
    if (!files.length) throw new Error('No images found in this comic archive')
    return makeImageBook({
        title: baseName(rec.path), count: files.length,
        getPage: async i => (await fetch(fileURL(files[i]))).blob(),
    })
}

async function makeDjVu(file) {
    const m = await import('../vendor/djvu-rs/djvu_rs.js')
    await m.default()
    const doc = await m.WasmLazyDocument.open(file.size, async (offset, len) =>
        new Uint8Array(await file.slice(offset, offset + len).arrayBuffer()))
    const count = doc.page_count()
    const render = async (i, dpi, type = 'image/jpeg') => {
        const pm = await doc.render_page(i, dpi)
        const w = pm.width(), ht = pm.height()
        const canvas = new OffscreenCanvas(w, ht)
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pm.view()), w, ht), 0, 0)
        pm.free?.()
        return canvas.convertToBlob({ type, quality: 0.9 })
    }
    const dpi = Math.min(220, Math.round(110 * Math.max(1, devicePixelRatio)))
    let queue = Promise.resolve()
    const serial = fn => (queue = queue.then(fn, fn)) // the decoder handles one page at a time
    return makeImageBook({
        title: file.name, count,
        getPage: i => serial(() => render(i, dpi)),
        getCover: () => serial(() => render(0, 60)),
        onDestroy: () => { try { doc.free() } catch { /* already freed */ } },
    })
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[data-src="${src}"]`)) return resolve()
        const s = document.createElement('script')
        s.src = src; s.dataset.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`))
        document.head.append(s)
    })
}
function rtfToText(rtf) {
    let s = rtf.replace(/\{\\\*?\\?(fonttbl|colortbl|stylesheet|info|pict|themedata|datastore|latentstyles|generator|xmlnstbl|listtable|listoverridetable|rsidtbl|mmathPr)[\s\S]*?\}(?=\s*[{\\}])/g, '')
    s = s.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
    s = s.replace(/\\par[d]?\b ?/g, '\n').replace(/\\line\b ?/g, '\n').replace(/\\tab\b ?/g, '\t')
    s = s.replace(/\\u(-?\d+)\??\s?/g, (_, n) => String.fromCodePoint((+n + 65536) % 65536))
    s = s.replace(/\\'([0-9a-f]{2})/gi, (_, hx) => new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(hx, 16)])))
    s = s.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '')
    return s
}
function odtToHtml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const conv = node => {
        if (node.nodeType === 3) return esc(node.nodeValue)
        if (node.nodeType !== 1) return ''
        const inner = () => Array.from(node.childNodes).map(conv).join('')
        switch (node.localName) {
            case 'h': return `<h${Math.min(6, +node.getAttribute('text:outline-level') || 2)}>${inner()}</h${Math.min(6, +node.getAttribute('text:outline-level') || 2)}>`
            case 'p': return `<p>${inner()}</p>`
            case 'list': return `<ul>${inner()}</ul>`
            case 'list-item': return `<li>${inner()}</li>`
            case 'table': return `<table>${inner()}</table>`
            case 'table-row': return `<tr>${inner()}</tr>`
            case 'table-cell': return `<td>${inner()}</td>`
            case 'line-break': return '<br>'
            case 'tab': return ' '
            case 's': return ' '
            default: return inner()
        }
    }
    const body = doc.getElementsByTagName('office:text')[0]
    return body ? Array.from(body.childNodes).map(conv).join('\n') : ''
}

async function makeDocument(rec) {
    const fmt = rec.format
    const title = rec.title || baseName(rec.path).replace(/\.[^.]+$/, '')
    const buffer = async () => (await wholeFile(rec)).arrayBuffer()
    if (fmt === 'txt') return makeHtmlBook({ title, chapters: textToChapters(decodeText(await buffer()), title) })
    if (fmt === 'md' || fmt === 'markdown') {
        const { marked } = await import('../vendor/marked.esm.js')
        return makeHtmlBook({ title, chapters: splitHtmlByHeadings(marked.parse(decodeText(await buffer())), title) })
    }
    if (fmt === 'html' || fmt === 'htm' || fmt === 'xhtml') {
        const doc = new DOMParser().parseFromString(decodeText(await buffer()), 'text/html')
        return makeHtmlBook({ title: doc.title?.trim() || title, chapters: splitHtmlByHeadings(doc.body?.innerHTML ?? '', doc.title?.trim() || title) })
    }
    if (fmt === 'docx') {
        await loadScript('vendor/mammoth.browser.min.js')
        const res = await window.mammoth.convertToHtml({ arrayBuffer: await buffer() })
        return makeHtmlBook({ title, chapters: splitHtmlByHeadings(res.value, title) })
    }
    if (fmt === 'odt') {
        const { ZipReader, BlobReader, TextWriter } = await zipLib()
        const entries = await new ZipReader(new BlobReader(await wholeFile(rec))).getEntries()
        const content = entries.find(e => e.filename === 'content.xml')
        if (!content) throw new Error('Not a valid ODT file')
        return makeHtmlBook({ title, chapters: splitHtmlByHeadings(odtToHtml(await content.getData(new TextWriter())), title) })
    }
    if (fmt === 'rtf') return makeHtmlBook({ title, chapters: textToChapters(rtfToText(new TextDecoder('windows-1252').decode(await buffer())), title) })
    if (fmt === 'doc') return makeHtmlBook({ title, chapters: textToChapters(await api.invoke('doc:text', rec.path), title) })
    return null
}

// ---------- public: open a book for reading ----------
export async function openBook(rec, { forMeta = false } = {}) {
    const fmt = rec.format
    let book
    if (fmt === 'cbz') book = await makeCBZ(forMeta || rec.size > 300e6 ? diskFile(rec) : await wholeFile(rec), rec)
    else if (COMIC.has(fmt)) book = await makeArchiveComic(rec, forMeta)
    else if (fmt === 'djvu' || fmt === 'djv') book = await makeDjVu(diskFile(rec))
    else if (fmt === 'pdf') book = await makeBook(diskFile(rec))
    else if (fmt === 'epub') book = await makeBook(forMeta || rec.size > 200e6 ? diskFile(rec) : await wholeFile(rec))
    else book = await makeDocument(rec)
    if (!book) {
        // mobi, azw3, fb2, fbz and anything unknown: let the engine sniff the content
        const file = await wholeFile(rec)
        try { book = await makeBook(file) } catch (e) {
            if (/not supported/i.test(e.message)) {
                // last resort: treat as text if it looks like text
                const head = new Uint8Array(await file.slice(0, 2048).arrayBuffer())
                if (!head.some(b => b === 0)) return makeHtmlBook({ title: rec.title, chapters: textToChapters(decodeText(await file.arrayBuffer()), rec.title) })
            }
            throw e
        }
    }
    return book
}

// ---------- public: metadata + cover for the library ----------
async function firstImage(book) {
    for (const s of (book.sections ?? []).slice(0, 3)) {
        const url = await s.load()
        if (!url) continue
        const doc = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html')
        const el = doc.querySelector('img[src], image')
        const src = el?.getAttribute('src') ?? el?.getAttribute('xlink:href') ?? el?.getAttribute('href')
        if (src?.startsWith('blob:')) return (await fetch(src)).blob()
        if ((doc.body?.textContent ?? '').trim().length > 800) break
    }
    return null
}
export async function coverToJpeg(blob, maxW = 400, maxH = 640, strict = false) {
    let bmp
    try { bmp = await createImageBitmap(blob) } catch {
        // e.g. SVG covers
        const url = URL.createObjectURL(blob)
        try {
            const img = new Image()
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
            bmp = img
        } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
    }
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight
    if (!w0 || !h0) throw new Error('Empty cover')
    if (strict && (w0 < 180 || h0 < 240 || w0 > h0 * 1.2)) throw new Error('Not a cover image')
    const scale = Math.min(1, maxW / w0, maxH / h0)
    const w = Math.max(1, Math.round(w0 * scale)), ht = Math.max(1, Math.round(h0 * scale))
    const canvas = new OffscreenCanvas(w, ht)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, ht)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, ht)
    bmp.close?.()
    return (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.84 })).arrayBuffer()
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))])

export async function extractMeta(rec) {
    const out = { raw: null, cover: null, pages: null, error: null }
    let book
    try {
        book = await withTimeout(openBook(rec, { forMeta: true }), 30000, 'Opening')
        out.raw = book.metadata ?? {}
        if (FIXED.has(rec.format)) out.pages = COMIC.has(rec.format) && rec.format !== 'cbz' ? null : book.sections.length
        try {
            let blob = await withTimeout(Promise.resolve(book.getCover?.()), 20000, 'Cover')
            if (blob) out.cover = await coverToJpeg(blob)
            else if (!FIXED.has(rec.format)) {
                // no declared cover: many books simply put the cover image on their first page
                blob = await withTimeout(firstImage(book), 15000, 'Cover')
                if (blob) out.cover = await coverToJpeg(blob, 400, 640, true)
            }
        } catch (e) { console.warn('cover failed', rec.path, e) }
    } catch (e) {
        out.error = e?.message ?? String(e)
    } finally {
        try { book?.destroy?.() } catch { /* ignore */ }
    }
    return out
}
