#!/usr/bin/env python3
"""Excel（パラメータDB）→ data/*.json 変換スクリプト.

使い方:
    python3 tools/export_excel.py                     # リポジトリ直下の最新 .xlsx を自動検出
    python3 tools/export_excel.py path/to/book.xlsx   # ファイルを明示
    python3 tools/export_excel.py --check             # 書き込まず検証のみ

出力:
    data/model.json             回答尺度・7→15翻訳係数・マッチング設定・軸定義
    data/questions.json         30問の質問文と Loading
    data/profiles.json          140プロファイルの15軸＋性格座標
    data/roster.json            現行100体のロスター
    data/archetypes.json        アーキタイプ別の15軸リファレンス
    tests/fixtures/excel_baseline.json  Excel Simulator の計算結果（Web実装の突き合わせ用）

このスクリプトは data/comments.json, data/personality-types.json, data/display.json を
上書きしません（Excelに存在しない、手で調整する表現系データのため）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import math
import os
import sys
import warnings
from collections import Counter, OrderedDict

try:
    import openpyxl
except ImportError:  # pragma: no cover - 実行環境向けの案内
    sys.exit("openpyxl が必要です:  pip install openpyxl")

warnings.filterwarnings("ignore", module="openpyxl")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "data")
FIXTURE_DIR = os.path.join(REPO_ROOT, "tests", "fixtures")

# ---------------------------------------------------------------------------
# 軸の定義（Excelの列順とコードの軸順を一致させるための唯一の情報源）
# ---------------------------------------------------------------------------

PERSONALITY_AXES = [
    "Initiative",
    "RiskTolerance",
    "Cooperation",
    "SelfReliance",
    "Planning",
    "Adaptability",
    "Mastery",
]

GAME_AXES = [
    "Engage",
    "Dive",
    "Peel",
    "Frontline",
    "Poke",
    "Burst",
    "SustainDPS",
    "Control",
    "Support",
    "Mobility",
    "FarmScaling",
    "ObjectiveSecure",
    "ScoringSide",
    "Execution",
    "Decision",
]

# Profiles_140 の P_* 列（Excel上は数式）を再現するための係数。
# 例: P_Initiative = ROUND(0.38*Engage + 0.30*Dive + 0.17*Burst + 0.15*Decision, 0)
# ("inverted": True の項は (100 - 軸値) を使う)
PROFILE_PERSONALITY_FORMULA = {
    "Initiative": [("Engage", 0.38), ("Dive", 0.30), ("Burst", 0.17), ("Decision", 0.15)],
    "RiskTolerance": [("Dive", 0.38), ("Burst", 0.25), ("Mobility", 0.20), ("Peel", 0.17, True)],
    "Cooperation": [("Peel", 0.32), ("Support", 0.26), ("Control", 0.24), ("Engage", 0.18)],
    "SelfReliance": [
        ("SustainDPS", 0.27),
        ("Mobility", 0.24),
        ("Frontline", 0.22),
        ("Burst", 0.15),
        ("ObjectiveSecure", 0.12),
    ],
    "Planning": [("Poke", 0.28), ("Control", 0.28), ("Decision", 0.28), ("Dive", 0.16, True)],
    "Adaptability": [
        ("Decision", 0.35),
        ("Mobility", 0.22),
        ("Control", 0.18),
        ("Support", 0.13),
        ("Execution", 0.12),
    ],
    "Mastery": [("Execution", 0.72), ("Decision", 0.28)],
}

OFFICIAL_ROLES = ["アタック型", "バランス型", "スピード型", "ディフェンス型", "サポート型"]


# ---------------------------------------------------------------------------
# 汎用ヘルパー
# ---------------------------------------------------------------------------


def excel_round(value: float, digits: int = 0) -> float:
    """ExcelのROUND（四捨五入、0.5は絶対値が大きい方へ）を再現する。"""
    factor = 10 ** digits
    scaled = value * factor
    rounded = math.floor(abs(scaled) + 0.5) * (1 if scaled >= 0 else -1)
    return rounded / factor if digits else int(rounded)


def clean(value):
    """空白のみのセルを None に寄せる。"""
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def as_number(value, default=0.0) -> float:
    if value is None or value == "":
        return default
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except ValueError:
        return default


def find_header_row(ws, first_label: str, max_row: int = 30) -> int:
    """A列が first_label の行番号を返す（ヘッダー行の位置ズレに耐えるため）。"""
    for row in range(1, min(ws.max_row, max_row) + 1):
        if clean(ws.cell(row=row, column=1).value) == first_label:
            return row
    raise ValueError(f"'{first_label}' で始まるヘッダー行が {ws.title} に見つかりません")


def header_map(ws, header_row: int) -> "OrderedDict[str, int]":
    """ヘッダー名 → 列番号 の対応を返す。"""
    mapping: "OrderedDict[str, int]" = OrderedDict()
    for col in range(1, ws.max_column + 1):
        name = clean(ws.cell(row=header_row, column=col).value)
        if name and name not in mapping:
            mapping[name] = col
    return mapping


def find_cell(ws, label: str, max_row: int = 60, max_col: int = 30):
    """指定ラベルのセル座標 (row, col) を返す。ブロック位置検出用。"""
    for row in range(1, min(ws.max_row, max_row) + 1):
        for col in range(1, min(ws.max_column, max_col) + 1):
            if clean(ws.cell(row=row, column=col).value) == label:
                return row, col
    raise ValueError(f"'{label}' が {ws.title} に見つかりません")


def strip_zeros(loadings: dict) -> dict:
    """0 の Loading は保存しない（JSONを読みやすく保つ。欠損は0として扱う）。"""
    return {key: value for key, value in loadings.items() if value}


# ---------------------------------------------------------------------------
# 各シートの読み取り
# ---------------------------------------------------------------------------


def read_axes(book) -> tuple:
    """Axes シートから15ゲーム軸と7性格軸の日本語名・定義を読む。

    性格座標のブロックは列位置が動く可能性があるため、"P_" で始まるセルを探して特定する。
    """
    ws = book["Axes"]
    game, personality = {}, {}
    p_col = None
    for row in range(1, ws.max_row + 1):
        for col in range(1, ws.max_column + 1):
            value = clean(ws.cell(row=row, column=col).value)
            if isinstance(value, str) and value.startswith("P_") and value[2:] in PERSONALITY_AXES:
                p_col = col
                break
        if p_col:
            break
    if p_col is None:
        raise ValueError("Axes シートに P_* 列が見つかりません")

    for row in range(2, ws.max_row + 1):
        code = clean(ws.cell(row=row, column=1).value)
        if code in GAME_AXES:
            game[code] = {
                "key": code,
                "nameJa": clean(ws.cell(row=row, column=2).value) or code,
                "description": clean(ws.cell(row=row, column=3).value) or "",
            }
        p_code = clean(ws.cell(row=row, column=p_col).value)
        if isinstance(p_code, str) and p_code.startswith("P_"):
            key = p_code[2:]
            personality[key] = {
                "key": key,
                "nameJa": clean(ws.cell(row=row, column=p_col + 1).value) or key,
                "description": clean(ws.cell(row=row, column=p_col + 2).value) or "",
            }
    missing = [axis for axis in GAME_AXES if axis not in game]
    missing += [f"P_{axis}" for axis in PERSONALITY_AXES if axis not in personality]
    if missing:
        raise ValueError(f"Axes シートに定義が無い軸があります: {missing}")
    return game, personality


def read_model(book, game_axis_info, personality_axis_info) -> dict:
    """Model_Formula シートから回答尺度・翻訳係数・マッチング設定を読む。"""
    ws = book["Model_Formula"]

    # 回答尺度（1〜5 → 正規化係数 + 表示ラベル）
    scale_header = find_header_row(ws, "回答値")
    scale = []
    row = scale_header + 1
    while clean(ws.cell(row=row, column=1).value) is not None:
        scale.append(
            {
                "value": int(as_number(ws.cell(row=row, column=1).value)),
                "norm": as_number(ws.cell(row=row, column=2).value),
                "label": clean(ws.cell(row=row, column=3).value) or "",
            }
        )
        row += 1

    # 7性格軸 → 15ゲーム軸 翻訳係数（A列が GameAxis のブロック）
    t_row, t_col = find_cell(ws, "GameAxis")
    t_headers = {
        clean(ws.cell(row=t_row, column=col).value): col
        for col in range(t_col, t_col + len(PERSONALITY_AXES) + 2)
    }
    translation = {}
    row = t_row + 1
    while True:
        axis = clean(ws.cell(row=row, column=t_col).value)
        if not axis:
            break
        translation[axis] = {
            p_axis: as_number(ws.cell(row=row, column=t_headers[p_axis]).value)
            for p_axis in PERSONALITY_AXES
            if p_axis in t_headers
        }
        row += 1

    # 15軸マッチング設定（Weight / OverReqPenalty / PreferenceBlend）
    m_row, m_col = find_cell(ws, "15軸マッチング設定")
    m_header_row = m_row + 1
    m_headers = {
        clean(ws.cell(row=m_header_row, column=col).value): col
        for col in range(m_col, min(ws.max_column, m_col + 6) + 1)
        if clean(ws.cell(row=m_header_row, column=col).value)
    }
    matching = {}
    row = m_header_row + 1
    while True:
        axis = clean(ws.cell(row=row, column=m_headers["GameAxis"]).value)
        if not axis:
            break
        matching[axis] = {
            "weight": as_number(ws.cell(row=row, column=m_headers["Weight"]).value, 1.0),
            "overReqPenalty": as_number(
                ws.cell(row=row, column=m_headers["OverReqPenalty"]).value, 0.0
            ),
            "preferenceBlend": as_number(
                ws.cell(row=row, column=m_headers["PreferenceBlend"]).value, 0.0
            ),
        }
        row += 1

    # 数式の説明（READMEやデバッグ表示で参照する用）
    notes_row = find_header_row(ws, "項目", max_row=40)
    notes = []
    row = notes_row + 1
    while clean(ws.cell(row=row, column=1).value):
        notes.append(
            {
                "item": clean(ws.cell(row=row, column=1).value),
                "formula": clean(ws.cell(row=row, column=2).value) or "",
                "purpose": clean(ws.cell(row=row, column=3).value) or "",
            }
        )
        row += 1

    return {
        "answerScale": scale,
        "neutralAnswer": next((s["value"] for s in scale if s["norm"] == 0), 3),
        "scoreCenter": 50,
        "scoreSpan": 50,
        "scoreMin": 0,
        "scoreMax": 100,
        "personalityAxes": [personality_axis_info[k] for k in PERSONALITY_AXES],
        "gameAxes": [game_axis_info[k] for k in GAME_AXES],
        "translation": {axis: translation[axis] for axis in GAME_AXES if axis in translation},
        "matching": {axis: matching[axis] for axis in GAME_AXES if axis in matching},
        "formulaNotes": notes,
    }


def read_questions(book) -> dict:
    """Questions_30 シートから質問文と Loading を読む。"""
    ws = book["Questions_30"]
    header_row = find_header_row(ws, "QID")
    cols = header_map(ws, header_row)
    questions = []
    row = header_row + 1
    while True:
        qid = clean(ws.cell(row=row, column=cols["QID"]).value)
        if not qid:
            break
        personality = {
            axis: as_number(ws.cell(row=row, column=cols[axis]).value)
            for axis in PERSONALITY_AXES
            if axis in cols
        }
        gameplay = {
            axis: as_number(ws.cell(row=row, column=cols[axis]).value)
            for axis in GAME_AXES
            if axis in cols
        }
        questions.append(
            {
                "id": qid,
                "section": clean(ws.cell(row=row, column=cols["区分"]).value) or "",
                "text": clean(ws.cell(row=row, column=cols["質問文"]).value) or "",
                "target": clean(ws.cell(row=row, column=cols["主な測定対象"]).value) or "",
                "note": clean(ws.cell(row=row, column=cols["備考"]).value) or "",
                "intent": clean(ws.cell(row=row, column=cols["設計意図"]).value) or "",
                "personality": strip_zeros(personality),
                "gameplay": strip_zeros(gameplay),
            }
        )
        row += 1
    return {"questions": questions}


def read_profiles(book) -> tuple:
    """Profiles_140 シートから140プロファイルを読む。P_* 列は数式なので再計算する。"""
    ws = book["Profiles_140"]
    cached = book["__cached__"]["Profiles_140"]
    header_row = find_header_row(ws, "Pokemon")
    cols = header_map(ws, header_row)
    profiles, mismatches = [], []
    row = header_row + 1
    while True:
        pokemon = clean(ws.cell(row=row, column=cols["Pokemon"]).value)
        if not pokemon:
            break
        axes = {
            axis: as_number(ws.cell(row=row, column=cols[axis]).value)
            for axis in GAME_AXES
        }
        personality = {}
        for p_axis, terms in PROFILE_PERSONALITY_FORMULA.items():
            total = 0.0
            for term in terms:
                axis, coeff = term[0], term[1]
                inverted = len(term) > 2 and term[2]
                value = 100 - axes[axis] if inverted else axes[axis]
                total += coeff * value
            personality[p_axis] = excel_round(total)
            # Excelのキャッシュ値と突き合わせて、数式変更に気付けるようにする
            cached_value = cached.cell(row=row, column=cols[f"P_{p_axis}"]).value
            if isinstance(cached_value, (int, float)) and abs(cached_value - personality[p_axis]) > 0.51:
                mismatches.append(
                    f"{pokemon} P_{p_axis}: Excel={cached_value} 再計算={personality[p_axis]}"
                )
        profiles.append(
            {
                "id": clean(ws.cell(row=row, column=cols["ProfileID"]).value),
                "pokemon": pokemon,
                "officialRole": clean(ws.cell(row=row, column=cols["OfficialRole"]).value),
                "profileName": clean(ws.cell(row=row, column=cols["ProfileName"]).value),
                "profileLabel": clean(ws.cell(row=row, column=cols["ProfileLabel"]).value),
                "primaryArchetype": clean(ws.cell(row=row, column=cols["PrimaryArchetype"]).value),
                "secondaryArchetype": clean(
                    ws.cell(row=row, column=cols["SecondaryArchetype"]).value
                ),
                "splitReason": clean(ws.cell(row=row, column=cols["SplitReason"]).value),
                "confidence": clean(ws.cell(row=row, column=cols["Confidence"]).value),
                "axes": axes,
                "personality": personality,
            }
        )
        row += 1
    return {"profiles": profiles}, mismatches


def read_roster(book) -> dict:
    """Roster_100 シートから現行ロスターを読む。"""
    ws = book["Roster_100"]
    header_row = find_header_row(ws, "No")
    cols = header_map(ws, header_row)
    pokemon = []
    row = header_row + 1
    while True:
        name = clean(ws.cell(row=row, column=cols["Pokemon"]).value)
        if not name:
            break
        pokemon.append(
            {
                "no": int(as_number(ws.cell(row=row, column=cols["No"]).value)),
                "name": name,
                "officialRole": clean(ws.cell(row=row, column=cols["OfficialRole"]).value),
                "primaryArchetype": clean(
                    ws.cell(row=row, column=cols["WikiPrimaryArchetype"]).value
                ),
                "secondaryArchetype": clean(
                    ws.cell(row=row, column=cols["WikiSecondaryArchetype"]).value
                ),
                "splitProfile": clean(ws.cell(row=row, column=cols["SplitProfile"]).value) == "Yes",
                "profileCount": int(as_number(ws.cell(row=row, column=cols["ProfileCount"]).value, 1)),
                "confidence": clean(ws.cell(row=row, column=cols["Confidence"]).value),
            }
        )
        row += 1
    counts = Counter(p["officialRole"] for p in pokemon)
    roles = [
        {"key": role, "count": counts.get(role, 0)}
        for role in OFFICIAL_ROLES
        if counts.get(role, 0)
    ]
    # Excelに未知のロールが増えても落とさない
    roles += [
        {"key": role, "count": count}
        for role, count in counts.items()
        if role not in OFFICIAL_ROLES
    ]
    return {"roles": roles, "pokemon": pokemon}


def read_archetypes(book) -> dict:
    """Archetypes シートのアーキタイプ別15軸（参考値）を読む。"""
    ws = book["Archetypes"]
    header_row = find_header_row(ws, "Archetype")
    cols = header_map(ws, header_row)
    archetypes = []
    row = header_row + 1
    while True:
        name = clean(ws.cell(row=row, column=cols["Archetype"]).value)
        if not name:
            break
        archetypes.append(
            {
                "key": name,
                "axes": {
                    axis: as_number(ws.cell(row=row, column=cols[axis]).value)
                    for axis in GAME_AXES
                    if axis in cols
                },
            }
        )
        row += 1
    return {"archetypes": archetypes}


def read_baseline(book) -> dict:
    """Simulator / Match_140 のキャッシュ値を、Web実装の回帰テスト用に取り出す。

    Simulator の D列に入っている回答値と、その結果（7性格軸・15軸・上位10件）を
    そのまま保存する。Excelで回答を変えて再保存すれば、テストの期待値も更新される。
    """
    sim_formula = book["Simulator"]
    sim = book["__cached__"]["Simulator"]

    header_row = find_header_row(sim_formula, "QID")
    answers = []
    row = header_row + 1
    while clean(sim_formula.cell(row=row, column=1).value):
        answers.append(int(as_number(sim_formula.cell(row=row, column=4).value, 3)))
        row += 1

    personality = {
        axis: sim.cell(row=header_row + 1, column=7 + index).value
        for index, axis in enumerate(PERSONALITY_AXES)
    }

    # 「最終15ゲーム軸」ブロック（G列にGameAxisヘッダー）
    block_row, block_col = find_cell(sim_formula, "GameAxis", max_row=40)
    translated, preference, final = {}, {}, {}
    row = block_row + 1
    while True:
        axis = clean(sim_formula.cell(row=row, column=block_col).value)
        if not axis or axis not in GAME_AXES:
            break
        translated[axis] = sim.cell(row=row, column=block_col + 2).value
        preference[axis] = sim.cell(row=row, column=block_col + 3).value
        final[axis] = sim.cell(row=row, column=block_col + 5).value
        row += 1

    match = book["__cached__"]["Match_140"]
    match_header = find_header_row(match, "Pokemon", max_row=20)
    ranked = []
    row = match_header + 1
    while clean(match.cell(row=row, column=1).value):
        ranked.append(
            {
                "profileId": clean(match.cell(row=row, column=2).value),
                "pokemon": clean(match.cell(row=row, column=1).value),
                "profileName": clean(match.cell(row=row, column=3).value),
                "matchScore": match.cell(row=row, column=23).value,
                "rank": match.cell(row=row, column=24).value,
            }
        )
        row += 1
    ranked.sort(key=lambda item: (-(item["matchScore"] or 0), item["profileId"]))

    return {
        "source": "Excel Simulator / Match_140 のキャッシュ値",
        "answers": answers,
        "personality": personality,
        "translated": translated,
        "preference": preference,
        "final": final,
        "profileCount": len(ranked),
        "top": ranked[:10],
    }


# ---------------------------------------------------------------------------
# 出力
# ---------------------------------------------------------------------------


def write_json(path: str, payload: dict, check_only: bool) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if check_only:
        print(f"  [check] {os.path.relpath(path, REPO_ROOT)} ({len(text):,} bytes)")
        return
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"  書き出し: {os.path.relpath(path, REPO_ROOT)} ({len(text):,} bytes)")


def default_workbook() -> str:
    candidates = sorted(
        glob.glob(os.path.join(REPO_ROOT, "*.xlsx")),
        key=os.path.getmtime,
        reverse=True,
    )
    candidates = [path for path in candidates if not os.path.basename(path).startswith("~$")]
    if not candidates:
        sys.exit("リポジトリ直下に .xlsx が見つかりません。パスを引数で指定してください。")
    return candidates[0]


class WorkbookPair(dict):
    """数式シートとキャッシュ値シートの両方へ同じ書き方でアクセスするためのラッパー。

    book["Profiles_140"]              → 数式を保持したシート
    book["__cached__"]["Profiles_140"] → 計算結果（キャッシュ値）のシート
    """

    def __init__(self, formulas, cached):
        super().__init__()
        self._formulas = formulas
        self._cached = cached

    def __getitem__(self, key):
        if key == "__cached__":
            return self._cached
        return self._formulas[key]


def main() -> int:
    parser = argparse.ArgumentParser(description="Excel パラメータDB → data/*.json 変換")
    parser.add_argument("workbook", nargs="?", help="Excelファイルのパス")
    parser.add_argument("--check", action="store_true", help="書き込まずに検証のみ行う")
    args = parser.parse_args()

    workbook_path = args.workbook or default_workbook()
    print(f"読み込み: {os.path.relpath(workbook_path, REPO_ROOT)}")

    book = WorkbookPair(
        openpyxl.load_workbook(workbook_path, data_only=False),
        openpyxl.load_workbook(workbook_path, data_only=True),
    )
    return export(book, workbook_path, args.check)


def export(book, workbook_path: str, check_only: bool) -> int:
    meta = {
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceWorkbook": os.path.basename(workbook_path),
        "note": "このファイルは tools/export_excel.py が生成します。直接編集せずExcel側を修正してください。",
    }

    game_axis_info, personality_axis_info = read_axes(book)
    model = read_model(book, game_axis_info, personality_axis_info)
    questions = read_questions(book)
    profiles, mismatches = read_profiles(book)
    roster = read_roster(book)
    archetypes = read_archetypes(book)
    baseline = read_baseline(book)

    # --- 検証 ---
    problems = []
    profile_list = profiles["profiles"]
    roster_list = roster["pokemon"]

    if len(set(p["id"] for p in profile_list)) != len(profile_list):
        problems.append("ProfileID が重複しています")
    roster_names = {p["name"] for p in roster_list}
    profile_names = {p["pokemon"] for p in profile_list}
    if profile_names - roster_names:
        problems.append(f"Roster に無いポケモン: {sorted(profile_names - roster_names)}")
    if roster_names - profile_names:
        problems.append(f"Profile が無いポケモン: {sorted(roster_names - profile_names)}")
    for axis in GAME_AXES:
        if axis not in model["translation"]:
            problems.append(f"翻訳係数に {axis} がありません")
        if axis not in model["matching"]:
            problems.append(f"マッチング設定に {axis} がありません")
    for profile in profile_list:
        for axis, value in profile["axes"].items():
            if not 0 <= value <= 100:
                problems.append(f"{profile['id']} の {axis} が0〜100の外: {value}")
    counted = Counter(p["pokemon"] for p in profile_list)
    for entry in roster_list:
        if counted[entry["name"]] != entry["profileCount"]:
            problems.append(
                f"{entry['name']}: ProfileCount={entry['profileCount']} だが"
                f" Profiles_140 上は {counted[entry['name']]} 件"
            )

    print(
        f"件数: ロスター {len(roster_list)}体 / プロファイル {len(profile_list)}件 /"
        f" 質問 {len(questions['questions'])}問 /"
        f" 軸 {len(model['personalityAxes'])}+{len(model['gameAxes'])}"
    )
    for role in roster["roles"]:
        print(f"  {role['key']}: {role['count']}体")

    for message in mismatches[:10]:
        print(f"  [注意] 性格座標がExcelのキャッシュ値と一致しません: {message}")
    if len(mismatches) > 10:
        print(f"  [注意] ほか {len(mismatches) - 10} 件")

    if problems:
        print("\n検証エラー:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    counts = {
        "roster": len(roster_list),
        "profiles": len(profile_list),
        "questions": len(questions["questions"]),
        "personalityAxes": len(model["personalityAxes"]),
        "gameAxes": len(model["gameAxes"]),
    }

    write_json(os.path.join(DATA_DIR, "model.json"), {"meta": meta, **model}, check_only)
    write_json(
        os.path.join(DATA_DIR, "questions.json"),
        {"meta": {**meta, "count": counts["questions"]}, **questions},
        check_only,
    )
    write_json(
        os.path.join(DATA_DIR, "profiles.json"),
        {"meta": {**meta, "count": counts["profiles"]}, **profiles},
        check_only,
    )
    write_json(
        os.path.join(DATA_DIR, "roster.json"),
        {"meta": {**meta, "count": counts["roster"]}, **roster},
        check_only,
    )
    write_json(os.path.join(DATA_DIR, "archetypes.json"), {"meta": meta, **archetypes}, check_only)
    write_json(
        os.path.join(FIXTURE_DIR, "excel_baseline.json"),
        {"meta": meta, "counts": counts, **baseline},
        check_only,
    )
    print("完了" if not check_only else "検証のみ完了（ファイルは書き換えていません）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
