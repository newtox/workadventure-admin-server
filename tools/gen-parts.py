# Generates extra woka parts: recoloured hair, eyes, glasses and hats from WorkAdventure's own customisation sprites,
# plus the hand-drawn office and gaming accessories and headsets from gen_accessories.py.
import os, re, sys, json, colorsys
from PIL import Image

SRC = sys.argv[1]          # .../play/public/resources/customisation
OUT = sys.argv[2]          # repo/data/parts
os.makedirs(OUT, exist_ok=True)

def lum(p): return 0.299*p[0] + 0.587*p[1] + 0.114*p[2]
def ramp(stops, t):
    t = max(0.0, min(1.0, t)); n = len(stops) - 1
    i = min(int(t * n), n - 1); f = t * n - i
    a, b = stops[i], stops[i + 1]
    return tuple(round(a[k] + (b[k] - a[k]) * f) for k in range(3))

collections = {"hair": [], "eyes": []}

# ---------- hair ----------
HAIR = {
    "ginger":  ({"de": "Rote Haare", "en": "Red hair"},        [(70,22,8),(150,55,18),(210,100,40),(242,165,95)]),
    "black":   ({"de": "Schwarze Haare", "en": "Black hair"},  [(12,12,16),(32,32,42),(58,58,74),(98,98,120)]),
    "darkbrown":({"de": "Dunkelbraune Haare", "en": "Dark brown hair"}, [(30,17,10),(64,36,20),(100,62,36),(145,100,64)]),
    "silver":  ({"de": "Silberne Haare", "en": "Silver hair"}, [(95,95,108),(155,155,168),(205,205,215),(246,246,250)]),
    "pink":    ({"de": "Pinke Haare", "en": "Pink hair"},       [(110,25,72),(195,65,135),(240,128,188),(255,192,226)]),
    "blue":    ({"de": "Blaue Haare", "en": "Blue hair"},       [(18,30,95),(38,78,178),(80,140,232),(152,202,255)]),
    "purple":  ({"de": "Lila Haare", "en": "Purple hair"},      [(45,18,85),(98,48,160),(150,100,212),(202,168,242)]),
    "green":   ({"de": "Grüne Haare", "en": "Green hair"},      [(14,56,28),(32,118,58),(80,180,100),(152,226,162)]),
}
hair_dir = os.path.join(SRC, "character_hairs")
def hair_files():
    files = sorted(os.listdir(hair_dir), key=lambda f: (len(f), f))
    out = []
    for f in files:
        im = Image.open(os.path.join(hair_dir, f)).convert("RGBA")
        px = [p for p in im.getdata() if p[3] > 0]
        if not px: continue
        sat = sum(colorsys.rgb_to_hsv(*[c/255 for c in p[:3]])[1] for p in px) / len(px)
        if sat < 0.35:          # the brown variant of each style (the other one is blond)
            out.append(f)
    return out
bases = hair_files()
for key, (names, stops) in HAIR.items():
    items = []
    for f in bases:
        im = Image.open(os.path.join(hair_dir, f)).convert("RGBA")
        data = list(im.getdata())
        hairpx = [p for p in data if p[3] > 0 and colorsys.rgb_to_hsv(*[c/255 for c in p[:3]])[1] < 0.5]
        lo = min(lum(p) for p in hairpx); hi = max(lum(p) for p in hairpx)
        new = []
        for p in data:
            if p[3] == 0: new.append(p); continue
            s = colorsys.rgb_to_hsv(*[c/255 for c in p[:3]])[1]
            if s >= 0.5: new.append(p); continue          # keep coloured accessories (ribbons, clips)
            t = (lum(p) - lo) / (hi - lo or 1)
            new.append(ramp(stops, t) + (p[3],))
        im.putdata(new)
        name = f"hair-{key}-{f.replace('character_hairs','').replace('.png','')}.png"
        im.save(os.path.join(OUT, name), optimize=True)
        items.append(name)
    collections["hair"].append({"key": key, "names": names, "files": items})

# ---------- eye colours ----------
EYES = {
    "blue":   ({"de": "Blaue Augen", "en": "Blue eyes"},     (72,140,232), (30,74,160)),
    "green":  ({"de": "Grüne Augen", "en": "Green eyes"},    (72,182,82), (28,104,44)),
    "grey":   ({"de": "Graue Augen", "en": "Grey eyes"},     (150,160,176), (84,94,110)),
    "violet": ({"de": "Lila Augen", "en": "Violet eyes"},    (166,102,222), (94,50,150)),
    "red":    ({"de": "Rote Augen", "en": "Red eyes"},       (222,52,62), (134,20,30)),
    "teal":   ({"de": "Türkise Augen", "en": "Teal eyes"},   (40,196,196), (10,114,124)),
}
eye_dir = os.path.join(SRC, "character_eyes")
LIGHT, DARK = (150,79,0), (92,46,0)
eye_bases = []
for n in range(1, 60):
    f = f"character_eyes{n}.png"
    if not os.path.exists(os.path.join(eye_dir, f)): continue
    cols = {p[:3] for p in Image.open(os.path.join(eye_dir, f)).convert("RGBA").getdata() if p[3] > 0}
    if LIGHT in cols or DARK in cols: eye_bases.append(f)
for key, (names, light, dark) in EYES.items():
    items = []
    for f in eye_bases:
        im = Image.open(os.path.join(eye_dir, f)).convert("RGBA")
        im.putdata([(light + (p[3],)) if p[:3] == LIGHT else (dark + (p[3],)) if p[:3] == DARK else p for p in im.getdata()])
        name = f"eyes-{key}-{f.replace('character_eyes','').replace('.png','')}.png"
        im.save(os.path.join(OUT, name), optimize=True)
        items.append(name)
    collections["eyes"].append({"key": key, "names": names, "files": items})

# ---------- glasses in more colours ----------
GLASSES = {"black": [(10,10,14),(30,30,38),(55,55,66)], "blue": [(20,45,140),(40,90,210),(90,150,245)],
           "gold": [(130,90,0),(200,150,20),(245,210,80)], "pink": [(150,30,95),(225,80,160),(250,150,205)],
           "white": [(170,170,180),(220,220,228),(252,252,255)]}
glasses = []
for n in (25, 27):
    f = f"character_eyes{n}.png"
    im0 = Image.open(os.path.join(eye_dir, f)).convert("RGBA")
    frame = [p for p in im0.getdata() if p[3] == 255]
    lo = min(lum(p) for p in frame); hi = max(lum(p) for p in frame)
    for key, stops in GLASSES.items():
        im = im0.copy()
        im.putdata([(ramp(stops, (lum(p)-lo)/(hi-lo or 1)) + (255,)) if p[3] == 255 else p for p in im0.getdata()])
        name = f"glasses-{key}-{n}.png"
        im.save(os.path.join(OUT, name), optimize=True)
        glasses.append(name)
# glasses that WorkAdventure ships but does not list
extra = [f"character_eyes{n}.png" for n in range(31, 35) if os.path.exists(os.path.join(eye_dir, f"character_eyes{n}.png"))]
collections["eyes"].append({"key": "glasses", "names": {"de": "Brillen", "en": "Glasses"}, "files": glasses, "bundled": extra})

# ---------- hats in more colours ----------
# The largest colour group of each hat (its fabric) is recoloured; small details (ties, buttons) keep their colour.
FABRIC = {
    "red":    ({"de": "Rot", "en": "Red"},       [(70,10,15),(150,25,35),(215,60,65),(245,140,140)], 0.0),
    "blue":   ({"de": "Blau", "en": "Blue"},     [(15,25,80),(35,70,170),(75,130,230),(160,200,255)], 0.6),
    "green":  ({"de": "Grün", "en": "Green"},    [(12,55,25),(30,115,55),(75,175,95),(160,225,170)], 0.36),
    "yellow": ({"de": "Gelb", "en": "Yellow"},   [(110,80,0),(200,155,10),(240,205,50),(255,240,150)], 0.13),
    "purple": ({"de": "Lila", "en": "Purple"},   [(45,18,85),(100,50,165),(155,105,215),(210,180,245)], 0.76),
    "black":  ({"de": "Schwarz", "en": "Black"}, [(10,10,14),(28,28,36),(52,52,64),(90,90,108)], None),
}
def hsv(p): return colorsys.rgb_to_hsv(*[c/255 for c in p[:3]])
def group(p):
    h, s_, v = hsv(p)
    return "n" if s_ < 0.25 else int(h * 12) % 12
def fabric_variants(folder, prefix, label_suffix, skip=()):
    d = os.path.join(SRC, folder)
    files = [f for f in sorted(os.listdir(d), key=lambda f: (len(f), f)) if f.endswith(".png") and f not in skip]
    cols = []
    for key, (names, stops, hue) in FABRIC.items():
        items = []
        for f in files:
            im = Image.open(os.path.join(d, f)).convert("RGBA")
            data = list(im.getdata())
            opaque = [p for p in data if p[3] > 0]
            if len(opaque) < 20: continue
            counts = {}
            for p in opaque: counts[group(p)] = counts.get(group(p), 0) + 1
            main = max(counts, key=counts.get)
            mainpx = [p for p in opaque if group(p) == main]
            # skip variants that would look like the original
            if hue is None and main == "n" and sum(lum(p) for p in mainpx) / len(mainpx) < 70: continue
            if hue is not None and main != "n" and min(abs(main / 12 - hue), 1 - abs(main / 12 - hue)) < 0.06: continue
            lo = min(lum(p) for p in mainpx); hi = max(lum(p) for p in mainpx)
            im.putdata([(ramp(stops, (lum(p) - lo) / (hi - lo or 1)) + (p[3],)) if p[3] > 0 and group(p) == main else p for p in data])
            stem = re.sub(r"[^a-z0-9]+", "-", f.replace(".png", "").replace("character_clothes", "").replace("character_hats", "").lower()).strip("-")
            name = f"{prefix}-{key}-{stem}.png"
            im.save(os.path.join(OUT, name), optimize=True)
            items.append(name)
        cols.append({"key": key, "names": {"de": f"{names['de']} {label_suffix['de']}", "en": f"{names['en']} {label_suffix['en']}"}, "files": items})
    return cols
collections["hat"] = fabric_variants("character_hats", "hat", {"de": "(Hüte)", "en": "(hats)"})

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_accessories import build
drawn = build(OUT)
collections["accessory"] = drawn["accessory"]
collections["hat"] = drawn["hat"] + collections["hat"]

json.dump(collections, open(os.path.join(OUT, "parts.json"), "w"), indent=1, ensure_ascii=False)
print({k: sum(len(c["files"]) + len(c.get("bundled", [])) for c in v) for k, v in collections.items()})
