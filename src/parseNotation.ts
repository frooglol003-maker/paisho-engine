// src/parseNotation.ts
// Converts your handwritten notation into a GameRecord.
//
// Supports lines like:
//   0H.B,K,W,R
//   1G.R3(0,-8)
//   2H.(0,8)-(-1,7)+R4(-8,0)
//   RESULT guest

import { GameRecord, Placement, Action, Side, TypeIdNames } from "./parse";
import { indexOf } from "./coords";

type MoveLine = {
  ply: number;
  side: Side;
  raw: string;
};

function sideOf(s: string): Side {
  return s === "H" ? "host" : "guest";
}

function parseXY(str: string): [number, number] {
  const m = str.match(/\((-?\d+),\s*(-?\d+)\)/);
  if (!m) throw new Error(`Bad coordinate: ${str}`);
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

function xyToIndex1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`Invalid board coord (${x},${y})`);
  return i0 + 1;
}

export function parseNotationToGameRecord(text: string): GameRecord {
  const lines = text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const setup: Placement[] = [];
  const moves: Action[] = [];
  let result: "host" | "guest" | "draw" = "draw";

  // 1) First find setup lines (ply 0)
  for (const ln of lines) {
    if (!ln.startsWith("0H.") && !ln.startsWith("0G.")) continue;

    const side = sideOf(ln[1]);

    // Example: "0H.B,K,W,R"
    const after = ln.slice(3);
    const names = after.split(",").map(s => s.trim());
    for (const n of names) {
      const t = TypeIdNames[n];
      if (!t) throw new Error(`Unknown piece in setup: ${n}`);
      // For setup, no coordinates: the engine places them automatically?
      // But you provided no XYs, so we can't put them on the board.
      // Standard Paisho: 0H and 0G lines specify the pool pieces, not placements.
      // So we IGNORE these as board placements; they only indicate pool availability.
      // -> No placements added.
    }
  }

  // 2) Parse move lines (ply >= 1)
  const moveLines: MoveLine[] = [];

  for (const ln of lines) {
    if (/^RESULT/i.test(ln)) {
      const parts = ln.split(/\s+/);
      const r = parts[1]?.toLowerCase();
      if (r === "host") result = "host";
      else if (r === "guest") result = "guest";
      else result = "draw";
      continue;
    }

    const m = ln.match(/^(\d+)(H|G)\.(.+)$/);
    if (!m) continue;

    const ply = parseInt(m[1], 10);
    const side = sideOf(m[2]);
    const raw = m[3].trim();

    moveLines.push({ ply, side, raw });
  }

  moveLines.sort((a, b) => a.ply - b.ply);

  // 3) Convert each move into engine-style Action[]
  for (const ml of moveLines) {
    const side: Side = ml.side;

    const raw = ml.raw;

    // PREFIXES:
    //   R3(1,2) = placement
    //   (x,y)-(x2,y2) = arrange
    //   +(tile) = accent in same move
    //   +R4(8,0) = place accent
    //   +K(-6,-1) etc

    // Check for composite moves like:
    //    (0,8)-(1,7)+R4(-8,0)

    const parts = raw.split("+").map(s => s.trim());
    const main = parts[0];

    // 3A) Placement with TYPE(x,y)
    const placeMatch = main.match(/^([A-Z][0-9A-Za-z]*)\((-?\d+),\s*(-?\d+)\)$/);
    if (placeMatch) {
      const typeName = placeMatch[1];
      const tx = parseInt(placeMatch[2], 10);
      const ty = parseInt(placeMatch[3], 10);

      const idx1 = xyToIndex1(tx, ty);

      moves.push({
        kind: "place",
        side,
        type: typeName,
        index: idx1
      } as any);

      // Handle trailing accents (like +R4(-8,0))
      for (let k = 1; k < parts.length; k++) {
        const acc = parts[k];
        const mm = acc.match(/^([A-Z][0-9A-Za-z]*)\((-?\d+),\s*(-?\d+)\)$/);
        if (!mm) throw new Error(`Bad accent: ${acc}`);
        const tname = mm[1];
        const ax = parseInt(mm[2], 10);
        const ay = parseInt(mm[3], 10);
        const idxA = xyToIndex1(ax, ay);
        moves.push({
          kind: "place",
          side,
          type: tname,
          index: idxA
        } as any);
      }

      continue;
    }

    // 3B) Arrange moves: (x1,y1)-(x2,y2)
    const arrMatch = main.match(/^\((-?\d+),\s*(-?\d+)\)-\((-?\d+),\s*(-?\d+)\)$/);
    if (arrMatch) {
      const x1 = parseInt(arrMatch[1], 10);
      const y1 = parseInt(arrMatch[2], 10);
      const x2 = parseInt(arrMatch[3], 10);
      const y2 = parseInt(arrMatch[4], 10);

      moves.push({
        kind: "arrangeXY",
        side,
        fromXY: [x1, y1],
        pathXY: [[x2, y2]]
      });

      // Accents still allowed
      for (let k = 1; k < parts.length; k++) {
        const acc = parts[k];
        const mm = acc.match(/^([A-Z][0-9A-Za-z]*)\((-?\d+),\s*(-?\d+)\)$/);
        if (!mm) throw new Error(`Bad accent: ${acc}`);
        const tname = mm[1];
        const ax = parseInt(mm[2], 10);
        const ay = parseInt(mm[3], 10);
        const idxA = xyToIndex1(ax, ay);
        moves.push({
          kind: "place",
          side,
          type: tname,
          index: idxA
        } as any);
      }

      continue;
    }

    throw new Error(`Unrecognized notation: ${raw}`);
  }

  return {
    id: "notation",
    setup,
    moves,
    result
  };
}
