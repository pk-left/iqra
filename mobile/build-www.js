// Builds the Android web bundle (www/) from the desktop app's web code. Desktop files are never changed.
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'app');
const OUT = path.join(__dirname, 'www');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true, filter: (p) => !/\.bak/.test(path.basename(p)) && !/selftest\.js$/.test(p) });
for (const f of ['pk-sync.js', 'android-api.js', 'mobile.css']) fs.copyFileSync(path.join(__dirname, 'src', f), path.join(OUT, f));
// 7-Zip (WebAssembly) for .cbr / .cb7 comics
const sz = path.join(__dirname, '..', 'node_modules', '7z-wasm');
fs.mkdirSync(path.join(OUT, 'vendor', '7z'), { recursive: true });
for (const f of ['7zz.es6.js', '7zz.wasm', 'License.txt', 'unRarLicense.txt']) fs.copyFileSync(path.join(sz, f), path.join(OUT, 'vendor', '7z', f));

const sub = (file, from, to) => {
  const p = path.join(OUT, file);
  const s = fs.readFileSync(p, 'utf8');
  if (!s.includes(from)) throw new Error(`${file}: could not find ${from}`);
  fs.writeFileSync(p, s.split(from).join(to));
};
// app:// URLs from the desktop build -> Android file URLs
sub('js/formats.js', '`app://iqra/_file?p=${encodeURIComponent(p)}`', 'window.__fileSrc(p)');
sub('js/store.js', '`app://iqra/_cover/${b.id}.jpg?v=${b.cover}`', '`${window.__coverSrc(b.id)}?v=${b.cover}`');
sub('js/reader.js', 'app://iqra/fonts/', '${location.origin}/fonts/');

// phone wording (soft: skipped if the desktop text changes)
const soft = (file, from, to) => { try { sub(file, from, to) } catch (e) { console.warn('wording not changed:', e.message) } };
soft('js/app.js', 'Tips: drag files or folders into the window to add more, right-click any book for options, and press S while reading to change how the page looks.',
  'Tips: tap + to add books from anywhere on your phone, press and hold any book for options, and tap the edges of the page to turn it.');
soft('js/library.js', 'Add books with the + button, or drag files and folders into this window.', 'Add books with the + button, or put them in your Download, Documents or Books folder.');
for (const f of ['js/pages.js', 'js/settings.js', 'js/study.js']) {
  const p = path.join(OUT, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/right-click/g, 'press and hold').replace(/Right-click/g, 'Press and hold'));
}

let html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
html = html.replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">');
html = html.replace('<link rel="stylesheet" href="css/themes.css">', '<link rel="stylesheet" href="css/themes.css">\n<link rel="stylesheet" href="mobile.css">');
html = html.replace('<script type="module" src="js/app.js"></script>', '<script src="pk-sync.js"></script>\n<script src="android-api.js"></script>\n<script type="module" src="js/app.js"></script>');
if (!html.includes('android-api.js') || !html.includes('mobile.css')) throw new Error('index.html changed shape');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('www built from', SRC);
