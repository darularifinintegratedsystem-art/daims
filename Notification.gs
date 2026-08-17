/**
 * Notification.gs
 * ----------------------------------------------------------------------------
 * Notification Engine (Architecture Master §12, ADR-012): NOTIFICATION_QUEUE
 * is the SINGLE reuse-generic channel for every domain's alerts — this file
 * is the only place that writes to it. No module should ever grow its own
 * notification table (see Handbook Vol 2 "Kesalahan Umum" on this exact
 * anti-pattern).
 *
 * Verified columns (NOTIFICATION_QUEUE): id_notifikasi, judul, pesan,
 * modul_sumber, id_penerima, kanal, waktu_kirim, status_kirim.
 * id_penerima is polymorphic (MASTER_USER / MASTER_SDM / MASTER_ORANG_TUA)
 * per the handbook's own note — this file resolves "unread for the current
 * user" against id_sdm specifically for Tahap 2 scope (staff-facing bell
 * icon only; Portal Wali notifications are a later phase).
 * ----------------------------------------------------------------------------
 */

/**
 * Pushes a new notification. Called by Automation.gs (server-side, system
 * events) — never called directly from a client form, consistent with
 * ADR-012's "otomatis oleh sistem, dipicu berbagai event" description.
 */
function pushNotification(modulSumber, idPenerima, judul, pesan, kanal) {
  const resolvedKanal = kanal || 'In-App';
  // In-App is the only channel this bell icon reads, so new items start
  // 'Belum Dibaca' so the unread badge has something to count. WhatsApp/
  // Email pushes have no in-app read state, so they default 'Terkirim'
  // (matches the seed pattern: every WhatsApp row is 'Terkirim').
  const initialStatus = resolvedKanal === 'In-App' ? 'Belum Dibaca' : 'Terkirim';
  return insertRow(SHEETS.NOTIFICATION_QUEUE, {
    judul: judul,
    pesan: pesan,
    modul_sumber: modulSumber,
    id_penerima: idPenerima,
    kanal: resolvedKanal,
    waktu_kirim: new Date(),
    status_kirim: initialStatus
  });
}

/**
 * Returns notifications addressed to the current user (by id_sdm), newest
 * first.
 *
 * status_kirim ENUM — flagged, not fully governed anywhere: MASTER_LOOKUP
 * has NO 'StatusKirim'/'StatusNotifikasi' grup at all (checked all 22
 * existing grup values), and seed data only ever contains 'Terkirim' or
 * 'Belum Dibaca' (never 'Gagal', despite the handbook prose mentioning it).
 * ASSUMPTION made explicit here (please correct if wrong, this is inferred,
 * not verified against a governing source): 'Belum Dibaca' is the initial
 * state for In-App notifications needing attention, and reading one
 * transitions it back to 'Terkirim' — reusing the existing two-value enum
 * rather than inventing a third 'Dibaca' state that appears nowhere in the
 * schema. An earlier draft of this file used 'Dibaca'; corrected before
 * shipping once the seed data was actually checked.
 */
function getNotificationsForCurrentUser() {
  const user = getCurrentUser();
  if (!user) return [];
  const rows = getRows(SHEETS.NOTIFICATION_QUEUE, { id_penerima: user.id_sdm });
  return rows.sort(function (a, b) {
    return new Date(b.waktu_kirim) - new Date(a.waktu_kirim);
  });
}

function markNotificationRead(idNotifikasi) {
  const notif = getRowById(SHEETS.NOTIFICATION_QUEUE, idNotifikasi);
  if (!notif) throw new Error('Notifikasi tidak ditemukan: ' + idNotifikasi);
  // See ENUM note above insertNotification/getNotificationsForCurrentUser —
  // 'Terkirim' is reused as the read/acknowledged state, not a new value.
  return updateRow(SHEETS.NOTIFICATION_QUEUE, idNotifikasi, { status_kirim: 'Terkirim' });
}

/** Client-facing wrappers. Read access to one's own notifications needs no
 *  module-level permission check beyond being logged in — a user always has
 *  the right to see messages addressed to them. */
function clientGetNotifications() {
  try {
    const user = getCurrentUser();
    if (!user) return errorResponse_('Tidak terautentikasi.');
    return successResponse_(getNotificationsForCurrentUser());
  } catch (err) {
    return errorResponse_(err.message);
  }
}

function clientMarkNotificationRead(idNotifikasi) {
  try {
    return successResponse_(markNotificationRead(idNotifikasi));
  } catch (err) {
    return errorResponse_(err.message);
  }
}
