// Settings: defaults, access helpers, app theming, and the shared reading controls.
import { data, db } from './db.js'
import { h, segmented, slider, toggle, row, select, icon, uid, modal, toast } from './ui.js'

export const READER_THEMES = [
    { id: 'paper', name: 'Paper', bg: '#fbf7ef', fg: '#2b2620', link: '#a4542a' },
    { id: 'white', name: 'White', bg: '#ffffff', fg: '#1b1b1b', link: '#1a5fb4' },
    { id: 'sepia', name: 'Sepia', bg: '#f4ecd8', fg: '#5b4636', link: '#8a4b20' },
    { id: 'sand', name: 'Sand', bg: '#e9dfc9', fg: '#3d3426', link: '#7a4a1e' },
    { id: 'mint', name: 'Mint', bg: '#e4efe4', fg: '#203324', link: '#1d6b45' },
    { id: 'mist', name: 'Mist', bg: '#e7eaee', fg: '#252a31', link: '#2b5f9e' },
    { id: 'solarized', name: 'Solarized', bg: '#fdf6e3', fg: '#586e75', link: '#268bd2' },
    { id: 'night', name: 'Night', bg: '#1b1d22', fg: '#c9cdd4', link: '#8ab4f8', dark: true },
    { id: 'dusk', name: 'Dusk', bg: '#22252e', fg: '#bcc3d2', link: '#9cb8ff', dark: true },
    { id: 'mocha', name: 'Mocha', bg: '#2a2320', fg: '#d3c5b5', link: '#e0a070', dark: true },
    { id: 'forest', name: 'Forest', bg: '#17211c', fg: '#b9c9bc', link: '#7fd1a0', dark: true },
    { id: 'nord', name: 'Nord', bg: '#2e3440', fg: '#d8dee9', link: '#88c0d0', dark: true },
    { id: 'gruvbox', name: 'Gruvbox', bg: '#282828', fg: '#ebdbb2', link: '#fabd2f', dark: true },
    { id: 'solarized-dark', name: 'Solarized Dark', bg: '#002b36', fg: '#93a1a1', link: '#2aa198', dark: true },
    { id: 'black', name: 'Black', bg: '#000000', fg: '#b4b4b4', link: '#7aa7e0', dark: true },
    // pages that go with the app styles
    { id: 'parchment', name: 'Parchment', bg: '#f2e8d2', fg: '#2a2416', link: '#8e2b26', style: 'library' },
    { id: 'study-lamp', name: 'Study lamp', bg: '#1a1f19', fg: '#e2d6b8', link: '#d0a44e', dark: true, style: 'library' },
    { id: 'paperback', name: 'Paperback', bg: '#fbf5e8', fg: '#1d1d1b', link: '#d9600f', style: 'paperback' },
    { id: 'paperback-night', name: 'Paperback night', bg: '#1f1b17', fg: '#ece2d0', link: '#ff8a3c', dark: true, style: 'paperback' },
    { id: 'newsprint', name: 'Newsprint', bg: '#ece8df', fg: '#161616', link: '#b3261e', style: 'broadsheet' },
    { id: 'press-ink', name: 'Press ink', bg: '#151515', fg: '#dcd8ce', link: '#e35d4f', dark: true, style: 'broadsheet' },
    { id: 'cotton', name: 'Cotton', bg: '#efe3cc', fg: '#2a1d14', link: '#9c4a1c', style: 'bogolan' },
    { id: 'mud', name: 'Mud cloth', bg: '#241912', fg: '#ead7b9', link: '#d9894a', dark: true, style: 'bogolan' },
    { id: 'indigo-wash', name: 'Indigo wash', bg: '#eaeef6', fg: '#14204a', link: '#1f3b8f', style: 'indigo' },
    { id: 'indigo-deep', name: 'Deep indigo', bg: '#0f1836', fg: '#dfe6f7', link: '#8fb3ff', dark: true, style: 'indigo' },
    { id: 'kente-gold', name: 'Kente gold', bg: '#f8f1df', fg: '#1a1410', link: '#1f7a3a', style: 'kente' },
    { id: 'kente-night', name: 'Kente night', bg: '#18130e', fg: '#f2e3c0', link: '#f2c230', dark: true, style: 'kente' },
    { id: 'plaster', name: 'Plaster', bg: '#f6f3ec', fg: '#12313a', link: '#0f6e64', style: 'zellige' },
    { id: 'tile-night', name: 'Tile night', bg: '#0d262d', fg: '#e9e2cf', link: '#e9b949', dark: true, style: 'zellige' },
    { id: 'stucco', name: 'Stucco', bg: '#f6eddd', fg: '#3b2416', link: '#b5532d', style: 'andalus' },
    { id: 'courtyard', name: 'Courtyard', bg: '#20160f', fg: '#eddcc0', link: '#e08a5a', dark: true, style: 'andalus' },
    { id: 'vellum', name: 'Vellum', bg: '#f1e5c6', fg: '#2a1c10', link: '#24479a', style: 'manuscript' },
    { id: 'gilt-night', name: 'Gilt night', bg: '#19150f', fg: '#e9d8b0', link: '#d9a843', dark: true, style: 'manuscript' },
    { id: 'mist', name: 'Window mist', bg: '#e7ecf0', fg: '#1e2a33', link: '#3c6e8f', style: 'rainy' },
    { id: 'rain-night', name: 'Rain at night', bg: '#121a21', fg: '#cfd9e1', link: '#7fb4d6', dark: true, style: 'rainy' },
    { id: 'dining-car', name: 'Dining car', bg: '#f3e8d4', fg: '#2b1d14', link: '#8a3b2a', style: 'train' },
    { id: 'sleeper', name: 'Sleeper car', bg: '#1d1422', fg: '#ecd6ae', link: '#e0a84c', dark: true, style: 'train' },
    { id: 'haze', name: 'Haze', bg: '#efe2c9', fg: '#3a2a1a', link: '#c4622d', style: 'harmattan' },
    { id: 'sahel-dusk', name: 'Sahel dusk', bg: '#2b1f19', fg: '#efdcc0', link: '#e88a4a', dark: true, style: 'harmattan' },
]
export const BUNDLED_FONTS = [
    ['Literata', 'Literata', 'serif'], ['Merriweather', 'Merriweather', 'serif'], ['Lora', 'Lora', 'serif'],
    ['Inter', 'Inter', 'sans-serif'], ['Atkinson Hyperlegible', 'Atkinson Hyperlegible', 'sans-serif'],
    ['OpenDyslexic', 'OpenDyslexic', 'sans-serif'], ['JetBrains Mono', 'JetBrains Mono', 'monospace'],
]
export const SYSTEM_FONTS = ['Georgia', 'Times New Roman', 'Cambria', 'Garamond', 'Palatino Linotype', 'Book Antiqua', 'Segoe UI', 'Arial', 'Verdana', 'Calibri', 'Tahoma', 'Consolas']
export const PALETTES = {
    ink: { name: 'Ink', hue: 225, sat: 13 }, warm: { name: 'Warm', hue: 32, sat: 16 }, forest: { name: 'Forest', hue: 150, sat: 12 },
    rose: { name: 'Rose', hue: 345, sat: 12 }, ocean: { name: 'Ocean', hue: 208, sat: 26 }, plum: { name: 'Plum', hue: 275, sat: 14 },
    mono: { name: 'Mono', hue: 0, sat: 0 },
}
export const ACCENTS = ['#e2703a', '#d9a400', '#3aa76d', '#2f8fd8', '#6c6fe8', '#b05fd6', '#e0527a', '#8c9099']
export const HIGHLIGHTS = { yellow: '#f6d32d', green: '#57e389', blue: '#62a0ea', pink: '#f66151', purple: '#c061cb', orange: '#ffa348' }

export const KEY_ACTIONS = {
    next: 'Next page', prev: 'Previous page', nextSection: 'Next chapter', prevSection: 'Previous chapter',
    back: 'Back to library', toc: 'Contents and notes', search: 'Search in book', bookmark: 'Bookmark this page',
    settings: 'Reading settings', fullscreen: 'Full screen', tts: 'Read aloud: play or pause', fontUp: 'Bigger text',
    fontDown: 'Smaller text', flow: 'Switch paged / scrolling', theme: 'Next theme', historyBack: 'Go back (after a jump)',
    speed: 'Speed reading', ruler: 'Reading ruler', bars: 'Show or hide toolbars', focus: 'Focus session and sounds',
}
export const DEFAULT_KEYS = {
    next: ['ArrowRight', 'PageDown', ' ', 'l'], prev: ['ArrowLeft', 'PageUp', 'Shift+ ', 'h'],
    nextSection: ['Ctrl+ArrowRight'], prevSection: ['Ctrl+ArrowLeft'], back: ['Escape'], toc: ['t'], search: ['Ctrl+f', '/'],
    bookmark: ['b', 'Ctrl+d'], settings: ['s'], fullscreen: ['F11', 'f'], tts: ['r'], fontUp: ['Ctrl+=', '='],
    fontDown: ['Ctrl+-', '-'], flow: ['v'], theme: ['n'], historyBack: ['Alt+ArrowLeft', 'Backspace'], speed: ['Ctrl+r'],
    ruler: ['g'], bars: ['m'], focus: ['p'],
}

// App styles. Riso and Classic are the originals; the rest each bring their own paper, type, ornaments
// and quirks (css/themes.css), plus a pair of matching page colors for the reader.
const P = (bg, bg2, surface, surface2, border, text, text2, text3, shadow) => ({ '--bg': bg, '--bg2': bg2, '--surface': surface, '--surface2': surface2, '--border': border, '--text': text, '--text2': text2, '--text3': text3, '--shadow': shadow })
export const STYLES = {
    riso: { name: 'Riso print', group: 'Originals', desc: 'Two-ink print, library cards and rubber stamps', swatch: ['#f3ecdc', '#3255a4', '#ff48b0'] },
    classic: { name: 'Classic', group: 'Originals', desc: 'The clean look, with your own colors', swatch: ['#f4f2ef', '#2a2d33', '#e2703a'] },
    library: { name: 'Old Library', group: 'Book world', desc: 'Leather, gilt edges, brass shelf plates and marbled endpapers', font: 'EB Garamond', reader: ['parchment', 'study-lamp'],
        day: P('#ece2cc', '#e2d5b9', '#f6eedc', '#e9dec6', '#b9a77f', '#23261d', '#4f4a3a', '#857b62', 'rgba(60,40,10,.22)'), night: P('#121813', '#0e130f', '#1b241d', '#243027', '#3c4a3d', '#eadfc4', '#c2b795', '#8a8268', 'rgba(0,0,0,.6)'), accent: ['#8e2b26', '#d0a44e'] },
    paperback: { name: 'Paperback', group: 'Book world', desc: 'Orange-band paperbacks, bold caps and pocket-book corners', font: 'Josefin Sans', reader: ['paperback', 'paperback-night'],
        day: P('#f6efe2', '#efe5d2', '#fffaf1', '#f3ead9', '#d9cdb6', '#1b1b1b', '#4a4640', '#8a8478', 'rgba(40,30,10,.18)'), night: P('#1b1815', '#151310', '#25211d', '#2f2a25', '#443d35', '#f1e8d8', '#c9bfae', '#8d8476', 'rgba(0,0,0,.6)'), accent: ['#e8661a', '#ff8a3c'] },
    broadsheet: { name: 'Broadsheet', group: 'Book world', desc: 'A newspaper front page: mastheads, column rules and halftone photos', font: 'Newsreader', reader: ['newsprint', 'press-ink'],
        day: P('#e9e5dc', '#e1dcd1', '#f3f0e8', '#e6e1d6', '#1a1a1a', '#141414', '#3d3d3b', '#75736d', 'rgba(0,0,0,.18)'), night: P('#111111', '#0b0b0b', '#1a1a1a', '#242424', '#d8d3c8', '#ebe6db', '#b9b4a9', '#7f7b73', 'rgba(0,0,0,.7)'), accent: ['#b3261e', '#e35d4f'] },
    bogolan: { name: 'Bògòlan', group: 'West African', desc: 'Mud cloth from Mali: hand-painted symbols on rough cotton', font: 'Bricolage Grotesque', reader: ['cotton', 'mud'],
        day: P('#e8dbc2', '#ddcdb0', '#f2e8d5', '#e6d8bd', '#2a1d14', '#2a1d14', '#5a4636', '#8a7360', 'rgba(42,29,20,.25)'), night: P('#211710', '#1a120c', '#2d2118', '#382a1f', '#ead7b9', '#efdfc4', '#cdb898', '#8f7a62', 'rgba(0,0,0,.6)'), accent: ['#9c4a1c', '#e0955a'] },
    indigo: { name: 'Indigo', group: 'West African', desc: 'Tie-dye and batik from the dye pits: resist circles and crackle', font: 'DM Serif Display', reader: ['indigo-wash', 'indigo-deep'],
        day: P('#e4e9f2', '#d8dfec', '#f4f6fa', '#e6ebf4', '#b7c2da', '#0f1c46', '#3a4670', '#6f7a9c', 'rgba(15,28,70,.2)'), night: P('#0b1330', '#08102a', '#121e46', '#1a2856', '#2b3b70', '#e7ecf8', '#b8c3e2', '#7c88ad', 'rgba(0,0,8,.6)'), accent: ['#1f3b8f', '#8fb3ff'] },
    kente: { name: 'Kente', group: 'West African', desc: 'Woven strips of gold, green, red and black', font: 'Archivo', reader: ['kente-gold', 'kente-night'],
        day: P('#f4ede0', '#ebe2d0', '#fffaf0', '#f2e9d7', '#1a1410', '#1a1410', '#4a3f33', '#857865', 'rgba(26,20,16,.2)'), night: P('#14100c', '#0f0c09', '#1f1913', '#29211a', '#f2c230', '#f4e6c5', '#d4c39c', '#93856a', 'rgba(0,0,0,.65)'), accent: ['#1f7a3a', '#f2c230'] },
    zellige: { name: 'Zellige', group: 'Islamic geometry', desc: 'Glazed star tiles from Fez, in teal, cobalt and ochre', font: 'Atkinson Hyperlegible', reader: ['plaster', 'tile-night'],
        day: P('#f2efe8', '#e8e3d8', '#fbf9f4', '#efebe2', '#cfc6b3', '#12313a', '#3c5960', '#7a8e91', 'rgba(18,49,58,.18)'), night: P('#0a2026', '#071a1f', '#0f2e37', '#153a44', '#2a5560', '#f1ead8', '#c4cfc8', '#83998f', 'rgba(0,0,0,.6)'), accent: ['#0f6e64', '#e9b949'] },
    andalus: { name: 'Andalus', group: 'Islamic geometry', desc: 'Horseshoe arches, carved stucco and courtyard terracotta', font: 'Atkinson Hyperlegible', reader: ['stucco', 'courtyard'],
        day: P('#f1e7d6', '#e7dac4', '#faf4e8', '#efe4d1', '#d3bfa0', '#3b2416', '#654a37', '#977c66', 'rgba(59,36,22,.2)'), night: P('#1c130d', '#160f0a', '#281c14', '#33241a', '#4d3826', '#f0e1c8', '#cdb79a', '#927b63', 'rgba(0,0,0,.6)'), accent: ['#b5532d', '#e08a5a'] },
    manuscript: { name: 'Manuscript', group: 'Islamic geometry', desc: 'Illuminated pages: vellum, lapis blue and gold leaf', font: 'EB Garamond', reader: ['vellum', 'gilt-night'],
        day: P('#ece0c2', '#e2d3b0', '#f6ecd3', '#ebdfc1', '#b8862b', '#2a1c10', '#584530', '#8d7656', 'rgba(60,40,10,.22)'), night: P('#14110c', '#100d09', '#1f1a12', '#2a2319', '#7d6a3f', '#ecdcb6', '#c9b68c', '#8e7e5d', 'rgba(0,0,0,.6)'), accent: ['#24479a', '#d9a843'] },
    rainy: { name: 'Rainy window', group: 'Moods and places', desc: 'Frosted glass, rain running down the pane', font: 'Atkinson Hyperlegible', reader: ['mist', 'rain-night'],
        day: P('#d9e1e7', '#cfd8df', 'rgba(244,247,249,.78)', 'rgba(231,237,241,.85)', 'rgba(60,90,110,.22)', '#1e2a33', '#45545f', '#7a8892', 'rgba(20,40,60,.18)'), night: P('#0e141a', '#0b1015', 'rgba(26,36,46,.78)', 'rgba(36,48,60,.85)', 'rgba(140,180,210,.18)', '#d6e0e8', '#a5b3bf', '#6d7c88', 'rgba(0,0,0,.6)'), accent: ['#3c6e8f', '#7fb4d6'] },
    train: { name: 'Night train', group: 'Moods and places', desc: 'Brass, velvet and a ticket for the sleeper car', font: 'Atkinson Hyperlegible', reader: ['dining-car', 'sleeper'],
        day: P('#efe4d0', '#e5d7bd', '#f8f0e1', '#ece0c9', '#7a4a2e', '#2b1d14', '#5c4535', '#8f7867', 'rgba(60,30,10,.22)'), night: P('#170f1b', '#120b15', '#231829', '#2e2134', '#5a4060', '#f3dcb2', '#cdb48d', '#8d7a66', 'rgba(0,0,0,.65)'), accent: ['#8a3b2a', '#e0a84c'] },
    harmattan: { name: 'Harmattan', group: 'Moods and places', desc: 'Dry-season haze, a pale sun and dust in the air', font: 'Atkinson Hyperlegible', reader: ['haze', 'sahel-dusk'],
        day: P('#ead9bd', '#e1cdab', '#f4e9d6', '#eadcc3', '#cdb48c', '#3a2a1a', '#634c36', '#977d62', 'rgba(90,60,20,.2)'), night: P('#261b16', '#1f1612', '#33251e', '#3e2e25', '#5a4334', '#f0dcc0', '#cdb595', '#937b62', 'rgba(0,0,0,.6)'), accent: ['#c4622d', '#e88a4a'] },
}

export const DEFAULTS = {
    app: {
        style: 'riso', mode: 'system', palette: 'ink', accent: '#e2703a', amoled: false, uiFont: 'Inter', uiScale: 100,
        coverSize: 148, coverRadius: 6, showTitles: true, view: 'grid', sort: 'added', sortDir: 'desc',
        landing: 'home', customCSS: '', lookupGenres: true, scanOnStart: true, folders: null,
        downloadFolder: '', sidebarCollapsed: false,
    },
    reader: {
        lightTheme: 'paper', darkTheme: 'night', followApp: true, theme: 'paper',
        font: 'Literata', fontSize: 18, weight: 400, lineHeight: 1.6, paraSpacing: -0.1, indent: -0.25, letterSpacing: 0, wordSpacing: 0,
        justify: true, hyphenate: true, overrideFonts: false, overrideColors: true,
        flow: 'paginated', columns: 2, maxWidth: 720, margin: 44, gap: 6, animated: true,
        pdfZoom: 'fit-page', pdfSpread: 'auto', pdfTheme: false, dimImages: false,
        comicScroll: false, comicWidth: 900, comicGap: 0,
        brightness: 100, warmth: 0, ruler: false, rulerHeight: 3,
        customCSS: '', showClock: true, footer: 'percent', autoHideBars: false, clickZones: true, wheelTurn: true,
        ttsVoice: '', ttsRate: 1, ttsPitch: 1, translateTo: 'en', highlightColor: 'yellow', highlightStyle: 'highlight', matchStyle: true,
        speedWpm: 300,
    },
    themes: [], keys: DEFAULT_KEYS, goals: { dailyMinutes: 30, yearlyBooks: 12 }, perBook: {}, firstRunDone: false,
}

export const S = {
    get app() { return { ...DEFAULTS.app, ...(data.settings.app ?? {}) } },
    get reader() { return { ...DEFAULTS.reader, ...(data.settings.reader ?? {}) } },
    get goals() { return { ...DEFAULTS.goals, ...(data.settings.goals ?? {}) } },
    get keys() { return { ...DEFAULT_KEYS, ...(data.settings.keys ?? {}) } },
    get themes() { return [...READER_THEMES, ...Object.values(data.settings.themes ?? {})] },
    readerFor(bookId) { return { ...this.reader, ...(data.settings.perBook?.[bookId] ?? {}) } },
    setApp(k, v) { db.set('settings', ['app', k], v) },
    setReader(k, v) { db.set('settings', ['reader', k], v) },
}

const mq = matchMedia('(prefers-color-scheme: dark)')
export const isDark = () => { const m = S.app.mode; return m === 'dark' || (m === 'system' && mq.matches) }
mq.addEventListener('change', () => applyAppTheme())

// Riso style: newsprint by day, navy night-print stock after dark. Inks live in css/riso.css.
const RISO = {
    day: { '--bg': '#f3ecdc', '--bg2': '#ebe2cc', '--surface': '#fbf7ee', '--surface2': '#efe6d3', '--border': '#1d1b3a',
        '--text': '#1d1b3a', '--text2': '#4a4668', '--text3': '#7d7896', '--shadow': 'rgba(29,27,58,.25)' },
    night: { '--bg': '#18172a', '--bg2': '#141325', '--surface': '#211f3a', '--surface2': '#2a2846', '--border': '#4b4775',
        '--text': '#f1e9d6', '--text2': '#c6bfdc', '--text3': '#8e88ad', '--shadow': 'rgba(0,0,0,.55)' },
}
export function applyAppTheme() {
    const a = S.app
    const dark = isDark()
    const p = PALETTES[a.palette] ?? PALETTES.ink
    const hsl = (l, sMul = 1) => `hsl(${p.hue} ${Math.round(p.sat * sMul)}% ${l}%)`
    const riso = a.style === 'riso'
    const themed = STYLES[a.style]?.day ? STYLES[a.style] : null
    const v = themed ? (dark ? themed.night : themed.day) : riso ? (dark ? RISO.night : RISO.day) : dark ? {
        '--bg': a.amoled ? '#000' : hsl(8.5), '--bg2': a.amoled ? hsl(5) : hsl(11.5), '--surface': hsl(a.amoled ? 9 : 14.5), '--surface2': hsl(a.amoled ? 13 : 19),
        '--border': hsl(23), '--text': hsl(92, 0.6), '--text2': hsl(68, 0.7), '--text3': hsl(48, 0.8), '--shadow': 'rgba(0,0,0,.55)',
    } : {
        '--bg': hsl(96, 1.4), '--bg2': hsl(93, 1.4), '--surface': hsl(99.2, 1.6), '--surface2': hsl(91, 1.3),
        '--border': hsl(84, 1.1), '--text': hsl(13), '--text2': hsl(36), '--text3': hsl(52), '--shadow': 'rgba(60,50,40,.18)',
    }
    const root = document.documentElement
    for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val)
    root.style.setProperty('--accent', themed ? themed.accent[dark ? 1 : 0] : riso ? (dark ? '#ff5cb8' : '#e8167f') : a.accent)
    root.dataset.style = themed ? a.style : riso ? 'riso' : 'classic'
    if (themed) root.dataset.themed = '1'; else delete root.dataset.themed
    root.style.setProperty('--cover-w', a.coverSize + 'px')
    root.style.setProperty('--cover-r', a.coverRadius + 'px')
    const uiFont = a.uiFont !== 'Inter' ? a.uiFont : themed ? themed.font : riso ? 'Atkinson Hyperlegible' : 'Inter'
    root.style.setProperty('--ui-font', `"${uiFont}", "Amiri", "Segoe UI", system-ui, sans-serif`)
    root.style.fontSize = (a.uiScale / 100 * 14.5) + 'px'
    root.dataset.mode = dark ? 'dark' : 'light'
    root.classList.toggle('no-titles', !a.showTitles)
    let st = document.getElementById('user-css')
    if (!st) { st = h('style', { id: 'user-css' }); document.head.append(st) }
    st.textContent = a.customCSS || ''
    if (!document.querySelector('#reader.rd')) setOverlay(v['--bg'], dark)
}
const probe = document.createElement('canvas').getContext('2d')
export function setOverlay(cssColor, dark) {
    probe.fillStyle = '#000'; probe.fillStyle = cssColor
    window.api.invoke('win:overlay', probe.fillStyle, dark ? '#a9afba' : '#4b4f57')
}

export function resolveReaderTheme(r) {
    const pair = r.followApp && r.matchStyle ? STYLES[S.app.style]?.reader : null
    const id = pair ? pair[isDark() ? 1 : 0] : r.followApp ? (isDark() ? r.darkTheme : r.lightTheme) : r.theme
    return S.themes.find(t => t.id === id) ?? READER_THEMES[0]
}

let localFonts
export async function fontChoices() {
    if (localFonts === undefined) {
        localFonts = []
        try {
            const fonts = await window.queryLocalFonts()
            localFonts = [...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b))
        } catch { localFonts = SYSTEM_FONTS }
    }
    return localFonts
}

// ---------- reading controls (used in the reader side panel and in Settings) ----------
export function readerControls(get, set, { fixed = false, tab = 'text', onTab, comic = false, webtoon = false, onComicMode } = {}) {
    const r = get()
    const wrap = h('div.reader-controls')
    const themeGrid = () => {
        const cur = r.followApp ? null : r.theme
        return h('div.theme-grid', S.themes.map(t => h('button.theme-swatch', {
            class: (cur === t.id ? 'on ' : '') + (r.followApp && (r.matchStyle && STYLES[S.app.style]?.reader ? STYLES[S.app.style].reader : [r.lightTheme, r.darkTheme]).includes(t.id) ? 'auto' : ''),
            title: t.name, style: { background: t.bg, color: t.fg },
            onclick: () => {
                if (r.matchStyle) set('matchStyle', false)
                if (r.followApp) set(t.dark ? 'darkTheme' : 'lightTheme', t.id)
                else set('theme', t.id)
                rerender()
            },
            oncontextmenu: e => { e.preventDefault(); if (t.custom) editTheme(t, rerender) },
        }, h('b', 'Aa'), h('small', t.name))),
        h('button.theme-swatch.add', { title: 'Create your own theme', onclick: () => editTheme(null, rerender) }, icon('plus', 16), h('small', 'Custom')))
    }
    const fontSelect = () => {
        const sel = h('select', { onchange: () => set('font', sel.value) },
            h('optgroup', { label: 'Included' }, BUNDLED_FONTS.map(([n]) => h('option', { value: n, selected: n === r.font }, n))),
            h('optgroup', { label: 'On this computer' }, h('option', { value: r.font, selected: !BUNDLED_FONTS.some(f => f[0] === r.font) }, r.font)))
        fontChoices().then(list => {
            const og = sel.querySelector('optgroup:last-child')
            og.replaceChildren(...list.map(n => h('option', { value: n, selected: n === r.font }, n)))
        })
        return sel
    }
    const tabs = [['text', 'Text'], ['layout', 'Layout'], ['theme', 'Theme'], ['more', 'More']]
    const panes = {
        text: () => fixed ? [h('p.muted', 'Text settings apply to reflowable books (EPUB, MOBI, FB2, TXT, DOCX). This file has fixed pages; see Layout for zoom.')] : [
            row('Font', fontSelect()),
            row('Size', slider({ min: 10, max: 40, value: r.fontSize, onchange: v => set('fontSize', v), fmt: v => v + ' px' })),
            row('Weight', slider({ min: 300, max: 700, step: 100, value: r.weight, onchange: v => set('weight', v) })),
            row('Line height', slider({ min: 1, max: 2.6, step: 0.05, value: r.lineHeight, onchange: v => set('lineHeight', v), fmt: v => v.toFixed(2) })),
            row('Paragraph spacing', slider({ min: -0.1, max: 2, step: 0.1, value: r.paraSpacing, onchange: v => set('paraSpacing', v), fmt: v => v < 0 ? "Book's own" : v.toFixed(1) + ' em' })),
            row('First-line indent', slider({ min: -0.25, max: 3, step: 0.25, value: r.indent, onchange: v => set('indent', v), fmt: v => v < 0 ? "Book's own" : v + ' em' })),
            row('Letter spacing', slider({ min: -0.05, max: 0.2, step: 0.01, value: r.letterSpacing, onchange: v => set('letterSpacing', v), fmt: v => v.toFixed(2) + ' em' })),
            row('Word spacing', slider({ min: 0, max: 0.5, step: 0.02, value: r.wordSpacing, onchange: v => set('wordSpacing', v), fmt: v => v.toFixed(2) + ' em' })),
            row('Justify text', toggle(r.justify, v => set('justify', v))),
            row('Hyphenate', toggle(r.hyphenate, v => set('hyphenate', v))),
            row('Always use my font', toggle(r.overrideFonts, v => set('overrideFonts', v)), "Ignore the book's own fonts"),
        ],
        layout: () => [
            comic ? row('Reading mode', segmented([['pages', 'Pages'], ['scroll', 'Scroll']], webtoon ? 'scroll' : 'pages', v => onComicMode?.(v)), 'Scroll shows the pages in one long strip, like a webtoon') : null,
            webtoon ? row('Page width', slider({ min: 0, max: 2000, step: 50, value: r.comicWidth ?? 900, onchange: v => set('comicWidth', v), fmt: v => v ? v + ' px' : 'Full window' })) : null,
            webtoon ? row('Space between pages', slider({ min: 0, max: 60, step: 2, value: r.comicGap ?? 0, onchange: v => set('comicGap', v), fmt: v => v ? v + ' px' : 'None (seamless)' })) : null,
            comic ? row('Open comics in scroll mode', toggle(!!r.comicScroll, v => set('comicScroll', v)), 'The default for comics you have not set yourself') : null,
            fixed && !webtoon ? row('Zoom', segmented([['fit-page', 'Fit page'], ['fit-width', 'Fit width'], ['1', '100%'], ['1.5', '150%'], ['2', '200%']], String(r.pdfZoom), v => set('pdfZoom', v))) : null,
            fixed ? null : row('Reading mode', segmented([['paginated', 'Pages'], ['scrolled', 'Scroll']], r.flow, v => set('flow', v))),
            fixed ? null : row('Columns', segmented([[1, 'One'], [2, 'Two'], [3, 'Three']], r.columns, v => set('columns', v)), 'Used when the window is wide enough'),
            fixed ? null : row('Line width', slider({ min: 360, max: 1400, step: 20, value: r.maxWidth, onchange: v => set('maxWidth', v), fmt: v => v + ' px' })),
            fixed ? null : row('Top and bottom margin', slider({ min: 0, max: 140, step: 4, value: r.margin, onchange: v => set('margin', v), fmt: v => v + ' px' })),
            fixed ? null : row('Side gap', slider({ min: 0, max: 20, step: 1, value: r.gap, onchange: v => set('gap', v), fmt: v => v + ' %' })),
            fixed ? null : row('Page-turn animation', toggle(r.animated, v => set('animated', v))),
            webtoon ? null : row('Click sides to turn pages', toggle(r.clickZones, v => set('clickZones', v))),
            webtoon ? null : row('Mouse wheel turns pages', toggle(r.wheelTurn, v => set('wheelTurn', v))),
            row('Hide toolbars while reading', toggle(r.autoHideBars, v => set('autoHideBars', v)), 'Move the mouse to the top or bottom edge to show them'),
            row('Footer shows', select([['percent', 'Percent read'], ['page', 'Page / location'], ['time', 'Time left in book'], ['chapter', 'Time left in chapter'], ['none', 'Nothing']], r.footer, v => set('footer', v))),
            row('Show clock', toggle(r.showClock, v => set('showClock', v))),
        ],
        theme: () => [
            row('Match the app (light / dark)', toggle(r.followApp, v => { set('followApp', v); rerender() }), r.followApp ? 'Pick one light and one dark theme below' : 'One theme at all times'),
            STYLES[S.app.style]?.reader ? row(`Use the ${STYLES[S.app.style].name} pages`, toggle(r.followApp && r.matchStyle, v => { set('matchStyle', v); if (v) set('followApp', true); rerender() }), 'Page colors that go with the app style') : null,
            themeGrid(),
            h('p.muted.small', 'Right-click one of your own themes to edit or delete it.'),
            row("Use theme colors over the book's", toggle(r.overrideColors, v => set('overrideColors', v))),
            row('Apply theme to PDFs and scans', toggle(r.pdfTheme, v => set('pdfTheme', v)), 'Recolors page images to match dark themes'),
            row('Dim images in dark themes', toggle(r.dimImages, v => set('dimImages', v))),
            row('Brightness', slider({ min: 30, max: 100, value: r.brightness, onchange: v => set('brightness', v), fmt: v => v + ' %' })),
            row('Warmth (night light)', slider({ min: 0, max: 60, value: r.warmth, onchange: v => set('warmth', v), fmt: v => v + ' %' })),
        ],
        more: () => [
            row('Reading ruler', toggle(r.ruler, v => set('ruler', v)), 'A focus band that follows your mouse'),
            row('Ruler height', slider({ min: 1, max: 8, step: 0.5, value: r.rulerHeight, onchange: v => set('rulerHeight', v), fmt: v => v + ' lines' })),
            row('Translate into', select(LANGS, r.translateTo, v => set('translateTo', v))),
            row('Read-aloud voice', voiceSelect(r.ttsVoice, v => set('ttsVoice', v))),
            row('Read-aloud speed', slider({ min: 0.5, max: 2.5, step: 0.1, value: r.ttsRate, onchange: v => set('ttsRate', v), fmt: v => v.toFixed(1) + '×' })),
            row('Speed-reading pace', slider({ min: 120, max: 900, step: 20, value: r.speedWpm, onchange: v => set('speedWpm', v), fmt: v => v + ' wpm' })),
            h('label.field', h('span', 'Your own CSS for book pages'),
                h('textarea', { rows: 5, spellcheck: false, placeholder: 'e.g.  p { text-indent: 1.5em }  h1 { color: tomato }', value: r.customCSS, oninput: e => set('customCSS', e.target.value) })),
        ],
    }
    let current = tab
    const rerender = () => {
        Object.assign(r, get())
        wrap.replaceChildren(
            h('div.seg.tabs', tabs.map(([id, label]) => h('button', { class: id === current ? 'on' : '', onclick: () => { current = id; onTab?.(id); rerender() } }, label))),
            h('div.pane', panes[current]()))
    }
    rerender()
    return wrap
}

export const LANGS = [['en', 'English'], ['fr', 'French'], ['ar', 'Arabic'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['de', 'German'], ['it', 'Italian'],
    ['zh-CN', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ru', 'Russian'], ['tr', 'Turkish'], ['hi', 'Hindi'], ['sw', 'Swahili'], ['wo', 'Wolof'], ['nl', 'Dutch']]

function voiceSelect(value, onchange) {
    const sel = h('select', { onchange: () => onchange(sel.value) }, h('option', { value: '' }, 'Automatic (match book language)'))
    const fill = () => {
        const voices = speechSynthesis.getVoices()
        if (!voices.length) return
        sel.replaceChildren(h('option', { value: '' }, 'Automatic (match book language)'),
            ...voices.map(v => h('option', { value: v.name, selected: v.name === value }, `${v.name} (${v.lang})`)))
    }
    fill()
    speechSynthesis.addEventListener('voiceschanged', fill, { once: true })
    return sel
}

export function editTheme(theme, done) {
    const t = theme ? { ...theme } : { id: 'custom-' + uid(), name: 'My theme', bg: '#f3efe6', fg: '#2a2a2a', link: '#b3541e', dark: false, custom: true }
    const preview = h('div.theme-preview', h('b', 'The quick brown fox'), h('p', 'jumps over the lazy dog. ', h('a', 'A link looks like this.')))
    const paint = () => { preview.style.background = t.bg; preview.style.color = t.fg; preview.querySelector('a').style.color = t.link }
    const color = key => h('input', { type: 'color', value: t[key], oninput: e => { t[key] = e.target.value; paint() } })
    paint()
    modal({
        title: theme ? 'Edit theme' : 'New theme',
        body: h('div', h('label.field', h('span', 'Name'), h('input', { type: 'text', value: t.name, oninput: e => t.name = e.target.value })),
            row('Page color', color('bg')), row('Text color', color('fg')), row('Link color', color('link')),
            row('This is a dark theme', toggle(t.dark, v => t.dark = v)), preview),
        actions: [
            theme ? { label: 'Delete', danger: true, run: () => { db.set('settings', ['themes', t.id], null); done?.() } } : null,
            { label: 'Cancel' },
            { label: 'Save', primary: true, run: () => { db.set('settings', ['themes', t.id], { ...t, custom: true }); toast('Theme saved'); done?.() } },
        ].filter(Boolean),
    })
}
