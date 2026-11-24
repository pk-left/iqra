// Library data helpers + the importer that finds books, reads their details and sorts them.
import { data, db } from './db.js'
import { hashStr, sleep, dayKey } from './ui.js'
import { parseFilename, normalizeMeta, guessKind, mapGenres } from './sort.js'
import { extractMeta, baseName } from './formats.js'
import { S } from './settings.js'

const api = window.api
export let appInfo = {}
export const setAppInfo = i => { appInfo = i }

const extOf = p => { const n = p.toLowerCase(); return n.endsWith('.fb2.zip') ? 'fbz' : (n.match(/\.([a-z0-9]+)$/)?.[1] ?? '') }
const dupKey = (p, size) => baseName(p).toLowerCase().replace(/\s*\(\d+\)(?=\.[a-z0-9]+$)/, '').replace(/\s+/g, ' ') + '|' + size

export const lib = {
    get all() { return Object.values(data.library.books ?? {}) },
    get books() { return this.all.filter(b => !b.removed) },
    get(id) { return data.library.books?.[id] },
    update(id, patch) { db.patch('library', Object.entries(patch).map(([k, v]) => [['books', id, k], v])) },
    get collections() { return Object.values(data.library.collections ?? {}).sort((a, b) => a.name.localeCompare(b.name)) },
    coverURL(b) { return b.cover ? `${window.__coverSrc(b.id)}?v=${b.cover}` : null },
    setStatus(id, status) {
        const patch = { status }
        if (status === 'finished') {
            patch.progress = 1; patch.finishedAt = Date.now()
            if (this.get(id)?.kind !== 'document') db.set('stats', ['finished', id], dayKey())
        } else if (status === 'unread') { patch.progress = 0; patch.location = null; patch.finishedAt = null; db.set('stats', ['finished', id], null) }
        else { patch.finishedAt = null; db.set('stats', ['finished', id], null) }
        this.update(id, patch)
    },
}

function makeRecord(f) {
    const format = extOf(f.path)
    const name = baseName(f.path)
    const guess = normalizeMeta({}, name, format)
    return {
        id: hashStr(f.path.toLowerCase()), path: f.path, size: f.size, mtime: f.mtime, format,
        title: guess.title, author: guess.author, authors: guess.authors, series: guess.series, seriesIndex: guess.seriesIndex,
        genres: guess.genres, subjects: [], language: '', year: guess.year, description: '', publisher: '',
        kind: guessKind(format, guess.title, null, f.size),
        addedAt: f.mtime || Date.now(), status: 'unread', progress: 0, metaDone: false,
    }
}

const listeners = new Set()
export const importer = {
    state: { scanning: false, metaTotal: 0, metaDone: 0, metaRunning: false, genreRunning: false, lastAdded: 0 },
    onProgress(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit() { for (const fn of listeners) fn(this.state) },
    folders() { return S.app.folders ?? appInfo.folders ?? [] },

    // Merge a list of files on disk into the library. Returns ids of newly added books.
    addFiles(files, { scannedFolders } = {}) {
        const books = data.library.books ?? {}
        const byPath = new Map(), byDup = new Map()
        for (const b of Object.values(books)) {
            byPath.set(b.path.toLowerCase(), b)
            byDup.set(dupKey(b.path, b.size), b)
        }
        const ops = [], added = [], seen = new Set()
        for (const f of files) {
            const low = f.path.toLowerCase()
            seen.add(low)
            const have = byPath.get(low)
            if (have) {
                if (have.missing) ops.push([['books', have.id, 'missing'], null])
                if (have.size !== f.size) ops.push([['books', have.id, 'size'], f.size], [['books', have.id, 'metaDone'], false])
                continue
            }
            const dup = byDup.get(dupKey(f.path, f.size))
            if (dup) {
                // the same file in a new place: follow it if the old one is gone, otherwise skip the copy
                if (dup.missing && !dup.removed) {
                    ops.push([['books', dup.id, 'path'], f.path], [['books', dup.id, 'missing'], null])
                    byPath.set(low, dup); dup.missing = false
                }
                continue
            }
            const rec = makeRecord(f)
            if (books[rec.id]) continue
            ops.push([['books', rec.id], rec])
            byPath.set(low, rec); byDup.set(dupKey(f.path, f.size), rec)
            added.push(rec.id)
        }
        if (scannedFolders) {
            const roots = scannedFolders.map(r => r.toLowerCase().replace(/[\\/]+$/, ''))
            for (const b of Object.values(books)) {
                const low = b.path.toLowerCase()
                if (!b.missing && !b.removed && !seen.has(low) && roots.some(r => low.startsWith(r + '\\') || low.startsWith(r + '/')) && appInfo.bookExt?.includes(b.format))
                    ops.push([['books', b.id, 'missing'], true])
            }
        }
        if (ops.length) db.patch('library', ops)
        return added
    },

    async scan() {
        if (this.state.scanning) return []
        this.state.scanning = true; this.emit()
        let added = []
        try {
            const folders = this.folders()
            const files = await api.invoke('scan', folders)
            added = this.addFiles(files, { scannedFolders: folders })
            db.set('library', ['lastScan'], Date.now())
            this.state.lastAdded = added.length
        } finally { this.state.scanning = false; this.emit() }
        this.runMeta()
        return added
    },

    async addPaths(paths) {
        const files = []
        for (const p of paths) {
            const st = await api.invoke('stat', p)
            if (!st) continue
            if (st.isDir) files.push(...await api.invoke('walk:any', p))
            else files.push({ path: p, size: st.size, mtime: st.mtime })
        }
        const ok = files.filter(f => appInfo.bookExt.includes(extOf(f.path)) || appInfo.docExt.includes(extOf(f.path)))
        const added = this.addFiles(ok)
        // bring back books the user had removed if they add them again on purpose
        for (const f of ok) {
            const b = lib.all.find(x => x.path.toLowerCase() === f.path.toLowerCase())
            if (b?.removed) { lib.update(b.id, { removed: null }); added.push(b.id) }
        }
        this.runMeta()
        return { added, files: ok }
    },

    async runMeta() {
        if (this.state.metaRunning) return
        this.state.metaRunning = true
        try {
            for (;;) {
                const pending = lib.books.filter(b => !b.metaDone && !b.missing)
                    .sort((a, b) => (a.format === 'pdf') - (b.format === 'pdf') || a.size - b.size)
                if (!pending.length) break
                this.state.metaTotal = Math.max(this.state.metaTotal, this.state.metaDone + pending.length)
                const rec = pending[0]
                if ((rec.metaTry ?? 0) >= 2) lib.update(rec.id, { metaDone: true, metaError: 'This file could not be read (skipped after two attempts)' })
                else {
                    lib.update(rec.id, { metaTry: (rec.metaTry ?? 0) + 1 })
                    await this.readDetails(rec)
                }
                this.state.metaDone++
                this.emit()
                await sleep(document.hidden ? 0 : 4)
            }
        } finally {
            this.state.metaRunning = false; this.state.metaTotal = 0; this.state.metaDone = 0
            this.emit()
        }
        this.runGenres()
    },

    async readDetails(rec, force) {
        const res = await extractMeta(rec)
        const patch = { metaDone: true }
        if (res.error) {
            patch.metaError = res.error
            if (/FILE_MISSING|404/.test(res.error)) patch.missing = true
        } else {
            const m = normalizeMeta(res.raw, baseName(rec.path), rec.format)
            const edited = force ? {} : (rec.edited ?? {})
            for (const k of ['title', 'author', 'authors', 'series', 'seriesIndex', 'genres', 'subjects', 'language', 'publisher', 'year', 'description'])
                if (!edited[k === 'authors' ? 'author' : k]) patch[k] = m[k]
            if (res.pages != null) patch.pages = res.pages
            if (!edited.kind) patch.kind = guessKind(rec.format, patch.title ?? rec.title, res.pages ?? rec.pages, rec.size)
            patch.metaError = null; patch.metaTry = null
            if (res.cover && !rec.customCover) {
                try { await api.invoke('cover:save', rec.id, res.cover); patch.cover = Date.now() } catch (e) { console.warn(e) }
            }
        }
        lib.update(rec.id, patch)
    },

    // Fill in missing genres from Open Library (title + author only; nothing else leaves the computer)
    async runGenres() {
        if (this.state.genreRunning || !S.app.lookupGenres) return
        this.state.genreRunning = true
        let failures = 0
        try {
            for (;;) {
                const rec = lib.books.find(b => b.metaDone && !b.genreLooked && !b.genres?.length && b.kind === 'book' && b.title && !b.edited?.genres)
                if (!rec || failures >= 3) break
                const q = new URLSearchParams({ title: rec.title.slice(0, 120), limit: '1', fields: 'subject,first_publish_year,author_name' })
                if (rec.authors?.[0]) q.set('author', rec.authors[0])
                const res = await api.invoke('net:fetch', `https://openlibrary.org/search.json?${q}`, { timeout: 12000 })
                const patch = { genreLooked: true }
                if (!res.ok) failures++
                else {
                    failures = 0
                    try {
                        const doc = JSON.parse(res.text).docs?.[0]
                        if (doc?.subject?.length) {
                            const genres = mapGenres(doc.subject.slice(0, 40), rec.title, false)
                            if (genres.length) patch.genres = genres
                            if (!rec.subjects?.length) patch.subjects = doc.subject.slice(0, 10)
                        }
                        if (doc?.first_publish_year && !rec.year) patch.year = String(doc.first_publish_year)
                        if (!rec.author && doc?.author_name?.[0]) { patch.author = doc.author_name[0]; patch.authors = [doc.author_name[0]] }
                    } catch { /* unexpected reply */ }
                }
                if (res.ok) lib.update(rec.id, patch)
                await sleep(700)
            }
        } finally { this.state.genreRunning = false; this.emit() }
    },
}
