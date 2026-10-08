"""Membuat ulang semua aset logo dari img/Logo.png (butuh Pillow dan numpy).
Jalankan dari akar repo: python3 img/build-brand.py img/Logo.png /tmp/bg.txt"""
import sys
from PIL import Image, ImageDraw, ImageChops, ImageFilter
import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(float)
BG = np.array([15, 17, 31.0])
# warna mark: piksel paling terang/teal di tengah
flat = a.reshape(-1, 3)
d = np.linalg.norm(flat - BG, axis=1)
TEAL = flat[d > np.percentile(d[d > 40], 90)].mean(axis=0)
print('bg', BG, 'teal', TEAL.round())

# area dalam tile (hindari sudut putih): sisakan margin 6%
mx, my = int(W * .06), int(H * .06)
cov = np.clip(np.linalg.norm(a - BG, axis=2) / np.linalg.norm(TEAL - BG), 0, 1)
inner = np.zeros((H, W)); inner[my:H-my, mx:W-mx] = 1
cov *= inner

# naikkan resolusi 8x dengan Lanczos, lalu pertajam tepi dengan kurva kontras
S = 8
c = Image.fromarray((cov * 255).astype('uint8')).resize((W * S, H * S), Image.LANCZOS).filter(ImageFilter.GaussianBlur(S * .6))
c = np.asarray(c).astype(float) / 255
c = np.clip((c - .5) * 6 + .5, 0, 1)  # tepi tajam, tetap antialias
mask = Image.fromarray((c * 255).astype('uint8'))
bbox = mask.point(lambda v: 255 if v > 128 else 0).getbbox()
print('bbox', bbox, 'dari', mask.size)
mark = mask.crop(bbox)
mw, mh = mark.size
tealc = tuple(int(x) for x in TEAL)
bgc = tuple(int(x) for x in BG)

def mark_rgba(box, pad=0.0):
    """Mark teal pada kanvas transparan box×box, tinggi mark = (1-2*pad)*box, di tengah."""
    th = int(box * (1 - 2 * pad))
    tw = int(mw * th / mh)
    m = mark.resize((tw, th), Image.LANCZOS)
    canvas = Image.new('RGBA', (box, box), (0, 0, 0, 0))
    solid = Image.new('RGBA', (tw, th), tealc + (255,))
    solid.putalpha(m)
    canvas.alpha_composite(solid, ((box - tw) // 2, (box - th) // 2))
    return canvas

def tile(box, radius=0.24, pad=0.2, round_shape=False):
    s = 4
    big = box * s
    bg = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    m = Image.new('L', (big, big), 0)
    dr = ImageDraw.Draw(m)
    if round_shape: dr.ellipse((0, 0, big - 1, big - 1), fill=255)
    else: dr.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius), fill=255)
    fill = Image.new('RGBA', (big, big), bgc + (255,)); fill.putalpha(m)
    bg.alpha_composite(fill)
    bg.alpha_composite(mark_rgba(big, pad))
    return bg.resize((box, box), Image.LANCZOS)

def save(img, path):
    import os; os.makedirs(os.path.dirname(path), exist_ok=True); img.save(path, optimize=True); print(path, img.size)

R = 'apps/pos/android/app/src/main/res'
# --- web: tile (UI) dan ikon situs
for app in ('dashboard', 'admin', 'pos'):
    save(tile(256), f'apps/{app}/public/logo.png')
for app in ('dashboard', 'admin'):
    save(tile(512), f'apps/{app}/src/app/icon.png')
    save(tile(180, radius=0.0, pad=0.2).convert('RGB'), f'apps/{app}/src/app/apple-icon.png')
save(tile(64), 'apps/pos/public/favicon.png')
save(tile(512), 'apps/pos/public/icon-512.png')
# --- Android
dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for n, k in dens.items():
    save(tile(int(48 * k)), f'{R}/mipmap-{n}/ic_launcher.png')
    save(tile(int(48 * k), round_shape=True), f'{R}/mipmap-{n}/ic_launcher_round.png')
    # adaptive foreground: 108dp, zona aman 66dp di tengah -> mark ~ 46% dari kanvas
    save(mark_rgba(int(108 * k), pad=0.27), f'{R}/mipmap-{n}/ic_launcher_foreground.png')
# --- splash: latar navy, logo di tengah
def splash(w, h, name):
    img = Image.new('RGBA', (w, h), bgc + (255,))
    side = int(min(w, h) * .32)
    img.alpha_composite(mark_rgba(side, 0.0), ((w - side) // 2, (h - side) // 2))
    save(img.convert('RGB'), name)
import glob
for p in glob.glob(f'{R}/drawable*/splash.png'):
    w, h = Image.open(p).size
    splash(w, h, p)
open(OUT, 'w').write(f'{bgc[0]:02X}{bgc[1]:02X}{bgc[2]:02X}')
