#!/usr/bin/env python3
"""X などのリンクカード用に、ポケモンごとのカード画像とシェア用ページを作る。

    .venv/bin/python tools/build_share_cards.py          # og/*.png と share/*.html を作り直す
    .venv/bin/python tools/build_share_cards.py --check  # 作り直しが必要かだけ確認（必要なら終了コード1）

GitHub Pages は静的サイトなので、result.html?a=... ごとにリンクカードの画像を変えることはできない。
そこでロスターの全ポケモンについて、あらかじめ
  og/pNNN.png         … 1200×630 のカード画像（相棒候補のポケモン名・ロール。公式画像は使わない）
  share/pNNN.html     … og:image にその画像を指定したページ。開いた人は result.html?a=... へすぐ移動する
を作っておき、結果のシェアURLを share/pNNN.html?a=回答 にする（NNN はロスターの No.）。
X はシェア用ページのカード画像を読み、リンクを踏んだ人には本人と同じ結果ページが表示される。
参考結果（回答の情報が少ない）とトップページ用には共通カード og/common.png / share/common.html を使う。
index.html などの各ページの og:image / twitter:image も、共通カードの URL にそろえる。

フォントは tools/fonts/DotGothic16-Regular.ttf（SIL Open Font License。tools/fonts/OFL.txt）。
ロスター・表示名・公開URL（data/display.json の site.url）を変えたら実行し直す（テストで確認している）。
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, "tools", "fonts", "DotGothic16-Regular.ttf")
OG_DIR = os.path.join(ROOT, "og")
SHARE_DIR = os.path.join(ROOT, "share")
WIDTH, HEIGHT = 1200, 630
VERSION = "1"  # デザインを変えたら上げる（キャッシュ対策として画像URLに付ける）
# 共通カード（og/common.png）を og:image / twitter:image に使うページ
PAGES = ["index.html", "diagnosis.html", "result.html", "random.html"]
IMAGE_META = re.compile(r'(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(")')

# css/style.css の色に合わせる
BG_TOP, BG_BOTTOM = (61, 50, 133), (29, 36, 71)
PANEL, PANEL_EDGE, DEEP = (42, 52, 98), (67, 82, 143), (20, 26, 54)
INK, INK_DIM, ACCENT = (255, 255, 255), (198, 204, 232), (255, 212, 71)
ROLE_COLORS = {
    "アタック型": (255, 158, 149),
    "バランス型": (213, 175, 255),
    "スピード型": (140, 202, 255),
    "ディフェンス型": (76, 217, 123),
    "サポート型": (255, 210, 63),
}


def read_json(relative: str):
    with open(os.path.join(ROOT, relative), encoding="utf-8") as handle:
        return json.load(handle)


def display_name(name: str) -> str:
    """js/ui.js の displayPokemonName と同じ（半角括弧を全角に）。"""
    return name.replace("(", "（").replace(")", "）")


def slug(entry: dict) -> str:
    return f"p{entry['no']:03d}"


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def fit_font(text: str, max_width: int, start: int, minimum: int) -> ImageFont.FreeTypeFont:
    size = start
    while size > minimum and font(size).getlength(text) > max_width:
        size -= 2
    return font(size)


def background() -> Image.Image:
    """サイトと同じ縦グラデーションに、ドットの格子を重ねる。"""
    image = Image.new("RGB", (WIDTH, HEIGHT), BG_BOTTOM)
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        t = y / (HEIGHT - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        draw.line([(0, y), (WIDTH, y)], fill=color)
    for y in range(8, HEIGHT, 16):
        for x in range(8, WIDTH, 16):
            draw.rectangle([x, y, x + 1, y + 1], fill=(70, 78, 140))
    return image


def pixel_frame(draw: ImageDraw.ImageDraw, box, color, width=8, notch=8):
    """角を1ドット欠いたピクセル風の枠。"""
    x0, y0, x1, y1 = box
    draw.rectangle(box, fill=color)
    draw.rectangle([x0 + width, y0 + width, x1 - width, y1 - width], fill=PANEL)
    for cx, cy in ((x0, y0), (x1 - notch + 1, y0), (x0, y1 - notch + 1), (x1 - notch + 1, y1 - notch + 1)):
        draw.rectangle([cx, cy, cx + notch - 1, cy + notch - 1], fill=BG_BOTTOM)


def shadow_text(draw, xy, text, fnt, fill, shadow=DEEP, offset=6, anchor="mm"):
    x, y = xy
    draw.text((x + offset, y + offset), text, font=fnt, fill=shadow, anchor=anchor)
    draw.text((x, y), text, font=fnt, fill=fill, anchor=anchor)


def badge(draw, center_x, y, text, fnt, color, fill=None, padding=(22, 10)):
    width = fnt.getlength(text)
    x0 = center_x - width / 2 - padding[0]
    x1 = center_x + width / 2 + padding[0]
    box = [x0, y, x1, y + fnt.size + padding[1] * 2]
    draw.rectangle(box, fill=fill or DEEP, outline=color, width=4)
    draw.text((center_x, y + padding[1] + fnt.size / 2), text, font=fnt, fill=color, anchor="mm")
    return box


def header(draw, site_name: str):
    label = "非公式 ポケモンユナイト ファン診断"
    small = font(30)
    w = small.getlength(label)
    draw.rectangle([60, 52, 60 + w + 40, 52 + 54], outline=ACCENT, width=4, fill=DEEP)
    draw.text((80, 79), label, font=small, fill=ACCENT, anchor="lm")
    draw.text((WIDTH - 64, 79), site_name, font=font(36), fill=INK, anchor="rm")


def footer(draw, url: str, color):
    draw.rectangle([0, HEIGHT - 86, WIDTH, HEIGHT], fill=DEEP)
    for x in range(0, WIDTH, 24):
        draw.rectangle([x, HEIGHT - 92, x + 11, HEIGHT - 87], fill=color if (x // 24) % 2 else ACCENT)
    draw.text((64, HEIGHT - 43), "あなたの相棒は？ 30問で全100体から診断", font=font(32), fill=INK, anchor="lm")
    draw.text((WIDTH - 64, HEIGHT - 43), url.replace("https://", "").rstrip("/"), font=font(26), fill=INK_DIM, anchor="rm")


def pokemon_card(entry: dict, site: dict) -> Image.Image:
    color = ROLE_COLORS.get(entry["officialRole"], ACCENT)
    image = background()
    draw = ImageDraw.Draw(image)
    header(draw, site["name"])
    pixel_frame(draw, [60, 132, WIDTH - 60, HEIGHT - 122], color)
    draw.text((WIDTH / 2, 186), "診断で出た相棒候補は", font=font(36), fill=INK_DIM, anchor="mm")
    name = display_name(entry["name"])
    shadow_text(draw, (WIDTH / 2, 284), name, fit_font(name, 980, 140, 70), color)
    badge(draw, WIDTH / 2, 386, entry["officialRole"], font(32), color)
    footer(draw, site["url"], color)
    return image


def common_card(site: dict, count: int) -> Image.Image:
    image = background()
    draw = ImageDraw.Draw(image)
    header(draw, site["name"])
    pixel_frame(draw, [60, 132, WIDTH - 60, HEIGHT - 122], ACCENT)
    shadow_text(draw, (WIDTH / 2, 232), "あなたのOTPを", font(96), INK)
    shadow_text(draw, (WIDTH / 2, 340), "見つけよう", font(96), ACCENT)
    draw.text((WIDTH / 2, 430), f"全{count}体から、プレイの好みに合う相棒を診断", font=font(34), fill=INK_DIM, anchor="mm")
    footer(draw, site["url"], ACCENT)
    return image


def font_digest() -> str:
    with open(FONT, "rb") as handle:
        return hashlib.sha1(handle.read()).hexdigest()[:12]


def card_key(*parts) -> str:
    """画像の入力（表示する文字・色・公開URL・デザインの版・フォント）から作るキー。
    Pillow や FreeType の版で PNG のバイト列が変わっても、入力が同じなら同じキーになる。"""
    return hashlib.sha1("|".join(map(str, (VERSION, font_digest(), *parts))).encode("utf-8")).hexdigest()


def png_bytes(image: Image.Image, key: str) -> bytes:
    info = PngInfo()
    info.add_text("card-key", key)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True, pnginfo=info)
    return buffer.getvalue()


def stored_key(path: str):
    try:
        with Image.open(path) as image:
            return image.text.get("card-key") if image.size == (WIDTH, HEIGHT) else None
    except (OSError, ValueError):
        return None


def share_page(site: dict, slug_name: str, title: str, description: str, image_alt: str) -> str:
    image_url = f"{site['url']}og/{slug_name}.png?v={VERSION}"
    e = lambda text: html.escape(text, quote=True)  # noqa: E731
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="robots" content="noindex">
<meta name="description" content="{e(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{e(site['name'])}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:image" content="{e(image_url)}">
<meta property="og:image:width" content="{WIDTH}">
<meta property="og:image:height" content="{HEIGHT}">
<meta property="og:image:alt" content="{e(image_alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{e(title)}">
<meta name="twitter:description" content="{e(description)}">
<meta name="twitter:image" content="{e(image_url)}">
<meta name="twitter:image:alt" content="{e(image_alt)}">
<meta name="theme-color" content="#0d1020">
<script>
  // リンクカード用のページ。開いた人は、URLの回答（?a=...）のまま結果ページへ移動する
  location.replace('../result.html' + location.search + location.hash);
</script>
</head>
<body style="background:#1d2447;color:#fff;font-family:sans-serif;text-align:center;padding:48px 16px">
<p>診断結果を開いています…</p>
<p><a id="link" href="../index.html" style="color:#ffd447">開かない場合はこちら</a></p>
<script>document.getElementById('link').href = '../result.html' + location.search;</script>
</body>
</html>
"""


def build(display: dict, roster: dict) -> dict:
    """出力するファイル {相対パス: bytes（HTML）または (描画関数, 引数, キー)（PNG）}。"""
    site = display["site"]
    count = len(roster["pokemon"])
    outputs = {}
    description = f"30問に答えて、ポケモンユナイト全{count}体からあなたのOTP（使い込みたい相棒）を探す非公式ファン診断です。あなたの相棒は？"
    outputs["og/common.png"] = (common_card, (site, count), card_key("common", site["url"], site["name"], count))
    outputs["share/common.html"] = share_page(
        site, "common", f"あなたのOTPを見つけよう｜{site['name']}", description, f"{site['name']}：あなたのOTPを見つけよう"
    ).encode("utf-8")
    for entry in roster["pokemon"]:
        name = display_name(entry["name"])
        key = slug(entry)
        outputs[f"og/{key}.png"] = (pokemon_card, (entry, site), card_key(name, entry["officialRole"], site["url"], site["name"]))
        outputs[f"share/{key}.html"] = share_page(
            site,
            key,
            f"相棒候補は「{name}」｜{site['name']}",
            description,
            f"{site['name']}：診断で出た相棒候補は{name}（{entry['officialRole']}）",
        ).encode("utf-8")
    # 各ページの共通カードのURLも、公開URLと版番号にそろえる
    common_url = f"{site['url']}og/common.png?v={VERSION}"
    for page in PAGES:
        with open(os.path.join(ROOT, page), encoding="utf-8") as handle:
            source = handle.read()
        if not IMAGE_META.search(source):
            raise SystemExit(f"{page} に og:image / twitter:image の meta がありません")
        outputs[page] = IMAGE_META.sub(lambda m: f"{m.group(1)}{html.escape(common_url, quote=True)}{m.group(2)}", source).encode("utf-8")
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="作り直しが必要かだけ確認する")
    args = parser.parse_args()
    outputs = build(read_json("data/display.json"), read_json("data/roster.json"))

    expected = {os.path.join(ROOT, path) for path in outputs if path.startswith(("og/", "share/"))}
    existing = {
        os.path.join(folder, name)
        for folder in (OG_DIR, SHARE_DIR)
        if os.path.isdir(folder)
        for name in os.listdir(folder)
    }
    def is_stale(path, data):
        full = os.path.join(ROOT, path)
        if isinstance(data, tuple):
            return stored_key(full) != data[2]
        return not os.path.exists(full) or open(full, "rb").read() != data

    stale = [p for p, data in outputs.items() if is_stale(p, data)]
    extra = sorted(os.path.relpath(p, ROOT) for p in existing - expected)

    if args.check:
        if stale or extra:
            print(f"作り直しが必要: 変更 {len(stale)} 件 / 不要 {len(extra)} 件（.venv/bin/python tools/build_share_cards.py を実行）")
            return 1
        print(f"リンクカード画像とシェア用ページは最新です（{len(outputs)} ファイル）。")
        return 0

    os.makedirs(OG_DIR, exist_ok=True)
    os.makedirs(SHARE_DIR, exist_ok=True)
    for path in stale:
        data = outputs[path]
        if isinstance(data, tuple):
            draw_card, card_args, key = data
            data = png_bytes(draw_card(*card_args), key)
        with open(os.path.join(ROOT, path), "wb") as handle:
            handle.write(data)
    for path in extra:
        os.remove(os.path.join(ROOT, path))
    print(f"更新 {len(stale)} 件 / 削除 {len(extra)} 件（全 {len(outputs)} ファイル）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
