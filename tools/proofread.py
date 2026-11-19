#!/usr/bin/env python3
"""
Print Proofer for your computer: no Claude, no account, no internet needed
(after a one-time download of LanguageTool).

    python proofread.py flyer.jpg                 # photo or screenshot
    python proofread.py menu.png poster.png       # several pages
    python proofread.py --text "Their is a typo"  # plain text
    python proofread.py flyer.jpg --notes "Bella's Bakery"   # words that are always correct

Setup (once):
    pip install pytesseract pillow language-tool-python
    + install Tesseract OCR:   Windows: https://github.com/UB-Mannheim/tesseract/wiki
                               Mac: brew install tesseract   Linux: sudo apt install tesseract-ocr
    + Java 17+ (LanguageTool runs locally on it; first run downloads ~250 MB)
"""
import argparse
import calendar
import datetime as dt
import re
import sys

DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = [m.lower() for m in calendar.month_name[1:]]


def ocr(path: str) -> str:
    try:
        import pytesseract
        from PIL import Image, ImageOps
    except ImportError:
        sys.exit("Missing packages. Run: pip install pytesseract pillow")
    img = ImageOps.exif_transpose(Image.open(path)).convert("L")
    if max(img.size) < 1500:  # small screenshots read better enlarged
        img = img.resize((img.width * 2, img.height * 2))
    try:
        text = pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError:
        sys.exit("Tesseract OCR is not installed. See the setup notes at the top of this file.")
    lines = [re.sub(r"\s+", " ", l).strip() for l in text.splitlines()]
    return "\n".join(l for l in lines if len(l) > 1)


def rule_checks(text: str):
    """Checks LanguageTool doesn't do: weekday vs date, phone digits, broken emails/links."""
    issues = []
    today = dt.date.today()
    day = r"(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*\.?"
    mon = r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
    for m in re.finditer(rf"\b{day},?\s+{mon}\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?", text, re.I):
        d_idx = next(i for i, d in enumerate(DAYS) if d.startswith(m[1].lower()[:3]))
        month = next(i for i, x in enumerate(MONTHS) if x.startswith(m[2].lower()[:3])) + 1
        year = int(m[4]) if m[4] else today.year + (1 if (dt.date(today.year, month, 1) < today.replace(day=1)) else 0)
        try:
            date = dt.date(year, month, int(m[3]))
        except ValueError:
            issues.append(("error", m[0], f"{calendar.month_name[month]} doesn't have {m[3]} days."))
            continue
        if date.weekday() != d_idx:
            issues.append(("error", m[0], f"{date:%b %d, %Y} is a {date:%A}, not a {DAYS[d_idx].title()}."))
    for m in re.finditer(r"(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{2,6}\b", text):
        digits = re.sub(r"\D", "", m[0])
        n = 10 if len(digits) == 11 and digits.startswith("1") else len(digits)
        if n != 10:
            issues.append(("error", m[0].strip(), f"Phone number has {n} digits; US numbers have 10."))
    for m in re.finditer(r"[\w.+-]+@[\w.-]*", text):
        if not re.fullmatch(r"[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}", m[0].rstrip(".,;:"), re.I):
            issues.append(("error", m[0], "Email address looks incomplete."))
    for m in re.finditer(r"\b(\w+)\s+\1\b", text, re.I):
        if m[1].lower() not in {"that", "had", "bye", "no", "so", "very"}:
            issues.append(("error", m[0], "Repeated word."))
    return issues


def grammar_checks(text: str, notes: str):
    try:
        import language_tool_python
    except ImportError:
        print("(Skipping spelling/grammar: run  pip install language-tool-python  to enable it.)\n")
        return []
    tool = language_tool_python.LanguageTool("en-US")
    ok_words = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z'-]+", notes)}
    out = []
    for m in tool.check(text):
        length = getattr(m, "error_length", None) or getattr(m, "errorLength", 0)
        issue_type = getattr(m, "rule_issue_type", None) or getattr(m, "ruleIssueType", "")
        bad = text[m.offset : m.offset + length]
        if bad.lower().strip("'s") in ok_words or bad.lower() in ok_words:
            continue
        sev = "error" if issue_type in ("misspelling", "grammar") else "check"
        fix = " or ".join(m.replacements[:2])
        out.append((sev, bad, f"{m.message}" + (f"  ->  {fix}" if fix else "")))
    tool.close()
    return out


def main():
    ap = argparse.ArgumentParser(description="Proofread a photo, screenshot or text before printing.")
    ap.add_argument("images", nargs="*", help="image files (jpg, png, ...)")
    ap.add_argument("--text", help="check this text instead of / as well as images")
    ap.add_argument("--notes", default="", help="names and words that are always correct")
    ap.add_argument("--no-grammar", action="store_true", help="skip LanguageTool (OCR + fact checks only)")
    a = ap.parse_args()
    if not a.images and not a.text:
        ap.print_help()
        return

    parts = []
    for i, path in enumerate(a.images, 1):
        t = ocr(path)
        parts.append(f"[Page {i}: {path}]\n{t}" if len(a.images) > 1 else t)
    if a.text:
        parts.append(a.text)
    text = "\n\n".join(parts)

    print("=" * 60 + "\nTEXT FOUND\n" + "=" * 60 + f"\n{text or '(no text found)'}\n")
    issues = rule_checks(text) + ([] if a.no_grammar else grammar_checks(text, a.notes))
    print("=" * 60 + f"\n{len(issues)} PROBLEM(S)\n" + "=" * 60)
    for sev, bad, why in issues:
        print(f"[{'ERROR' if sev == 'error' else 'CHECK'}] \"{bad}\": {why}")
    if not issues:
        print("Looks clean. No problems found.")


if __name__ == "__main__":
    main()
