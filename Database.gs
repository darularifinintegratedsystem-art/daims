/**
 * Database.gs
 * ----------------------------------------------------------------------------
 * Generic read/write abstraction over Google Sheets. This is the ONLY file
 * allowed to call SpreadsheetApp range methods for CRUD — every feature
 * module (Automation.gs etc.) goes through getRows/getRowById/insertRow/
 * updateRow, never touches a Range directly. This keeps cache-protection,
 * validation-before-write, and audit logging enforced in exactly one place.
 *
 * CACHE PROTECTION (two layers, see Core.gs header comment for why two):
 *   1. Whole-sheet: read from DATA_OWNERSHIP_MATRIX.cache = 'Ya'.
 *   2. Partial-column: PARTIAL_CACHE_COLUMNS constant (documented exceptions
 *      like TABUNGAN_SANTRI.saldo_saat_ini).
 * ----------------------------------------------------------------------------
 */

/** Returns true if the sheet is flagged cache='Ya' in DATA_OWNERSHIP_MATRIX. */
function isWholeSheetCache_(sheetName) {
  const ss = getCoreSpreadsheet_();
  const matrixSheet = ss.getSheetByName(SHEETS.DATA_OWNERSHIP_MATRIX);
  if (!matrixSheet) return false; // fail open on lookup, not on the write itself
  const rows = rowsToObjects_(matrixSheet);
  const entry = rows.find(function (r) { return r.nama_entity === sheetName; });
  return !!entry && entry.cache === 'Ya';
}

/** Returns the list of protected (partial-cache) columns for a sheet, if any. */
function getProtectedColumns_(sheetName) {
  return PARTIAL_CACHE_COLUMNS[sheetName] || [];
}

/**
 * Reads rows from a sheet with optional equality filters.
 * @param {string} sheetName
 * @param {Object=} filters e.g. { id_santri: 'STR0001', status: 'Aktif' }
 * @return {Array<Object>}
 */
function getRows(sheetName, filters) {
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);

  let rows = rowsToObjects_(sheet);
  if (filters) {
    const keys = Object.keys(filters);
    rows = rows.filter(function (r) {
      return keys.every(function (k) { return r[k] === filters[k]; });
    });
  }
  // Strip internal bookkeeping field before returning to callers.
  return rows.map(function (r) {
    const copy = Object.assign({}, r);
    delete copy.__rowIndex;
    return copy;
  });
}

/** Reads a single row by its PK (first column) value. Returns null if not found. */
function getRowById(sheetName, id) {
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const headers = getHeaders_(sheet);
  const pkColumn = headers[0];
  const rows = rowsToObjects_(sheet);
  const found = rows.find(function (r) { return r[pkColumn] === id; });
  if (!found) return null;
  const copy = Object.assign({}, found);
  delete copy.__rowIndex;
  return copy;
}

/**
 * Inserts a new row. Auto-generates the PK if not supplied. Runs the
 * caller-supplied validators (array of vOk_/vFail_ results, see
 * Validation.gs) before writing; rejects the whole write on first failure.
 *
 * @param {string} sheetName
 * @param {Object} data column->value map (PK optional; auto-generated)
 * @param {Array=} validationResults pre-computed validator outcomes to check
 * @return {Object} the inserted row, including generated PK
 */
function insertRow(sheetName, data, validationResults) {
  if (isWholeSheetCache_(sheetName)) {
    throw new Error(
      sheetName + ' adalah cache (lihat DATA_OWNERSHIP_MATRIX) — tidak boleh ' +
      'ditulis manual. Hanya boleh diperbarui lewat fungsi refresh terjadwal ' +
      'di Automation.gs.'
    );
  }

  const check = aggregateValidation_(validationResults || []);
  if (!check.valid) {
    throw new Error('Validasi gagal: ' + check.message);
  }

  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const headers = getHeaders_(sheet);
  const pkColumn = headers[0];

  const payload = Object.assign({}, data);
  if (!payload[pkColumn]) {
    payload[pkColumn] = generatePrefixedId(sheetName);
  }

  const rowArray = objectToRow_(headers, payload);
  sheet.appendRow(rowArray);

  const user = getCurrentUser();
  writeAuditLog_('INSERT', sheetName, payload[pkColumn], user ? user.email : 'system', payload);

  return payload;
}

/**
 * Updates an existing row identified by PK. Protects cache columns and runs
 * validators the same way insertRow does.
 *
 * @param {string} sheetName
 * @param {string} id PK value of the row to update
 * @param {Object} data partial column->value map of changes
 * @param {Array=} validationResults
 */
function updateRow(sheetName, id, data, validationResults) {
  const wholeSheetCache = isWholeSheetCache_(sheetName);
  const protectedCols = getProtectedColumns_(sheetName);

  if (wholeSheetCache) {
    throw new Error(
      sheetName + ' adalah cache (lihat DATA_OWNERSHIP_MATRIX) — tidak boleh ' +
      'ditulis manual.'
    );
  }

  const touchedProtected = protectedCols.filter(function (col) {
    return Object.prototype.hasOwnProperty.call(data, col);
  });
  if (touchedProtected.length > 0) {
    throw new Error(
      'Kolom ' + touchedProtected.join(', ') + ' di ' + sheetName +
      ' adalah nilai turunan (partial cache) — hanya boleh berubah lewat ' +
      'transaksi sumbernya, bukan diedit langsung. Lihat PARTIAL_CACHE_COLUMNS.'
    );
  }

  const check = aggregateValidation_(validationResults || []);
  if (!check.valid) {
    throw new Error('Validasi gagal: ' + check.message);
  }

  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  const headers = getHeaders_(sheet);
  const pkColumn = headers[0];
  const rows = rowsToObjects_(sheet);
  const target = rows.find(function (r) { return r[pkColumn] === id; });

  if (!target) {
    throw new Error('Baris dengan ' + pkColumn + '=' + id + ' tidak ditemukan di ' + sheetName + '.');
  }

  const merged = Object.assign({}, target, data);
  delete merged.__rowIndex;
  const rowArray = objectToRow_(headers, merged);
  sheet.getRange(target.__rowIndex, 1, 1, headers.length).setValues([rowArray]);

  const user = getCurrentUser();
  writeAuditLog_('UPDATE', sheetName, id, user ? user.email : 'system', data);

  return merged;
}

/**
 * Client-facing wrappers. Every one requires a `modul` argument so the
 * caller's role is checked against MASTER_HAK_AKSES before touching data —
 * no client-side call reaches getRows/insertRow/updateRow without going
 * through requireAccess() first.
 */
function clientGetRows(modul, sheetName, filters) {
  try {
    requireAccess(modul, 'Read');
    return successResponse_(getRows(sheetName, filters));
  } catch (err) {
    return errorResponse_(err.message);
  }
}

function clientInsertRow(modul, sheetName, data, validationResults) {
  try {
    requireAccess(modul, 'Write');
    return successResponse_(insertRow(sheetName, data, validationResults));
  } catch (err) {
    return errorResponse_(err.message);
  }
}

function clientUpdateRow(modul, sheetName, id, data, validationResults) {
  try {
    requireAccess(modul, 'Write');
    return successResponse_(updateRow(sheetName, id, data, validationResults));
  } catch (err) {
    return errorResponse_(err.message);
  }
}
