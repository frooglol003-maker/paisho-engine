// src/engine.ts
// Multi-step Arrange move gen + fast alpha–beta search + Harmony Bonus generators,
// with ring wins as primary and alt-win (cross-midline harmony) as secondary.

import { performance } from "perf_hooks";
import { coordsOf, NEIGHBORS4_1, NEIGHBORS8_1 } from "./coords";
import { Board, unpackPiece, TypeId, Owner } from "./board";
import {
  getPieceDescriptor,
  planWheelRotate,
  planBoatOnFlower,
  planBoatOnAccent,
} from "./rules";
import {
  validateArrange,
  detectAnyClash,
  buildHarmonyGraph,
  getRingOwners,
} from "./move";
import { evaluate } from "./eval";
import { applyWheel, applyBoatFlower, applyBoatAccent } from "./parse";
import { Z_PIECE, Z_SIDE, xor64, key64 } from "./zobrist";

// ---------- Basic types ----------
export type Side = "host" | "guest";

// Arrange move: a path of 1-based indices from a source
export type PlannedArrange = { from: number; path: number[] };

// (Internal types only — not exported)
type _IndexMove = { from: number; to: number };
type _WheelPlan = { center: number; moves: _IndexMove[] };
type _BoatFlowerPlan = { boat: number; from: number; to: number };
type _BoatAccentPlan = { boat: number; target: number; remove: number[] };

// Core move kinds
type ArrangeMove = { kind: "arrange"; from: number; path: number[] };
type WheelMove = { kind: "wheel"; center: number };
type BoatFlower = { kind: "boatFlower"; boat: number; from: number; to: number };
type BoatAccent = { kind: "boatAccent"; boat: number; target: number };

// Public move type (exported for external use, e.g. self-play / UI)
export type EngineMove = ArrangeMove | WheelMove | BoatFlower | BoatAccent;

// Internal alias
type AnyMove = EngineMove;

// ---------- Helpers ----------
function opposite(s: Side): Side {
  return s === "host" ? "guest" : "host";
}

function sideToOwner(side: Side): Owner {
  return side === "host" ? Owner.Host : Owner.Guest;
}

function belongsTo(packed: number | null, side: Side): boolean {
  if (!packed) return false;
  const dec = unpackPiece(packed)!;
  return side === "host" ? dec.owner === Owner.Host : dec.owner === Owner.Guest;
}

function owns(board: Board, idx1: number, side: Side): boolean {
  const p = board.getAtIndex(idx1);
  if (!p) return false;
  const d = unpackPiece(p)!;
  return side === "host" ? d.owner === Owner.Host : d.owner === Owner.Guest;
}

function isType(board: Board, idx1: number, t: TypeId): boolean {
  const p = board.getAtIndex(idx1);
  if (!p) return false;
  const d = unpackPiece(p)!;
  return d.type === t;
}

function other(side: Side): Side {
  return side === "host" ? "guest" : "host";
}

function isStandardFlower(t: TypeId): boolean {
  return (
    t === TypeId.R3 ||
    t === TypeId.R4 ||
    t === TypeId.R5 ||
    t === TypeId.W3 ||
    t === TypeId.W4 ||
    t === TypeId.W5
  );
}

// ---------- Zobrist-based position key ----------
export function boardKey(board: Board, side: Side): string {
  const N: number = (board as any).size1Based ?? 249;
  let h: [number, number] = [0, 0];
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    // inline unpack for speed
    const type = (p & 0x0f) as TypeId;
    const owner = ((p >> 4) & 0x01) ? Owner.Guest : Owner.Host;

    let tIdx = -1;
    switch (type) {
      case TypeId.R3: tIdx = 0; break;
      case TypeId.R4: tIdx = 1; break;
      case TypeId.R5: tIdx = 2; break;
      case TypeId.W3: tIdx = 3; break;
      case TypeId.W4: tIdx = 4; break;
      case TypeId.W5: tIdx = 5; break;
      case TypeId.Lotus: tIdx = 6; break;
      case TypeId.Orchid: tIdx = 7; break;
      case TypeId.Rock: tIdx = 8; break;
      case TypeId.Wheel: tIdx = 9; break;
      case TypeId.Boat: tIdx = 10; break;
      case TypeId.Knotweed: tIdx = 11; break;
      default:
        continue; // Empty / unknown
    }
    const oIdx = owner === Owner.Host ? 0 : 1;
    h = xor64(h, Z_PIECE[i][tIdx][oIdx]);
  }
  if (side === "guest") h = xor64(h, Z_SIDE);
  return key64(h);
}

// ---------- Move application ----------

// Forward-declared in this file; function declarations are hoisted.
export function applyPlannedArrange(board: Board, mv: PlannedArrange): Board {
  const final1 = mv.path[mv.path.length - 1];
  const cloned = board.clone();
  const piece = cloned.getAtIndex(mv.from);
  const dest = cloned.getAtIndex(final1);
  cloned.setAtIndex(mv.from, 0);
  if (dest) cloned.setAtIndex(final1, 0);
  if (piece) cloned.setAtIndex(final1, piece);
  return cloned;
}

// Make move on a cloned board and return it.
function applyMoveCloned(board: Board, side: Side, mv: AnyMove): Board {
  switch (mv.kind) {
    case "arrange":
      return applyPlannedArrange(board, { from: mv.from, path: mv.path });
    case "wheel":
      return applyWheel(board, side, mv.center);
    case "boatFlower":
      return applyBoatFlower(board, side, mv.boat, mv.from, mv.to);
    case "boatAccent":
      return applyBoatAccent(board, side, mv.boat, mv.target);
  }
}

// Public helper for callers that want to step games forward.
export function applyEngineMove(board: Board, side: Side, mv: EngineMove): Board {
  return applyMoveCloned(board, side, mv);
}

// ---------- Terminal scoring: ring win + alt-win ----------

const RING_WIN_SCORE = 10_000;
const ALT_WIN_SCORE  = 5_000;

/**
 * Count how many standard flowers a given owner has on the board.
 * (We don't track reserves explicitly, so we use "on-board standard flowers"
 *  as the proxy for "still has flowers".)
 */
function countStandardFlowersOnBoard(board: Board, owner: Owner): number {
  const N = (board as any).size1Based ?? 249;
  let count = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner !== owner) continue;
    if (isStandardFlower(d.type)) count++;
  }
  return count;
}

/**
 * Cross-midline harmony score:
 *  - Uses buildHarmonyGraph(board)
 *  - Only counts edges between same-owner pieces that lie on opposite sides of
 *    the horizontal midline y = 0.
 *  - Each adjacency contributes 1; double-counting is fine since it's symmetric
 *    between players.
 */
function crossMidlineHarmonyScore(board: Board, owner: Owner): number {
  const g = buildHarmonyGraph(board);
  let score = 0;

  for (const [idx, neighbors] of g) {
    const p = board.getAtIndex(idx);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner !== owner) continue;

    const { x: x1, y: y1 } = coordsOf(idx - 1);
    const side1 = Math.sign(y1); // -1, 0, or 1

    for (const n of neighbors) {
      const q = board.getAtIndex(n);
      if (!q) continue;
      const d2 = unpackPiece(q)!;
      if (d2.owner !== owner) continue;

      const { x: x2, y: y2 } = coordsOf(n - 1);
      const side2 = Math.sign(y2);

      // Require opposite sides of the horizontal midline (ignore exactly-on-midline)
      if (side1 === 0 || side2 === 0) continue;
      if (side1 * side2 === -1) {
        score++;
      }
    }
  }

  return score;
}

/**
 * Terminal scoring from the POV of `pov`.
 * - Returns null if position is non-terminal.
 * - Otherwise returns a large-magnitude score encoding:
 *      ring win  >  alt-win  >  draw
 */
function terminalScore(board: Board, pov: Side): number | null {
  const rings = getRingOwners(board); // assumed shape: { host: boolean; guest: boolean }

  // 1) Ring win takes absolute precedence
  if (rings.host || rings.guest) {
    if (rings.host && rings.guest) {
      // extremely unlikely but well-defined: both made a ring → draw
      return 0;
    }
    const winner: Side = rings.host ? "host" : "guest";
    return winner === pov ? +RING_WIN_SCORE : -RING_WIN_SCORE;
  }

  // 2) Alt win: when at least one party has no standard flowers on the board
  const hostFlowers = countStandardFlowersOnBoard(board, Owner.Host);
  const guestFlowers = countStandardFlowersOnBoard(board, Owner.Guest);

  if (hostFlowers === 0 || guestFlowers === 0) {
    const hostScore = crossMidlineHarmonyScore(board, Owner.Host);
    const guestScore = crossMidlineHarmonyScore(board, Owner.Guest);

    if (hostScore === guestScore) {
      return 0; // alt-win draw
    }

    const winner: Side = hostScore > guestScore ? "host" : "guest";
    return winner === pov ? +ALT_WIN_SCORE : -ALT_WIN_SCORE;
  }

  // Non-terminal
  return null;
}

// ---------- Search core (alpha–beta + ordering + TT + time limit) ----------

type Score = number;
type TTFlag = "EXACT" | "LOWER" | "UPPER";

interface TTEntry {
  depth: number; // remaining depth when stored
  score: Score;  // score from side-to-move POV when stored
  flag: TTFlag;
  best?: AnyMove;
}

const TT = new Map<string, TTEntry>();
const TT_CAP = 200_000;

function TT_set(key: string, val: TTEntry) {
  if (TT.size >= TT_CAP) {
    // simple aging: drop ~1/8 of entries
    let n = Math.floor(TT_CAP / 8);
    for (const k of TT.keys()) {
      TT.delete(k);
      if (--n <= 0) break;
    }
  }
  TT.set(key, val);
}

// stats (for demo / debugging)
export const searchStats = { nodes: 0, ttHits: 0, cutoffs: 0 };

// --- killer moves + history (declare AFTER AnyMove is defined) ---
const MAX_PLY = 128;
const killers: (AnyMove | null)[][] = Array.from({ length: MAX_PLY }, () => [
  null,
  null,
]);
const history = new Map<string, number>();
function histKey(mv: AnyMove) {
  return JSON.stringify(mv);
}

// Generate all candidate moves (arrange + bonus). Bonus are deduped and pre-checked.
function generateAllMoves(board: Board, side: Side): AnyMove[] {
  const moves: AnyMove[] = [];

  // Arrange moves
  for (const m of generateLegalArrangeMoves(board, side)) {
    moves.push({ kind: "arrange", from: m.from, path: m.path });
  }

  // Bonus: Wheel / Boat (robust, deduped, prechecked)
  {
    const seen = new Set<string>();
    const safePush = (mv: AnyMove) => {
      const key = JSON.stringify(mv);
      if (seen.has(key)) return;
      try {
        const child = applyMoveCloned(board, side, mv);
        // filter out moves that produce a clash position
        if (detectAnyClash(child)) return;
        seen.add(key);
        moves.push(mv);
      } catch {
        // ignore unplayable bonus
      }
    };

    // Wheel
    for (const c of generateWheelBonusMoves(board, side)) {
      if (typeof c.center === "number")
        safePush({ kind: "wheel", center: c.center });
    }
    // Boat on flower
    for (const b of generateBoatFlowerBonusMoves(board, side)) {
      if (
        typeof b.boat === "number" &&
        typeof b.from === "number" &&
        typeof b.to === "number" &&
        b.from !== b.to
      ) {
        safePush({ kind: "boatFlower", boat: b.boat, from: b.from, to: b.to });
      }
    }
    // Boat on accent
    for (const k of generateBoatAccentBonusMoves(board, side)) {
      const target = (k as any).target as number | undefined;
      if (typeof k.boat === "number" && typeof target === "number") {
        safePush({ kind: "boatAccent", boat: k.boat, target });
      }
    }
  }

  return moves;
}

// Move ordering heuristic: shallow eval of child + center bias + short paths + killer/history.
function orderMoves(
  board: Board,
  side: Side,
  moves: AnyMove[],
  ply = 0
): AnyMove[] {
  const k1 = killers[ply]?.[0],
    k2 = killers[ply]?.[1];

  const scored = moves.map((mv) => {
    let landingIdx1 = -1;
    if (mv.kind === "arrange") landingIdx1 = mv.path[mv.path.length - 1];
    else if (mv.kind === "boatFlower") landingIdx1 = mv.to;

    let centerBias = 0;
    if (landingIdx1 > 0) {
      const { x, y } = coordsOf(landingIdx1 - 1);
      centerBias = -(Math.abs(x) + Math.abs(y));
    }

    let val = 0;
    try {
      val = evaluate(applyMoveCloned(board, side, mv), side);
    } catch {
      val = -1e9;
    }

    const shortPathBias = mv.kind === "arrange" ? -mv.path.length : 0;
    const mvStr = JSON.stringify(mv);
    const killerBonus =
      (k1 && JSON.stringify(k1) === mvStr) ? 5000 :
      (k2 && JSON.stringify(k2) === mvStr) ? 3000 :
      0;
    const histBonus = history.get(histKey(mv)) ?? 0;

    return {
      mv,
      key: val * 1000 + centerBias * 10 + shortPathBias + killerBonus + histBonus,
    };
  });

  scored.sort((a, b) => b.key - a.key);
  return scored.map((s) => s.mv);
}

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
  opts: SearchOpts,
  ply = 0
): { score: Score; best?: AnyMove } {
  searchStats.nodes++;

  // 0) Time check
  if (opts.maxMs && performance.now() - startMs > opts.maxMs) {
    return { score: evaluate(board, side) };
  }

  // 1) Terminal check (ring / alt-win)
  const tScore = terminalScore(board, side);
  if (tScore !== null) {
    return { score: tScore };
  }

  // Keep originals for TT flag computation
  const originalAlpha = alpha;
  const originalBeta = beta;

  // 2) TT probe
  const key = boardKey(board, side);
  const tt = TT.get(key);
  if (tt && tt.depth >= depth) {
    searchStats.ttHits++;
    if (tt.flag === "EXACT") return { score: tt.score, best: tt.best };
    if (tt.flag === "LOWER" && tt.score > alpha) alpha = tt.score;
    else if (tt.flag === "UPPER" && tt.score < beta) beta = tt.score;
    if (alpha >= beta) return { score: tt.score, best: tt.best };
  }

  if (depth === 0) {
    return { score: evaluate(board, side) };
  }

  // 3) Generate & order
  const moves = orderMoves(board, side, generateAllMoves(board, side), ply);

  // Try TT's best move first if present
  if (tt?.best) {
    const bestStr = JSON.stringify(tt.best);
    const i = moves.findIndex((m) => JSON.stringify(m) === bestStr);
    if (i > 0) {
      const [mv] = moves.splice(i, 1);
      moves.unshift(mv);
    }
  }

  if (moves.length === 0) {
    // No moves → treat as terminal from eval POV (but we already checked
    // ring/alt-win above, so this is just "stuck" = static evaluation).
    return { score: evaluate(board, side) };
  }

  let best: AnyMove | undefined;
  let localAlpha = alpha;
  let value: Score = -Infinity;

  for (let idx = 0; idx < moves.length; idx++) {
    const mv = moves[idx];

    let child: Board;
    try {
      child = applyMoveCloned(board, side, mv);
    } catch {
      continue; // move application threw → skip this move
    }

    // Late Move Reductions: reduce depth for unpromising late quiet moves
    let newDepth = depth - 1;
    const isQuiet = mv.kind === "arrange"; // wheel/boat are tactical; search full depth
    if (depth >= 3 && isQuiet && idx >= 6) {
      newDepth = Math.max(1, newDepth - 1);
    }

    const res = searchAlphaBeta(
      child,
      other(side),
      newDepth,
      -beta,
      -localAlpha,
      startMs,
      opts,
      ply + 1
    );
    const v = -res.score;

    if (v > value) {
      value = v;
      best = mv;
    }
    if (v > localAlpha) localAlpha = v;

    if (localAlpha >= beta) {
      // killer + history on cutoff
      searchStats.cutoffs++;
      if (killers[ply]) {
        if (!killers[ply][0] || JSON.stringify(killers[ply][0]) !== JSON.stringify(mv)) {
          killers[ply][1] = killers[ply][0];
          killers[ply][0] = mv;
        }
      }
      const hk = histKey(mv);
      history.set(hk, (history.get(hk) ?? 0) + depth * 100);
      break; // beta cutoff
    }
  }

  // Fallback if every move threw for some reason
  if (!best || value === -Infinity) {
    const evalNow = evaluate(board, side);
    return { score: evalNow };
  }

  // 4) Store in TT
  let flag: TTFlag = "EXACT";
  if (value <= originalAlpha) flag = "UPPER";
  else if (value >= originalBeta) flag = "LOWER";
  TT_set(key, { depth, score: value, flag, best });

  return { score: value, best };
}

// Iterative deepening wrapper with optional time limit (aspiration windows).
function searchIterativeDeepening(
  board: Board,
  side: Side,
  maxDepth: number,
  maxMs?: number
): AnyMove | null {
  TT.clear();
  searchStats.nodes = 0;
  searchStats.ttHits = 0;
  searchStats.cutoffs = 0;

  const start = performance.now();
  let lastBest: AnyMove | null = null;

  let window = 0.5; // start narrow; tune later
  let guess = 0;

  for (let d = 1; d <= maxDepth; d++) {
    let alpha = guess - window;
    let beta = guess + window;
    let result: { score: number; best?: AnyMove };

    while (true) {
      result = searchAlphaBeta(board, side, d, alpha, beta, start, {
        maxDepth,
        maxMs,
      });
      if (result.score <= alpha) {
        // fail-low, widen downward
        alpha -= window * 2;
        window *= 2;
      } else if (result.score >= beta) {
        // fail-high, widen upward
        beta += window * 2;
        window *= 2;
      } else {
        break; // in-window
      }
      if (maxMs && performance.now() - start > maxMs) break;
    }

    if (result.best) lastBest = result.best;
    guess = result.score;
    window = Math.max(0.5, window * 0.75); // slightly tighten for next depth
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
    if (desc.kind !== "basic" && desc.kind !== "lotus" && desc.kind !== "orchid")
      continue;

    const limit =
      desc.kind === "basic"
        ? desc.number
        : desc.kind === "lotus"
        ? 2
        : desc.kind === "orchid"
        ? 6
        : 0;
    if (limit <= 0) continue;

    const seen = new Set<number>([i]);

    function dfs(path: number[]) {
      if (path.length > limit) return;

      // validate full path as an Arrange move
      if (path.length > 0) {
        const valid = validateArrange(board, i, path);
        if (valid.ok) {
          // simulate and filter out clash positions
          const child = applyPlannedArrange(board, { from: i, path });
          if (!detectAnyClash(child)) {
            out.push({ from: i, path: path.slice() });
          }
        }
      }

      if (path.length === limit) return;

      const last = path.length ? path[path.length - 1] : i;
      for (const nxt of NEIGHBORS4_1[last]) {
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
export function pickBestMove(
  board: Board,
  side: Side,
  depth: number,
  opts?: { maxMs?: number }
): EngineMove | null {
  const move = searchIterativeDeepening(board, side, depth, opts?.maxMs);
  return move || null;
}

// ---------- Simple self-play helper (engine vs. itself) ----------
export interface SelfPlayStep {
  side: Side;
  move: EngineMove;
  scoreAfterHostPOV: number;
}

export interface SelfPlayResult {
  finalBoard: Board;
  steps: SelfPlayStep[];
  finalScoreHostPOV: number;
  winner: Side | "draw";
}

/**
 * Let the engine play against itself from a starting position.
 * This is a generic helper; true game-end conditions should be
 * enforced by the caller if needed.
 */
export function selfPlayGame(
  initialBoard: Board,
  startingSide: Side,
  opts: { maxPlies?: number; depth?: number; maxMsPerMove?: number } = {}
): SelfPlayResult {
  const maxPlies = opts.maxPlies ?? 200;
  const depth = opts.depth ?? 3;

  let board = initialBoard.clone();
  let side: Side = startingSide;
  const steps: SelfPlayStep[] = [];

  for (let ply = 0; ply < maxPlies; ply++) {
    const mv = pickBestMove(board, side, depth, { maxMs: opts.maxMsPerMove });
    if (!mv) {
      break;
    }

    board = applyEngineMove(board, side, mv);
    const scoreHost = evaluate(board, "host");
    steps.push({ side, move: mv, scoreAfterHostPOV: scoreHost });
    side = opposite(side);
  }

  const finalScoreHostPOV = evaluate(board, "host");
  const winner =
    finalScoreHostPOV > 0 ? ("host" as Side) :
    finalScoreHostPOV < 0 ? ("guest" as Side) :
    "draw";

  return { finalBoard: board, steps, finalScoreHostPOV, winner };
}

// ---------------- Harmony Bonus move generation ----------------
export function generateWheelBonusMoves(
  board: Board,
  side: Side
): _WheelPlan[] {
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

export function generateBoatFlowerBonusMoves(
  board: Board,
  side: Side
): _BoatFlowerPlan[] {
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
        d.type === TypeId.R3 ||
        d.type === TypeId.R4 ||
        d.type === TypeId.R5 ||
        d.type === TypeId.W3 ||
        d.type === TypeId.W4 ||
        d.type === TypeId.W5 ||
        d.type === TypeId.Lotus ||
        d.type === TypeId.Orchid;
      if (!isFlower) continue;

      for (const to of NEIGHBORS8_1[f]) {
        const plan = planBoatOnFlower(board, f, to);
        if (plan.ok) out.push({ boat: b, from: f, to });
      }
    }
  }
  return out;
}

export function generateBoatAccentBonusMoves(
  board: Board,
  side: Side
): _BoatAccentPlan[] {
  const out: _BoatAccentPlan[] = [];
  const N = (board as any).size1Based ?? 249;

  for (let b = 1; b <= N; b++) {
    if (!owns(board, b, side)) continue;
    if (!isType(board, b, TypeId.Boat)) continue;

    for (const target of NEIGHBORS8_1[b]) {
      const p = board.getAtIndex(target);
      if (!p) continue;
      const d = unpackPiece(p)!;
      const isAccent =
        d.type === TypeId.Rock ||
        d.type === TypeId.Wheel ||
        d.type === TypeId.Boat ||
        d.type === TypeId.Knotweed;
      if (!isAccent) continue;
      if (d.type === TypeId.Boat) continue; // must be a non-boat accent

      const res = planBoatOnAccent(board, target, b);
      if (res.ok)
        out.push({ boat: b, target, remove: res.remove.map((r) => r.remove) });
    }
  }
  return out;
}
