/**
 * WorkflowEngine.gs (part of DaimsLib)
 * ----------------------------------------------------------------------------
 * Generalized from Automation.gs's INCIDENT_LOG approval-chain logic
 * (Tahap 2) and PERIZINAN single-jenjang logic. The DAIMS-specific pieces
 * — "read approver_role_sequence from MASTER_INCIDENT", "match against
 * MASTER_SDM.jabatan", "trigger triggerScoreRule() on completion" — stay in
 * the host project's Automation.gs, because those ARE the business rules,
 * not generic infrastructure. What moved here is the part that has nothing
 * to do with incidents specifically: parsing a role-sequence string and
 * computing which jenjang is next. Pure functions only — no spreadsheet
 * I/O at all in this file (see SCOPE NOTE below for why writes stayed out).
 * ----------------------------------------------------------------------------
 */

var Workflow = Workflow || {};

/**
 * SCOPE NOTE: this library exposes read/compute-only functions. Writing an
 * approval-log row or flipping a status field is intentionally NOT exposed
 * here — the host project's Database.gs (insertRow/updateRow) is what
 * enforces audit logging (writeAuditLog_) and cache protection on every
 * write in DAIMS, and a library function that wrote directly to a sheet
 * would silently bypass both. (An earlier draft of this library did expose
 * recordApprovalDecision()/decideSingleStep() as raw-write helpers; removed
 * before shipping once this conflict was caught — see README.) The host
 * still owns every write; it just delegates the PURE logic below to avoid
 * re-implementing it.
 */

/**
 * Splits a role-sequence string into ordered jenjang steps.
 *   '->' separates SEQUENTIAL jenjang.
 *   '/'  inside one jenjang token means ANY of those roles may approve
 *        that single step (verified pattern from live MASTER_INCIDENT data:
 *        'Koordinator Musyrif->Wadir Pengasuhan->Mudir' vs
 *        'Musyrif/Koordinator Olahraga').
 *   '-' or empty means no approval chain at all.
 * @return {Array<Array<string>>}
 */
Workflow.parseSequence = function (sequenceString) {
  if (!sequenceString || sequenceString === '-') return [];
  return sequenceString.split('->').map(function (step) {
    return step.split('/').map(function (s) { return s.trim(); });
  });
};

/**
 * Given a parsed sequence and how many jenjang have already been approved
 * ('Setuju'), returns the next required step, or null if the chain is
 * already complete (or there was no chain to begin with).
 */
Workflow.getNextStep = function (parsedSequence, approvedCount) {
  if (!parsedSequence || parsedSequence.length === 0) return null;
  if (approvedCount >= parsedSequence.length) return null;
  return {
    jenjangNumber: approvedCount + 1,
    allowedRoles: parsedSequence[approvedCount],
    isFinal: approvedCount + 1 === parsedSequence.length
  };
};

/**
 * Loose role match with an optional alias map, so gender/title variants
 * (e.g. 'Musyrif' should also match a jabatan of 'Musyrifah') don't have to
 * be hardcoded inside the library — the host supplies its own domain
 * vocabulary via `aliases`.
 * @param {string} actualValue e.g. MASTER_SDM.jabatan for the current user
 * @param {string} expectedToken one entry from allowedRoles
 * @param {Object<string,string[]>=} aliases e.g. { musyrif: ['musyrif','musyrifah'] }
 */
Workflow.roleMatches = function (actualValue, expectedToken, aliases) {
  if (!actualValue || !expectedToken) return false;
  const a = String(actualValue).trim().toLowerCase();
  const t = String(expectedToken).trim().toLowerCase();
  if (a === t) return true;
  if (aliases && aliases[t] && aliases[t].indexOf(a) !== -1) return true;
  return false;
};
