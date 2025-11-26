// src/eval.ts
// Phase-aware position evaluator for Pai Sho (no mobility term for speed).

import { Board, unpackPiece, TypeId } from "./board";
import { coordsOf } from "./coords";
import { buildHarmonyGraph } from "./move";

type Pov = "host" | "guest";

// --- Material values (can be re-tuned later) ---
const MATERIAL: Record<TypeId, number> = {
  [TypeId.Empty]: 0 as any, // keep or drop depending on your enum
  [TypeId.R3]: 3,
  [TypeId.R4]: 4,
  [TypeId.R5]: 5,
  [TypeId.W3]: 3,
  [TypeId.W4]: 4,
  [TypeId.W5]: 5,
  [TypeId.Lotus]: 7,
  [TypeId.Orchid]: 6,
  [TypeId.Rock]: 0,
  [TypeId.Wheel]: 0,
  [TypeId.Boat]: 0,
  [TypeId.Knotweed]: 0,
};

function pieceValue(t: TypeId): number {
  return MATERIAL[t] ?? 0;
}

// --- Feature extractors ---

function material(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0, guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const val = pieceValue(d.type);
    if (d.owner === 0) host += val;
    else guest += val;
  }
  return { host, guest };
}

// Raw piece counts (ignores type)
function pieceCount(board: Board): { host: number; guest: number; total: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0, guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner === 0) host++;
    else guest++;
  }
  return { host, guest, total: host + guest };
}

// Harmony degree = sum of harmony edges touching each piece
function harmonyDeg(board: Board): { host: number; guest: number } {
  const g = buildHarmonyGraph(board);
  let host = 0, guest = 0;
  for (const [node, neighbors] of g) {
    const p = board.getAtIndex(node);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner === 0) host += neighbors.length;
    else guest += neighbors.length;
  }
  return { host, guest };
}

// "Development" = central presence
function centerCount(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0, guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const { x, y } = coordsOf(i - 1);
    const isCenter = Math.abs(x) + Math.abs(y) <= 3;
    if (!isCenter) continue;
    if (d.owner === 0) host++;
    else guest++;
  }
  return { host, guest };
}

// --- Game phase: 0 = pure opening, 1 = full late game ---
function gamePhase(board: Board): number {
  const pc = pieceCount(board).total;
  const maxPieces = 40; // tweak if your actual max differs
  const t = pc / maxPieces;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// --- Feature vector type ---
interface Features {
  materialDiff:   number; // host - guest (weighted by MATERIAL)
  pieceCountDiff: number; // hostPieces - guestPieces
  harmonyDegDiff: number; // sum of harmony edges
  centerDiff:     number; // central presence
}

// --- Weight sets: opening vs endgame ---
// Opening (phase ~0): push planting + harmonies + development.
// Endgame (phase ~1): harmonies + material dominate.
const OPENING_WEIGHTS: Features = {
  materialDiff: 0.135090,
  harmonyDegDiff: -0.120804,
  centerDiff: -0.212725,
  mobilityDiff: -0.000034
};

const ENDGAME_WEIGHTS: Features = {
  materialDiff:   1.8,
  pieceCountDiff: 0.7,
  harmonyDegDiff: 3.2,
  centerDiff:     0.4,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function blendedWeights(phase: number): Features {
  return {
    materialDiff:   lerp(OPENING_WEIGHTS.materialDiff,   ENDGAME_WEIGHTS.materialDiff,   phase),
    pieceCountDiff: lerp(OPENING_WEIGHTS.pieceCountDiff, ENDGAME_WEIGHTS.pieceCountDiff, phase),
    harmonyDegDiff: lerp(OPENING_WEIGHTS.harmonyDegDiff, ENDGAME_WEIGHTS.harmonyDegDiff, phase),
    centerDiff:     lerp(OPENING_WEIGHTS.centerDiff,     ENDGAME_WEIGHTS.centerDiff,     phase),
  };
}

/**
 * Evaluate from POV: positive = good for pov.
 * We compute (host - guest) with features, then flip by pov.
 */
export function evaluate(board: Board, pov: "host" | "guest"): number {
  const m = (function material(board) {
    const N = board.size1Based ?? 249;
    let host = 0, guest = 0;
    for (let i = 1; i <= N; i++) {
        const p = board.getAtIndex(i);
        if (!p)
            continue;
        const d = (0, board_1.unpackPiece)(p);
        const val = d.type === board_1.TypeId.R3 || d.type === board_1.TypeId.W3
            ? 3
            : d.type === board_1.TypeId.R4 || d.type === board_1.TypeId.W4
                ? 4
                : d.type === board_1.TypeId.R5 || d.type === board_1.TypeId.W5
                    ? 5
                    : d.type === board_1.TypeId.Lotus
                        ? 7
                        : d.type === board_1.TypeId.Orchid
                            ? 6
                            : 0;
        if (d.owner === board_1.Owner.Host)
            host += val;
        else
            guest += val;
    }
    return { host, guest };
})(board);
  const h = (function harmonyDeg(board) {
    const g = (0, move_1.buildHarmonyGraph)(board);
    let host = 0, guest = 0;
    for (const [node, neighbors] of g) {
        const p = board.getAtIndex(node);
        if (!p)
            continue;
        const d = (0, board_1.unpackPiece)(p);
        if (d.owner === board_1.Owner.Host)
            host += neighbors.length;
        else
            guest += neighbors.length;
    }
    return { host, guest };
})(board);
  const c = (function centerCount(board) {
    const N = board.size1Based ?? 249;
    let host = 0, guest = 0;
    for (let i = 1; i <= N; i++) {
        const p = board.getAtIndex(i);
        if (!p)
            continue;
        const d = (0, board_1.unpackPiece)(p);
        const { x, y } = (0, coords_1.coordsOf)(i - 1);
        const isCenter = Math.abs(x) + Math.abs(y) <= 3;
        if (!isCenter)
            continue;
        if (d.owner === board_1.Owner.Host)
            host++;
        else
            guest++;
    }
    return { host, guest };
})(board);
  const mo = (function mobility(board) {
    const hostMoves = (0, engine_1.generateLegalArrangeMoves)(board, "host").length;
    const guestMoves = (0, engine_1.generateLegalArrangeMoves)(board, "guest").length;
    return { host: hostMoves, guest: guestMoves };
})(board);
  const f = {
    materialDiff: m.host - m.guest,
    harmonyDegDiff: h.host - h.guest,
    centerDiff: c.host - c.guest,
    mobilityDiff: mo.host - mo.guest,
  };

  const raw =
    WEIGHTS.materialDiff * f.materialDiff +
    WEIGHTS.harmonyDegDiff * f.harmonyDegDiff +
    WEIGHTS.centerDiff   * f.centerDiff +
    WEIGHTS.mobilityDiff * f.mobilityDiff;

  return pov === "host" ? raw : -raw;
}
