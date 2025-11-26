// src/selfplay.ts
// Engine self-play from a fixed R3/W5 gate opening + harmony-bonus plants
// + notation output + learned weights.
//
// Usage (after build):
//   npm run build
//   node dist/selfplay.js --games 5 --depth 3 --maxMs 500
//
// What it does:
//   - Builds a fixed opening position:
//       * Host: R3 at (0, 8),  W5 at (-8, 0)
//       * Guest: R3 at (0, -8), W5 at ( 8, 0)
//   - From that position, lets the engine play against itself.
//   - After each move, if the moving side created new harmonies,
//     it automatically takes a HARMONY BONUS as a **plant** into an empty gate,
//     respecting tile pools.
//   - The bonus plant is encoded as an accent in notation:  5H.(...)-(...)+TYPE(x,y)
//   - Prints the self-play game in Pai Sho–style notation.
//   - Collects features and runs ridge regression to print a WEIGHTS block.

import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import {
  buildHarmonyGraph,
  getRingOwners,
  listHarmonyEdges,
} from "./move";
import {
  generateLegalArrangeMoves,
  Side,
  EngineMove,
  pickBestMove,
  applyEngineMove,
  boardKey,
} from "./engine";
import { evaluate } from "./eval";

// For CLI entry detection
declare const require: any;

// ---------------- Feature extraction (same style as learn.ts) ----------------

type Features = {
  materialDiff: number;
  harmonyDegDiff: number;
  centerDiff: number;
  mobilityDiff: number;
};

type Vec = number[];
type Mat = number[][];

function material(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0,
    guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const val =
      d.type === TypeId.R3 || d.type === TypeId.W3
        ? 3
        : d.type === TypeId.R4 || d.type === TypeId.W4
        ? 4
        : d.type === TypeId.R5 || d.type === TypeId.W5
        ? 5
        : d.type === TypeId.Lotus
        ? 7
        : d.type === TypeId.Orchid
        ? 6
        : 0;
    if (d.owner === Owner.Host) host += val;
    else guest += val;
  }
  return { host, guest };
}

function harmonyDeg(board: Board): { host: number; guest: number } {
  const g = buildHarmonyGraph(board);
  let host = 0,
    guest = 0;
  for (const [node, neighbors] of g) {
    const p = board.getAtIndex(node);
    if (!p) continue;
    const d = unpackPiece(p)!;
    if (d.owner === Owner.Host) host += neighbors.length;
    else guest += neighbors.length;
  }
  return { host, guest };
}

function centerCount(board: Board): { host: number; guest: number } {
  const N = (board as any).size1Based ?? 249;
  let host = 0,
    guest = 0;
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const { x, y } = coordsOf(i - 1);
    const isCenter = Math.abs(x) + Math.abs(y) <= 3;
    if (!isCenter) continue;
    if (d.owner === Owner.Host) host++;
    else guest++;
  }
  return { host, guest };
}

function mobility(board: Board): { host: number; guest: number } {
  const hostMoves = generateLegalArrangeMoves(board, "host").length;
  const guestMoves = generateLegalArrangeMoves(board, "guest").length;
  return { host: hostMoves, guest: guestMoves };
}

function extractFeatures(board: Board): Features {
  const m = material(board);
  const h = harmonyDeg(board);
  const c = centerCount(board);
  const mo = mobility(board);
  return {
    materialDiff: m.host - m.guest,
    harmonyDegDiff: h.host - h.guest,
    centerDiff: c.host - c.guest,
    mobilityDiff: mo.host - mo.guest,
  };
}

// -------- Ridge regression (same structure as learn.ts) --------

type MatLike = Mat;

function transpose(A: MatLike): MatLike {
  const m = A.length,
    n = A[0].length;
  const T: MatLike = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}

function mul(A: MatLike, B: MatLike): MatLike {
  const m = A.length,
    n = B[0].length,
    p = B.length;
  const C: MatLike = Array.from({ length: m }, () => Array(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < p; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}

function mulVec(A: MatLike, v: Vec): Vec {
  const m = A.length,
    n = A[0].length;
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

// Simple symmetric matrix inverse via Gauss-Jordan (OK for tiny feature sets)
function invSymmetric(M: MatLike): MatLike {
  const n = M.length;
  const A: MatLike = M.map((r) => r.slice());
  const I: MatLike = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  for (let i = 0; i < n; i++) {
    let maxR = i,
      maxV = Math.abs(A[i][i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(A[r][i]);
      if (v > maxV) {
        maxV = v;
        maxR = r;
      }
    }
    if (maxV < 1e-12) throw new Error("Matrix near-singular in ridge");
    if (maxR !== i) {
      [A[i], A[maxR]] = [A[maxR], A[i]];
      [I[i], I[maxR]] = [I[maxR], I[i]];
    }
    const piv = A[i][i];
    for (let j = 0; j < n; j++) {
      A[i][j] /= piv;
      I[i][j] /= piv;
    }
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) {
        A[r][j] -= f * A[i][j];
        I[r][j] -= f * I[i][j];
      }
    }
  }
  return I;
}

function ridge(X: MatLike, y: Vec, lambda = 1e-3): Vec {
  const XT = transpose(X);
  const XTX = mul(XT, X);
  const k = XTX.length;
  for (let i = 0; i < k; i++) XTX[i][i] += lambda;
  const XTy = mulVec(XT, y);
  const XTXinv = invSymmetric(XTX);
  return mulVec(XTXinv, XTy);
}

function resultToScoreFromHost(finalScoreHost: number): number {
  if (finalScoreHost > 0) return +1;
  if (finalScoreHost < 0) return -1;
  return 0;
}

// ----------------- Notation helpers -----------------

function sideShort(side: Side): "H" | "G" {
  return side === "host" ? "H" : "G";
}

// Convert index1 (1-based) into (x,y)
function idx1ToXY(idx1: number): { x: number; y: number } {
  const { x, y } = coordsOf(idx1 - 1);
  return { x, y };
}

/**
 * Convert a single engine move into a Pai Sho–style notation line.
 *
 * - Arrange:      (x1,y1)-(x2,y2)
 * - Boat accent:  B(boatX,boatY)-({targetX},{targetY})
 * - Wheel / BoatFlower: ad-hoc but readable comments for now.
 *
 * Bonus plants are appended outside this function as +TYPE(x,y).
 */
function formatMoveNotation(ply: number, side: Side, mv: EngineMove): string {
  const s = sideShort(side);
  switch (mv.kind) {
    case "arrange": {
      const from = idx1ToXY(mv.from);
      const to = idx1ToXY(mv.path[mv.path.length - 1]);
      return `${ply}${s}.(${from.x},${from.y})-(${to.x},${to.y})`;
    }
    case "boatAccent": {
      const boat = idx1ToXY(mv.boat);
      const target = idx1ToXY(mv.target);
      return `${ply}${s}.B(${boat.x},${boat.y})-(${target.x},${target.y})`;
    }
    case "wheel": {
      const c = idx1ToXY(mv.center);
      return `${ply}${s}.;WHEEL(${c.x},${c.y})`;
    }
    case "boatFlower": {
      const b = idx1ToXY(mv.boat);
      const from = idx1ToXY(mv.from);
      const to = idx1ToXY(mv.to);
      return `${ply}${s}.;BFL(${b.x},${b.y}):(${from.x},${from.y})->(${to.x},${to.y})`;
    }
  }
}

// ----------------- Harmony / bonus helpers -----------------

function harmonyEdgesForSide(board: Board, side: Side): number {
  const edges = listHarmonyEdges(board) as { owner: "host" | "guest" }[];
  return edges.filter((e) => e.owner === side).length;
}

// ----------------- Pool / bonus plant helpers -----------------

// Gates (same as in play.ts)
const GATES = [
  { x: 0, y: 8 },
  { x: 0, y: -8 },
  { x: -8, y: 0 },
  { x: 8, y: 0 },
];

function idx1FromXY(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`idx1FromXY: off-board coord (${x},${y})`);
  return i0 + 1;
}

// Pool bookkeeping (mirrors play.ts, but minimal)
type CountMap = Record<string, number>;

const PIECE_KEYS: [TypeId, string][] = [
  [TypeId.R3, "R3"],
  [TypeId.R4, "R4"],
  [TypeId.R5, "R5"],
  [TypeId.W3, "W3"],
  [TypeId.W4, "W4"],
  [TypeId.W5, "W5"],
  [TypeId.Lotus, "Lotus"],
  [TypeId.Orchid, "Orchid"],
];

const STANDARD_POOL: CountMap = {
  R3: 3,
  R4: 3,
  R5: 3,
  W3: 3,
  W4: 3,
  W5: 3,
  Lotus: 1,
  Orchid: 1,
};

function keyForType(t: TypeId): string | undefined {
  const pair = PIECE_KEYS.find(([tid]) => tid === t);
  return pair ? pair[1] : undefined;
}

function zeroCounts(): CountMap {
  const out: CountMap = {};
  for (const [, key] of PIECE_KEYS) out[key] = 0;
  return out;
}

/** Count pieces on the board, split by owner. */
function countsOnBoard(board: Board): { host: CountMap; guest: CountMap } {
  const host = zeroCounts();
  const guest = zeroCounts();

  const N: number =
    (board as any).size ??
    (board as any).size1Based ??
    249;

  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const d = unpackPiece(p)!;
    const key = keyForType(d.type);
    if (!key) continue;
    if (d.owner === Owner.Host) host[key] = (host[key] || 0) + 1;
    else guest[key] = (guest[key] || 0) + 1;
  }
  return { host, guest };
}

/** Remaining pool per side from board state + STANDARD_POOL. */
function remainingFromBoard(board: Board): { host: CountMap; guest: CountMap } {
  const onBoard = countsOnBoard(board);
  const hostRem = zeroCounts();
  const guestRem = zeroCounts();

  for (const [, key] of PIECE_KEYS) {
    const total = STANDARD_POOL[key] ?? 0;
    hostRem[key] = Math.max(0, total - (onBoard.host[key] ?? 0));
    guestRem[key] = Math.max(0, total - (onBoard.guest[key] ?? 0));
  }
  return { host: hostRem, guest: guestRem };
}

/** Player can plant only if they have NO tile in ANY gate, and some gate is empty. */
function playerCanPlant(board: Board, side: Side): boolean {
  const myOwner = side === "host" ? Owner.Host : Owner.Guest;

  let hasOwnInGate = false;
  let hasEmptyGate = false;

  for (const g of GATES) {
    const idx = idx1FromXY(g.x, g.y);
    const packed = board.getAtIndex(idx);
    if (!packed) {
      hasEmptyGate = true;
      continue;
    }
    const dec = unpackPiece(packed)!;
    if (dec.owner === myOwner) hasOwnInGate = true;
  }

  if (hasOwnInGate) return false;
  return hasEmptyGate;
}

type BonusPlantInfo = {
  typeName: string; // e.g. "R5"
  x: number;
  y: number;
};

/**
 * Try to apply a single bonus PLANT for `side`.
 * - Only flowers + Lotus/Orchid are used.
 * - Respects per-side pools.
 * - Only allowed if playerCanPlant and there is an empty gate.
 *
 * Returns info for notation if a plant was done; otherwise null.
 */
function tryApplyBonusPlant(board: Board, side: Side): BonusPlantInfo | null {
  if (!playerCanPlant(board, side)) {
    return null;
  }

  const rem = remainingFromBoard(board);
  const pool = side === "host" ? rem.host : rem.guest;
  const owner = side === "host" ? Owner.Host : Owner.Guest;

  // Prefer higher-value material: Lotus > Orchid > 5s > 4s > 3s
  const ORDER: { key: keyof CountMap; type: TypeId }[] = [
    { key: "Lotus", type: TypeId.Lotus },
    { key: "Orchid", type: TypeId.Orchid },
    { key: "R5", type: TypeId.R5 },
    { key: "W5", type: TypeId.W5 },
    { key: "R4", type: TypeId.R4 },
    { key: "W4", type: TypeId.W4 },
    { key: "R3", type: TypeId.R3 },
    { key: "W3", type: TypeId.W3 },
  ];

  let chosenType: TypeId | null = null;
  let chosenKey: string | null = null;

  for (const opt of ORDER) {
    if ((pool[opt.key] ?? 0) > 0) {
      chosenType = opt.type;
      chosenKey = opt.key;
      break;
    }
  }

  if (!chosenType || !chosenKey) {
    return null; // nothing left to plant
  }

  // Choose a gate: prefer "home" gate, else any empty.
  const preferredOrder =
    side === "host"
      ? [
          { x: 0, y: 8 }, // north
          { x: -8, y: 0 },
          { x: 8, y: 0 },
          { x: 0, y: -8 },
        ]
      : [
          { x: 0, y: -8 }, // south
          { x: -8, y: 0 },
          { x: 8, y: 0 },
          { x: 0, y: 8 },
        ];

  let gatePos: { x: number; y: number } | null = null;
  for (const g of preferredOrder) {
    const idx = idx1FromXY(g.x, g.y);
    if (!board.getAtIndex(idx)) {
      gatePos = g;
      break;
    }
  }

  if (!gatePos) {
    return null;
  }

  const idx = idx1FromXY(gatePos.x, gatePos.y);
  board.setAtIndex(idx, packPiece(chosenType, owner));

  console.log(
    `BONUS: ${side} plants ${chosenKey} at (${gatePos.x},${gatePos.y})`
  );

  return { typeName: chosenKey, x: gatePos.x, y: gatePos.y };
}

// ----------------- Fixed R3/W5 opening seed -----------------

/**
 * Fixed, legal opening:
 *   - Move 1 type: R3 on vertical gates
 *       Host R3 at (0, 8), Guest R3 at (0, -8)
 *   - Move 2 type: W5 on horizontal gates
 *       Host W5 at (-8, 0), Guest W5 at (8, 0)
 *
 * After this scripted opening, self-play begins with HOST to move.
 */
function setupFixedOpening(board: Board): void {
  // Host R3 at north gate, guest R3 at south gate
  board.setAtIndex(idx1FromXY(0, 8), packPiece(TypeId.R3, Owner.Host));
  board.setAtIndex(idx1FromXY(0, -8), packPiece(TypeId.R3, Owner.Guest));

  // Host W5 at west gate, guest W5 at east gate
  board.setAtIndex(idx1FromXY(-8, 0), packPiece(TypeId.W5, Owner.Host));
  board.setAtIndex(idx1FromXY(8, 0), packPiece(TypeId.W5, Owner.Guest));
}

function makeSeedPosition(): {
  board: Board;
  side: Side;
  seedDescription: string;
} {
  const board = new Board();
  setupFixedOpening(board);
  // Opening is fully "planted"; we start actual play with host to move.
  return {
    board,
    side: "host",
    seedDescription: "fixed gate opening: R3 on (0,±8), W5 on (±8,0)",
  };
}

// ----------------- Self-play core -----------------

interface SelfPlayPositionSample {
  features: Features;
  resultHost: number;
}

interface SelfPlayGameRecord {
  id: string;
  seedDescription: string;
  notationLines: string[];
  finalScoreHost: number;
  bonusHost: number;
  bonusGuest: number;
}

function playSingleSelfPlayGame(
  gameId: string,
  opts: { maxPlies?: number; depth?: number; maxMsPerMove?: number } = {}
): { game: SelfPlayGameRecord; samples: SelfPlayPositionSample[] } {
  const maxPlies = opts.maxPlies ?? 200;
  const depth = opts.depth ?? 3;

  const { board: startBoard, side: startSide, seedDescription } =
    makeSeedPosition();

  let board = startBoard;
  let side: Side = startSide;
  const notationLines: string[] = [];
  const positions: Features[] = [];

  // For threefold repetition detection
  const seenPositions = new Map<string, number>();

  let ply = 1;
  let bonusHost = 0;
  let bonusGuest = 0;

  while (ply <= maxPlies) {
    // --- repetition check at start of ply ---
    const key = boardKey(board, side);
    const count = (seenPositions.get(key) ?? 0) + 1;
    seenPositions.set(key, count);

    if (count >= 3) {
      notationLines.push(`; REPETITION DRAW after ply ${ply - 1}`);
      break;
    }

    // Harmony count BEFORE this move (for this side) to detect new harmonies
    const edgesBefore = harmonyEdgesForSide(board, side);

    const mv = pickBestMove(board, side, depth, {
      maxMs: opts.maxMsPerMove,
    });

    if (!mv) {
      // no legal move for side-to-move → stop; eval will decide label
      break;
    }

    // Record features BEFORE the move
    const f = extractFeatures(board);
    positions.push(f);

    // Notation main part (without bonus suffix yet)
    const mainNotation = formatMoveNotation(ply, side, mv);

    // Apply main move
    board = applyEngineMove(board, side, mv);

    // --- optional debug: move counts after ply ---
    const hostMoves = generateLegalArrangeMoves(board, "host").length;
    const guestMoves = generateLegalArrangeMoves(board, "guest").length;
    console.log(
      `DEBUG after ply ${ply}: hostMoves=${hostMoves}, guestMoves=${guestMoves}`
    );

    // Harmony count AFTER main move
    const edgesAfter = harmonyEdgesForSide(board, side);
    let bonusSuffix = "";

    if (edgesAfter > edgesBefore) {
      // Harmony bonus: always try PLANT (never accent) to gain material.
      const bonus = tryApplyBonusPlant(board, side);
      if (bonus) {
        bonusSuffix = `+${bonus.typeName}(${bonus.x},${bonus.y})`;
        if (side === "host") bonusHost++;
        else bonusGuest++;
      }
    }

    // --- ring check AFTER bonuses ---
    const rings = getRingOwners(board);
    if (rings.host || rings.guest) {
      if (rings.host && rings.guest) {
        notationLines.push(`${mainNotation}${bonusSuffix}`);
        notationLines.push(`; DOUBLE-RING DRAW at ply ${ply}`);
      } else if (rings.host) {
        notationLines.push(`${mainNotation}${bonusSuffix}`);
        notationLines.push(`; HOST RING WIN at ply ${ply}`);
      } else {
        notationLines.push(`${mainNotation}${bonusSuffix}`);
        notationLines.push(`; GUEST RING WIN at ply ${ply}`);
      }
      break;
    }

    // Commit notation for this ply (main move + optional bonus plant)
    notationLines.push(`${mainNotation}${bonusSuffix}`);

    // Next side
    side = side === "host" ? "guest" : "host";
    ply++;
  }

  const finalScoreHost = evaluate(board, "host");
  const resHost = resultToScoreFromHost(finalScoreHost);

  const samples: SelfPlayPositionSample[] = positions.map((feat) => ({
    features: feat,
    resultHost: resHost,
  }));

  const game: SelfPlayGameRecord = {
    id: gameId,
    seedDescription,
    notationLines,
    finalScoreHost,
    bonusHost,
    bonusGuest,
  };

  return { game, samples };
}

// ----------------- Batch + learning + CLI -----------------

function parseArgs(argv: string[]) {
  const out: Record<string, string | number | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      const num = Number(next);
      out[key] = isNaN(num) ? next : num;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const numGames = (args["games"] as number) ?? 3;
  const depth = (args["depth"] as number) ?? 3;
  const maxMsPerMove = (args["maxMs"] as number) || undefined;
  const maxPlies = (args["maxPlies"] as number) ?? 200;

  console.log(
    `Self-play: games=${numGames}, depth=${depth}, maxMsPerMove=${maxMsPerMove ?? "none"}, maxPlies=${maxPlies}`
  );
  console.log(
    "Starting each game from fixed R3/W5 gate opening, with harmony-bonus PLANTS enabled."
  );

  const allSamples: SelfPlayPositionSample[] = [];
  let totalBonusHost = 0;
  let totalBonusGuest = 0;

  for (let g = 0; g < numGames; g++) {
    const gameId = `selfplay_${Date.now()}_${g}`;
    const { game, samples } = playSingleSelfPlayGame(gameId, {
      depth,
      maxMsPerMove,
      maxPlies,
    });

    allSamples.push(...samples);
    totalBonusHost += game.bonusHost;
    totalBonusGuest += game.bonusGuest;

    console.log(`\n=== Game ${g + 1}/${numGames} (id=${game.id}) ===`);
    console.log(`# seed: ${game.seedDescription}`);
    console.log(`# bonus plants: host=${game.bonusHost}, guest=${game.bonusGuest}\n`);

    for (const ln of game.notationLines) {
      console.log(ln);
    }

    const winner =
      game.finalScoreHost > 0 ? "host" : game.finalScoreHost < 0 ? "guest" : "draw";

    console.log(
      `RESULT ${winner}  (finalScoreHost=${game.finalScoreHost.toFixed(2)})`
    );
  }

  console.log(
    `\nTOTAL bonus plants across all games: host=${totalBonusHost}, guest=${totalBonusGuest}`
  );

  if (allSamples.length === 0) {
    console.log("\nNo samples collected (no moves?). Nothing to learn from.");
    return;
  }

  const X: MatLike = [];
  const y: Vec = [];

  for (const s of allSamples) {
    const f = s.features;
    X.push([f.materialDiff, f.harmonyDegDiff, f.centerDiff, f.mobilityDiff]);
    y.push(s.resultHost);
  }

  const w = ridge(X, y, 1e-3);
  const [wMat, wHar, wCtr, wMob] = w;

  console.log("\n---- Learned weights from self-play ----\n");
  console.log(`Samples used: ${X.length}`);
  console.log(
    `materialDiff: ${wMat.toFixed(6)}, harmonyDegDiff: ${wHar.toFixed(
      6
    )}, centerDiff: ${wCtr.toFixed(6)}, mobilityDiff: ${wMob.toFixed(6)}`
  );
  console.log(
    "\n---- Paste this block into src/eval.ts (replace the scoring section) ----\n"
  );
  console.log(`// Learned from self-play (${X.length} samples)`);
  console.log(
    `const WEIGHTS = { materialDiff: ${wMat.toFixed(
      6
    )}, harmonyDegDiff: ${wHar.toFixed(6)}, centerDiff: ${wCtr.toFixed(
      6
    )}, mobilityDiff: ${wMob.toFixed(6)} };`
  );
  console.log(`
export function evaluate(board: Board, pov: "host" | "guest"): number {
  const m = (${material.toString()})(board);
  const h = (${harmonyDeg.toString()})(board);
  const c = (${centerCount.toString()})(board);
  const mo = (${mobility.toString()})(board);
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
`);
  console.log("---- end paste block ----\n");
}

if (require.main === module) {
  main().catch((e: any) => {
    console.error(e);
    process.exit(1);
  });
}
