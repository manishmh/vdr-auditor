import { deflateSync } from "node:zlib";

/**
 * Build a minimal valid multi-page PDF in memory (no dependencies).
 * Each entry becomes one page; an empty string yields a blank page.
 * Content streams use WinAnsiEncoding single bytes so typographic
 * characters (curly quotes, dashes, €, ©, …) survive extraction.
 */
export function makePdf(pageTexts: string[]): Uint8Array {
  return buildPdf(pageTexts, false);
}

/**
 * Like makePdf, but with FlateDecode-compressed content streams, as real
 * producers emit. Exercises the decompression path in extraction.
 */
export function makeCompressedPdf(pageTexts: string[]): Uint8Array {
  return buildPdf(pageTexts, true);
}

function buildPdf(pageTexts: string[], compress: boolean): Uint8Array {
  const encoder = new TextEncoder(); // ascii-only structural output
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  const push = (s: string) => {
    const b = encoder.encode(s);
    chunks.push(b);
    cursor += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    cursor += b.length;
  };

  const WIN_ANSI_EXTRA: Record<string, number> = {
    "€": 0x80,
    "‚": 0x82,
    "ƒ": 0x83,
    "„": 0x84,
    "…": 0x85,
    "†": 0x86,
    "‡": 0x87,
    "ˆ": 0x88,
    "‰": 0x89,
    "‹": 0x8b,
    "‘": 0x91,
    "’": 0x92,
    "“": 0x93,
    "”": 0x94,
    "•": 0x95,
    "–": 0x96,
    "—": 0x97,
    "˜": 0x98,
    "™": 0x99,
    "›": 0x9b,
  };

  /** Encode a content-stream string as raw WinAnsi bytes (unknown chars → "?"). */
  const encodeStreamBytes = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 128) {
        out[i] = code;
      } else if (code < 256) {
        out[i] = code;
      } else {
        out[i] = WIN_ANSI_EXTRA[s[i]] ?? 0x3f;
      }
    }
    return out;
  };

  const escape = (s: string) =>
    s
      .replace(/[\u0000-\u001F]/g, (ch) => (ch === "\n" || ch === "\t" ? " " : "?"))
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

  const wrap = (line: string, width: number): string[] => {
    const words = line.split(" ").filter((w) => w.length > 0);
    const out: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > width && current) {
        out.push(current);
        current = word;
      } else {
        current = next;
      }
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
  push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  offsets[2] = cursor;
  push(`2 0 obj\n<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);

  pageTexts.forEach((text, i) => {
    const lines = text
      .split("\n")
      .flatMap((l) => wrap(l, 80))
      .map((l) => `(${escape(l)}) Tj T*`)
      .join("\n");
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td\n${lines}\nET`;
    const rawBytes = encodeStreamBytes(stream);
    const streamBytes = compress ? deflateSync(rawBytes) : rawBytes;
    const filter = compress ? " /Filter /FlateDecode" : "";
    offsets[contentNums[i]] = cursor;
    push(`${contentNums[i]} 0 obj\n<< /Length ${streamBytes.length}${filter} >>\nstream\n`);
    pushBytes(streamBytes);
    push(`\nendstream\nendobj\n`);
    offsets[pageNums[i]] = cursor;
    push(
      `${pageNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>\nendobj\n`,
    );
  });

  offsets[fontNum] = cursor;
  push(
    `${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );

  const total = fontNum + 1;
  const xrefAt = cursor;
  push(`xref\n0 ${total}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i < total; i++) {
    push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);

  const out = new Uint8Array(cursor);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
