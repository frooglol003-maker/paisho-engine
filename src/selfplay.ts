// src/selfplay.ts
// Engine self-play seeded from real games + notation output + learned weights.
//
// Usage (after build):
//   npm run build
//   node dist/selfplay.js --games 5 --depth 3 --maxMs 500 --seedPath data/sample_games.jsonl
//
// What it does:
//   - Loads recorded games via parse.loadGames (same as learn.ts).
//   - For each self-play run, picks a random game and random prefix of its moves,
//     applies that prefix (using applySetup + applyAction) to get a mid-game position
//     that obeys your actual rules.
//   - From that position, lets the engine (Arrange + bonus) play against itself.
//   - Prints the self-play part in Pai Sho–style notation to stdout.
//   - Collects features for each self-play position and runs ridge regression
//     to print a WEIGHTS block you can paste into eval.ts.

import * as fs from "fs";
import { Board, unpackPiece, TypeId } from "./board";
import { coordsOf } from "./coords";
import { buildHarmonyGraph, getRingOwners} from "./move";
import {
  generateLegalArrangeMoves,
  Side,
  EngineMove,
  pickBestMove,
  applyEngineMove,
  boardKey,    
} from "./engine";
import { evaluate } from "./eval";
import { applySetup, applyAction, loadGames, GameRecord } from "./parse";

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
    if (d.owner === 0) host += val;
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
    if (d.owner === 0) host += neighbors.length;
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
    if (d.owner === 0) host++;
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

function transpose(A: Mat): Mat {
  const m = A.length,
    n = A[0].length;
  const T: Mat = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}

function mul(A: Mat, B: Mat): Mat {
  const m = A.length,
    n = B[0].length,
    p = B.length;
  const C: Mat = Array.from({ length: m }, () => Array(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < p; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}

function mulVec(A: Mat, v: Vec): Vec {
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
function invSymmetric(M: Mat): Mat {
  const n = M.length;
  const A: Mat = M.map((r) => r.slice());
  const I: Mat = Array.from({ length: n }, (_, i) =>
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

function ridge(X: Mat, y: Vec, lambda = 1e-3): Vec {
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

// ----------------- Self-play core -----------------

interface SelfPlayPositionSample {
  features: Features;
  resultHost: number;
}

interface SelfPlayGameRecord {
  id: string;
  seedGameId?: string | number;
  seedPrefix: number;
  notationLines: string[];
  finalScoreHost: number;
}

function makeSeedFromGames(games: GameRecord[]): {
  board: Board;
  side: Side;
  seedGame?: GameRecord;
  seedPrefix: number;
} {
  // If no seed games at all, just start from an empty board.
  if (!games || games.length === 0) {
    return {
      board: new Board(),
      side: "host",
      seedPrefix: 0,
    };
  }

  const MAX_TRIES = 20;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const g = games[Math.floor(Math.random() * games.length)];
    const maxPrefix = g.moves.length;
    const prefix =
      maxPrefix === 0 ? 0 : Math.floor(Math.random() * (maxPrefix + 1));

    let b = new Board();
    applySetup(b, g.setup);
    let side: Side = "host";

    try {
      for (let i = 0; i < prefix; i++) {
        const action = g.moves[i];
        // applyAction returns a new Board (same pattern as in learn.ts)
        b = applyAction(b, action);
        side = side === "host" ? "guest" : "host";
      }

      // If we got here, this game+prefix is legal under current rules.
      return {
        board: b,
        side,
        seedGame: g,
        seedPrefix: prefix,
      };
    } catch (e: any) {
      console.warn(
        `Failed to seed from game ${g.id ?? "(no id)"} at prefix ${prefix}: ${
          e?.message ?? e
        }`
      );
      // try another game on the next loop iteration
    }
  }

  // If all attempts failed (old data doesn’t match new rules), just start fresh.
  console.warn(
    "Seeding from sample_games.jsonl failed repeatedly; starting from empty board."
  );
  return {
    board: new Board(),
    side: "host",
    seedPrefix: 0,
  };
}

function playSingleSelfPlayGame(
  gameId: string,
  games: GameRecord[],
  opts: { maxPlies?: number; depth?: number; maxMsPerMove?: number } = {}
): { game: SelfPlayGameRecord; samples: SelfPlayPositionSample[] } {
  const maxPlies = opts.maxPlies ?? 200;
  const depth = opts.depth ?? 3;

  const { board: startBoard, side: startSide, seedGame, seedPrefix } =
    makeSeedFromGames(games);

  let board = startBoard;
  let side: Side = startSide;
  const notationLines: string[] = [];
  const positions: Features[] = [];

  // For threefold repetition detection
  const seenPositions = new Map<string, number>();

  let ply = 1;

  while (ply <= maxPlies) {
    // --- repetition check at start of ply ---
    const key = boardKey(board, side);
    const count = (seenPositions.get(key) ?? 0) + 1;
    seenPositions.set(key, count);

    if (count >= 3) {
      notationLines.push(`; REPETITION DRAW after ply ${ply - 1}`);
      break;
    }

    const mv = pickBestMove(board, side, depth, {
      maxMs: opts.maxMsPerMove,
    });

    if (!mv) {
      // no legal move for side-to-move → just stop; eval will decide label
      break;
    }

    // Record features BEFORE the move
    const f = extractFeatures(board);
    positions.push(f);

    // Notation line
    const line = formatMoveNotation(ply, side, mv);
    notationLines.push(line);

    // Apply move
    board = applyEngineMove(board, side, mv);

    // --- optional debug: how many moves does each side have now? ---
    const hostMoves = generateLegalArrangeMoves(board, "host").length;
    const guestMoves = generateLegalArrangeMoves(board, "guest").length;
    console.log(
      `DEBUG after ply ${ply}: hostMoves=${hostMoves}, guestMoves=${guestMoves}`
    );

    // --- ring check after move ---
    const rings = getRingOwners(board);
    if (rings.host || rings.guest) {
      if (rings.host && rings.guest) {
        notationLines.push(`; DOUBLE-RING DRAW at ply ${ply}`);
      } else if (rings.host) {
        notationLines.push(`; HOST RING WIN at ply ${ply}`);
      } else {
        notationLines.push(`; GUEST RING WIN at ply ${ply}`);
      }
      break;
    }

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
    seedGameId: (seedGame as any).id,
    seedPrefix,
    notationLines,
    finalScoreHost,
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
  const seedPath = (args["seedPath"] as string) || "data/sample_games.jsonl";

  console.log(
    `Self-play: games=${numGames}, depth=${depth}, maxMsPerMove=${maxMsPerMove ?? "none"}, maxPlies=${maxPlies}`
  );
  console.log(`Seeding from games in: ${seedPath}`);

  if (!fs.existsSync(seedPath)) {
    console.error(`Seed file not found: ${seedPath}`);
    process.exit(1);
  }

  const games = await loadGames(seedPath);
  if (games.length === 0) {
    console.error("No games found in seed file.");
    process.exit(1);
  }

  const allSamples: SelfPlayPositionSample[] = [];

  for (let g = 0; g < numGames; g++) {
    const gameId = `selfplay_${Date.now()}_${g}`;
    const { game, samples } = playSingleSelfPlayGame(gameId, games, {
      depth,
      maxMsPerMove,
      maxPlies,
    });

    allSamples.push(...samples);

    console.log(`\n=== Game ${g + 1}/${numGames} (id=${game.id}) ===`);
    console.log(
      `# seeded from recorded game id=${String(
        game.seedGameId ?? "?"
      )} with prefix=${game.seedPrefix} moves\n`
    );
    for (const ln of game.notationLines) {
      console.log(ln);
    }

    const winner =
      game.finalScoreHost > 0 ? "host" : game.finalScoreHost < 0 ? "guest" : "draw";

    console.log(
      `RESULT ${winner}  (finalScoreHost=${game.finalScoreHost.toFixed(2)})`
    );
  }

  if (allSamples.length === 0) {
    console.log("\nNo samples collected (no moves?). Nothing to learn from.");
    return;
  }

  const X: Mat = [];
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
