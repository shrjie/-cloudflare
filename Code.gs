/**
 * 高雄市市立福山國中傳染病通報單 — 後端 (Google Apps Script)
 * ------------------------------------------------------------
 * 部署方式：
 * 1. 開一份新的 Google 試算表（作為資料庫）。
 * 2. 「擴充功能」→「Apps Script」，把本檔內容整個貼上（取代預設內容）。
 * 3. 上方選單「專案設定」→ 可自訂密碼：在「指令碼屬性」新增
 *    屬性名稱 TEACHER_PASSWORD，值填入老師登入用密碼。
 *    （若不設定，預設密碼為 admin123，強烈建議部署後立刻設定自己的密碼）
 * 4. 「部署」→「新增部署作業」→ 類型選「網頁應用程式」：
 *    - 執行身分：我 (你的帳號)
 *    - 誰可以存取：所有人
 * 5. 部署後取得網頁應用程式網址 (.../exec)，貼到前端 HTML 的 GAS_URL。
 */

const SHEET_NAME = 'Reports';
const HEADERS = ['RowId', 'IdNumber', 'Name', 'ClassInfo', 'UpdatedAt', 'DataJson'];
const TOKEN_TTL_SECONDS = 60 * 60 * 2; // 教師登入 token 有效 2 小時

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

function getTeacherPassword_() {
  const p = PropertiesService.getScriptProperties().getProperty('TEACHER_PASSWORD');
  return p || 'admin123';
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
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(idNumber)) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
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

function rowToRecord_(row) {
  let data = {};
  try { data = JSON.parse(row[5] || '{}'); } catch (e) { data = {}; }
  return {
    rowId: row[0],
    idNumber: row[1],
    name: row[2],
    classInfo: row[3],
    updatedAt: row[4],
    data: data
  };
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, message: '無效的請求格式' });
  }
  const action = body.action;
  const sheet = getSheet_();

  try {
    switch (action) {

      // ---- 家長：新增或更新（以身分證字號為索引，只保留最近一筆）----
      case 'submitOrUpdate': {
        let payload = body.payload || {};
        // 相容舊版前端誤包一層 {payload: data} 的情況
        if (!payload.idNumber && payload.payload && typeof payload.payload === 'object') {
          payload = payload.payload;
        }
        const idNumber = String(payload.idNumber || '').trim();
        if (!idNumber) return jsonOut_({ success: false, message: '缺少身分證字號' });

        const now = new Date();
        const name = payload.name || '';
        const classInfo = payload.classNumber || '';
        const dataJson = JSON.stringify(payload);

        const existing = findRowByIdNumber_(sheet, idNumber);
        if (existing) {
          const r = existing.rowIndex;
          sheet.getRange(r, 3).setValue(name);
          sheet.getRange(r, 4).setValue(classInfo);
          sheet.getRange(r, 5).setValue(now);
          sheet.getRange(r, 6).setValue(dataJson);
          return jsonOut_({ success: true, rowId: existing.row[0], mode: 'updated' });
        } else {
          const rowId = Utilities.getUuid();
          sheet.appendRow([rowId, idNumber, name, classInfo, now, dataJson]);
          return jsonOut_({ success: true, rowId: rowId, mode: 'created' });
        }
      }

      // ---- 家長：以身分證字號查詢自己最近一筆填報 ----
      case 'getByIdNumber': {
        const idNumber = String((body.payload || {}).idNumber || '').trim();
        if (!idNumber) return jsonOut_({ success: false, message: '缺少身分證字號' });
        const existing = findRowByIdNumber_(sheet, idNumber);
        if (!existing) return jsonOut_({ success: true, found: false });
        return jsonOut_({ success: true, found: true, record: rowToRecord_(existing.row) });
      }

      // ---- 老師：登入 ----
      case 'teacherLogin': {
        const password = (body.payload || {}).password || '';
        if (password === getTeacherPassword_()) {
          return jsonOut_({ success: true, token: makeToken_() });
        }
        return jsonOut_({ success: false, message: '密碼錯誤' });
      }

      // ---- 老師：列出全部通報 ----
      case 'listAll': {
        const token = (body.payload || {}).token;
        if (!checkToken_(token)) return jsonOut_({ success: false, message: '請重新登入' });
        const data = sheet.getDataRange().getValues();
        const records = [];
        for (let i = 1; i < data.length; i++) {
          if (!data[i][0]) continue;
          records.push(rowToRecord_(data[i]));
        }
        records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        return jsonOut_({ success: true, records: records });
      }

      // ---- 老師：編修指定通報 ----
      case 'teacherUpdate': {
        const p = body.payload || {};
        if (!checkToken_(p.token)) return jsonOut_({ success: false, message: '請重新登入' });
        const existing = findRowByRowId_(sheet, p.rowId);
        if (!existing) return jsonOut_({ success: false, message: '找不到資料' });
        const r = existing.rowIndex;
        const payload = p.data || {};
        sheet.getRange(r, 2).setValue(payload.idNumber || existing.row[1]);
        sheet.getRange(r, 3).setValue(payload.name || '');
        sheet.getRange(r, 4).setValue(payload.classNumber || '');
        sheet.getRange(r, 5).setValue(new Date());
        sheet.getRange(r, 6).setValue(JSON.stringify(payload));
        return jsonOut_({ success: true });
      }

      // ---- 老師：刪除指定通報 ----
      case 'teacherDelete': {
        const p = body.payload || {};
        if (!checkToken_(p.token)) return jsonOut_({ success: false, message: '請重新登入' });
        const existing = findRowByRowId_(sheet, p.rowId);
        if (!existing) return jsonOut_({ success: false, message: '找不到資料' });
        sheet.deleteRow(existing.rowIndex);
        return jsonOut_({ success: true });
      }

      default:
        return jsonOut_({ success: false, message: '未知的操作' });
    }
  } catch (err) {
    return jsonOut_({ success: false, message: '伺服器錯誤：' + err.message });
  }
}

function doGet(e) {
  return jsonOut_({ success: true, message: '福山國中傳染病通報單後端運作中' });
}
