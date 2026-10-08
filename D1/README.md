# 福山國中傳染病通報單 — Cloudflare D1 版

Google 版（試算表＋Apps Script）的完整移植，全套跑在 Cloudflare 上。
原本檔案（根目錄＋`site/`）完全沒動；D1 版所有檔案都在本資料夾。

```
D1/
  worker.js      後端 API（11 個動作，與 Google 版協定一致）
  wrangler.toml  Worker 設定＋D1 綁定
  schema.sql     資料表結構（Reports / Settings / Sessions / Meta）
  web/           前端（index.html＋_headers，API 指到 Worker）
  tools/
    sheet2d1.py  試算表 CSV → D1 匯入 SQL
```

線上位置（已部署、已驗證）：

- API：https://fushan-report-api.shrjie.workers.dev
- D1 測試站：https://fushan-d1.pages.dev（接 D1 API，資料庫目前是空的）
- D1 資料庫：`fushan-disease-report`（`4e644582-00fa-4f6e-9619-32676f3953c2`）

## 行為對照（與 Google 版相同）

- 家長：身分證字號查名下全部通報、可新增、24 小時內可編修（第 12 欄老師資料自動保留）
- 老師：密碼登入（2 小時 token）、列表摘要＋按需讀全文、編修／刪除、匯出 A4 列印
- 系統管理：改校名標題、改密碼（強度規則相同）
- 密碼雜湊算法相同（SHA-256 `salt::password`），搬家後舊密碼可直接登入

## 重新部署

```sh
cd D1
wrangler d1 execute fushan-disease-report --remote --file=schema.sql  # 改表結構才需要
wrangler deploy                                  # 後端 API
wrangler pages deploy web --project-name fushan-d1 --branch main   # 前端測試站
```

## 試算表搬家（把現有通報＋密碼搬進 D1）

1. 試算表 → `Reports` 工作表 → 檔案 → 下載 → CSV → 存成 `reports.csv`
2. 試算表 → `Settings` 工作表 → 下載 CSV → 存成 `settings.csv`（內含密碼雜湊＋校名，建議一起搬）
3. `python3 tools/sheet2d1.py --reports reports.csv --settings settings.csv --out import.sql`
4. `wrangler d1 execute fushan-disease-report --remote --file=import.sql`
5. 用**舊老師密碼**登入 https://fushan-d1.pages.dev 對筆數 → 到系統管理換新密碼
6. 確認無誤後，再把正式站（Netlify／既有 Pages）換成 D1 前端，或把 D1 前端推上正式專案

匯入用 `ON CONFLICT DO NOTHING`，同 RowId／Key 不會覆蓋 D1 已有資料，可安心重跑。
搬家空窗期若有家長在 Google 端新通報，搬完再補跑一次即可。

## 注意

- D1 測試站管理密碼目前仍是預設 `admin123`（只有你知道網址，但上線前務必先改）
- Google 端（試算表＋舊站）保持運作當備援，直到你確認切換
