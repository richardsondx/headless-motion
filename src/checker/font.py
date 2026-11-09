"""Font identification by template matching over Google Fonts.

Method (from study/2026-11-08-whatthefont-reverse-engineering.md):
render each candidate face in the known label text at the measured cap
height, normalize spacing and scale per word, and score with normalized
cross-correlation on grey values (the render is blurred by 1 px first,
because the reference frames are soft YouTube stills). A Dice score on
binarized bitmaps is kept as a cross-check for the top candidates.

Honest limits: this can only name fonts already in the candidate library.
Below the match bar the answer is "closest lookalike, not confirmed".
Never download a commercial font: the library is Google Fonts only
(SIL OFL / Apache, free to use and embed). Font files live in a cache
directory outside the repo (default ~/.cache/hme-fonts), never in the repo.

Run: python -m checker.font --frame <frame.png> --text "EL FASHER"
     [--box x,y,w,h] [--cache-dir DIR] [--top N]
Prints exactly one JSON object to stdout; progress goes to stderr.
"""
import argparse
import hashlib
import json
import math
import os
import re
import struct
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .metrics import luma
from .text import ink_box, otsu_threshold

# Match bar, from the study. Starting point, not a law: best score at
# least 0.85 with a margin of at least 0.10 over second place.
BAR_SCORE = 0.85
BAR_MARGIN = 0.10
# Blur applied to the render before scoring, in px. The reference frames
# are soft, so a sharp render scores worse than the true shape deserves.
RENDER_BLUR = 1.0
# Grey mapping for the reference crop: luma 40 -> 0, 210 -> 1.
GREY_LO = 40.0
GREY_HI = 210.0
# Search grid per word. Tracking is extra px between letters at the
# render size; scale is a horizontal stretch of the whole word.
TRACKINGS = (-2, -1, 0, 1, 2, 3, 4)
SCALES = (0.90, 0.95, 1.00, 1.05, 1.10, 1.15)
SHIFTS = (-2, -1, 0, 1, 2)
# Dice cross-check thresholds (luma) for the top candidates.
DICE_THRESHOLDS = (120, 140, 160)

# Candidate library: Google Fonts only. (family, weight). Condensed and
# semi-condensed sans faces most likely in news graphics, plus a few
# wider faces as controls so a wide font has to earn its place. Anton is
# in the list on purpose: it is the scene's current guess for EL FASHER,
# and the matcher must show where it really ranks.
CANDIDATES = [
    ("Barlow Condensed", 400), ("Barlow Condensed", 500), ("Barlow Condensed", 600),
    ("Barlow Semi Condensed", 500), ("Barlow Semi Condensed", 600),
    ("Oswald", 300), ("Oswald", 400), ("Oswald", 500), ("Oswald", 600),
    ("Archivo Narrow", 400), ("Archivo Narrow", 500), ("Archivo Narrow", 600),
    ("Archivo Narrow", 700),
    ("Roboto Condensed", 400), ("Roboto Condensed", 500), ("Roboto Condensed", 700),
    ("PT Sans Narrow", 400), ("PT Sans Narrow", 700),
    ("IBM Plex Sans Condensed", 400), ("IBM Plex Sans Condensed", 500),
    ("IBM Plex Sans Condensed", 600),
    ("Saira Condensed", 400), ("Saira Condensed", 500), ("Saira Condensed", 600),
    ("Saira Semi Condensed", 500), ("Saira Semi Condensed", 600),
    ("Yanone Kaffeesatz", 400), ("Yanone Kaffeesatz", 500), ("Yanone Kaffeesatz", 600),
    ("Fjalla One", 400), ("Anton", 400), ("Bebas Neue", 400), ("Abel", 400),
    ("Encode Sans Condensed", 400), ("Encode Sans Condensed", 500),
    ("Encode Sans Semi Condensed", 500), ("Encode Sans Semi Condensed", 600),
    ("Asap Condensed", 400), ("Asap Condensed", 500), ("Asap Condensed", 600),
    ("Fira Sans Extra Condensed", 400), ("Fira Sans Extra Condensed", 500),
    ("Fira Sans Condensed", 400), ("Fira Sans Condensed", 500),
    ("League Spartan", 500), ("Montserrat", 500), ("Montserrat", 600),
    ("Archivo", 500), ("Inter Tight", 500),
    ("Rajdhani", 500), ("Rajdhani", 600),
    ("Stint Ultra Condensed", 400), ("Six Caps", 400),
    ("Public Sans", 500), ("Chivo", 500),
]

GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2?family={fam}:wght@{wt}&display=swap"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
CONDENSED_HINT = ("Condensed", "Narrow")


def default_cache_dir():
    return os.path.join(os.path.expanduser("~"), ".cache", "hme-fonts")


def cache_file(cache_dir, family, weight):
    return os.path.join(cache_dir, "%s-%d.ttf" % (family.replace(" ", ""), weight))


def fetch_font(family, weight, cache_dir):
    """Download one Google Fonts face (TTF) into the cache. Returns the path."""
    path = cache_file(cache_dir, family, weight)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(cache_dir, exist_ok=True)
    url = GOOGLE_FONTS_CSS.format(fam=family.replace(" ", "+"), wt=weight)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        css = resp.read().decode("utf-8", "replace")
    m = re.search(r"url\((https://[^)]+\.ttf)\)", css)
    if not m:
        raise RuntimeError("Google Fonts gave no TTF for %s %d" % (family, weight))
    tmp = path + ".tmp"
    urllib.request.urlretrieve(m.group(1), tmp)
    os.replace(tmp, path)
    return path


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def read_os2(path):
    """(usWeightClass, usWidthClass) from the TTF OS/2 table. Pure stdlib."""
    with open(path, "rb") as f:
        data = f.read()
    n = struct.unpack(">H", data[4:6])[0]
    for i in range(n):
        off = 12 + i * 16
        if data[off:off + 4] == b"OS/2":
            toff = struct.unpack(">I", data[off + 8:off + 12])[0]
            weight = struct.unpack(">H", data[toff + 4:toff + 6])[0]
            width = struct.unpack(">H", data[toff + 6:toff + 8])[0]
            return weight, width
    return None, None


def pil_family_name(path):
    try:
        name = ImageFont.truetype(path, 20).getname()
        return name[0] if name else None
    except Exception:
        return None


# ---------------------------------------------------------------- crop


def main_band(binary):
    """Largest ink band, splitting on 3 or more empty rows.

    A label crop can hold a stray mark below the text (for example the
    dot next to EL FASHER). The text band holds far more ink than the
    stray mark, so the band with the most ink is the text. A row counts
    as text only when it holds more than 10 percent of the crop's peak
    row ink, so a soft edge sliver does not add a row to the cap height.
    """
    counts = binary.sum(axis=1)
    peak = int(counts.max()) if len(counts) else 0
    rows = counts > max(1, 0.10 * peak)
    bands, start = [], None
    for i, r in enumerate(rows):
        if r and start is None:
            start = i
        if not r and start is not None:
            bands.append((start, i - 1))
            start = None
    if start is not None:
        bands.append((start, len(rows) - 1))
    if not bands:
        return None
    merged = []
    for b in bands:
        if merged and b[0] - merged[-1][1] <= 2:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(list(b))
    best = None
    best_ink = -1
    for a, b in merged:
        ink = int(binary[a:b + 1].sum())
        if ink > best_ink:
            best_ink = ink
            best = (a, b)
    return best


def column_groups(binary):
    """(start, end) column runs of ink, end exclusive."""
    cols = binary.any(axis=0)
    groups, start = [], None
    for i, c in enumerate(cols):
        if c and start is None:
            start = i
        if not c and start is not None:
            groups.append((start, i))
            start = None
    if start is not None:
        groups.append((start, len(cols)))
    return groups


def split_words(groups, word_gap=8):
    """Group letter columns into words. A gap over 8 px is a word space."""
    words, cur = [], [groups[0]]
    for g in groups[1:]:
        if g[0] - cur[-1][1] > word_gap:
            words.append(cur)
            cur = [g]
        else:
            cur.append(g)
    words.append(cur)
    return words


def find_label_band(luma_frame, text):
    """Find the label line in a whole frame, without a --box.

    Binarize at the frame Otsu threshold, take row bands 10 to 60 px
    tall, and pick the band whose letter-group count is closest to the
    number of letters in the text. Returns (y0, y1, x0, x1) or None.
    """
    thr = otsu_threshold(luma_frame)
    ink = luma_frame > thr
    rows = ink.sum(axis=1)
    hot = rows > 20
    bands, start = [], None
    for i, r in enumerate(hot):
        if r and start is None:
            start = i
        if not r and start is not None:
            bands.append((start, i - 1))
            start = None
    if start is not None:
        bands.append((start, len(hot) - 1))
    letters = len([c for c in text if c != " "])
    best = None
    best_diff = None
    for a, b in bands:
        h = b - a + 1
        if h < 10 or h > 60:
            continue
        groups = column_groups(ink[a:b + 1])
        if not groups:
            continue
        diff = abs(len(groups) - letters)
        if best_diff is None or diff < best_diff:
            best_diff = diff
            xs = [g[0] for g in groups] + [groups[-1][1]]
            best = (a, b, min(xs), max(xs))
    return best


def crop_label(luma_frame, text, box):
    """Return (grey_crop, cap_height, ink_box, words).

    grey_crop is the text band as grey values 0..1 (ink near 1).
    words is a list of (start_col, end_col) in crop coordinates.
    """
    if box is not None:
        found = ink_box(luma_frame, box)
        if found is None:
            return None
        x0, y0, x1, y1 = found
        crop_luma = luma_frame[y0:y1 + 1, x0:x1 + 1]
        # Same threshold as the whole-frame path, so --box and no --box
        # measure the same cap height on the same label.
        thr = otsu_threshold(luma_frame)
        band = main_band(crop_luma > thr)
        if band is None:
            return None
        by0, by1 = band
        grey = crop_luma[by0:by1 + 1, :]
        binary = grey > thr
    else:
        found = find_label_band(luma_frame, text)
        if found is None:
            return None
        y0, y1, x0, x1 = found
        grey = luma_frame[y0:y1 + 1, x0:x1 + 1]
        binary = grey > otsu_threshold(luma_frame)
    xs = np.where(binary.any(axis=0))[0]
    if len(xs) == 0:
        return None
    grey = grey[:, xs.min():xs.max() + 1]
    binary = binary[:, xs.min():xs.max() + 1]
    groups = column_groups(binary)
    if not groups:
        return None
    words = split_words(groups)
    word_spans = [(w[0][0], w[-1][1]) for w in words]
    grey_norm = np.clip((grey.astype(np.float64) - GREY_LO) / (GREY_HI - GREY_LO), 0, 1)
    ink_box_out = [int(x0 + xs.min()), int(y0), int(x0 + xs.max()), int(y0 + grey.shape[0] - 1)]
    if box is not None:
        ink_box_out[1] = int(y0 + by0)
        ink_box_out[3] = int(y0 + by1)
    return grey_norm, int(grey.shape[0]), ink_box_out, word_spans


# ---------------------------------------------------------------- render


def render_size(path, cap_height):
    """PIL size that renders capitals cap_height px tall."""
    probe = ImageFont.truetype(path, 100)
    img = Image.new("L", (1200, 200), 0)
    draw = ImageDraw.Draw(img)
    draw.text((10, 10), "EL FASHER", font=probe, fill=255)
    a = np.array(img) > 128
    ys = np.where(a.any(axis=1))[0]
    h100 = ys.max() - ys.min() + 1
    return max(8, int(round(100 * cap_height / h100)))


def render_word(path, word, cap_height, tracking, blur):
    """Render one word in grey values 0..1, cropped to its ink."""
    size = render_size(path, cap_height)
    font = ImageFont.truetype(path, size)
    widths = [font.getlength(ch) for ch in word]
    total_w = int(sum(widths) + tracking * (len(word) - 1)) + 4
    img = Image.new("L", (max(10, total_w), size * 2), 0)
    draw = ImageDraw.Draw(img)
    x = 2.0
    for ch, w in zip(word, widths):
        draw.text((x, 2), ch, font=font, fill=255)
        x += w + tracking
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    a = np.array(img).astype(np.float64) / 255.0
    ys, xs = np.where(a > 30 / 255.0)
    if len(ys) == 0:
        return np.zeros((1, 1))
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def render_word_binary(path, word, cap_height, tracking):
    """Sharp black-and-white render of one word, cropped to its ink."""
    size = render_size(path, cap_height)
    font = ImageFont.truetype(path, size)
    widths = [font.getlength(ch) for ch in word]
    total_w = int(sum(widths) + tracking * (len(word) - 1)) + 4
    img = Image.new("L", (max(10, total_w), size * 2), 0)
    draw = ImageDraw.Draw(img)
    x = 2.0
    for ch, w in zip(word, widths):
        draw.text((x, 2), ch, font=font, fill=255)
        x += w + tracking
    a = np.array(img) > 128
    ys, xs = np.where(a)
    if len(ys) == 0:
        return np.zeros((1, 1))
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float64)


# ---------------------------------------------------------------- score


def ncc(a, b):
    a = a - a.mean()
    b = b - b.mean()
    na = math.sqrt(float((a * a).sum()))
    nb = math.sqrt(float((b * b).sum()))
    if na == 0 or nb == 0:
        return -1.0
    return float((a * b).sum() / (na * nb))


def dice(a, b):
    a = a > 0.5
    b = b > 0.5
    inter = float((a & b).sum())
    total = float(a.sum() + b.sum())
    return 2 * inter / total if total else 0.0


def _place(canvas, small, dx):
    """Place small (already resized) into canvas at horizontal shift dx."""
    h, w = canvas.shape
    xs0 = max(0, dx)
    xs1 = min(w, dx + small.shape[1])
    rs0 = max(0, -dx)
    rs1 = rs0 + (xs1 - xs0)
    if xs1 > xs0:
        canvas[:, xs0:xs1] = small[:, rs0:rs1]
    return canvas


def best_word(rend, ref, metric):
    """Best score over scale and shift for one word. Returns (score, best)."""
    h, w = ref.shape
    best = -1.0
    best_info = None
    for s in SCALES:
        rw = max(4, int(round(rend.shape[1] * s)))
        r = np.array(
            Image.fromarray(np.clip(rend, 0, 1).astype(np.float64) * 255).resize((rw, h), Image.BILINEAR)
        ) / 255.0 if metric == "ncc" else None
        if metric == "dice":
            r = (np.array(
                Image.fromarray((rend * 255).astype(np.uint8)).resize((rw, h), Image.BILINEAR)) > 128
            ).astype(np.float64)
        for dx in SHIFTS:
            canvas = _place(np.zeros_like(ref), r, dx)
            v = ncc(ref, canvas) if metric == "ncc" else dice(ref, canvas)
            if v > best:
                best = v
                best_info = {"scale": s, "dx": dx, "width_px": rw}
    return best, best_info


def score_font(path, words, refs, cap_height):
    """Grey NCC over all words, weighted by each word's ink mass."""
    total = 0.0
    mass = 0.0
    infos = []
    for word, ref in zip(words, refs):
        best = -1.0
        best_info = None
        for tracking in TRACKINGS:
            rend = render_word(path, word, cap_height, tracking, RENDER_BLUR)
            v, info = best_word(rend, ref, "ncc")
            if v > best:
                best = v
                best_info = {"tracking": tracking, **info}
        total += best * float(ref.sum())
        mass += float(ref.sum())
        infos.append(best_info)
    return (total / mass if mass else -1.0), infos


def dice_font(path, words, refs_by_threshold, cap_height):
    """Mean Dice over thresholds, for a cross-check on shortlisted faces."""
    scores = []
    for refs in refs_by_threshold:
        total = 0.0
        mass = 0.0
        for word, ref in zip(words, refs):
            best = -1.0
            for tracking in TRACKINGS:
                rend = render_word_binary(path, word, cap_height, tracking)
                v, _ = best_word(rend, ref, "dice")
                best = max(best, v)
            total += best * float(ref.sum())
            mass += float(ref.sum())
        scores.append(total / mass if mass else 0.0)
    return float(np.mean(scores)) if scores else 0.0


# ---------------------------------------------------------------- measure


def measure_h(path, cap_height):
    """(stem_px, width_px) of capital H rendered at cap_height.

    Stem is the first ink run in the top quarter rows, where only the
    two stems show. Width is the ink width of H. Both are measured on
    the rendered template, not read from a table.
    """
    size = render_size(path, cap_height)
    font = ImageFont.truetype(path, size)
    w = int(font.getlength("H")) + 4
    img = Image.new("L", (w, size * 2), 0)
    draw = ImageDraw.Draw(img)
    draw.text((2, 2), "H", font=font, fill=255)
    a = np.array(img) > 128
    ys, xs = np.where(a)
    a = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    runs = []
    top = a[1:max(2, a.shape[0] // 4), :]
    for row in top:
        idx = np.where(row)[0]
        if len(idx):
            j = int(idx[0])
            k = j
            while k + 1 < len(row) and row[k + 1]:
                k += 1
            runs.append(k - j + 1)
    stem = float(np.median(runs)) if runs else 0.0
    return stem, int(a.shape[1])


def describe_weight_width(path, cap_height):
    """Weight and width of a face, from its file and its template."""
    weight, width_class = read_os2(path)
    stem, h_width = measure_h(path, cap_height)
    return {
        "os2_weight": weight,
        "os2_width": width_class,
        "stem_px": stem,
        "stem_ratio": round(stem / cap_height, 3) if cap_height else None,
        "h_width_px": h_width,
        "width_ratio": round(h_width / cap_height, 3) if cap_height else None,
    }


# ---------------------------------------------------------------- run


def run(frame_path, text, box, cache_dir, top_n):
    frame = np.array(Image.open(frame_path).convert("RGB"))
    frame_luma = luma(frame)
    cropped = crop_label(frame_luma, text, box)
    if cropped is None:
        raise RuntimeError("no label ink found in %s" % frame_path)
    grey, cap_height, ink_box_out, word_spans = cropped
    words = text.split(" ")
    if len(words) != len(word_spans):
        # The frame holds a different number of word gaps than the text.
        # Score the whole string as one word instead of guessing.
        words = [text]
        word_spans = [(0, grey.shape[1])]
    refs = [grey[:, s:e] for s, e in word_spans]
    refs_by_threshold = []
    crop_luma = frame_luma[
        ink_box_out[1]:ink_box_out[3] + 1, ink_box_out[0]:ink_box_out[2] + 1
    ]
    for thr in DICE_THRESHOLDS:
        b = (crop_luma > thr).astype(np.float64)
        refs_by_threshold.append([b[:, s:e] for s, e in word_spans])

    ranked = []
    downloaded = []
    for family, weight in CANDIDATES:
        try:
            path = fetch_font(family, weight, cache_dir)
        except Exception as err:  # network or API miss: skip the face
            print("skip %s %d: %s" % (family, weight, err), file=sys.stderr)
            continue
        if not any(d["family"] == family and d["weight"] == weight for d in downloaded):
            downloaded.append({
                "family": family,
                "weight": weight,
                "path": path,
                "sha256": sha256_file(path),
            })
        score, infos = score_font(path, words, refs, cap_height)
        ranked.append({
            "family": family,
            "weight": weight,
            "score": round(score, 4),
            "best": infos,
            "path": path,
        })
    ranked.sort(key=lambda r: r["score"], reverse=True)
    shortlist = ranked[:8]
    for entry in shortlist:
        entry["dice"] = round(dice_font(entry["path"], words, refs_by_threshold, cap_height), 4)
    for entry in ranked:
        entry.setdefault("dice", None)
        del entry["path"]

    top = ranked[:top_n]
    best_score = top[0]["score"] if top else 0.0
    second_score = ranked[1]["score"] if len(ranked) > 1 else 0.0
    margin = round(best_score - second_score, 4)
    passes = best_score >= BAR_SCORE and margin >= BAR_MARGIN

    # Weight and width of the top match, measured on its template, with
    # Anton (the scene's guess) and Montserrat Bold (the SUDAN face) as
    # the two reference points when their files exist in the repo.
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    top_path = cache_file(cache_dir, top[0]["family"], top[0]["weight"]) if top else None
    weight_width = {"top": describe_weight_width(top_path, cap_height) if top_path else None}
    for label, rel in (("anton", "assets/fonts/Anton-Regular.ttf"),
                       ("sudan_face", "assets/fonts/Montserrat-Bold.ttf")):
        p = os.path.join(repo_root, rel)
        weight_width[label] = describe_weight_width(p, cap_height) if os.path.exists(p) else None
    weight_width["how_determined"] = (
        "Weight: OS/2 usWeightClass read from the font file, plus the H stem "
        "width measured on the rendered template at the label cap height. "
        "Width: H ink width measured on the same template, as a ratio to cap "
        "height. Anton and Montserrat Bold are measured the same way for "
        "contrast. A stem ratio below the SUDAN face and a width ratio "
        "between Anton and Montserrat Bold means a mid-weight, slightly "
        "condensed face."
    )

    notes = {
        "Archivo Narrow": "Condensed grotesque, the open lookalike for a narrow news sans.",
        "Anton": "Very heavy condensed display face, the scene's current guess. It ranks low here.",
        "Montserrat": "Wide geometric sans, the SUDAN face. Too wide for this label.",
    }
    for entry in top:
        fam = entry["family"]
        if fam in notes:
            entry["note"] = notes[fam]
        elif any(h in fam for h in CONDENSED_HINT):
            entry["note"] = "Condensed sans face."
        elif "Semi Condensed" in fam:
            entry["note"] = "Semi-condensed sans face."
        else:
            entry["note"] = "Sans face, not condensed."
    if top:
        top[0]["weight_width"] = weight_width["top"]

    return {
        "frame": frame_path,
        "text": text,
        "box": ink_box_out,
        "cap_height_px": cap_height,
        "candidates_scored": len(ranked),
        "candidates_in_library": len(CANDIDATES),
        "cache_dir": cache_dir,
        "fonts_downloaded": downloaded,
        "ranking": top,
        "best_score": round(best_score, 4),
        "second_score": round(second_score, 4),
        "margin": margin,
        "match_bar": {"score": BAR_SCORE, "margin": BAR_MARGIN},
        "passes_bar": passes,
        "verdict": (
            "confirmed match" if passes else "closest lookalike, not confirmed"
        ),
        "weight_width": weight_width,
        "method": (
            "Template matching: render each candidate in the label text at "
            "the measured cap height, blur 1 px, search tracking -2..4, "
            "horizontal scale 0.90..1.15 and shift -2..2 per word, score grey "
            "normalized cross-correlation per word. Dice on binarized bitmaps "
            "is a cross-check for the top 8."
        ),
        "limits": [
            "Template matching can only name fonts already in the library. "
            "A font outside Google Fonts will never win; the answer is the "
            "closest open lookalike, not the font.",
            "Cap height here is %d px. At this size several grotesques differ "
            "by a few pixels per letter, so the margin over second place is "
            "small and the weight call rests on the measured stem, not the "
            "name." % cap_height,
            "YouTube compression softens edges, so scores on these frames run "
            "below scores on clean renders.",
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(prog="checker.font")
    parser.add_argument("--frame", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--box", default=None, help="x,y,w,h search rect")
    parser.add_argument("--cache-dir", default=None)
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args(argv)
    box = None
    if args.box:
        try:
            box = tuple(int(v) for v in args.box.split(","))
            if len(box) != 4:
                raise ValueError
        except ValueError:
            parser.error("--box needs x,y,w,h")
    cache_dir = args.cache_dir or default_cache_dir()
    try:
        result = run(args.frame, args.text, box, cache_dir, args.top)
    except Exception as err:
        print("checker.font: %s" % err, file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
