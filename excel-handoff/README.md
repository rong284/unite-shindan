# excel-handoff

Excel（パラメータDB）が唯一の正本です。このフォルダには、Excel へ書き戻す前の中間ファイルだけを置きます。

| ファイル | 作り方 | 使い方 |
| --- | --- | --- |
| `calibration.json` | `node tools/calibrate-model.mjs`（疑似回答 20,000件で Percentile 分位点、別の7,000件で RankBias、さらに別の7,000件で監査） | `python3 tools/excel_patch.py --calibration excel-handoff/calibration.json` で Excel の `Percentile_Calibration` シートと `Profiles_140` の RankBias 列へ書き戻し、`python3 tools/export_excel.py` で書き出す |

テスト（`node tests/run-tests.mjs`）が、`calibration.json` の値と Excel から書き出した `data/profiles.json` の値が一致することを確認します。

## 2026-10-03 の変更（経緯）

* **回答スタイル補正を Excel に実装**: `Model_Formula` K4:L10 に `ResponseStyle` ブロック（Enabled / Target 0.425 / Strength 1 / MinScale 0.8 / MaxScale 1.6 / RampExtremity 0.2）、`Simulator` の P5:P7 に ResponseExtremity と補正倍率、N5:N34 に補正後の正規化回答を追加し、性格7軸（G5:M5）と補助嗜好（J11:J25）の式を N列参照に変更。以前 `data/tuning.json` にあった設定はこちらへ移した。
* **Percentile・RankBias を Excel へ書き戻し**: 以前はサイト側の `data/calibration.json` が Excel の値を上書きしていたが、現在は Excel の値だけを使う。
* **結合セルの修正**: `Model_Formula` A11:J11（SpecificityCap の F11 を隠していた）を A11:D11 に、`Match_140` A3:X3（PlayerSignal の計算に使う F3:X3 の数式を隠していたため、Excel では Shape 補正が常に0になっていた）を解除。重なっていた見出しの結合（Match_140 / Questions_30 / Calibration_Audit / Distinctiveness_Audit / README）は大きい方だけ残した。
* 紹介文（ResultComment）とキーワード（StyleKeywords）を130プロファイルぶん書き直し、キーワードの語彙を `Axes` I・J列に追加。
