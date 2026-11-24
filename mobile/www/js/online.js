// Book details and covers from the internet (Open Library and Google Books).
// Only the title and author are sent. Nothing changes unless the user clicks a button.
import { h, icon, modal, toast } from './ui.js'
import { lib } from './store.js'
import { coverToJpeg } from './formats.js'
import { mapGenres } from './sort.js'

const api = window.api
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FIELDS = ['title', 'author', 'year', 'publisher', 'pages', 'description', 'genres']

// ---------- matching ----------
const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ').split(/[:;–—]/)[0].replace(/[^a-z0-9؀-ۿ ]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim()
const words = s => new Set(norm(s).split(' ').filter(w => w.length > 1))
function titleScore(a, b) {
    const A = words(a), B = words(b)
    if (!A.size || !B.size) return 0
    let both = 0
    for (const w of A) if (B.has(w)) both++
    return both / Math.max(A.size, B.size)
}
const lastName = s => norm(s).split(' ').pop()
function authorMatches(rec, c) {
    const mine = rec.authors?.length ? rec.authors : rec.author ? [rec.author] : []
    if (!mine.length || !c.authors?.length) return null // unknown
    return mine.some(a => c.authors.some(b => lastName(a) && lastName(a) === lastName(b)))
}
// how sure we are that a result is this book (0 to 1)
export function confidence(rec, c) {
    const t = titleScore(rec.title, c.title)
    const a = authorMatches(rec, c)
    return a === false ? t * 0.3 : a === true ? Math.min(1, t + 0.15) : t * 0.85
}

// ---------- searching ----------
async function getJSON(url) {
    const res = await api.invoke('net:fetch', url, { timeout: 25000 })
    if (!res.ok) throw new Error(res.status === 429 ? 'Too many requests, try again in a minute' : res.error || `HTTP ${res.status}`)
    return JSON.parse(res.text)
}
async function openLibrary(title, author) {
    const q = new URLSearchParams({ title: title.slice(0, 120), limit: '6', fields: 'key,title,subtitle,author_name,first_publish_year,publisher,number_of_pages_median,subject,cover_i,language' })
    if (author) q.set('author', author)
    const data = await getJSON(`https://openlibrary.org/search.json?${q}`)
    return (data.docs ?? []).map(d => ({
        source: 'Open Library', key: d.key,
        title: d.title, authors: d.author_name?.slice(0, 4) ?? [],
        year: d.first_publish_year ? String(d.first_publish_year) : '',
        publisher: d.publisher?.[0] ?? '', pages: d.number_of_pages_median ?? null,
        subjects: d.subject?.slice(0, 40) ?? [], description: '',
        cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg?default=false` : null,
        thumb: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    }))
}
async function googleBooks(title, author) {
    const q = `intitle:${title.slice(0, 120)}${author ? ` inauthor:${author}` : ''}`
    const data = await getJSON(`https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q, maxResults: '6', printType: 'books' })}`)
    return (data.items ?? []).map(it => {
        const v = it.volumeInfo ?? {}
        const img = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:').replace('&edge=curl', '')
        return {
            source: 'Google Books', key: it.id,
            title: v.title ?? '', authors: v.authors?.slice(0, 4) ?? [],
            year: (v.publishedDate ?? '').slice(0, 4), publisher: v.publisher ?? '', pages: v.pageCount || null,
            subjects: v.categories ?? [], description: (v.description ?? '').replace(/<[^>]+>/g, ''),
            // ask Google for a bigger image than the thumbnail
            cover: img ? img.replace(/&zoom=\d/, '') + '&fife=w800-h1200' : null,
            thumb: img || null,
        }
    })
}
export async function searchBook(title, author) {
    const out = await Promise.allSettled([openLibrary(title, author), googleBooks(title, author)])
    const list = out.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    if (!list.length && out.every(r => r.status === 'rejected')) throw out[0].reason
    return list
}
async function fillDescription(c) {
    if (c.description || c.source !== 'Open Library' || !c.key) return c
    try {
        const w = await getJSON(`https://openlibrary.org${c.key}.json`)
        const d = typeof w.description === 'string' ? w.description : w.description?.value
        if (d) c.description = d.replace(/\r/g, '').replace(/\(\[source\]\[\d+\]\)|\[\d+\]:\s*\S+/g, '').trim()
    } catch { /* no description */ }
    return c
}

// ---------- applying ----------
async function saveCover(id, url) {
    if (!url) return false
    const res = await api.invoke('net:fetch', url, { binary: true, timeout: 40000 })
    if (!res.ok || !res.data?.byteLength || !/image/.test(res.type ?? '')) return false
    try {
        // strict: skip blank placeholders and images that are not cover-shaped
        const jpg = await coverToJpeg(new Blob([res.data]), 600, 960, true)
        await api.invoke('cover:save', id, jpg)
        return true
    } catch { return false }
}
// mode 'all': use everything from the chosen result (except what the user typed in themselves)
// mode 'fill': only fill details that are empty
async function apply(id, c, { mode = 'fill', cover = 'missing', details = true } = {}) {
    const rec = lib.get(id)
    if (!rec) return { details: 0, cover: false }
    const edited = { ...(rec.edited ?? {}) }, online = { ...(rec.online ?? {}) }
    const patch = { onlineAt: Date.now(), onlineSource: c.source }
    let n = 0
    if (details) {
        if (mode === 'all' || !rec.description) await fillDescription(c)
        const genres = c.subjects?.length ? mapGenres(c.subjects, c.title, false) : []
        const next = { title: c.title, author: c.authors?.join(', '), year: c.year, publisher: c.publisher, pages: c.pages, description: c.description, genres }
        for (const k of FIELDS) {
            const v = next[k]
            if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
            if (rec.edited?.[k] && !rec.online?.[k]) continue // never overwrite what the user typed in themselves
            const empty = rec[k] == null || rec[k] === '' || (Array.isArray(rec[k]) && !rec[k].length)
            if (mode === 'fill' && !empty) continue
            if (JSON.stringify(rec[k]) === JSON.stringify(v)) continue
            patch[k] = v
            if (k === 'author') patch.authors = c.authors
            // marked as edited so "re-read from file" leaves them alone, and as online so a later lookup may replace them
            if (k !== 'pages') { edited[k] = true; online[k] = true }
            n++
        }
        if (c.subjects?.length && !rec.subjects?.length) patch.subjects = c.subjects.slice(0, 10)
        patch.edited = edited; patch.online = online
    }
    let gotCover = false
    if (cover === 'always' || (cover === 'missing' && !rec.cover) || (cover === 'file' && !rec.customCover)) {
        gotCover = await saveCover(id, c.cover) || (c.thumb !== c.cover && await saveCover(id, c.thumb))
        if (gotCover) { patch.cover = Date.now(); patch.customCover = true }
    }
    lib.update(id, patch)
    return { details: n, cover: gotCover }
}

// ---------- one book: search and pick ----------
export function findOnline(id) {
    const rec = lib.get(id)
    if (!rec) return
    const f = { title: rec.title ?? '', author: rec.authors?.[0] ?? rec.author ?? '' }
    const list = h('div.ol-results', h('p.muted', 'Searching…'))
    const titleIn = h('input', { type: 'text', value: f.title, oninput: e => f.title = e.target.value, onkeydown: e => e.key === 'Enter' && run() })
    const authorIn = h('input', { type: 'text', value: f.author, oninput: e => f.author = e.target.value, onkeydown: e => e.key === 'Enter' && run() })
    const m = modal({
        title: 'Find details and cover online', wide: true, cls: 'ol-modal',
        body: h('div',
            h('div.ol-search', h('label.field', h('span', 'Title'), titleIn), h('label.field', h('span', 'Author'), authorIn),
                h('button.btn.primary', { onclick: () => run() }, icon('search', 16), ' Search')),
            list,
            h('p.muted.small', 'Searches Open Library and Google Books using only the title and author. Details you typed in yourself are kept.')),
    })
    const use = async (c, btn, opts) => {
        btn.disabled = true; btn.textContent = 'Saving…'
        try {
            const r = await apply(id, c, opts)
            toast(r.cover || r.details ? `Updated${r.details ? ` ${r.details} detail${r.details === 1 ? '' : 's'}` : ''}${r.cover ? `${r.details ? ' and' : ''} the cover` : ''}` : 'Nothing new to add from that result')
            m.close()
        } catch (e) { console.warn(e); toast('Could not save that result', { type: 'error' }); btn.disabled = false }
    }
    async function run() {
        if (!f.title.trim()) return
        list.replaceChildren(h('p.muted', 'Searching…'))
        let res
        try { res = await searchBook(f.title.trim(), f.author.trim()) } catch (e) {
            return list.replaceChildren(h('p.warn', `Could not reach the book sites. Check your internet connection. (${e.message ?? e})`))
        }
        const probe = { ...rec, title: f.title, authors: f.author ? [f.author] : [] }
        res.sort((a, b) => (confidence(probe, b) + (b.cover ? 0.05 : 0)) - (confidence(probe, a) + (a.cover ? 0.05 : 0)))
        if (!res.length) return list.replaceChildren(h('p.muted', 'No matches. Try a shorter title or leave the author empty.'))
        list.replaceChildren(...res.slice(0, 10).map(c => {
            const useAll = h('button.btn.primary.small', { onclick: () => use(c, useAll, { mode: 'all', cover: c.cover ? 'always' : 'none' }) }, 'Use this')
            const coverOnly = c.cover ? h('button.btn.small', { onclick: () => use(c, coverOnly, { details: false, cover: 'always' }) }, 'Cover only') : null
            return h('div.ol-item',
                h('div.ol-thumb', c.thumb ? h('img', { src: c.thumb, loading: 'lazy', alt: '' }) : h('span', 'No cover')),
                h('div.ol-info',
                    h('b', c.title), h('div', c.authors.join(', ') || 'Unknown author'),
                    h('div.muted.small', [c.year, c.publisher, c.pages ? `${c.pages} pages` : '', c.source].filter(Boolean).join(' · ')),
                    c.description ? h('p.small', c.description.slice(0, 220) + (c.description.length > 220 ? '…' : '')) : null),
                h('div.ol-actions', useAll, coverOnly))
        }))
    }
    run()
}

// ---------- many books at once ----------
let running = null
export function updateMany(ids, label = 'your library') {
    if (running) return toast('Already updating; see the progress window')
    const books = ids.map(id => lib.get(id)).filter(b => b && !b.removed && b.title && b.kind !== 'document')
    if (!books.length) return toast('No books to update')
    const opt = { replaceCovers: false, skipDone: true }
    const chk = (key, label, hint) => h('label.ol-check', h('input', { type: 'checkbox', checked: opt[key], onchange: e => opt[key] = e.target.checked }), h('span', label, hint ? h('small.muted', hint) : null))
    const status = h('p.ol-status')
    const bar = h('div.ol-bar', h('i'))
    let stop = false
    const m = modal({
        title: 'Fetch details and covers', cls: 'ol-modal',
        body: h('div',
            h('p', `Looks up ${books.length === 1 ? '1 book' : `${books.length} books`} in ${label} on Open Library and Google Books, then fills in missing descriptions, years, publishers, page counts, genres and covers.`),
            chk('replaceCovers', 'Also replace covers that came from the files', 'Your own chosen covers are always kept'),
            chk('skipDone', 'Skip books already updated online')),
        onClose: () => { stop = true },
        actions: [{ label: 'Cancel' }, { label: 'Start', primary: true, run: () => { start(); return false } }],
    })
    async function start() {
        const todo = opt.skipDone ? books.filter(b => !b.onlineAt) : books
        m.box.querySelector('.modal-body').replaceChildren(status, bar)
        m.box.querySelector('footer').replaceChildren(h('button.btn', { onclick: () => m.close() }, 'Stop'))
        running = true
        let done = 0, updated = 0, covers = 0, unsure = 0, failures = 0
        const show = () => {
            status.textContent = `Checked ${done} of ${todo.length} · ${updated} updated · ${covers} new covers${unsure ? ` · ${unsure} not sure` : ''}`
            bar.firstChild.style.width = `${todo.length ? done / todo.length * 100 : 100}%`
        }
        show()
        try {
            for (const b of todo) {
                if (stop) break
                try {
                    const res = await searchBook(b.title, b.authors?.[0] ?? b.author ?? '')
                    failures = 0
                    const best = res.map(c => [confidence(b, c) + (c.cover ? 0.03 : 0), c]).sort((x, y) => y[0] - x[0])[0]
                    if (best && best[0] >= 0.7) {
                        // use the best match, but borrow a cover/description from another good match if it lacks one
                        const c = { ...best[1] }
                        for (const o of res) if (o !== best[1] && confidence(b, o) >= 0.7) { c.cover ??= o.cover; c.thumb ??= o.thumb; if (!c.description) c.description = o.description }
                        const r = await apply(b.id, c, { mode: 'fill', cover: opt.replaceCovers ? 'file' : 'missing' })
                        if (r.details || r.cover) updated++
                        if (r.cover) covers++
                    } else {
                        unsure++
                        lib.update(b.id, { onlineAt: Date.now(), onlineUnsure: true })
                    }
                } catch (e) {
                    console.warn('online lookup failed', b.title, e)
                    if (++failures >= 4) { status.textContent = `Stopped: ${e.message ?? 'the book sites are not answering'}`; break }
                }
                done++; show()
                await sleep(450)
            }
        } finally { running = null }
        if (!status.textContent.startsWith('Stopped')) status.textContent = `${stop ? 'Stopped. ' : 'Done. '}${updated} book${updated === 1 ? '' : 's'} updated, ${covers} new cover${covers === 1 ? '' : 's'}.${unsure ? ` ${unsure} had no sure match; use right-click → Find details online… for those.` : ''}`
        m.box.querySelector('footer').replaceChildren(h('button.btn.primary', { onclick: () => m.close() }, 'Close'))
        if (stop) toast(`Online update stopped: ${updated} updated`)
    }
}
