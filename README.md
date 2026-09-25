# あなたにおすすめのユナイトポケモン診断

Pokémon UNITE を題材にした、**非公式・お遊びの診断サイト**です。
サーバー・DB・ログインを使わない静的サイト（HTML / CSS / Vanilla JavaScript）で、GitHub Pages に置くだけで動きます。

主な機能は2つです。

1. **性格診断** … 30問の回答から性格7軸・プレイスタイル15軸を算出し、140プロファイル（100体＋型分け）と照合しておすすめを出す
2. **ランダム抽選** … 現行100体からランダムに1体選ぶ（全体／ロール別／診断TOP10から）

計算ロジックと全パラメータは Excel（パラメータDB）を正とし、`tools/export_excel.py` で `data/*.json` に書き出して使います。

---

## ディレクトリ構成

```text
.
├─ index.html              トップページ
├─ diagnosis.html          30問の診断
├─ result.html             診断結果
├─ random.html             ランダム抽選
├─ css/style.css
├─ js/
│  ├─ model.js             診断エンジン（純粋な計算。DOMに触らない）
│  ├─ comment.js           性格タイプ判定・結果コメント生成
│  ├─ data.js              data/*.json の読み込み
│  ├─ storage.js           localStorage への保存
│  ├─ share.js             回答のURLエンコードとXシェア
│  ├─ ui.js                画面まわりの共通処理
│  ├─ home.js / diagnosis.js / result.js / random.js   各ページの処理
├─ data/                   パラメータ（後述）
├─ tools/export_excel.py   Excel → JSON 変換
├─ tests/run-tests.mjs     テスト（Nodeのみ、外部ライブラリ不要）
├─ tests/fixtures/excel_baseline.json  Excelの計算結果（テストの期待値・自動生成）
├─ package.json            テスト実行用（サイト本体はビルド不要）
└─ Pokemon_UNITE_diagnosis_parameter_db_with_model_*.xlsx   パラメータDB（データの正）
```

ビルド工程はありません。HTML / CSS / JS をそのまま配信します。

---

## ローカルでの起動方法

ES Modules と `fetch` を使うため、`file://` で直接開くと動きません。簡易サーバーを立ててください。

```bash
python3 -m http.server 8000
#   → http://localhost:8000/ を開く
```

`npm run serve` でも同じコマンドが動きます（Node は不要。テスト実行にだけ使います）。

---

## GitHub Pages への公開方法

1. このディレクトリをそのまま GitHub のリポジトリに push する
2. リポジトリの **Settings → Pages** で、Source を「Deploy from a branch」、Branch を `main` / `(root)` に設定する
3. `https://<ユーザー名>.github.io/<リポジトリ名>/` にアクセスする

* すべてのパスは相対パス（`./css/...`、`./js/...`、JS内は `import.meta.url` 基準）なので、サブディレクトリ公開でも壊れません。
* Jekyll の処理を避けるため `.nojekyll` を置いています。
* `data/*.json` はブラウザから直接 `fetch` します。公開したくないデータは置かないでください。

---

## Excel → JSON の更新方法

```bash
# 初回のみ（環境によっては venv 推奨）
python3 -m venv .venv && . .venv/bin/activate
pip install openpyxl

# 変換（リポジトリ直下の最新 .xlsx を自動で拾います）
python3 tools/export_excel.py

# ファイルを明示する場合
python3 tools/export_excel.py path/to/book.xlsx

# 書き込まずに件数・整合性だけ確認する
python3 tools/export_excel.py --check
```

運用の流れは次のとおりです。

```text
Excelを修正 → python3 tools/export_excel.py → node tests/run-tests.mjs → git push
```

変換時に以下をチェックし、問題があれば書き出さずに終了します。

* ProfileID の重複、Roster と Profiles のポケモン不一致
* 15軸の値が 0〜100 の範囲外
* Roster の `ProfileCount` と Profiles_140 の実件数の不一致
* 翻訳係数・マッチング設定に抜けている軸がないか
* `P_*`（性格座標）の再計算値が Excel のキャッシュ値と食い違っていないか（警告）

> Excel を **Excel/Googleスプレッドシート以外**（スクリプト等）で編集した場合、数式のキャッシュ値が古いままになることがあります。
> その状態で書き出すと `tests/fixtures/excel_baseline.json`（テストの期待値）が古い値になるため、一度 Excel で開いて保存し直してください。

---

## 各JSONの役割

| ファイル | 生成元 | 内容 |
| --- | --- | --- |
| `data/model.json` | Excel `Model_Formula` / `Axes` | 回答尺度、7軸→15軸の翻訳係数、軸ごとの Weight / OverReqPenalty / PreferenceBlend、軸の日本語名 |
| `data/questions.json` | Excel `Questions_30` | 30問の質問文と、各質問の性格7軸・ゲーム15軸 Loading（0の係数は省略） |
| `data/profiles.json` | Excel `Profiles_140` | 140プロファイルの15軸、技構成名、ロール、アーキタイプ、性格座標 |
| `data/roster.json` | Excel `Roster_100` | 現行100体の一覧とロール別件数（ランダム抽選で使用） |
| `data/archetypes.json` | Excel `Archetypes` | アーキタイプ別の15軸リファレンス（調整時の参考値） |
| `data/comments.json` | **手編集** | 結果コメントの文章パーツ・テンプレート・ロール別／アーキタイプ別の一言 |
| `data/personality-types.json` | **手編集** | 性格タイプ名（28種）と判定条件 |
| `data/display.json` | **手編集** | 1画面あたりの質問数、TOP件数、「意外な適性」の選出条件、シェア文テンプレート、抽選時の一言 |

`tools/export_excel.py` が上書きするのは上の表の「生成元: Excel」の4＋1ファイルだけです。手編集のファイルは触りません。

---

## 診断計算の流れ

```text
30問の回答（1〜5）
  ↓ 正規化   1=-1.0 / 2=-0.5 / 3=0 / 4=+0.5 / 5=+1.0
性格7軸      50 + 50 × Σ(正規化 × QuestionLoading) / Σ|Loading|     → 0〜100 にClamp
  ↓ 正規化   (score - 50) / 50
15ゲーム軸   50 + 50 × Σ(正規化性格 × 翻訳係数) / Σ|翻訳係数|        → 0〜100 にClamp
  ↓
直接嗜好     50 + 50 × Σ(正規化 × ゲーム軸Loading) / Σ|Loading|      ※Q21〜Q30
  ↓
最終15軸     翻訳値 × (1 - PreferenceBlend) + 嗜好値 × PreferenceBlend
  ↓
マッチング   軸別誤差 = Weight × (ポケモン要求値 - プレイヤー値)^2 × penalty
             penalty = 要求値がプレイヤーを上回るとき 1 + OverReqPenalty、それ以外は 1
             WeightedMSE = Σ軸別誤差 / ΣWeight
             MatchScore  = max(0, 100 - √WeightedMSE)
  ↓
順位付け     140プロファイルすべてを計算 → ポケモン単位に畳み込み（最も相性の高い型を代表型に）
             → TOP3は必ず異なるポケモン／「意外な適性」を1件
```

対応する関数は `js/model.js` の
`calculatePersonality()` → `translateToGameplay()` → `calculatePreferences()` → `calculateFinalAxes()` → `calculateMatch()` / `rankProfiles()` / `pickSurprisePick()`、
文章生成は `js/comment.js` の `determinePersonalityType()` / `generateResultComment()` です。
`runDiagnosis()` がこれらをまとめて呼ぶので、UI側は結果オブジェクトを表示するだけです。

### 「意外な適性」の選び方

1位と **公式ロールが違う**・**アーキタイプが違う**・**15軸の平均差が一定以上** の候補のうち、
`MatchScore + 15軸の差 × 係数` が最大のものを1件選びます。条件に合う候補が無い場合は、条件を段階的に緩めます。
しきい値は `data/display.json` の `surprise` で調整できます。

---

## パラメータを変更する場所

| 変えたいもの | 場所 |
| --- | --- |
| 質問文・質問の並び | Excel `Questions_30` の「質問文」列 |
| Question Loading（各質問が効く軸と強さ） | Excel `Questions_30` の F〜AA 列 |
| ポケモンの15軸・技構成名・型分け | Excel `Profiles_140` |
| 7軸→15軸の翻訳係数 | Excel `Model_Formula` B13:H27 |
| Match Weight | Excel `Model_Formula` M列 |
| OverReqPenalty | Excel `Model_Formula` N列 |
| PreferenceBlend（軸別） | Excel `Model_Formula` O列 |
| 回答の選択肢ラベル・正規化係数 | Excel `Model_Formula` A5:C9 |
| 結果コメントの言い回し | `data/comments.json` |
| 性格タイプ名・判定条件 | `data/personality-types.json` |
| 1画面の質問数・TOP件数・シェア文・抽選の一言 | `data/display.json` |

質問数を増減しても計算式は係数の合計から自動で決まるため、コード修正は不要です
（保存済みの途中回答は質問数が変わると自動で破棄されます）。

### 性格タイプの追加方法

`data/personality-types.json` の `types` に1件足すだけです。

```json
{
  "id": "my-type",
  "name": "新しいタイプ名",
  "tagline": "一言説明",
  "require": [{ "axis": "Engage", "min": 56 }],
  "weights": { "Engage": 1.0, "Peel": -0.2 }
}
```

* `require` をすべて満たしたタイプの中で `score` が最大のものが選ばれます。
* `score = Σ weights[軸] × (軸の値 - 50) / 50`
* 軸キーは15ゲーム軸のキー、または性格7軸に `P_` を付けたキー（`P_Mastery` など）が使えます。
* どれも条件を満たさない場合は `fallback` が使われます。

---

## デバッグモード

URLに `?debug=1` を付けたときだけ有効になります（通常のユーザーには表示されません）。

* `diagnosis.html?debug=1` … 全問1 / 全問3 / 全問5 / ランダム回答の一括入力、現在の回答配列の表示、結果ページへのショートカット
* `result.html?debug=1` … 性格7軸（スコアと正規化値）、翻訳前15軸・Preference値・Blend・最終15軸、1位の軸別誤差（要求値・プレイヤー値・Weight・Penalty・誤差）、全140プロファイルのMatchScoreとRMSE、タイプ判定のスコアと次点

ページ間を移動しても `debug=1` は引き継がれます。

---

## テスト

```bash
node tests/run-tests.mjs      # または npm test
```

確認している内容は次のとおりです。

* 全回答3のとき性格7軸が50になる／極端な回答でも0〜100に収まる
* 最終15軸・MatchScore が0〜100に収まる
* 全140プロファイルが計算対象になる（ProfileIDの重複なし）
* 同点でも順位処理が壊れない（同順位の付与と、並びの再現性）
* 同一ポケモンの別型がTOP3を独占しない／代表型はそのポケモンの最高スコアの型になる
* JSONのポケモン数・プロファイル数・質問数がExcelと一致する
* **Excel `Simulator` と同じ回答を入れたとき、性格7軸・翻訳15軸・嗜好15軸・最終15軸・上位10件のMatchScoreが一致する**（許容誤差 0.01）
* 性格タイプが必ず決まり、コメントにテンプレートの置換漏れが無い
* シェアURLの回答エンコードが往復する（14文字程度）
* 各ページのスクリプトが参照する要素IDがHTMLに存在する／ルート絶対パスを使っていない

---

## 保存と共有

* **途中保存**: 回答するたびに `localStorage` に保存され、ブラウザを閉じても再開できます（トップページに再開導線が出ます）。
* **結果の保存**: 回答・性格7軸・最終15軸・おすすめTOP10を保存します。ランダム抽選の「診断TOP10から」で再利用します。
* **やり直し**: 診断ページの「最初から診断し直す」で保存内容を消去します。
* **シェアURL**: 30問の回答を5進数→36進数に詰めて `result.html?a=xxxxxxxxxxxxxx` の14文字程度にしています。URLを開くと同じ結果を再計算して表示します（スコアそのものではなく回答を保存しているため、パラメータを更新すると結果も最新の計算に追従します）。
* ランダム結果は `random.html?p=<ロスター番号>&m=<モード>` で再表示できます。

---

## 権利について

* このサイトは Pokémon UNITE の**非公式ファンサイト**です。株式会社ポケモン、任天堂、Creatures、Game Freak、TiMi Studio Group 等とは一切関係ありません。
* 「ポケモン」「Pokémon」「Pokémon UNITE」および各ポケモンの名称は、それぞれの権利者に帰属します。
* 公式のロゴ・キャラクター画像・ゲーム内素材・アイコンなどは**一切使用していません**。表示はポケモン名のテキストと、CSSで作った図形・汎用的な装飾のみで構成しています。
* 15軸の値は「プレイヤーに要求されるプレイ感」を表す診断用のヒューリスティックで、強さ・勝率・Tierの評価ではありません。
