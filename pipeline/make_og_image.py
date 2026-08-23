"""Render the 1200x630 social card used by og:image / twitter:image.

Deliberately carries no numbers. The card is a static asset committed to the
repo, while the data behind the site changes every Monday -- a card quoting a
citation total would be wrong within a week of being rendered, on exactly the
surface where nobody would notice. It states what the tracker measures instead,
which does not go stale.

Run after editing:  python pipeline/make_og_image.py
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config

OUT = os.path.join(config.ROOT, "og-image.png")
W, H = 1200, 630
PAD = 72

# The site's dark-theme tokens, so a shared link and the page it opens agree.
BG = "#0d0d0d"
INK = "#ffffff"
INK_2 = "#c3c2b7"
MUTED = "#898781"
RULE = "#2c2c2a"
SERIES = ("#3987e5", "#d95926", "#199e70")

# The page asks for -apple-system first and lands on Helvetica Neue here.
# Arial is the fallback so the card still renders on a Linux checkout.
FACES = [
    ("/System/Library/Fonts/HelveticaNeue.ttc", {"regular": 0, "bold": 1}),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", None),
]


def font(size, weight="regular"):
    for path, index in FACES:
        if not os.path.exists(path):
            continue
        try:
            if index is not None:
                return ImageFont.truetype(path, size, index=index[weight])
            bold = path.replace("Arial.ttf", "Arial Bold.ttf")
            return ImageFont.truetype(
                bold if weight == "bold" and os.path.exists(bold) else path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def tracked(draw, xy, text, fnt, fill, spacing):
    """Letter-spaced text. Pillow has no tracking, so step glyph by glyph."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + spacing
    return x


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    tracked(d, (PAD, 68), "SCFM TRACKER", font(20, "bold"), MUTED, 3.2)

    d.text((PAD, 112), "Single-Cell Foundation", font=font(62, "bold"), fill=INK)
    d.text((PAD, 184), "Model Tracker", font=font(62, "bold"), fill=INK)

    d.text((PAD, 286),
           "Every single-cell RNA-seq foundation model, ranked by three",
           font=font(27), fill=INK_2)
    d.text((PAD, 324), "signals that usually disagree.",
           font=font(27), fill=INK_2)

    d.line([(PAD, 400), (W - PAD, 400)], fill=RULE, width=1)

    columns = [
        ("Cited", "Citations, deduplicated", "across paper versions"),
        ("Used", "Hugging Face downloads", "and GitHub stars"),
        ("Maintained", "Days since anyone", "touched the code"),
    ]
    col_w = (W - 2 * PAD) // 3
    for i, (label, line1, line2) in enumerate(columns):
        x = PAD + i * col_w
        d.rectangle([x, 430, x + 44, 434], fill=SERIES[i])
        d.text((x, 452), label, font=font(28, "bold"), fill=INK)
        d.text((x, 494), line1, font=font(19), fill=MUTED)
        d.text((x, 520), line2, font=font(19), fill=MUTED)

    d.text((PAD, H - 52), "eastmanmd.github.io/scFM-tracker",
           font=font(20), fill=SERIES[0])
    right = "OpenAlex · GitHub · Hugging Face"
    d.text((W - PAD - d.textlength(right, font=font(20)), H - 52), right,
           font=font(20), fill=MUTED)

    img.save(OUT, "PNG", optimize=True)
    print("Wrote {} ({:,} bytes)".format(OUT, os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
