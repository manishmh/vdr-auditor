// Minimal valid-PDF generator for extraction tests. Builds single-font PDFs
// with exact cross-reference offsets so parsing is deterministic.

function escapePdfText(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream(lines: string[]): string {
  const ops = lines.map(
    (line, index) =>
      `BT /F1 12 Tf 72 ${720 - index * 20} Td (${escapePdfText(line)}) Tj ET`,
  );
  return ops.join("\n");
}

/**
 * Build a minimal valid PDF. `pages` is one entry per page; each page holds
 * an array of text lines (an empty array makes a textless page).
 */
export function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageRefs: string[] = [];
  let objectNumber = 1;
  const catalogNum = objectNumber++;
  const pagesNum = objectNumber++;
  const fontNum = objectNumber++;
  const pageCount = Math.max(pages.length, 1);
  for (let i = 0; i < pageCount; i += 1) {
    const pageNum = objectNumber++;
    const contentNum = objectNumber++;
    pageRefs.push(`${pageNum} 0 R`);
    const stream = contentStream(pages[i] ?? []);
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }
  objects.unshift(
    `${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`,
    `${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageCount} >>\nendobj\n`,
    `${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const body of objects) {
    offsets.push(pdf.length);
    pdf += body;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** Bytes with a PDF header that cannot be parsed as a document. */
export function buildCorruptPdf(): Buffer {
  return Buffer.from("%PDF-1.4\n%garbage that is not a pdf body at all\n", "latin1");
}
