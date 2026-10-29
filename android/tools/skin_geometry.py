"""
Разметка фотоскинов камуфляжа по их рендерам.

Корпус скина — готовая картинка skins/<цвет>_body.png с прозрачными вырезами под экран,
16 кнопок, боковые кнопки и гнездо ручки. Живые элементы рации кладутся в эти вырезы. Рендеры
у скинов разные (766–798 px в ширину, вырезы сдвинуты на 1–3 %), поэтому одна общая сетка
на всех не подходит: где элемент не закрыл вырез, сквозь корпус видно то, что за рацией.

Скрипт сам находит вырезы в каждом рендере и пишет в skins.css блок на каждый скин:
  - под фото корпуса — тёмная «ниша» ровно по вырезам: даже если элемент сдвинут на пиксель,
    в щели видна ниша корпуса, а не рабочий стол или фон за рацией;
  - экран, кнопки, боковые, ручка, светодиод и фонарик — по координатам вырезов этого скина.

Запуск (нужен Pillow):  python android/tools/skin_geometry.py
Блок пишется между маркерами в обе копии skins.css — Android-рации и ПК (radio-air-PC).
"""

import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SKINS_DIR = ROOT / 'android' / 'app' / 'src' / 'main' / 'assets' / 'android' / 'skins'
CSS_FILES = [
    ROOT / 'android' / 'app' / 'src' / 'main' / 'assets' / 'android' / 'skins.css',
    ROOT / 'radio-air-PC' / 'css' / 'skins.css',
]
SKINS = ['woodland', 'desert', 'urban_gray', 'arctic', 'purple', 'red']
BEGIN = '/* @skin-geometry:begin — блок пишет android/tools/skin_geometry.py, руками не править */'
END = '/* @skin-geometry:end */'

RIG_W, RIG_H = 294, 527  # рамка .rig в skins.css: фото корпуса растянуто на неё целиком
SOLID = 128              # непрозрачность, с которой пиксель считается корпусом
WELL_GROW = 4            # на сколько px рендера ниша шире выреза

# Насколько живые элементы больше выреза — так подогнано вручную по «лесу» (кнопка-рендер
# шире выреза: у неё свой скос и тень). Доли — от размера выреза, сдвиги — в % рендера.
KEY_SCALE = (19.7 / 16.9, 7.75 / 6.6)
KEY_GAP = 0.5                           # минимальный зазор между соседними кнопками
LCD_PAD = 0.25                          # экран заходит на рамку выреза
PTT_PAD = (-2.7, -1.6, 2.2, 0.3)        # лево, верх, право, низ — относительно выреза
SIDE_PAD = (-2.7, -1.0, 2.0, 0.6)
SIDE2_STEP = 8.5                        # вторая малая боковая — под первой (выреза у неё нет)
KNOB_W = 18.0


def load_alpha(path):
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    return w, h, im.getchannel('A').tobytes()


def flood(mask, w, h, seeds):
    """Все пиксели mask, связанные (по 4 соседям) с seeds."""
    seen = bytearray(w * h)
    q = deque()
    for i in seeds:
        if mask[i] and not seen[i]:
            seen[i] = 1
            q.append(i)
    while q:
        i = q.popleft()
        x = i % w
        for j in (i - w, i + w, i - 1 if x else -1, i + 1 if x < w - 1 else -1):
            if 0 <= j < w * h and mask[j] and not seen[j]:
                seen[j] = 1
                q.append(j)
    return seen


def components(mask, w, h):
    """Связные области mask: [(пикселей, x1, y1, x2, y2)], x2/y2 — не включительно."""
    seen = bytearray(w * h)
    out = []
    for start in range(w * h):
        if not mask[start] or seen[start]:
            continue
        seen[start] = 1
        q = deque([start])
        n, x1, y1, x2, y2 = 0, w, h, 0, 0
        while q:
            i = q.popleft()
            n += 1
            x, y = i % w, i // w
            x1, y1, x2, y2 = min(x1, x), min(y1, y), max(x2, x + 1), max(y2, y + 1)
            for j in (i - w, i + w, i - 1 if x else -1, i + 1 if x < w - 1 else -1):
                if 0 <= j < w * h and mask[j] and not seen[j]:
                    seen[j] = 1
                    q.append(j)
        out.append((n, x1, y1, x2, y2))
    return out


def measure(name):
    w, h, alpha = load_alpha(SKINS_DIR / f'{name}_body.png')
    clear = bytes(1 if a < SOLID else 0 for a in alpha)
    border = [x for x in range(w)] + [(h - 1) * w + x for x in range(w)] \
        + [y * w for y in range(h)] + [y * w + w - 1 for y in range(h)]
    outside = flood(clear, w, h, border)
    holes = bytes(1 if c and not o else 0 for c, o in zip(clear, outside))
    every = [c for c in components(holes, w, h) if c[0] > 15]
    found = [c for c in every if c[0] > w * h * 0.002]
    # Мелкие вырезы: светодиод и фонарик в верхней части корпуса, дырочки микрофона внизу
    small = [c for c in every if c not in found]
    top = sorted((c for c in small if c[4] < h * 0.25), key=lambda c: c[1])
    led = next((c for c in top if (c[1] + c[3]) / 2 < w * 0.44), None)
    torch = next((c for c in top if (c[1] + c[3]) / 2 >= w * 0.44), None)
    if not found:
        sys.exit(f'{name}: в рендере нет вырезов — уже залиты или это не корпус скина')

    lcd = max(found, key=lambda c: c[0])
    notches = sorted((c for c in found if c[3] < w * 0.12), key=lambda c: c[2])
    keys = sorted((c for c in found if c is not lcd and c not in notches), key=lambda c: c[2])
    if len(keys) != 16 or not notches:
        sys.exit(f'{name}: ждал 16 вырезов кнопок и боковые, нашёл кнопок {len(keys)}, боковых {len(notches)}')
    rows = [sorted(keys[r * 4:r * 4 + 4], key=lambda c: c[1]) for r in range(4)]

    # Гнездо ручки: вырез в правом плече, открытый вверх, — короткие прозрачные отрезки строки,
    # зажатые корпусом с обеих сторон (верхняя четверть рендера, правая часть)
    solid_row = lambda y, x: alpha[y * w + x] >= SOLID
    socket = None
    for y in range(h // 4):
        xs = [x for x in range(w) if solid_row(y, x)]
        if len(xs) < 2:
            continue
        x = xs[0]
        while x < xs[-1]:
            if solid_row(y, x):
                x += 1
                continue
            s = x
            while x < w and not solid_row(y, x):
                x += 1
            if 0.02 * w <= x - s <= 0.14 * w and s > 0.6 * w:
                socket = (min(socket[0], s), min(socket[1], y), max(socket[2], x), max(socket[3], y + 1)) \
                    if socket else (s, y, x, y + 1)

    # Ниша шире выреза на WELL_GROW px рендера: при уменьшении картинки её прозрачный край
    # размазывается внутрь рамки, и узкая ниша его не догоняет. Но ниша не должна выходить на
    # «улицу» (пиксели, связанные с краем картинки) — иначе тёмный край вылезет за корпус.
    def street_inside(x1, y1, x2, y2):
        return sum(outside[y * w + x] for y in range(max(0, y1), min(h, y2)) for x in range(max(0, x1), min(w, x2)))

    def well(x1, y1, x2, y2):
        for by in (WELL_GROW, 2, 0):
            r = (x1 - by, y1 - by, x2 + by, y2 + by)
            if not street_inside(*r):
                return r
        return (x1, y1, x2, y2)

    # Под экраном и клавиатурой — одним прямоугольником, если он весь внутри корпуса;
    # иначе — по нише на каждую деталь
    parts = [lcd] + keys
    block = well(min(c[1] for c in parts), min(c[2] for c in parts), max(c[3] for c in parts), max(c[4] for c in parts))
    wells = [block] if not street_inside(*block) else [well(*c[1:]) for c in parts]
    wells += [well(*c[1:]) for c in notches + small]
    if socket:
        # Гнездо открыто вверх — вверх нишу не растим, только вбок (в приливы) и вниз (в дно)
        x1, y1, x2, y2 = socket
        for by in (WELL_GROW, 2, 0):
            strips = [(x1 - by, y1, x1, y2), (x2, y1, x2 + by, y2), (x1 - by, y2, x2 + by, y2 + by)]
            if not any(street_inside(*s) for s in strips):
                break
        wells.append((x1 - by, y1, x2 + by, y2 + by))

    pct = lambda v, size: v / size * 100
    box = lambda c: (pct(c[1], w), pct(c[2], h), pct(c[3] - c[1], w), pct(c[4] - c[2], h))
    return dict(name=name, w=w, h=h, lcd=box(lcd), rows=[[box(c) for c in r] for r in rows],
                notches=[box(c) for c in notches], wells=wells,
                led=box(led) if led else None, torch=box(torch) if torch else None,
                socket=(pct(socket[0], w), pct(socket[1], h), pct(socket[2] - socket[0], w), pct(socket[3] - socket[1], h)) if socket else None)


def f(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.') + '%'


def px(v):
    return f'{v:.1f}'.rstrip('0').rstrip('.') + 'px'


def css_for(g):
    sel = f'html:root[data-skin="{g["name"]}"]'
    out = [f'/* {g["name"]}: рендер {g["w"]}×{g["h"]} */']

    sx, sy = RIG_W / g['w'], RIG_H / g['h']
    layers = ['var(--skin-body) 0 0 / 100% 100% no-repeat']
    for x1, y1, x2, y2 in g['wells']:
        layers.append(f'linear-gradient(var(--skin-well), var(--skin-well)) '
                      f'{px(x1 * sx)} {px(y1 * sy)} / {px((x2 - x1) * sx)} {px((y2 - y1) * sy)} no-repeat')
    out.append(f'{sel} .rig {{\n  background:\n    ' + ',\n    '.join(layers) + ';\n}')

    l, t, w, h = g['lcd']
    out.append(f'{sel} .lcd {{ left: {f(l - LCD_PAD)}; top: {f(t - LCD_PAD)}; '
               f'width: {f(w + 2 * LCD_PAD)}; height: {f(h + 2 * LCD_PAD)}; }}')

    # Кнопка — по центру своего выреза; больше выреза, но не наезжает на соседнюю
    keys = [k for r in g['rows'] for k in r]
    cols = [sum(r[col][0] + r[col][2] / 2 for r in g['rows']) / 4 for col in range(4)]
    rows = [sum(k[1] + k[3] / 2 for k in r) / 4 for r in g['rows']]
    kw = min(sum(k[2] for k in keys) / 16 * KEY_SCALE[0], (cols[3] - cols[0]) / 3 - KEY_GAP)
    kh = min(sum(k[3] for k in keys) / 16 * KEY_SCALE[1], (rows[3] - rows[0]) / 3 - KEY_GAP)
    out.append(f'{sel} .key {{ width: {f(kw)}; height: {f(kh)}; }}')
    for cx, nth in zip(cols, ['4n + 1', '4n + 2', '4n + 3', '4n']):
        out.append(f'{sel} .key:nth-child({nth}) {{ left: {f(cx - kw / 2)}; }}')
    for cy, nth in zip(rows, ['-n + 4', 'n + 5):nth-child(-n + 8', 'n + 9):nth-child(-n + 12', 'n + 13']):
        out.append(f'{sel} .key:nth-child({nth}) {{ top: {f(cy - kh / 2)}; }}')

    def side(n, pad):
        l, t, w, h = n
        return l + pad[0], t + pad[1], w - pad[0] + pad[2], h - pad[1] + pad[3]

    ptt = max(g['notches'], key=lambda n: n[3])
    small = [n for n in g['notches'] if n is not ptt and n[1] > ptt[1]]
    l, t, w, h = side(ptt, PTT_PAD)
    out.append(f'{sel} .side__ptt {{ left: {f(l)}; top: {f(t)}; width: {f(w)}; height: {f(h)}; }}')
    if small:
        l, t, w, h = side(small[0], SIDE_PAD)
        out.append(f'{sel} #side1 {{ left: {f(l)}; top: {f(t)}; width: {f(w)}; height: {f(h)}; }}')
        if len(small) > 1:  # у второй малой свой вырез
            l, t, w, h = side(small[1], SIDE_PAD)
        else:
            t += SIDE2_STEP
        out.append(f'{sel} #side2 {{ left: {f(l)}; top: {f(t)}; width: {f(w)}; height: {f(h)}; }}')

    if g['socket']:
        l, _, w, _ = g['socket']
        out.append(f'{sel} .knob {{ left: {f(l + w / 2 - KNOB_W / 2)}; }}')
    # Светодиод и фонарик — живые (горят на передаче/приёме, светят) — в свои вырезы
    for part in ('led', 'torch'):
        if g[part]:
            l, t, w, h = g[part]
            out.append(f'{sel} .{part} {{ left: {f(l)}; top: {f(t)}; width: {f(w)}; height: {f(h)}; }}')
    return '\n'.join(out)


def main():
    blocks = []
    for name in SKINS:
        g = measure(name)
        blocks.append(css_for(g))
        print(f'{name:10s} {g["w"]}×{g["h"]}: экран {", ".join(f(v) for v in g["lcd"])}, '
              f'боковых вырезов {len(g["notches"])}, гнездо ручки {"есть" if g["socket"] else "нет"}, '
              f'светодиод {"есть" if g["led"] else "нет"}, фонарик {"есть" if g["torch"] else "нет"}, '
              f'слоёв ниши {len(g["wells"])}')
    text = BEGIN + '\n' + '\n\n'.join(blocks) + '\n' + END
    for css in CSS_FILES:
        src = css.read_text(encoding='utf-8')
        if BEGIN in src and END in src:
            head, rest = src.split(BEGIN, 1)
            src = head + text + rest.split(END, 1)[1]
        else:
            src = src.rstrip('\n') + '\n\n' + text + '\n'
        css.write_text(src, encoding='utf-8')
        print('записан', css.relative_to(ROOT))


if __name__ == '__main__':
    main()
