/**
 * SheetAccess.gs (part of DaimsLib)
 * ----------------------------------------------------------------------------
 * Minimal, self-contained sheet read/write helpers duplicated here on
 * purpose — NOT imported from the host project's Database.gs/Utility.gs.
 * A library cannot reference host globals, and re-implementing four small
 * functions here is far safer than the alternative (a library that quietly
 * assumes a host-side Utility.gs with matching function names exists,
 * which breaks the moment someone reuses this library from a different
 * host project). Every public DaimsLib function below takes the target
 * Spreadsheet object explicitly — it never opens a spreadsheet by ID
 * itself, so the host retains full control over which workbook is touched.
 * ----------------------------------------------------------------------------
 */

function getHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

function rowsToObjects_(sheet) {
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row, idx) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    obj.__rowIndex = idx + 2;
    return obj;
  });
}

function objectToRow_(headers, obj) {
  return headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : '';
  });
}

function findSheet_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('DaimsLib: sheet tidak ditemukan: ' + sheetName);
  return sheet;
}
