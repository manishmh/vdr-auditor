// Generate a synthetic 2-page contract PDF (fully fictional) for live API testing.
// Usage: node scripts/make-synthetic-pdf.mjs [/tmp/synthetic-test.pdf]
// Never use real or confidential documents to test inference.
import { writeFileSync } from "node:fs";

function makePdf(pageTexts) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let cursor = 0;
  const push = (s) => {
    const b = encoder.encode(s);
    chunks.push(b);
    cursor += b.length;
  };
  const escape = (s) =>
    s
      .replace(/[^ -~]/g, (ch) => (ch === "\n" || ch === "\t" ? " " : "?"))
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const wrap = (line, width) => {
    const words = line.split(" ").filter((w) => w.length > 0);
    const out = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > width && current) {
        out.push(current);
        current = word;
      } else current = next;
    }
    if (current) out.push(current);
    return out.length > 0 ? out : [""];
  };
  const n = pageTexts.length;
  const fontNum = 3 + n * 2;
  const pageNums = pageTexts.map((_, i) => 3 + i * 2);
  const contentNums = pageTexts.map((_, i) => 4 + i * 2);
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  offsets[1] = cursor;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = cursor;
  push(`2 0 obj\n<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);
  pageTexts.forEach((text, i) => {
    const lines = text.split("\n").flatMap((l) => wrap(l, 80)).map((l) => `(${escape(l)}) Tj T*`).join("\n");
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td\n${lines}\nET`;
    offsets[contentNums[i]] = cursor;
    push(`${contentNums[i]} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
    offsets[pageNums[i]] = cursor;
    push(
      `${pageNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>\nendobj\n`,
    );
  });
  offsets[fontNum] = cursor;
  push(`${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  const total = fontNum + 1;
  const xrefAt = cursor;
  push(`xref\n0 ${total}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
  const out = new Uint8Array(cursor);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const pdf = makePdf([
  `SYNTHETIC TEST AGREEMENT - FICTIONAL CONTENT FOR API TESTING ONLY

Section 1. Services. Vendor shall provide the consulting services described in Exhibit A.

Section 2. Change of Control. In the event of a change of control of Vendor, Customer may terminate this agreement upon thirty days written notice and receive a refund of prepaid fees.`,
  `Section 3. Liability. Vendor liability shall be unlimited for breach of its data protection obligations. For all other claims, liability is capped at fees paid in the prior year.

Vendor Inc.

Signature: __________`,
]);

const target = process.argv[2] ?? "/tmp/synthetic-test.pdf";
writeFileSync(target, pdf);
console.log(`wrote ${target} (${pdf.length} bytes)`);
