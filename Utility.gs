/**
 * Utility.gs
 * ----------------------------------------------------------------------------
 * Shared helpers with no business meaning of their own: ID generation,
 * header/row <-> object mapping, logging. Every other .gs file should reuse
 * these rather than re-implementing sheet plumbing.
 * ----------------------------------------------------------------------------
 */

/**
 * Reads the header row of a sheet and returns it as an array, in column
 * order. Every Database.gs function uses this instead of hardcoding column
 * positions, because column order/names must always be verified against the
 * live workbook, never assumed from memory.
 */
function getHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

/** Converts a sheet's data rows into an array of plain objects keyed by header. */
function rowsToObjects_(sheet) {
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row, idx) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    obj.__rowIndex = idx + 2; // 1-based sheet row, for internal use only
    return obj;
  });
}

/** Converts a plain object into a row array matching the given header order. */
function objectToRow_(headers, obj) {
  return headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : '';
  });
}

/**
 * Generates the next prefixed ID for a sheet (e.g. MASTER_SANTRI -> STR0016),
 * by reading the prefix convention from 00_DATA_DICTIONARY's description
 * text for that sheet's PK column, and the current max numeric suffix
 * already in use. This avoids hardcoding "STR" / "ICL" / etc. per sheet in
 * application code — the dictionary is the single source for prefixes,
 * consistent with §13 Naming Standards.
 *
 * @param {string} sheetName
 * @return {string} newly generated ID, not yet written to the sheet.
 */
function generatePrefixedId(sheetName) {
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);

  const headers = getHeaders_(sheet);
  const pkColumn = headers[0]; // §13 convention: PK is always the first column
  const existingRows = rowsToObjects_(sheet);

  // Determine prefix from existing data (most reliable — avoids re-parsing
  // free-text dictionary descriptions). Falls back to dictionary lookup only
  // if the sheet is still empty (should not happen post-seed, but handled).
  let prefix = null;
  let maxSuffix = 0;
  let suffixLength = 4;

  existingRows.forEach(function (row) {
    const val = String(row[pkColumn] || '');
    const match = val.match(/^([A-Za-z_]+?)(\d+)$/);
    if (match) {
      const p = match[1];
      const numStr = match[2];
      const num = parseInt(numStr, 10);
      if (prefix === null) {
        prefix = p;
        suffixLength = numStr.length;
      }
      if (p === prefix && num > maxSuffix) {
        maxSuffix = num;
        suffixLength = numStr.length;
      }
    }
  });

  if (prefix === null) {
    // Sheet has no seed rows yet — look up the prefix from the data dictionary
    // description as documented convention, e.g. "prefix BDG + nomor urut".
    prefix = lookupPrefixFromDictionary_(sheetName, pkColumn);
    if (!prefix) {
      throw new Error(
        'Tidak bisa menentukan prefix ID untuk ' + sheetName +
        ' — sheet kosong dan deskripsi dictionary tidak eksplisit. ' +
        'Laporkan ke pemilik proyek, jangan menebak prefix.'
      );
    }
  }

  const nextNum = maxSuffix + 1;
  const paddedNum = String(nextNum).padStart(suffixLength, '0');
  return prefix + paddedNum;
}

/** Best-effort prefix extraction from 00_DATA_DICTIONARY description text. */
function lookupPrefixFromDictionary_(sheetName, pkColumn) {
  const ss = getCoreSpreadsheet_();
  const dict = ss.getSheetByName(SHEETS.DATA_DICTIONARY);
  if (!dict) return null;
  const rows = rowsToObjects_(dict);
  const match = rows.find(function (r) {
    return r['Nama Sheet'] === sheetName && r['Nama Kolom'] === pkColumn;
  });
  if (!match) return null;
  const desc = String(match['Deskripsi'] || '');
  const m = desc.match(/prefix\s+([A-Za-z_]+)/i);
  return m ? m[1] : null;
}

/**
 * Writes a structured audit line to a hidden/append-only log sheet. Used by
 * Database.gs on every insert/update so "siapa-ubah-apa-kapan" is captured
 * without every feature reinventing logging (see SECURITY / AUDIT TRAIL
 * requirements).
 */
function writeAuditLog_(action, sheetName, rowId, userEmail, details) {
  const ss = getCoreSpreadsheet_();
  let logSheet = ss.getSheetByName('_AUDIT_LOG');
  if (!logSheet) {
    logSheet = ss.insertSheet('_AUDIT_LOG');
    logSheet.appendRow(['timestamp', 'action', 'sheet', 'row_id', 'user_email', 'details']);
  }
  logSheet.appendRow([
    new Date(),
    action,
    sheetName,
    rowId,
    userEmail,
    JSON.stringify(details || {})
  ]);
}

/** Standard error shape returned to the client so UI can branch consistently. */
function errorResponse_(message) {
  return { ok: false, error: message };
}

function successResponse_(data) {
  return { ok: true, data: data };
}
