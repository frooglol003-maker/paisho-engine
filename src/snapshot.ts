import * as fs from "fs";
import { Board, unpackPiece, TypeId, Owner } from "./board";
import { applyAction, GameRecord } from "./parse";
import { coordsOf } from "./coords";

export type PieceDump = {
  x: number;
  y: number;
  type: string;
  owner: "host" | "guest";
};

export type BoardDump = {
  moveCount: number;
  pieces: PieceDump[];
};

function dumpBoard(b: Board, moveCount: number): BoardDump {
  const N = (b as any).size1Based ?? 249;
  const out: PieceDump[] = [];
  for (let i = 1; i <= N; i++) {
    const packed = b.getAtIndex(i);
    if (!packed) continue;
    const d = unpackPiece(packed)!;
    const { x, y } = coordsOf(i - 1);
    out.push({
      x, y,
      type: TypeId[d.type],
      owner: d.owner === Owner.Host ? "host" : "guest"
    });
  }
  return { moveCount, pieces: out };
}

export function snapshotAfterMoves(game: GameRecord, plyLimit: number) {
  const b = new Board();
  if (game.setup) {
    const { applySetup } = require("./parse");
    applySetup(b, game.setup);
  }

  let count = 0;
  for (const action of game.moves) {
    if (count >= plyLimit) break;
    applyAction(b, action);
    count++;
  }

  return dumpBoard(b, count);
}

// CLI
if (require.main === module) {
  const raw = fs.readFileSync("game.json", "utf8");
  const g = JSON.parse(raw) as GameRecord;
  const snap = snapshotAfterMoves(g, 3);
  fs.writeFileSync("snapshot-after-3.json", JSON.stringify(snap, null, 2));
  console.log("Wrote snapshot-after-3.json");
}
