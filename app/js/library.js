// Library views: home, shelves, auto-sorted facets (authors, series, genres), details, collections.
import { h, $, $$, icon, iconBtn, menu, menuAt, modal, toast, confirmBox, promptBox, debounce, fmtDuration, fmtDate, fmtSize, relTime, uid, esc, dayKey, hashStr, select } from './ui.js'
import { data, db } from './db.js'
import { lib, importer, appInfo } from './store.js'
import { S } from './settings.js'
import { authorSort, titleSort, langName, GENRES } from './sort.js'
import { coverToJpeg } from './formats.js'
import { findOnline, updateMany } from './online.js'
import { todayStats, streak } from './stats.js'
import { dueCards, dueWords, wishCount, addWish } from './study.js'
import { focus } from './focus.js'

const api = window.api
const state = { route: 'home', query: '', selected: new Set(), formatFilter: '', scrollMemo: {} }
let contentEl, sidebarEl, titleEl, countEl, searchEl, toolsEl
let navigate = () => {}

const SORTS = { added: 'Date added', read: 'Last read', title: 'Title', author: 'Author', series: 'Series', progress: 'Progress', year: 'Year', size: 'File size' }
const KIND_LABEL = { book: 'Book', comic: 'Comic', document: 'Document' }

// ---------- data shaping ----------
function matchesQuery(b, q) {
    if (!q) return true
    const hay = `${b.title} ${b.author} ${b.series} ${(b.genres ?? []).join(' ')} ${(b.tags ?? []).join(' ')} ${b.format} ${b.path.split(/[\\/]/).pop()}`.toLowerCase()
    return q.toLowerCase().split(/\s+/).every(w => hay.includes(w))
}
function sortBooks(list, key = S.app.sort, dir = S.app.sortDir) {
    const sign = dir === 'desc' ? -1 : 1
    const cmp = {
        added: (a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0),
        read: (a, b) => (a.lastReadAt ?? 0) - (b.lastReadAt ?? 0),
        title: (a, b) => titleSort(a.title).localeCompare(titleSort(b.title)),
        author: (a, b) => authorSort(a.authors?.[0] ?? '￿').localeCompare(authorSort(b.authors?.[0] ?? '￿')) || seriesCmp(a, b),
        series: (a, b) => seriesCmp(a, b),
        progress: (a, b) => (a.progress ?? 0) - (b.progress ?? 0),
        year: (a, b) => (+a.year || 0) - (+b.year || 0),
        size: (a, b) => a.size - b.size,
    }[key] ?? (() => 0)
    return [...list].sort((a, b) => sign * cmp(a, b) || titleSort(a.title).localeCompare(titleSort(b.title)))
}
const seriesCmp = (a, b) => (a.series || '￿').localeCompare(b.series || '￿') || (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9) || titleSort(a.title).localeCompare(titleSort(b.title))

function facet(type, books = lib.books) {
    const map = new Map()
    const add = (k, b) => { if (!map.has(k)) map.set(k, []); map.get(k).push(b) }
    for (const b of books) {
        if (type === 'authors') { if (b.kind === 'document' && !b.authors?.length) continue; (b.authors?.length ? b.authors : ['']).forEach(a => add(a, b)) }
        else if (type === 'series') { if (b.series) add(b.series, b) }
        else if (type === 'genres') { if (b.kind === 'document') continue; (b.genres?.length ? b.genres : ['']).forEach(g => add(g, b)) }
        else if (type === 'formats') add(b.format, b)
        else if (type === 'languages') add(b.language ? langName(b.language) : '', b)
    }
    if (type === 'series') for (const [k, v] of map) if (v.length < 1) map.delete(k)
    return map
}
function booksForRoute(route) {
    const [page, ...rest] = route.split('/')
    const arg = decodeURIComponent(rest.join('/'))
    const all = lib.books
    switch (page) {
        case 'all': return all.filter(b => b.kind !== 'document')
        case 'everything': return all
        case 'status': return all.filter(b => b.status === arg && (b.kind !== 'document' || arg !== 'unread'))
        case 'favorites': return all.filter(b => b.fav)
        case 'comics': return all.filter(b => b.kind === 'comic')
        case 'documents': return all.filter(b => b.kind === 'document')
        case 'authors': return all.filter(b => arg ? b.authors?.includes(arg) : !b.authors?.length && b.kind !== 'document')
        case 'series': return all.filter(b => b.series === arg)
        case 'genres': return all.filter(b => b.kind !== 'document' && (arg ? b.genres?.includes(arg) : !b.genres?.length))
        case 'formats': return all.filter(b => b.format === arg)
        case 'collections': return (data.library.collections?.[arg]?.books ?? []).map(id => lib.get(id)).filter(b => b && !b.removed)
        case 'missing': return all.filter(b => b.missing)
        default: return all
    }
}

// ---------- cover + card ----------
export function coverEl(b, lazy = true) {
    const url = lib.coverURL(b)
    if (url) return h('img', { src: url, loading: lazy ? 'lazy' : 'eager', decoding: 'async', alt: '', draggable: false })
    const hue = parseInt(hashStr(b.title + b.author).slice(0, 6), 36) % 360
    return h('div.gen-cover', { style: { '--h': hue } }, h('span.gt', b.title), b.author ? h('span.ga', b.author) : null, h('span.gf', b.format.toUpperCase()))
}
function bookCard(b) {
    const pct = Math.round((b.progress ?? 0) * 100)
    return h('div.book', {
        dataset: { id: b.id }, tabIndex: 0, title: `${b.title}${b.author ? '\n' + b.author : ''}`,
        class: [b.status, b.missing ? 'missing' : '', state.selected.has(b.id) ? 'selected' : ''].join(' '),
        onclick: e => onBookClick(e, b), oncontextmenu: e => { e.preventDefault(); bookMenu(e.clientX, e.clientY, b) },
        onkeydown: e => { if (e.key === 'Enter') openBook(b) },
    },
    h('div.cover', coverEl(b),
        h('span.badge.fmt', b.format.toUpperCase()),
        b.status === 'finished' ? h('span.badge.done', icon('check', 12)) : null,
        b.fav ? h('span.badge.fav', icon('heart', 12)) : null,
        b.missing ? h('span.badge.miss', 'File missing') : null,
        b.status === 'reading' && pct > 0 ? h('div.bar', h('i', { style: { width: pct + '%' } })) : null,
        h('button.more', { title: 'More', onclick: e => { e.stopPropagation(); bookMenu(e.clientX, e.clientY, b) } }, icon('ellipsis', 16))),
    h('div.meta', h('div.t', b.series && state.route.startsWith('series/') && b.seriesIndex != null ? `${b.seriesIndex}. ${b.title}` : b.title),
        h('div.a', b.author || (b.kind === 'document' ? 'Document' : ''))))
}
function bookRow(b) {
    const pct = Math.round((b.progress ?? 0) * 100)
    return h('div.brow', {
        dataset: { id: b.id }, class: [b.status, b.missing ? 'missing' : '', state.selected.has(b.id) ? 'selected' : ''].join(' '),
        onclick: e => onBookClick(e, b), oncontextmenu: e => { e.preventDefault(); bookMenu(e.clientX, e.clientY, b) },
    },
    h('div.cover', coverEl(b)), h('div.c1', h('div.t', b.title), h('div.a', b.author || '—')),
    h('div.c2', b.series ? `${b.series}${b.seriesIndex != null ? ' #' + b.seriesIndex : ''}` : ''),
    h('div.c3', (b.genres ?? []).join(', ')), h('div.c4', b.format.toUpperCase()),
    h('div.c5', b.status === 'finished' ? 'Finished' : pct ? pct + '%' : ''), h('div.c6', fmtDate(b.addedAt)))
}
function onBookClick(e, b) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || state.selected.size) {
        state.selected.has(b.id) ? state.selected.delete(b.id) : state.selected.add(b.id)
        e.currentTarget.classList.toggle('selected', state.selected.has(b.id))
        renderSelectionBar()
        return
    }
    openBook(b)
}
export function openBook(b, newWindow) {
    if (newWindow) return api.invoke('win:new', `#/read/${b.id}`)
    navigate(`read/${b.id}`)
}

// ---------- menus & actions ----------
function bookMenu(x, y, b) {
    const ids = state.selected.has(b.id) && state.selected.size > 1 ? [...state.selected] : [b.id]
    const many = ids.length > 1
    const each = fn => ids.forEach(id => fn(lib.get(id)))
    menu(x, y, [
        !many && { label: b.progress > 0 && b.progress < 1 ? 'Continue reading' : 'Read', icon: 'book-open', run: () => openBook(b) },
        !many && { label: 'Open in new window', icon: 'external-link', run: () => openBook(b, true) },
        !many && { label: 'Details', icon: 'info', run: () => showDetails(b.id) },
        !many && '-',
        { label: 'Mark as reading', icon: 'circle', checked: !many && b.status === 'reading', run: () => each(x => lib.setStatus(x.id, 'reading')) },
        { label: 'Mark as finished', icon: 'circle-check', checked: !many && b.status === 'finished', run: () => each(x => lib.setStatus(x.id, 'finished')) },
        { label: 'Mark as unread', icon: 'rotate-ccw', run: () => each(x => lib.setStatus(x.id, 'unread')) },
        { label: !many && b.fav ? 'Remove from favorites' : 'Add to favorites', icon: 'heart', run: () => each(x => lib.update(x.id, { fav: many ? true : !b.fav })) },
        { label: 'Add to collection…', icon: 'folder-plus', run: () => pickCollection(ids) },
        { label: !many && b.want ? 'Remove from Want to read' : 'Want to read', icon: 'bookmark-plus', run: () => each(x => lib.update(x.id, { want: many ? true : (b.want ? null : true) })) },
        state.route.startsWith('collections/') && { label: 'Remove from this collection', icon: 'x', run: () => removeFromCollection(state.route.split('/')[1], ids) },
        '-',
        !many && { label: 'Edit details…', icon: 'pencil', run: () => editDetails(b.id) },
        { label: many ? `Fetch details and covers online (${ids.length})…` : 'Find details and cover online…', icon: 'globe', run: () => many ? updateMany(ids, 'your selection') : findOnline(b.id) },
        { label: many ? `Re-read details (${ids.length})` : 'Re-read details from file', icon: 'refresh-cw', run: () => { each(x => lib.update(x.id, { metaDone: false, edited: null, genreLooked: null })); importer.runMeta() } },
        !many && { label: 'Show in folder', icon: 'folder', run: () => api.invoke('shell:show', b.path) },
        '-',
        { label: many ? `Remove ${ids.length} from library` : 'Remove from library', icon: 'trash-2', danger: true, run: () => removeBooks(ids) },
    ])
}
async function removeBooks(ids) {
    if (!await confirmBox('Remove from library?', `${ids.length === 1 ? 'This book' : ids.length + ' books'} will be removed from Iqra. The file${ids.length === 1 ? '' : 's'} on your computer will not be deleted.`, 'Remove', true)) return
    db.patch('library', ids.map(id => [['books', id, 'removed'], true]))
    state.selected.clear(); renderSelectionBar()
    toast(`Removed ${ids.length} from library`, { action: { label: 'Undo', run: () => db.patch('library', ids.map(id => [['books', id, 'removed'], null])) } })
}
function pickCollection(ids) {
    const cols = lib.collections
    const addTo = id => {
        const cur = data.library.collections[id].books ?? []
        db.set('library', ['collections', id, 'books'], [...new Set([...cur, ...ids])])
        toast(`Added to “${data.library.collections[id].name}”`)
        state.selected.clear(); renderSelectionBar()
    }
    const m = modal({
        title: 'Add to collection',
        body: h('div.col-list', cols.map(c => h('button.btn.block', { onclick: () => { addTo(c.id); m.close() } }, icon('folder', 16), ' ', c.name, h('small', ` ${c.books?.length ?? 0}`))),
            h('button.btn.block.primary', { onclick: async () => { m.close(); const id = await newCollection(); if (id) addTo(id) } }, icon('plus', 16), ' New collection…')),
    })
}
async function newCollection() {
    const name = (await promptBox('New collection', 'Name'))?.trim()
    if (!name) return null
    const id = uid()
    db.set('library', ['collections', id], { id, name, books: [] })
    return id
}
function removeFromCollection(id, ids) {
    const cur = data.library.collections?.[id]?.books ?? []
    db.set('library', ['collections', id, 'books'], cur.filter(x => !ids.includes(x)))
}

// ---------- details ----------
export function showDetails(id) {
    const b = lib.get(id)
    if (!b) return
    const link = (label, route) => h('a.link', { onclick: () => { m.close(); navigate(route) } }, label)
    const timeRead = Object.values(data.stats.days ?? {}).reduce((s, d) => s + (d.books?.[id] ?? 0), 0)
    const notes = Object.keys(data.annotations[id]?.highlights ?? {}).length
    const m = modal({
        title: '', wide: true, cls: 'details',
        body: h('div.details-grid',
            h('div.big-cover', coverEl(b, false)),
            h('div.info',
                h('h1', b.title),
                h('p.by', b.authors?.length ? b.authors.map((a, i) => [i ? ', ' : '', link(a, `authors/${encodeURIComponent(a)}`)]) : 'Unknown author'),
                b.series ? h('p.series', icon('layers', 14), ' ', link(b.series, `series/${encodeURIComponent(b.series)}`), b.seriesIndex != null ? ` · Book ${b.seriesIndex}` : '') : null,
                h('div.chips', (b.genres ?? []).map(g => h('button.chip', { onclick: () => { m.close(); navigate(`genres/${encodeURIComponent(g)}`) } }, g)),
                    h('span.chip.plain', KIND_LABEL[b.kind] ?? 'Book'), h('span.chip.plain', b.format.toUpperCase()), b.language ? h('span.chip.plain', langName(b.language)) : null, b.year ? h('span.chip.plain', b.year) : null),
                h('div.actions',
                    h('button.btn.primary', { disabled: !!b.missing, onclick: () => { m.close(); openBook(b) } }, icon('book-open', 16), b.progress > 0 && b.progress < 1 ? ` Continue · ${Math.round(b.progress * 100)}%` : ' Read'),
                    select([['unread', 'Unread'], ['reading', 'Reading'], ['finished', 'Finished']], b.status, v => lib.setStatus(id, v)),
                    iconBtn('heart', 'Favorite', e => { lib.update(id, { fav: !lib.get(id).fav }); e.currentTarget.classList.toggle('on') }, b.fav ? 'on' : ''),
                    iconBtn('pencil', 'Edit details', () => { m.close(); editDetails(id) }),
                    iconBtn('globe', 'Find details and cover online', () => { m.close(); findOnline(id) }),
                    iconBtn('folder', 'Show in folder', () => api.invoke('shell:show', b.path))),
                h('div.rating', [1, 2, 3, 4, 5].map(n => h('button', { class: (b.rating ?? 0) >= n ? 'on' : '', title: `${n} star${n > 1 ? 's' : ''}`, onclick: e => {
                    const v = lib.get(id).rating === n ? 0 : n
                    lib.update(id, { rating: v })
                    $$('button', e.currentTarget.parentNode).forEach((x, i) => x.classList.toggle('on', i < v))
                } }, icon('star', 18)))),
                b.description ? h('p.desc', b.description) : null,
                h('dl.facts',
                    h('dt', 'Time read'), h('dd', timeRead ? fmtDuration(timeRead) : 'Not started'),
                    b.lastReadAt ? [h('dt', 'Last read'), h('dd', relTime(b.lastReadAt))] : null,
                    notes ? [h('dt', 'Highlights'), h('dd', String(notes))] : null,
                    b.pages ? [h('dt', 'Pages'), h('dd', String(b.pages))] : null,
                    b.publisher ? [h('dt', 'Publisher'), h('dd', b.publisher)] : null,
                    h('dt', 'Added'), h('dd', fmtDate(b.addedAt)),
                    h('dt', 'File'), h('dd.path', `${b.path} (${fmtSize(b.size)})`),
                    b.missing ? [h('dt', 'Status'), h('dd.warn', 'The file is no longer at this location.')] : null,
                    b.metaError ? [h('dt', 'Note'), h('dd.warn', `Could not read details: ${b.metaError}`)] : null))),
    })
}
function editDetails(id) {
    const b = lib.get(id)
    const f = { title: b.title, author: (b.authors ?? []).join(', '), series: b.series ?? '', seriesIndex: b.seriesIndex ?? '', genres: (b.genres ?? []).join(', '), year: b.year ?? '', language: b.language ?? '', description: b.description ?? '', kind: b.kind, tags: (b.tags ?? []).join(', ') }
    const input = (key, label, props = {}) => h('label.field', h('span', label), h(props.rows ? 'textarea' : 'input', { type: 'text', value: f[key], oninput: e => f[key] = e.target.value, ...props }))
    const coverInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
        const file = coverInput.files[0]
        if (!file) return
        try {
            await api.invoke('cover:save', id, await coverToJpeg(file))
            lib.update(id, { cover: Date.now(), customCover: true })
            toast('Cover updated')
        } catch { toast('That image could not be used', { type: 'error' }) }
    } })
    modal({
        title: 'Edit details', wide: true,
        body: h('div.form-grid', input('title', 'Title'), input('author', 'Author(s), separated by commas'),
            input('series', 'Series'), input('seriesIndex', 'Number in series'),
            h('label.field', h('span', 'Genres, separated by commas'), h('input', { type: 'text', value: f.genres, list: 'genre-list', oninput: e => f.genres = e.target.value }),
                h('datalist', { id: 'genre-list' }, GENRES.map(([g]) => h('option', { value: g })))),
            input('tags', 'Your tags, separated by commas'), input('year', 'Year'), input('language', 'Language code (en, fr…)'),
            h('label.field', h('span', 'Shelf'), select([['book', 'Book'], ['comic', 'Comic'], ['document', 'Document']], f.kind, v => f.kind = v)),
            h('div.field', h('span', 'Cover'), h('button.btn', { onclick: () => coverInput.click() }, icon('image', 16), ' Choose image…'), coverInput),
            input('description', 'Description', { rows: 5, class: 'span2' })),
        actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, run: () => {
            const split = s => s.split(',').map(x => x.trim()).filter(Boolean)
            const authors = split(f.author)
            const idx = parseFloat(f.seriesIndex)
            const edited = { ...(b.edited ?? {}) }, online = { ...(b.online ?? {}) }
            const next = { title: f.title.trim() || b.title, authors, author: authors.join(', '), series: f.series.trim(), seriesIndex: isNaN(idx) ? null : idx, genres: split(f.genres), year: f.year.trim(), language: f.language.trim(), description: f.description.trim(), kind: f.kind, tags: split(f.tags) }
            for (const k of ['title', 'author', 'series', 'seriesIndex', 'genres', 'year', 'language', 'description', 'kind'])
                if (JSON.stringify(next[k]) !== JSON.stringify(b[k] ?? (k === 'genres' ? [] : k === 'seriesIndex' ? null : ''))) { edited[k] = true; delete online[k] }
            lib.update(id, { ...next, edited, online })
            toast('Details saved')
        } }],
    })
}

// ---------- pages ----------
function setHeader(title, count, { search = true, tools = true } = {}) {
    titleEl.textContent = title
    countEl.textContent = count != null ? String(count) : ''
    searchEl.parentNode.hidden = !search
    toolsEl.hidden = !tools
}
// Big shelves (thousands of books) are built in pieces: the first screenful straight away,
// the rest in small batches while the app is idle, so opening a shelf or typing in search
// never freezes the window. flushGrid() finishes the job at once when something needs every card.
const FIRST_BATCH = 160, NEXT_BATCH = 240
let gridFill = null
function flushGrid() { if (gridFill) gridFill.finish() }
function gridOf(books) {
    if (gridFill) { gridFill.cancel(); gridFill = null }
    if (!books.length) return emptyState()
    const list = S.app.view === 'list'
    const make = list ? bookRow : bookCard
    const box = list
        ? h('div.list', h('div.brow.head', h('div.cover'), h('div.c1', 'Title'), h('div.c2', 'Series'), h('div.c3', 'Genre'), h('div.c4', 'Format'), h('div.c5', 'Progress'), h('div.c6', 'Added')))
        : h('div.grid')
    let i = 0
    const add = n => { const end = Math.min(books.length, i + n); const frag = document.createDocumentFragment(); for (; i < end; i++) frag.append(make(books[i])); box.append(frag) }
    add(FIRST_BATCH)
    if (i < books.length) {
        let handle = 0, dead = false
        const idle = window.requestIdleCallback ? cb => requestIdleCallback(cb, { timeout: 120 }) : cb => setTimeout(cb, 16)
        const unidle = window.cancelIdleCallback ?? clearTimeout
        const step = () => { if (dead) return; add(NEXT_BATCH); if (i < books.length) handle = idle(step); else if (gridFill === job) gridFill = null }
        const job = {
            cancel() { dead = true; unidle(handle) },
            finish() { if (dead) return; unidle(handle); add(books.length - i); dead = true; if (gridFill === job) gridFill = null },
        }
        gridFill = job
        handle = idle(step)
    }
    return box
}
function emptyState() {
    const scanning = importer.state.scanning
    if (state.query) return h('div.empty', icon('search', 36), h('h3', 'No matches'), h('p', `Nothing in this shelf matches “${state.query}”.`))
    return h('div.empty', icon('library', 40), h('h3', scanning ? 'Looking for your books…' : 'Nothing here yet'),
        h('p', scanning ? 'Scanning your folders. Books will appear here as they are found.' : 'Add books with the + button, or drag files and folders into this window.'))
}
function renderShelf(route) {
    const [page, ...rest] = route.split('/')
    const arg = decodeURIComponent(rest.join('/'))
    let books = booksForRoute(route).filter(b => matchesQuery(b, state.query))
    if (state.formatFilter) books = books.filter(b => b.format === state.formatFilter)
    const titles = { all: 'All books', everything: 'Everything', favorites: 'Favorites', comics: 'Comics', documents: 'Documents', missing: 'Missing files' }
    let title = titles[page] ?? arg
    if (page === 'status') title = { reading: 'Reading now', unread: 'To read', finished: 'Finished' }[arg]
    if (page === 'authors') title = arg || 'Unknown author'
    if (page === 'genres') title = arg || 'Uncategorized'
    if (page === 'formats') title = arg.toUpperCase()
    if (page === 'collections') title = data.library.collections?.[arg]?.name ?? 'Collection'
    setHeader(title, books.length)
    const sorted = page === 'series' ? sortBooks(books, 'series', 'asc') : page === 'status' && arg === 'reading' ? sortBooks(books, 'read', 'desc') : sortBooks(books)
    const crumb = ['authors', 'series', 'genres'].includes(page)
        ? h('div.crumb', h('a.link', { onclick: () => navigate(page) }, icon('chevron-left', 14), ` All ${page}`))
        : page === 'collections' ? h('div.crumb', h('button.btn.small', { onclick: async () => {
            const name = (await promptBox('Rename collection', 'Name', title))?.trim()
            if (name) db.set('library', ['collections', arg, 'name'], name)
        } }, 'Rename'), h('button.btn.small.danger', { onclick: async () => {
            if (await confirmBox('Delete collection?', 'The books stay in your library.', 'Delete', true)) { db.set('library', ['collections', arg], null); navigate('all') }
        } }, 'Delete')) : null
    contentEl.replaceChildren(crumb ?? '', gridOf(sorted))
}
function renderFacets(type) {
    const map = facet(type)
    let entries = [...map.entries()].filter(([name]) => !state.query || name.toLowerCase().includes(state.query.toLowerCase()))
    const order = data.settings.app?.[`facetSort_${type}`] ?? (type === 'genres' ? 'count' : 'name')
    entries.sort((a, b) => {
        if (!a[0]) return 1
        if (!b[0]) return -1
        if (order === 'count') return b[1].length - a[1].length || a[0].localeCompare(b[0])
        return type === 'authors' ? authorSort(a[0]).localeCompare(authorSort(b[0])) : titleSort(a[0]).localeCompare(titleSort(b[0]))
    })
    setHeader({ authors: 'Authors', series: 'Series', genres: 'Genres' }[type], entries.length, { tools: false })
    const bar = h('div.crumb', h('span.muted', 'Sorted automatically from your books’ details. '),
        h('button.btn.small', { onclick: () => { S.setApp(`facetSort_${type}`, order === 'count' ? 'name' : 'count'); render() } }, icon('arrow-up-down', 14), order === 'count' ? ' Most books first' : ' A to Z'))
    if (!entries.length) return contentEl.replaceChildren(bar, emptyState())
    contentEl.replaceChildren(bar, h('div.facets', { class: type }, entries.map(([name, books]) => {
        const sorted = type === 'series' ? sortBooks(books, 'series', 'asc') : sortBooks(books, 'added', 'desc')
        const label = name || (type === 'authors' ? 'Unknown author' : 'Uncategorized')
        const done = books.filter(b => b.status === 'finished').length
        return h('button.facet', { onclick: () => navigate(`${type}/${encodeURIComponent(name)}`), title: label },
            h('div.stack', sorted.slice(0, 3).reverse().map(b => h('div.cover', coverEl(b)))),
            h('div.fname', label),
            h('div.fcount', `${books.length} ${books.length === 1 ? 'book' : 'books'}${type === 'series' && done ? ` · ${done} read` : ''}`))
    })))
}
function shelfRow(title, books, route, big) {
    if (!books.length) return null
    return h('section.shelf', h('header', h('h2', title), route ? h('a.link', { onclick: () => navigate(route) }, 'See all') : null),
        h('div.rowscroll', { class: big ? 'big' : '' }, books.map(b => big ? continueCard(b) : bookCard(b))))
}
function continueCard(b) {
    const pct = Math.round((b.progress ?? 0) * 100)
    return h('div.continue', { dataset: { id: b.id }, onclick: () => openBook(b), oncontextmenu: e => { e.preventDefault(); bookMenu(e.clientX, e.clientY, b) } },
        h('div.cover', coverEl(b, false)),
        h('div.cinfo', h('div.t', b.title), h('div.a', b.author || ''),
            h('div.bar', h('i', { style: { width: pct + '%' } })),
            h('div.sub', `${pct}% · ${relTime(b.lastReadAt)}`),
            h('button.btn.primary.small', icon('book-open', 14), ' Continue')))
}
function renderHome() {
    setHeader('Home', null, { tools: false })
    const books = lib.books
    const reading = sortBooks(books.filter(b => b.status === 'reading'), 'read', 'desc').slice(0, 8)
    const recent = sortBooks(books.filter(b => b.kind !== 'document'), 'added', 'desc').slice(0, 18)
    // next unread book in a series you have started
    const upNext = []
    for (const [, list] of facet('series', books)) {
        const sorted = sortBooks(list, 'series', 'asc')
        const lastDone = sorted.findLastIndex(b => b.status === 'finished')
        const next = sorted[lastDone + 1]
        if (lastDone >= 0 && next && next.status === 'unread') upNext.push(next)
    }
    const unread = books.filter(b => b.status === 'unread' && b.kind === 'book')
    const seed = Number(dayKey().replace(/-/g, ''))
    const picks = unread.map((b, i) => [(parseInt(hashStr(b.id + seed).slice(0, 5), 36) + i) % 9973, b]).sort((a, b) => a[0] - b[0]).slice(0, 12).map(x => x[1])
    const t = todayStats(), goal = S.goals.dailyMinutes, mins = Math.floor(t.sec / 60)
    const pct = Math.min(1, mins / Math.max(1, goal))
    const hr = new Date().getHours()
    const year = String(new Date().getFullYear())
    const finishedThisYear = Object.values(data.stats.finished ?? {}).filter(d => d.startsWith(year)).length
    const now = new Date()
    const hero = h('section.hero', { dataset: { day: now.toLocaleDateString('en-GB', { weekday: 'long' }).toUpperCase(), date: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase(), time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) } },
        h('div.hello', h('h1', hr < 5 ? 'Reading late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'),
            h('p', books.length ? `${books.filter(b => b.kind !== 'document').length} books in your library · ${books.filter(b => b.status === 'finished').length} finished` : 'Your library is empty. Add some books to get started.')),
        h('div.goal', { onclick: () => navigate('stats'), title: 'Open reading stats' },
            h('div.ring', { style: { '--p': pct } }, h('b', String(mins)), h('small', `of ${goal} min`)),
            h('div.stamp', h('small', 'streak'), h('b', `${streak()} day${streak() === 1 ? '' : 's'}`), h('small', new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))),
            h('div', h('div.gl', pct >= 1 ? 'Daily goal reached' : 'Today’s reading'), h('div.gs', icon('flame', 14), ` ${streak()} day streak`), h('div.gs', icon('trophy', 14), ` ${finishedThisYear} of ${S.goals.yearlyBooks} books this year`),
                dueCards().length || dueWords().length ? h('a.gs.link', { onclick: e => { e.stopPropagation(); navigate(dueCards().length ? 'review' : 'words') } }, icon('layers', 14), ` ${dueCards().length + dueWords().length} to review today`) : null)))
    const st = importer.state
    contentEl.replaceChildren(hero,
        !books.length ? emptyState() : '',
        shelfRow('Continue reading', reading, 'status/reading', true) ?? '',
        shelfRow('Next in your series', upNext.slice(0, 12), 'series') ?? '',
        shelfRow('Recently added', recent, 'all') ?? '',
        shelfRow('Pick something new', picks, 'status/unread') ?? '',
        st.metaRunning ? h('p.muted.center', `Reading book details: ${st.metaDone} of ${st.metaTotal}. Covers and sorting improve as this finishes.`) : '')
}

// ---------- sidebar ----------
function renderSidebar() {
    const books = lib.books
    const count = fn => books.filter(fn).length
    const item = (route, label, ic, n) => h('a.nav', { class: state.route === route || (route !== 'home' && state.route.startsWith(route + '/')) ? 'on' : '', onclick: () => navigate(route), title: label },
        icon(ic, 17), h('span', label), n != null ? h('small', String(n)) : null)
    const st = importer.state
    sidebarEl.replaceChildren(
        h('div.brand', h('img', { src: 'img/logo.svg', alt: '' }), h('b', 'Iqra')),
        h('nav',
            item('home', 'Home', 'house'),
            h('div.navhead', 'Library'),
            item('all', 'All books', 'library', count(b => b.kind !== 'document')),
            item('status/reading', 'Reading now', 'book-open', count(b => b.status === 'reading')),
            item('status/unread', 'To read', 'bookmark', count(b => b.status === 'unread' && b.kind !== 'document')),
            item('status/finished', 'Finished', 'circle-check', count(b => b.status === 'finished')),
            item('favorites', 'Favorites', 'heart', count(b => b.fav)),
            h('div.navhead', 'Study'),
            item('review', 'Review', 'layers', dueCards().length || null),
            item('words', 'My words', 'whole-word', Object.keys(data.study.words ?? {}).length || null),
            item('wishlist', 'Want to read', 'bookmark-plus', wishCount() || null),
            h('div.navhead', 'Sorted for you'),
            item('authors', 'Authors', 'users', facet('authors', books).size),
            item('series', 'Series', 'layers', facet('series', books).size),
            item('genres', 'Genres', 'tags', facet('genres', books).size),
            item('comics', 'Comics', 'image', count(b => b.kind === 'comic')),
            item('documents', 'Documents', 'file-text', count(b => b.kind === 'document')),
            count(b => b.missing) ? item('missing', 'Missing files', 'info', count(b => b.missing)) : null,
            h('div.navhead', 'Collections', h('button.mini', { title: 'New collection', onclick: async () => { const id = await newCollection(); if (id) navigate(`collections/${id}`) } }, icon('plus', 14))),
            lib.collections.map(c => item(`collections/${c.id}`, c.name, 'folder', c.books?.length ?? 0))),
        h('div.side-foot',
            st.scanning || st.metaRunning ? h('div.progress', h('div.pl', st.scanning ? 'Scanning folders…' : `Reading details ${st.metaDone}/${st.metaTotal}`),
                h('div.bar', h('i', { style: { width: st.scanning ? '15%' : `${(st.metaDone / Math.max(1, st.metaTotal)) * 100}%` } }))) : null,
            h('a.nav', { onclick: e => focus.panel(e.currentTarget), title: 'Focus session and sounds' }, icon('timer', 17), h('span', 'Focus & sounds')),
            item('discover', 'Free books', 'compass'),
            item('stats', 'Reading stats', 'chart-column'),
            item('settings', 'Settings', 'settings')))
}

// ---------- selection bar ----------
function renderSelectionBar() {
    let bar = $('#selbar')
    if (!state.selected.size) return bar?.remove()
    if (!bar) { bar = h('div', { id: 'selbar' }); $('#main').append(bar) }
    const ids = [...state.selected]
    bar.replaceChildren(h('b', `${ids.length} selected`),
        h('button.btn.small', { onclick: () => ids.forEach(id => lib.setStatus(id, 'finished')) }, 'Finished'),
        h('button.btn.small', { onclick: () => ids.forEach(id => lib.setStatus(id, 'unread')) }, 'Unread'),
        h('button.btn.small', { onclick: () => pickCollection(ids) }, 'Add to collection'),
        h('button.btn.small', { onclick: () => updateMany(ids, 'your selection') }, 'Fetch details'),
        h('button.btn.small.danger', { onclick: () => removeBooks(ids) }, 'Remove'),
        h('button.btn.small', { onclick: () => { state.selected.clear(); renderSelectionBar(); $$('.selected').forEach(e => e.classList.remove('selected')) } }, 'Clear'))
}

// ---------- shell ----------
export function initLibrary({ nav, pages }) {
    navigate = nav
    sidebarEl = $('#sidebar'); contentEl = $('#content')
    titleEl = h('h1'); countEl = h('span.count')
    searchEl = h('input', { type: 'search', placeholder: 'Search title, author, series, genre…', oninput: debounce(() => {
        state.query = searchEl.value.trim()
        const page = state.route.split('/')[0]
        // searching from Home (or Stats, Settings…) searches the whole library
        if (state.query && (page === 'home' || state.pages[page])) { state.keepQuery = true; return navigate('everything') }
        render()
    }, 160) })
    addEventListener('keydown', e => {
        if ($('#app').hidden || $('.modal-back')) return
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select() }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); addFilesDialog() }
        else if (e.key === 'Escape' && state.selected.size) { state.selected.clear(); render(true) }
    })
    toolsEl = h('div.tools',
        iconBtn('arrow-up-down', 'Sort', e => menuAt(e.currentTarget, [
            ...Object.entries(SORTS).map(([k, label]) => ({ label, checked: S.app.sort === k, icon: S.app.sort === k ? 'check' : null, run: () => { S.setApp('sort', k); render() } })),
            '-', { label: S.app.sortDir === 'desc' ? 'Descending (newest / Z first)' : 'Ascending (oldest / A first)', icon: 'arrow-up-down', run: () => { S.setApp('sortDir', S.app.sortDir === 'desc' ? 'asc' : 'desc'); render() } },
        ])),
        iconBtn('filter', 'Filter by format', e => menuAt(e.currentTarget, [
            { label: 'All formats', icon: !state.formatFilter ? 'check' : null, run: () => { state.formatFilter = ''; render() } }, '-',
            ...[...facet('formats').entries()].sort((a, b) => b[1].length - a[1].length).map(([f, list]) => ({ label: `${f.toUpperCase()}  (${list.length})`, icon: state.formatFilter === f ? 'check' : null, run: () => { state.formatFilter = f; render() } })),
        ])),
        iconBtn('layout-grid', 'Grid or list', () => { S.setApp('view', S.app.view === 'grid' ? 'list' : 'grid'); render() }),
        h('input.size', { type: 'range', min: 90, max: 260, value: S.app.coverSize, title: 'Cover size', oninput: e => { document.documentElement.style.setProperty('--cover-w', e.target.value + 'px'); saveSize(+e.target.value) } }))
    const saveSize = debounce(v => S.setApp('coverSize', v), 400)
    const fetchAll = () => updateMany(lib.books.filter(b => !b.removed).map(b => b.id))
    const onlineBtn = h('button.btn', { title: 'Fetch the latest details and covers for your books', onclick: fetchAll }, icon('globe', 16), ' Details & covers')
    const addBtn = h('button.btn.primary', { onclick: e => menuAt(e.currentTarget, [
        { label: 'Add files…', icon: 'file-text', run: addFilesDialog },
        { label: 'Add a folder…', icon: 'folder-plus', run: addFolderDialog },
        { label: 'Fetch details and covers online…', icon: 'globe', run: fetchAll },
        { label: 'Scan my folders now', icon: 'refresh-cw', run: async () => { const added = await importer.scan(); toast(added.length ? `Found ${added.length} new book${added.length === 1 ? '' : 's'}` : 'No new books found') } },
    ]) }, icon('plus', 16), ' Add')
    $('#topbar').replaceChildren(
        iconBtn('panel-left', 'Show or hide sidebar', () => { const c = !S.app.sidebarCollapsed; S.setApp('sidebarCollapsed', c); document.body.classList.toggle('side-collapsed', c) }),
        h('div.title', titleEl, countEl), h('div.search', icon('search', 16), searchEl), toolsEl, onlineBtn, addBtn)
    document.body.classList.toggle('side-collapsed', !!S.app.sidebarCollapsed)
    state.pages = pages

    let softTimer = null
    const softRender = () => { softTimer ??= setTimeout(() => { softTimer = null; if (!$('#app').hidden && !document.querySelector('.modal-back, .menu')) render(true) }, importer.state.metaRunning ? 6000 : 700) }
    const sideRender = debounce(renderSidebar, 500)
    db.onChange((name, ops) => {
        if (name === 'library') {
            sideRender()
            if ($('#app').hidden) return
            // patch visible cards in place where possible; rebuild lazily otherwise
            const ids = new Set()
            let structural = !ops
            for (const [p] of ops ?? []) { if (p[0] === 'books' && p.length >= 2) { ids.add(p[1]); if (p.length === 2 || ['removed', 'kind', 'status', 'series', 'authors', 'genres'].includes(p[2])) structural = true } else structural = true }
            for (const id of ids) {
                const b = lib.get(id)
                if (!b || b.removed) continue
                $$(`.book[data-id="${id}"]`, contentEl).forEach(el => el.replaceWith(bookCard(b)))
                $$(`.brow[data-id="${id}"]`, contentEl).forEach(el => el.replaceWith(bookRow(b)))
            }
            if (structural) softRender()
        } else if (name === 'settings' && !ops) render()
        else if (name === 'study' && (!ops || ops.some(([p]) => ['cards', 'words', 'wishlist'].includes(p[0])))) sideRender()
    })
    importer.onProgress(debounce(() => { renderSidebar() }, 300))

    // drag & drop files or folders anywhere
    addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging') })
    addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging') })
    addEventListener('drop', async e => {
        e.preventDefault(); document.body.classList.remove('dragging')
        const paths = Array.from(e.dataTransfer.files).map(f => api.pathForFile(f)).filter(Boolean)
        if (paths.length) addPathsAndReport(paths)
    })
}
export async function addPathsAndReport(paths, openFirst) {
    const { added, files } = await importer.addPaths(paths)
    if (!files.length) return toast('No supported books in what you added', { type: 'error' })
    toast(added.length ? `Added ${added.length} book${added.length === 1 ? '' : 's'}` : 'Already in your library')
    if (openFirst || files.length === 1) {
        const b = lib.books.find(x => x.path.toLowerCase() === files[0].path.toLowerCase())
        if (b && (openFirst || added.length === 1)) openBook(b)
    }
}
async function addFilesDialog() {
    const exts = [...appInfo.bookExt, ...appInfo.docExt]
    const paths = await api.invoke('dialog:open', { title: 'Add books', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Books and documents', extensions: exts }, { name: 'All files', extensions: ['*'] }] })
    if (paths.length) addPathsAndReport(paths)
}
async function addFolderDialog() {
    const paths = await api.invoke('dialog:open', { title: 'Add a folder of books', properties: ['openDirectory'] })
    if (!paths.length) return
    const watch = await confirmBox('Keep watching this folder?', 'Iqra can check this folder for new books every time it starts.', 'Yes, watch it')
    if (watch) S.setApp('folders', [...new Set([...importer.folders(), ...paths])])
    addPathsAndReport(paths)
}

export function render(keepScroll) {
    const route = state.route
    const scroller = $('#content')
    const top = keepScroll ? scroller.scrollTop : (state.scrollMemo[route] ?? 0)
    renderSidebar()
    if (gridFill) { gridFill.cancel(); gridFill = null }
    const [page] = route.split('/')
    const hasArg = route.includes('/')
    if (page === 'home') renderHome()
    else if (['authors', 'series', 'genres'].includes(page) && !hasArg) renderFacets(page)
    else if (state.pages[page]) { setHeader(state.pages[page].title, null, { search: false, tools: false }); state.pages[page].render(contentEl) }
    else renderShelf(route)
    // coming back to a spot far down the shelf: build the rest now so the scroll lands in the right place
    if (top > 0 && scroller.scrollHeight < top + scroller.clientHeight * 2) flushGrid()
    scroller.scrollTop = top
    renderSelectionBar()
}
export function showRoute(route) {
    if (state.route !== route) {
        state.scrollMemo[state.route] = $('#content').scrollTop
        if (state.keepQuery) state.keepQuery = false
        else { state.query = ''; if (searchEl) searchEl.value = '' }
        state.selected.clear()
    }
    const back = state.route === route
    state.route = route
    render(back)
}
