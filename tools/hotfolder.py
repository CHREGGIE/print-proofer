#!/usr/bin/env python3
"""
Print Proofer hotfolder: drop files in a folder, get a proof report for each. No Claude needed.

    python hotfolder.py ~/Proofs                 # watch the folder (Ctrl+C to stop)
    python hotfolder.py ~/Proofs --once          # check what's there now, then exit
    python hotfolder.py ~/Proofs --notes "Bella's Bakery, bellasbakery.com"

For every PDF or image (jpg, png, tif, webp) that lands in the folder it:
  * proofreads the text: spelling and grammar (LanguageTool, local), wrong weekday for a date,
    phone numbers with the wrong number of digits, broken emails, bad UPC/EAN check digits
  * finds every QR code and barcode and checks it: does the link load, does it match the address
    printed beside it, does the phone in the code match the printed phone, is the barcode valid
  * PDFs only: print preflight (images under 300 dpi, no bleed, page size)
and writes  checked/<file>.report.html  (open it in a browser, or print it) and a .json next to it.
The original is moved to  done/  so the folder stays a to-do list (use --keep to leave it).

Setup (once):
    pip install pillow pypdfium2 zxing-cpp pytesseract language-tool-python
    + Tesseract OCR for images and scanned PDFs, and Java for LanguageTool (see proofread.py)
"""
import argparse
import html
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proofread import ocr, rule_checks, grammar_checks  # noqa: E402

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp"}
SHORTENERS = re.compile(r"^(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|t\.co|rebrand\.ly|is\.gd|buff\.ly|cutt\.ly|qrco\.de|linktr\.ee)$", re.I)


# ---------------------------------------------------------------- reading files

def read_pdf(path: Path):
    """Text, rendered pages (for codes and scanned pages) and preflight notes from a PDF."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        sys.exit("Missing package. Run: pip install pypdfium2")
    pdf = pdfium.PdfDocument(str(path))
    texts, images, preflight = [], [], []
    for i, page in enumerate(pdf, 1):
        w_pt, h_pt = page.get_size()
        label = f"Page {i}" if len(pdf) > 1 else "Page"
        text = page.get_textpage().get_text_range().replace("\r\n", "\n").strip()
        bitmap = page.render(scale=200 / 72).to_pil()  # 200 dpi: enough for codes and OCR
        if not text:  # scanned PDF: no text layer, read it like a photo
            tmp = path.parent / f".{path.stem}.p{i}.png"
            bitmap.save(tmp)
            text = ocr(str(tmp))
            tmp.unlink(missing_ok=True)
            preflight.append(("info", f"{label}: no text layer (scanned), so the text was read by OCR."))
        texts.append(text)
        images.append(bitmap)

        # Bleed: a print-ready PDF has a bleed box bigger than its trim box.
        trim, bleed = page.get_trimbox(), page.get_bleedbox()
        if all(abs(a - b) < 0.5 for a, b in zip(trim, bleed)):
            preflight.append(("warn", f"{label}: no bleed. Anything printed to the edge may show a white sliver after trimming (add 0.125 in / 3 mm)."))
        preflight.append(("info", f"{label}: {w_pt / 72:.2f} × {h_pt / 72:.2f} in ({w_pt / 72 * 25.4:.0f} × {h_pt / 72 * 25.4:.0f} mm)."))

        # Image resolution as placed on the page.
        for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE], max_depth=3):
            try:
                meta = obj.get_metadata()
                dpi = min(meta.horizontal_dpi, meta.vertical_dpi)
                px = f"{meta.width}×{meta.height}px"
            except Exception:
                continue
            if dpi and dpi < 150:
                preflight.append(("bad", f"{label}: an image ({px}) is only {dpi:.0f} dpi. It will print blurry; use 300 dpi."))
            elif dpi and dpi < 290:
                preflight.append(("warn", f"{label}: an image ({px}) is {dpi:.0f} dpi. 300 dpi is the print standard."))
    pdf.close()  # release the file before it's moved to done/
    return "\n\n".join(f"[{('Page ' + str(i + 1))}]\n{t}" if len(texts) > 1 else t for i, t in enumerate(texts)), images, preflight


def read_image(path: Path):
    from PIL import Image, ImageOps
    return ocr(str(path)), [ImageOps.exif_transpose(Image.open(path)).convert("RGB")], []


# ---------------------------------------------------------------- QR codes and barcodes

_online = None


def internet_up() -> bool:
    global _online
    if _online is None:
        try:
            urllib.request.urlopen(urllib.request.Request("https://www.google.com", method="HEAD"), timeout=5)
            _online = True
        except Exception:
            _online = False
    return _online


def link_loads(url: str):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0 (print proof link check)"})
    try:
        urllib.request.urlopen(req, timeout=8)
        return True
    except urllib.error.HTTPError as e:
        return e.code < 500 and e.code != 404  # 403/405 for HEAD still means the site is there
    except Exception:
        return None if not internet_up() else False


def gs1_valid(d: str) -> bool:
    body = [int(x) for x in d[:-1]][::-1]
    return (10 - sum(n * (3 if i % 2 == 0 else 1) for i, n in enumerate(body)) % 10) % 10 == int(d[-1])


def host(u: str) -> str:
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/:?#]+)", u.strip(), re.I)
    return m.group(1).lower() if m else ""


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def check_codes(images, printed: str, test_links: bool):
    try:
        import zxingcpp
    except ImportError:
        return [{"format": "-", "raw": "", "checks": [("info", "QR/barcode check skipped: pip install zxing-cpp")]}]
    hosts = {host(m) for m in re.findall(r"\b(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|shop|store|biz|info|app)\b", printed, re.I)}
    hosts |= {e.split("@")[1].lower() for e in re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", printed)}
    phones = {re.sub(r"\D", "", p)[-10:] for p in re.findall(r"\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b", printed)}

    seen, reports = set(), []
    for img in images:
        for r in zxingcpp.read_barcodes(img):
            raw = r.text.strip()
            if not raw or raw in seen:
                continue
            seen.add(raw)
            fmt = str(r.format).split(".")[-1].replace("QRCode", "QR").replace("EAN13", "EAN-13").replace("UPCA", "UPC-A").replace("EAN8", "EAN-8")
            checks = [("ok", "Scans cleanly.")]
            if fmt in ("EAN-13", "UPC-A", "EAN-8", "UPCE") or (fmt != "QR" and raw.isdigit() and len(raw) in (8, 12, 13)):
                checks.append(("ok", "Check digit is valid.") if gs1_valid(raw) else ("bad", "Check digit is wrong: shop scanners will reject it."))
                runs = [re.sub(r"\D", "", m) for m in re.findall(r"\d[\d ]{6,18}\d", printed)]
                runs = [d for d in runs if abs(len(d) - len(raw)) <= 1]
                if runs and not any(d in (raw, raw[1:]) or "0" + d == raw for d in runs):
                    checks.append(("bad", f"The number printed under the bars ({runs[0]}) doesn't match the code ({raw})."))
            elif raw.lower().startswith("tel:"):
                p = re.sub(r"\D", "", raw)[-10:]
                if phones and p not in phones:
                    checks.append(("bad", f"The code dials {p}, but the printed number is {sorted(phones)[0]}."))
                else:
                    checks.append(("ok", f"Dials {p}."))
            elif re.match(r"^(https?://|www\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$", raw, re.I):
                url = raw if re.match(r"^https?://", raw, re.I) else "https://" + raw
                h = host(url)
                if url.lower().startswith("http://"):
                    checks.append(("warn", "Uses http, not https: some phones warn the page isn't secure."))
                if SHORTENERS.match(h):
                    checks.append(("warn", f"Short link ({h}): confirm where it goes and that it won't expire."))
                if hosts and h not in hosts:
                    near = next((p for p in hosts if edit_distance(p, h) <= 2), None)
                    checks.append(("bad", f"Typo: the code goes to {h} but the printed address is {near}.") if near
                                  else ("warn", f"The code goes to {h}, but the printed address is {', '.join(sorted(hosts))}."))
                elif hosts:
                    checks.append(("ok", f"Goes to {h}, same as printed."))
                if test_links:
                    ok = link_loads(url)
                    checks.append(("ok", "The link loads.") if ok else ("bad", "The link doesn't load.") if ok is False else ("info", "Couldn't test the link (no internet)."))
            else:
                checks.append(("info", "Plain text, not a link."))
            reports.append({"format": fmt, "raw": raw, "checks": checks})
    return reports


# ---------------------------------------------------------------- report

def verdict(issues, codes, preflight):
    bad = sum(1 for s, *_ in issues if s == "error") + sum(1 for c in codes for s, _ in c["checks"] if s == "bad") + sum(1 for s, _ in preflight if s == "bad")
    warn = sum(1 for s, *_ in issues if s != "error") + sum(1 for c in codes for s, _ in c["checks"] if s == "warn") + sum(1 for s, _ in preflight if s == "warn")
    return bad, warn


def write_report(src: Path, out_dir: Path, text, issues, codes, preflight):
    bad, warn = verdict(issues, codes, preflight)
    stamp = ("NOT READY", "HOLD THE PRESS", "#ec008c") if bad else ("CHECK FIRST", "THEN PRINT", "#141414") if warn else ("APPROVED", "OK TO PRINT", "#0090c8")
    esc = html.escape
    mark = {"ok": "✓", "warn": "!", "bad": "✕", "info": "i", "error": "✕", "check": "!"}
    rows = "".join(f'<li class="{s}"><b>{mark.get(s, "!")}</b><span><q>{esc(o)}</q> {esc(w)}</span></li>' for s, o, w in issues)
    code_html = "".join(
        f'<div class="code"><span class="tag">{esc(c["format"])}</span> <code>{esc(c["raw"])}</code><ul>'
        + "".join(f'<li class="{s}"><b>{mark[s]}</b>{esc(t)}</li>' for s, t in c["checks"]) + "</ul></div>" for c in codes)
    pre_html = "".join(f'<li class="{s}"><b>{mark[s]}</b>{esc(t)}</li>' for s, t in preflight)
    doc = f"""<!doctype html><meta charset="utf-8"><title>Proof · {esc(src.name)}</title>
<style>body{{margin:0;padding:32px;background:#121212;color:#fff;font:15px/1.5 system-ui,sans-serif;max-width:860px}}
h1,h2{{font-family:Impact,'Arial Narrow',sans-serif;font-weight:400;text-transform:uppercase;margin:28px 0 10px}}h1{{font-size:40px;margin:0}}
.cmyk{{display:flex;height:8px;margin:12px 0 24px}}.cmyk i{{flex:1}}
.sheet{{background:#f7f5ef;color:#141414;padding:24px;position:relative}}.big{{font:132px/0.82 Impact,sans-serif}}
.stamp{{position:absolute;right:24px;top:28px;transform:rotate(-9deg);border:4px solid {stamp[2]};color:{stamp[2]};font:26px/1 Impact,sans-serif;padding:8px 10px;text-align:center}}
.stamp small{{display:block;font-size:13px;letter-spacing:.14em}}ul{{list-style:none;padding:0;margin:0}}li{{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:6px 0;border-top:1px solid #2c2c2c}}
b{{font-family:monospace}}.ok b{{color:#00aeef}}.warn b,.check b{{color:#fff200}}.bad b,.error b{{color:#ff5cb8}}.bad,.error{{font-weight:600}}.info{{color:#a3a3a3}}
q{{color:#ff5cb8}}.code{{background:#1c1c1c;padding:14px 16px;margin-bottom:10px}}.tag{{background:#ec008c;padding:2px 8px;font:13px Impact,sans-serif;letter-spacing:.06em}}
code{{word-break:break-all}}pre{{white-space:pre-wrap;background:#f7f5ef;color:#141414;padding:20px;font:15px/1.8 system-ui}}p.meta{{color:#a3a3a3}}</style>
<h1>Proof report</h1><p class="meta">{esc(src.name)} · {time.strftime("%b %d, %Y %H:%M")}</p>
<div class="cmyk"><i style="background:#00aeef"></i><i style="background:#ec008c"></i><i style="background:#fff200"></i><i style="background:#fff"></i></div>
<div class="sheet"><div class="big">{bad or warn}</div><div style="font:30px Impact,sans-serif;text-transform:uppercase;margin-top:12px">
{"mistakes to fix before it prints" if bad else "things to check before it prints" if warn else "mistakes found. ready to print."}</div>
<div class="stamp">{stamp[0]}<small>{stamp[1]}</small></div></div>
{f"<h2>QR &amp; barcodes</h2>{code_html}" if codes else ""}
{f"<h2>Preflight</h2><ul>{pre_html}</ul>" if preflight else ""}
<h2>Corrections</h2><ul>{rows or '<li class="ok"><b>✓</b>Nothing to correct.</li>'}</ul>
<h2>Text as printed</h2><pre>{esc(text) or "(no text found)"}</pre>"""
    out_dir.mkdir(exist_ok=True)
    report = out_dir / f"{src.name}.report.html"
    report.write_text(doc, encoding="utf-8")
    (out_dir / f"{src.name}.report.json").write_text(json.dumps({
        "file": src.name, "mistakes": bad, "to_check": warn,
        "issues": [{"severity": s, "text": o, "why": w} for s, o, w in issues],
        "codes": codes, "preflight": [{"severity": s, "text": t} for s, t in preflight], "text": text,
    }, indent=2), encoding="utf-8")
    return report, bad, warn


# ---------------------------------------------------------------- the folder

def process(path: Path, a) -> None:
    ext = path.suffix.lower()
    try:
        text, images, preflight = read_pdf(path) if ext == ".pdf" else read_image(path)
    except SystemExit:
        raise
    except Exception as e:
        print(f"  ✕ {path.name}: couldn't read it ({e})")
        return
    issues = rule_checks(text)
    if not a.no_grammar:
        # LanguageTool repeats some of the built-in checks (dates, doubled words): keep one of each.
        ours = [o for _, o, _ in issues]
        issues += [g for g in grammar_checks(text, a.notes) if not any(g[1] in o or o in g[1] for o in ours)]
    codes = check_codes(images, text, test_links=not a.no_links)
    report, bad, warn = write_report(path, path.parent / "checked", text, issues, codes, preflight)
    status = "\033[95m✕ NOT READY\033[0m" if bad else "\033[93m! CHECK FIRST\033[0m" if warn else "\033[96m✓ APPROVED\033[0m"
    print(f"  {status}  {path.name}  ({bad} mistakes, {warn} to check)  → {report}")
    if not a.keep:
        done = path.parent / "done"
        done.mkdir(exist_ok=True)
        shutil.move(str(path), done / path.name)


def pending(folder: Path, seen):
    for p in sorted(folder.iterdir()):
        if p.is_file() and not p.name.startswith(".") and (p.suffix.lower() == ".pdf" or p.suffix.lower() in IMAGE_EXT) and p not in seen:
            yield p


def stable(p: Path, wait=1.5) -> bool:
    """Don't read a file that's still being copied in."""
    try:
        a = p.stat().st_size
        time.sleep(wait)
        return a == p.stat().st_size and a > 0
    except FileNotFoundError:
        return False


def main():
    ap = argparse.ArgumentParser(description="Watch a folder and proof every PDF or image dropped into it.")
    ap.add_argument("folder")
    ap.add_argument("--once", action="store_true", help="check the files there now, then exit")
    ap.add_argument("--keep", action="store_true", help="leave originals in place (don't move them to done/)")
    ap.add_argument("--notes", default="", help="names and words that are always correct")
    ap.add_argument("--no-grammar", action="store_true", help="skip LanguageTool (spelling/grammar)")
    ap.add_argument("--no-links", action="store_true", help="don't open QR links to test them")
    ap.add_argument("--interval", type=float, default=3.0, help="seconds between looks at the folder")
    a = ap.parse_args()

    folder = Path(a.folder).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    print(f"Print Proofer hotfolder: {folder}\n  reports → {folder / 'checked'}" + ("" if a.keep else f"\n  originals → {folder / 'done'}"))
    seen = set()
    try:
        while True:
            for p in pending(folder, seen):
                if stable(p, 0 if a.once else 1.5):
                    print(f"\n{time.strftime('%H:%M:%S')}  checking {p.name}…")
                    process(p, a)
                    seen.add(p)
            if a.once:
                break
            time.sleep(a.interval)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
