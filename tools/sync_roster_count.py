#!/usr/bin/env python3
"""HTML に書いてある「全N体」を data/roster.json のポケモン数にそろえる。

    python3 tools/sync_roster_count.py          # 書き換える
    python3 tools/sync_roster_count.py --check  # ずれていないかだけ確認（ずれていれば終了コード1）

meta description や OGP はクローラーが JS を実行しないため、HTML に数字を直接書いておく必要がある。
新しいポケモンを追加して export_excel.py を実行したら、このスクリプトも実行すること（テストでも確認している）。
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "diagnosis.html", "result.html", "random.html"]
COUNT_PATTERN = re.compile(r"全\d+体")


def main() -> int:
    check_only = "--check" in sys.argv
    with open(os.path.join(ROOT, "data", "roster.json"), encoding="utf-8") as handle:
        count = len(json.load(handle)["pokemon"])
    expected = f"全{count}体"

    stale = []
    for page in PAGES:
        path = os.path.join(ROOT, page)
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
        updated = COUNT_PATTERN.sub(expected, source)
        if updated == source:
            continue
        stale.append(page)
        if not check_only:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(updated)

    if check_only:
        if stale:
            print(f"「{expected}」になっていないページ: {', '.join(stale)}（python3 tools/sync_roster_count.py を実行してください）")
            return 1
        print(f"すべてのページが「{expected}」です。")
        return 0
    print(f"「{expected}」に更新: {', '.join(stale) if stale else 'なし'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
