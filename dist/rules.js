"use strict";
// rules.ts
// Garden/gate classification, harmony/clash utilities, and piece descriptor helpers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HARMONY_CYCLE = exports.GATES = void 0;
exports.isGateCoord = isGateCoord;
exports.intersectionType = intersectionType;
exports.getGardenType = getGardenType;
exports.toHarmonyId = toHarmonyId;
exports.harmoniousPair = harmoniousPair;
exports.isClashPair = isClashPair;
exports.getPieceDescriptor = getPieceDescriptor;
exports.ownerHasBloomingLotus = ownerHasBloomingLotus;
const coords_1 = require("./coords");
const board_1 = require("./board");
// Gates
exports.GATES = [
    { x: 8, y: 0 },
    { x: -8, y: 0 },
    { x: 0, y: 8 },
    { x: 0, y: -8 },
];
function isGateCoord(x, y) {
    return (Math.abs(x) === 8 && y === 0) || (Math.abs(y) === 8 && x === 0);
}
function intersectionType(x, y) {
    if (isGateCoord(x, y))
        return "gate";
    if (x === 0 || y === 0)
        return "neutral";
    if (Math.abs(x) === Math.abs(y))
        return "neutral";
    if (x * y > 0)
        return "white";
    if (x * y < 0)
        return "red";
    return "neutral";
}
function getGardenType(x, y) {
    const t = intersectionType(x, y);
    if (t === "gate")
        return "gate";
    if (t === "white")
        return "white";
    if (t === "red")
        return "red";
    return "neutral";
}
// Harmony cycle and helpers
exports.HARMONY_CYCLE = ["R3", "R4", "R5", "W3", "W4", "W5"];
function toHarmonyId(garden, num) {
    return (garden + String(num));
}
function harmoniousPair(aGarden, aNum, bGarden, bNum) {
    const ai = exports.HARMONY_CYCLE.indexOf(toHarmonyId(aGarden, aNum));
    const bi = exports.HARMONY_CYCLE.indexOf(toHarmonyId(bGarden, bNum));
    if (ai < 0 || bi < 0)
        return false;
    const d = Math.abs(ai - bi);
    return d === 1 || d === (exports.HARMONY_CYCLE.length - 1);
}
function isClashPair(aGarden, aNum, bGarden, bNum) {
    return (aGarden !== bGarden) && (aNum === bNum);
}
function getPieceDescriptor(board, index) {
    const packed = board.getAtIndex(index);
    if (!packed)
        return { kind: "empty" };
    const decoded = (0, board_1.unpackPiece)(packed);
    const owner = decoded.owner === 0 ? "host" : "guest";
    const { x, y } = (0, coords_1.coordsOf)(index);
    const blooming = !isGateCoord(x, y);
    switch (decoded.type) {
        case board_1.TypeId.R3: return { kind: "basic", owner, garden: "R", number: 3, blooming };
        case board_1.TypeId.R4: return { kind: "basic", owner, garden: "R", number: 4, blooming };
        case board_1.TypeId.R5: return { kind: "basic", owner, garden: "R", number: 5, blooming };
        case board_1.TypeId.W3: return { kind: "basic", owner, garden: "W", number: 3, blooming };
        case board_1.TypeId.W4: return { kind: "basic", owner, garden: "W", number: 4, blooming };
        case board_1.TypeId.W5: return { kind: "basic", owner, garden: "W", number: 5, blooming };
        case board_1.TypeId.Lotus: return { kind: "lotus", owner, blooming };
        case board_1.TypeId.Orchid: {
            // wild is determined by owner having any Blooming Lotus (caller can ask for recompute)
            // default to false here; callers can compute wildness by scanning board for owner's lotus
            return { kind: "orchid", owner, blooming, wild: false };
        }
        case board_1.TypeId.Rock: return { kind: "accent", owner, accent: "rock" };
        case board_1.TypeId.Wheel: return { kind: "accent", owner, accent: "wheel" };
        case board_1.TypeId.Boat: return { kind: "accent", owner, accent: "boat" };
        case board_1.TypeId.Knotweed: return { kind: "accent", owner, accent: "knotweed" };
        default: return { kind: "empty" };
    }
}
// Find if an owner has a blooming lotus on the board
function ownerHasBloomingLotus(board, owner) {
    const pts = (0, coords_1.generateValidPoints)();
    for (let i = 0; i < pts.length; i++) {
        const idx = i + 1;
        const packed = board.getAtIndex(idx);
        if (!packed)
            continue;
        const dec = (0, board_1.unpackPiece)(packed);
        if (dec.type === board_1.TypeId.Lotus) {
            const lotusOwner = dec.owner === 0 ? "host" : "guest";
            const { x, y } = (0, coords_1.coordsOf)(idx);
            if (lotusOwner === owner && !isGateCoord(x, y))
                return true;
        }
    }
    return false;
}
