// src/play_vs_engine.ts
// Simple CLI: human vs engine using current engine + ring wins.
//
// Usage after build:
//   npm run build
//   node dist/play_vs_engine.js
//
// You will be asked:
//   - Play as host or guest
//   - Depth / maxMs
// And then you type moves like:
//   (-8,0) (-3,0) (0,0)
// for an Arrange that goes gate → mid → center.

import * as readline from "readline";
import { Board, TypeId, Owner, packPiece, unpackPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import {
  getPieceDescriptor,
  // optional, but useful to validate the human's move type
} from "./rules";
import {
  validateArrange,
  detectAnyClash,
  getRingOwners,
} from "./move";
import {
  Side,
  EngineMove,
  pickBestMove,
  applyEngineMove,
  applyPlannedArrange,
  generateLegalArrangeMoves,
} from "./engine";
import { evaluate } from "./eval";

// ----------------- Helpers -----------------

function idx1FromXY(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`idx1FromXY: off-board coord (${x},${y})`);
  return i0 + 1;
}

function xyFromIdx1(idx1: number): { x: number; y: number } {
  return coordsOf(idx1 - 1);
}

function ownerFromSide(side: Side): Owner {
  return side === "host" ? Owner.Host : Owner.Guest;
}

function sideName(side: Side): string {
  return side === "host" ? "Host (light)" : "Guest (dark)";
}

// Very lightweight board dump: just list all pieces with coords.
function printBoard(board: Board) {
  console.log("\n=== Board pieces ===");
  for (const { index, x, y, packed } of board.listPieces()) {
    const dec = unpackPiece(packed)!;
    const owner = dec.owner === Owner.Host ? "H" : "G";
    const typeName = TypeId[dec.type];
    console.log(
      `  ${owner} ${typeName} at (${x},${y}) [idx1=${index}]`
    );
  }
  console.log("====================\n");
}

// Parse a line like: "(-8,0) (-3,0) (0,0)" → [{x,y}, ...]
function parseCoordLine(line: string): { x: number; y: number }[] | null {
  line = line.trim();
  if (!line) return null;
  const tokens = line.split(/\s+/);
  const coords: { x: number; y: number }[] = [];

  for (const tok of tokens) {
    const m = tok.match(/^\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?$/);
    if (!m) {
      console.log(`Could not parse token "${tok}" as (x,y).`);
      return null;
    }
    const x = Number(m[1]);
    const y = Number(m[2]);
    coords.push({ x, y });
  }
  if (coords.length < 2) {
    console.log("Need at least a start and one destination, e.g. (0,8) (-3,8).");
    return null;
  }
  return coords;
}

// Convert coordinate sequence to an Arrange move (from idx1 + path idx1[])
function coordsToArrange(
  board: Board,
  side: Side,
  coords: { x: number; y: number }[]
): { from: number; path: number[] } | null {
  const idxs = coords.map((c) => idx1FromXY(c.x, c.y));
  const from = idxs[0];
  const path = idxs.slice(1);

  const packed = board.getAtIndex(from);
  if (!packed) {
    console.log("No piece at the starting coordinate.");
    return null;
  }
  const dec = unpackPiece(packed)!;
  if (
    (side === "host" && dec.owner !== Owner.Host) ||
    (side === "guest" && dec.owner !== Owner.Guest)
  ) {
    console.log("That starting piece does not belong to you.");
    return null;
  }

  // Check descriptor/movement limit to give nice errors.
  const desc = getPieceDescriptor(board, from);
  if (desc.kind !== "basic" && desc.kind !== "lotus" && desc.kind !== "orchid") {
    console.log("That piece cannot perform an Arrange move (try another).");
    return null;
  }
  const limit =
    desc.kind === "basic"
      ? desc.number
      : desc.kind === "lotus"
      ? 2
      : desc.kind === "orchid"
      ? 6
      : 0;
  if (path.length > limit) {
    console.log(
      `Path is longer than this piece's Arrange limit (${limit} steps).`
    );
    return null;
  }

  const valid = validateArrange(board, from, path);
  if (!valid.ok) {
    console.log(`Illegal Arrange: ${valid.reason ?? "unknown reason"}`);
    return null;
  }

  const child = applyPlannedArrange(board, { from, path });
  if (detectAnyClash(child)) {
    console.log("Move would result in a clash; not allowed.");
    return null;
  }

  return { from, path };
}

// Check ring status and announce if game over
function checkRingGameOver(board: Board): Side | "double" | null {
  const rings = getRingOwners(board); // { host: boolean; guest: boolean } by our convention
  if (rings.host && rings.guest) return "double";
  if (rings.host) return "host";
  if (rings.guest) return "guest";
  return null;
}

// ----------------- Opening setup -----------------

// Same fixed gate opening as selfplay.ts
function setupFixedOpening(board: Board): void {
  // Host R3 at north gate, guest R3 at south gate
  board.setAtIndex(idx1FromXY(0, 8), packPiece(TypeId.R3, Owner.Host));
  board.setAtIndex(idx1FromXY(0, -8), packPiece(TypeId.R3, Owner.Guest));

  // Host W5 at west gate, guest W5 at east gate
  board.setAtIndex(idx1FromXY(-8, 0), packPiece(TypeId.W5, Owner.Host));
  board.setAtIndex(idx1FromXY(8, 0), packPiece(TypeId.W5, Owner.Guest));
}

function makeStartingBoard(): Board {
  const b = new Board();
  setupFixedOpening(b);
  return b;
}

// ----------------- CLI loop -----------------

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask(question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve));
  }

  console.log("Pai Sho engine CLI – play vs engine.");
  console.log("We start from the fixed R3/W5 gate opening used in self-play.\n");

  let sideInput = (await ask("Play as host (H) or guest (G)? [H/G] ")).trim().toUpperCase();
  if (sideInput !== "H" && sideInput !== "G") sideInput = "H";
  const humanSide: Side = sideInput === "H" ? "host" : "guest";
  const engineSide: Side = humanSide === "host" ? "guest" : "host";

  const depthStr = (await ask("Engine search depth? [default 3] ")).trim();
  const depth = depthStr ? Math.max(1, Number(depthStr) || 3) : 3;

  const maxMsStr = (await ask("Soft time limit per engine move (ms)? [e.g. 500, blank = no limit] ")).trim();
  const maxMs = maxMsStr ? Number(maxMsStr) || undefined : undefined;

  console.log(
    `\nYou are ${sideName(humanSide)}. Engine is ${sideName(engineSide)}.`
  );
  console.log(`Search depth = ${depth}, maxMs = ${maxMs ?? "none"}.\n`);

  let board = makeStartingBoard();
  let sideToMove: Side = "host"; // host always moves first after fixed planting
  let ply = 1;
  const MAX_PLIES = 300;

  printBoard(board);

  outer: while (ply <= MAX_PLIES) {
    console.log(`=== Ply ${ply} – ${sideName(sideToMove)} to move ===`);

    // Check for trivial "no moves" condition
    const movesAvailable = generateLegalArrangeMoves(board, sideToMove).length;
    if (movesAvailable === 0) {
      console.log("No available Arrange moves for side to move; stopping.");
      break;
    }

    if (sideToMove === humanSide) {
      // ----- HUMAN TURN -----
      while (true) {
        const line = await ask(
          "Enter Arrange path as (x,y) (x,y) ... or 'q' to quit: "
        );
        if (line.trim().toLowerCase() === "q") {
          console.log("Quitting.");
          break outer;
        }

        const coords = parseCoordLine(line);
        if (!coords) continue;

        const arr = coordsToArrange(board, humanSide, coords);
        if (!arr) continue;

        board = applyPlannedArrange(board, arr);

        const ringWinner = checkRingGameOver(board);
        printBoard(board);

        if (ringWinner) {
          if (ringWinner === "double") {
            console.log("Both players formed a ring – double ring draw!");
          } else if (ringWinner === humanSide) {
            console.log("You formed a ring – you win!");
          } else {
            console.log("Engine has a ring after your move (?!) – engine wins!");
          }
          break outer;
        }

        const evalHost = evaluate(board, "host");
        console.log(`Position eval (host POV): ${evalHost.toFixed(2)}\n`);

        break; // move accepted
      }
    } else {
      // ----- ENGINE TURN -----
      console.log("Engine thinking...");
      const mv: EngineMove | null = pickBestMove(board, engineSide, depth, {
        maxMs,
      });

      if (!mv) {
        console.log("Engine found no move; game over.");
        break;
      }

      // Describe move
      if (mv.kind === "arrange") {
        const from = xyFromIdx1(mv.from);
        const to = xyFromIdx1(mv.path[mv.path.length - 1]);
        console.log(
          `Engine plays ARRANGE: (${from.x},${from.y}) -> (${to.x},${to.y})`
        );
      } else if (mv.kind === "wheel") {
        const c = xyFromIdx1(mv.center);
        console.log(`Engine plays WHEEL at (${c.x},${c.y})`);
      } else if (mv.kind === "boatFlower") {
        const b = xyFromIdx1(mv.boat);
        const from = xyFromIdx1(mv.from);
        const to = xyFromIdx1(mv.to);
        console.log(
          `Engine plays BOAT-FLOWER: boat at (${b.x},${b.y}) carries (${from.x},${from.y}) -> (${to.x},${to.y})`
        );
      } else if (mv.kind === "boatAccent") {
        const b = xyFromIdx1(mv.boat);
        const t = xyFromIdx1(mv.target);
        console.log(
          `Engine plays BOAT-ACCENT: boat at (${b.x},${b.y}) interacts with accent at (${t.x},${t.y})`
        );
      }

      board = applyEngineMove(board, engineSide, mv);

      const ringWinner = checkRingGameOver(board);
      printBoard(board);

      if (ringWinner) {
        if (ringWinner === "double") {
          console.log("Both players formed a ring – double ring draw!");
        } else if (ringWinner === engineSide) {
          console.log("Engine formed a ring – engine wins!");
        } else {
          console.log("You have a ring after engine move – you win!");
        }
        break;
      }

      const evalHost = evaluate(board, "host");
      console.log(`Position eval (host POV): ${evalHost.toFixed(2)}\n`);
    }

    sideToMove = sideToMove === "host" ? "guest" : "host";
    ply++;
  }

  console.log("Game loop ended.");
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
