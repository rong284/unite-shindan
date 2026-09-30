#!/usr/bin/env python3
"""ローカル確認用の簡易サーバー（キャッシュ無効）。

    python3 tools/serve.py        # http://localhost:8000/
    python3 tools/serve.py 8080   # ポート指定

python3 -m http.server と同じだが、Cache-Control: no-cache を付けるので、
HTML・JS・JSONを更新したあとにブラウザが古いファイルを使い続けることがない。
"""

import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("", port), handler) as server:
        print(f"http://localhost:{port}/ で配信中（Ctrl+C で終了）", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
