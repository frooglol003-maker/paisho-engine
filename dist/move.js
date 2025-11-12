"use strict";
// move.ts
// Move validation, clash detection, harmony graph and ring detection.
Object.defineProperty(exports, "__esModule", { value: true });
exports.lineOfSightClear = lineOfSightClear;
exports.detectAnyClash = detectAnyClash;
exports.validateArrange = validateArrange;
exports.buildHarmonyGraph = buildHarmonyGraph;
exports.findHarmonyRings = findHarmonyRings;
const coords_1 = require("./coords");
const board_1 = require("./board");
const rules_1 = require("./rules");
/* Utility to compute orthogonal neighbors (if valid intersection). */
function orthogonalNeighborsIdx(idx) {
    const { x, y } = (0, coords_1.coordsOf)(idx);
    const candidates = [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 }
    ];
    const out = [];
    for (const c of candidates) {
        try {
            const i = (0, coords_1.indexOf)(c.x, c.y);
            out.push(i);
        }
        catch {
            // skip invalid
        }
    }
    return out;
}
/* lineOfSightClear: true if orthogonal straight segment from a to b has no pieces and no gates between them */
function lineOfSightClear(board, aIdx, bIdx) {
    const a = (0, coords_1.coordsOf)(aIdx), b = (0, coords_1.coordsOf)(bIdx);
    if (a.x !== b.x && a.y !== b.y)
        return false;
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    let cx = a.x + dx, cy = a.y + dy;
    while (!(cx === b.x && cy === b.y)) {
        try {
            const idx = (0, coords_1.indexOf)(cx, cy);
            const packed = board.getAtIndex(idx);
            if (packed)
                return false;
            if ((0, rules_1.isGateCoord)(cx, cy))
                return false;
        }
        catch {
            return false;
        }
        cx += dx;
        cy += dy;
    }
    return true;
}
/* detectAnyClash: scan all basic blooming pairs aligned with lineOfSight and test clash */
function detectAnyClash(board) {
    const pts = (0, coords_1.generateValidPoints)();
    for (let i = 0; i < pts.length; i++) {
        const aIdx = i + 1;
        const pA = (0, rules_1.getPieceDescriptor)(board, aIdx);
        if (pA.kind !== "basic")
            continue;
        if (!pA.blooming)
            continue;
        for (let j = 0; j < pts.length; j++) {
            if (i === j)
                continue;
            const bIdx = j + 1;
            const pB = (0, rules_1.getPieceDescriptor)(board, bIdx);
            if (pB.kind !== "basic")
                continue;
            if (!pB.blooming)
                continue;
            // same axis?
            const aC = (0, coords_1.coordsOf)(aIdx), bC = (0, coords_1.coordsOf)(bIdx);
            if (aC.x !== bC.x && aC.y !== bC.y)
                continue;
            if (!lineOfSightClear(board, aIdx, bIdx))
                continue;
            if ((0, rules_1.isClashPair)(pA.garden, pA.number, pB.garden, pB.number))
                return true;
        }
    }
    return false;
}
/* validateArrange: verify a path (list of indices) from fromIdx to a finalIdx */
function validateArrange(board, fromIdx, path) {
    if (path.length === 0)
        return { ok: false, reason: "empty path" };
    const packed = board.getAtIndex(fromIdx);
    if (!packed)
        return { ok: false, reason: "no piece at from index" };
    const decoded = (0, board_1.unpackPiece)(packed);
    if (![board_1.TypeId.R3, board_1.TypeId.R4, board_1.TypeId.R5, board_1.TypeId.W3, board_1.TypeId.W4, board_1.TypeId.W5, board_1.TypeId.Lotus, board_1.TypeId.Orchid].includes(decoded.type)) {
        return { ok: false, reason: "only flower tiles may arrange" };
    }
    // build piece descriptor to get movement limit
    const desc = (0, rules_1.getPieceDescriptor)(board, fromIdx);
    let limit = 0;
    if (desc.kind === "basic")
        limit = desc.number;
    else if (desc.kind === "lotus")
        limit = 2;
    else if (desc.kind === "orchid")
        limit = 6;
    if (path.length > limit)
        return { ok: false, reason: `path too long: ${path.length} > ${limit}` };
    // step-by-step checks
    let prev = fromIdx;
    const seen = new Set([fromIdx]);
    for (let i = 0; i < path.length; i++) {
        const cur = path[i];
        const { x: px, y: py } = (0, coords_1.coordsOf)(prev);
        const { x: cx, y: cy } = (0, coords_1.coordsOf)(cur);
        if (Math.abs(px - cx) + Math.abs(py - cy) !== 1)
            return { ok: false, reason: `non-orthogonal step at step ${i}` };
        // cannot revisit same square in a path (redundant)
        if (seen.has(cur))
            return { ok: false, reason: "path revisits a square (redundant)" };
        seen.add(cur);
        const occ = board.getAtIndex(cur);
        const isFinal = (i === path.length - 1);
        if (occ && !isFinal)
            return { ok: false, reason: `blocked at intermediate ${cur}` };
        if (isFinal && (0, rules_1.isGateCoord)(cx, cy))
            return { ok: false, reason: "cannot end move in a gate" };
        // garden landing checks for basic
        if (isFinal && desc.kind === "basic") {
            const g = (0, rules_1.getGardenType)(cx, cy);
            if (g === "red" && desc.garden === "W")
                return { ok: false, reason: "cannot end in opposite garden (red)" };
            if (g === "white" && desc.garden === "R")
                return { ok: false, reason: "cannot end in opposite garden (white)" };
        }
        prev = cur;
    }
    // simulate final board and check clash
    const finalIdx = path[path.length - 1];
    const simulated = board.clone();
    const destPacked = simulated.getAtIndex(finalIdx);
    // remove source
    simulated.setAtIndex(fromIdx, 0);
    // remove captured (if any)
    if (destPacked)
        simulated.setAtIndex(finalIdx, 0);
    // place mover
    simulated.setAtIndex(finalIdx, packed);
    if (detectAnyClash(simulated))
        return { ok: false, reason: "move would create a Clash" };
    return { ok: true };
}
/* Build harmony graph and detect rings.
   Simple implementation:
   - Nodes are indices of blooming basic tiles;
   - Edges between two nodes if same axis, lineOfSightClear, and harmoniousPair OR if one endpoint is a White Lotus (owner of basic gets the harmony).
*/
function buildHarmonyGraph(board) {
    const pts = (0, coords_1.generateValidPoints)();
    const nodeIdxs = [];
    for (let i = 0; i < pts.length; i++) {
        const idx = i + 1;
        const p = (0, rules_1.getPieceDescriptor)(board, idx);
        if (p.kind === "basic" && p.blooming)
            nodeIdxs.push(idx);
    }
    const graph = new Map();
    for (let i = 0; i < nodeIdxs.length; i++) {
        for (let j = i + 1; j < nodeIdxs.length; j++) {
            const aIdx = nodeIdxs[i], bIdx = nodeIdxs[j];
            const a = (0, rules_1.getPieceDescriptor)(board, aIdx);
            const b = (0, rules_1.getPieceDescriptor)(board, bIdx);
            const aC = (0, coords_1.coordsOf)(aIdx), bC = (0, coords_1.coordsOf)(bIdx);
            if (aC.x !== bC.x && aC.y !== bC.y)
                continue;
            if (!lineOfSightClear(board, aIdx, bIdx))
                continue;
            if ((0, rules_1.harmoniousPair)(a.garden, a.number, b.garden, b.number)) {
                graph.set(aIdx, (graph.get(aIdx) || []).concat(bIdx));
                graph.set(bIdx, (graph.get(bIdx) || []).concat(aIdx));
            }
            else {
                // Lotus interactions (lotus harmonizes with any basic) — handled elsewhere when lotus present.
                // TODO: add lotus edges if a lotus owned by someone participates on the same axis.
            }
        }
    }
    return graph;
}
/* Basic cycle detection + polygon test for center inclusion (0,0)
   For simplicity we'll look for simple cycles (via DFS), build their ordered polygon using coords in traversal order,
   and run ray-casting for (0,0). This will detect rings that are closed and contain the origin.
*/
function findHarmonyRings(board) {
    const graph = buildHarmonyGraph(board);
    const nodes = Array.from(graph.keys());
    const rings = [];
    const visited = new Set();
    const maxLen = 20;
    function dfs(start, curr, parent, path, seen) {
        if (path.length > maxLen)
            return;
        const neighbors = graph.get(curr) || [];
        for (const nb of neighbors) {
            if (nb === parent)
                continue;
            if (nb === start && path.length >= 4) {
                const cycle = [...path];
                const key = cycle.slice().sort((a, b) => a - b).join(",");
                if (!visited.has(key)) {
                    visited.add(key);
                    if (cycleEnclosesOrigin(cycle))
                        rings.push(cycle.slice());
                }
            }
            else if (!seen.has(nb) && nb > start) {
                seen.add(nb);
                path.push(nb);
                dfs(start, nb, curr, path, seen);
                path.pop();
                seen.delete(nb);
            }
        }
    }
    for (const start of nodes) {
        dfs(start, start, null, [start], new Set([start]));
    }
    return rings;
}
function cycleEnclosesOrigin(cycle) {
    const pts = cycle.map(i => (0, coords_1.coordsOf)(i));
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y;
        const xj = pts[j].x, yj = pts[j].y;
        const intersect = ((yi > 0) !== (yj > 0)) && (0 < (xj - xi) * (0 - yi) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersect)
            inside = !inside;
    }
    return inside;
}
