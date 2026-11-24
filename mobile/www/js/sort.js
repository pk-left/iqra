// Auto-sorting brains: cleans metadata, reads file names, detects series, maps subjects to genres.

const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }
const num = s => { const n = parseFloat(s); return isNaN(n) ? (WORDNUM[String(s).toLowerCase()] ?? null) : n }
const tidy = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const JUNK_AUTHOR = /^(unknown( author)?|calibre|anonymous|anonymous user|admin|user|author|none|null|n\/a|microsoft|adobe.*|administrator|owner|pc|\d+)$/i
const NUMWORD = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[ivx]{1,4})'

export function langName(code) {
    if (!code) return ''
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(String(code).split(/[-_]/)[0].toLowerCase()) ?? code } catch { return code }
}

const str = x => {
    if (x == null) return ''
    if (typeof x === 'string') return x
    if (Array.isArray(x)) return x.map(str).filter(Boolean).join(', ')
    if (typeof x === 'object') return str(x.name ?? x[Object.keys(x)[0]])
    return String(x)
}
const list = x => (Array.isArray(x) ? x : x == null ? [] : [x]).map(str).map(tidy).filter(Boolean)

export function cleanAuthor(a) {
    a = tidy(a).replace(/\s*\[[^\]]*\]$/, '').replace(/\s*\((author|editor|ed\.|translator|illustrator)\)$/i, '')
    if (!a || JUNK_AUTHOR.test(a) || a.length > 80) return ''
    const m = /^([^,]+),\s*([^,]+)$/.exec(a)
    if (m && m[1].split(' ').length <= 3 && m[2].split(' ').length <= 3 && !/\b(jr|sr|phd|md|ii|iii)\b\.?/i.test(m[2])) a = `${m[2]} ${m[1]}`
    return a.replace(/\b([A-Z])\.(?=[A-Z])/g, '$1. ').replace(/\s+/g, ' ').trim()
}
export function splitAuthors(s) {
    const raw = list(s).flatMap(x => x.split(/\s*(?:;|\s&\s|\sand\s(?=\S+\s\S+)|\s\/\s|\|)\s*/))
        .flatMap(x => { const p = x.split(/\s*,\s*/); return p.length >= 2 && p.every(q => q.split(' ').length >= 2) ? p : [x] })
    const out = []
    for (const a of raw.map(cleanAuthor)) if (a && !out.includes(a)) out.push(a)
    return out.slice(0, 6)
}
export const authorSort = a => {
    const parts = tidy(a).split(' ')
    return parts.length > 1 ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`.toLowerCase() : tidy(a).toLowerCase()
}
export const titleSort = t => tidy(t).toLowerCase().replace(/^(the|a|an|le|la|les|l'|un|une)\s+/, '').replace(/^[^\p{L}\p{N}]+/u, '')

const looksLikeName = s => {
    const w = tidy(s).split(' ')
    return w.length >= 2 && w.length <= 4 && !/\d/.test(s) && w.every(x => /^[\p{Lu}][\p{L}.'’-]*$/u.test(x) || /^(de|van|von|der|la|le|du|da|bin|al|el)$/i.test(x))
}

// ---------- file name parsing ----------
const isCommaName = s => /^[\p{Lu}][\p{L}'’-]+,\s*[\p{Lu}][\p{L}.'’ -]*$/u.test(tidy(s)) && tidy(s).split(' ').length <= 4
const isName = s => looksLikeName(s) || isCommaName(s)
export function parseFilename(name) {
    let base = name.replace(/\.(fb2\.zip|[a-z0-9]{2,5})$/i, '')
    const out = { title: '', author: '', series: '', seriesIndex: null, year: null }
    // Anna's Archive: Title -- Author -- Publisher -- Year -- ids -- Anna's Archive
    if (/ -- /.test(base) && /anna.?s archive/i.test(base)) {
        const p = base.split(' -- ').map(tidy)
        out.title = p[0].replace(/_/g, ':'); out.author = (p[1] ?? '').replace(/_/g, ' ')
        const y = p.find(x => /^(1[5-9]|20)\d\d$/.test(x)); if (y) out.year = +y
        return finish(out)
    }
    base = base.replace(/@[\w.]+/g, ' ').replace(/\s*\((z-library|z-lib\.org|1lib\.\w+|pdfdrive|epub|pdf|mobi|azw3|retail|ebook|digital|digital\+?|scan|web|hq|ocr|\d+\s*covers?)\)/ig, ' ')
    base = base.replace(/^_?OceanofPDF\.com_/i, '').replace(/\s*[-_ ]*(pdfdrive(\.com)?|z[-_ ]?lib(rary)?([._ ](org|sk))?|1lib[._ ]sk|libgen(\.\w+)?|oceanofpdf(\.com)?|epubdump|bookzz|b-ok)[,_ ]*/ig, ' ').replace(/\(\s*\)/g, ' ')
    base = base.replace(/\s*\[(epub|pdf|mobi|azw3|retail|ebook|www\.[^\]]+)\]/ig, ' ').replace(/\s*\((\d{1,2})\)$/, ' ')
    base = base.replace(/^(\d{2})_(\d)_/, '$1.$2 ')
    if (!/\s/.test(base) && /[_.]/.test(base)) base = base.replace(/[_.]+/g, ' ')
    base = base.replace(/_/g, ' ')
    const ym = /[([]((?:1[5-9]|20)\d\d)[)\]]/.exec(base)
    if (ym) { out.year = +ym[1]; base = base.replace(ym[0], ' ') }
    base = tidy(base.replace(/\((?:[A-Z][\w-]*-(?:[A-Z]\w*)|Minutemen[^)]*|Empire|DCP|Zone-Empire)[^)]*\)/g, ' '))
    let m
    // "(Series 2) Author - Title"
    m = /^\(([^()]+?)\s+#?(\d{1,3}(?:\.\d)?)\)\s*(.+)$/.exec(base)
    if (m) { out.series = tidy(m[1]); out.seriesIndex = num(m[2]); base = tidy(m[3]) }
    // a leading position such as "01 " or "03. " (only when clearly an index, so "12 Rules for Life" is left alone)
    let lead = null
    m = /^(0\d(?:\.\d)?|\d{1,2}(?:\.\d)?(?=[.)]|\s*-\s))[.)]?[\s-]+(?=\D)/.exec(base)
    if (m && !out.series) { lead = num(m[1]); base = tidy(base.slice(m[0].length)) }
    // trailing year: "... - 2004"
    m = /[\s,-]+((?:1[5-9]|20)\d\d)$/.exec(base)
    if (m && base.length > m[0].length + 3) { out.year ??= +m[1]; base = tidy(base.slice(0, -m[0].length)) }
    // [Series 01] or (Series #1) fragments
    m = new RegExp(`[\\[(]\\s*([^\\])]+?)[\\s,]+(?:#|book\\s+|vol\\.?\\s*|volume\\s+)?${NUMWORD}\\s*[\\])]`, 'i').exec(base)
    if (!out.series && m && num(m[2]) != null && !/^\d+$/.test(m[1])) { out.series = tidy(m[1]); out.seriesIndex = num(m[2]); base = tidy(base.replace(m[0], ' ')) }
    // trailing "(Something)": the author (Z-Library style) or, after a leading number, the series
    m = /^(.*)\(([^()]+)\)\s*$/.exec(base)
    if (m && tidy(m[1])) {
        const inner = tidy(m[2])
        if (isName(inner) || (/,/.test(inner) && inner.split(',').every(x => looksLikeName(x) || x.trim().split(' ').length <= 3) && !/ - /.test(m[1]))) {
            out.title = tidy(m[1]); out.author = inner
            return finish(out)
        }
        if (lead != null && !out.series) { out.series = inner; out.seriesIndex = lead; base = tidy(m[1]) }
    }
    m = /^(.+?)\s+by\s+([\p{Lu}][^-–]+)$/u.exec(base)
    if (m && looksLikeName(m[2])) { out.title = m[1]; out.author = m[2]; return finish(out) }
    const parts = base.split(/\s+[-–—]\s+/).map(tidy).filter(Boolean)
    if (parts.length >= 2) {
        const first = parts[0], last = parts[parts.length - 1]
        const titleish = x => /^(the|a|an|my|our|how|why|what|when)\b/i.test(x) || /\b(of|and|the|in|to|for|on|with|from|at)\b/i.test(x)
        if (isCommaName(first) || (isName(first) && !titleish(first) && !isCommaName(last))) { out.author = first; out.title = parts.slice(1).join(' - ') }
        else if (isName(last) && !titleish(last)) { out.author = last; out.title = parts.slice(0, -1).join(' - ') }
        else out.title = parts.join(' - ')
        return finish(out)
    }
    // "Last, First Title of the Book" (names that lost their dashes)
    m = /^([\p{Lu}][\p{L}'’-]+),\s([\p{Lu}][\p{L}'’.-]+)\s+(.{3,})$/u.exec(base)
    if (m) { out.author = `${m[2]} ${m[1]}`; out.title = m[3]; return finish(out) }
    out.title = base
    return finish(out)
}
function finish(o) {
    o.title = tidy(o.title).replace(/^[-–\s]+|[-–\s]+$/g, '')
    o.author = tidy(o.author)
    return o
}

// ---------- series ----------
export function detectSeries(title, isComic) {
    const t = tidy(title)
    let m = new RegExp(`^(.*?)\\s*\\(([^()]+?)(?:,|\\s)\\s*(?:#|book\\s+|vol\\.?\\s*|volume\\s+|no\\.?\\s*|part\\s+)${NUMWORD}\\)\\s*$`, 'i').exec(t)
    if (m && m[1]) return { title: m[1], series: tidy(m[2].replace(/[,:]$/, '')), seriesIndex: num(m[3]) }
    m = new RegExp(`^(.*?)\\s*\\(([^()]+?)\\s+${NUMWORD}\\)\\s*$`, 'i').exec(t)
    if (m && m[1] && num(m[3]) != null && num(m[3]) < 100 && !/^(1[5-9]|20)\d\d$/.test(m[3])) return { title: m[1], series: tidy(m[2]), seriesIndex: num(m[3]) }
    m = new RegExp(`^(.+?)[,:]?\\s+(?:book|vol\\.?|volume|part)\\s+${NUMWORD}\\s*[:\\-–—]\\s*(.+)$`, 'i').exec(t)
    if (m) return { title: tidy(m[3]), series: tidy(m[1]), seriesIndex: num(m[2]) }
    m = new RegExp(`^(.+?)\\s*[:\\-–—]\\s*(?:book|volume|vol\\.?|part)\\s+${NUMWORD}\\s+(?:of|in)\\s+(?:the\\s+)?(.+?)(?:\\s+(?:series|trilogy|saga|cycle))?$`, 'i').exec(t)
    if (m) return { title: tidy(m[1]), series: tidy(m[3]), seriesIndex: num(m[2]) }
    m = new RegExp(`^(.+?)\\s+(?:book|vol\\.?|volume|#)\\s*${NUMWORD}$`, 'i').exec(t)
    if (m && num(m[2]) != null) return { title: t, series: tidy(m[1].replace(/[,:\-–]$/, '')), seriesIndex: num(m[2]) }
    if (isComic) {
        m = /^(.+?)\s+(?:#|v|vol\.?\s*|c|ch\.?\s*|t|tome\s*)?(\d{1,4})(?:\s*\(of\s*\d+\))?(?:\s*[-–(].*)?$/i.exec(t)
        if (m && !/^(1[5-9]|20)\d\d$/.test(m[2])) return { title: t.replace(/\s*\(of\s*\d+\)/i, ''), series: tidy(m[1].replace(/[-–,]$/, '')), seriesIndex: +m[2] }
    }
    return null
}

// ---------- genres ----------
export const GENRES = [
    ['Comics & Manga', /\b(comics?|graphic novels?|manga|manhwa|webtoon|superhero)/i],
    ['Fantasy', /\b(fantasy|fantasies|magic|wizards?|dragons?|sword|sorcer|fairy tales?|mytholog|epic\b.*\bfiction)/i],
    ['Science Fiction', /\b(science fiction|sci-?fi|dystopia|space opera|cyberpunk|time travel|aliens?|post-?apocalyptic|steampunk)/i],
    ['Mystery & Thriller', /\b(myster(y|ies)|thrillers?|detective|crime|suspense|noir|espionage|spy|murder|police procedural)/i],
    ['Romance', /\b(romance|love stor|romantic|chick lit|erotica)/i],
    ['Horror', /\b(horror|ghost|vampire|zombie|occult fiction|supernatural|paranormal)/i],
    ['Historical Fiction', /\bhistorical\b.*\bfiction|\bhistorical fiction/i],
    ['Young Adult', /\b(young adult|ya\b|teen|juvenile fiction|coming of age)/i],
    ["Children's", /\b(children|juvenile|picture books?|kids|middle grade)/i],
    ['Poetry & Drama', /\b(poetry|poems?|drama|plays?\b|theatre|theater|shakespeare)/i],
    ['Classics', /\b(classics?|classic literature|literary collections)/i],
    ['Programming & Computing', /\b(computers?|programming|software|python|javascript|java\b|c\+\+|algorithms?|data structures?|machine learning|artificial intelligence|deep learning|databases?|linux|web development|coding|cyber ?security|networking|computer science|data science|arduino|matlab)/i],
    ['Engineering', /\b(engineering|thermodynamics|fluid mechanics|mechanics of materials|strength of materials|statics|dynamics|heat transfer|machine design|mechatronics|control systems?|circuits?|electronics|electrical|mechanical|manufacturing|cad\b|solidworks|autocad|robotics|materials science|vibrations?|hydraulics|pneumatics|kinematics|technical drawing|engineering drawing|structural|civil|aerodynamics|turbomachinery|automotive|welding|metrology|tribology|workshop)/i],
    ['Mathematics', /\b(mathematics|maths?\b|calculus|algebra|geometry|statistics|probability|differential equations?|numerical methods?|trigonometry|linear algebra|discrete math|number theory)/i],
    ['Science & Nature', /\b(science|physics|chemistry|biology|astronomy|cosmology|evolution|nature|ecology|geology|neuroscience|quantum|genetics|environment|climate|zoology|botany)/i],
    ['Medicine & Health', /\b(medical|medicine|health|fitness|nutrition|diet|anatomy|nursing|disease|exercise|workout|wellness|yoga|bodybuilding)/i],
    ['Business & Money', /\b(business|economics?|finance|investing|investment|management|marketing|entrepreneur|startup|leadership|money|accounting|sales|trading|wealth|career)/i],
    ['Self-Help & Psychology', /\b(self-?help|personal (development|growth)|psychology|motivation|habits?|productivity|mindfulness|success|happiness|self-improvement|relationships|communication skills)/i],
    ['Biography & Memoir', /\b(biograph|autobiograph|memoirs?|diaries|letters)/i],
    ['History', /\b(history|historical|world war|civilization|ancient|medieval|empire|military)/i],
    ['Philosophy', /\b(philosoph|ethics|stoic|metaphysics|logic\b|existential)/i],
    ['Religion & Spirituality', /\b(religio|spiritual|islam|quran|bible|christian|buddhis|hindu|theology|faith|prayer|hadith|sufis)/i],
    ['Politics & Society', /\b(politic|social science|sociology|government|law\b|legal|current events|economy|culture|anthropology|education|feminis|race\b|africa)/i],
    ['Languages & Reference', /\b(language|grammar|dictionary|vocabulary|linguistics|french|english language|spanish|study guide|reference|encyclopedia|writing|textbook|exam|ielts|toefl)/i],
    ['Art & Design', /\b(art\b|arts\b|design|photography|architecture|music|drawing|painting|film|cinema|fashion|typography|animation)/i],
    ['Cooking & Lifestyle', /\b(cook|recipes?|food|travel|garden|crafts?|hobbies|home|parenting|sports?|games?)/i],
    ['Humor', /\b(humou?r|comedy|satire|jokes)/i],
    ['Short Stories', /\b(short stories|anthology|anthologies|essays)/i],
    ['Literary Fiction', /\b(literary|fiction|novels?)\b/i],
]
export function mapGenres(subjects, title = '', isComic) {
    const out = []
    if (isComic) out.push('Comics & Manga')
    const subj = (subjects ?? []).join(' | ')
    const nonfic = /\bnon-?fiction\b/i.test(subj)
    for (const [g, re] of GENRES) {
        if (out.length >= 2) break
        if (g === 'Literary Fiction' && (out.length || nonfic)) continue
        if (re.test(subj) && !out.includes(g)) out.push(g)
    }
    if (!out.length && title) {
        // textbooks and guides rarely carry subjects; the title is usually enough
        for (const [g, re] of GENRES.slice(11, 26)) if (re.test(title)) { out.push(g); break }
    }
    if (!out.length && nonfic) out.push('Nonfiction')
    return out
}

const DOC_WORDS = /\b(timetable|syllabus|assignment|homework|invoice|receipt|resume|curriculum vitae|\bcv\b|lecture|slides?|past ?papers?|exam(ination)?s?|quiz|worksheet|lab ?report|tutorial sheet|handout|transcript|certificate|application|form\b|letter|brochure|flyer|ticket|statement|schedule|notes?\b|draft|report|proposal|manual|datasheet|admission|question(s| paper)?|answers?|marking scheme|course outline|module \d)/i
export function guessKind(format, title, pages, size) {
    if (['cbz', 'cbr', 'cb7', 'cbt'].includes(format)) return 'comic'
    if (['txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'docx', 'doc', 'odt', 'rtf'].includes(format)) return 'document'
    if (format === 'pdf' || format === 'djvu' || format === 'djv') {
        if (pages != null && pages < 40) return 'document'
        if (pages == null && size < 400 * 1024) return 'document'
        if (DOC_WORDS.test(title) && (pages == null || pages < 120)) return 'document'
    }
    return 'book'
}

// ---------- combine everything into one clean record ----------
export function normalizeMeta(raw, filename, format) {
    raw ??= {}
    const fromName = parseFilename(filename)
    const isComic = ['cbz', 'cbr', 'cb7', 'cbt'].includes(format)
    let title = tidy(str(raw.title))
    // PDF titles are often junk like "Microsoft Word - doc1.docx" or a file name
    if (/^(microsoft word\s*-|microsoft powerpoint\s*-|untitled|document\d*$|layout \d+$|slide \d+$|powerpoint presentation$|presentation\d*$|title$|front ?matter$|cover$|[\d\W]+$|.*\.(docx?|pdf|indd|qxd|pptx?|tex|dvi|p65|pmd|rtf)$)/i.test(title) || title.length < 2 || (isComic && !raw.fromComicInfo)) title = ''
    // PDFs often carry a one-word leftover as their title; the file name is the better guide then
    if (format === 'pdf' && title && title.split(/\s+/).length < 2 && fromName.title.split(/\s+/).length >= 2) title = ''
    let authors = splitAuthors(raw.author)
    if (!title) { title = fromName.title || filename }
    if (!authors.length && fromName.author) authors = splitAuthors(fromName.author)
    let series = '', seriesIndex = null
    const bs = raw.belongsTo?.series
    const s0 = Array.isArray(bs) ? bs[0] : bs
    if (s0?.name) { series = tidy(str(s0.name)); seriesIndex = num(s0.position) }
    if (!series && raw.series) { series = tidy(str(raw.series)); seriesIndex = num(raw.seriesIndex) }
    if (!series) {
        const d = detectSeries(title, isComic)
        if (d) { series = d.series; seriesIndex = d.seriesIndex; title = d.title || title }
        else if (fromName.series) { series = fromName.series; seriesIndex = fromName.seriesIndex }
    } else {
        const d = detectSeries(title, false)
        if (d && d.series.toLowerCase() === series.toLowerCase()) title = d.title || title
    }
    const subjects = list(raw.subject).flatMap(s => s.split(/\s*(?:;|\/|--|,)\s*/)).map(tidy).filter(s => s && s.length < 60).slice(0, 12)
    const published = str(raw.published) || (fromName.year ? String(fromName.year) : '')
    const year = /\b(1[4-9]|20)\d\d\b/.exec(published)?.[0] ?? ''
    return {
        title: tidy(title).slice(0, 300), authors, author: authors.join(', '),
        series, seriesIndex,
        subjects, genres: mapGenres(subjects, title, isComic),
        language: str(Array.isArray(raw.language) ? raw.language[0] : raw.language).slice(0, 12),
        publisher: tidy(str(raw.publisher)).slice(0, 120), year,
        description: tidy(str(raw.description).replace(/<[^>]+>/g, ' ')).slice(0, 4000),
        identifier: tidy(str(raw.identifier)).slice(0, 80),
    }
}
