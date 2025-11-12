"use strict";
// board.ts
// Compact board representation (Int16Array) and packing helpers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Board = exports.Owner = exports.TypeId = exports.TOTAL_POINTS = void 0;
exports.packPiece = packPiece;
exports.unpackPiece = unpackPiece;
const coords_1 = require("./coords"); // <- imported indexOf
// Total playable intersections (should be 249)
exports.TOTAL_POINTS = (0, coords_1.totalIntersections)();
// Packed piece layout (16-bit integer per square):
// bits 0-3: type id (0 empty, 1..6 basics, 7 lotus, 8 orchid, 9 rock, 10 wheel, 11 boat, 12 knotweed)
// bit 4: owner (0 host/light, 1 guest/dark)
// bits 5-15: reserved for flags (unused for now)
var TypeId;
(function (TypeId) {
    TypeId[TypeId["Empty"] = 0] = "Empty";
    TypeId[TypeId["R3"] = 1] = "R3";
    TypeId[TypeId["R4"] = 2] = "R4";
    TypeId[TypeId["R5"] = 3] = "R5";
    TypeId[TypeId["W3"] = 4] = "W3";
    TypeId[TypeId["W4"] = 5] = "W4";
    TypeId[TypeId["W5"] = 6] = "W5";
    TypeId[TypeId["Lotus"] = 7] = "Lotus";
    TypeId[TypeId["Orchid"] = 8] = "Orchid";
    TypeId[TypeId["Rock"] = 9] = "Rock";
    TypeId[TypeId["Wheel"] = 10] = "Wheel";
    TypeId[TypeId["Boat"] = 11] = "Boat";
    TypeId[TypeId["Knotweed"] = 12] = "Knotweed";
})(TypeId || (exports.TypeId = TypeId = {}));
var Owner;
(function (Owner) {
    Owner[Owner["Host"] = 0] = "Host";
    Owner[Owner["Guest"] = 1] = "Guest";
})(Owner || (exports.Owner = Owner = {}));
function packPiece(type, owner) {
    return (type & 0x0f) | ((owner & 0x01) << 4);
}
function unpackPiece(packed) {
    if (!packed)
        return null;
    const type = (packed & 0x0f);
    const owner = ((packed >> 4) & 0x01) ? Owner.Guest : Owner.Host;
    return { type, owner };
}
class Board {
    constructor(initial) {
        this.size = exports.TOTAL_POINTS;
        if (initial) {
            if (initial.length !== this.size)
                throw new Error("initial length mismatch");
            this.squares = Int16Array.from(initial);
        }
        else {
            this.squares = new Int16Array(this.size);
        }
    }
    getAtIndex(index) {
        if (index < 1 || index > this.size)
            throw new RangeError("invalid index");
        return this.squares[index - 1];
    }
    setAtIndex(index, packed) {
        if (index < 1 || index > this.size)
            throw new RangeError("invalid index");
        this.squares[index - 1] = packed;
    }
    getAtCoord(x, y) {
        const idx = (0, coords_1.indexOf)(x, y);
        return this.getAtIndex(idx);
    }
    setAtCoord(x, y, packed) {
        const idx = (0, coords_1.indexOf)(x, y);
        this.setAtIndex(idx, packed);
    }
    clone() {
        return new Board(this.squares);
    }
    toArray() {
        return Array.from(this.squares);
    }
    // Debug helper — list non-empty squares with coords
    listPieces() {
        const out = [];
        for (let i = 0; i < this.size; i++) {
            const p = this.squares[i];
            if (p) {
                const { x, y } = (0, coords_1.coordsOf)(i + 1);
                out.push({ index: i + 1, x, y, packed: p });
            }
        }
        return out;
    }
}
exports.Board = Board;
