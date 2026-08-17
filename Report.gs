/**
 * Report.gs
 * ----------------------------------------------------------------------------
 * PDF Engine (Architecture Master §12). Generates SURAT_PERINGATAN as a PDF,
 * allocating from NOMOR_SURAT's shared sequence — the number MUST be
 * allocated before the document is considered final (Handbook Vol 6,
 * NOMOR_SURAT §25 Best Practice).
 *
 * *** SCHEMA GAP UPDATE — RESOLVED CHG009 ***
 * The two gaps flagged after Tahap 2 review are now resolved by owner
 * decision, logged in CHANGELOG as CHG009:
 *   1. MASTER_SDM gained SDM020 (jabatan 'Mudir') — Automation.gs's soft-
 *      warning override for the "no Mudir exists" case has been removed;
 *      jabatan-matching now works through the normal path for every jenjang.
 *   2. SURAT_PERINGATAN gained an `id_file` column — generateSuratPeringatanPdf_
 *      now writes the Drive URL back onto the record via updateRow(), so the
 *      link survives a browser refresh instead of only living in the
 *      immediate UI response.
 * Still true (not part of this fix, still worth knowing): TEMPLATE_SURAT has
 * no column for the letter body itself, so `renderSuratPeringatanBody_`
 * below remains an in-code layout rather than something read from the
 * sheet. Not asked to resolve this one — flagging again only for completeness.
 * ----------------------------------------------------------------------------
 */

const SEKRETARIAT_MODULE = 'DAIMS_SEKRETARIAT';

/**
 * Allocates the next nomor_surat for a given arah_surat, following the
 * shared-sequence design (§12, one counter for SURAT_KELUAR/KETERANGAN/
 * KEPUTUSAN — SP reuses the same 'Keluar' direction since it's an outgoing
 * official letter). Format mirrors the seed example: 'NNN/DA/BULAN-ROMAWI/TAHUN'.
 */
function allocateNomorSurat(idReferensiDokumen) {
  const ss = getCoreSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.NOMOR_SURAT);
  const rows = rowsToObjects_(sheet);

  const now = new Date();
  const romanMonths = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const year = now.getFullYear();

  const usedThisYear = rows.filter(function (r) {
    return String(r.nomor_surat || '').indexOf('/' + year) !== -1;
  });
  const nextSeq = usedThisYear.length + 1;
  const nomorSurat = String(nextSeq).padStart(3, '0') + '/DA/' + romanMonths[now.getMonth()] + '/' + year;

  return insertRow(SHEETS.NOMOR_SURAT, {
    nomor_surat: nomorSurat,
    arah_surat: 'Keluar',
    tanggal_pakai: now,
    status: 'Dipakai',
    id_referensi_dokumen: idReferensiDokumen
  });
}

/** In-code letter body per jenis_dokumen — see schema-gap note above. */
function renderSuratPeringatanBody_(sp, santri, penerbit, incident, masterIncident, nomorSurat) {
  const tingkatText = { '1': 'PERTAMA', '2': 'KEDUA', '3': 'KETIGA' }[String(sp.tingkat_sp)] || sp.tingkat_sp;
  return [
    'PONDOK PESANTREN DARUL ARIFIN',
    'SURAT PERINGATAN ' + tingkatText,
    'Nomor: ' + nomorSurat,
    '',
    'Yang bertanda tangan di bawah ini menyatakan bahwa santri:',
    'Nama    : ' + (santri ? santri.nama_lengkap : sp.id_santri),
    'ID      : ' + sp.id_santri,
    '',
    'Diberikan Surat Peringatan ' + tingkatText + ' atas pelanggaran:',
    (masterIncident ? masterIncident.nama_incident : '-') + ' (kategori ' + (masterIncident ? masterIncident.kategori : '-') + ')',
    'Referensi kejadian: ' + sp.id_incident_log,
    'Alasan: ' + sp.alasan,
    '',
    'Diterbitkan pada: ' + Utilities.formatDate(new Date(sp.tanggal_terbit), DAIMS_CONFIG.TIMEZONE, 'dd MMMM yyyy'),
    '',
    'Diterbitkan oleh,',
    (penerbit ? penerbit.nama_lengkap : sp.id_sdm_penerbit),
    (penerbit ? penerbit.jabatan : '')
  ].join('\n');
}

/**
 * Validates + inserts a SURAT_PERINGATAN row + generates its PDF as ONE
 * atomic server-side operation. This exists because splitting "insert the
 * row" and "generate the PDF" into two separate client round-trips (an
 * earlier draft of the client code did this) allows an invalid SP — bad
 * id_incident_log, or an incident not yet 'Berlaku' — to be PERSISTED
 * before the validation that should have blocked it ever runs. Caught
 * during review; fixed by validating BEFORE insertRow, not after.
 */
function createAndIssueSuratPeringatan(idSantri, idIncidentLog, tingkatSp, alasan) {
  const user = requireAccess(PENGASUHAN_MODULE, 'Write');

  const santriCheck = validateFKExists(SHEETS.MASTER_SANTRI, idSantri);
  if (!santriCheck.valid) throw new Error(santriCheck.message);

  const incidentCheck = validateFKExists(SHEETS.INCIDENT_LOG, idIncidentLog);
  if (!incidentCheck.valid) throw new Error(incidentCheck.message);

  const incident = getRowById(SHEETS.INCIDENT_LOG, idIncidentLog);
  if (String(incident.status_final).indexOf('Berlaku') !== 0) {
    throw new Error(
      'INCIDENT_LOG ' + idIncidentLog + ' berstatus "' + incident.status_final +
      '" — SP hanya boleh diterbitkan atas incident yang sudah Berlaku (lolos verifikasi/approval).'
    );
  }

  const sp = insertRow(SHEETS.SURAT_PERINGATAN, {
    id_santri: idSantri,
    tingkat_sp: String(tingkatSp),
    tanggal_terbit: new Date(),
    id_incident_log: idIncidentLog,
    alasan: alasan,
    id_sdm_penerbit: user.id_sdm,
    id_template: 'TPL004' // TEMPLATE_SURAT seed row for "Surat Peringatan (SP) Santri"
  });

  return generateSuratPeringatanPdf_(sp);
}

/**
 * Generates the PDF for an ALREADY-VALIDATED SURAT_PERINGATAN row. Internal
 * (underscore) — only createAndIssueSuratPeringatan calls this, so the
 * validate-then-insert-then-generate ordering can never be bypassed by a
 * caller invoking PDF generation on its own with an unvalidated row.
 */
function generateSuratPeringatanPdf_(sp) {
  const incident = getRowById(SHEETS.INCIDENT_LOG, sp.id_incident_log);
  const santri = getRowById(SHEETS.MASTER_SANTRI, sp.id_santri);
  const penerbit = getRowById(SHEETS.MASTER_SDM, sp.id_sdm_penerbit);
  const masterIncident = getRowById(SHEETS.MASTER_INCIDENT, incident.id_master_incident);

  const nomorSuratRow = allocateNomorSurat(sp.id_surat_peringatan);

  const body = renderSuratPeringatanBody_(sp, santri, penerbit, incident, masterIncident, nomorSuratRow.nomor_surat);

  // Docs -> PDF -> Drive mechanics delegated to the library (Tahap 4) — this
  // part had zero DAIMS-specific knowledge to begin with (see PdfEngine.gs).
  const fileName = 'SP_' + sp.id_surat_peringatan + '_' + sp.id_santri;
  const pdfResult = DaimsLib.Pdf.generateFromText(body, fileName, 'DAIMS_Generated_Documents', 'SURAT_PERINGATAN');

  pushNotification(
    PENGASUHAN_MODULE, sp.id_santri,
    'Surat Peringatan Diterbitkan',
    'SP ' + nomorSuratRow.nomor_surat + ' diterbitkan untuk ' + (santri ? santri.nama_lengkap : sp.id_santri),
    'In-App'
  );

  // CHG009: persist the link back onto the record itself (previously
  // impossible — no id_file column existed until this change). Still goes
  // through the host's audited updateRow(), not a library write function.
  updateRow(SHEETS.SURAT_PERINGATAN, sp.id_surat_peringatan, { id_file: pdfResult.pdfUrl });

  return {
    nomorSurat: nomorSuratRow.nomor_surat,
    pdfUrl: pdfResult.pdfUrl,
    pdfFileId: pdfResult.pdfFileId,
    persistedOnRecord: true
  };
}

/** Client-facing wrapper — single round trip: validate, insert, generate. */
function clientCreateAndIssueSuratPeringatan(idSantri, idIncidentLog, tingkatSp, alasan) {
  try {
    return successResponse_(createAndIssueSuratPeringatan(idSantri, idIncidentLog, tingkatSp, alasan));
  } catch (err) {
    return errorResponse_(err.message);
  }
}
