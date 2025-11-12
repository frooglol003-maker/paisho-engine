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
// ---------------- Harmony Bonus move generation (append-only) ----------------

import {
  planWheelRotate,
  planBoatOnFlower,
  planBoatOnAccent,
  isGateCoord,
  getPieceDescriptor,
} from "./rules";
import { coordsOf } from "./coords";
import { TypeId, unpackPiece } from "./board";

// Types for bonus plans (no board mutation here)
export type IndexMove = { from: number; to: number };
export type WheelPlan = { center: number; moves: IndexMove[] }; // rotate 8 neighbors
export type BoatFlowerPlan = { boat: number; from: number; to: number }; // move a flower 1 step
export type BoatAccentPlan = { boat: number; remove: number[] }; // remove boat + target accent

function owns(board: Board, idx1: number, side: Side): boolean {
  const p = board.getAtIndex(idx1);
  if (!p) return false;
  const d = unpackPiece(p)!;
  return side === "host" ? d.owner === 0 : d.owner === 1;
}

function isType(board: Board, idx1: number, t: TypeId): boolean {
  const p = board.getAtIndex(idx1);
  if (!p) return false;
  const d = unpackPiece(p)!;
  return d.type === t;
}

function* neighbors8(idx1: number): Iterable<number> {
  const { x, y } = coordsOf(idx1 - 1);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const tx = x + dx, ty = y + dy;
      const t0 = indexOf(tx, ty);
      if (t0 !== -1) yield t0 + 1;
    }
  }
}

/**
 * Generate all valid Wheel rotations for `side`.
 * NOTE: Real rules only allow bonus after making a harmony; this function just lists what
 * would be legal *if* a Wheel bonus is available.
 */
export function generateWheelBonusMoves(board: Board, side: Side): WheelPlan[] {
  const out: WheelPlan[] = [];
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    if (!owns(board, i, side)) continue;
    if (!isType(board, i, TypeId.Wheel)) continue;
    const plan = planWheelRotate(board, i);
    if (plan.ok) out.push({ center: i, moves: plan.moves });
  }
  return out;
}

/**
 * Generate all valid Boat-on-flower bonus moves for `side`.
 * Moves a BLOOMING flower by 1 (8-neighborhood), cannot land in gates or on occupied squares.
 */
export function generateBoatFlowerBonusMoves(board: Board, side: Side): BoatFlowerPlan[] {
  const out: BoatFlowerPlan[] = [];
  const N = (board as any).size1Based ?? 249;

  for (let b = 1; b <= N; b++) {
    if (!owns(board, b, side)) continue;
    if (!isType(board, b, TypeId.Boat)) continue;

    // A Boat can target a BLOOMING flower (any owner per standard rules for bonus).
    for (let f = 1; f <= N; f++) {
      const p = board.getAtIndex(f);
      if (!p) continue;
      const d = unpackPiece(p)!;
      const isFlower =
        d.type === TypeId.R3 || d.type === TypeId.R4 || d.type === TypeId.R5 ||
        d.type === TypeId.W3 || d.type === TypeId.W4 || d.type === TypeId.W5 ||
        d.type === TypeId.Lotus || d.type === TypeId.Orchid;
      if (!isFlower) continue;

      // Try each adjacent target for that flower
      for (const to of neighbors8(f)) {
        const plan = planBoatOnFlower(board, f, to);
        if (plan.ok) out.push({ boat: b, from: f, to });
      }
    }
  }
  return out;
}

/**
 * Generate all valid Boat-on-accent bonus actions for `side`.
 * Removes the targeted accent AND the boat itself.
 */
export function generateBoatAccentBonusMoves(board: Board, side: Side): BoatAccentPlan[] {
  const out: BoatAccentPlan[] = [];
  const N = (board as any).size1Based ?? 249;

  for (let b = 1; b <= N; b++) {
    if (!owns(board, b, side)) continue;
    if (!isType(board, b, TypeId.Boat)) continue;

    // Boat can target any adjacent non-boat accent
    for (const target of neighbors8(b)) {
      const p = board.getAtIndex(target);
      if (!p) continue;
      const d = unpackPiece(p)!;
      const isAccent = (
        d.type === TypeId.Rock || d.type === TypeId.Wheel || d.type === TypeId.Boat || d.type === TypeId.Knotweed
      );
      if (!isAccent) continue;
      if (d.type === TypeId.Boat) continue; // planner disallows boating a boat

      const res = planBoatOnAccent(board, target, b);
      if (res.ok) out.push({ boat: b, remove: res.remove.map(r => r.remove) });
    }
  }
  return out;
}
