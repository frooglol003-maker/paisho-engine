// src/parse.ts
// Parse & apply high-ELO game records to Board states.
// Supports setup placements, Arrange paths, Wheel rotation, Boat-on-flower, Boat-on-accent.
// Now also supports XY-friendly actions to avoid index guesswork.

import * as fs from "fs";
import * as readline from "readline";
import { Board, TypeId, Owner, unpackPiece, packPiece } from "./board";
import { coordsOf, indexOf } from "./coords";
import { validateArrange } from "./move";
import { applyPlannedArrange } from "./engine";
import { getGardenType, isGateCoord } from "./rules";

// ====== Types ======
export type Side = "host" | "guest";
export type Result = "host" | "guest" | "draw";

export type Placement = {
  owner: Side;
  type: keyof typeof TypeIdNames; // "R3"|"W4"|...
  index?: number; // 1-based index
  x?: number;     // optional (x,y) instead of index
  y?: number;
};

// Index-based actions (backward compatible)
export type ActionIndex =
  | { kind: "arrange";     side: Side; from: number; path: number[] } // indices 1-based
  | { kind: "wheel";       side: Side; center: number }
  | { kind: "boatFlower";  side: Side; boat: number; from: number; to: number }
  | { kind: "boatAccent";  side: Side; boat: number; target: number };

// XY-based actions (new)
export type ActionXY =
  | { kind: "arrangeXY";     side: Side; fromXY: [number, number]; pathXY: [number, number][] }
  | { kind: "wheelXY";       side: Side; centerXY: [number, number] }
  | { kind: "boatFlowerXY";  side: Side; boatXY: [number, number]; fromXY: [number, number]; toXY: [number, number] }
  | { kind: "boatAccentXY";  side: Side; boatXY: [number, number]; targetXY: [number, number] };

// Union of all accepted actions
export type Action = ActionIndex | ActionXY;

export type GameRecord = {
  id?: string;
  setup?: Placement[];
  moves: Action[];
  result: Result;
};

// ====== Mapping piece names -> TypeId ======
export const TypeIdNames: Record<string, TypeId> = {
  R3: TypeId.R3,
  R4: TypeId.R4,
  R5: TypeId.R5,
  W3: TypeId.W3,
  W4: TypeId.W4,
  W5: TypeId.W5,
  Lotus: TypeId.Lotus,
  Orchid: TypeId.Orchid,
  Rock: TypeId.Rock,
  Wheel: TypeId.Wheel,
  Boat: TypeId.Boat,
  Knotweed: TypeId.Knotweed,
};

// ====== Helpers ======
function toIndex1FromPlacement(p: Placement): number {
  if (typeof p.index === "number") return p.index;
  if (typeof p.x === "number" && typeof p.y === "number") {
    const i0 = indexOf(p.x, p.y);
    if (i0 === -1) throw new Error(`invalid (x,y)=(${p.x},${p.y})`);
    return i0 + 1;
  }
  throw new Error("Placement needs either index or (x,y).");
}

function xyToIndex1(x: number, y: number): number {
  const i0 = indexOf(x, y);
  if (i0 === -1) throw new Error(`invalid XY (${x},${y})`);
  return i0 + 1;
}

function toOwnerEnum(owner: Side): Owner {
  return owner === "host" ? Owner.Host : Owner.Guest;
}

function typeFromName(name: string): TypeId {
  const t = TypeIdNames[name];
  if (t === undefined) throw new Error(`Unknown piece type name: ${name}`);
  return t;
}

export function applySetup(board: Board, setup?: Placement[]) {
  if (!setup) return;
  for (const pl of setup) {
    const idx1 = toIndex1FromPlacement(pl);
    const packed = packPiece(typeFromName(pl.type), toOwnerEnum(pl.owner));
    board.setAtIndex(idx1, packed);
  }
}

// ----- Arrange (index-based) via validator + apply
export function applyArrange(board: Board, _side: Side, from: number, path: number[]) {
  const ok = validateArrange(board, from, path);
  if (!ok.ok) throw new Error(`arrange invalid: ${ok.reason ?? "unknown"}`);
  return applyPlannedArrange(board, { from, path });
}

// ----- Arrange (XY-based) convenience wrapper
export function applyArrangeXY(
  board: Board,
  side: Side,
  fromXY: [number, number],
  pathXY: [number, number][]
) {
  const from = xyToIndex1(fromXY[0], fromXY[1]);
  const path = pathXY.map(([x, y]) => xyToIndex1(x, y));
  return applyArrange(board, side, from, path);
}

// ====== Wheel logic ======

// Rotate the 8 surrounding intersections (king ring) clockwise.
// Also enforce:
//  - Illegal if any neighbor is a Rock
//  - Illegal if any neighbor is a flower that is in a gate
function isFlowerType(t: TypeId): boolean {
  return (
    t === TypeId.R3 ||
    t === TypeId.R4 ||
    t === TypeId.R5 ||
    t === TypeId.W3 ||
    t === TypeId.W4 ||
    t === TypeId.W5 ||
    t === TypeId.Lotus ||
    t === TypeId.Orchid
  );
}

function isGateXY(x: number, y: number): boolean {
  return isGateCoord(x, y);
}

export function applyWheel(
  board: Board,
  _side: any,          // CLI doesn't need the side here
  centerIdx1: number
): Board {
  const centerXY = coordsOf(centerIdx1 - 1);
  if (!centerXY) throw new Error("Invalid wheel center index");
  const { x: cx, y: cy } = centerXY;

  // 8 neighbors around (cx,cy), clockwise, starting from top-left
  const ring = [
    { x: cx - 1, y: cy + 1 }, // 0 top-left
    { x: cx,     y: cy + 1 }, // 1 top
    { x: cx + 1, y: cy + 1 }, // 2 top-right
    { x: cx + 1, y: cy     }, // 3 right
    { x: cx + 1, y: cy - 1 }, // 4 bottom-right
    { x: cx,     y: cy - 1 }, // 5 bottom
    { x: cx - 1, y: cy - 1 }, // 6 bottom-left
    { x: cx - 1, y: cy     }, // 7 left
  ];

  const idxs = ring.map(({ x, y }) => {
    const i0 = indexOf(x, y);
    return i0 === -1 ? null : i0 + 1;
  });

  // --- Legality checks ---
  for (let i = 0; i < idxs.length; i++) {
    const idx1 = idxs[i];
    if (!idx1) continue;

    const packed = board.getAtIndex(idx1);
    if (!packed) continue;

    const p = unpackPiece(packed)!;
    const { x, y } = ring[i];

    // 1) Illegal if touching a Rock
    if (p.type === TypeId.Rock) {
      throw new Error("Illegal wheel: adjacent to a Rock.");
    }

    // 2) Illegal if moving a flower that is currently in a gate
    if (isGateXY(x, y) && isFlowerType(p.type)) {
      throw new Error("Illegal wheel: cannot move a flower in a gate.");
    }
  }

  // --- Perform clockwise rotation on the ring ---
  const vals = idxs.map(i => (i ? board.getAtIndex(i) || 0 : 0));
  const rotated = vals.slice();

  // clockwise: each neighbor takes the value of the previous one
  for (let i = 0; i < 8; i++) {
    const from = (i + 7) % 8; // previous index
    rotated[i] = vals[from];
  }

  // write back
  for (let i = 0; i < 8; i++) {
    const idx1 = idxs[i];
    if (!idx1) continue;
    board.setAtIndex(idx1, rotated[i]);
  }

  return board;
}

// ----- Wheel (XY-based)
export function applyWheelXY(board: Board, _side: Side, centerXY: [number, number]) {
  const center = xyToIndex1(centerXY[0], centerXY[1]);
  return applyWheel(board, _side, center);
}

// ====== Boat logic ======

function isFlowerPieceType(t: TypeId): boolean {
  return (
    t === TypeId.R3 ||
    t === TypeId.R4 ||
    t === TypeId.R5 ||
    t === TypeId.W3 ||
    t === TypeId.W4 ||
    t === TypeId.W5 ||
    t === TypeId.Lotus ||
    t === TypeId.Orchid
  );
}

function canFlowerStopAt(type: TypeId, x: number, y: number): boolean {
  const g = getGardenType(x, y); // "red" | "white" | "neutral"
  if (g === "neutral") return true;

  const isRed = type === TypeId.R3 || type === TypeId.R4 || type === TypeId.R5;
  const isWhite = type === TypeId.W3 || type === TypeId.W4 || type === TypeId.W5;

  if (g === "red" && isWhite) return false;
  if (g === "white" && isRed) return false;

  // Lotus / Orchid are allowed anywhere
  return true;
}

/**
 * Boat-on-flower:
 *  - boat stays where it is (one-time use, inert afterward)
 *  - from and to must both be among the 8 neighbors of the boat
 *  - from must contain a flower
 *  - to must be empty
 *  - final landing must be garden-legal for that flower
 */
export function applyBoatFlower(
  board: Board,
  _side: Side,
  boatIdx1: number,
  fromIdx1: number,
  toIdx1: number
): Board {
  const boatXY = coordsOf(boatIdx1 - 1);
  if (!boatXY) throw new Error("invalid boat index");
  const { x: bx, y: by } = boatXY;

  const ring = [
    { x: bx - 1, y: by + 1 },
    { x: bx,     y: by + 1 },
    { x: bx + 1, y: by + 1 },
    { x: bx + 1, y: by     },
    { x: bx + 1, y: by - 1 },
    { x: bx,     y: by - 1 },
    { x: bx - 1, y: by - 1 },
    { x: bx - 1, y: by     },
  ];

  const ringIdxs = ring.map(({ x, y }) => {
    const i0 = indexOf(x, y);
    return i0 === -1 ? null : i0 + 1;
  });

  const isInRing = (idx1: number) => ringIdxs.some(i => i === idx1);

  if (!isInRing(fromIdx1)) throw new Error("boatFlower: 'from' must be adjacent to boat");
  if (!isInRing(toIdx1))   throw new Error("boatFlower: 'to' must be adjacent to boat");
  if (fromIdx1 === toIdx1) throw new Error("boatFlower: from and to must differ");

  const cloned = board.clone();

  const fromPacked = cloned.getAtIndex(fromIdx1);
  if (!fromPacked) throw new Error("boatFlower: no piece at 'from'");
  const fromPiece = unpackPiece(fromPacked)!;

  if (!isFlowerPieceType(fromPiece.type)) {
    throw new Error("boatFlower: can only move flowers");
  }

  const toPacked = cloned.getAtIndex(toIdx1);
  if (toPacked) {
    throw new Error("boatFlower: 'to' must be empty");
  }

  const toXY = coordsOf(toIdx1 - 1);
  if (!toXY) throw new Error("boatFlower: invalid 'to' coordinate");

  if (!canFlowerStopAt(fromPiece.type, toXY.x, toXY.y)) {
    throw new Error("boatFlower: flower cannot stop on that garden");
  }

  // Move the flower; boat stays put.
  cloned.setAtIndex(fromIdx1, 0);
  cloned.setAtIndex(toIdx1, fromPacked);

  return cloned;
}

// ----- Boat-on-flower (XY-based)
export function applyBoatFlowerXY(
  board: Board,
  side: Side,
  boatXY: [number, number],
  fromXY: [number, number],
  toXY: [number, number]
) {
  const boat = xyToIndex1(boatXY[0], boatXY[1]);
  const from = xyToIndex1(fromXY[0], fromXY[1]);
  const to   = xyToIndex1(toXY[0],  toXY[1]);
  return applyBoatFlower(board, side, boat, from, to);
}

// Accent tiles = Rock, Wheel, Knotweed, Boat itself.
function isAccentType(t: TypeId): boolean {
  return t === TypeId.Rock || t === TypeId.Wheel || t === TypeId.Boat || t === TypeId.Knotweed;
}

/**
 * Boat-on-accent:
 *  - target must be one of the 8 neighbors of the boat
 *  - target must be an accent tile (Rock/Wheel/Boat/Knotweed)
 *  - removes BOTH the boat and the target accent
 *  - rest of legality (clash, etc.) is handled by detectAnyClash in play.ts
 */
export function applyBoatAccent(
  board: Board,
  _side: Side,
  boatIdx1: number,
  targetIdx1: number
): Board {
  const boatXY = coordsOf(boatIdx1 - 1);
  if (!boatXY) throw new Error("boatAccent: invalid boat index");

  const { x: bx, y: by } = boatXY;

  const ring = [
    { x: bx - 1, y: by + 1 },
    { x: bx,     y: by + 1 },
    { x: bx + 1, y: by + 1 },
    { x: bx + 1, y: by     },
    { x: bx + 1, y: by - 1 },
    { x: bx,     y: by - 1 },
    { x: bx - 1, y: by - 1 },
    { x: bx - 1, y: by     },
  ];

  const ringIdxs = ring.map(({ x, y }) => {
    const i0 = indexOf(x, y);
    return i0 === -1 ? null : i0 + 1;
  });

  if (!ringIdxs.some(i => i === targetIdx1)) {
    throw new Error("boatAccent: target must be adjacent to boat");
  }

  const boatPacked = board.getAtIndex(boatIdx1);
  if (!boatPacked) throw new Error("boatAccent: no boat at given index");
  const boatPiece = unpackPiece(boatPacked)!;
  if (boatPiece.type !== TypeId.Boat) {
    throw new Error("boatAccent: source piece is not a Boat");
  }

  const targetPacked = board.getAtIndex(targetIdx1);
  if (!targetPacked) throw new Error("boatAccent: no piece at target");
  const targetPiece = unpackPiece(targetPacked)!;

  if (!isAccentType(targetPiece.type)) {
    throw new Error("boatAccent: target is not an accent tile");
  }

  const cloned = board.clone();
  // Remove BOTH boat and accent.
  cloned.setAtIndex(boatIdx1, 0);
  cloned.setAtIndex(targetIdx1, 0);

  return cloned;
}

// ----- Boat-on-accent (XY-based)
export function applyBoatAccentXY(
  board: Board,
  side: Side,
  boatXY: [number, number],
  targetXY: [number, number]
) {
  const boat   = xyToIndex1(boatXY[0],   boatXY[1]);
  const target = xyToIndex1(targetXY[0], targetXY[1]);
  return applyBoatAccent(board, side, boat, target);
}

// ----- Apply any action -----
export function applyAction(board: Board, action: Action): Board {
  switch (action.kind) {
    // Index-based
    case "arrange":       return applyArrange(board, action.side, action.from, action.path);
    case "wheel":         return applyWheel(board, action.side, action.center);
    case "boatFlower":    return applyBoatFlower(board, action.side, action.boat, action.from, action.to);
    case "boatAccent":    return applyBoatAccent(board, action.side, action.boat, action.target);

    // XY-based
    case "arrangeXY":     return applyArrangeXY(board, action.side, action.fromXY, action.pathXY);
    case "wheelXY":       return applyWheelXY(board, action.side, action.centerXY);
    case "boatFlowerXY":  return applyBoatFlowerXY(board, action.side, action.boatXY, action.fromXY, action.toXY);
    case "boatAccentXY":  return applyBoatAccentXY(board, action.side, action.boatXY, action.targetXY);

    default: {
      const _never: never = action as never;
      throw new Error(`Unknown action kind: ${(action as any).kind}`);
    }
  }
}

// Load JSONL file -> GameRecord[] (with line numbers on errors)
export async function loadGames(jsonlPath: string): Promise<GameRecord[]> {
  const games: GameRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    try {
      games.push(JSON.parse(trimmed));
    } catch (e: any) {
      throw new Error(
        `JSONL parse error at ${jsonlPath}:${lineNo}\nLine: ${trimmed}\n${e.message}`
      );
    }
  }
  return games;
}
