#!/usr/bin/env python3
"""Excel Simulator に複数の回答パターンを入れて再計算し、結果をテストの期待値として保存する。

    python3 tools/export_excel_cases.py      # tests/fixtures/excel_cases.json を更新

Excel の Simulator は D列の回答1組ぶんしか計算を保持しないため、formulas（pip install formulas）で
D5:D34 を差し替えながら再計算し、7気質・最終15軸・Match_140 の上位10件（RawMatch / Percentile /
DisplayScore / RankScore / RankBias）を取り出す。tests/run-tests.mjs がサイトの計算と突き合わせる。
formulas の再計算が Excel のキャッシュ値と一致することは tools/excel_patch.py --verify で確認できる。
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
import warnings

warnings.simplefilter("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from excel_patch import REPO_ROOT, column_number, default_workbook  # noqa: E402
from export_excel import GAME_AXES, PERSONALITY_AXES  # noqa: E402

FIXTURE = os.path.join(REPO_ROOT, "tests", "fixtures", "excel_cases.json")
QUESTION_ROWS = range(5, 35)  # Simulator D5:D34
PERSONALITY_COLUMNS = "GHIJKLM"  # Simulator G5:M5（PERSONALITY_AXES の順。tools/export_excel.py の read_baseline と同じ）
GAME_ROWS = range(11, 26)  # Simulator L11:L25（GAME_AXES の順の最終15軸）


def column_letters(n: int) -> str:
    letters = ""
    while n:
        n, r = divmod(n - 1, 26)
        letters = chr(65 + r) + letters
    return letters


def answer_patterns() -> list:
    """回答スタイルの違う代表パターン（固定シードで再現可能）。"""
    rng = random.Random(20261003)
    cases = [
        ("全3（情報なし）", [3] * 30),
        ("全1", [1] * 30),
        ("全5", [5] * 30),
        ("1と5の交互", [1, 5] * 15),
        ("2と4の交互（1・5を使わない）", [2, 4] * 15),
        ("ほぼ全部3（3が27問）", [3] * 27 + [4, 2, 4]),
    ]
    for index in range(3):
        cases.append((f"2/3/4中心のランダム{index + 1}", [rng.choice([2, 3, 3, 4]) for _ in QUESTION_ROWS]))
    for index in range(3):
        cases.append((f"1〜5のランダム{index + 1}", [rng.randint(1, 5) for _ in QUESTION_ROWS]))
    return cases


def main() -> int:
    import formulas
    import openpyxl

    path = default_workbook()
    # ProfileID は数式でない値のセルなので、再計算結果ではなくシートから読む
    match_sheet = openpyxl.load_workbook(path, data_only=True)["Match_140"]
    profile_ids = {row: match_sheet[f"B{row}"].value for row in range(6, 136)}
    model = formulas.ExcelModel().loads(path).finish()
    workbook_name = os.path.basename(path)
    sim_input = lambda ref: f"'[{workbook_name}]SIMULATOR'!{ref}"  # noqa: E731

    def cell_map(solution) -> dict:
        """再計算結果を {(シート名, セル): 値} にする（範囲でまとまったキーもセルごとに展開する）。"""
        cells = {}
        for key, item in solution.items():
            m = re.match(r"'\[.+\](.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$", key)
            if not m:
                continue
            sheet, col1, row1, col2, row2 = m.group(1), m.group(2), int(m.group(3)), m.group(4), m.group(5)
            values = item.value if hasattr(item, "value") else [[item]]
            if not col2:
                v = values[0][0]
                cells[(sheet, f"{col1}{row1}")] = v.item() if hasattr(v, "item") else v
                continue
            start_col = column_number(col1)
            for r_offset, row_values in enumerate(values):
                for c_offset, v in enumerate(row_values):
                    ref = f"{column_letters(start_col + c_offset)}{row1 + r_offset}"
                    cells.setdefault((sheet, ref), v.item() if hasattr(v, "item") else v)
        return cells

    cases = []
    for label, answers in answer_patterns():
        inputs = {sim_input(f"D{row}"): answer for row, answer in zip(QUESTION_ROWS, answers)}
        cells = cell_map(model.calculate(inputs=inputs))
        sim = lambda ref: cells[("SIMULATOR", ref)]  # noqa: E731
        match = lambda ref: cells[("MATCH_140", ref)]  # noqa: E731
        ranked = []
        for row in range(6, 136):
            ranked.append(
                {
                    "profileId": profile_ids[row],
                    "rank": match(f"AI{row}"),
                    "rawMatch": match(f"AD{row}"),
                    "percentile": match(f"AE{row}"),
                    "displayScore": match(f"AF{row}"),
                    "rankBias": match(f"AG{row}"),
                    "rankScore": match(f"AH{row}"),
                }
            )
        ranked.sort(key=lambda item: item["rank"])
        cases.append(
            {
                "label": label,
                "answers": answers,
                "responseScale": sim("P7"),
                "personality": {axis: sim(f"{col}5") for axis, col in zip(PERSONALITY_AXES, PERSONALITY_COLUMNS)},
                "final": {axis: sim(f"L{row}") for axis, row in zip(GAME_AXES, GAME_ROWS)},
                "top": ranked[:10],
            }
        )
        print(f"  {label}: 1位 {ranked[0]['profileId']}（Display {ranked[0]['displayScore']}）補正倍率 {cases[-1]['responseScale']:.3f}")

    payload = {
        "meta": {
            "note": "tools/export_excel_cases.py が Excel Simulator を formulas で再計算して生成します。直接編集しないでください。",
            "sourceWorkbook": os.path.basename(path),
        },
        "cases": cases,
    }
    with open(FIXTURE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"書き出し: {os.path.relpath(FIXTURE, REPO_ROOT)}（{len(cases)}パターン）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
