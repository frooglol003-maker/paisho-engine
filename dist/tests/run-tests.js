"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// minimal tests
const coords_1 = require("../coords");
const board_1 = require("../board");
const board_2 = require("../board");
const coords_2 = require("../coords");
const move_1 = require("../move");
function assert(cond, msg) {
    if (!cond)
        throw new Error(msg || "assert failed");
}
function testBoardSize() {
    console.log("Test: total intersections");
    const t = (0, coords_1.totalIntersections)();
    console.log("Total intersections:", t);
    assert(t === 249, `expected 249 intersections, got ${t}`);
}
function testSimpleArrange() {
    console.log("Test: simple arrange validation");
    const b = new board_1.Board();
    // place a Host R3 at (-1,0) (just left of center on midline)
    const from = (0, coords_2.indexOf)(-1, 0);
    b.setAtIndex(from, (0, board_2.packPiece)(board_2.TypeId.R3, 0));
    // move it two steps right to (1,0) via (0,0) (but cannot stop in gate — center is neutral so ok)
    const mid = (0, coords_2.indexOf)(0, 0);
    const to = (0, coords_2.indexOf)(1, 0);
    const result = (0, move_1.validateArrange)(b, from, [mid, to]);
    assert(result.ok, "expected arrange up to 3 steps to be valid");
}
function run() {
    testBoardSize();
    testSimpleArrange();
    console.log("All tests passed.");
}
run();
