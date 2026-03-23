#!/usr/bin/env node
"use strict";
// compare.js — Run emulator + web port with same seed, compare render buffers pixel by pixel.
// Usage: node compare.js <mars.exe> [--seed N] [--bin-png f] [--web-png f] [--diff-png f]

const fs = require("fs");
const { CPU, loadMZ } = require("./emu86.js");
const { createMars, PAL6, W, H } = require("../web/mars.js");

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

// === VGA Palette (for image output) ===
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

// Breakpoints to capture intermediate state
cpu.addBreakpoint(0x00F3, (c) => {
    console.log(`Binary seed entering gen_colormap: 0x${c.readWord(c.ds, 0x035D).toString(16)}`);
    return false;
});
let binaryRawColormap = null;
cpu.addBreakpoint(0x013C, (c) => {
    const cmSeg2 = c.readWord(c.ds, 0x034B);
    binaryRawColormap = c.mem.slice(cmSeg2 * 16, cmSeg2 * 16 + 65536);
    console.log(`Binary seed after colormap subdivide: 0x${c.readWord(c.ds, 0x035D).toString(16)}`);
    return false;
});
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

function bufSum(buf, len) { let s = 0; for (let i = 0; i < (len || buf.length); i++) s += buf[i]; return s; }

const binaryHeading = cpu.readWord(cpu.ds, 0x0359);
console.log('camera: posX=%d posY=%d heading=0x%s', cpu.readWord(cpu.ds, 0x0351), cpu.readWord(cpu.ds, 0x0353), binaryHeading.toString(16));

const fsSeg = cpu.readWord(cpu.ds, 0x0347);
const gsSeg = cpu.readWord(cpu.ds, 0x0349);
const cmSeg = cpu.readWord(cpu.ds, 0x034B);
const binaryHeightmap = cpu.mem.slice(fsSeg * 16, fsSeg * 16 + 65536);
const binarySlopemap = cpu.mem.slice(gsSeg * 16, gsSeg * 16 + 65536);
const binaryColormap = cpu.mem.slice(cmSeg * 16, cmSeg * 16 + 65536);

console.log('\n=== Binary checksums ===');
console.log('colormap  checksum:', bufSum(binaryColormap, 65536));
console.log('heightmap checksum:', bufSum(binaryHeightmap, 65536));
console.log('slopemap  checksum:', bufSum(binarySlopemap, 65536));
console.log('renderBuf checksum:', bufSum(binaryRender));

// ============================================================================
// 2. Run the web port (shared module)
// ============================================================================
const mars = createMars(SEED);
mars.render(1000, 1000);
const camH = mars.cameraHeight(1000, 1000);
const ah = ((camH >> 8) + 0x19) & 0xFF;
const heading = ((camH >> 8) + 0x19) >= 0x100 ? 0xFFFF : ((ah << 8) | (camH & 0xFF));
console.log('web heading: 0x' + heading.toString(16) + ' (binary: 0x' + binaryHeading.toString(16) + ')');

console.log('\n=== Web checksums ===');
console.log('colormap  checksum:', bufSum(mars.colormap));
console.log('heightmap checksum:', bufSum(mars.heightmap));
console.log('slopemap  checksum:', bufSum(mars.slopemap));
console.log('renderBuf checksum:', bufSum(mars.renderBuf));

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

console.log("\n=== Buffer comparison ===");
compareBuffers("Colormap", mars.colormap, binaryColormap, 65536);
compareBuffers("Heightmap", mars.heightmap, binaryHeightmap, 65536);
compareBuffers("Slopemap", mars.slopemap, binarySlopemap, 65536);

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
        if (mars.renderBuf[i] !== binaryRender[i]) {
            totalDiffs++;
            if (y < 99) regionDiffs.floor++;
            else if (y <= 139) regionDiffs.sky++;
            else regionDiffs.voxel++;
            if (firstDiffs.length < 20)
                firstDiffs.push({ x, y, web: mars.renderBuf[i], bin: binaryRender[i] });
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
            if (mars.renderBuf[y * W + x] !== binaryRender[y * W + x]) rowDiffs++;
        if (rowDiffs > 0) console.log(`  row ${y}: ${rowDiffs}/256`);
    }
}

// ============================================================================
// 4. Dump images
// ============================================================================
if (pngBinary || pngWeb || pngDiff) {
    let useCanvas = false, createCanvas;
    try { ({ createCanvas } = require("canvas")); useCanvas = true; } catch(e) {}

    function writeImg(filePath, buf) {
        if (useCanvas) {
            const c = createCanvas(W, H);
            const ctx2 = c.getContext("2d");
            const img = ctx2.createImageData(W, H);
            for (let i = 0; i < W * H; i++) {
                img.data[i*4] = palR[buf[i]]; img.data[i*4+1] = palG[buf[i]];
                img.data[i*4+2] = palB[buf[i]]; img.data[i*4+3] = 255;
            }
            ctx2.putImageData(img, 0, 0);
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
            const ctx2 = c.getContext("2d");
            const img = ctx2.createImageData(W, H);
            for (let i = 0; i < W * H; i++) {
                if (webBuf[i] !== binBuf[i]) {
                    img.data[i*4] = 255; img.data[i*4+1] = 0; img.data[i*4+2] = 0;
                } else {
                    img.data[i*4] = palR[webBuf[i]]; img.data[i*4+1] = palG[webBuf[i]];
                    img.data[i*4+2] = palB[webBuf[i]];
                }
                img.data[i*4+3] = 255;
            }
            ctx2.putImageData(img, 0, 0);
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
    if (pngWeb) { writeImg(pngWeb, mars.renderBuf); console.log(`Wrote ${pngWeb}`); }
    if (pngDiff) { writeDiffImg(pngDiff, mars.renderBuf, binaryRender); console.log(`Wrote ${pngDiff}`); }
}
