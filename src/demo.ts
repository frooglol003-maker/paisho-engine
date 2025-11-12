// src/demo.ts
import { Board, TypeId, Owner, packPiece } from "./board";
import { pickBestMove } from "./engine";
import { coordsOf, indexOf } from "./coords";

function idx1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function setupSmallPosition(): Board {
  const b = new Board();

  // Host R3 at (0,0) [neutral midline]
  b.setAtIndex(idx1(0, 0), packPiece(TypeId.R3, Owner.Host));

  // Guest W3 at (1,0) [neutral midline]
  b.setAtIndex(idx1(1, 0), packPiece(TypeId.W3, Owner.Guest));

  // Extra host piece to create options (R4 at (0,1))
  b.setAtIndex(idx1(0, 1), packPiece(TypeId.R4, Owner.Host));

  return b;
}

function printMove(m: any) {
  if (!m) { console.log("Engine returned no move."); return; }
  if (m.kind === "arrange") {
    const fromXY = coordsOf(m.from - 1);
    const toXY = coordsOf(m.path[m.path.length - 1] - 1);
    console.log(
      `Engine suggests: ARRANGE from ${JSON.stringify(fromXY)} -> ${JSON.stringify(toXY)} (steps=${m.path.length})`
    );
  } else {
    console.log("Engine suggests:", m);
  }
}

async function main() {
  const board = setupSmallPosition();
  const depth = 3; // try 2–4
  const move = pickBestMove(board, "host", depth);
  printMove(move);
}

main().catch(e => { console.error(e); process.exit(1); });
