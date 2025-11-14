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
  materialDiff:   0.4,
  pieceCountDiff: 1.8,
  harmonyDegDiff: 2.5,
  centerDiff:     1.2,
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
export function evaluate(board: Board, pov: Pov): number {
  const m  = material(board);
  const pc = pieceCount(board);
  const h  = harmonyDeg(board);
  const c  = centerCount(board);

  const feats: Features = {
    materialDiff:   m.host  - m.guest,
    pieceCountDiff: pc.host - pc.guest,
    harmonyDegDiff: h.host  - h.guest,
    centerDiff:     c.host  - c.guest,
  };

  const phase = gamePhase(board); // 0 → opening, 1 → late
  const W = blendedWeights(phase);

  const raw =
    W.materialDiff   * feats.materialDiff   +
    W.pieceCountDiff * feats.pieceCountDiff +
    W.harmonyDegDiff * feats.harmonyDegDiff +
    W.centerDiff     * feats.centerDiff;

  return pov === "host" ? raw : -raw;
}
