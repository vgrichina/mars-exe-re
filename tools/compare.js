#!/usr/bin/env node
"use strict";
// compare.js — Run emulator + web port with same seed, compare render buffers pixel by pixel.
// Usage: node compare.js <mars.exe> [--seed N] [--dump dir/]

const fs = require("fs");
const { CPU, loadMZ } = require("./emu86.js");

// === Parse args ===
const args = process.argv.slice(2);
let exePath = null, SEED = 42;
let pngBinary = null, pngWeb = null, pngDiff = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seed") { SEED = parseInt(args[++i]); }
    else if (args[i] === "--bin-png") { pngBinary = args[++i]; }
    else if (args[i] === "--web-png") { pngWeb = args[++i]; }
    else if (args[i] === "--diff-png") { pngDiff = args[++i]; }
    else if (!args[i].startsWith("-")) { exePath = args[i]; }
}
if (!exePath) { console.error("Usage: node compare.js <mars.exe> [--seed N] [--bin-png f] [--web-png f] [--diff-png f]"); process.exit(1); }

// === VGA Palette ===
const PAL6 = [
0,0,0, 1,0,0, 2,0,0, 3,0,0, 3,1,0, 4,0,0, 5,0,0, 6,0,0,
7,0,0, 8,0,0, 9,0,0, 10,0,0, 11,0,0, 12,0,0, 13,0,0, 14,0,0,
15,0,0, 16,0,0, 17,0,0, 18,0,0, 19,0,0, 20,0,0, 21,0,0, 22,0,0,
23,0,0, 24,0,0, 25,0,0, 26,0,0, 27,0,0, 28,0,0, 29,1,0, 30,2,0,
31,3,0, 32,4,0, 33,5,0, 34,6,0, 35,7,1, 36,8,2, 37,9,3, 38,10,4,
39,11,5, 40,12,6, 41,13,7, 42,14,8, 43,15,9, 44,16,10, 45,17,11, 46,18,12,
47,19,13, 48,20,14, 49,21,15, 50,22,16, 51,23,17, 52,24,18, 53,25,19, 54,26,20,
55,27,21, 56,28,22, 57,29,23, 58,30,24, 59,31,25, 60,32,26, 61,33,27, 62,34,28,
50,10,10, 50,11,11, 50,12,12, 50,13,13, 50,14,14, 50,15,15, 50,16,16, 50,17,17,
50,18,18, 50,19,19, 50,20,20, 50,21,21, 50,22,22, 50,23,23, 50,24,24, 50,25,25,
50,26,26, 50,27,27, 50,28,28, 50,29,29, 50,30,30, 50,31,31, 50,32,32, 50,33,33,
50,34,34, 50,35,35, 50,36,36, 50,37,37, 50,38,38, 50,39,39, 50,40,40, 50,41,41,
63,63,63,
];
const palR = new Uint8Array(256), palG = new Uint8Array(256), palB = new Uint8Array(256);
for (let i = 0; i < 97; i++) {
    palR[i] = (PAL6[i*3] << 2) | (PAL6[i*3] >> 4);
    palG[i] = (PAL6[i*3+1] << 2) | (PAL6[i*3+1] >> 4);
    palB[i] = (PAL6[i*3+2] << 2) | (PAL6[i*3+2] >> 4);
}

// ============================================================================
// 1. Run the emulator
// ============================================================================
const cpu = new CPU();
cpu.timerTicks = SEED;
cpu.keyBuffer.push(0x011B);
cpu.traceEnabled = false;
loadMZ(cpu, exePath);

// Capture pre-smooth heightmap via breakpoint
// gen_heightmap's subdivide call returns, then first smooth starts at CS:018C
// (file 0x38C = code offset 0x018C, after ADD SP,4 cleanup from subdivide call)
let binaryPreSmooth = null;
// Breakpoints to capture intermediate state
// gen_heightmap starts at CS:0153. Subdivide call at file 0x388 → code 0x0188.
// After CALL returns + ADD SP,4: IP = 0x018E. But we also want pre-subdivide seed.
// Use gen_heightmap entry (0x0153) to capture seed before PRNG call.
// gen_colormap entry at 0x00F3
cpu.addBreakpoint(0x00F3, (c) => {
    console.log(`Binary seed entering gen_colormap: 0x${c.readWord(c.ds, 0x035D).toString(16)}`);
    return false;
});
// After gen_colormap's subdivide returns, ADD SP,4 at CS:013C
let binaryRawColormap = null;
let binPrngCount = 0;
let countingPrng = false;
// The PRNG MUL instruction is inside subdivide's perturb code
// Binary PRNG = MOV AX,0xAB; MUL [035D] — MUL is at varying offsets
// but seed update MOV [035D],DX always at same instruction within perturb
// Actually easier: count writes to [035D] by watching that breakpoint
// The MOV [035D],DX in gen_colormap's initial PRNG is at CS:0116
// In subdivide's perturb, it's at different offsets. Let me just count via a hook.

cpu.addBreakpoint(0x013C, (c) => {
    const cmSeg2 = c.readWord(c.ds, 0x034B);
    binaryRawColormap = c.mem.slice(cmSeg2 * 16, cmSeg2 * 16 + 65536);
    console.log(`Binary seed after colormap subdivide: 0x${c.readWord(c.ds, 0x035D).toString(16)}`);
    return false;
});
// gen_heightmap entry at 0x0153
cpu.addBreakpoint(0x0153, (c) => {
    console.log(`Binary seed entering gen_heightmap: 0x${c.readWord(c.ds, 0x035D).toString(16)}`);
    return false;
});

cpu.run();

const dsBase = cpu.ds * 16;
const binaryRender = new Uint8Array(256 * 200);
for (let i = 0; i < 256 * 200; i++) {
    binaryRender[i] = cpu.mem[dsBase + 0x07AA + i];
}

console.log(`Binary: DS=${cpu.ds.toString(16)}, posX=${cpu.readWord(cpu.ds, 0x0351)}, posY=${cpu.readWord(cpu.ds, 0x0353)}, heading=${cpu.readWord(cpu.ds, 0x0359).toString(16)}`);

const fsSeg = cpu.readWord(cpu.ds, 0x0347);
const gsSeg = cpu.readWord(cpu.ds, 0x0349);
const cmSeg = cpu.readWord(cpu.ds, 0x034B);
const binaryHeightmap = cpu.mem.slice(fsSeg * 16, fsSeg * 16 + 65536);
const binarySlopemap = cpu.mem.slice(gsSeg * 16, gsSeg * 16 + 65536);
const binaryColormap = cpu.mem.slice(cmSeg * 16, cmSeg * 16 + 65536);

// ============================================================================
// 2. Run the web port (extracted from web/index.html)
// ============================================================================
const W = 256, H = 200;
const stepTable = [
    0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
    16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
    32,33,34,35,36,37,38,39,40,42,44,46,48,50,52,54,
    56,58,60,64,68,72,76,80,84,88,92,96,100
];

const heightmap = new Uint8Array(65536);
const slopemap = new Uint8Array(65536);
const colormap = new Uint8Array(65536);
let seed = SEED & 0x7FFF;

let prngCount = 0;
const prngLog = [];
function prng() {
    seed = ((seed * 0xAB) + 0x2BCD) % 0xCF85;
    prngCount++;
    if (prngCount <= 10) prngLog.push(seed);
    return seed;
}

function perturb(half, avg) {
    const rnd = prng();
    let dx = rnd - 0x67C2;
    const product = half * dx;
    let shifted = product >> 13;
    let al = shifted & 0xFF;
    if (al > 127) al -= 256;
    let val = avg + al;
    if (val < 0) val = 0;
    if (val > 254) val = 254;
    return val;
}

function subdivide(buf, start, size) {
    const half = size >> 1;
    if (half < 1) return;
    let bl = start & 0xFF, bh = (start >> 8) & 0xFF;
    const tl = (bh << 8) | bl, tl_v = buf[tl];
    bl = (bl + half) & 0xFF;
    const eTop = (bh << 8) | bl;
    bl = (bl + half) & 0xFF;
    const tr = (bh << 8) | bl, tr_v = buf[tr];
    if (buf[eTop] === 0xFF) buf[eTop] = perturb(half, (tl_v + tr_v) >> 1);
    bh = (bh + half) & 0xFF;
    const eRight = (bh << 8) | bl;
    bh = (bh + half) & 0xFF;
    const br = (bh << 8) | bl, br_v = buf[br];
    if (buf[eRight] === 0xFF) buf[eRight] = perturb(half, (tr_v + br_v) >> 1);
    bl = (bl - half) & 0xFF;
    const eBottom = (bh << 8) | bl;
    bl = (bl - half) & 0xFF;
    const blc = (bh << 8) | bl, bl_v = buf[blc];
    if (buf[eBottom] === 0xFF) buf[eBottom] = perturb(half, (br_v + bl_v) >> 1);
    bh = (bh - half) & 0xFF;
    const eLeft = (bh << 8) | bl;
    bh = (bh - half) & 0xFF;
    if (buf[eLeft] === 0xFF) buf[eLeft] = perturb(half, (bl_v + buf[(bh << 8) | bl]) >> 1);
    const cx = ((start & 0xFF) + half) & 0xFF;
    const cy = (((start >> 8) & 0xFF) + half) & 0xFF;
    buf[(cy << 8) | cx] = perturb(half, (tl_v + tr_v + br_v + bl_v) >> 2);
    if (half <= 1) return;
    const sx = start & 0xFF, sy = (start >> 8) & 0xFF;
    subdivide(buf, (sy << 8) | sx, half);
    const sx2 = (sx + half) & 0xFF;
    subdivide(buf, (sy << 8) | sx2, half);
    const sy2 = (sy + half) & 0xFF;
    subdivide(buf, (sy2 << 8) | sx2, half);
    subdivide(buf, (sy2 << 8) | sx, half);
}

let webRawColormap = null;
function genColormap() {
    console.log(`Web seed entering gen_colormap: 0x${seed.toString(16)}`);
    colormap.fill(0xFF);
    prng();
    const savedSeed = seed;
    colormap[0x0000] = 0; colormap[0x0080] = 0xFE;
    colormap[0x8000] = 0xFE; colormap[0x8080] = 0;
    subdivide(colormap, 0, 256);
    seed = savedSeed;
    webRawColormap = new Uint8Array(colormap);
    console.log(`Web seed after colormap: 0x${seed.toString(16)} (${prngCount} prng calls)`);
    for (let i = 0; i < 65536; i++) colormap[i] = (colormap[i] >> 3) + 0x40;
}

let preSmooth = null;
function genHeightmap() {
    console.log(`Web seed entering gen_heightmap: 0x${seed.toString(16)}`);
    heightmap.fill(0xFF);
    prng();
    const savedSeed = seed;
    heightmap[0] = 0x80;
    console.log(`Web seed entering heightmap subdivide: 0x${seed.toString(16)}`);
    subdivide(heightmap, 0, 256);
    seed = savedSeed;
    preSmooth = new Uint8Array(heightmap);
    for (let i = 0; i < 65536; i++) {
        heightmap[i] = (heightmap[i] + heightmap[(i + 4) & 0xFFFF] +
                  heightmap[(i + 514) & 0xFFFF] + heightmap[(i + 65279) & 0xFFFF]) >> 2;
    }
    for (let i = 0; i < 65536; i++) {
        let d = heightmap[i] - heightmap[(i+3) & 0xFFFF] + 32;
        if (d < 0) d = 0; if (d > 63) d = 63;
        slopemap[i] = d;
    }
    for (let i = 0; i < 65536; i++) {
        heightmap[i] = (heightmap[i] + heightmap[(i+1) & 0xFFFF] +
                  heightmap[(i+256) & 0xFFFF] + heightmap[(i+257) & 0xFFFF]) >> 2;
    }
}

genColormap();
genHeightmap();

// === Compare intermediate buffers ===
function compareBuffers(name, web, binary, size) {
    let diffs = 0, firstDiff = -1;
    for (let i = 0; i < size; i++) {
        if (web[i] !== binary[i]) { diffs++; if (firstDiff < 0) firstDiff = i; }
    }
    if (diffs > 0) {
        console.log(`${name}: ${diffs} differences (first at 0x${firstDiff.toString(16)}, web=${web[firstDiff]} bin=${binary[firstDiff]})`);
        let shown = 0;
        for (let i = 0; i < size && shown < 10; i++) {
            if (web[i] !== binary[i]) {
                console.log(`  [0x${i.toString(16)}] (${i&0xFF},${(i>>8)&0xFF}): web=${web[i]} bin=${binary[i]}`);
                shown++;
            }
        }
    } else {
        console.log(`${name}: MATCH`);
    }
    return diffs;
}

console.log("\n=== Intermediate buffers ===");
if (binaryRawColormap && webRawColormap) {
    compareBuffers("Colormap (raw, pre-xform)", webRawColormap, binaryRawColormap, 65536);
}
if (binaryPreSmooth && preSmooth) {
    compareBuffers("Heightmap (pre-smooth)", preSmooth, binaryPreSmooth, 65536);
}
compareBuffers("Colormap", colormap, binaryColormap, 65536);
compareBuffers("Heightmap", heightmap, binaryHeightmap, 65536);
compareBuffers("Slopemap", slopemap, binarySlopemap, 65536);

// === Run web renderer ===
const renderBuf = new Uint8Array(W * H);
const heading = 0xFFFF;

function render() {
    const iPosX = 1000, iPosY = 1000;
    const ray_x = (iPosX << 9) | 0, ray_y = (iPosY << 9) | 0;

    for (let ecx = 99; ecx >= 1; ecx--) {
        const row = 99 - ecx;
        const step = (0x08000000 / ecx) | 0;
        const esi = (ray_x - step) | 0, ebp = (ray_y + step) | 0;
        let si = (((ebp >>> 16) & 0xFF) << 8) | ((esi >>> 16) & 0xFF);
        const ddaStep = (step >>> 7) | 0;
        const ddaAX = ddaStep & 0xFFFF;
        const ddaBP = (((ddaStep >>> 16) - 1) & 0xFFFF);
        let bx = esi & 0xFFFF;
        for (let col = 0; col < W; col++) {
            renderBuf[row * W + col] = colormap[si & 0xFFFF];
            si = (si + 1) & 0xFFFF;
            bx = (bx + ddaAX) | 0;
            const carry = (bx > 0xFFFF) ? 1 : 0;
            bx &= 0xFFFF;
            si = (si + ddaBP + carry) & 0xFFFF;
        }
    }

    const skyBase = 99;
    for (let x = 0; x < W; x++) renderBuf[skyBase * W + x] = 0x50;
    const skyVal = ((heading & 0xFFFF) >>> 1) + 10;
    for (let bl = 4; bl < 44; bl++) {
        let val = ((skyVal / bl) | 0) >>> 7;
        if (val > 63) val = 63;
        const off = (skyBase + (bl - 3)) * W;
        for (let x = 0; x < W; x++) renderBuf[off + x] = val;
    }

    const iPosX2 = 1000, iPosY2 = 1000;
    const voxCamX = (((iPosX2 >> 4) % 256) + 256) % 256;
    const voxCamY = (((iPosY2 >> 4) % 256) + 256) % 256;
    const horizon = new Int32Array(W); horizon.fill(0x7D00);
    const prevColor = new Int16Array(W);

    for (let si2 = stepTable.length - 1; si2 >= 1; si2--) {
        const dist = stepTable[si2];
        const SI = (dist << 4) | (15 - (iPosY2 & 0xF));
        const perspScale = (si2 === 1) ? 0x7D00 : ((((heading & 0xFFFF) / SI) | 0) + 100) | 0;
        const heightScale = (si2 === 1) ? 0 : (0x10000 / SI) | 0;

        for (let col = 0; col < W; col++) {
            const perpOffset = (col - 128) * SI / 1024;
            const sampleXf = voxCamX + perpOffset;
            const sampleYf = voxCamY + dist;
            const wrappedX = ((sampleXf % 256) + 256) % 256;
            const wrappedY = ((sampleYf % 256) + 256) % 256;
            const sampleXi = wrappedX | 0;
            const sampleYi = wrappedY | 0;
            const fracX16 = ((wrappedX - sampleXi) * 65536) | 0;
            const halfFrac = (fracX16 >>> 1) & 0x7FFF;
            const mapIdx = ((sampleYi & 0xFF) << 8) | (sampleXi & 0xFF);
            const nextIdx = ((sampleYi & 0xFF) << 8) | ((sampleXi + 1) & 0xFF);

            const h0 = heightmap[mapIdx], h1 = heightmap[nextIdx];
            let hDelta = (h1 - h0) | 0;
            hDelta = (hDelta << 16) >> 16;
            const hProduct = (hDelta * halfFrac) | 0;
            const hShifted = (hProduct >> 7) | 0;
            const interpAH = (((hShifted >> 8) + h0) & 0xFF);
            const interpAX = ((interpAH << 8) | (hShifted & 0xFF)) & 0xFFFF;

            let screenY = (perspScale - (interpAX * heightScale >>> 16)) | 0;
            if (screenY < 0) screenY = -1;
            if (screenY >= H) screenY = H - 1;

            const oldHorizon = horizon[col];
            horizon[col] = screenY;
            const columnHeight = (oldHorizon - screenY) | 0;

            const CH = (halfFrac >>> 8) & 0xFF;
            const c0 = slopemap[mapIdx], c1 = slopemap[nextIdx];
            let cDelta = ((c1 - c0) << 24) >> 24;
            let cProd = (cDelta * CH) | 0;
            cProd = (cProd << 1) | 0;
            const colorHi = ((cProd >> 8) + c0) & 0xFF;
            const colorAX = ((colorHi << 8) | (cProd & 0xFF)) & 0xFFFF;

            if (columnHeight >= 0) { prevColor[col] = colorAX; continue; }

            const oldColor = prevColor[col];
            prevColor[col] = colorAX;

            const drawStart = (oldHorizon + 1) < 0 ? 0 : ((oldHorizon + 1) > H ? H : (oldHorizon + 1));
            const drawEnd = (screenY + 1) < 0 ? 0 : ((screenY + 1) > H ? H : (screenY + 1));
            if (drawStart >= drawEnd) continue;

            const negHeight = -columnHeight;
            const colorDiff = (oldColor - colorAX) | 0;
            const colorStep = (negHeight > 0) ? ((-colorDiff / negHeight) | 0) : 0;
            let drawColor = oldColor;

            for (let y = drawStart; y < drawEnd; y++) {
                renderBuf[y * W + col] = (drawColor >> 8) & 0xFF;
                drawColor = (drawColor + colorStep) | 0;
            }
        }
    }
}

render();

// ============================================================================
// 3. Compare render buffers
// ============================================================================
console.log("\n=== Render buffer comparison ===");
let totalDiffs = 0;
let regionDiffs = { floor: 0, sky: 0, voxel: 0 };
let firstDiffs = [];

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (renderBuf[i] !== binaryRender[i]) {
            totalDiffs++;
            if (y < 99) regionDiffs.floor++;
            else if (y <= 139) regionDiffs.sky++;
            else regionDiffs.voxel++;
            if (firstDiffs.length < 20)
                firstDiffs.push({ x, y, web: renderBuf[i], bin: binaryRender[i] });
        }
    }
}

if (totalDiffs === 0) {
    console.log("PIXEL PERFECT");
} else {
    console.log(`${totalDiffs} pixel differences (${(totalDiffs / (W*H) * 100).toFixed(1)}%)`);
    console.log(`  Floor (rows 0-98): ${regionDiffs.floor}`);
    console.log(`  Sky (rows 99-139): ${regionDiffs.sky}`);
    console.log(`  Voxel (rows 140+): ${regionDiffs.voxel}`);
    console.log("\nFirst differences:");
    for (const d of firstDiffs)
        console.log(`  (${d.x},${d.y}): web=${d.web} bin=${d.bin} delta=${d.web - d.bin}`);
    console.log("\nPer-row diff counts (non-zero):");
    for (let y = 0; y < H; y++) {
        let rowDiffs = 0;
        for (let x = 0; x < W; x++)
            if (renderBuf[y * W + x] !== binaryRender[y * W + x]) rowDiffs++;
        if (rowDiffs > 0) console.log(`  row ${y}: ${rowDiffs}/256`);
    }
}

// ============================================================================
// 4. Dump PNG images (uses node-canvas if available, falls back to raw P6 PPM)
// ============================================================================
if (pngBinary || pngWeb || pngDiff) {
    let useCanvas = false, createCanvas;
    try { ({ createCanvas } = require("canvas")); useCanvas = true; } catch(e) {}

    function writeImg(filePath, buf) {
        if (useCanvas) {
            const c = createCanvas(W, H);
            const ctx = c.getContext("2d");
            const img = ctx.createImageData(W, H);
            for (let i = 0; i < W * H; i++) {
                img.data[i*4] = palR[buf[i]]; img.data[i*4+1] = palG[buf[i]];
                img.data[i*4+2] = palB[buf[i]]; img.data[i*4+3] = 255;
            }
            ctx.putImageData(img, 0, 0);
            fs.writeFileSync(filePath, c.toBuffer("image/png"));
        } else {
            const fp = filePath.replace(/\.png$/, ".ppm");
            const hdr = `P6\n${W} ${H}\n255\n`;
            const out = Buffer.alloc(hdr.length + W * H * 3);
            out.write(hdr);
            for (let i = 0; i < W * H; i++) {
                out[hdr.length+i*3] = palR[buf[i]]; out[hdr.length+i*3+1] = palG[buf[i]];
                out[hdr.length+i*3+2] = palB[buf[i]];
            }
            fs.writeFileSync(fp, out);
            console.log(`  (no canvas, wrote ${fp})`);
        }
    }

    function writeDiffImg(filePath, webBuf, binBuf) {
        if (useCanvas) {
            const c = createCanvas(W, H);
            const ctx = c.getContext("2d");
            const img = ctx.createImageData(W, H);
            for (let i = 0; i < W * H; i++) {
                if (webBuf[i] !== binBuf[i]) {
                    img.data[i*4] = 255; img.data[i*4+1] = 0; img.data[i*4+2] = 0;
                } else {
                    img.data[i*4] = palR[webBuf[i]]; img.data[i*4+1] = palG[webBuf[i]];
                    img.data[i*4+2] = palB[webBuf[i]];
                }
                img.data[i*4+3] = 255;
            }
            ctx.putImageData(img, 0, 0);
            fs.writeFileSync(filePath, c.toBuffer("image/png"));
        } else {
            const fp = filePath.replace(/\.png$/, ".ppm");
            const hdr = `P6\n${W} ${H}\n255\n`;
            const out = Buffer.alloc(hdr.length + W * H * 3);
            out.write(hdr);
            for (let i = 0; i < W * H; i++) {
                if (webBuf[i] !== binBuf[i]) {
                    out[hdr.length+i*3] = 255;
                } else {
                    out[hdr.length+i*3] = palR[webBuf[i]]; out[hdr.length+i*3+1] = palG[webBuf[i]];
                    out[hdr.length+i*3+2] = palB[webBuf[i]];
                }
            }
            fs.writeFileSync(fp, out);
            console.log(`  (no canvas, wrote ${fp})`);
        }
    }

    if (pngBinary) { writeImg(pngBinary, binaryRender); console.log(`Wrote ${pngBinary}`); }
    if (pngWeb) { writeImg(pngWeb, renderBuf); console.log(`Wrote ${pngWeb}`); }
    if (pngDiff) { writeDiffImg(pngDiff, renderBuf, binaryRender); console.log(`Wrote ${pngDiff}`); }
}
