// Iqra - bootstraps the app and routes between the library and the reader
import { db, data } from './db.js'
import { $, h, toast, modal, icon } from './ui.js'
import { S, applyAppTheme } from './settings.js'
import { lib, importer, setAppInfo, appInfo } from './store.js'
import { initLibrary, showRoute, addPathsAndReport } from './library.js'
import { openReader, closeReader, readerOpen } from './reader.js'
import { renderStats } from './stats.js'
import { renderSettings, renderDiscover } from './pages.js'
import { initStudy, renderReview, renderWords, renderWishlist } from './study.js'
import { openBook } from './library.js'
import { focus, ambient } from './focus.js'

const api = window.api
const readerOnly = location.hash.startsWith('#/read/')
let lastLibRoute = null

const navigate = route => { location.hash = '#/' + route }
async function onRoute() {
    const route = decodeURI(location.hash.replace(/^#\/?/, '')) || S.app.landing || 'home'
    if (route.startsWith('read/')) {
        const id = route.slice(5)
        if (!lib.get(id)) { toast('That book is not in the library any more', { type: 'error' }); return navigate(lastLibRoute ?? 'home') }
        $('#app').hidden = true
        await openReader(id, () => readerOnly ? api.invoke('win:close') : navigate(lastLibRoute ?? 'home'))
    } else {
        if (readerOpen()) await closeReader()
        $('#app').hidden = false
        lastLibRoute = route
        showRoute(route)
    }
}

function welcome(folders) {
    modal({
        title: 'Welcome to Iqra',
        body: h('div.welcome',
            h('p', 'Iqra is now looking for books in these folders:'),
            h('ul', folders.map(f => h('li', f))),
            h('p', 'Your files stay exactly where they are. Books appear in the library right away, and covers, authors, series and genres fill in over the next few minutes while Iqra reads each file.'),
            h('p.muted', 'Tips: drag files or folders into the window to add more, right-click any book for options, and press S while reading to change how the page looks.')),
        actions: [{ label: 'Start reading', primary: true }],
    })
}

async function boot() {
    await db.init()
    const info = await api.invoke('app:info')
    setAppInfo(info)
    applyAppTheme()
    db.onChange((name, ops) => { if (name === 'settings' && (!ops || ops.some(([p]) => p[0] === 'app' || p[0] === 'themes'))) applyAppTheme() })
    initLibrary({ nav: navigate, pages: {
        stats: { title: 'Reading stats', render: renderStats },
        settings: { title: 'Settings', render: renderSettings },
        discover: { title: 'Free books', render: renderDiscover },
        review: { title: 'Review', render: renderReview },
        words: { title: 'My words', render: renderWords },
        wishlist: { title: 'Want to read', render: renderWishlist },
    } })
    initStudy({ nav: navigate, openBook })
    addEventListener('hashchange', onRoute)
    await onRoute()
    document.body.classList.add('ready')
    if (readerOnly || !info.isMain) return
    api.on('open-files', files => addPathsAndReport(files, true))
    if (info.openFiles?.length) addPathsAndReport(info.openFiles, true)
    if (info.test) S.setApp('folders', [info.test + '/books'])
    const first = !data.settings.firstRunDone
    if (first) {
        db.set('settings', ['firstRunDone'], true)
        if (!info.test) welcome(importer.folders())
    }
    if (first || S.app.scanOnStart) importer.scan().then(added => { if (!first && added.length) toast(`Found ${added.length} new book${added.length === 1 ? '' : 's'}`) })
    else importer.runMeta()
    if (info.test) import('./selftest.js').then(m => m.run(info.test)).catch(e => api.invoke('test:done', { fatal: String(e?.stack ?? e) }))
}
addEventListener('error', e => console.error('window error', e.message, e.filename, e.lineno))
addEventListener('unhandledrejection', e => console.error('unhandled', e.reason?.stack ?? e.reason))
boot().catch(e => {
    console.error(e)
    document.body.append(h('pre', { style: { padding: '40px', whiteSpace: 'pre-wrap' } }, `Iqra could not start:\n${e?.stack ?? e}`))
})
