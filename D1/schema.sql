-- 福山國中傳染病通報單 — Cloudflare D1 結構
-- 對應 Google 版：Reports 工作表 / Settings 工作表 / CacheService(token＋登入鎖定)
-- 套用：wrangler d1 execute fushan-disease-report --remote --file=D1/schema.sql

CREATE TABLE IF NOT EXISTS Reports (
  RowId     TEXT PRIMARY KEY,
  IdNumber  TEXT NOT NULL,
  Name      TEXT DEFAULT '',
  ClassInfo TEXT DEFAULT '',
  UpdatedAt TEXT NOT NULL,
  DataJson  TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_reports_idnumber ON Reports(IdNumber);
CREATE INDEX IF NOT EXISTS idx_reports_updated ON Reports(UpdatedAt DESC);

CREATE TABLE IF NOT EXISTS Settings (
  Key       TEXT PRIMARY KEY,
  Value     TEXT DEFAULT '',
  UpdatedAt TEXT
);

-- 老師登入 token（對應 GAS CacheService，效期 2 小時，查驗時順手清過期）
CREATE TABLE IF NOT EXISTS Sessions (
  Token     TEXT PRIMARY KEY,
  CreatedAt INTEGER NOT NULL
);

-- 登入防爆：失敗次數＋鎖定到期（ms epoch）
CREATE TABLE IF NOT EXISTS Meta (
  Key   TEXT PRIMARY KEY,
  Value TEXT DEFAULT ''
);
