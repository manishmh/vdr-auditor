import type { PageText } from "../pdf/extract";

export interface TextSection {
  id: string;
  text: string;
  pageStart: number;
  pageEnd: number;
}

export interface ChunkOptions {
  /** Preferred maximum section size. Never splits mid-paragraph below this. */
  maxChars?: number;
  /** Overlap applied only when a single paragraph exceeds maxChars. */
  hardSplitOverlap?: number;
}

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_OVERLAP = 200;

/** Paragraphs that look like clause/section headings; preferred section starts. */
const KEYWORD_HEADING =
  /^(section|article|clause|schedule|exhibit|appendix|part)\b|^§\s*\d|^\d+(\.\d+){0,4}[.)]\s+\S/i;
const CAPS_HEADING = /^[A-Z][A-Z0-9 ,;:'"()&/-]{8,120}$/;

interface Paragraph {
  text: string;
  page: number;
  isHeading: boolean;
}

function toParagraphs(pages: PageText[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const page of pages) {
    for (const raw of page.text.split(/\n{2,}|\r?\n\s*\r?\n/)) {
      const text = raw.replace(/[ \t]+/g, " ").replace(/\n/g, " ").trim();
      if (!text) continue;
      const firstLine = text.slice(0, 160);
      const isHeading = KEYWORD_HEADING.test(firstLine) || CAPS_HEADING.test(firstLine);
      out.push({ text, page: page.pageNumber, isHeading });
    }
  }
  return out;
}

/**
 * Divide page texts into sections without cutting clauses when avoidable:
 * splits happen at paragraph boundaries (preferably clause headings), and a
 * paragraph longer than maxChars is hard-split with a small overlap.
 * Page ranges are tracked per section for server-side citation.
 */
export function splitIntoSections(pages: PageText[], options: ChunkOptions = {}): TextSection[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = Math.min(options.hardSplitOverlap ?? DEFAULT_OVERLAP, Math.floor(maxChars / 2));
  const paragraphs = toParagraphs(pages);
  const sections: TextSection[] = [];

  let current: Paragraph[] = [];
  let currentLen = 0;
  const flush = () => {
    if (current.length === 0) return;
    sections.push({
      id: `s${sections.length + 1}`,
      text: current.map((p) => p.text).join("\n\n"),
      pageStart: current[0].page,
      pageEnd: current[current.length - 1].page,
    });
    current = [];
    currentLen = 0;
  };

  for (const para of paragraphs) {
    if (para.text.length > maxChars) {
      flush();
      let start = 0;
      while (start < para.text.length) {
        const end = Math.min(start + maxChars, para.text.length);
        sections.push({
          id: `s${sections.length + 1}`,
          text: para.text.slice(start, end),
          pageStart: para.page,
          pageEnd: para.page,
        });
        if (end === para.text.length) break;
        const next = end - overlap;
        start = next > start ? next : end;
      }
      continue;
    }
    const wouldExceed = currentLen + para.text.length + 2 > maxChars;
    if (current.length > 0 && (wouldExceed || (para.isHeading && currentLen > maxChars / 4))) {
      flush();
    }
    current.push(para);
    currentLen += para.text.length + 2;
  }
  flush();
  return sections;
}
