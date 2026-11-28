"""Build the FoulBrood II app icons (macOS .icns, Windows .ico) from the viewer's bee picture."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
BEE = Image.open(HERE/'foulbrood-hive.png').convert('RGBA')

def tile(size, inset, radius, shadow):
    """The bee on a rounded tile, drawn at 4x and scaled down for smooth edges."""
    s = 4; big = size*s
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    x0 = round(inset*big); w = big-2*x0; r = round(radius*w)
    mask = Image.new('L', (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w-1, w-1), r, fill=255)
    if shadow:
        sh = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        sh.paste((0, 0, 0, 90), (x0, x0+round(0.012*big)), mask)
        canvas = Image.alpha_composite(canvas, sh.filter(ImageFilter.GaussianBlur(0.012*big)))
    face = BEE.resize((w, w), Image.LANCZOS)
    canvas.paste(face, (x0, x0), mask)
    return canvas.resize((size, size), Image.LANCZOS)

def main():
    mac = tile(1024, 100/1024, 0.225, True)          # Apple's icon grid
    mac.save(HERE/'FoulBrood.icns')
    win = [tile(n, 0.03 if n >= 48 else 0.0, 0.18, False) for n in (256, 128, 64, 48, 32, 24, 16)]
    win[0].save(HERE/'FoulBrood.ico', sizes=[(i.width, i.height) for i in win], append_images=win[1:])

if __name__ == '__main__':
    main()
