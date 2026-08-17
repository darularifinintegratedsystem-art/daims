/**
 * Permission.gs
 * ----------------------------------------------------------------------------
 * Permission Engine (Architecture Master §12): MASTER_ROLE -> MASTER_HAK_AKSES
 * -> MASTER_USER. This is the ONLY file allowed to answer "is this user
 * allowed to do X". No other .gs file may hardcode an email check or a role
 * name — everything routes through checkAccess() / requireAccess().
 *
 * MASTER_USER.id_referensi_lain is polymorphic (points to MASTER_ORANG_TUA or
 * MASTER_SANTRI when id_sdm is '-'), per the handbook's explicit note under
 * "Relasi ke Sheet Lain". Resolved here so callers never touch that
 * ambiguity directly.
 * ----------------------------------------------------------------------------
 */

const ACCESS_LEVELS_RANK = {
  'Read': 1,
  'Write': 2,
  'Approve': 2, // parallel rank to Write; distinct capability, not a superset
  'Full': 3
};

// Explicit "which rule values satisfy a request for level X" map, derived
// from ACCESS_LEVELS_RANK but made explicit rather than computed by rank
// comparison — see PermissionEngine.gs's checkAccess doc for why rank
// comparison alone is wrong here (Write and Approve share a rank but must
// not satisfy each other).
const ACCEPTED_LEVELS_MAP_ = {
  Read: ['Read', 'Write', 'Approve', 'Full'],
  Write: ['Write', 'Full'],
  Approve: ['Approve', 'Full'],
  Full: ['Full']
};

/**
 * Resolves the currently logged-in Google account to a MASTER_USER row.
 * Returns null (not an error) if the account has no MASTER_USER row —
 * callers decide how to handle "authenticated but not provisioned".
 */
function getCurrentUser() {
  const email = Session.getActiveUser().getEmail();
  if (!email) return null;

  const ss = getCoreSpreadsheet_();

  // Generic "find staff row by email, find user row by staff FK" resolution
  // delegated to the library (Tahap 4) — pure lookup, no write. Column
  // names are DAIMS-specific and supplied here, not assumed by the library.
  const resolved = DaimsLib.Permission.resolveUserByEmail(ss, email, {
    staffSheet: SHEETS.MASTER_SDM, staffEmailField: 'email', staffPkField: 'id_sdm',
    userSheet: SHEETS.MASTER_USER, userStaffFkField: 'id_sdm'
  });
  if (!resolved) return null;

  const user = resolved.userRow;
  const sdmMatch = resolved.staffRow;

  if (user.status_akun !== 'Aktif') {
    throw new Error('Akun ' + user.username + ' berstatus ' + user.status_akun + ', bukan Aktif.');
  }

  return {
    id_user: user.id_user,
    username: user.username,
    id_sdm: user.id_sdm,
    id_role: user.id_role,
    email: email,
    nama_lengkap: sdmMatch ? sdmMatch.nama_lengkap : user.username,
    jabatan: sdmMatch ? sdmMatch.jabatan : null,
    id_bidang: sdmMatch ? sdmMatch.id_bidang : null
  };
}

/** Returns the full MASTER_HAK_AKSES row set for a given role. */
function getRoleAccessRules_(idRole) {
  const ss = getCoreSpreadsheet_();
  return DaimsLib.Permission.getRoleRules(ss, SHEETS.MASTER_HAK_AKSES, 'id_role', idRole);
}

/**
 * Checks whether the given role may access `modul` at (at least)
 * `levelDibutuhkan`. modul = '*' rows in MASTER_HAK_AKSES grant access to
 * every module, per the seed convention observed (HAK0001 ROL001 '*' Full).
 *
 * @param {string} idRole
 * @param {string} modul e.g. 'DAIMS_PENGASUHAN'
 * @param {string} levelDibutuhkan one of 'Read'|'Write'|'Approve'|'Full'
 * @return {boolean}
 */
function checkAccess(idRole, modul, levelDibutuhkan) {
  if (!idRole) return false;
  const rules = getRoleAccessRules_(idRole);
  return DaimsLib.Permission.checkAccess(
    rules, { moduleField: 'modul', levelField: 'level_akses' }, '*',
    modul, levelDibutuhkan, ACCEPTED_LEVELS_MAP_
  );
}

/**
 * Same as checkAccess but throws — use at the top of every backend function
 * that touches data, so an access failure never silently falls through.
 */
function requireAccess(modul, levelDibutuhkan) {
  const user = getCurrentUser();
  if (!user) {
    throw new Error('Tidak terautentikasi atau akun belum terdaftar di MASTER_USER.');
  }
  if (!checkAccess(user.id_role, modul, levelDibutuhkan)) {
    throw new Error(
      'Akses ditolak: role ' + user.id_role + ' tidak punya ' +
      levelDibutuhkan + ' pada modul ' + modul + '.'
    );
  }
  return user;
}

/**
 * Client-facing wrapper (called via google.script.run) so the dashboard shell
 * can render navigation dynamically per role, without the client ever
 * deciding access on its own — it only renders what the server already
 * confirmed is visible.
 */
function getCurrentUserForClient() {
  try {
    const user = getCurrentUser();
    if (!user) return errorResponse_('Akun tidak terdaftar di MASTER_USER. Hubungi Administrator.');
    const rules = getRoleAccessRules_(user.id_role);
    const roleSheet = getCoreSpreadsheet_().getSheetByName(SHEETS.MASTER_ROLE);
    const role = rowsToObjects_(roleSheet).find(function (r) { return r.id_role === user.id_role; });
    return successResponse_({
      user: user,
      role: role || null,
      accessRules: rules
    });
  } catch (err) {
    return errorResponse_(err.message);
  }
}
