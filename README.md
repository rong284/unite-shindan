# あなたにおすすめのユナイトポケモン診断

Pokémon UNITE を題材にした、**非公式・お遊びの診断サイト**です。
サーバー・DB・ログインを使わない静的サイト（HTML / CSS / Vanilla JavaScript）で、GitHub Pages に置くだけで動きます。

主な機能は2つです。

1. **性格診断** … 30問の回答から性格7軸・プレイスタイル15軸を算出し、130プロファイル（100体＋型分け）と照合しておすすめを出す
2. **ランダム抽選** … 現行100体からランダムに1体選ぶ（全体／ロール別）

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
│  ├─ share.js             回答のURLエンコードとXシェア
│  ├─ ui.js                画面まわりの共通処理
│  ├─ diagnosis.js / result.js / random.js   各ページの処理
├─ data/                   パラメータ（後述）
├─ tools/export_excel.py   Excel → JSON 変換
├─ tools/calibrate-types.mjs  性格タイプの出現率の自動調整
├─ tools/serve.py          ローカル確認用サーバー（キャッシュ無効）
├─ tools/stamp_assets.py   JS・CSSの参照に版番号を付ける（キャッシュ対策）
├─ .github/workflows/pages.yml  GitHub Pages への自動公開
├─ tests/run-tests.mjs     テスト（Nodeのみ、外部ライブラリ不要）
├─ tests/fixtures/excel_baseline.json  Excelの計算結果（テストの期待値・自動生成）
├─ package.json            テスト実行用（サイト本体はビルド不要）
└─ Pokemon_UNITE_diagnosis_parameter_db_*.xlsx   パラメータDB（データの正）
```

ビルド工程はありません。HTML / CSS / JS をそのまま配信します。

---

## ローカルでの起動方法

ES Modules と `fetch` を使うため、`file://` で直接開くと動きません。簡易サーバーを立ててください。

```bash
python3 tools/serve.py
#   → http://localhost:8000/ を開く
```

`python3 -m http.server 8000` でも動きますが、ブラウザが古いHTML・JSをキャッシュして更新が反映されないことがあります。
`tools/serve.py` はキャッシュを無効にして配信します。

`npm run serve` でも同じコマンドが動きます（Node は不要。テスト実行にだけ使います）。

---

## GitHub Pages への公開方法

GitHub Actions（`.github/workflows/pages.yml`）で公開します。`main` に push するたびに、テストと版番号のチェックを通したうえで、**サイトに必要なファイル（HTML・`css/`・`js/`・`data/`）だけ**を公開します。Excel・テスト・ツールは公開されません。

1. リポジトリの **Settings → Pages → Build and deployment** で、Source を「**GitHub Actions**」にする（初回のみ）
2. `main` に push する（Actions タブで進み具合を確認できます）
3. `https://<ユーザー名>.github.io/<リポジトリ名>/` にアクセスする（このリポジトリなら `https://rong284.github.io/unite-shindan/`）

テストが落ちた場合は公開されません。JS・CSS を編集したら `python3 tools/stamp_assets.py` を実行してからコミットしてください。

* すべてのパスは相対パス（`./css/...`、`./js/...`、JS内は `import.meta.url` 基準）なので、サブディレクトリ公開でも壊れません。
* Jekyll の処理を避けるため `.nojekyll` を置いています。
* `data/*.json` はブラウザから直接 `fetch` するので公開されます。公開したくないデータは `data/` に置かないでください。

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
Excelを修正 → python3 tools/export_excel.py → node tools/calibrate-types.mjs → node tests/run-tests.mjs → git push
```

変換時に以下をチェックし、問題があれば書き出さずに終了します。

* ProfileID の重複、Roster と Profiles のポケモン不一致
* 15軸の値が 0〜100 の範囲外
* Roster の `ProfileCount` と Profiles_140 の実件数の不一致
* Model_Formula の GlobalSetting に無い設定（既定値で補って警告）、ResultComment の空欄（警告）
* 翻訳係数・マッチング設定に抜けている軸がないか
* `P_*`（性格座標）の再計算値が Excel のキャッシュ値と食い違っていないか（警告）

> Excel を **Excel/Googleスプレッドシート以外**（スクリプト等）で編集した場合、数式のキャッシュ値が古いままになることがあります。
> その状態で書き出すと `tests/fixtures/excel_baseline.json`（テストの期待値）が古い値になるため、一度 Excel で開いて保存し直してください。

---

## 各JSONの役割

| ファイル | 生成元 | 内容 |
| --- | --- | --- |
| `data/model.json` | Excel `Model_Formula` / `Axes` / `Personality_Axes` / `Interaction_Model` | 回答尺度、各段階のスケール、7軸→15軸の翻訳係数、性格の組み合わせ効果、軸ごとの Weight / OverReqPenalty / PreferenceBlend、Shape/Specificity補正・表示スコア・順位の設定、軸の表示名と両端ラベル |
| `data/questions.json` | Excel `Questions_30` | 30問の質問文と、各質問の性格7軸・ゲーム15軸 Loading（0の係数は省略） |
| `data/profiles.json` | Excel `Profiles_140` | 全プロファイルの15軸、技構成名、ロール、アーキタイプ、性格座標、結果コメント（ResultComment）、特徴キーワード、順位補正（RankBias）、RawMatch分布の分位点（Excel `Percentile_Calibration`） |
| `data/roster.json` | Excel `Roster_100` | 現行100体の一覧とロール別件数（ランダム抽選で使用） |
| `data/archetypes.json` | Excel `Archetypes` | アーキタイプ別の15軸リファレンス（調整時の参考値） |
| `data/comments.json` | **手編集** | 結果コメントの文章パーツ（15軸の言い回し・テンプレート・相性の一言） |
| `data/personality-types.json` | **手編集** | 性格タイプ（29種）の名前・キャッチコピー・説明文・判定用の重み（bias と axisStats は自動計算） |
| `data/display.json` | **手編集** | 1画面あたりの質問数、TOP件数、シェア文テンプレート、抽選時の一言 |

`tools/export_excel.py` が上書きするのは上の表の「生成元: Excel」の4＋1ファイルだけです。手編集のファイルは触りません。

---

## 診断計算の流れ

```text
30問の回答（1〜5）
  ↓ 正規化   1=-1.0 / 2=-0.5 / 3=0 / 4=+0.5 / 5=+1.0
性格7軸      50 + PersonalityScale × Σ(正規化 × QuestionLoading) / Σ|Loading|   → 0〜100 にClamp
  ↓ 正規化   (score - 50) / 50
15ゲーム軸   50 + TranslationScale × Σ(正規化性格 × 翻訳係数) / Σ|翻訳係数|
             ＋ 組み合わせ効果（例: 自分から動く×勝負に出る → Engage/Dive）            → 0〜100 にClamp
  ↓
直接嗜好     50 + PreferenceScale × Σ(正規化 × ゲーム軸Loading) / Σ|Loading|  ※Q21〜Q30
  ↓
最終15軸     翻訳値 × (1 - PreferenceBlend) + 嗜好値 × PreferenceBlend
  ↓
マッチング   軸別誤差 = Weight × (ポケモン要求値 - プレイヤー値)^2 × penalty
             penalty = 要求値がプレイヤーを上回るとき 1 + OverReqPenalty、それ以外は 1
             AbsoluteScore = max(0, 100 - √(Σ軸別誤差 / ΣWeight))
             ShapeScore    = 50 + 50 × 重み付き相関(プレイヤー15軸, ポケモン15軸)
             PlayerSignal  = min(1, プレイヤー15軸の重み付き標準偏差 / SignalReference)
             Hybrid        = Absolute × (1 - BaseShapeWeight×Signal) + Shape × (BaseShapeWeight×Signal)
             Specificity補正 = clamp(SpecificityCorrection × (ポケモンの尖り具合 - 全体平均), ±SpecificityCap)
             RawMatch      = clamp(Hybrid + Specificity補正, 0, 100)
             Percentile    = そのプロファイルの RawMatch 分布（疑似回答20,000件）の中での位置 0〜1
             DisplayScore  = round(max(DisplayMin, DisplayBase + DisplayRange × Percentile^DisplayPower))  ← 画面の「相性 / 100」
             RankScore     = 0.8 × Percentile×100 + 0.2 × RawMatch + RankBias                          ← 順位決定用
  ↓
順位付け     全プロファイルを RankScore 順に並べる → ポケモン単位に畳み込み（最上位の型を代表型に）
             → TOP5は必ず異なるポケモン
```

対応する関数は `js/model.js` の
`calculatePersonality()` → `translateToGameplay()` → `calculatePreferences()` → `calculateFinalAxes()` → `calculateMatch()` / `rankProfiles()`、
文章生成は `js/comment.js` の `determinePersonalityType()` / `generateResultComment()` です。
`runDiagnosis()` がこれらをまとめて呼ぶので、UI側は結果オブジェクトを表示するだけです。

---

## パラメータを変更する場所

| 変えたいもの | 場所 |
| --- | --- |
| 質問文・質問の並び | Excel `Questions_30` の「質問文」列 |
| Question Loading（各質問が効く軸と強さ） | Excel `Questions_30` の F〜AA 列 |
| ポケモンの15軸・技構成名・型分け | Excel `Profiles_140` |
| ポケモン（型）ごとの結果コメント | Excel `Profiles_140` の `ResultComment` 列 |
| 出やすさの補正（順位のみ） | Excel `Profiles_140` の `RankBias` 列 |
| 各段階のスケール・Shape/Specificity補正 | Excel `Model_Formula` の GlobalSetting（E4:F11） |
| 表示スコアの広げ方・順位の配分 | Excel `Model_Formula` の DisplaySetting（H4:I9） |
| 性格の組み合わせ効果 | Excel `Interaction_Model`（Mode: high_high / low_second / low_first / low_low） |
| 軸の表示名・両端ラベル | Excel `Axes`（15軸）/ `Personality_Axes`（7気質） |
| Percentile の分布 | Excel `Percentile_Calibration`（Excel側で再計算して保存） |
| 7軸→15軸の翻訳係数 | Excel `Model_Formula` B13:H27 |
| Match Weight | Excel `Model_Formula` M列 |
| OverReqPenalty | Excel `Model_Formula` N列 |
| PreferenceBlend（軸別） | Excel `Model_Formula` O列 |
| 回答の選択肢ラベル・正規化係数 | Excel `Model_Formula` A5:C9 |
| 結果コメントの言い回し | `data/comments.json` |
| 性格タイプ名・判定条件 | `data/personality-types.json` |
| 1画面の質問数・TOP件数・シェア文・抽選の一言 | `data/display.json` |

質問数を増減しても計算式は係数の合計から自動で決まるため、コード修正は不要です。

### 性格タイプの追加・調整方法

`data/personality-types.json` の `types` に1件足して、調整ツールを実行します。

```json
{
  "id": "my-type",
  "name": "新しいタイプ名",
  "tagline": "キャッチコピー",
  "lead": "説明の1行目（太字で表示）",
  "body": "説明の本文",
  "color": "#ff6b4a",
  "weights": { "Engage": 1.0, "Peel": -0.2 }
}
```

```bash
node tools/calibrate-types.mjs          # bias と axisStats を計算して書き込む
node tools/calibrate-types.mjs --check  # 書き込まずに出現率だけ見る
```

* `weights` は「どの軸が高い（マイナスなら低い）人か」。軸キーは15ゲーム軸、または性格7軸に `P_` を付けたキー（`P_Mastery` など）。
* 判定では各軸を `axisStats`（疑似回答での平均・標準偏差）で「全体の中での高さ」に直し、`weights` との内積を重みの大きさで割った値 ＋ `bias` が最大のタイプを選びます。
* `weights` が空のタイプ（バランス感覚の万能型）は `bias` だけで比べるので、どの軸も目立たない回答のときに選ばれます。
* `bias` は調整ツールが「全タイプがほぼ同じくらい出る」ように自動で決めます。**weights・質問・Excelを変えたら実行し直してください。**
* 出現率はテスト（疑似回答2,000件で全タイプが出て、最大でも8%未満）でも確認しています。

---

## デバッグモード

URLに `?debug=1` を付けたときだけ有効になります（通常のユーザーには表示されません）。

* `diagnosis.html?debug=1` … 全問1 / 全問3 / 全問5 / ランダム回答の一括入力、現在の回答配列の表示、結果ページへのショートカット
* `result.html?debug=1` … 性格7軸（スコアと正規化値）、翻訳前15軸・Preference値・Blend・最終15軸、1位の軸別誤差（要求値・プレイヤー値・Weight・Penalty・誤差）、全プロファイルの RankScore / DisplayScore / Percentile / RawMatch と内訳（Absolute / Shape / Specificity補正 / RankBias）、PlayerSignal、タイプ判定のスコアと次点

ページ間を移動しても `debug=1` は引き継がれます。

---

## テスト

```bash
node tests/run-tests.mjs      # または npm test
```

確認している内容は次のとおりです。

* 全回答3のとき性格7軸が50になる／極端な回答でも0〜100に収まる
* 最終15軸・RawMatch・DisplayScore が0〜100、Percentile が0〜1に収まる
* 全プロファイルが計算対象になる（ProfileIDの重複なし）
* 同点でも順位処理が壊れない（同順位の付与と、並びの再現性）
* 同一ポケモンの別型がTOP3を独占しない／代表型はそのポケモンの最高スコアの型になる
* JSONのポケモン数・プロファイル数・質問数がExcelと一致する
* **Excel `Simulator` と同じ回答を入れたとき、性格7軸・翻訳15軸・嗜好15軸・最終15軸・上位10件の順位と RawMatch / Percentile / DisplayScore / RankScore が一致する**（許容誤差 0.01）
* 順位は RankScore 順／全プロファイルに101個の分位点がある／1位の表示相性が広がる（p10≈73・中央値≈91・p90≈95）／組み合わせ効果が効く
* 中立の回答ではShapeが効かない／形が同じなら Shape=100・逆なら 0／Specificity補正が上限内に収まる
* 疑似回答7,000件で全ポケモンが一度はTOP3に出て、1位が特定のポケモンに偏らない（Excel `Calibration_Audit` と同じ回答分布）
* 性格タイプが必ず決まり、コメントにテンプレートの置換漏れが無い
* シェアURLの回答エンコードが往復する（14文字程度）
* 各ページのスクリプトが参照する要素IDがHTMLに存在する／ルート絶対パスを使っていない

---

## 画面の操作・表示

* 回答後の自動送りは、診断画面のチェックでオン・オフを切り替えられます。戻る・次へ・やり直しを選ぶと保留中の自動送りは止まります。
* 数字キー1〜5で回答できます。選択肢にフォーカス中は矢印キーで選択、Enterで次へ進みます。
* 抽選中はロール変更と再抽選を一時的に無効にし、抽選結果と共有URLのロールを揃えます。
* 結果は相棒・理由・候補・シェアを先に表示し、性格の詳細はスマホでは後ろ、幅1000px以上では右側に表示します。
* 上位の相性差が1未満の場合は僅差の案内、confidenceが「低」の場合は評価調整中の案内を表示します。
* ストライク型は、見出し・推薦理由・共有文に「ストライク」、補足にハッサムのライセンスを表示します。
* 中立回答の扱い、性格タイプの判定、相性の計算値とExcelのパラメータは従来どおりです。

## 共有

* **保存はしません**: 回答や結果をブラウザ（`localStorage` 等）に残しません。診断途中でページを閉じると最初からになります。
* **シェアURL**: 30問の回答を5進数→36進数に詰めて `result.html?a=xxxxxxxxxxxxxx` の14文字程度にしています。URLを開くと同じ結果を再計算して表示します（スコアそのものではなく回答を保存しているため、パラメータを更新すると結果も最新の計算に追従します）。
* ランダム結果は `random.html?p=<ロスター番号>&m=<モード>` で再表示できます。

---

## 権利について

* このサイトは Pokémon UNITE の**非公式ファンサイト**です。株式会社ポケモン、任天堂、Creatures、Game Freak、TiMi Studio Group 等とは一切関係ありません。
* 「ポケモン」「Pokémon」「Pokémon UNITE」および各ポケモンの名称は、それぞれの権利者に帰属します。
* 公式のロゴ・キャラクター画像・ゲーム内素材・アイコンなどは**一切使用していません**。表示はポケモン名のテキストと、CSSで作った図形・汎用的な装飾のみで構成しています。
* 15軸の値は「プレイヤーに要求されるプレイ感」を表す診断用のヒューリスティックで、強さ・勝率・Tierの評価ではありません。
