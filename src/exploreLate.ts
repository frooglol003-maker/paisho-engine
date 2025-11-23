import * as fs from "fs";
import { Board, unpackPiece, TypeId, Owner, packPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { listHarmonyEdges, getRingOwners } from "./move";
import { applyMoveCloned, generateAllMoves, Side } from "./engine";

export type TreeNode = {
  id: number;
  parent: number | null;
  depth: number;
  move: string | null;
  terminal: "ongoing" | "hostRing" | "guestRing" | "doubleRing";
  pieces: {
    x: number; y: number;
    type: string;
    owner: "host" | "guest";
  }[];
};

let nextId = 1;

function classify(board: Board) {
  const rings = getRingOwners(board);
  if (rings.host && rings.guest) return "doubleRing";
  if (rings.host) return "hostRing";
  if (rings.guest) return "guestRing";
  return "ongoing";
}

function dump(board: Board, parent: number | null, depth: number, move: string | null): TreeNode {
  const N = (board as any).size1Based ?? 249;
  const pieces = [];
  for (let i = 1; i <= N; i++) {
    const p = board.getAtIndex(i);
    if (!p) continue;
    const u = unpackPiece(p);
    const { x, y } = coordsOf(i - 1);
    pieces.push({
      x, y,
      type: TypeId[u!.type],
      owner: u!.owner === Owner.Host ? "host" : "guest",
    });
  }
  return {
    id: nextId++,
    parent,
    depth,
    move,
    terminal: classify(board),
    pieces,
  };
}

export function exploreLateGame(rootBoard: Board, side: Side, maxDepth: number, filename: string) {
  const out = fs.createWriteStream(filename);

  function rec(board: Board, side: Side, depth: number, parent: number | null) {
    const node = dump(board, parent, depth, null);
    out.write(JSON.stringify(node) + "\n");

    if (node.terminal !== "ongoing") return;
    if (depth >= maxDepth) return;

    const baseEdges = JSON.stringify(listHarmonyEdges(board));

    const moves = generateAllMoves(board, side);
    for (const mv of moves) {
      let child: Board;
      try {
        child = applyMoveCloned(board, side, mv);
      } catch {
        continue;
      }
      const moved = JSON.stringify(listHarmonyEdges(child));
      const changed = moved !== baseEdges;

      const cm = classify(child);

      if (changed || cm !== "ongoing") {
        const label = JSON.stringify(mv);
        const childNode = dump(child, node.id, depth + 1, label);
        out.write(JSON.stringify(childNode) + "\n");

        if (childNode.terminal === "ongoing")
          rec(child, side === "host" ? "guest" : "host", depth + 1, childNode.id);
      }
    }
  }

  rec(rootBoard, side, 0, null);
  out.end();
}

// CLI
if (require.main === module) {
  const snap = JSON.parse(fs.readFileSync("snapshot-after-3.json", "utf8"));
  const b = new Board();
  for (const p of snap.pieces) {
    const i0 = indexOf(p.x, p.y);
    const idx1 = i0 + 1;
    b.setAtIndex(idx1, packPiece(TypeId[p.type], p.owner === "host" ? Owner.Host : Owner.Guest));
  }
  exploreLateGame(b, "guest", 3, "lategame-tree.jsonl");
}
