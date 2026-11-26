/**
 * Excerpt locating over PDF text-layer strings. The backend verifies
 * excerpts whitespace-tolerantly and case-insensitively without storing
 * offsets, so the viewer re-finds them the same way at render time and maps
 * matches back to exact character ranges for highlighting. DOM-free: the
 * viewer walks its own text nodes with these ranges.
 */

/** Minimum normalized excerpt length worth searching for. */
export const MIN_SEARCHABLE_EXCERPT_CHARS = 10;

export interface CharRange {
  /** Inclusive start offset in the original (unnormalized) string. */
  start: number;
  /** Exclusive end offset in the original (unnormalized) string. */
  end: number;
}

function normalizeChar(char: string): string | null {
  // Mirror the backend's whitespace-tolerant, case-insensitive match:
  // every whitespace run collapses to one space, then lowercase.
  if (/\s/.test(char)) {
    return " ";
  }
  return char.toLowerCase();
}

interface NormalizedText {
  text: string;
  /** Source offset of each normalized char (runs map to first source char). */
  map: number[];
}

function normalizeWithMap(value: string): NormalizedText {
  let text = "";
  const map: number[] = [];
  let pendingSpace = -1;
  for (let index = 0; index < value.length; index += 1) {
    const normalized = normalizeChar(value[index] as string);
    if (normalized === " ") {
      if (pendingSpace === -1) {
        pendingSpace = index;
      }
      continue;
    }
    if (pendingSpace !== -1) {
      if (text !== "") {
        text += " ";
        map.push(pendingSpace);
      }
      pendingSpace = -1;
    }
    text += normalized;
    map.push(index);
  }
  return { text, map };
}

/**
 * Find every non-overlapping occurrence of `excerpt` in `haystack`,
 * returned as original-space ranges (trailing whitespace excluded: the end
 * bound is the first unmatched char). Returns [] when the excerpt is too
 * short to search reliably or occurs nowhere.
 */
export function findExcerptRanges(haystack: string, excerpt: string): CharRange[] {
  const needle = normalizeWithMap(excerpt).text;
  if (needle.length < MIN_SEARCHABLE_EXCERPT_CHARS) {
    return [];
  }
  const hay = normalizeWithMap(haystack);
  const ranges: CharRange[] = [];
  let from = 0;
  for (;;) {
    const at = hay.text.indexOf(needle, from);
    if (at === -1) {
      return ranges;
    }
    const start = hay.map[at] as number;
    const end = (hay.map[at + needle.length - 1] as number) + 1;
    ranges.push({ start, end });
    from = at + needle.length;
  }
}

/**
 * Map a stored finding page to a real PDF page. Stored pages are relative
 * to the trimmed extraction text; the document's page offset restores the
 * leading blank pages. Returns null when the finding cites no page.
 * Clamps into the document when its length is known; otherwise floors at 1.
 */
export function storedPageToPdfPage(
  storedPage: number | null,
  pageOffset: number | undefined,
  numPages: number | null,
): number | null {
  if (storedPage === null) {
    return null;
  }
  const offset = pageOffset ?? 0;
  const unclamped = storedPage + offset;
  if (numPages === null || numPages < 1) {
    return Math.max(1, unclamped);
  }
  return Math.min(Math.max(1, unclamped), numPages);
}

/**
 * Join per-item text-layer strings into one searchable string while
 * remembering which char offsets belong to which item index. Ranges from
 * `findExcerptRanges` over the joined text map back through `itemAt`.
 */
export interface JoinedLayerText {
  text: string;
  itemAt: number[];
}

export function joinLayerItems(items: string[]): JoinedLayerText {
  return joinLayerItemsWithBreaks(items, items.map(() => false));
}

/**
 * Join text-layer strings the way extraction joins content items: a newline
 * after every end-of-line item, direct concatenation elsewhere. The newline
 * maps to its preceding item so matches spanning the break stay contiguous;
 * highlighters clamp to real div text, so the synthetic break itself never
 * paints. `breaks` shorter than `items` means no break (graceful).
 */
export function joinLayerItemsWithBreaks(items: string[], breaks: boolean[]): JoinedLayerText {
  let text = "";
  const itemAt: number[] = [];
  items.forEach((item, itemIndex) => {
    for (let index = 0; index < item.length; index += 1) {
      itemAt.push(itemIndex);
    }
    text += item;
    if (breaks[itemIndex] === true) {
      itemAt.push(itemIndex);
      text += "\n";
    }
  });
  return { text, itemAt };
}
