// src/engine.ts
// Legal move gen (Arrange, orthogonal one-step), apply, and a tiny negamax search.

import { coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor } from "./rules";
import { validateArrange, buildHarmonyGraph } from "./move";
import { evaluate } from "./eval";

// ---------- Types ----------
export type Side = "host" | "guest";
export type PlannedMove = { from: number; to: number };

// ---------- Helpers ----------
function opposite(side: Side): Side {
  return side === "host" ? "guest" : "host";
}

function belongsTo(packed: number | null, side: Side): boolean {
  if (!packed) return false;
  const dec = unpackPiece(packed)!;
  return side === "host" ? dec.owner === 0 : dec.owner === 1;
}

function* orthogonalNeighbors1(idx1: number): Iterable<number> {
  const { x, y } = coordsOf(idx1 - 1); // coords want 0-based
  const cands = [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ];
  for (const c of cands) {
    const t0 = indexOf(c.x, c.y);     // 0-based index
    if (t0 !== -1) yield t0 + 1;      // convert to 1-based for Board
  }
}

// ---------- Move gen (Arrange, 1-step orthogonal) ----------
export function generateLegalArrangeMoves(board: Board, side: Side): PlannedMove[] {
  const out: PlannedMove[] = [];
  const N = (board as any).size1Based ?? 249; // if Board exposes, else 249

  for (let i = 1; i <= N; i++) {
    const packed = board.getAtIndex(i);
    if (!belongsTo(packed, side)) continue;

    // only flowers can arrange
    const desc = getPieceDescriptor(board, i);
    if (desc.kind !== "basic" && desc.kind !== "lotus" && desc.kind !== "orchid") continue;

    for (const t of orthogonalNeighbors1(i)) {
      // our validate takes a path of 1-based indices; one-step path = [t]
      const result = validateArrange(board, i, [t]);
      if (result.ok) out.push({ from: i, to: t });
    }
  }

  return out;
}

// ---------- Apply (pure-ish: returns a cloned board) ----------
export function applyPlannedMove(board: Board, mv: PlannedMove): Board {
  const cloned = board.clone();
  const piece = cloned.getAtIndex(mv.from);
  const dest = cloned.getAtIndex(mv.to);
  // clear source
  cloned.setAtIndex(mv.from, 0);
  // capture if any
  if (dest) cloned.setAtIndex(mv.to, 0);
  // place mover
  if (piece) cloned.setAtIndex(mv.to, piece);
  return cloned;
}

// ---------- Search (negamax with alpha-beta) ----------
export function pickBestMove(board: Board, side: Side, depth = 2): PlannedMove | null {
  const moves = generateLegalArrangeMoves(board, side);
  if (moves.length === 0) return null;

  let bestScore = -Infinity;
  let best: PlannedMove | null = null;
  let alpha = -Infinity;
  const beta = Infinity;

  for (const mv of moves) {
    const child = applyPlannedMove(board, mv);
    const score = -negamax(child, opposite(side), depth - 1, -beta, -alpha);
    if (score > bestScore) {
      bestScore = score;
      best = mv;
      if (score > alpha) alpha = score;
    }
  }

  return best;
}

function negamax(board: Board, side: Side, depth: number, alpha: number, beta: number): number {
  if (depth <= 0) {
    return evaluate(board, side);
  }

  const moves = generateLegalArrangeMoves(board, side);
  if (moves.length === 0) {
    // no moves = bad
    return -1e6;
  }

  let value = -Infinity;

  for (const mv of moves) {
    const child = applyPlannedMove(board, mv);
    const v = -negamax(child, opposite(side), depth - 1, -beta, -alpha);
    if (v > value) value = v;
    if (value > alpha) alpha = value;
    if (alpha >= beta) break; // alpha-beta cutoff
  }

  return value;
}
