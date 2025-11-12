"use strict";
// engine.ts
// Simple minimax engine with alpha-beta using the evaluator and move generation stubs.
// The move generation is minimal: plant into empty gates from reserve and basic arrange moves.
// You should expand move generation to include accents, special-flowers, and wheel/boat effects.
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateMoves = generateMoves;
exports.applyMove = applyMove;
exports.minimax = minimax;
const board_1 = require("./board");
const coords_1 = require("./coords");
const move_1 = require("./move");
const eval_1 = require("./eval");
function generatePlantMoves(board, owner, reserveTypes) {
    const moves = [];
    const gates = [
        (0, coords_1.indexOf)(8, 0),
        (0, coords_1.indexOf)(-8, 0),
        (0, coords_1.indexOf)(0, 8),
        (0, coords_1.indexOf)(0, -8)
    ];
    for (const g of gates) {
        if (board.getAtIndex(g) === 0) {
            for (const t of reserveTypes) {
                // only basic or special types can be planted into gate per rules (mostly basics or specials)
                moves.push({ type: "plant", owner, typeId: t, gateIdx: g });
            }
        }
    }
    return moves;
}
/* Generate reachable destinations for a flower at index up to limit, using BFS that allows turning.
   We will return moves as arrange with a representative path (shortest path to dest).
   For completeness, you might want to enumerate different distinct paths but a single representative path is enough for engine.
*/
function generateArrangeMoves(board, fromIdx) {
    const packed = board.getAtIndex(fromIdx);
    if (!packed)
        return [];
    const p = (0, board_1.unpackPiece)(packed);
    let limit = 1;
    switch (p.type) {
        case board_1.TypeId.R3:
            limit = 3;
            break;
        case board_1.TypeId.R4:
            limit = 4;
            break;
        case board_1.TypeId.R5:
            limit = 5;
            break;
        case board_1.TypeId.W3:
            limit = 3;
            break;
        case board_1.TypeId.W4:
            limit = 4;
            break;
        case board_1.TypeId.W5:
            limit = 5;
            break;
        case board_1.TypeId.Lotus:
            limit = 2;
            break;
        case board_1.TypeId.Orchid:
            limit = 6;
            break;
        default: return [];
    }
    // BFS
    const q = [];
    const seen = new Set();
    q.push({ idx: fromIdx, path: [] });
    seen.add(fromIdx);
    const results = [];
    while (q.length > 0) {
        const cur = q.shift();
        if (cur.path.length >= limit)
            continue;
        const neighbors = orthNeighbors(cur.idx);
        for (const nb of neighbors) {
            if (nb === fromIdx)
                continue;
            if (cur.path.includes(nb))
                continue;
            // cannot pass through occupied squares except possibly as a final landing square (capture)
            const occ = board.getAtIndex(nb);
            const isFinal = true; // in BFS we add neighbor as destination candidate
            // Only allow stepping into nb if it's empty or capture (occupied by opponent)
            if (occ && occ !== 0) {
                // if occupant same owner, cannot land; skip neighbor also as passing-block
                if (((0, board_1.unpackPiece)(occ).owner) === ((0, board_1.unpackPiece)(packed).owner))
                    continue;
                // else capture allowed as final
            }
            const newPath = cur.path.concat([nb]);
            // validate full path via validateArrange
            const v = (0, move_1.validateArrange)(board, fromIdx, newPath);
            if (v.ok) {
                results.push({ type: "arrange", from: fromIdx, path: newPath });
            }
            // only enqueue nb for further exploration if nb was empty (can't pass through occupied)
            if (!occ) {
                q.push({ idx: nb, path: newPath });
            }
        }
    }
    return results;
}
// small orthNeighbors helper using coords
const coords_2 = require("./coords");
function orthNeighbors(idx) {
    const { x, y } = (0, coords_2.coordsOf)(idx);
    const cand = [
        { x: x + 1, y }, { x: x - 1, y },
        { x, y: y + 1 }, { x, y: y - 1 }
    ];
    const out = [];
    for (const c of cand) {
        try {
            out.push((0, coords_1.indexOf)(c.x, c.y));
        }
        catch { }
    }
    return out;
}
/* Generate a list of pseudo-legal moves for a player.
   reserveTypes is a list of TypeId the player can plant (their reserve).
*/
function generateMoves(board, owner, reserveTypes) {
    const moves = [];
    // plant moves
    moves.push(...generatePlantMoves(board, owner, reserveTypes));
    // arrange moves: for each tile belonging to owner generate arrange moves
    const size = board.toArray().length;
    for (let i = 1; i <= size; i++) {
        const packed = board.getAtIndex(i);
        if (!packed)
            continue;
        const dec = (0, board_1.unpackPiece)(packed);
        if (dec.owner === owner) {
            moves.push(...generateArrangeMoves(board, i));
        }
    }
    return moves;
}
/* Apply a move onto a board (mutating copy returned). */
function applyMove(board, move) {
    const next = board.clone();
    if (move.type === "plant") {
        next.setAtIndex(move.gateIdx, (0, board_1.packPiece)(move.typeId, move.owner));
        return next;
    }
    else {
        const fromPacked = next.getAtIndex(move.from);
        next.setAtIndex(move.from, 0);
        const finalIdx = move.path[move.path.length - 1];
        // capture if present
        if (next.getAtIndex(finalIdx))
            next.setAtIndex(finalIdx, 0);
        next.setAtIndex(finalIdx, fromPacked);
        return next;
    }
}
/* Minimax with alpha-beta. depth=ply to search. */
function minimax(board, owner, reserveHost, reserveGuest, depth, maximizingOwner, alpha = -Infinity, beta = Infinity) {
    if (depth === 0) {
        return { score: (0, eval_1.evaluate)(board) };
    }
    const reserve = owner === 0 ? reserveHost : reserveGuest;
    const moves = generateMoves(board, owner, reserve);
    if (moves.length === 0)
        return { score: (0, eval_1.evaluate)(board) };
    let bestMove = undefined;
    if (owner === maximizingOwner) {
        let value = -Infinity;
        for (const m of moves) {
            const child = applyMove(board, m);
            const res = minimax(child, owner === 0 ? 1 : 0, reserveHost, reserveGuest, depth - 1, maximizingOwner, alpha, beta);
            if (res.score > value) {
                value = res.score;
                bestMove = m;
            }
            alpha = Math.max(alpha, value);
            if (alpha >= beta)
                break;
        }
        return { score: value, move: bestMove };
    }
    else {
        let value = Infinity;
        for (const m of moves) {
            const child = applyMove(board, m);
            const res = minimax(child, owner === 0 ? 1 : 0, reserveHost, reserveGuest, depth - 1, maximizingOwner, alpha, beta);
            if (res.score < value) {
                value = res.score;
                bestMove = m;
            }
            beta = Math.min(beta, value);
            if (alpha >= beta)
                break;
        }
        return { score: value, move: bestMove };
    }
}
