// src/parseNotation.ts
// Converts your handwritten notation into a GameRecord.
//
// Supports lines like:
//   1G.R3(0,-8)
//   2H.(0,8)-(-1,7)
//   4H.(0,8)-(1,7)+R4(-8,0)
//   9G.(8,0)-(7,1)+B(-6,0)-(-7,-1)
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

  // NOTE: Your 0H.B,K,W,R / 0G.W,K,K,B lines describe pools, not board setup.
  // We currently ignore them for board placement; pools are handled in play.ts.
  // (We still support parsing them later if we ever want to record pools.)

  const moveLines: MoveLine[] = [];

  for (const ln of lines) {
    if (/^RESULT/i.test(ln)) {
      const parts = ln.split(/\s+/);
      const r = (parts[1] ?? "").toLowerCase();
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

  for (const ml of moveLines) {
    const side: Side = ml.side;
    const raw = ml.raw;

    // Split "main + accent + accent ..." parts
    const parts = raw.split("+").map(s => s.trim());
    const main = parts[0];

    // ------------------------------------------------------------------
    // 3A) PLACEMENT main: TYPE(x,y)  e.g. R3(0,-8), L(8,0), O(0,8)
    // ------------------------------------------------------------------
    const placeMatch = main.match(/^([A-Z][0-9A-Za-z]*)\((-?\d+),\s*(-?\d+)\)$/);
    if (placeMatch) {
      const typeName = placeMatch[1] as keyof typeof TypeIdNames;
      const tx = parseInt(placeMatch[2], 10);
      const ty = parseInt(placeMatch[3], 10);
      const idx1 = xyToIndex1(tx, ty);

      moves.push({
        kind: "place",
        side,
        type: typeName,
        index: idx1,
      } as any);

      // Accents after a placement, e.g. R3(0,-8)+K(-6,-1)
      for (let k = 1; k < parts.length; k++) {
        const acc = parts[k];

        // Accent placement: TYPE(x,y)
        const accPlace = acc.match(/^([A-Z][0-9A-Za-z]*)\((-?\d+),\s*(-?\d+)\)$/);
        if (accPlace) {
          const aTypeName = accPlace[1] as keyof typeof TypeIdNames;
          const ax = parseInt(accPlace[2], 10);
          const ay = parseInt(accPlace[3], 10);
          const aIdx = xyToIndex1(ax, ay);

          moves.push({
            kind: "place",
            side,
            type: aTypeName,
            index: aIdx,
          } as any);
          continue;
        }

        // Boat accent: B(boatX,boatY)-(targetX,targetY)
        const boatAcc = acc.match(/^B\((-?\d+),\s*(-?\d+)\)-\((-?\d+),\s*(-?\d+)\)$/);
        if (boatAcc) {
          const bx = parseInt(boatAcc[1], 10);
          const by = parseInt(boatAcc[2], 10);
          const tx = parseInt(boatAcc[3], 10);
          const ty = parseInt(boatAcc[4], 10);

          moves.push({
            kind: "boatAccentXY",
            side,
            boatXY: [bx, by],
            targetXY: [tx, ty],
          } as any);
          continue;
        }

        throw new Error(`Bad accent: ${acc}`);
      }

      continue;
    }

    // ------------------------------------------------------------------
    // 3B) ARRANGE main: (x1,y1)-(x2,y2)
    // ------------------------------------------------------------------
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
        pathXY: [[x2, y2]],
      } as any);

      // Accents after arrange, e.g. (0,8)-(1,7)+R4(-8,0) or +B(-6,0)-(-7,-1)
      for (let k = 1; k < parts.length; k++) {
        const acc = parts[k];

        // Accent placement
        const accPlace = acc.match(/^([A-Z][0-9A-Za-z]*)\((-?\d+),\s*(-?\d+)\)$/);
        if (accPlace) {
          const aTypeName = accPlace[1] as keyof typeof TypeIdNames;
          const ax = parseInt(accPlace[2], 10);
          const ay = parseInt(accPlace[3], 10);
          const aIdx = xyToIndex1(ax, ay);

          moves.push({
            kind: "place",
            side,
            type: aTypeName,
            index: aIdx,
          } as any);
          continue;
        }

        // Boat accent: B(boatX,boatY)-(targetX,targetY)
        const boatAcc = acc.match(/^B\((-?\d+),\s*(-?\d+)\)-\((-?\d+),\s*(-?\d+)\)$/);
        if (boatAcc) {
          const bx = parseInt(boatAcc[1], 10);
          const by = parseInt(boatAcc[2], 10);
          const tx = parseInt(boatAcc[3], 10);
          const ty = parseInt(boatAcc[4], 10);

          moves.push({
            kind: "boatAccentXY",
            side,
            boatXY: [bx, by],
            targetXY: [tx, ty],
          } as any);
          continue;
        }

        throw new Error(`Bad accent: ${acc}`);
      }

      continue;
    }

    // If we get here, we don't recognize the main pattern
    throw new Error(`Unrecognized notation: ${raw}`);
  }

  const game: GameRecord = {
    id: "notation",
    setup,
    moves,
    result,
  };

  return game;
}
