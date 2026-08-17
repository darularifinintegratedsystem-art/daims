/**
 * PermissionEngine.gs (part of DaimsLib)
 * ----------------------------------------------------------------------------
 * Generalized from Permission.gs (Tahap 1). Column names for the
 * user/staff/role/access sheets are all supplied via config rather than
 * assumed — the host's Permission.gs still owns the DAIMS-specific
 * decision of WHICH sheets/columns those are (MASTER_USER, MASTER_SDM,
 * MASTER_HAK_AKSES with their verified column names) and still owns
 * throwing DAIMS-flavored error messages; this file only does the generic
 * "look up a role, evaluate a rank-based access rule set" mechanics.
 * ----------------------------------------------------------------------------
 */

var Permission = Permission || {};

/**
 * Resolves a person's row in `staffSheet` (e.g. MASTER_SDM) by email, then
 * their row in `userSheet` (e.g. MASTER_USER) by the staff-id foreign key.
 * Returns null (not an error) if no match — same "authenticated but not
 * provisioned" contract as the host's original getCurrentUser().
 *
 * @param {Spreadsheet} ss
 * @param {string} email
 * @param {Object} config {
 *   staffSheet, staffEmailField, staffPkField,
 *   userSheet, userStaffFkField, userPkField, userRoleField, userStatusField
 * }
 * @return {{userRow: Object, staffRow: Object}|null}
 */
Permission.resolveUserByEmail = function (ss, email, config) {
  if (!email) return null;

  const staffSheet = findSheet_(ss, config.staffSheet);
  const staffRows = rowsToObjects_(staffSheet);
  const staffRow = staffRows.find(function (s) { return s[config.staffEmailField] === email; });
  if (!staffRow) return null;

  const userSheet = findSheet_(ss, config.userSheet);
  const userRows = rowsToObjects_(userSheet);
  const userRow = userRows.find(function (u) {
    return u[config.userStaffFkField] === staffRow[config.staffPkField];
  });
  if (!userRow) return null;

  return { userRow: userRow, staffRow: staffRow };
};

/** Returns access-rule rows for a given role from an access-matrix sheet. */
Permission.getRoleRules = function (ss, sheetName, roleField, idRole) {
  const sheet = findSheet_(ss, sheetName);
  const rows = rowsToObjects_(sheet);
  return rows.filter(function (r) { return r[roleField] === idRole; })
    .map(function (r) { const c = Object.assign({}, r); delete c.__rowIndex; return c; });
};

/**
 * Access check against a rule set, using an explicit "which rule-level
 * values satisfy this request" map — NOT numeric rank comparison. Rank
 * comparison looks appealing but is WRONG for DAIMS: Write and Approve
 * share the same conceptual "rank" (2) yet Write must NOT satisfy an
 * Approve request (they're parallel capabilities, not a hierarchy — see
 * host ACCESS_LEVELS_RANK's own comment). An earlier draft of this
 * function used rank comparison plus a special-cased 'approveLevelName'
 * parameter to patch around that one case; caught during review that it
 * was fragile (correct only for the one case it was patched for) and
 * replaced with this more explicit, more honestly-generic design.
 *
 * @param {Array<Object>} rules
 * @param {Object} fieldNames { moduleField, levelField }
 * @param {string} wildcardValue
 * @param {string} modul
 * @param {string} levelDibutuhkan
 * @param {Object<string,string[]>} acceptedLevelsMap e.g.
 *   { Read: ['Read','Write','Approve','Full'], Write: ['Write','Full'],
 *     Approve: ['Approve','Full'], Full: ['Full'] }
 */
Permission.checkAccess = function (rules, fieldNames, wildcardValue, modul, levelDibutuhkan, acceptedLevelsMap) {
  const acceptedValues = acceptedLevelsMap[levelDibutuhkan] || [];

  return rules.some(function (rule) {
    const modulMatches = rule[fieldNames.moduleField] === wildcardValue || rule[fieldNames.moduleField] === modul;
    if (!modulMatches) return false;
    return acceptedValues.indexOf(rule[fieldNames.levelField]) !== -1;
  });
};
