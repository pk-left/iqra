# Iqra

![Iqra's home page in the Riso print style](docs/screenshot.png)

**Iqra** (اقرأ) means *read* in Arabic. It is a book reader and library for Windows that opens almost every ebook and document format, sorts your library for you, and keeps everything on your own computer.

## Features

- **Opens nearly everything**: EPUB, PDF, MOBI, AZW/AZW3, FB2, DjVu, comics (CBZ, CBR, CB7, CBT), and documents (DOCX, DOC, ODT, RTF, TXT, Markdown, HTML).
- **Reads books where they are**: point Iqra at your folders and it finds your books without copying or moving them.
- **Sorts itself**: authors, series (in order), genres and formats are worked out from each file and its filename.
- **Comfortable reading**: paged or scrolling layout, one or two columns, and themes. You can also set fonts (including OpenDyslexic and Atkinson Hyperlegible), spacing and margins, plus a reading ruler and a warmth filter.
- **Tools while reading**: highlights and notes, bookmarks, full-text search, tap-to-define and translate, read-aloud and a word-at-a-time speed reader.
- **Reading stats**: daily goal, streaks, a yearly book goal, and a year-at-a-glance heatmap.
- **Free books**: browse and download public-domain books from inside the app.
- **Two looks**: *Riso print* (the default: two-ink print, library cards, rubber stamps, and a navy "night print" in dark mode) or *Classic*.

DRM-protected books (for example from the Kindle or Google Play stores) cannot be opened by any third-party reader, including this one.

## Download

Grab the Windows installer from the [Releases](../../releases) page.

Iqra was called Inkwell before version 1.1. If you used Inkwell, Iqra brings across your library, reading positions, highlights, stats and settings automatically the first time it opens.

## Run it from source

Requires [Node.js](https://nodejs.org/).

```bash
npm install
npm start
```

Build the Windows installer (output in `dist/`):

```bash
npm run dist
```

## Where your data lives

`%APPDATA%\Iqra`: the library, settings, highlights and stats as JSON files, plus saved covers. Your book files are never changed.

## Project layout

```
main.js              Electron main process: windows, data files, the app:// protocol, archives
preload.js           The small bridge between the window and the main process
app/
  index.html
  css/app.css        Layout and the Classic look
  css/riso.css       The Riso print look
  js/                Library, reader, sorting, stats, settings (plain JavaScript modules)
  fonts/             Bundled reading and interface fonts (SIL Open Font License / Apache 2.0)
  img/               Logo, paper textures and stamp wear for the Riso look
  vendor/            foliate-js (MIT), PDF.js (Apache 2.0), djvu-rs (MIT), mammoth (BSD), marked (MIT)
```

## License

MIT
