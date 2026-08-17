/**
 * UI.gs
 * ----------------------------------------------------------------------------
 * Read-only aggregation endpoints that feed dashboard widgets. Per §5.2 Data
 * Flow, dashboards are ALWAYS read-only consumers — nothing in this file
 * writes. Panel set for DAIMS_PENGASUHAN follows Handbook Vol 7 §9.3
 * ("rekap mutabaah harian, SP aktif, kinerja musyrif").
 * ----------------------------------------------------------------------------
 */

/** Today's MUTABAAH_HARIAN completion + a same-value ("Ya semua") flag per
 *  row, surfacing the exact anti-pattern documented in Handbook Vol 4
 *  §15 ("dicatat seragam Ya semua tanpa pengamatan riil"). */
function getMutabaahRekapHariIni() {
  const todayStr = Utilities.formatDate(new Date(), DAIMS_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const rows = getRows(SHEETS.MUTABAAH_HARIAN);
  const today = rows.filter(function (r) {
    const d = r.tanggal instanceof Date ? r.tanggal : new Date(r.tanggal);
    return !isNaN(d) && Utilities.formatDate(d, DAIMS_CONFIG.TIMEZONE, 'yyyy-MM-dd') === todayStr;
  });

  const aspects = ['sholat_berjamaah', 'tilawah_harian', 'kedisiplinan_asrama', 'adab_harian'];
  const flagged = today.filter(function (r) {
    return aspects.every(function (a) { return r[a] === 'Ya'; });
  });

  return {
    totalTercatatHariIni: today.length,
    seragamYaSemua: flagged.length,
    seragamYaPersen: today.length > 0 ? Math.round((flagged.length / today.length) * 100) : 0,
    rows: today
  };
}

/** Currently-active SP count and breakdown by tingkat_sp. */
function getSuratPeringatanAktifSummary() {
  const rows = getRows(SHEETS.SURAT_PERINGATAN);
  const byTingkat = { '1': 0, '2': 0, '3': 0 };
  rows.forEach(function (r) {
    const t = String(r.tingkat_sp);
    if (byTingkat[t] !== undefined) byTingkat[t]++;
  });
  return { total: rows.length, byTingkat: byTingkat, rows: rows };
}

/** Latest SUPERVISI_MUSYRIF score per musyrif, sorted lowest first (the ones
 *  needing attention surface at the top, per §9.3 dashboard intent). */
function getKinerjaMusyrifRingkas() {
  const rows = getRows(SHEETS.SUPERVISI_MUSYRIF);
  const latestByMusyrif = {};
  rows.forEach(function (r) {
    const existing = latestByMusyrif[r.id_sdm_musyrif];
    const rDate = new Date(r.tanggal_penilaian);
    if (!existing || rDate > new Date(existing.tanggal_penilaian)) {
      latestByMusyrif[r.id_sdm_musyrif] = r;
    }
  });
  const list = Object.values(latestByMusyrif);
  list.sort(function (a, b) { return Number(a.skor) - Number(b.skor); });
  return list;
}

/** Aggregated payload for the Pengasuhan dashboard tab in a single round trip. */
function getPengasuhanDashboard() {
  requireAccess(PENGASUHAN_MODULE, 'Read');
  return {
    mutabaah: getMutabaahRekapHariIni(),
    suratPeringatan: getSuratPeringatanAktifSummary(),
    kinerjaMusyrif: getKinerjaMusyrifRingkas(),
    // ADR-014: INCIDENT_LOG hanging items belong here too, see getHangingItems() doc.
    hangingItems: getHangingItems(2, [PENGASUHAN_MODULE, STUDENT_ENGINE_MODULE])
  };
}

function clientGetPengasuhanDashboard() {
  try { return successResponse_(getPengasuhanDashboard()); }
  catch (err) { return errorResponse_(err.message); }
}

// =============================================================================
// TAHAP 3 — Akademik & Keuangan dashboard widgets
// =============================================================================

/** Rekap kehadiran kelas hari ini + jumlah nilai yang sudah diinput semester berjalan. */
function getAkademikDashboard() {
  requireAccess(AKADEMIK_MODULE, 'Read');
  const todayStr = Utilities.formatDate(new Date(), DAIMS_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const kehadiran = getRows(SHEETS.KEHADIRAN_KELAS);
  const kehadiranHariIni = kehadiran.filter(function (r) {
    const d = r.tanggal instanceof Date ? r.tanggal : new Date(r.tanggal);
    return !isNaN(d) && Utilities.formatDate(d, DAIMS_CONFIG.TIMEZONE, 'yyyy-MM-dd') === todayStr;
  });
  const alpaHariIni = kehadiranHariIni.filter(function (r) { return r.status_hadir === 'Alpa'; });
  const nilaiRows = getRows(SHEETS.NILAI_AKADEMIK);

  return {
    kehadiranHariIni: kehadiranHariIni.length,
    alpaHariIni: alpaHariIni.length,
    totalNilaiTercatat: nilaiRows.length
  };
}

/** Piutang SPP ringkas: total Belum Lunas, total Lunas bulan berjalan. */
function getKeuanganDashboard() {
  requireAccess(KEUANGAN_MODULE, 'Read');
  const tagihan = getRows(SHEETS.TAGIHAN_SPP);
  const belumLunas = tagihan.filter(function (r) { return r.status === 'Belum Lunas'; });
  const totalPiutang = belumLunas.reduce(function (sum, r) { return sum + Number(r.nominal_tagihan || 0); }, 0);

  return {
    totalTagihan: tagihan.length,
    belumLunasCount: belumLunas.length,
    totalPiutang: totalPiutang,
    hangingItems: getHangingItems(7, KEUANGAN_MODULE) // 7 hari lewat jatuh tempo baru dianggap perlu perhatian
  };
}

function clientGetAkademikDashboard() {
  try { return successResponse_(getAkademikDashboard()); }
  catch (err) { return errorResponse_(err.message); }
}
function clientGetKeuanganDashboard() {
  try { return successResponse_(getKeuanganDashboard()); }
  catch (err) { return errorResponse_(err.message); }
}

// =============================================================================
// TAHAP 5 — DAIMS_SDM dashboard widgets
// =============================================================================

/**
 * KONTRAK_KERJA "mendekati berakhir" is a DIFFERENT alert shape from
 * getHangingItems() — that scanner flags records STUCK in a pending status
 * for too long; this flags Aktif contracts approaching a future deadline
 * (Handbook Vol 6 KONTRAK_KERJA §22: "Pengingat H-30 sebelum tanggal_berakhir").
 * Kept as its own function rather than forced into HANGING_STATUS_RULES's
 * shape, which doesn't fit "counting down to a future date" semantics.
 */
function getKontrakMendekatiBerakhir(hDays) {
  const now = new Date();
  const threshold = hDays || 30;
  const kontrakAktif = getRows(SHEETS.KONTRAK_KERJA, { status: 'Aktif' });

  return kontrakAktif
    .map(function (k) {
      const berakhir = new Date(k.tanggal_berakhir);
      const daysRemaining = Math.floor((berakhir - now) / (1000 * 60 * 60 * 24));
      return Object.assign({}, k, { daysRemaining: daysRemaining });
    })
    .filter(function (k) { return k.daysRemaining <= threshold; })
    .sort(function (a, b) { return a.daysRemaining - b.daysRemaining; });
}

/** Latest PENILAIAN_KINERJA_SDM score per SDM, lowest first — same shape as
 *  getKinerjaMusyrifRingkas() (Tahap 2), generalized here to ALL staff, not
 *  just musyrif (PENILAIAN_KINERJA_SDM covers the whole org per Handbook,
 *  distinct from SUPERVISI_MUSYRIF which is musyrif-only). */
function getKinerjaSdmRingkas() {
  const rows = getRows(SHEETS.PENILAIAN_KINERJA_SDM);
  const latestBySdm = {};
  rows.forEach(function (r) {
    const existing = latestBySdm[r.id_sdm];
    const rDate = new Date(r.tanggal_penilaian);
    if (!existing || rDate > new Date(existing.tanggal_penilaian)) {
      latestBySdm[r.id_sdm] = r;
    }
  });
  const list = Object.values(latestBySdm);
  list.sort(function (a, b) { return Number(a.skor_kinerja) - Number(b.skor_kinerja); });
  return list;
}

function getSdmDashboard() {
  requireAccess(SDM_MODULE, 'Read');
  const cutiAktif = getRows(SHEETS.CUTI_SDM, { status: 'Disetujui' }).filter(function (c) {
    const now = new Date();
    return new Date(c.tanggal_mulai) <= now && now <= new Date(c.tanggal_selesai);
  });

  return {
    kontrakMendekatiBerakhir: getKontrakMendekatiBerakhir(30),
    cutiAktifHariIni: cutiAktif,
    kinerjaSdm: getKinerjaSdmRingkas(),
    hangingItems: getHangingItems(2, SDM_MODULE)
  };
}

function clientGetSdmDashboard() {
  try { return successResponse_(getSdmDashboard()); }
  catch (err) { return errorResponse_(err.message); }
}
