/**
 * Validation.gs
 * ----------------------------------------------------------------------------
 * Generic, reusable validators implementing the recurring rule categories
 * documented in Handbook Vol 7 §10.1 ("Kategori Aturan Data Quality yang
 * Berulang"). Forms/modules call these instead of writing bespoke checks
 * per sheet, so a rule fixed once is fixed everywhere.
 *
 * Every function returns { valid: boolean, message: string|null } — never
 * throws directly, so Database.gs can aggregate multiple validator results
 * before deciding whether to write.
 * ----------------------------------------------------------------------------
 */

function vOk_() { return { valid: true, message: null }; }
function vFail_(msg) { return { valid: false, message: msg }; }

/**
 * Rentang Tanggal Valid — e.g. tanggal_selesai must be after tanggal_mulai.
 * (Handbook §10.1: PERIZINAN, CUTI_SDM, KONTRAK_KERJA, TRANSAKSI_LAUNDRY)
 */
function validateDateRange(startDate, endDate, opts) {
  opts = opts || {};
  if (!startDate || !endDate) return vOk_(); // presence is a separate concern
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start) || isNaN(end)) return vFail_('Format tanggal tidak valid.');
  if (opts.allowEqual ? end < start : end <= start) {
    return vFail_('Tanggal selesai harus setelah tanggal mulai.');
  }
  return vOk_();
}

/**
 * Status Konsisten dengan Ambang — e.g. STOK_OBAT.status_stok must match
 * jumlah_tersedia vs ambang_minimum (Handbook §10.1, ADR-012).
 */
function validateStockStatusConsistency(jumlahTersedia, ambangMinimum, statusStok) {
  const qty = Number(jumlahTersedia);
  const min = Number(ambangMinimum);
  if (isNaN(qty) || isNaN(min)) return vFail_('jumlah_tersedia/ambang_minimum harus angka.');

  let expected;
  if (qty <= 0) expected = 'Habis';
  else if (qty < min) expected = 'Menipis';
  else expected = 'Normal';

  if (statusStok !== expected) {
    return vFail_(
      'status_stok "' + statusStok + '" tidak konsisten dengan jumlah (' +
      qty + ' vs ambang ' + min + '). Seharusnya: ' + expected + '.'
    );
  }
  return vOk_();
}

/**
 * FK Wajib Terverifikasi — checks a value exists as a PK in the target
 * sheet before allowing a dependent write (Handbook §10.1: id_incident_log
 * wajib valid sebelum SP terbit; id_orang_tua_diberitahu wajib terisi).
 */
function validateFKExists(sheetName, idValue) {
  if (!idValue || idValue === '-') return vFail_('Referensi wajib diisi (tidak boleh kosong/"-").');
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return vFail_('Sheet referensi tidak ditemukan: ' + sheetName);
  const headers = getHeaders_(sheet);
  const pkColumn = headers[0];
  const rows = rowsToObjects_(sheet);
  const found = rows.some(function (r) { return r[pkColumn] === idValue; });
  if (!found) {
    return vFail_(idValue + ' tidak ditemukan di ' + sheetName + '.' + pkColumn + '.');
  }
  return vOk_();
}

/**
 * Satu Baris Aktif per Entitas — e.g. only one ASET_PENGGUNA / KONTRAK_KERJA
 * row may be status=Aktif for the same entity key at a time.
 *
 * @param {string} sheetName
 * @param {Object} keyFilter e.g. { id_aset: 'AST0002' }
 * @param {string} statusColumn e.g. 'status'
 * @param {string} activeValue e.g. 'Aktif'
 * @param {string=} excludeRowId row PK to exclude (when editing an existing
 *   active row rather than inserting a new one)
 */
function validateSingleActive(sheetName, keyFilter, statusColumn, activeValue, excludeRowId) {
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return vFail_('Sheet tidak ditemukan: ' + sheetName);
  const headers = getHeaders_(sheet);
  const pkColumn = headers[0];
  const rows = rowsToObjects_(sheet);

  const keyFields = Object.keys(keyFilter);
  const conflict = rows.find(function (r) {
    if (excludeRowId && r[pkColumn] === excludeRowId) return false;
    const keyMatches = keyFields.every(function (k) { return r[k] === keyFilter[k]; });
    return keyMatches && r[statusColumn] === activeValue;
  });

  if (conflict) {
    return vFail_(
      'Sudah ada baris berstatus "' + activeValue + '" untuk kombinasi ' +
      JSON.stringify(keyFilter) + ' di ' + sheetName + ' (' + conflict[pkColumn] + ').'
    );
  }
  return vOk_();
}

/**
 * Unik per Kombinasi Kunci — e.g. TAGIHAN_SPP unique per (id_santri,
 * periode_bulan); KEHADIRAN_KELAS unique per (id_santri, id_kelas, tanggal).
 */
function validateUniqueCombo(sheetName, keyFields, values, excludeRowId) {
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return vFail_('Sheet tidak ditemukan: ' + sheetName);
  const headers = getHeaders_(sheet);
  const pkColumn = headers[0];
  const rows = rowsToObjects_(sheet);

  const conflict = rows.find(function (r) {
    if (excludeRowId && r[pkColumn] === excludeRowId) return false;
    return keyFields.every(function (k) { return String(r[k]) === String(values[k]); });
  });

  if (conflict) {
    return vFail_(
      'Kombinasi ' + keyFields.join('+') + ' sudah ada di ' + sheetName +
      ' (' + conflict[pkColumn] + '). Duplikasi tidak diperbolehkan.'
    );
  }
  return vOk_();
}

/**
 * Enum validity against MASTER_LOOKUP grup+nilai (Handbook §13 Naming
 * Standards: lookup values are data, not hardcoded per sheet).
 */
function validateLookupValue(grup, nilai) {
  const ss = getCoreSpreadsheet_();
  const lookupSheet = ss.getSheetByName(SHEETS.MASTER_LOOKUP);
  const rows = rowsToObjects_(lookupSheet);
  const found = rows.some(function (r) { return r.grup === grup && r.nilai === nilai; });
  if (!found) {
    return vFail_('Nilai "' + nilai + '" tidak terdaftar di MASTER_LOOKUP grup "' + grup + '".');
  }
  return vOk_();
}

/**
 * Runs a list of validator results and aggregates into one outcome. Use
 * this from Database.gs / Automation.gs so a write is rejected on the
 * FIRST failure encountered but the caller still gets one coherent object.
 */
function aggregateValidation_(results) {
  const failure = results.find(function (r) { return r && r.valid === false; });
  return failure || vOk_();
}
