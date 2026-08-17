/**
 * PdfEngine.gs (part of DaimsLib)
 * ----------------------------------------------------------------------------
 * Generalized from Report.gs's Google Docs -> PDF -> Drive flow (Tahap 2).
 * This is the most straightforwardly generic of the four extractions — it
 * has ZERO knowledge of SURAT_PERINGATAN, TEMPLATE_SURAT, or any DAIMS
 * concept. The host supplies plain text body + a filename + a folder path;
 * everything domain-specific (letter wording, which record triggered this,
 * writing the resulting URL back onto a sheet row) stays in the host's
 * Report.gs.
 * ----------------------------------------------------------------------------
 */

var Pdf = Pdf || {};

/**
 * Creates a Google Doc from plain text, converts it to PDF, saves the PDF
 * into `rootFolderName/subfolderName` (creating either if missing), and
 * discards the intermediate Doc.
 *
 * @param {string} bodyText
 * @param {string} fileName filename WITHOUT extension
 * @param {string} rootFolderName e.g. 'DAIMS_Generated_Documents'
 * @param {string} subfolderName e.g. 'SURAT_PERINGATAN'
 * @return {{pdfUrl: string, pdfFileId: string}}
 */
Pdf.generateFromText = function (bodyText, fileName, rootFolderName, subfolderName) {
  const folder = Pdf.getOrCreateFolder_(rootFolderName, subfolderName);

  const doc = DocumentApp.create(fileName);
  doc.getBody().setText(bodyText);
  doc.saveAndClose();

  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs('application/pdf');
  const pdfFile = folder.createFile(pdfBlob).setName(fileName + '.pdf');
  docFile.setTrashed(true);

  return { pdfUrl: pdfFile.getUrl(), pdfFileId: pdfFile.getId() };
};

Pdf.getOrCreateFolder_ = function (rootFolderName, subfolderName) {
  const rootFolders = DriveApp.getFoldersByName(rootFolderName);
  const root = rootFolders.hasNext() ? rootFolders.next() : DriveApp.createFolder(rootFolderName);
  if (!subfolderName) return root;
  const subs = root.getFoldersByName(subfolderName);
  return subs.hasNext() ? subs.next() : root.createFolder(subfolderName);
};
