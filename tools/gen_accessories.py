# Draws office and gaming accessories for wokas as 96x128 sprite sheets (3 walk frames x 4 directions, 32x32 each).
# Handheld things go to the "accessory" part; things worn on the head go to the "hat" part, so both can be combined.
import os
from PIL import Image

K = (28, 28, 34)          # outline
PALETTE = {
    "k": K,
    "w": (240, 240, 244), "W": (200, 202, 210), "v": (150, 152, 162),   # white / light grey / grey
    "d": (64, 66, 76), "D": (44, 46, 54), "e": (92, 95, 108),            # dark greys
    "b": (110, 64, 34), "B": (150, 96, 52), "n": (196, 150, 98),         # browns / coffee / cardboard
    "r": (214, 52, 60), "R": (150, 26, 36),
    "g": (70, 200, 90), "G": (30, 120, 50), "l": (170, 245, 120),
    "u": (60, 130, 230), "U": (30, 70, 160), "c": (120, 220, 250),
    "p": (240, 120, 180), "P": (180, 60, 130), "y": (250, 210, 60), "o": (250, 150, 40),
    "s": (176, 180, 190), "S": (220, 224, 232),
}

def blit(im, art, x, y, flip=False, pal=None):
    pal = {**PALETTE, **(pal or {})}
    for j, row in enumerate(art):
        if flip: row = row[::-1]
        for i, ch in enumerate(row):
            if ch == ".": continue
            px, py = x + i, y + j
            if 0 <= px < 32 and 0 <= py < 32:
                im.putpixel((px, py), pal[ch] + (255,))

def size(art): return len(art[0]), len(art)

DIRS = ["down", "left", "right", "up"]

# Centre of the hand that holds one-handed things, per (direction row, frame column). Measured on WorkAdventure's body sprite.
HAND = {(0, 0): (6, 23), (0, 1): (6, 25), (0, 2): (8, 26),
        (1, 0): (12, 26), (1, 1): (14, 26), (1, 2): (21, 26),
        (2, 0): (10, 26), (2, 1): (17, 26), (2, 2): (19, 26),
        (3, 0): (26, 24), (3, 1): (25, 25), (3, 2): (23, 24)}

def sheet(draw):
    out = Image.new("RGBA", (96, 128), (0, 0, 0, 0))
    for r in range(4):
        for c in range(3):
            f = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            draw(f, DIRS[r], c, 0 if c == 1 else 1, HAND[(r, c)])
            out.alpha_composite(f, (c * 32, r * 32))
    return out

# ---------- one-handed things ----------
def handheld(front, side=None, back=None, grip=None):
    """front: art seen from the front/back; side: art for left-facing (flipped for right). grip: point of the art in the hand."""
    side = side or front
    back = back if back is not None else front
    def draw(f, d, c, bob, hand):
        art = {"down": front, "up": back, "left": side, "right": side}[d]
        if not art: return
        w, h = size(art)
        gx, gy = grip or (w // 2, h // 2)
        if d == "right": gx = w - 1 - gx
        blit(f, art, hand[0] - gx, hand[1] - gy, flip=(d == "right"))
    return draw

MUG = [".kkkkk..",
       "kbbBbbk.",
       "kwwwwwkk",
       "kwwrwwk.k",
       "kwwwwwkk.",
       "kWwwwWk..",
       ".kkkkk..."]
MUG = [r.ljust(9, ".") for r in MUG]

TOGO = [".kkkkk.",
        "kwwwwwk",
        "kkkkkkk",
        ".kwwwk.",
        ".knnnk.",
        ".kBBBk.",
        ".knnnk.",
        ".kwwwk.",
        "..kkk.."]

CAN = [".kkk.",
       "kSsSk",
       "kGgGk",
       "kglGk",
       "kgGGk",
       "kGgGk",
       "kSsSk",
       ".kkk."]

PHONE_FRONT = ["kkkk",
               "kcUk",
               "kuck",
               "kUuk",
               "kuUk",
               "kkkk"]
PHONE_SIDE = ["kk",
              "kd",
              "kd",
              "kd",
              "kd",
              "kk"]
PHONE_BACK = ["kkkk",
              "kddk",
              "kdek",
              "kddk",
              "kddk",
              "kkkk"]

CLIPBOARD = ["..kkk..",
             "kkkvkkk",
             "kbwwwbk",
             "kbwkwbk",
             "kbwwwbk",
             "kbwkkbk",
             "kbwwwbk",
             "kbbbbbk",
             "kkkkkkk"]
CLIPBOARD_SIDE = ["k.",
                  "kk",
                  "kb",
                  "kb",
                  "kb",
                  "kb",
                  "kb",
                  "kb",
                  "kk"]

LAPTOP_EDGE = ["kkk",
               "ksk",
               "kSk",
               "ksk",
               "ksk",
               "ksk",
               "kSk",
               "ksk",
               "kkk"]
LAPTOP_SIDE = ["kkkkkkkkkk",
               "kssssssssk",
               "kssssSsssk",
               "ksssSwSssk",
               "kssssSsssk",
               "kssssssssk",
               "kkkkkkkkkk"]

# ---------- two-handed things held in front of the belly ----------
def front_held(front, side):
    def draw(f, d, c, bob, hand):
        if d == "up": return
        if d == "down":
            w, h = size(front)
            blit(f, front, 16 - w // 2, 22 + bob - h // 2 + 1, False)
        else:
            w, h = size(side)
            x = 8 if d == "left" else 24 - w
            blit(f, side, x, 23 + bob - h // 2, flip=(d == "right"))
    return draw

CONTROLLER = ["..kkkkkkkk..",
              ".kddddddddk.",
              "kddkdddduddk",
              "kdkkkddrdydk",
              "kddkddddgddk",
              "kdddkkkkdddk",
              ".kdk....kdk.",
              "..k......k.."]
CONTROLLER_SIDE = [".kkkk",
                   "kdddk",
                   "kdddk",
                   ".kkk."]

HANDHELD = [".kkkkkkkkkkkkk.",
            "kddddkkkkkddddk",
            "kdkddkcucukdddk",
            "kkkkdkuccukdrdk",
            "kdkddkucuckdddk",
            "kddddkkkkkdgddk",
            ".kkkkkkkkkkkkk."]
HANDHELD_SIDE = [".kk",
                 "kdk",
                 "kdk",
                 "kdk",
                 ".kk"]

# ---------- worn on the chest ----------
def lanyard(strap, badge):
    pal = {"q": strap}
    BADGE = ["kkkkk",
             "kqqqk",
             "kwwwk",
             "kwkwk",
             "kwwwk",
             "kkkkk"]
    def draw(f, d, c, bob, hand):
        y0 = 18 + bob   # neckline
        if d == "down":
            for i in range(4):
                blit(f, ["q"], 12 + i, y0 + i, pal=pal); blit(f, ["q"], 20 - i, y0 + i, pal=pal)
            blit(f, BADGE, 14, y0 + 4, pal={**pal, "q": badge})
        elif d == "up":
            for x in range(12, 21): blit(f, ["q"], x, y0, pal=pal)
        else:
            flip = d == "right"
            def X(x, w=1): return 31 - x - (w - 1) if flip else x
            for i in range(4): blit(f, ["q"], X(14 - i // 2), y0 + i, pal=pal)
            blit(f, ["kkk", "kqk", "kwk", "kwk", "kkk"], X(11, 3), y0 + 4, pal={**pal, "q": badge})
    return draw

# ---------- worn on the head (hat part) ----------
# Head of the body sprite: x 8..24, top at y 3 when standing (y 4 in walk frames); ears at y 12..13.
BAND_DOWN = [(9, 6), (10, 5), (11, 4), (12, 3), (13, 3), (14, 2), (15, 2), (16, 2), (17, 2), (18, 2), (19, 3), (20, 3), (21, 4), (22, 5), (23, 6)]

def headset(main, accent, mic=False, ears=False, two_cups=True):
    """Headphones over the head. two_cups=False gives an office headset with one ear cup and a pad on the other side."""
    pal = {"m": main, "a": accent}
    CUP_FRONT = ["kkk", "kmk", "kak", "kak", "kmk", "kkk"]
    CUP_SIDE = [".kkkk.", "kmmmmk", "kmaamk", "kmaamk", "kmmmmk", ".kkkk."]
    PAD_FRONT = ["kk", "km", "km", "kk"]
    PAD_SIDE = ["kkkk", "kmmk", "kmmk", "kkkk"]
    EAR = ["..k..", ".kmk.", "kmamk"]
    def draw(f, d, c, bob, hand):
        y = bob
        if d in ("down", "up"):
            for x, by in BAND_DOWN:
                blit(f, ["k", "m"], x, by + y, pal=pal)
            for yy in range(6, 10):
                blit(f, ["km"], 7, yy + y, pal=pal); blit(f, ["mk"], 24, yy + y, pal=pal)
            # the cup with the microphone is on the character's right: screen left from the front, screen right from behind
            mic_x, other_x = (5, 24) if d == "down" else (24, 5)
            blit(f, CUP_FRONT, mic_x, 9 + y, pal=pal)
            if two_cups:
                blit(f, CUP_FRONT, other_x, 9 + y, pal=pal)
            else:
                blit(f, PAD_FRONT, other_x + (1 if other_x < 16 else 0), 10 + y, pal=pal)
            if mic and d == "down":
                for mx, my in [(8, 15), (9, 16), (10, 17), (11, 17)]:
                    blit(f, ["k"], mx, my + y, pal=pal)
                blit(f, ["a"], 12, 17 + y, pal=pal)
            if ears:
                blit(f, EAR, 9, 1 + y, pal=pal); blit(f, EAR, 19, 1 + y, pal=pal)
        else:
            flip = d == "right"
            def X(x, w=1): return 31 - x - (w - 1) if flip else x
            band = [(20, 9), (20, 8), (19, 7), (19, 6), (18, 5), (17, 4), (16, 3), (15, 3), (14, 3), (13, 3), (12, 4)]
            for x, by in band:
                blit(f, ["k", "m"], X(x), by + y - 1, pal=pal)
            # facing right shows the character's right ear (with the microphone), facing left the other one
            mic_side = d == "right"
            if two_cups or mic_side:
                blit(f, CUP_SIDE, X(17, 6), 10 + y, flip=flip, pal=pal)
            else:
                blit(f, PAD_SIDE, X(18, 4), 11 + y, pal=pal)
            if mic and mic_side:
                for mx, my in [(16, 15), (15, 16), (14, 17), (13, 17), (12, 17), (11, 17)]:
                    blit(f, ["k"], X(mx), my + y, pal=pal)
                blit(f, ["a"], X(10), 17 + y, pal=pal)
            if ears:
                blit(f, EAR, X(14, 5), 0 + y, pal=pal)
    return draw

def vr_headset(main, accent):
    pal = {"m": main, "a": accent}
    FRONT = [".kkkkkkkkkkkkk.",
             "kmmmmmmmmmmmmmk",
             "kmaammmmmmmaamk",
             "kmmmmmkkkmmmmmk",
             ".kkkkk...kkkkk."]
    SIDE = ["kkkkk",
            "kmmmk",
            "kammk",
            "kmmmk",
            ".kkkk"]
    def draw(f, d, c, bob, hand):
        y = bob
        if d == "down":
            blit(f, ["k"] , 8, 12 + y, pal=pal); blit(f, ["k"], 24, 12 + y, pal=pal)
            blit(f, FRONT, 9, 10 + y, pal=pal)
            for x in range(10, 23): blit(f, ["k"], x, 4 + y, pal=pal)   # top strap
        elif d == "up":
            for x in range(8, 25): blit(f, ["k"], x, 12 + y, pal=pal); blit(f, ["m"], x, 13 + y, pal=pal)
            for yy in range(4, 12): blit(f, ["k"], 16, yy + y, pal=pal)
            blit(f, ["kkk", "kak", "kkk"], 15, 11 + y, pal=pal)
        else:
            flip = d == "right"
            def X(x, w=1): return 31 - x - (w - 1) if flip else x
            for x in range(11, 24): blit(f, ["k"], X(x), 12 + y, pal=pal)    # strap around the head
            for yy in range(4, 12): blit(f, ["k"], X(18), yy + y, pal=pal)   # strap over the top
            blit(f, SIDE, X(6, 5), 10 + y, flip=flip, pal=pal)
    return draw

def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    accessories = [
        ("office", {"de": "Büro", "en": "Office"}, [
            ("coffee-mug", handheld(MUG, MUG, MUG, grip=(3, 4))),
            ("coffee-to-go", handheld(TOGO, TOGO, TOGO, grip=(3, 5))),
            ("laptop", handheld(LAPTOP_EDGE, LAPTOP_SIDE, LAPTOP_EDGE, grip=None)),
            ("clipboard", handheld(CLIPBOARD, CLIPBOARD_SIDE, CLIPBOARD, grip=(3, 6))),
            ("smartphone", handheld(PHONE_FRONT, PHONE_SIDE, PHONE_BACK, grip=(2, 4))),
            ("badge-blue", lanyard((40, 90, 200), (60, 130, 230))),
            ("badge-red", lanyard((190, 40, 50), (214, 52, 60))),
        ]),
        ("gaming", {"de": "Gaming", "en": "Gaming"}, [
            ("controller", front_held(CONTROLLER, CONTROLLER_SIDE)),
            ("handheld", front_held(HANDHELD, HANDHELD_SIDE)),
            ("energy-drink", handheld(CAN, CAN, CAN, grip=(2, 4))),
        ]),
    ]
    headsets = [
        ("headset-black", headset((50, 52, 60), (230, 40, 60), mic=True)),
        ("headset-white", headset((236, 236, 242), (60, 170, 250), mic=True)),
        ("headset-cat", headset((245, 150, 200), (255, 240, 120), ears=True)),
        ("headset-office", headset((60, 62, 70), (90, 220, 120), mic=True, two_cups=False)),
        ("vr-headset", vr_headset((40, 42, 50), (90, 170, 250))),
    ]
    result = {"accessory": [], "hat": []}
    for key, names, items in accessories:
        files = []
        for name, draw in items:
            fn = f"accessory-{name}.png"
            sheet(draw).save(os.path.join(out_dir, fn), optimize=True)
            files.append(fn)
        result["accessory"].append({"key": key, "names": names, "files": files})
    files = []
    for name, draw in headsets:
        fn = f"hat-{name}.png"
        sheet(draw).save(os.path.join(out_dir, fn), optimize=True)
        files.append(fn)
    result["hat"].append({"key": "headsets", "names": {"de": "Headsets", "en": "Headsets"}, "files": files})
    return result

if __name__ == "__main__":
    import sys
    print(build(sys.argv[1]))
