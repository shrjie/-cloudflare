/**
 * 福山國中傳染病通報單 — API Worker（Cloudflare Workers＋D1）
 * ------------------------------------------------------------------
 * 協定與 Google 版 site/Code.gs 的 doPost 完全對應：
 *   POST {action, payload}，action ∈ submitOrUpdate / getByIdNumber /
 *   teacherLogin / listAll / getByRowId / teacherUpdate / teacherDelete /
 *   getPublicSettings / getAdminSettings / updateSiteSettings / changePassword
 * 密碼雜湊與 GAS 版同算法 SHA-256(salt + '::' + password)，試算表搬家時
 * PWD_HASH／PWD_SALT 可直接沿用，舊密碼無縫接軌。
 */

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 老師 token 效期 2 小時
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000; // 連續失敗鎖定 10 分鐘
const PARENT_EDIT_WINDOW_HOURS = 24; // 家長 24 小時內可編修
const DEFAULT_PASSWORD = 'admin123';
const DEFAULT_SITE_TITLE = '傳染病通報單線上系統';
const DEFAULT_SCHOOL_NAME = '高雄市市立福山國中';

// 第 12 欄（簽名與通報時間）由老師填寫：家長送件時保留舊值，不可覆寫
const TEACHER_ONLY_KEYS = [
  'signer',
  'parent_report_y', 'parent_report_m', 'parent_report_d', 'parent_report_date', 'parent_report_time',
  'teacher_report_y', 'teacher_report_m', 'teacher_report_d', 'teacher_report_date', 'teacher_report_time'
];

const CORS = {
  'Content-Type': 'application/json;charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });

/* ---------------- 小工具 ---------------- */

async function sha256hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const nowISO = () => new Date().toISOString();
const nowMs = () => Date.now();

async function getSetting(db, key) {
  const row = await db.prepare('SELECT Value FROM Settings WHERE Key = ?').bind(key).first();
  return row ? String(row.Value ?? '') : null;
}
async function setSetting(db, key, value) {
  await db.prepare('INSERT INTO Settings (Key, Value, UpdatedAt) VALUES (?, ?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value, UpdatedAt = excluded.UpdatedAt')
    .bind(key, String(value ?? ''), nowISO()).run();
}

/** 首次初始化：預設標題＋預設密碼（已存在則不覆寫，搬家資料優先） */
async function ensureSettingsInitialized(db) {
  if ((await getSetting(db, 'SITE_TITLE')) === null) await setSetting(db, 'SITE_TITLE', DEFAULT_SITE_TITLE);
  if ((await getSetting(db, 'SCHOOL_NAME')) === null) await setSetting(db, 'SCHOOL_NAME', DEFAULT_SCHOOL_NAME);
  if ((await getSetting(db, 'PWD_HASH')) === null || (await getSetting(db, 'PWD_SALT')) === null) {
    const salt = crypto.randomUUID() + crypto.randomUUID();
    await setSetting(db, 'PWD_SALT', salt);
    await setSetting(db, 'PWD_HASH', await sha256hex(salt + '::' + DEFAULT_PASSWORD));
    await setSetting(db, 'PWD_IS_DEFAULT', '1');
    await setSetting(db, 'PWD_UPDATED_AT', nowISO());
  }
}
const isDefaultPasswordFlag = async (db) => (await getSetting(db, 'PWD_IS_DEFAULT')) === '1';

async function verifyPassword(db, input) {
  await ensureSettingsInitialized(db);
  const salt = await getSetting(db, 'PWD_SALT');
  const hash = await getSetting(db, 'PWD_HASH');
  if (!salt || !hash) return false;
  return (await sha256hex(salt + '::' + String(input || ''))) === hash;
}

function checkPasswordStrength(pwd) {
  pwd = String(pwd || '');
  if (pwd.length < 8) return '新密碼至少 8 碼';
  if (pwd === DEFAULT_PASSWORD) return '不可使用預設密碼 admin123，請換一組';
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) return '新密碼需同時包含英文字母與數字';
  if (pwd.length > 64) return '新密碼過長（最多 64 碼）';
  return null;
}

/* ---------------- 登入保護＋token（D1 版 CacheService） ---------------- */

async function metaGet(db, key) {
  const row = await db.prepare('SELECT Value FROM Meta WHERE Key = ?').bind(key).first();
  return row ? String(row.Value ?? '') : null;
}
async function metaSet(db, key, value) {
  await db.prepare('INSERT INTO Meta (Key, Value) VALUES (?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value')
    .bind(key, String(value)).run();
}
async function metaDel(db, key) {
  await db.prepare('DELETE FROM Meta WHERE Key = ?').bind(key).run();
}

async function isLoginLocked(db) {
  const until = parseInt((await metaGet(db, 'login_locked_until')) || '0', 10) || 0;
  if (until && until > nowMs()) return true;
  if (until) { await metaDel(db, 'login_locked_until'); await metaDel(db, 'login_fail_count'); }
  return false;
}
async function recordLoginFail(db) {
  let n = parseInt((await metaGet(db, 'login_fail_count')) || '0', 10) || 0;
  n += 1;
  if (n >= LOGIN_FAIL_LIMIT) {
    await metaSet(db, 'login_locked_until', String(nowMs() + LOGIN_LOCK_MS));
    await metaDel(db, 'login_fail_count');
  } else {
    await metaSet(db, 'login_fail_count', String(n));
  }
  return n;
}
async function clearLoginFail(db) {
  await metaDel(db, 'login_fail_count');
  await metaDel(db, 'login_locked_until');
}

async function makeToken(db) {
  const token = crypto.randomUUID();
  await db.prepare('INSERT INTO Sessions (Token, CreatedAt) VALUES (?, ?)').bind(token, nowMs()).run();
  return token;
}
async function checkToken(db, token) {
  if (!token) return false;
  await db.prepare('DELETE FROM Sessions WHERE CreatedAt < ?').bind(nowMs() - TOKEN_TTL_MS).run();
  const row = await db.prepare('SELECT Token FROM Sessions WHERE Token = ?').bind(String(token)).first();
  return !!row;
}

/* ---------------- 通報資料 ---------------- */

function parseData(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}
function toRecord(row) {
  return {
    rowId: row.RowId, idNumber: row.IdNumber, name: row.Name,
    classInfo: row.ClassInfo, updatedAt: row.UpdatedAt || '', data: parseData(row.DataJson)
  };
}
function toSummary(row) {
  return {
    rowId: row.RowId, idNumber: row.IdNumber, name: row.Name,
    classInfo: row.ClassInfo, updatedAt: row.UpdatedAt || ''
  };
}
function editStatus(updatedAt) {
  const t = new Date(updatedAt).getTime();
  if (isNaN(t)) return { editable: true, expiresAt: null };
  const exp = new Date(t + PARENT_EDIT_WINDOW_HOURS * 3600 * 1000);
  return { editable: exp.getTime() > nowMs(), expiresAt: exp.toISOString() };
}
function preserveTeacherSection(payload, oldData) {
  oldData = oldData || {};
  for (const k of TEACHER_ONLY_KEYS) if (oldData[k] !== undefined) payload[k] = oldData[k];
  return payload;
}

async function coreSubmitOrUpdate(db, payload) {
  let p = payload || {};
  if (!p.idNumber && p.payload && typeof p.payload === 'object') p = p.payload; // 相容舊前端誤包一層
  const idNumber = String(p.idNumber || '').trim();
  if (!idNumber) return { success: false, message: '缺少身分證字號' };
  const name = p.name || '';
  const classInfo = p.classNumber || '';

  if (p._rowId) { // 家長 24 小時內編修舊案
    const row = await db.prepare('SELECT * FROM Reports WHERE RowId = ?').bind(String(p._rowId)).first();
    if (!row) return { success: false, message: '找不到該筆通報' };
    if (String(row.IdNumber) !== String(idNumber)) return { success: false, message: '身分證字號與通報紀錄不符' };
    const st = editStatus(row.UpdatedAt);
    if (!st.editable) {
      return { success: false, expired: true, message: '該筆通報已超過 24 小時編修期限，無法再修改。如需更正請聯繫導師或衛生組由管理端處理。' };
    }
    preserveTeacherSection(p, parseData(row.DataJson));
    await db.prepare('UPDATE Reports SET Name = ?, ClassInfo = ?, UpdatedAt = ?, DataJson = ? WHERE RowId = ?')
      .bind(name, classInfo, nowISO(), JSON.stringify(p), row.RowId).run();
    return { success: true, rowId: row.RowId, mode: 'updated' };
  }
  // 新案一律新增（舊案鎖定不影響新案）
  const rowId = crypto.randomUUID();
  await db.prepare('INSERT INTO Reports (RowId, IdNumber, Name, ClassInfo, UpdatedAt, DataJson) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(rowId, idNumber, name, classInfo, nowISO(), JSON.stringify(p)).run();
  return { success: true, rowId, mode: 'created' };
}

async function coreGetByIdNumber(db, idNumber) {
  idNumber = String(idNumber || '').trim();
  if (!idNumber) return { success: false, message: '缺少身分證字號' };
  const { results } = await db.prepare('SELECT * FROM Reports WHERE IdNumber = ? ORDER BY UpdatedAt DESC').bind(idNumber).all();
  if (!results.length) return { success: true, found: false, records: [] };
  const records = results.map((r) => {
    const rec = toRecord(r);
    const st = editStatus(r.UpdatedAt);
    rec.editable = st.editable;
    rec.expiresAt = st.expiresAt;
    return rec;
  });
  const latest = records[0];
  return {
    success: true, found: true, record: latest, records,
    editable: latest.editable, expiresAt: latest.expiresAt, editWindowHours: PARENT_EDIT_WINDOW_HOURS
  };
}

async function coreTeacherLogin(db, password) {
  await ensureSettingsInitialized(db);
  if (await isLoginLocked(db)) return { success: false, message: '登入失敗次數過多，已暫時鎖定 10 分鐘，請稍後再試' };
  if (await verifyPassword(db, password)) {
    await clearLoginFail(db);
    return { success: true, token: await makeToken(db), mustChangePassword: await isDefaultPasswordFlag(db) };
  }
  const n = await recordLoginFail(db);
  const remain = Math.max(0, LOGIN_FAIL_LIMIT - n);
  return { success: false, message: remain > 0 ? '密碼錯誤（剩餘嘗試 ' + remain + ' 次）' : '密碼錯誤，已暫時鎖定 10 分鐘' };
}

async function coreListAll(db, token) {
  if (!(await checkToken(db, token))) return { success: false, message: '請重新登入' };
  const { results } = await db.prepare('SELECT * FROM Reports ORDER BY UpdatedAt DESC').all();
  return { success: true, records: (results || []).filter((r) => r.RowId).map(toSummary) };
}

async function coreGetByRowId(db, p) {
  p = p || {};
  if (!(await checkToken(db, p.token))) return { success: false, message: '請重新登入' };
  if (!p.rowId) return { success: false, message: '缺少通報編號' };
  const row = await db.prepare('SELECT * FROM Reports WHERE RowId = ?').bind(String(p.rowId)).first();
  if (!row) return { success: false, message: '找不到資料（可能已被刪除）' };
  return { success: true, record: toRecord(row) };
}

async function coreTeacherUpdate(db, p) {
  p = p || {};
  if (!(await checkToken(db, p.token))) return { success: false, message: '請重新登入' };
  const row = await db.prepare('SELECT * FROM Reports WHERE RowId = ?').bind(String(p.rowId || '')).first();
  if (!row) return { success: false, message: '找不到資料' };
  const payload = p.data || {};
  await db.prepare('UPDATE Reports SET IdNumber = ?, Name = ?, ClassInfo = ?, UpdatedAt = ?, DataJson = ? WHERE RowId = ?')
    .bind(payload.idNumber || row.IdNumber, payload.name || '', payload.classNumber || '', nowISO(), JSON.stringify(payload), row.RowId).run();
  return { success: true };
}

async function coreTeacherDelete(db, p) {
  p = p || {};
  if (!(await checkToken(db, p.token))) return { success: false, message: '請重新登入' };
  const row = await db.prepare('SELECT * FROM Reports WHERE RowId = ?').bind(String(p.rowId || '')).first();
  if (!row) return { success: false, message: '找不到資料' };
  await db.prepare('DELETE FROM Reports WHERE RowId = ?').bind(row.RowId).run();
  return { success: true };
}

async function coreGetPublicSettings(db) {
  await ensureSettingsInitialized(db);
  return {
    success: true,
    schoolName: (await getSetting(db, 'SCHOOL_NAME')) || DEFAULT_SCHOOL_NAME,
    siteTitle: (await getSetting(db, 'SITE_TITLE')) || DEFAULT_SITE_TITLE
  };
}

async function coreGetAdminSettings(db, token) {
  if (!(await checkToken(db, token))) return { success: false, message: '請重新登入' };
  await ensureSettingsInitialized(db);
  return {
    success: true,
    schoolName: (await getSetting(db, 'SCHOOL_NAME')) || DEFAULT_SCHOOL_NAME,
    siteTitle: (await getSetting(db, 'SITE_TITLE')) || DEFAULT_SITE_TITLE,
    pwdUpdatedAt: (await getSetting(db, 'PWD_UPDATED_AT')) || '',
    isDefaultPassword: await isDefaultPasswordFlag(db)
  };
}

async function coreUpdateSiteSettings(db, p) {
  p = p || {};
  if (!(await checkToken(db, p.token))) return { success: false, message: '請重新登入' };
  const schoolName = String(p.schoolName || '').trim();
  const siteTitle = String(p.siteTitle || '').trim();
  if (!schoolName) return { success: false, message: '學校名稱不可空白' };
  if (!siteTitle) return { success: false, message: '網頁標題不可空白' };
  if (schoolName.length > 40) return { success: false, message: '學校名稱過長（最多 40 字）' };
  if (siteTitle.length > 40) return { success: false, message: '網頁標題過長（最多 40 字）' };
  await setSetting(db, 'SCHOOL_NAME', schoolName);
  await setSetting(db, 'SITE_TITLE', siteTitle);
  return { success: true, schoolName, siteTitle };
}

async function coreChangePassword(db, p) {
  p = p || {};
  if (!(await checkToken(db, p.token))) return { success: false, message: '請重新登入' };
  await ensureSettingsInitialized(db);
  if (!(await verifyPassword(db, p.oldPassword))) return { success: false, message: '舊密碼不正確' };
  const err = checkPasswordStrength(p.newPassword);
  if (err) return { success: false, message: err };
  if (String(p.newPassword) !== String(p.confirmPassword)) return { success: false, message: '兩次輸入的新密碼不一致' };
  if (String(p.oldPassword) === String(p.newPassword)) return { success: false, message: '新密碼不可與舊密碼相同' };
  const salt = crypto.randomUUID() + crypto.randomUUID();
  await setSetting(db, 'PWD_SALT', salt);
  await setSetting(db, 'PWD_HASH', await sha256hex(salt + '::' + String(p.newPassword)));
  await setSetting(db, 'PWD_UPDATED_AT', nowISO());
  await setSetting(db, 'PWD_IS_DEFAULT', '0');
  return { success: true };
}

/* ---------------- 入口 ---------------- */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const db = env.DB;
    try {
      if (request.method === 'GET') {
        const pub = await coreGetPublicSettings(db);
        return json({ success: true, message: '福山國中傳染病通報單後端運作中（Cloudflare D1）', schoolName: pub.schoolName, siteTitle: pub.siteTitle, settings: { schoolName: pub.schoolName, siteTitle: pub.siteTitle } });
      }
      if (request.method !== 'POST') return json({ success: false, message: '不支援的方法' }, 405);
      let body = {};
      try { body = await request.json(); } catch { return json({ success: false, message: '無效的請求格式' }); }
      const action = body.action;
      const q = body.payload;
      switch (action) {
        case 'submitOrUpdate': return json(await coreSubmitOrUpdate(db, q));
        case 'getByIdNumber': return json(await coreGetByIdNumber(db, (q || {}).idNumber));
        case 'teacherLogin': return json(await coreTeacherLogin(db, (q || {}).password));
        case 'listAll': return json(await coreListAll(db, (q || {}).token));
        case 'getByRowId': return json(await coreGetByRowId(db, q));
        case 'teacherUpdate': return json(await coreTeacherUpdate(db, q));
        case 'teacherDelete': return json(await coreTeacherDelete(db, q));
        case 'getPublicSettings': return json(await coreGetPublicSettings(db));
        case 'getAdminSettings': return json(await coreGetAdminSettings(db, (q || {}).token));
        case 'updateSiteSettings': return json(await coreUpdateSiteSettings(db, q));
        case 'changePassword': return json(await coreChangePassword(db, q));
        default: return json({ success: false, message: '未知的操作' });
      }
    } catch (e) {
      return json({ success: false, message: '伺服器錯誤：' + (e && e.message ? e.message : e) });
    }
  }
};
