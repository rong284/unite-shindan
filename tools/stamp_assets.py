#!/usr/bin/env python3
"""JS・CSS の参照に版番号（中身のハッシュ）を付ける。

    python3 tools/stamp_assets.py          # 参照を書き換える
    python3 tools/stamp_assets.py --check  # 書き換えが必要かだけ確認（必要なら終了コード1）

ブラウザは JS（特に import で読み込むモジュール）を強くキャッシュするため、
ファイルを更新しても古い版と新しい版が混ざって動かなくなることがある。
そこで import './model.js' を import './model.js?v=1a2b3c4d' のように、
中身が変わるとURLも変わる形にしておく。

JS・CSS を編集したら、コミット前に必ず実行すること（テストでも確認している）。
"""

from __future__ import annotations

import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "diagnosis.html", "result.html", "random.html"]

# from './x.js' / from './x.js?v=abc' / import './x.js'
IMPORT_PATTERN = re.compile(r"""((?:from|import)\s*['"])\./([\w.-]+\.js)(?:\?v=[0-9a-f]+)?(['"])""")
# src="./js/x.js" / href="./css/x.css"（?v= の有無を問わない）
PAGE_PATTERN = re.compile(r"""((?:src|href)=")\./((?:js|css)/[\w.-]+\.(?:js|css))(?:\?v=[0-9a-f]+)?(")""")


def digest(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), encoding="utf-8") as handle:
        return handle.read()


def main() -> int:
    check_only = "--check" in sys.argv
    outputs: dict[str, str] = {}
    hashes: dict[str, str] = {}
    visiting: set[str] = set()

    def stamp_module(path: str) -> str:
        """依存先から順に書き換え、書き換え後の中身のハッシュを返す。"""
        if path in hashes:
            return hashes[path]
        if path in visiting:
            raise SystemExit(f"循環 import があります: {path}")
        visiting.add(path)
        source = read(path)
        folder = os.path.dirname(path)

        def replace(match: re.Match) -> str:
            dependency = os.path.join(folder, match.group(2))
            return f"{match.group(1)}./{match.group(2)}?v={stamp_module(dependency)}{match.group(3)}"

        stamped = IMPORT_PATTERN.sub(replace, source)
        visiting.discard(path)
        outputs[path] = stamped
        hashes[path] = digest(stamped)
        return hashes[path]

    for page in PAGES:
        source = read(page)

        def replace_page(match: re.Match) -> str:
            asset = match.group(2)
            version = stamp_module(asset) if asset.endswith(".js") else digest(read(asset))
            return f"{match.group(1)}./{asset}?v={version}{match.group(3)}"

        outputs[page] = PAGE_PATTERN.sub(replace_page, source)

    changed = [path for path, text in outputs.items() if read(path) != text]
    if check_only:
        if changed:
            print("版番号が古いファイル:", ", ".join(sorted(changed)))
            print("python3 tools/stamp_assets.py を実行してください。")
            return 1
        print("版番号はすべて最新です。")
        return 0

    for path in changed:
        with open(os.path.join(ROOT, path), "w", encoding="utf-8") as handle:
            handle.write(outputs[path])
        print(f"  更新: {path}")
    print("完了" if changed else "変更なし（すべて最新）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
