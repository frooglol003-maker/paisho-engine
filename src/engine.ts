// src/engine.ts
// Multi-step Arrange move gen + fast alpha–beta search + Harmony Bonus generators.
// Board indices are 1-based (1..249). coords/index helpers are 0-based (0..248).

import { performance } from "perf_hooks";
import { coordsOf, indexOf } from "./coords";
import { Board, unpackPiece, TypeId } from "./board";
import { getPieceDescriptor, planWheelRotate, planBoatOnFlower, planBoatOnAccent } from "./rules";
import { validateArrange } from "./move";
import { evaluate } from "./eval";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";

// ---------- Types ----------
export type Side = "host" | "guest";

// Arrange move: a path of 1-based indices from a source
export type PlannedArrange = { from: number; path: number[] };

// (Internal types only — not exported)
type _IndexMove = { from: number; to: number };
type _WheelPlan = { center: number; moves: _IndexMove[] };
type _BoatFlowerPlan = { boat: number; from: number; to: number };
type _BoatAccentPlan = { boat: number; target: number; remove: number[] };

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
  const cands = [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }];
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

// ---------- Search core (alpha–beta + ordering + TT + time limit) ----------
type ArrangeMove = { kind: "arrange"; from: number; path: number[] };
type WheelMove   = { kind: "wheel"; center: number };
type BoatFlower  = { kind: "boatFlower"; boat: number; from: number; to: number };
type BoatAccent  = { kind: "boatAccent"; boat: number; target: number };
type AnyMove = ArrangeMove | WheelMove | BoatFlower | BoatAccent;

type Score = number;
type TTFlag = "EXACT" | "LOWER" | "UPPER";

interface TTEntry {
  depth: number;      // remaining depth when stored
  score: Score;       // score from side-to-move POV when stored
  flag: TTFlag;
  best?: AnyMove;
}

const TT = new Map<string, TTEntry>();

function boardKey(board: Board, side: Side): string {
  const N: number = (board as any).size1Based ?? 249;
  let s = side === "host" ? "H|" : "G|";
  for (let i = 1; i <= N; i++) {
    const v = board.getAtIndex(i) || 0;
    s += v.toString(16) + ",";
  }
  return s;
}

// Forward-declared in this file; function declarations are hoisted.
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

// Make move on a cloned board and return it.
// Uses existing apply* helpers so we keep one source of truth.
function applyMoveCloned(board: Board, side: Side, mv: AnyMove): Board {
  switch (mv.kind) {
    case "arrange":     return applyPlannedArrange(board, { from: mv.from, path: mv.path });
    case "wheel":       return applyWheel(board, side, mv.center);
    case "boatFlower":  return applyBoatFlower(board, side, mv.boat, mv.from, mv.to);
    case "boatAccent":  return applyBoatAccent(board, side, mv.boat, mv.target);
  }
}

// Generate all candidate moves (arrange + bonus). Bonus are deduped and pre-checked.
function generateAllMoves(board: Board, side: Side): AnyMove[] {
  const moves: AnyMove[] = [];

  // Arrange
  try {
    for (const m of generateLegalArrangeMoves(board, side)) {
      moves.push({ kind: "arrange", from: m.from, path: m.path });
    }
  } catch {}

  // Bonus: Wheel / Boat (robust, deduped, prechecked)
  {
    const seen = new Set<string>();
    const safePush = (mv: AnyMove) => {
      const key = JSON.stringify(mv);
      if (seen.has(key)) return;
      try {
        void applyMoveCloned(board, side, mv);
        seen.add(key);
        moves.push(mv);
      } catch {
        /* ignore unplayable bonus */
      }
    };

    // Wheel
    try {
      for (const c of generateWheelBonusMoves(board, side)) {
        if (typeof c.center === "number") {
          safePush({ kind: "wheel", center: c.center });
        }
      }
    } catch { /* ignore */ }

    // Boat on flower
    try {
      for (const b of generateBoatFlowerBonusMoves(board, side)) {
        if (typeof b.boat === "number" && typeof b.from === "number" && typeof b.to === "number" && b.from !== b.to) {
          safePush({ kind: "boatFlower", boat: b.boat, from: b.from, to: b.to });
        }
      }
    } catch { /* ignore */ }

    // Boat on accent
    try {
      for (const k of generateBoatAccentBonusMoves(board, side)) {
        const target = (k as any).target as number | undefined;
        if (typeof k.boat === "number" && typeof target === "number") {
          safePush({ kind: "boatAccent", boat: k.boat, target });
        }
      }
    } catch { /* ignore */ }
  }

  return moves;
} // <<< important: close generateAllMoves

// Move ordering heuristic: shallow eval of child + center bias + short paths first.
function orderMoves(board: Board, side: Side, moves: AnyMove[]): AnyMove[] {
  const scored = moves.map(mv => {
    let landingIdx1 = -1;
    if (mv.kind === "arrange") landingIdx1 = mv.path[mv.path.length - 1];
    else if (mv.kind === "boatFlower") landingIdx1 = mv.to;

    let centerBias = 0;
    if (landingIdx1 > 0) {
      const { x, y } = coordsOf(landingIdx1 - 1);
      centerBias = -(Math.abs(x) + Math.abs(y)); // closer is better
    }

    let val = 0;
    try {
      const child = applyMoveCloned(board, side, mv);
      val = evaluate(child, side);
    } catch {
      val = -1e9; // illegal/failed moves pushed to end
    }

    const shortPathBias = mv.kind === "arrange" ? -mv.path.length : 0;
    return { mv, key: val * 1000 + centerBias * 10 + shortPathBias };
  });

  scored.sort((a, b) => b.key - a.key);
  return scored.map(s => s.mv);
}

function other(side: Side): Side { return side === "host" ? "guest" : "host"; }

interface SearchOpts {
  maxDepth: number;
  maxMs?: number; // soft time limit
}

function searchAlphaBeta(
  board: Board,
  side: Side,
  depth: number,
  alpha: Score,
  beta: Score,
  startMs: number,
  opts: SearchOpts
): { score: Score, best?: AnyMove } {
  if (opts.maxMs && performance.now() - startMs > opts.maxMs) {
    return { score: evaluate(board, side) };
  }

  const key = boardKey(board, side);
  const tt = TT.get(key);
  if (tt && tt.depth >= depth) {
    if (tt.flag === "EXACT") return { score: tt.score, best: tt.best };
    if (tt.flag === "LOWER" && tt.score > alpha) alpha = tt.score;
    else if (tt.flag === "UPPER" && tt.score < beta) beta = tt.score;
    if (alpha >= beta) return { score: tt.score, best: tt.best };
  }

  if (depth === 0) {
    return { score: evaluate(board, side) };
  }

  const moves = orderMoves(board, side, generateAllMoves(board, side));
  if (moves.length === 0) {
    return { score: evaluate(board, side) };
  }

  let best: AnyMove | undefined;
  let localAlpha = alpha;
  let value = -Infinity as Score;

  for (const mv of moves) {
    let child: Board;
    try { child = applyMoveCloned(board, side, mv); }
    catch { continue; }

    const { score: childScore } =
      searchAlphaBeta(child, other(side), depth - 1, -beta, -localAlpha, startMs, opts);

    const v = -childScore;
    if (v > value) { value = v; best = mv; }
    if (v > localAlpha) localAlpha = v;
    if (localAlpha >= beta) break; // beta cutoff
  }

  // Store in TT
  let flag: TTFlag = "EXACT";
  if (value <= alpha) flag = "UPPER";
  else if (value >= beta) flag = "LOWER";
  TT.set(key, { depth, score: value, flag, best });

  return { score: value, best };
}

// Iterative deepening wrapper with optional time limit.
function searchIterativeDeepening(
  board: Board,
  side: Side,
  maxDepth: number,
  maxMs?: number
): AnyMove | null {
  TT.clear();
  const start = performance.now();
  let lastBest: AnyMove | null = null;

  for (let d = 1; d <= maxDepth; d++) {
    const { best } = searchAlphaBeta(board, side, d, -Infinity, Infinity, start, { maxDepth, maxMs });
    if (best) lastBest = best;
    if (maxMs && performance.now() - start > maxMs) break;
  }
  return lastBest;
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

// ---------- Public search entry ----------
export function pickBestMove(board: Board, side: Side, depth: number, opts?: { maxMs?: number }) {
  const move = searchIterativeDeepening(board, side, depth, opts?.maxMs);
  return move || null;
}

// ---------------- Harmony Bonus move generation ----------------
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
      const isAccent =
        d.type === TypeId.Rock || d.type === TypeId.Wheel || d.type === TypeId.Boat || d.type === TypeId.Knotweed;
      if (!isAccent) continue;
      if (d.type === TypeId.Boat) continue; // must be a non-boat accent

      const res = planBoatOnAccent(board, target, b);
      if (res.ok) out.push({ boat: b, target, remove: res.remove.map(r => r.remove) });
    }
  }
  return out;
}
