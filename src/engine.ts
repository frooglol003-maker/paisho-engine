// src/engine.ts
// Multi-step Arrange move gen + tiny negamax search + Harmony Bonus generators.
// NOTE: Board indices are 1-based (1..249). coords/index helpers are 0-based (0..248).

import { coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor, planWheelRotate, planBoatOnFlower, planBoatOnAccent } from "./rules";
import { validateArrange } from "./move";
import { evaluate } from "./eval";

// ---------- Types ----------
export type Side = "host" | "guest";
// Arrange move: a path of 1-based indices from a source
export type PlannedArrange = { from: number; path: number[] };

// (Internal types only — do NOT export to avoid name clashes with rules.ts)
type _IndexMove = { from: number; to: number };
type _WheelPlan = { center: number; moves: _IndexMove[] };
type _BoatFlowerPlan = { boat: number; from: number; to: number };
type _BoatAccentPlan = { boat: number; remove: number[] };

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
      const t0 = indexOf(x + dx, y + dy);
      if (t0 !== -1) yield t0 + 1;
    }
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

    const limit =
      desc.kind === "basic" ? desc.number :
      desc.kind === "lotus" ? 2 :
      desc.kind === "orchid" ? 6 : 0;
    if (limit <= 0) continue;

    const seen = new Set<number>([i]);
    function dfs(path: number[]) {
      if (path.length > limit) return;

      // validate full path as an Arrange move
      if (path.length > 0) {
        const valid = validateArrange(board, i, path);
        if (valid.ok) out.push({ from: i, path: path.slice() });
      }

      if (path.length === limit) return;

      const last = path.length ? path[path.length - 1] : i;
      for (const nxt of orthoNeighbors1(last)) {
        if (seen.has(nxt)) continue;
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
    const v = -negamax(child, opposite(side), depth - 1, -beta, -alpha);
    if (v > value) value = v;
    if (value > alpha) alpha = value;
    if (alpha >= beta) break;
  }
  return value;
}

// ---------------- Harmony Bonus move generation (append-only) ----------------
// These are exposed as functions but keep their plan types internal to avoid export name clashes.

export function generateWheelBonusMoves(board: Board, side: Side): _WheelPlan[] {
  const out: _WheelPlan[] = [];
  const N = (board as any).size1Based ?? 249;
  for (let i = 1; i <= N; i++) {
    if (!owns(board, i, side)) continue;
    if (!isType(board, i, TypeId.Wheel)) continue;
    const plan = planWheelRotate(board, i);
    if (plan.ok) out.push({ center: i, moves: plan.moves as _IndexMove[] });
  }
  return out;
}

export function generateBoatFlowerBonusMoves(board: Board, side: Side): _BoatFlowerPlan[] {
  const out: _BoatFlowerPlan[] = [];
  const N = (board as any).size1Based ?? 249;

  for (let b = 1; b <= N; b++) {
    if (!owns(board, b, side)) continue;
    if (!isType(board, b, TypeId.Boat)) continue;

    for (let f = 1; f <= N; f++) {
      const p = board.getAtIndex(f);
      if (!p) continue;
      const d = unpackPiece(p)!;
      const isFlower =
        d.type === TypeId.R3 || d.type === TypeId.R4 || d.type === TypeId.R5 ||
        d.type === TypeId.W3 || d.type === TypeId.W4 || d.type === TypeId.W5 ||
        d.type === TypeId.Lotus || d.type === TypeId.Orchid;
      if (!isFlower) continue;

      for (const to of neighbors8(f)) {
        const plan = planBoatOnFlower(board, f, to);
        if (plan.ok) out.push({ boat: b, from: f, to });
      }
    }
  }
  return out;
}

export function generateBoatAccentBonusMoves(board: Board, side: Side): _BoatAccentPlan[] {
  const out: _BoatAccentPlan[] = [];
  const N = (board as any).size1Based ?? 249;

  for (let b = 1; b <= N; b++) {
    if (!owns(board, b, side)) continue;
    if (!isType(board, b, TypeId.Boat)) continue;

    for (const target of neighbors8(b)) {
      const p = board.getAtIndex(target);
      if (!p) continue;
      const d = unpackPiece(p)!;
      const isAccent = (
        d.type === TypeId.Rock || d.type === TypeId.Wheel || d.type === TypeId.Boat || d.type === TypeId.Knotweed
      );
      if (!isAccent) continue;
      if (d.type === TypeId.Boat) continue;

      const res = planBoatOnAccent(board, target, b);
      if (res.ok) out.push({ boat: b, remove: res.remove.map(r => r.remove) });
    }
  }
  return out;
}
