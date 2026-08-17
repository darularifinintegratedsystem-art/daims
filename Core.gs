/**
 * Core.gs
 * ----------------------------------------------------------------------------
 * Bootstrap layer: spreadsheet handles, global constants, and the doGet()
 * entry point for the HtmlService Web App.
 *
 * ARCHITECTURE NOTE (do not violate):
 * - DAIMS_CORE is the mandatory first-deployed workbook (Architecture Master
 *   §14.1). All cross-workbook reads go through Apps Script functions here,
 *   never through manual IMPORTRANGE (§14.3).
 * - This file holds NO business logic. It only resolves "which spreadsheet /
 *   which sheet" and hands off. Business logic lives in Automation.gs,
 *   validation in Validation.gs, access control in Permission.gs.
 * ----------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// CONFIGURATION — fill these in at deployment time (Project Settings > Script
// Properties, or hardcode here for a single-workbook MVP). DAIMS_CORE holds
// 01_DAIMS_CORE + all cross-cutting registries (DATA_OWNERSHIP_MATRIX,
// RULE_ENGINE_REGISTRY, CHANGELOG, MASTER_LOOKUP, MASTER_KONFIGURASI) plus,
// for this MVP, 09_DAIMS_PENGASUHAN (Tahap 2 scope). If/when the pesantren
// splits into true multi-workbook deployment per §14.1, only CORE_SS_ID
// changes here — no other file needs to know.
// ---------------------------------------------------------------------------
const DAIMS_CONFIG = {
  // Replace with the actual Spreadsheet ID of DAIMS_ENTERPRISE_DATABASE
  // (or DAIMS_CORE once physically split). Left blank intentionally —
  // do not guess an ID.
  CORE_SS_ID: PropertiesService.getScriptProperties().getProperty('CORE_SS_ID') || '',
  APP_TITLE: 'DAIMS — Darul Arifin Integrated Management System',
  TIMEZONE: 'Asia/Jakarta'
};

/**
 * Registry-sheet names as they ACTUALLY exist in the workbook (verified
 * against DAIMS_ENTERPRISE_DATABASE_5.xlsx — NOT the numeric-prefixed names
 * used in the handbook prose, which do not match the live file):
 *   Handbook says          | Actual sheet name
 *   92_DATA_OWNERSHIP_MATRIX | DATA_OWNERSHIP_MATRIX
 *   93_MASTER_RULE_ENGINE    | RULE_ENGINE_REGISTRY
 *   94_CHANGELOG             | CHANGELOG
 * This constant map is the single place that discrepancy is absorbed —
 * every other file references SHEETS.xxx, never a literal string.
 */
const SHEETS = {
  // Registries / cross-cutting
  DATA_DICTIONARY: '00_DATA_DICTIONARY',
  INDEX: '00_INDEX',
  DATA_OWNERSHIP_MATRIX: 'DATA_OWNERSHIP_MATRIX',
  RULE_ENGINE_REGISTRY: 'RULE_ENGINE_REGISTRY',
  CHANGELOG: 'CHANGELOG',
  MASTER_LOOKUP: 'MASTER_LOOKUP',
  MASTER_KONFIGURASI: 'MASTER_KONFIGURASI',

  // Core identity/org
  MASTER_BIDANG: 'MASTER_BIDANG',
  MASTER_SDM: 'MASTER_SDM',
  MASTER_SANTRI: 'MASTER_SANTRI',
  MASTER_ORANG_TUA: 'MASTER_ORANG_TUA',
  MASTER_ASRAMA: 'MASTER_ASRAMA',
  MASTER_TAHUN_AJARAN: 'MASTER_TAHUN_AJARAN',

  // Akademik (Tahap 3)
  MASTER_KELAS: 'MASTER_KELAS',
  MASTER_MATA_PELAJARAN: 'MASTER_MATA_PELAJARAN',
  PENGAMPU_MATA_PELAJARAN: 'PENGAMPU_MATA_PELAJARAN',
  NILAI_AKADEMIK: 'NILAI_AKADEMIK',
  KEHADIRAN_KELAS: 'KEHADIRAN_KELAS',

  // Keuangan / SPP (Tahap 3)
  TAGIHAN_SPP: 'TAGIHAN_SPP',
  PEMBAYARAN_SPP: 'PEMBAYARAN_SPP',
  PENGAJUAN_ANGGARAN: 'PENGAJUAN_ANGGARAN',

  // SDM (Tahap 5)
  MASTER_JABATAN: 'MASTER_JABATAN',
  KONTRAK_KERJA: 'KONTRAK_KERJA',
  PENILAIAN_KINERJA_SDM: 'PENILAIAN_KINERJA_SDM',
  CUTI_SDM: 'CUTI_SDM',
  PELATIHAN_SDM: 'PELATIHAN_SDM',

  // Permission Engine
  MASTER_ROLE: 'MASTER_ROLE',
  MASTER_HAK_AKSES: 'MASTER_HAK_AKSES',
  MASTER_USER: 'MASTER_USER',

  // Shared platform services
  NOTIFICATION_QUEUE: 'NOTIFICATION_QUEUE',
  NOMOR_SURAT: 'NOMOR_SURAT',
  TEMPLATE_SURAT: 'TEMPLATE_SURAT',

  // Pengasuhan (Tahap 2 scope, referenced now so constants exist in one place)
  MASTER_INCIDENT: 'MASTER_INCIDENT',
  MASTER_SCORE_RULE: 'MASTER_SCORE_RULE',
  INCIDENT_LOG: 'INCIDENT_LOG',
  INCIDENT_APPROVAL_LOG: 'INCIDENT_APPROVAL_LOG',
  SURAT_PERINGATAN: 'SURAT_PERINGATAN',
  PERIZINAN: 'PERIZINAN',
  MUTABAAH_HARIAN: 'MUTABAAH_HARIAN',
  SUPERVISI_MUSYRIF: 'SUPERVISI_MUSYRIF',
  COUNSELING_LOG: 'COUNSELING_LOG',

  // Cache sheets — writes must NEVER go through Database.gs.insertRow/updateRow
  // for these; they are refreshed only by Automation.gs jobs.
  SANTRI_SCORE_SUMMARY: 'SANTRI_SCORE_SUMMARY',
  LEADERBOARD_CACHE: 'LEADERBOARD_CACHE',
  SCORE_TRANSACTION: 'SCORE_TRANSACTION',
  TABUNGAN_SANTRI: 'TABUNGAN_SANTRI'
};

/**
 * Explicit partial-cache column protection. DATA_OWNERSHIP_MATRIX only
 * flags cache at whole-sheet granularity (see discrepancy note above this
 * file's header). TABUNGAN_SANTRI.saldo_saat_ini is a documented exception:
 * the sheet itself is a live master (id_santri, status ARE writable), but
 * this one column is a running balance that must only move via
 * TRANSAKSI_TABUNGAN rows. Add more entries here ONLY with an explicit
 * handbook citation in the comment — never silently.
 */
const PARTIAL_CACHE_COLUMNS = {
  // Handbook Vol 6, TABUNGAN_SANTRI §15/§25: "Jangan pernah mengedit
  // saldo_saat_ini secara langsung — selalu buat baris baru di
  // TRANSAKSI_TABUNGAN dan biarkan saldo terhitung dari sana."
  TABUNGAN_SANTRI: ['saldo_saat_ini']
};

/** Lazily-cached handle to the CORE spreadsheet. */
function getCoreSpreadsheet_() {
  if (!DAIMS_CONFIG.CORE_SS_ID) {
    throw new Error(
      'CORE_SS_ID belum dikonfigurasi. Set lewat Script Properties ' +
      '(Project Settings > Script Properties > CORE_SS_ID) sebelum deploy.'
    );
  }
  return SpreadsheetApp.openById(DAIMS_CONFIG.CORE_SS_ID);
}

/**
 * doGet — single entry point for the Web App. Renders the dashboard shell.
 * Auth/role resolution happens client-side via google.script.run calls into
 * Permission.gs so the shell can render its nav dynamically per role,
 * rather than baking access logic into server-side HTML templating.
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');
  template.appTitle = DAIMS_CONFIG.APP_TITLE;
  return template
    .evaluate()
    .setTitle(DAIMS_CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Helper used by HTML templates to inline partial files (CSS/JS includes). */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
