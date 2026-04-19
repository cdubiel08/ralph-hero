/**
 * RecursiveCharacterTextSplitter-style chunker.
 *
 * Splits long text into overlapping chunks while preserving the original
 * character offsets (charStart, charEnd) so downstream code can reconstruct
 * positions. Mirrors the semantics of LangChain's RecursiveCharacterTextSplitter:
 * tries each separator in order, snapping chunk boundaries to the highest-priority
 * separator that keeps pieces under chunkSize.
 *
 * Defaults correspond to 512-token chunks with 64-token overlap
 * (approx: 1 token ~= 4 chars for English text).
 */

export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkerOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
}

const DEFAULT_CHUNK_SIZE = 2048;
const DEFAULT_CHUNK_OVERLAP = 256;
const DEFAULT_SEPARATORS: string[] = ["\n\n", "\n", ". ", " ", ""];

/**
 * A piece of the original text with an absolute offset back to the source.
 * Used as the internal working type while recursing through separators.
 */
interface Piece {
  text: string;
  start: number;
}

/**
 * Pick the first separator from `separators` that occurs in `piece.text`.
 * Falls back to the last separator (typically `""`) if none match — this is
 * the sentinel that lets us character-split oversized pieces with no natural
 * boundary.
 */
function pickSeparator(pieceText: string, separators: string[]): {
  separator: string;
  remaining: string[];
} {
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i]!;
    if (sep === "") {
      return { separator: sep, remaining: separators.slice(i + 1) };
    }
    if (pieceText.includes(sep)) {
      return { separator: sep, remaining: separators.slice(i + 1) };
    }
  }
  // Should be unreachable when DEFAULT_SEPARATORS ends with "".
  return { separator: "", remaining: [] };
}

/**
 * Split a piece on `separator` while retaining absolute char offsets.
 * When separator is empty, split into single-character pieces.
 */
function splitOnSeparator(piece: Piece, separator: string): Piece[] {
  if (separator === "") {
    const out: Piece[] = [];
    for (let i = 0; i < piece.text.length; i++) {
      out.push({ text: piece.text[i]!, start: piece.start + i });
    }
    return out;
  }

  const out: Piece[] = [];
  let cursor = 0;
  let idx = piece.text.indexOf(separator, cursor);
  while (idx !== -1) {
    // Keep the separator attached to the preceding piece so reconstruction
    // via text.slice(charStart, charEnd) works bit-for-bit.
    const sliceEnd = idx + separator.length;
    out.push({
      text: piece.text.slice(cursor, sliceEnd),
      start: piece.start + cursor,
    });
    cursor = sliceEnd;
    idx = piece.text.indexOf(separator, cursor);
  }
  if (cursor < piece.text.length) {
    out.push({
      text: piece.text.slice(cursor),
      start: piece.start + cursor,
    });
  }
  return out;
}

/**
 * Recursively flatten a piece into "atoms" — pieces small enough to merge
 * greedily into chunks. Pieces larger than chunkSize are split with the next
 * separator in line; pieces that fit are returned as-is.
 */
function flattenToAtoms(
  piece: Piece,
  separators: string[],
  chunkSize: number,
): Piece[] {
  if (piece.text.length <= chunkSize) {
    return [piece];
  }
  const { separator, remaining } = pickSeparator(piece.text, separators);
  const splits = splitOnSeparator(piece, separator);

  // If the separator didn't actually reduce the piece (e.g., no occurrence),
  // fall through to the next separator with the original piece.
  if (splits.length <= 1) {
    if (remaining.length === 0) {
      // No more separators — return whatever we have, even if oversized.
      return [piece];
    }
    return flattenToAtoms(piece, remaining, chunkSize);
  }

  const out: Piece[] = [];
  for (const sub of splits) {
    if (sub.text.length <= chunkSize) {
      out.push(sub);
    } else if (remaining.length > 0) {
      for (const leaf of flattenToAtoms(sub, remaining, chunkSize)) {
        out.push(leaf);
      }
    } else {
      // Last-resort: character-split oversized atom so we never return a
      // single atom larger than chunkSize.
      out.push(...splitOnSeparator(sub, ""));
    }
  }
  return out;
}

/**
 * Build a chunk object from a contiguous run of atoms.
 * `charStart` is taken from the first atom, `charEnd` from the last atom's
 * end boundary, and `content` is `text.slice(start, end)` — this guarantees
 * `text.slice(charStart, charEnd) === content`.
 */
function buildChunk(
  originalText: string,
  atoms: Piece[],
  index: number,
): Chunk {
  const first = atoms[0]!;
  const last = atoms[atoms.length - 1]!;
  const charStart = first.start;
  const charEnd = last.start + last.text.length;
  return {
    index,
    content: originalText.slice(charStart, charEnd),
    charStart,
    charEnd,
  };
}

/**
 * Compute the start position for the next chunk's atoms given the previous
 * chunk ended at `prevEnd`. We walk backward through the atom list to find
 * the atom whose start >= prevEnd - chunkOverlap; that atom begins the
 * overlap region.
 */
function findOverlapStartIndex(
  atoms: Piece[],
  lastEndAtomIndex: number,
  prevEnd: number,
  chunkOverlap: number,
): number {
  if (chunkOverlap <= 0) {
    return lastEndAtomIndex + 1;
  }
  const targetStart = prevEnd - chunkOverlap;
  // Find the earliest atom in [0..lastEndAtomIndex] whose start >= targetStart.
  let overlapAtomIdx = lastEndAtomIndex + 1;
  for (let i = lastEndAtomIndex; i >= 0; i--) {
    if (atoms[i]!.start >= targetStart) {
      overlapAtomIdx = i;
    } else {
      break;
    }
  }
  // If overlap produced no progress (no atoms found), step forward to avoid
  // an infinite loop.
  if (overlapAtomIdx > lastEndAtomIndex) {
    overlapAtomIdx = lastEndAtomIndex + 1;
  }
  return overlapAtomIdx;
}

/**
 * Split `text` into overlapping chunks.
 *
 * Semantics:
 * - Empty input -> empty array.
 * - Short input (<= chunkSize) -> single chunk covering the whole text.
 * - For each chunk, `text.slice(charStart, charEnd) === content`.
 * - `charStart` is monotonically non-decreasing across chunks.
 * - Consecutive chunks overlap by ~`chunkOverlap` chars (snapped to atom
 *   boundaries; may differ by up to the largest atom size).
 * - Each chunk's content length is bounded by chunkSize + a small slack for
 *   the separator that snapped the boundary.
 */
export function chunkText(text: string, opts: ChunkerOptions = {}): Chunk[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const separators = opts.separators ?? DEFAULT_SEPARATORS;

  if (text.length === 0) {
    return [];
  }

  if (chunkOverlap >= chunkSize) {
    throw new Error(
      `chunker: chunkOverlap (${chunkOverlap}) must be smaller than chunkSize (${chunkSize})`,
    );
  }

  // Fast path for short docs — no need to walk separators.
  if (text.length <= chunkSize) {
    return [
      {
        index: 0,
        content: text,
        charStart: 0,
        charEnd: text.length,
      },
    ];
  }

  const atoms = flattenToAtoms({ text, start: 0 }, separators, chunkSize);

  const chunks: Chunk[] = [];
  let chunkIdx = 0;
  let i = 0;

  while (i < atoms.length) {
    // Greedily pack atoms into this chunk until adding one more would push
    // the chunk content past chunkSize.
    let runLen = 0;
    let j = i;
    while (j < atoms.length) {
      const atomLen = atoms[j]!.text.length;
      // Always include at least one atom per chunk to ensure progress.
      if (j > i && runLen + atomLen > chunkSize) {
        break;
      }
      runLen += atomLen;
      j++;
    }
    const runAtoms = atoms.slice(i, j);
    const chunk = buildChunk(text, runAtoms, chunkIdx);
    chunks.push(chunk);
    chunkIdx++;

    if (j >= atoms.length) {
      break;
    }

    // Compute overlap start for the next chunk.
    const lastEndAtomIdx = j - 1;
    const nextStart = findOverlapStartIndex(
      atoms,
      lastEndAtomIdx,
      chunk.charEnd,
      chunkOverlap,
    );
    i = nextStart;
  }

  return chunks;
}
