/**
 * 高雄市市立福山國中傳染病通報單 — Google Sites 版 (Google Apps Script，單一專案：前端 + 後端)
 * ----------------------------------------------------------------------------------
 * 部署方式：
 * 1. 開一份新的 Google 試算表（作為資料庫，例如命名「福山國中傳染病通報單_資料庫」）。
 * 2. 上方選單「擴充功能」→「Apps Script」。
 * 3. 把本檔（site/Code.gs）內容整個貼上，取代預設的 Code.gs。
 * 4. 在 Apps Script 左側按「+」→「HTML」，檔案名稱取為 index，
 *    把 site/index.html 的內容整個貼上（取代預設內容）。
 * 5. （新版已不需要手動設定 TEACHER_PASSWORD）
 *    第一次使用管理密碼預設為 `admin123`，登入後請立刻到「系統管理」修改。
 *    密碼以加鹽 SHA-256 雜湊存放在試算表 `Settings` 工作表中，不存明文。
 *    若舊專案曾在「指令碼屬性」設定過 TEACHER_PASSWORD，首次執行會自動遷移並清除該屬性。
 * 6. 右上角「部署」→「新增部署作業」：
 *    - 類型：網頁應用程式
 *    - 執行身分：我
 *    - 誰可以存取：所有人
 * 7. 複製產生的網址（結尾為 /exec），到 Google Sites 用「嵌入」→「依網址」貼上即可。
 */

const SHEET_NAME = 'Reports';
const HEADERS = ['RowId', 'IdNumber', 'Name', 'ClassInfo', 'UpdatedAt', 'DataJson'];
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 教師登入 token 有效 2 小時

/* ---------------- 系統管理（Settings 表） ---------------- */
const SETTINGS_SHEET_NAME = 'Settings';
const SETTINGS_HEADERS = ['Key', 'Value', 'UpdatedAt'];
const DEFAULT_SITE_TITLE = '傳染病通報單線上系統';
const DEFAULT_SCHOOL_NAME = '高雄市市立福山國中';
const DEFAULT_PASSWORD = 'admin123';
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_SECONDS = 10 * 60; // 連續失敗鎖定 10 分鐘

/* 家長編修期限：通報後 24 小時內可編修，管理（老師）不受限制 */
const PARENT_EDIT_WINDOW_HOURS = 24;

function getEditWindowMs_() { return PARENT_EDIT_WINDOW_HOURS * 60 * 60 * 1000; }

function getParentEditStatus_(updatedAt) {
  const updated = new Date(updatedAt);
  if (isNaN(updated.getTime())) return { editable: true, expiresAt: null, remainingMs: null };
  const expires = new Date(updated.getTime() + getEditWindowMs_());
  const remaining = expires.getTime() - new Date().getTime();
  return { editable: remaining > 0, expiresAt: expires, remainingMs: Math.max(0, remaining) };
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getSettingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    sheet.appendRow(SETTINGS_HEADERS);
    sheet.setFrozenRows(1);
  }
  // 保護：避免家長/檢視者誤改（只有試算表擁有者可編輯，仍建議定期檢查共用設定）
  return sheet;
}

function getSetting_(key) {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(key)) return String(data[i][1] == null ? '' : data[i][1]);
  }
  return null;
}

function setSetting_(key, value) {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  let firstRow = -1;
  const dupRows = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(key)) {
      if (firstRow === -1) firstRow = i + 1;
      else dupRows.push(i + 1);
    }
  }
  if (firstRow !== -1) {
    sheet.getRange(firstRow, 1).setValue(key); // 正規化 key（順手去掉空白）
    sheet.getRange(firstRow, 2).setValue(value);
    sheet.getRange(firstRow, 3).setValue(new Date());
  } else {
    sheet.appendRow([key, value, new Date()]);
  }
  // 舊的重複列由下往上刪除，自動修復
  for (let k = dupRows.length - 1; k >= 0; k--) {
    sheet.deleteRow(dupRows[k]);
  }
}

/* 一次性修復：刪除 Settings 表中重複的 key 列（保留第一列）。可在編輯器直接執行一次。 */
function repairSettingsDuplicates() {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  const seen = {};
  const toDelete = [];
  for (let i = 1; i < data.length; i++) {
    const k = String(data[i][0]).trim();
    if (!k) continue;
    if (seen[k]) toDelete.push(i + 1);
    else seen[k] = i + 1;
  }
  for (let k = toDelete.length - 1; k >= 0; k--) sheet.deleteRow(toDelete[k]);
  Logger.log('已刪除重複列：' + toDelete.length + ' 列');
}

/* ---------------- 密碼安全：加鹽 SHA-256，不存明文 ---------------- */

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function hashPassword_(plainPassword, salt) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + '::' + plainPassword,
    Utilities.Charset.UTF_8
  );
  return bytesToHex_(digest);
}

function isDefaultPasswordFlag_() {
  return getSetting_('PWD_IS_DEFAULT') === '1';
}

/**
 * 確保 Settings 已初始化：
 * - SITE_TITLE / SCHOOL_NAME 預設值
 * - PWD_HASH + PWD_SALT：若無則從舊版 TEACHER_PASSWORD 遷移，否則用 admin123 建立
 */
function ensureSettingsInitialized_() {
  // 防多人同時首次開啟造成重複列：先拿鎖（拿不到也不卡死，流程本身具冪等性）
  const lock = LockService.getScriptLock();
  let locked = false;
  try { lock.waitLock(10000); locked = true; } catch (e) { locked = false; }
  try {
    ensureSettingsInitializedInner_();
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e) {} }
  }
}

function ensureSettingsInitializedInner_() {
  if (!getSetting_('SITE_TITLE')) setSetting_('SITE_TITLE', DEFAULT_SITE_TITLE);
  if (!getSetting_('SCHOOL_NAME')) setSetting_('SCHOOL_NAME', DEFAULT_SCHOOL_NAME);

  let hash = getSetting_('PWD_HASH');
  let salt = getSetting_('PWD_SALT');
  if (hash && salt) return;

  // 舊版遷移：指令碼屬性 TEACHER_PASSWORD（明文，只在此刻讀一次，隨即清除）
  let legacyPlain = null;
  try {
    legacyPlain = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD');
  } catch (e) { legacyPlain = null; }
  const initialPlain = (legacyPlain && String(legacyPlain).trim()) ? String(legacyPlain).trim() : DEFAULT_PASSWORD;
  const isDefault = (initialPlain === DEFAULT_PASSWORD);

  salt = Utilities.getUuid() + Utilities.getUuid();
  hash = hashPassword_(initialPlain, salt);
  setSetting_('PWD_SALT', salt);
  setSetting_('PWD_HASH', hash);
  setSetting_('PWD_UPDATED_AT', new Date().toISOString());
  setSetting_('PWD_IS_DEFAULT', isDefault ? '1' : '0');

  // 遷移後立即清除明文屬性，避免殘留
  try {
    if (legacyPlain) PropertiesService.getScriptProperties().deleteProperty('TEACHER_PASSWORD');
  } catch (e) { /* ignore */ }
}

function verifyPassword_(inputPassword) {
  ensureSettingsInitialized_();
  const salt = getSetting_('PWD_SALT');
  const hash = getSetting_('PWD_HASH');
  if (!salt || !hash) return false;
  return hashPassword_(String(inputPassword || ''), salt) === hash;
}

function checkPasswordStrength_(pwd) {
  pwd = String(pwd || '');
  if (pwd.length < 8) return '新密碼至少 8 碼';
  if (pwd === DEFAULT_PASSWORD) return '不可使用預設密碼 admin123，請換一組';
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) return '新密碼需同時包含英文字母與數字';
  if (pwd.length > 64) return '新密碼過長（最多 64 碼）';
  return null;
}

/* ---------------- 登入保護：失敗計數 + 鎖定 ---------------- */

function loginFailKey_() { return 'login_fail_count'; }
function loginLockKey_() { return 'login_locked_until'; }

function isLoginLocked_() {
  const cache = CacheService.getScriptCache();
  return cache.get(loginLockKey_()) === '1';
}

function recordLoginFail_() {
  const cache = CacheService.getScriptCache();
  let n = parseInt(cache.get(loginFailKey_()) || '0', 10) || 0;
  n += 1;
  cache.put(loginFailKey_(), String(n), LOGIN_LOCK_SECONDS);
  if (n >= LOGIN_FAIL_LIMIT) {
    cache.put(loginLockKey_(), '1', LOGIN_LOCK_SECONDS);
    cache.remove(loginFailKey_());
  }
  return n;
}

function clearLoginFail_() {
  const cache = CacheService.getScriptCache();
  cache.remove(loginFailKey_());
  cache.remove(loginLockKey_());
}

function getTeacherPassword_() {
  // 相容舊呼叫：回傳提示字串而非明文（明文已不再儲存）
  ensureSettingsInitialized_();
  return isDefaultPasswordFlag_() ? DEFAULT_PASSWORD + '（預設，請登入後立即修改）' : '（已雜湊儲存，請用系統管理修改）';
}

function makeToken_() {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('teacher_' + token, '1', TOKEN_TTL_SECONDS);
  return token;
}

function checkToken_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get('teacher_' + token) === '1';
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function findRowByIdNumber_(sheet, idNumber) {
  // 相容舊呼叫：回傳最新一筆（多筆架構下取 UpdatedAt 最大者）
  const all = findRowsByIdNumber_(sheet, idNumber);
  return all.length ? all[0] : null;
}

function findRowsByIdNumber_(sheet, idNumber) {
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (String(data[i][1]) === String(idNumber)) {
      out.push({ rowIndex: i + 1, row: data[i] });
    }
  }
  // 最新在前
  out.sort(function (a, b) { return new Date(b.row[4]) - new Date(a.row[4]); });
  return out;
}

function findRowByRowId_(sheet, rowId) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(rowId)) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function isoTime_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : v.toISOString();
  }
  return v == null ? '' : v;
}

function rowToRecord_(row) {
  let data = {};
  try { data = JSON.parse(row[5] || '{}'); } catch (e) { data = {}; }
  return {
    rowId: row[0],
    idNumber: row[1],
    name: row[2],
    classInfo: row[3],
    updatedAt: isoTime_(row[4]),
    data: data
  };
}

function rowToSummary_(row) {
  return {
    rowId: row[0],
    idNumber: row[1],
    name: row[2],
    classInfo: row[3],
    updatedAt: isoTime_(row[4])
  };
}

/* ---------------- 核心邏輯（doPost 與 google.script.run 共用） ---------------- */

/* 第 12 欄（簽名與通報時間）由老師填寫：家長送件時保留舊值，不可覆寫 */
const TEACHER_ONLY_KEYS = [
  'signer',
  'parent_report_y', 'parent_report_m', 'parent_report_d', 'parent_report_date', 'parent_report_time',
  'teacher_report_y', 'teacher_report_m', 'teacher_report_d', 'teacher_report_date', 'teacher_report_time'
];

function preserveTeacherSection_(newPayload, oldData) {
  oldData = oldData || {};
  TEACHER_ONLY_KEYS.forEach(function (k) {
    if (oldData[k] !== undefined) newPayload[k] = oldData[k];
  });
  return newPayload;
}

// 家長：新增通報一律建新列（舊案鎖定但新案可報）；
// 若 payload 帶 _rowId 則為 24 小時內編修舊案（須驗期限＋保留第 12 欄老師資料）
function coreSubmitOrUpdate_(payload) {
  let p = payload || {};
  // 相容舊版前端誤包一層 {payload: data} 的情況
  if (!p.idNumber && p.payload && typeof p.payload === 'object') {
    p = p.payload;
  }
  const idNumber = String(p.idNumber || '').trim();
  if (!idNumber) return { success: false, message: '缺少身分證字號' };

  const sheet = getSheet_();
  const now = new Date();
  const name = p.name || '';
  const classInfo = p.classNumber || '';

  // 編修舊案（家長 24 小時內）
  if (p._rowId) {
    const existing = findRowByRowId_(sheet, p._rowId);
    if (!existing) return { success: false, message: '找不到該筆通報' };
    if (String(existing.row[1]) !== String(idNumber)) {
      return { success: false, message: '身分證字號與通報紀錄不符' };
    }
    const st = getParentEditStatus_(existing.row[4]);
    if (!st.editable) {
      return {
        success: false,
        expired: true,
        message: '該筆通報已超過 24 小時編修期限，無法再修改。如需更正請聯繫導師或衛生組由管理端處理。'
      };
    }
    let oldData = {};
    try { oldData = JSON.parse(existing.row[5] || '{}'); } catch (e) { oldData = {}; }
    // 第 12 欄由老師填寫：家長編修時保留舊值
    preserveTeacherSection_(p, oldData);
    const dataJson = JSON.stringify(p);
    const r = existing.rowIndex;
    sheet.getRange(r, 3).setValue(name);
    sheet.getRange(r, 4).setValue(classInfo);
    sheet.getRange(r, 5).setValue(now);
    sheet.getRange(r, 6).setValue(dataJson);
    return { success: true, rowId: existing.row[0], mode: 'updated' };
  }

  // 新案通報：一律新增（不受舊案鎖定影響）
  const dataJson = JSON.stringify(p);
  const rowId = Utilities.getUuid();
  sheet.appendRow([rowId, idNumber, name, classInfo, now, dataJson]);
  return { success: true, rowId: rowId, mode: 'created' };
}

// 家長：以身分證字號查詢名下全部通報（新→舊；每筆附 24 小時編修狀態）
function coreGetByIdNumber_(idNumber) {
  idNumber = String(idNumber || '').trim();
  if (!idNumber) return { success: false, message: '缺少身分證字號' };
  const list = findRowsByIdNumber_(getSheet_(), idNumber);
  if (!list.length) return { success: true, found: false, records: [] };
  const records = list.map(function (item) {
    const record = rowToRecord_(item.row);
    const st = getParentEditStatus_(item.row[4]);
    record.editable = st.editable;
    record.expiresAt = st.expiresAt ? st.expiresAt.toISOString() : null;
    return record;
  });
  const latest = records[0];
  return {
    success: true,
    found: true,
    record: latest, // 相容舊前端：最新一筆
    records: records,
    editable: latest.editable,
    expiresAt: latest.expiresAt,
    editWindowHours: PARENT_EDIT_WINDOW_HOURS
  };
}

// 老師：登入（驗雜湊＋防暴力破解＋回傳是否仍為預設密碼）
function coreTeacherLogin_(password) {
  ensureSettingsInitialized_();
  if (isLoginLocked_()) {
    return { success: false, message: '登入失敗次數過多，已暫時鎖定 10 分鐘，請稍後再試' };
  }
  if (verifyPassword_(password)) {
    clearLoginFail_();
    return {
      success: true,
      token: makeToken_(),
      mustChangePassword: isDefaultPasswordFlag_()
    };
  }
  const n = recordLoginFail_();
  const remain = Math.max(0, LOGIN_FAIL_LIMIT - n);
  return {
    success: false,
    message: remain > 0
      ? '密碼錯誤（剩餘嘗試 ' + remain + ' 次）'
      : '密碼錯誤，已暫時鎖定 10 分鐘'
  };
}

// 老師：列出全部通報（只回傳輕量摘要，不含完整表單 JSON；點開才另取完整資料）
function coreListAll_(token) {
  if (!checkToken_(token)) return { success: false, message: '請重新登入' };
  const sheet = getSheet_();
  const range = sheet.getDataRange();
  const data = range.getValues();
  if (!data || data.length < 2) return { success: true, records: [] };
  const records = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    records.push(rowToSummary_(data[i]));
  }
  records.sort(function (a, b) {
    const ta = new Date(a.updatedAt).getTime();
    const tb = new Date(b.updatedAt).getTime();
    const va = isNaN(ta) ? 0 : ta;
    const vb = isNaN(tb) ? 0 : tb;
    return vb - va;
  });
  return { success: true, records: records };
}

// 老師：依 rowId 取得單筆完整通報（含表單 data）
function coreGetByRowId_(p) {
  p = p || {};
  if (!checkToken_(p.token)) return { success: false, message: '請重新登入' };
  if (!p.rowId) return { success: false, message: '缺少通報編號' };
  const existing = findRowByRowId_(getSheet_(), p.rowId);
  if (!existing) return { success: false, message: '找不到資料（可能已被刪除）' };
  return { success: true, record: rowToRecord_(existing.row) };
}

// 老師：編修指定通報（管理不受 24 小時限制）
function coreTeacherUpdate_(p) {
  p = p || {};
  if (!checkToken_(p.token)) return { success: false, message: '請重新登入' };
  const sheet = getSheet_();
  const existing = findRowByRowId_(sheet, p.rowId);
  if (!existing) return { success: false, message: '找不到資料' };
  const r = existing.rowIndex;
  const payload = p.data || {};
  sheet.getRange(r, 2).setValue(payload.idNumber || existing.row[1]);
  sheet.getRange(r, 3).setValue(payload.name || '');
  sheet.getRange(r, 4).setValue(payload.classNumber || '');
  sheet.getRange(r, 5).setValue(new Date());
  sheet.getRange(r, 6).setValue(JSON.stringify(payload));
  return { success: true };
}

// 老師：刪除指定通報
function coreTeacherDelete_(p) {
  p = p || {};
  if (!checkToken_(p.token)) return { success: false, message: '請重新登入' };
  const sheet = getSheet_();
  const existing = findRowByRowId_(sheet, p.rowId);
  if (!existing) return { success: false, message: '找不到資料' };
  sheet.deleteRow(existing.rowIndex);
  return { success: true };
}

/* ---------------- 管理功能：網站標題＋密碼（密碼只存雜湊） ---------------- */

// 公開：前端載入時取得網站標題（不需登入、不含任何密碼資訊）
function coreGetPublicSettings_() {
  ensureSettingsInitialized_();
  return {
    success: true,
    schoolName: getSetting_('SCHOOL_NAME') || DEFAULT_SCHOOL_NAME,
    siteTitle: getSetting_('SITE_TITLE') || DEFAULT_SITE_TITLE
  };
}

// 管理：取得完整設定（需 token；只回傳「是否為預設密碼＋更新時間」，絕不回傳雜湊）
function coreGetAdminSettings_(token) {
  if (!checkToken_(token)) return { success: false, message: '請重新登入' };
  ensureSettingsInitialized_();
  return {
    success: true,
    schoolName: getSetting_('SCHOOL_NAME') || DEFAULT_SCHOOL_NAME,
    siteTitle: getSetting_('SITE_TITLE') || DEFAULT_SITE_TITLE,
    pwdUpdatedAt: getSetting_('PWD_UPDATED_AT') || '',
    isDefaultPassword: isDefaultPasswordFlag_()
  };
}

// 管理：修改網頁標題（需 token）
function coreUpdateSiteSettings_(p) {
  p = p || {};
  if (!checkToken_(p.token)) return { success: false, message: '請重新登入' };
  const schoolName = String(p.schoolName || '').trim();
  const siteTitle = String(p.siteTitle || '').trim();
  if (!schoolName) return { success: false, message: '學校名稱不可空白' };
  if (!siteTitle) return { success: false, message: '網頁標題不可空白' };
  if (schoolName.length > 40) return { success: false, message: '學校名稱過長（最多 40 字）' };
  if (siteTitle.length > 40) return { success: false, message: '網頁標題過長（最多 40 字）' };
  setSetting_('SCHOOL_NAME', schoolName);
  setSetting_('SITE_TITLE', siteTitle);
  return { success: true, schoolName: schoolName, siteTitle: siteTitle };
}

// 管理：修改密碼（需 token＋舊密碼＋強度檢查；只存鹽＋雜湊）
function coreChangePassword_(p) {
  p = p || {};
  if (!checkToken_(p.token)) return { success: false, message: '請重新登入' };
  ensureSettingsInitialized_();
  if (!verifyPassword_(p.oldPassword)) {
    return { success: false, message: '舊密碼不正確' };
  }
  const err = checkPasswordStrength_(p.newPassword);
  if (err) return { success: false, message: err };
  if (String(p.newPassword) !== String(p.confirmPassword)) {
    return { success: false, message: '兩次輸入的新密碼不一致' };
  }
  if (String(p.oldPassword) === String(p.newPassword)) {
    return { success: false, message: '新密碼不可與舊密碼相同' };
  }
  const salt = Utilities.getUuid() + Utilities.getUuid();
  setSetting_('PWD_SALT', salt);
  setSetting_('PWD_HASH', hashPassword_(String(p.newPassword), salt));
  setSetting_('PWD_UPDATED_AT', new Date().toISOString());
  setSetting_('PWD_IS_DEFAULT', '0');
  return { success: true };
}

/* ---------------- 前端呼叫入口（本站版 index.html 經 google.script.run 呼叫） ---------------- */

// 安全包裝：後端例外轉為 {success:false, message} 回傳，前端才看得到原因
function safeApi_(fn, arg) {
  try {
    return fn(arg);
  } catch (err) {
    return { success: false, message: '伺服器錯誤：' + (err && err.message ? err.message : err) };
  }
}

function apiSubmitOrUpdate(payload) { return safeApi_(coreSubmitOrUpdate_, payload); }
function apiGetByIdNumber(payload) { return safeApi_(function (p) { return coreGetByIdNumber_((p || {}).idNumber); }, payload); }
function apiTeacherLogin(payload) { return safeApi_(function (p) { return coreTeacherLogin_((p || {}).password); }, payload); }
function apiListAll(payload) { return safeApi_(function (p) { return coreListAll_((p || {}).token); }, payload); }
function apiGetByRowId(payload) { return safeApi_(coreGetByRowId_, payload); }
function apiTeacherUpdate(payload) { return safeApi_(coreTeacherUpdate_, payload); }
function apiTeacherDelete(payload) { return safeApi_(coreTeacherDelete_, payload); }
function apiGetPublicSettings() { return safeApi_(coreGetPublicSettings_); }
function apiGetAdminSettings(payload) { return safeApi_(function (p) { return coreGetAdminSettings_((p || {}).token); }, payload); }
function apiUpdateSiteSettings(payload) { return safeApi_(coreUpdateSiteSettings_, payload); }
function apiChangePassword(payload) { return safeApi_(coreChangePassword_, payload); }

/* ---------------- 網頁提供（前端頁面＋保留 JSON 式 doPost 以便除錯） ---------------- */

function doGet(e) {
  ensureSettingsInitialized_();
  const school = getSetting_('SCHOOL_NAME') || DEFAULT_SCHOOL_NAME;
  const title = getSetting_('SITE_TITLE') || DEFAULT_SITE_TITLE;
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle(school + '｜' + title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, message: '無效的請求格式' });
  }
  const action = body.action;

  try {
    switch (action) {
      case 'submitOrUpdate':
        return jsonOut_(coreSubmitOrUpdate_(body.payload));
      case 'getByIdNumber':
        return jsonOut_(coreGetByIdNumber_((body.payload || {}).idNumber));
      case 'teacherLogin':
        return jsonOut_(coreTeacherLogin_((body.payload || {}).password));
      case 'listAll':
        return jsonOut_(coreListAll_((body.payload || {}).token));
      case 'getByRowId':
        return jsonOut_(coreGetByRowId_(body.payload));
      case 'teacherUpdate':
        return jsonOut_(coreTeacherUpdate_(body.payload));
      case 'teacherDelete':
        return jsonOut_(coreTeacherDelete_(body.payload));
      case 'getPublicSettings':
        return jsonOut_(coreGetPublicSettings_());
      case 'getAdminSettings':
        return jsonOut_(coreGetAdminSettings_((body.payload || {}).token));
      case 'updateSiteSettings':
        return jsonOut_(coreUpdateSiteSettings_(body.payload));
      case 'changePassword':
        return jsonOut_(coreChangePassword_(body.payload));
      default:
        return jsonOut_({ success: false, message: '未知的操作' });
    }
  } catch (err) {
    return jsonOut_({ success: false, message: '伺服器錯誤：' + err.message });
  }
}
