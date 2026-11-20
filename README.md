# Print Proofer

An Android app (and installable web app) that reads text with your phone's camera:

| Tab | What it does |
|---|---|
| **✔ Proof** | Take a photo or screenshot of anything before it goes to print. It flags spelling mistakes, grammar slips, a weekday that doesn't match the date, a phone number missing a digit, broken emails or links, bad UPC/EAN check digits, and the same name or number written two ways. Each problem shows as *wrong → right*. **QR codes and barcodes** on the proof are scanned and tested: does the link load, does it match the address printed beside it, does the phone in the code match the printed one, does the number under a barcode match the bars. **Read aloud** speaks the proof with the current word highlighted (the old proofreader's trick for missing and doubled words). |
| **🗂️ Screenshots** | *Screenshot memory.* Every screenshot on the phone is read and made searchable, then filed automatically as a 🧾 receipt (with its total), a 📦 tracking number (with a Track button), 💻 a code snippet, or other. New screenshots can be indexed in the background about once an hour. With **Warn me about mistakes in new screenshots** on, each new screenshot is checked seconds after it's taken and a notification lists any likely mistakes; tap it to open the full check. **Proof it** on any screenshot does the same by hand. |
| **🎬 Video** | Pull on-screen text out of a video (tutorials, ads, screen recordings): tool and product names, typed prompts, prices, offers, promo codes and links, each with its timestamp. These are the things transcripts miss. |
| **🎨 Colors** | Pull the palette out of a logo, flyer or photo: each colour with HEX, RGB and CMYK, how much of the image it covers, a plain name, and print notes (bright screen colours that will print duller, near-blacks that need a rich black). Tap the picture to sample any spot. |
| **📈 Competitors** | Photograph competitors' ads, flyers, menus and storefront signs over time. Prices, offers and promo codes are pulled out, and the app shows what changed since the last capture. |

## Works without Claude

Everything runs **on the phone, free, with no account**:

- **Text recognition**: Google ML Kit inside the Android app (the model is bundled, so it works offline). The browser version uses Tesseract instead.
- **Proofreading**: a Hunspell English dictionary plus built-in rules for the mistakes that matter most in print.
- **Optional extras** (off by default):
  - *Extra grammar check online*: LanguageTool's free public service, no account. It sends the text to languagetool.org.
  - *Claude deep check*: the most thorough option. It also reads layout problems and context. It needs your own Anthropic API key and costs a few cents per check.

Nothing is uploaded unless you turn on one of those two extras. Screenshot text, competitor captures and history all stay on the phone.

## Install on Android

**Option A: download the APK.** Every push to `main` builds the app and publishes it on this repo's **Releases → latest** page as `PrintProofer.apk`. On your phone, download it, tap it, and allow "install from this source" when Android asks.

**Option B: build it yourself.** You need Node 22, Java 21 and the Android SDK:

```bash
npm install
npm run android:apk      # → android/app/build/outputs/apk/debug/app-debug.apk
```

Every build is signed with the same key (`android/app/debug.keystore`), so a new APK installs over the old one and keeps your data. This key is a non-secret debug key meant for personal sideloading. Before publishing to the Play Store, switch to a private release key.

### First run

1. **Proof**: tap *Take photo* or *Upload*, then *Check for mistakes*. Or, in your Gallery, tap **Share → Print Proofer**.
2. **Screenshots**: tap *Scan new screenshots* and allow photo access. To keep it up to date automatically, turn on *Index new screenshots automatically* in ⚙︎ Settings.
3. ⚙︎ **Settings → Always-on notes**: list your business name, phone and website. They are never flagged as typos, and anything that doesn't match them stands out.

## Proofread on a computer (Python, no Claude)

`tools/proofread.py` does the same proofreading on a PC or Mac. It uses Tesseract for the OCR and LanguageTool, running locally, for spelling and grammar:

```bash
pip install pytesseract pillow language-tool-python
python tools/proofread.py flyer.jpg --notes "Bella's Bakery"
```

You also need Tesseract and Java; the setup notes are at the top of the script.

## Colour palettes on a computer (Python)

`tools/palette.py` gives the same palette as the Colors tab, from the command line:

```bash
pip install pillow
python tools/palette.py logo.png                   # table with swatches, HEX, CMYK, notes
python tools/palette.py flyer.jpg -n 8 --no-background --html palette.html   # printable swatch sheet
python tools/palette.py logo.png --json            # for other tools
```

## Hotfolder: proof every file dropped in a folder (Python)

`tools/hotfolder.py` watches a folder. Every PDF or image dropped into it is proofread, its QR codes and
barcodes checked, and (for PDFs) preflighted: images under 300 dpi, missing bleed, page size. A report is
written to `checked/<file>.report.html` (plus `.json`), and the original moves to `done/`.

```bash
pip install pillow pypdfium2 zxing-cpp pytesseract language-tool-python
python tools/hotfolder.py ~/Proofs                       # keep watching (Ctrl+C to stop)
python tools/hotfolder.py ~/Proofs --once --keep         # check what's there now, leave files in place
```

## Web version

The same app runs in a browser and can be installed from Chrome (**⋮ → Add to Home screen**). The `deploy.yml` workflow publishes it to GitHub Pages. Background screenshot indexing only works in the Android app; in the browser you add screenshots by hand.

## Development

```bash
npm run dev            # web app at http://localhost:5173 (also on your Wi-Fi)
npm run build          # type-check + build to dist/
npm run android:sync   # build + copy into the Android project
```

| Path | What it is |
|---|---|
| `src/offline.ts` | Offline proofreader: dictionary + rules (dates, phones, emails, a/an, doubled words, …) |
| `src/extract.ts` | Prices, offers, promo codes, links, tracking numbers; screenshot auto-filing; competitor diffs |
| `src/ocr.ts` | OCR: ML Kit on Android, Tesseract in the browser |
| `src/proof.ts` | Optional Claude deep check and video summary |
| `src/pages/*` | The four tabs |
| `android/app/src/main/java/com/printproofer/app/` | Native code: ML Kit OCR, screenshot indexer (SQLite), hourly background worker, share-sheet handling |
| `src/palette.ts` | Colour palette extraction (k-means in Lab, blend filtering, CMYK, print notes) |
| `tools/proofread.py` | Desktop proofreader in Python |
| `tools/palette.py` | Desktop colour palette extractor in Python |
| `tools/hotfolder.py` | Folder watcher: proofreads, checks codes and preflights every file dropped in |
| `src/codes.ts` | QR / barcode reading (ML Kit on Android, ZXing in the browser) and checks |
| `src/speech.ts` | Read aloud (Android text-to-speech, Web Speech in the browser) |
| `android/.../QuickCheck.java` | The fast checks run on new screenshots in the background |
