// src/selfplay.ts
// Engine self-play loop + JSONL export for future opening database.
//
// Usage (after build):
//   node dist/selfplay.js --games 100 --depth 3 --out data/selfplay.jsonl
//
// Options:
//   --games N        number of self-play games (default: 10)
//   --depth D        search depth per move (default: 3)
//   --maxMs M        soft time limit per move in ms (optional)
//   --out PATH       output JSONL file (default: data/selfplay.jsonl)

import * as fs from "fs";
import { Board } from "./board";
import { evaluate } from "./eval";
import { Side, EngineMove, pickBestMove, applyEngineMove } from "./engine";

interface SelfPlayMoveRecord {
  ply: number;                 // 0-based ply number
  side: Side;                  // side that moved
  move: EngineMove;            // engine move object
  scoreAfterHost: number;      // eval(board, "host") after this move
}

interface SelfPlayGameJSON {
  id: string;
  winner: Side | "draw";
  finalScoreHostPOV: number;
  moves: SelfPlayMoveRecord[];
  // You can add more metadata later if you want:
  // seed?: number;
  // initialFEN?: string;
}

/**
 * Play a single self-play game and return its record.
 * Assumes `new Board()` is a valid starting position. If your starting
 * position is different, replace the initial board construction.
 */
export function playSingleGame(
  gameId: string,
  opts: { maxPlies?: number; depth?: number; maxMsPerMove?: number } = {}
): SelfPlayGameJSON {
  const maxPlies = opts.maxPlies ?? 200;
  const depth = opts.depth ?? 3;

  let board = new Board();       // <-- swap this out if you have a custom setup
  let side: Side = "host";

  const moves: SelfPlayMoveRecord[] = [];

  for (let ply = 0; ply < maxPlies; ply++) {
    const mv = pickBestMove(board, side, depth, {
      maxMs: opts.maxMsPerMove,
    });

    // No legal move: treat as terminal position and stop
    if (!mv) break;

    board = applyEngineMove(board, side, mv);
    const scoreAfterHost = evaluate(board, "host");

    moves.push({
      ply,
      side,
      move: mv,
      scoreAfterHost,
    });

    side = side === "host" ? "guest" : "host";
  }

  const finalScoreHost = evaluate(board, "host");
  const winner: Side | "draw" =
    finalScoreHost > 0 ? "host" :
    finalScoreHost < 0 ? "guest" :
    "draw";

  return {
    id: gameId,
    winner,
    finalScoreHostPOV: finalScoreHost,
    moves,
  };
}

/**
 * Run a batch of self-play games and write them as JSONL.
 */
export function runSelfPlayBatch(
  numGames: number,
  outPath: string,
  opts: { maxPlies?: number; depth?: number; maxMsPerMove?: number } = {}
) {
  // Ensure directory exists if it's nested (very minimal)
  const dir = outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".";
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const stream = fs.createWriteStream(outPath, { flags: "a" }); // append by default

  for (let i = 0; i < numGames; i++) {
    const gameId = `engine_${Date.now()}_${i}`;
    const rec = playSingleGame(gameId, opts);
    stream.write(JSON.stringify(rec) + "\n");

    if ((i + 1) % 10 === 0 || i === numGames - 1) {
      console.log(
        `Finished game ${i + 1}/${numGames}: id=${rec.id}, winner=${rec.winner}, finalScoreHost=${rec.finalScoreHostPOV.toFixed(
          2
        )}`
      );
    }
  }

  stream.end();
  console.log(`\nWrote ${numGames} self-play games to ${outPath}`);
}

// ---- CLI entrypoint ----

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
      // Try to coerce numbers where applicable
      const num = Number(next);
      out[key] = isNaN(num) ? next : num;
      i++;
    }
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  const numGames = (args["games"] as number) ?? 10;
  const depth = (args["depth"] as number) ?? 3;
  const maxMsPerMove = (args["maxMs"] as number) || undefined;
  const outPath = (args["out"] as string) || "data/selfplay.jsonl";

  console.log(
    `Starting self-play: games=${numGames}, depth=${depth}, maxMsPerMove=${maxMsPerMove ?? "none"}, out=${outPath}`
  );

  runSelfPlayBatch(numGames, outPath, {
    depth,
    maxPlies: 200,
    maxMsPerMove,
  });
}
