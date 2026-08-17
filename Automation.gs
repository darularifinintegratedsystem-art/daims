/**
 * Automation.gs
 * ----------------------------------------------------------------------------
 * Workflow Engine implementation (Architecture Master §12) for Tahap 2 scope
 * (DAIMS_PENGASUHAN). Two DISTINCT approval patterns are implemented here,
 * per Handbook Vol 7 §7.1/§7.3 — they must NOT be merged into one generic
 * flow:
 *
 *   1. INCIDENT approval (ADR-016): jenjang count and approver role per
 *      jenjang come from MASTER_INCIDENT.approver_role_sequence, which is
 *      DIFFERENT per incident type. Verified format from live seed data:
 *        - '->' separates SEQUENTIAL jenjang, e.g.
 *          'Koordinator Musyrif->Wadir Pengasuhan->Mudir' (INC008, 3 jenjang)
 *        - '/' inside one jenjang token means ANY of these roles may approve
 *          that step, e.g. 'Musyrif/Koordinator Olahraga' (INC013, 1 jenjang)
 *        - '-' means no approval needed at all.
 *
 *   2. PERIZINAN approval: single jenjang, Diajukan -> Disetujui/Ditolak by
 *      one Musyrif. Generic, not rule-driven.
 *
 * KNOWN DATA GAP — RESOLVED (CHG009). MASTER_SDM previously had zero rows
 * with jabatan = 'Mudir', which forced jabatan-matching to degrade to a
 * soft warning for that one jenjang. The project owner added SDM020
 * (jabatan 'Mudir') after Tahap 2 review — the soft-warning override has
 * been removed below; every jenjang, including Mudir-level ones, now goes
 * through the same hard-match path.
 * ----------------------------------------------------------------------------
 */

const PENGASUHAN_MODULE = 'DAIMS_PENGASUHAN';
const STUDENT_ENGINE_MODULE = 'DAIMS_STUDENT_ENGINE';
// All DAIMS_* module identifiers consolidated here, declared BEFORE
// HANGING_STATUS_RULES (further down this file) uses them. This is a fix,
// not just tidying: an earlier version had KEUANGAN_MODULE/SDM_MODULE
// declared later in the file (each in its own Tahap's section) while
// HANGING_STATUS_RULES referenced them — a `const` temporal-dead-zone
// violation that throws ReferenceError at script-load time, which would
// have broken this entire file (and therefore the whole app) from Tahap 3
// onward. Caught while adding the SDM module; fixed by consolidating every
// module constant up here, once, so this class of ordering bug can't recur
// as more modules are added.
const AKADEMIK_MODULE = 'DAIMS_AKADEMIK';
const KEUANGAN_MODULE = 'DAIMS_KEUANGAN';
const SDM_MODULE = 'DAIMS_SDM';

/** Splits an approver_role_sequence string into ordered jenjang steps.
 *  Delegates to the extracted library (Tahap 4) — DaimsLib.Workflow.parseSequence
 *  is a pure function with no DAIMS-specific knowledge; only the fact that
 *  we're reading it from MASTER_INCIDENT.approver_role_sequence is host-specific. */
function parseApproverSequence_(sequence) {
  return DaimsLib.Workflow.parseSequence(sequence);
}

/**
 * Loose jabatan match against a role token. Handles the Musyrif/Musyrifah
 * gender-variant pattern observed in MASTER_SDM — this alias vocabulary is
 * DAIMS-specific, so it's supplied here as config to the library's generic
 * roleMatches(), not hardcoded inside the library itself.
 */
const JABATAN_ALIASES_ = { musyrif: ['musyrif', 'musyrifah'] };
function jabatanMatchesToken_(jabatan, token) {
  return DaimsLib.Workflow.roleMatches(jabatan, token, JABATAN_ALIASES_);
}

/**
 * Computes the next required approval step for an INCIDENT_LOG row.
 * @return {Object|null} { jenjangNumber, allowedJabatan: string[], isFinal }
 *   or null if the incident needs no approval / is already fully approved.
 */
function getNextIncidentApprovalStep(idIncidentLog) {
  const incident = getRowById(SHEETS.INCIDENT_LOG, idIncidentLog);
  if (!incident) throw new Error('INCIDENT_LOG ' + idIncidentLog + ' tidak ditemukan.');

  const masterIncident = getRowById(SHEETS.MASTER_INCIDENT, incident.id_master_incident);
  if (!masterIncident) throw new Error('MASTER_INCIDENT ' + incident.id_master_incident + ' tidak ditemukan.');

  if (masterIncident.perlu_approval !== 'Ya') return null;

  const steps = parseApproverSequence_(masterIncident.approver_role_sequence);
  if (steps.length === 0) return null;

  const existingApprovals = getRows(SHEETS.INCIDENT_APPROVAL_LOG, { id_incident_log: idIncidentLog });
  const approvedCount = existingApprovals.filter(function (a) { return a.keputusan === 'Setuju'; }).length;

  // Delegates the pure "which jenjang is next" computation to the library
  // (Tahap 4); reshapes its generic {allowedRoles} into this function's
  // existing {allowedJabatan} field name so callers elsewhere don't need
  // to change.
  const next = DaimsLib.Workflow.getNextStep(steps, approvedCount);
  if (!next) return null;
  return {
    jenjangNumber: next.jenjangNumber,
    allowedJabatan: next.allowedRoles,
    isFinal: next.isFinal
  };
}

/**
 * Records one approval-chain decision. Enforces: (a) jenjang must be the
 * NEXT expected one (no skipping, per Handbook Vol 3 §16), (b) approver's
 * jabatan should match the expected role for that jenjang — soft warning
 * (not hard block) for the documented 'Mudir' gap only.
 */
function submitIncidentApproval(idIncidentLog, keputusan, catatan) {
  const user = requireAccess(STUDENT_ENGINE_MODULE, 'Approve');

  const step = getNextIncidentApprovalStep(idIncidentLog);
  if (!step) {
    throw new Error('Incident ini tidak butuh approval lagi, atau sudah selesai seluruh jenjang.');
  }

  const sdm = getRowById(SHEETS.MASTER_SDM, user.id_sdm);
  const matchesExpected = step.allowedJabatan.some(function (role) {
    return jabatanMatchesToken_(sdm ? sdm.jabatan : null, role);
  });

  if (!matchesExpected) {
    throw new Error(
      'Jabatan approver (' + (sdm ? sdm.jabatan : '-') + ') tidak sesuai jenjang ' +
      step.jenjangNumber + ' yang membutuhkan: ' + step.allowedJabatan.join(' atau ') + '.'
    );
  }

  const incident = getRowById(SHEETS.INCIDENT_LOG, idIncidentLog);

  const approvalRow = insertRow(SHEETS.INCIDENT_APPROVAL_LOG, {
    id_incident_log: idIncidentLog,
    jenjang: String(step.jenjangNumber),
    id_bidang_approver: user.id_bidang || '-',
    id_sdm_approver: user.id_sdm,
    tanggal_approval: new Date(),
    keputusan: keputusan, // 'Setuju' | 'Revisi' | 'Tolak'
    catatan: catatan || ''
  });

  // Revisi/Tolak halts the chain — status_final reflects that immediately.
  if (keputusan === 'Tolak') {
    updateRow(SHEETS.INCIDENT_LOG, idIncidentLog, { status_final: 'Dibatalkan' });
    pushNotification(
      PENGASUHAN_MODULE, incident.id_sdm_pelapor,
      'Incident Ditolak', 'Incident ' + idIncidentLog + ' ditolak pada jenjang ' + step.jenjangNumber + '.',
      'In-App'
    );
    return { approval: approvalRow, chainComplete: false, rejected: true };
  }

  if (keputusan === 'Setuju' && step.isFinal) {
    updateRow(SHEETS.INCIDENT_LOG, idIncidentLog, { status_final: 'Berlaku (Approval Berjenjang)' });
    triggerScoreRule('Incident', incident.id_master_incident, incident.id_santri, idIncidentLog);
    return { approval: approvalRow, chainComplete: true, rejected: false };
  }

  return { approval: approvalRow, chainComplete: false, rejected: false };
}

/**
 * Producer/consumer entry point (ADR-014): ANY module may write a new
 * INCIDENT_LOG row (Musyrif, Wali Kelas, etc — checked by caller's own
 * module access, not restricted to Pengasuhan). status_verifikasi is
 * derived from MASTER_INCIDENT.perlu_verifikasi automatically, never left
 * for the UI to guess.
 */
function logIncident(idSantri, idMasterIncident, tanggalKejadian, deskripsi) {
  const user = requireAccess(STUDENT_ENGINE_MODULE, 'Write');
  const masterIncident = getRowById(SHEETS.MASTER_INCIDENT, idMasterIncident);
  if (!masterIncident) throw new Error('Jenis incident tidak ditemukan: ' + idMasterIncident);

  const statusVerifikasi = masterIncident.perlu_verifikasi === 'Ya' ? 'Menunggu Verifikasi' : 'Tidak Perlu';
  // Only "Tidak Perlu" incidents (no verification, no approval) are Berlaku
  // immediately; everything else waits for its gate to clear.
  const statusFinal = (statusVerifikasi === 'Tidak Perlu' && masterIncident.perlu_approval !== 'Ya')
    ? 'Berlaku'
    : 'Menunggu Verifikasi';

  const row = insertRow(SHEETS.INCIDENT_LOG, {
    id_santri: idSantri,
    id_master_incident: idMasterIncident,
    tanggal_kejadian: tanggalKejadian,
    id_sdm_pelapor: user.id_sdm,
    deskripsi: deskripsi,
    status_verifikasi: statusVerifikasi,
    id_verifikator: '-',
    tanggal_verifikasi: '-',
    status_final: statusFinal
  }, [
    validateFKExists(SHEETS.MASTER_SANTRI, idSantri)
  ]);

  if (statusFinal === 'Berlaku' && masterIncident.perlu_approval !== 'Ya') {
    triggerScoreRule('Incident', idMasterIncident, idSantri, row.id_incident_log);
  }

  return row;
}

/** Verifies an incident (Koordinator step before approval chain, if any). */
function verifyIncident(idIncidentLog) {
  const user = requireAccess(STUDENT_ENGINE_MODULE, 'Approve');
  const incident = getRowById(SHEETS.INCIDENT_LOG, idIncidentLog);
  if (!incident) throw new Error('INCIDENT_LOG tidak ditemukan: ' + idIncidentLog);
  if (incident.status_verifikasi !== 'Menunggu Verifikasi') {
    throw new Error('Incident ini tidak dalam status Menunggu Verifikasi.');
  }

  const masterIncident = getRowById(SHEETS.MASTER_INCIDENT, incident.id_master_incident);
  const needsApproval = masterIncident.perlu_approval === 'Ya';

  return updateRow(SHEETS.INCIDENT_LOG, idIncidentLog, {
    status_verifikasi: 'Terverifikasi',
    id_verifikator: user.id_sdm,
    tanggal_verifikasi: new Date(),
    status_final: needsApproval ? 'Berlaku (Approval Berjenjang)' : 'Berlaku'
  });
}

/**
 * Rule Engine execution (ADR-017): reads MASTER_SCORE_RULE for the given
 * sumber_event + id_referensi_event, writes SCORE_TRANSACTION. This is the
 * ONLY function allowed to write SCORE_TRANSACTION — no UI form ever
 * inserts into it directly (ledger is system-generated only, per Handbook
 * Vol 3 §15/§25).
 */
function triggerScoreRule(sumberEvent, idReferensiEvent, idSantri, idReferensiSumber) {
  const rules = getRows(SHEETS.MASTER_SCORE_RULE, {
    sumber_event: sumberEvent,
    id_referensi_event: idReferensiEvent
  });

  if (rules.length === 0) {
    // Not every event type has a scored rule (e.g. Ringan incidents with no
    // MASTER_SCORE_RULE row) — this is valid, not an error.
    return [];
  }

  return rules.map(function (rule) {
    const dampak = Number(rule.formula_dampak);
    // ADR-019: XP (SCT01) may never go negative from a violation impact.
    if (rule.id_score_type === 'SCT01' && dampak < 0) {
      throw new Error('MASTER_SCORE_RULE ' + rule.id_score_rule + ' melanggar ADR-019 (XP tidak boleh negatif).');
    }
    return insertRow(SHEETS.SCORE_TRANSACTION, {
      id_santri: idSantri,
      id_score_type: rule.id_score_type,
      sumber_event: sumberEvent,
      id_referensi_sumber: idReferensiSumber,
      tanggal: new Date(),
      nilai_perubahan: dampak,
      id_score_rule: rule.id_score_rule,
      catatan: rule.deskripsi || ''
    });
  });
}

/** Submits a new PERIZINAN request (Musyrif, on behalf of a santri). */
function ajukanPerizinan(idSantri, jenisIzin, tanggalMulai, tanggalSelesai, catatan) {
  requireAccess(PENGASUHAN_MODULE, 'Write');

  return insertRow(SHEETS.PERIZINAN, {
    id_santri: idSantri,
    jenis_izin: jenisIzin,
    tanggal_mulai: tanggalMulai,
    tanggal_selesai: tanggalSelesai,
    id_sdm_penyetuju: '-', // filled in by decidePerizinan() once approved
    status: 'Diajukan',
    catatan: catatan || ''
  }, [
    validateFKExists(SHEETS.MASTER_SANTRI, idSantri),
    validateDateRange(tanggalMulai, tanggalSelesai, { allowEqual: true })
  ]);
}

/** Single-jenjang PERIZINAN approval (Musyrif). */
function decidePerizinan(idPerizinan, keputusan) {
  const user = requireAccess(PENGASUHAN_MODULE, 'Approve');
  const perizinan = getRowById(SHEETS.PERIZINAN, idPerizinan);
  if (!perizinan) throw new Error('PERIZINAN tidak ditemukan: ' + idPerizinan);

  return updateRow(SHEETS.PERIZINAN, idPerizinan, {
    status: keputusan, // 'Disetujui' | 'Ditolak'
    id_sdm_penyetuju: user.id_sdm
  }, [
    keputusan === 'Disetujui' || keputusan === 'Ditolak'
      ? { valid: true, message: null }
      : { valid: false, message: 'Keputusan harus Disetujui atau Ditolak.' }
  ]);
}

/**
 * Generic "menggantung > N hari" scan across the status categories
 * documented in Handbook Vol 7 §7.4. Tahap 2 wires this for Pengasuhan's
 * own hanging statuses; the shape is reusable for other modules later
 * without rewriting the scan logic.
 */
const HANGING_STATUS_RULES = [
  { sheet: SHEETS.PERIZINAN, modul: PENGASUHAN_MODULE, statusField: 'status', hangingValue: 'Diajukan', dateField: 'tanggal_mulai' },
  { sheet: SHEETS.INCIDENT_LOG, modul: STUDENT_ENGINE_MODULE, statusField: 'status_verifikasi', hangingValue: 'Menunggu Verifikasi', dateField: 'tanggal_kejadian' },
  { sheet: SHEETS.COUNSELING_LOG, modul: PENGASUHAN_MODULE, statusField: 'status', hangingValue: null, dateField: 'tanggal',
    isHanging: function (row) { return String(row.status).indexOf('Selesai') === -1; } },
  // Handbook Vol 7 §7.4 lists overdue SPP tagihan among status categories
  // needing active monitoring, and Vol 6 TAGIHAN_SPP §17 flags "status
  // tidak sinkron" as the direct cause of duplicate billing/dashboard drift.
  { sheet: SHEETS.TAGIHAN_SPP, modul: KEUANGAN_MODULE, statusField: 'status', hangingValue: 'Belum Lunas', dateField: 'jatuh_tempo' },
  { sheet: SHEETS.CUTI_SDM, modul: SDM_MODULE, statusField: 'status', hangingValue: 'Diajukan', dateField: 'tanggal_mulai' }
];

/**
 * @param {number} minDaysHanging
 * @param {(string|string[])=} modulFilter If given, only scans rules
 *   belonging to that module (or any module in the array) — this is how a
 *   single dashboard gets its own hanging-items widget without needing
 *   access to every other module's data. Pengasuhan's dashboard legitimately
 *   needs BOTH DAIMS_PENGASUHAN and DAIMS_STUDENT_ENGINE (ADR-014:
 *   INCIDENT_LOG is produced/consumed across domain lines by design, so its
 *   hanging items belong on the Pengasuhan dashboard too even though the
 *   sheet itself is owned by Student Engine). Omit to scan everything the
 *   caller already has read access to.
 */
function getHangingItems(minDaysHanging, modulFilter) {
  const filterList = modulFilter ? (Array.isArray(modulFilter) ? modulFilter : [modulFilter]) : null;
  const rules = filterList
    ? HANGING_STATUS_RULES.filter(function (r) { return filterList.indexOf(r.modul) !== -1; })
    : HANGING_STATUS_RULES;

  // Check access per distinct module actually touched, not one hardcoded
  // module for the whole scan.
  const distinctModules = Array.from(new Set(rules.map(function (r) { return r.modul; })));
  distinctModules.forEach(function (m) { requireAccess(m, 'Read'); });

  const now = new Date();
  const results = [];

  rules.forEach(function (rule) {
    const rows = getRows(rule.sheet);
    rows.forEach(function (row) {
      const isHanging = rule.isHanging
        ? rule.isHanging(row)
        : row[rule.statusField] === rule.hangingValue;
      if (!isHanging) return;

      const refDate = new Date(row[rule.dateField]);
      if (isNaN(refDate)) return;
      const daysHanging = Math.floor((now - refDate) / (1000 * 60 * 60 * 24));
      if (daysHanging >= minDaysHanging) {
        results.push({
          sheet: rule.sheet,
          rowId: row[Object.keys(row)[0]],
          status: row[rule.statusField],
          daysHanging: daysHanging,
          row: row
        });
      }
    });
  });

  return results.sort(function (a, b) { return b.daysHanging - a.daysHanging; });
}

// =============================================================================
// TAHAP 3 — DAIMS_AKADEMIK
// =============================================================================

/**
 * Records KEHADIRAN_KELAS. Enforces the unique-combo rule documented in
 * Handbook Vol 4 §16 ("Satu santri hanya boleh punya satu baris presensi
 * per kelas per tanggal") — reusing validateUniqueCombo from Validation.gs
 * rather than writing a bespoke check, per the reuse-first principle.
 */
function catatKehadiranKelas(idKelas, idSantri, tanggal, statusHadir) {
  const user = requireAccess(AKADEMIK_MODULE, 'Write');
  return insertRow(SHEETS.KEHADIRAN_KELAS, {
    id_kelas: idKelas,
    id_santri: idSantri,
    tanggal: tanggal,
    status_hadir: statusHadir,
    id_sdm_pencatat: user.id_sdm
  }, [
    validateFKExists(SHEETS.MASTER_KELAS, idKelas),
    validateFKExists(SHEETS.MASTER_SANTRI, idSantri),
    validateUniqueCombo(SHEETS.KEHADIRAN_KELAS, ['id_kelas', 'id_santri', 'tanggal'],
      { id_kelas: idKelas, id_santri: idSantri, tanggal: tanggal })
  ]);
}

/**
 * Records NILAI_AKADEMIK. Enforces "id_sdm_penilai harus sesuai
 * PENGAMPU_MATA_PELAJARAN yang berlaku" (Handbook Vol 4 §16) — a real
 * business rule, not just a generic FK check, so it's implemented here
 * rather than pushed into Validation.gs's generic layer.
 *
 * SCHEMA NOTE — RESOLVED (CHG010): id_tahun_ajaran was originally
 * `id_tahun_ajaran_text`, a denormalized free-text column ('2025/2026')
 * rather than a real FK to MASTER_TAHUN_AJARAN — the exact same situation
 * MASTER_SANTRI.kelas_saat_ini was in before Sprint 2.5. The project owner
 * directed the same normalization here; the column was migrated (all 10
 * seed rows verified to resolve before rewriting, per CHANGELOG CHG010) and
 * this function now validates it as a real FK like any other.
 */
function catatNilaiAkademik(idSantri, idMapel, idKelas, semester, idTahunAjaran, nilaiAkhir) {
  const user = requireAccess(AKADEMIK_MODULE, 'Write');

  const pengampuRows = getRows(SHEETS.PENGAMPU_MATA_PELAJARAN, { id_mapel: idMapel, id_kelas: idKelas });
  const isPengampu = pengampuRows.some(function (p) { return p.id_sdm_guru === user.id_sdm; });
  if (!isPengampu) {
    throw new Error(
      'Anda (' + user.id_sdm + ') tidak terdaftar sebagai pengampu ' + idMapel +
      ' untuk kelas ' + idKelas + ' di PENGAMPU_MATA_PELAJARAN — nilai tidak bisa disimpan.'
    );
  }

  const nilai = Number(nilaiAkhir);
  const nilaiRangeCheck = (nilai >= 0 && nilai <= 100)
    ? vOk_() : vFail_('nilai_akhir harus di rentang 0-100.');

  return insertRow(SHEETS.NILAI_AKADEMIK, {
    id_santri: idSantri,
    id_mapel: idMapel,
    id_kelas: idKelas,
    semester: semester,
    id_tahun_ajaran: idTahunAjaran,
    nilai_akhir: String(nilai),
    id_sdm_penilai: user.id_sdm
  }, [
    validateFKExists(SHEETS.MASTER_SANTRI, idSantri),
    validateFKExists(SHEETS.MASTER_MATA_PELAJARAN, idMapel),
    validateFKExists(SHEETS.MASTER_KELAS, idKelas),
    validateFKExists(SHEETS.MASTER_TAHUN_AJARAN, idTahunAjaran),
    nilaiRangeCheck,
    validateUniqueCombo(SHEETS.NILAI_AKADEMIK, ['id_santri', 'id_mapel', 'semester', 'id_tahun_ajaran'],
      { id_santri: idSantri, id_mapel: idMapel, semester: semester, id_tahun_ajaran: idTahunAjaran })
  ]);
}

function clientCatatKehadiranKelas(idKelas, idSantri, tanggal, statusHadir) {
  try { return successResponse_(catatKehadiranKelas(idKelas, idSantri, tanggal, statusHadir)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientCatatNilaiAkademik(idSantri, idMapel, idKelas, semester, tahunAjaranText, nilaiAkhir) {
  try { return successResponse_(catatNilaiAkademik(idSantri, idMapel, idKelas, semester, tahunAjaranText, nilaiAkhir)); }
  catch (err) { return errorResponse_(err.message); }
}

// =============================================================================
// TAHAP 3 — DAIMS_KEUANGAN (SPP)
// =============================================================================

/**
 * Bulk-generates TAGIHAN_SPP for the given periode_bulan, one row per
 * currently-active MASTER_SANTRI not already billed that period. Mirrors
 * the documented process ("Sistem/Administrasi Keuangan menerbitkan
 * tagihan tiap awal bulan untuk seluruh santri aktif", Handbook Vol 6).
 * Skips (does not error on) santri who already have a row for this period
 * — reuses validateUniqueCombo's underlying check as a filter rather than
 * failing the whole batch over one pre-existing row.
 */
function generateTagihanSppBulanan(periodeBulan, nominalTagihan, jatuhTempo) {
  requireAccess(KEUANGAN_MODULE, 'Write');

  const activeSantri = getRows(SHEETS.MASTER_SANTRI, { status_aktif: 'Aktif' });
  const existingTagihan = getRows(SHEETS.TAGIHAN_SPP, { periode_bulan: periodeBulan });
  const alreadyBilled = new Set(existingTagihan.map(function (t) { return t.id_santri; }));

  const created = [];
  const skipped = [];

  activeSantri.forEach(function (santri) {
    if (alreadyBilled.has(santri.id_santri)) {
      skipped.push(santri.id_santri);
      return;
    }
    created.push(insertRow(SHEETS.TAGIHAN_SPP, {
      id_santri: santri.id_santri,
      periode_bulan: periodeBulan,
      nominal_tagihan: String(nominalTagihan),
      jatuh_tempo: jatuhTempo,
      status: 'Belum Lunas'
    }));
  });

  return { createdCount: created.length, skippedCount: skipped.length, created: created };
}

/**
 * Records a PEMBAYARAN_SPP AND updates the parent TAGIHAN_SPP.status to
 * Lunas in one atomic server call. This is the exact "keterlambatan update
 * status" failure mode documented as the #1 troubleshooting scenario in
 * Handbook Vol 7 §11.3 ("Tagihan SPP Sudah Dibayar Tapi Masih Tercatat
 * Belum Lunas") — implemented atomically from the start here rather than
 * repeating the same two-step-round-trip mistake already caught once in
 * Report.gs during Tahap 2.
 */
function bayarSpp(idTagihan, nominalDibayar, metodeBayar) {
  const user = requireAccess(KEUANGAN_MODULE, 'Write');

  const tagihan = getRowById(SHEETS.TAGIHAN_SPP, idTagihan);
  if (!tagihan) throw new Error('TAGIHAN_SPP tidak ditemukan: ' + idTagihan);
  if (tagihan.status !== 'Belum Lunas') {
    throw new Error('TAGIHAN_SPP ' + idTagihan + ' berstatus "' + tagihan.status + '", bukan Belum Lunas.');
  }

  const pembayaran = insertRow(SHEETS.PEMBAYARAN_SPP, {
    id_tagihan: idTagihan,
    tanggal_bayar: new Date(),
    nominal_dibayar: String(nominalDibayar),
    metode_bayar: metodeBayar,
    id_sdm_penerima: user.id_sdm
  });

  updateRow(SHEETS.TAGIHAN_SPP, idTagihan, { status: 'Lunas' });

  return { pembayaran: pembayaran, tagihanStatus: 'Lunas' };
}

function clientGenerateTagihanSppBulanan(periodeBulan, nominalTagihan, jatuhTempo) {
  try { return successResponse_(generateTagihanSppBulanan(periodeBulan, nominalTagihan, jatuhTempo)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientBayarSpp(idTagihan, nominalDibayar, metodeBayar) {
  try { return successResponse_(bayarSpp(idTagihan, nominalDibayar, metodeBayar)); }
  catch (err) { return errorResponse_(err.message); }
}

/**
 * Client-facing wrappers — every one goes through requireAccess() inside
 * the underlying function already; these just adapt to the errorResponse_/
 * successResponse_ shape for google.script.run.
 */
function clientLogIncident(idSantri, idMasterIncident, tanggal, deskripsi) {
  try { return successResponse_(logIncident(idSantri, idMasterIncident, tanggal, deskripsi)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientVerifyIncident(idIncidentLog) {
  try { return successResponse_(verifyIncident(idIncidentLog)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientGetNextApprovalStep(idIncidentLog) {
  try { return successResponse_(getNextIncidentApprovalStep(idIncidentLog)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientSubmitIncidentApproval(idIncidentLog, keputusan, catatan) {
  try { return successResponse_(submitIncidentApproval(idIncidentLog, keputusan, catatan)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientAjukanPerizinan(idSantri, jenisIzin, tanggalMulai, tanggalSelesai, catatan) {
  try { return successResponse_(ajukanPerizinan(idSantri, jenisIzin, tanggalMulai, tanggalSelesai, catatan)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientDecidePerizinan(idPerizinan, keputusan) {
  try { return successResponse_(decidePerizinan(idPerizinan, keputusan)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientGetHangingItems(minDays, modulFilter) {
  try { return successResponse_(getHangingItems(minDays || 2, modulFilter)); }
  catch (err) { return errorResponse_(err.message); }
}

// =============================================================================
// TAHAP 5 — DAIMS_SDM
// =============================================================================

/**
 * Submits a CUTI_SDM request. Same single-jenjang approval SHAPE as
 * PERIZINAN (Tahap 2) — exactly the reuse case flagged in the Tahap 2/3
 * README's "Reusable Component" table. Reuses the existing generic
 * validators (validateFKExists, validateDateRange) rather than writing new
 * ones for the third time.
 */
function ajukanCuti(idSdm, jenisCuti, tanggalMulai, tanggalSelesai) {
  requireAccess(SDM_MODULE, 'Write');
  return insertRow(SHEETS.CUTI_SDM, {
    id_sdm: idSdm,
    jenis_cuti: jenisCuti,
    tanggal_mulai: tanggalMulai,
    tanggal_selesai: tanggalSelesai,
    id_sdm_penyetuju: '-',
    status: 'Diajukan'
  }, [
    validateFKExists(SHEETS.MASTER_SDM, idSdm),
    validateDateRange(tanggalMulai, tanggalSelesai, { allowEqual: true })
  ]);
}

/**
 * Decides a CUTI_SDM request. Delegates the actual "compute next/only step"
 * concept to nothing extra here since this is single-jenjang (no chain to
 * compute) — kept as a direct updateRow like decidePerizinan, consistent
 * with that established pattern rather than routing single-jenjang cases
 * through the multi-jenjang DaimsLib.Workflow functions unnecessarily.
 */
function decideCuti(idCuti, keputusan) {
  const user = requireAccess(SDM_MODULE, 'Approve');
  const cuti = getRowById(SHEETS.CUTI_SDM, idCuti);
  if (!cuti) throw new Error('CUTI_SDM tidak ditemukan: ' + idCuti);

  return updateRow(SHEETS.CUTI_SDM, idCuti, {
    status: keputusan,
    id_sdm_penyetuju: user.id_sdm
  }, [
    keputusan === 'Disetujui' || keputusan === 'Ditolak'
      ? vOk_() : vFail_('Keputusan harus Disetujui atau Ditolak.')
  ]);
}

/**
 * Records a PENILAIAN_KINERJA_SDM row. Enforces the FAQ-documented rule
 * (Handbook Vol 6, PENILAIAN_KINERJA_SDM §24): "id_sdm_penilai HARUS
 * berbeda dari id_sdm yang dinilai" — a business rule, checked against the
 * logged-in user's own id_sdm (not a value the form can spoof), same
 * pattern as catatNilaiAkademik's pengampu check.
 */
function catatPenilaianKinerja(idSdmDinilai, periode, skorKinerja, catatan) {
  const user = requireAccess(SDM_MODULE, 'Write');

  if (user.id_sdm === idSdmDinilai) {
    throw new Error('id_sdm_penilai tidak boleh sama dengan SDM yang dinilai (menilai diri sendiri tidak diperbolehkan).');
  }

  const skor = Number(skorKinerja);
  const skorRangeCheck = (skor >= 0 && skor <= 100) ? vOk_() : vFail_('skor_kinerja harus di rentang 0-100.');

  return insertRow(SHEETS.PENILAIAN_KINERJA_SDM, {
    id_sdm: idSdmDinilai,
    tanggal_penilaian: new Date(),
    periode: periode,
    id_sdm_penilai: user.id_sdm,
    skor_kinerja: String(skor),
    catatan: catatan || ''
  }, [
    validateFKExists(SHEETS.MASTER_SDM, idSdmDinilai),
    skorRangeCheck
  ]);
}

/** Records a PELATIHAN_SDM row, linked back to the anggaran that funded it. */
function catatPelatihan(idPengajuanAnggaran, namaPelatihan, tanggal, idSdmPeserta, output) {
  requireAccess(SDM_MODULE, 'Write');
  return insertRow(SHEETS.PELATIHAN_SDM, {
    id_pengajuan_anggaran: idPengajuanAnggaran,
    nama_pelatihan: namaPelatihan,
    tanggal: tanggal,
    id_sdm_peserta: idSdmPeserta,
    output: output
  }, [
    validateFKExists(SHEETS.PENGAJUAN_ANGGARAN, idPengajuanAnggaran),
    validateFKExists(SHEETS.MASTER_SDM, idSdmPeserta)
  ]);
}

function clientAjukanCuti(idSdm, jenisCuti, tanggalMulai, tanggalSelesai) {
  try { return successResponse_(ajukanCuti(idSdm, jenisCuti, tanggalMulai, tanggalSelesai)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientDecideCuti(idCuti, keputusan) {
  try { return successResponse_(decideCuti(idCuti, keputusan)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientCatatPenilaianKinerja(idSdmDinilai, periode, skorKinerja, catatan) {
  try { return successResponse_(catatPenilaianKinerja(idSdmDinilai, periode, skorKinerja, catatan)); }
  catch (err) { return errorResponse_(err.message); }
}
function clientCatatPelatihan(idPengajuanAnggaran, namaPelatihan, tanggal, idSdmPeserta, output) {
  try { return successResponse_(catatPelatihan(idPengajuanAnggaran, namaPelatihan, tanggal, idSdmPeserta, output)); }
  catch (err) { return errorResponse_(err.message); }
}
