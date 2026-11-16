// Settings page and the free-books page
import { h, $, icon, iconBtn, toast, confirmBox, segmented, slider, toggle, row, select, debounce, fmtSize } from './ui.js'
import { data, db } from './db.js'
import { lib, importer, appInfo } from './store.js'
import { S, PALETTES, ACCENTS, BUNDLED_FONTS, KEY_ACTIONS, DEFAULT_KEYS, readerControls, applyAppTheme, fontChoices } from './settings.js'

const api = window.api
let settingsTab = 'look'

export function renderSettings(el) {
    const a = S.app
    const set = (k, v) => { S.setApp(k, v); applyAppTheme() }
    const tabs = [['look', 'Appearance'], ['library', 'Library'], ['reading', 'Reading'], ['keys', 'Shortcuts'], ['data', 'Backup and data']]
    const redraw = () => renderSettings(el)
    const panes = {
        look: () => {
            const fontSel = h('select', { onchange: () => set('uiFont', fontSel.value) }, BUNDLED_FONTS.map(([n]) => h('option', { value: n, selected: n === a.uiFont }, n)))
            fontChoices().then(list => fontSel.append(...list.filter(n => !BUNDLED_FONTS.some(f => f[0] === n)).map(n => h('option', { value: n, selected: n === a.uiFont }, n))))
            return [
                row('Style', segmented([['riso', 'Riso print'], ['classic', 'Classic']], a.style, v => { set('style', v); redraw() }), a.style === 'riso' ? 'Two-ink print, library cards and stamps. Night print in dark mode.' : 'The original clean look, with your own colors'),
                row('Mode', segmented([['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']], a.mode, v => set('mode', v))),
                a.style === 'riso' ? null : row('Color mood', segmented(Object.entries(PALETTES).map(([id, p]) => [id, p.name]), a.palette, v => set('palette', v))),
                a.style === 'riso' ? null : row('Accent color', h('div.swatches', ACCENTS.map(c => h('button', { class: c === a.accent ? 'on' : '', style: { background: c }, onclick: () => { set('accent', c); redraw() } })),
                    h('input', { type: 'color', value: a.accent, title: 'Any color', oninput: e => set('accent', e.target.value) }))),
                a.style === 'riso' ? null : row('Pure black in dark mode', toggle(a.amoled, v => set('amoled', v)), 'Good for OLED screens'),
                row('App font', fontSel),
                row('App size', slider({ min: 80, max: 140, step: 5, value: a.uiScale, onchange: v => set('uiScale', v), fmt: v => v + ' %' })),
                row('Cover size', slider({ min: 90, max: 260, step: 2, value: a.coverSize, onchange: v => set('coverSize', v), fmt: v => v + ' px' })),
                row('Cover corners', slider({ min: 0, max: 18, value: a.coverRadius, onchange: v => set('coverRadius', v), fmt: v => v + ' px' })),
                row('Show titles under covers', toggle(a.showTitles, v => set('showTitles', v))),
                row('Start on', select([['home', 'Home'], ['all', 'All books'], ['status/reading', 'Reading now'], ['authors', 'Authors'], ['series', 'Series'], ['genres', 'Genres']], a.landing, v => set('landing', v))),
                h('label.field', h('span', 'Your own CSS for the app (advanced)'),
                    h('textarea', { rows: 5, spellcheck: false, placeholder: '.book .t { font-family: Georgia }', value: a.customCSS, oninput: debounce(e => set('customCSS', e.target.value), 400) })),
            ]
        },
        library: () => {
            const folders = importer.folders()
            return [
                h('h3', 'Folders Iqra watches'),
                h('p.muted', 'Books stay where they are; Iqra reads them in place and never moves or deletes your files. New books in these folders are added automatically.'),
                h('div.folders', folders.map(f => h('div.folder', icon('folder', 16), h('span', f), iconBtn('x', 'Stop watching', () => { S.setApp('folders', folders.filter(x => x !== f)); redraw() })))),
                h('div.btnrow', h('button.btn', { onclick: async () => {
                    const p = await api.invoke('dialog:open', { title: 'Watch a folder', properties: ['openDirectory'] })
                    if (p.length) { S.setApp('folders', [...new Set([...folders, ...p])]); redraw(); importer.scan() }
                } }, icon('folder-plus', 16), ' Add folder'),
                h('button.btn', { onclick: async () => { const added = await importer.scan(); toast(added.length ? `Found ${added.length} new books` : 'No new books found') } }, icon('refresh-cw', 16), ' Scan now')),
                row('Scan for new books when Iqra starts', toggle(a.scanOnStart, v => set('scanOnStart', v))),
                row('Look up missing genres online', toggle(a.lookupGenres, v => { set('lookupGenres', v); if (v) importer.runGenres() }), 'Sends only the title and author to openlibrary.org'),
                h('h3', 'Sorting'),
                h('p.muted', 'Authors, series and genres are worked out from each book’s own details, then from its file name, then (for genres) from Open Library. You can always correct a book with right-click → Edit details; your edits are never overwritten.'),
                h('div.btnrow', h('button.btn', { onclick: async () => {
                    if (!await confirmBox('Re-read every book?', 'This re-reads titles, authors, covers and genres from all files. Your own edits are kept.', 'Re-read')) return
                    db.patch('library', lib.books.map(b => [['books', b.id, 'metaDone'], false]))
                    importer.runMeta()
                } }, 'Re-read details for all books'),
                h('button.btn', { onclick: () => {
                    const gone = lib.books.filter(b => b.missing)
                    db.patch('library', gone.map(b => [['books', b.id, 'removed'], true]))
                    toast(gone.length ? `Removed ${gone.length} missing books` : 'No missing files')
                } }, 'Remove books whose files are gone')),
            ]
        },
        reading: () => [h('p.muted', 'These are the defaults for every book. Inside a book, press S to change them on the spot or to give that one book its own settings.'),
            readerControls(() => S.reader, (k, v) => S.setReader(k, v))],
        keys: () => {
            const keys = S.keys
            const label = k => k.replace(' ', 'Space').replace('Arrow', '').replace('+', ' + ')
            return [h('p.muted', 'Click a shortcut to remove it, or Add to record a new one. These work while reading.'),
                h('div.keys', Object.entries(KEY_ACTIONS).map(([action, name]) => h('div.keyrow', h('span', name),
                    h('div', (keys[action] ?? []).map(k => h('kbd', { title: 'Click to remove', onclick: () => { db.set('settings', ['keys', action], keys[action].filter(x => x !== k)); redraw() } }, label(k))),
                        h('button.btn.small', { onclick: e => {
                            const btn = e.currentTarget
                            btn.textContent = 'Press a key…'
                            const onKey = ev => {
                                ev.preventDefault(); ev.stopPropagation()
                                if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) return
                                document.removeEventListener('keydown', onKey, true)
                                const k = (ev.ctrlKey || ev.metaKey ? 'Ctrl+' : '') + (ev.altKey ? 'Alt+' : '') + (ev.shiftKey && (ev.key.length > 1 || ev.key === ' ') ? 'Shift+' : '') + (ev.key.length === 1 ? ev.key.toLowerCase() : ev.key)
                                const ops = Object.keys(KEY_ACTIONS).filter(x => x !== action && keys[x]?.includes(k)).map(x => [['keys', x], keys[x].filter(y => y !== k)])
                                db.patch('settings', [...ops, [['keys', action], [...new Set([...(keys[action] ?? []), k])]]])
                                redraw()
                            }
                            document.addEventListener('keydown', onKey, true)
                        } }, 'Add'))))),
                h('div.btnrow', h('button.btn', { onclick: () => { db.set('settings', ['keys'], structuredClone(DEFAULT_KEYS)); redraw() } }, 'Reset all shortcuts'))]
        },
        data: () => {
            const books = lib.books
            const size = books.reduce((s, b) => s + b.size, 0)
            return [
                h('p.muted', `${books.length} items in your library (${fmtSize(size)} on disk). Iqra keeps its own data (reading positions, highlights, stats, settings, covers) in: ${appInfo.userData}`),
                h('div.btnrow',
                    h('button.btn', { onclick: async () => {
                        const payload = JSON.stringify({ iqraBackup: 1, date: new Date().toISOString(), ...data })
                        const p = await api.invoke('dialog:save', { title: 'Save backup', defaultPath: `iqra-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Iqra backup', extensions: ['json'] }] }, payload)
                        if (p) toast('Backup saved')
                    } }, icon('download', 16), ' Back up everything'),
                    h('button.btn', { onclick: async () => {
                        const p = await api.invoke('dialog:open', { title: 'Restore backup', properties: ['openFile'], filters: [{ name: 'Iqra backup', extensions: ['json'] }] })
                        if (!p.length) return
                        try {
                            const obj = JSON.parse(await api.invoke('file:readText', p[0]))
                            if (!obj.iqraBackup && !obj.inkwellBackup) throw new Error('not a backup')
                            if (!await confirmBox('Restore this backup?', 'Your current library data, highlights, stats and settings will be replaced.', 'Restore', true)) return
                            for (const name of ['library', 'settings', 'annotations', 'stats']) if (obj[name]) db.replace(name, obj[name])
                            applyAppTheme(); toast('Backup restored'); importer.runMeta()
                        } catch { toast('That file is not an Iqra backup', { type: 'error' }) }
                    } }, icon('upload', 16), ' Restore a backup'),
                    h('button.btn', { onclick: async () => {
                        let md = '# All highlights\n'
                        for (const [id, a] of Object.entries(data.annotations)) {
                            const list = Object.values(a.highlights ?? {}), b = lib.get(id)
                            if (!list.length || !b) continue
                            md += `\n## ${b.title}${b.author ? ' - ' + b.author : ''}\n\n` + list.map(x => `> ${x.text.replace(/\n+/g, ' ')}\n${x.note ? '\n' + x.note + '\n' : ''}`).join('\n')
                        }
                        const p = await api.invoke('dialog:save', { title: 'Export all highlights', defaultPath: 'iqra-highlights.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }, md)
                        if (p) toast('Highlights exported')
                    } }, icon('quote', 16), ' Export all highlights'),
                    h('button.btn', { onclick: async () => { await api.invoke('cache:clear'); toast('Temporary files cleared') } }, 'Clear temporary files')),
                h('h3', 'About'),
                h('p.muted', `Iqra ${appInfo.version}. Made by PK. Reading engine: foliate-js (MIT). PDF: PDF.js (Apache 2.0). DjVu: djvu-rs (MIT). Icons: Lucide (ISC).`),
                h('p.muted', 'Opens EPUB, PDF, MOBI, AZW, AZW3, FB2, FBZ, CBZ, CBR, CB7, CBT, DjVu, TXT, Markdown, HTML, DOCX, DOC, ODT and RTF. Books bought with copy protection (DRM) from Kindle, Kobo or Google Play can only be opened in those stores’ own apps.'),
            ]
        },
    }
    el.replaceChildren(h('div.settings-page',
        h('div.seg.tabs.big', tabs.map(([id, label]) => h('button', { class: id === settingsTab ? 'on' : '', onclick: () => { settingsTab = id; redraw() } }, label))),
        h('div.pane', panes[settingsTab]())))
}

// ---------- free books from Project Gutenberg ----------
const disc = { query: '', lang: 'en', topic: '', results: null, loading: false, next: null }
export function renderDiscover(el) {
    const list = h('div.grid.disc')
    const status = h('p.muted')
    const folder = () => S.app.downloadFolder || `${importer.folders()[0] ?? appInfo.home}${appInfo.platform === 'win32' ? '\\' : '/'}Iqra Books`
    const load = async more => {
        if (disc.loading) return
        disc.loading = true
        status.textContent = 'Loading…'
        const q = new URLSearchParams({ languages: disc.lang })
        if (disc.query) q.set('search', disc.query)
        if (disc.topic) q.set('topic', disc.topic)
        const url = more && disc.next ? disc.next : `https://gutendex.com/books/?${q}`
        const res = await api.invoke('net:fetch', url, { timeout: 25000 })
        disc.loading = false
        if (!res.ok) { status.textContent = 'Could not reach Project Gutenberg. Check your internet connection and try again.'; return }
        const json = JSON.parse(res.text)
        disc.next = json.next
        disc.results = more ? [...(disc.results ?? []), ...json.results] : json.results
        draw()
    }
    const draw = () => {
        const have = new Set(lib.books.map(b => b.title.toLowerCase()))
        list.replaceChildren(...(disc.results ?? []).map(bk => {
            const epub = bk.formats['application/epub+zip']
            const cover = bk.formats['image/jpeg']
            const author = (bk.authors ?? []).map(a => a.name.split(', ').reverse().join(' ')).join(', ')
            const owned = have.has(bk.title.toLowerCase())
            const btn = h('button.btn.small', { class: owned ? '' : 'primary', disabled: !epub || owned, onclick: async () => {
                btn.disabled = true; btn.textContent = 'Downloading…'
                try {
                    const f = await api.invoke('download', epub, folder(), `${bk.title.slice(0, 90)} - ${author.slice(0, 40) || 'Unknown'}.epub`)
                    await importer.addPaths([f.path])
                    btn.textContent = 'In your library'
                    toast(`Added “${bk.title}”`)
                } catch (e) { btn.disabled = false; btn.textContent = 'Try again'; toast('Download failed', { type: 'error' }) }
            } }, owned ? 'In your library' : epub ? 'Get book' : 'No EPUB')
            return h('div.book.disc', h('div.cover', cover ? h('img', { src: cover, loading: 'lazy', alt: '' }) : h('div.gen-cover', { style: { '--h': bk.id % 360 } }, h('span.gt', bk.title))),
                h('div.meta', h('div.t', { title: bk.title }, bk.title), h('div.a', author || 'Unknown'), btn))
        }))
        status.textContent = disc.results?.length ? '' : 'No books found.'
        moreBtn.hidden = !disc.next
    }
    const moreBtn = h('button.btn', { hidden: true, onclick: () => load(true) }, 'Show more')
    const input = h('input', { type: 'search', placeholder: 'Search 70,000+ free classics by title or author…', value: disc.query, onkeydown: e => { if (e.key === 'Enter') { disc.query = input.value.trim(); load() } } })
    const topics = ['', 'Adventure', 'Science Fiction', 'Fantasy', 'Mystery', 'Romance', 'Philosophy', 'History', 'Science', 'Poetry', 'Children']
    el.replaceChildren(h('div.discover',
        h('p.muted', 'Free, legal books from Project Gutenberg (public-domain classics). Downloads are saved to ', h('code', folder()), ' and added to your library.'),
        h('div.disc-bar', h('div.search', icon('search', 16), input),
            select([['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian']], disc.lang, v => { disc.lang = v; load() }),
            select(topics.map(t => [t.toLowerCase(), t || 'Any topic']), disc.topic, v => { disc.topic = v; load() })),
        status, list, h('div.center', moreBtn)))
    if (disc.results) draw(); else load()
}
