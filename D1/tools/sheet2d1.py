#!/usr/bin/env python3
"""試算表 → D1 搬家工具.

把 Google 試算表匯出的 CSV 轉成 D1 可匯入的 SQL。

1. 試算表 → Reports 工作表 → 檔案 → 下載 → CSV，存成 reports.csv
   （欄位順序：RowId, IdNumber, Name, ClassInfo, UpdatedAt, DataJson）
2. 試算表 → Settings 工作表 → 下載 CSV，存成 settings.csv（可選，但建議一起搬，
   內含 PWD_HASH／PWD_SALT／校名標題；雜湊算法兩邊相同，舊密碼無縫沿用）
3. python3 tools/sheet2d1.py --reports reports.csv --settings settings.csv --out import.sql
4. wrangler d1 execute fushan-disease-report --remote --file=import.sql
5. 用老師密碼登入 D1 新站確認筆數，再到系統管理換密碼（可沿用舊密碼先登入）

注意：匯入採 INSERT OR REPLACE，以 RowId／Key 為準，可重複執行不怕洗掉新資料
（同 RowId 會覆寫——若 D1 端已有家長新通報，先確認再搬，或先搬家再切換前端）。
"""
import argparse
import csv
import sys


def esc(v):
    if v is None:
        return "''"
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reports', required=True, help='Reports 工作表 CSV')
    ap.add_argument('--settings', default=None, help='Settings 工作表 CSV（可選）')
    ap.add_argument('--out', required=True, help='輸出的 SQL 檔')
    args = ap.parse_args()

    stmts = ['BEGIN TRANSACTION;']
    n_rep, n_set = 0, 0

    with open(args.reports, newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            if not (row.get('RowId') or '').strip():
                continue
            stmts.append(
                'INSERT INTO Reports (RowId, IdNumber, Name, ClassInfo, UpdatedAt, DataJson) VALUES (%s) '
                'ON CONFLICT(RowId) DO NOTHING;' % ', '.join([
                    esc(row.get('RowId', '')), esc(row.get('IdNumber', '')),
                    esc(row.get('Name', '')), esc(row.get('ClassInfo', '')),
                    esc(row.get('UpdatedAt', '')), esc(row.get('DataJson', '{}')),
                ]))
            n_rep += 1

    if args.settings:
        with open(args.settings, newline='', encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                key = (row.get('Key') or '').strip()
                if not key:
                    continue
                stmts.append(
                    'INSERT INTO Settings (Key, Value, UpdatedAt) VALUES (%s) '
                    'ON CONFLICT(Key) DO NOTHING;' % ', '.join([
                        esc(key), esc(row.get('Value', '')), esc(row.get('UpdatedAt', '')),
                    ]))
                n_set += 1

    stmts.append('COMMIT;')
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(stmts) + '\n')
    print(f'Reports {n_rep} 筆，Settings {n_set} 筆 → {args.out}')


if __name__ == '__main__':
    sys.exit(main())
