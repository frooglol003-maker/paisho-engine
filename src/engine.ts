// src/engine.ts
// Multi-step Arrange move gen using validateArrange + tiny negamax.

import { coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor } from "./rules";
import { validateArrange, buildHarmonyGraph } from "./move";
import { evaluate } from "./eval";

// ---------- Types ----------
export type Side = "host" | "guest";
// A planned Arrange move is a path of 1-based indices (final square is path[path.length-1])
export type PlannedArrange = { from: number; path: number[] };

// ---------- Helpers ----------
function opposite(s: Side): Side { return s === "host" ? "guest" : "host"; }
function belongsTo(packed: number | null, side: Side): boolean {
  if (!packed) return false;
  const dec = unpackPiece(packed)!;
  return side === "host" ? dec.owner === 0 : dec.owner === 1;
}

// Generate all simple orthogonal neighbors (1 step) as 1-based indices
function* orthoNeighbors1(idx1: number): Iterable<number> {
  const { x, y } = coordsOf(idx1 - 1);
  const cands = [{x:x+1,y},{x:x-1,y},{x,y:y+1},{x,y:y-1}];
  for (const c of cands) {
    const t0 = indexOf(c.x, c.y);
    if (t0 !== -1) yield t0 + 1;
  }
}

// ---------- Move gen (multi-step Arrange via DFS bounded by tile limit) ----------
export function generateLegalArrangeMoves(board: Board, side: Side): PlannedArrange[] {
  const out: PlannedArrange[] = [];
  const N = (board as any).size1Based ?? 249;

  for (let i = 1; i <= N; i++) {
    const packed = board.getAtIndex(i);
    if (!belongsTo(packed, side)) continue;

    const desc = getPieceDescriptor(board, i);
    if (desc.kind !== "basic" && desc.kind !== "lotus" && desc.kind !== "orchid") continue;

    // movement limit by piece
    const limit =
      desc.kind === "basic" ? desc.number :
      desc.kind === "lotus" ? 2 :
      desc.kind === "orchid" ? 6 : 0;
    if (limit <= 0) continue;

    // DFS over orthogonal steps up to limit, with no revisits
    const seen = new Set<number>([i]);
    function dfs(path: number[]) {
      if (path.length > limit) return;
      // validate the whole path as an Arrange move
      const valid = validateArrange(board, i, path);
      if (valid.ok && path.length > 0) out.push({ from: i, path: path.slice() });

      if (path.length === limit) return;

      const last = path.length ? path[path.length - 1] : i;
      for (const nxt of orthoNeighbors1(last)) {
        if (seen.has(nxt)) continue;
        // We allow stepping through empties only; validateArrange will catch blocks,
        // but pruning here reduces branching if the square is currently occupied and not final.
        const occ = board.getAtIndex(nxt);
        // You *can* capture on final, but not pass through a piece:
        // So we still explore; validateArrange will reject if it's intermediate.
        seen.add(nxt);
        path.push(nxt);
        dfs(path);
        path.pop();
        seen.delete(nxt);
      }
    }
    dfs([]);
  }

  return out;
}

// ---------- Apply (returns cloned board) ----------
export function applyPlannedArrange(board: Board, mv: PlannedArrange): Board {
  // assume caller already validated; use final square only
  const final1 = mv.path[mv.path.length - 1];
  const cloned = board.clone();
  const piece = cloned.getAtIndex(mv.from);
  const dest  = cloned.getAtIndex(final1);
  cloned.setAtIndex(mv.from, 0);
  if (dest) cloned.setAtIndex(final1, 0);
  if (piece) cloned.setAtIndex(final1, piece);
  return cloned;
}

// ---------- Search (negamax on Arrange moves) ----------
export function pickBestMove(board: Board, side: Side, depth = 2): PlannedArrange | null {
  const moves = generateLegalArrangeMoves(board, side);
  if (moves.length === 0) return null;

  let bestScore = -Infinity;
  let best: PlannedArrange | null = null;
  let alpha = -Infinity;
  const beta = Infinity;

  for (const mv of moves) {
    const child = applyPlannedArrange(board, mv);
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
  if (depth <= 0) return evaluate(board, side);

  const moves = generateLegalArrangeMoves(board, side);
  if (moves.length === 0) return -1e6;

  let value = -Infinity;
  for (const mv of moves) {
    const child = applyPlannedArrange(board, mv);
    const v = -negamax(child, side === "host" ? "guest" : "host", depth - 1, -beta, -alpha);
    if (v > value) value = v;
    if (value > alpha) alpha = value;
    if (alpha >= beta) break;
  }
  return value;
}
