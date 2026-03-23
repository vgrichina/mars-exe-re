"use strict";
// mars.js — Shared terrain generation + renderer for mars.exe web port
// Used by both web/index.html (browser) and tools/compare.js (Node)

// === VGA Palette (97 entries, 6-bit DAC values from mars.exe @ 0x14CA) ===
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

// Step table from binary @ 0x1450 (word entries)
const stepTable = [
    0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
    16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,
    32,33,34,35,36,37,38,39,40,42,44,46,48,50,52,54,
    56,58,60,64,68,72,76,80,84,88,92,96,100
];

const W = 256, H = 200;

// === Mars engine state ===
function createMars(initialSeed) {
    let seed = initialSeed & 0x7FFF;
    const heightmap = new Uint8Array(65536);
    const slopemap = new Uint8Array(65536);
    const colormap = new Uint8Array(65536);
    const renderBuf = new Uint8Array(W * H);

    // === PRNG: seed = seed * 0xAB + 0x2BCD mod 0xCF85 ===
    function prng() {
        seed = ((seed * 0xAB) + 0x2BCD) % 0xCF85;
        return seed;
    }

    // === Perturbation: exact binary IMUL + middle-16-bits + SAR 5 + CBW ===
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

    // === Diamond-square: matches binary BX register walk ===
    function subdivide(buf, start, size) {
        const half = size >> 1;
        if (half < 1) return;

        let bl = start & 0xFF;
        let bh = (start >> 8) & 0xFF;

        const tl = (bh << 8) | bl;
        const tl_v = buf[tl];

        bl = (bl + half) & 0xFF;
        const eTop = (bh << 8) | bl;

        bl = (bl + half) & 0xFF;
        const tr = (bh << 8) | bl;
        const tr_v = buf[tr];

        if (buf[eTop] === 0xFF) {
            buf[eTop] = perturb(half, (tl_v + tr_v) >> 1);
        }

        bh = (bh + half) & 0xFF;
        const eRight = (bh << 8) | bl;

        bh = (bh + half) & 0xFF;
        const br = (bh << 8) | bl;
        const br_v = buf[br];

        if (buf[eRight] === 0xFF) {
            buf[eRight] = perturb(half, (tr_v + br_v) >> 1);
        }

        bl = (bl - half) & 0xFF;
        const eBottom = (bh << 8) | bl;

        bl = (bl - half) & 0xFF;
        const blc = (bh << 8) | bl;
        const bl_v = buf[blc];

        if (buf[eBottom] === 0xFF) {
            buf[eBottom] = perturb(half, (br_v + bl_v) >> 1);
        }

        bh = (bh - half) & 0xFF;
        const eLeft = (bh << 8) | bl;

        bh = (bh - half) & 0xFF;
        const tl2_v = buf[(bh << 8) | bl];

        if (buf[eLeft] === 0xFF) {
            buf[eLeft] = perturb(half, (bl_v + tl2_v) >> 1);
        }

        const cx = ((start & 0xFF) + half) & 0xFF;
        const cy = (((start >> 8) & 0xFF) + half) & 0xFF;
        const center = (cy << 8) | cx;
        buf[center] = perturb(half, (tl_v + tr_v + br_v + bl_v) >> 2);

        if (half <= 1) return;

        const sx = start & 0xFF;
        const sy = (start >> 8) & 0xFF;
        subdivide(buf, (sy << 8) | sx, half);
        const sx2 = (sx + half) & 0xFF;
        subdivide(buf, (sy << 8) | sx2, half);
        const sy2 = (sy + half) & 0xFF;
        subdivide(buf, (sy2 << 8) | sx2, half);
        subdivide(buf, (sy2 << 8) | sx, half);
    }

    function genColormap() {
        colormap.fill(0xFF);
        prng();
        const savedSeed = seed;
        colormap[0x0000] = 0;
        colormap[0x0080] = 0xFE;
        colormap[0x8000] = 0xFE;
        colormap[0x8080] = 0;
        subdivide(colormap, 0, 256);
        seed = savedSeed;
        for (let i = 0; i < 65536; i++) {
            colormap[i] = (colormap[i] >> 3) + 0x40;
        }
    }

    function genHeightmap() {
        heightmap.fill(0xFF);
        prng();
        const savedSeed = seed;
        heightmap[0] = 0x80;
        subdivide(heightmap, 0, 256);
        seed = savedSeed;

        // First smooth pass: table-driven asymmetric kernel
        for (let i = 0; i < 65536; i++) {
            heightmap[i] = (heightmap[i] + heightmap[(i + 4) & 0xFFFF] +
                      heightmap[(i + 514) & 0xFFFF] + heightmap[(i + 65279) & 0xFFFF]) >> 2;
        }

        // Slope calc
        for (let i = 0; i < 65536; i++) {
            let d = heightmap[i] - heightmap[(i+3) & 0xFFFF] + 32;
            if (d < 0) d = 0;
            if (d > 63) d = 63;
            slopemap[i] = d;
        }

        // Second smooth pass
        for (let i = 0; i < 65536; i++) {
            heightmap[i] = (heightmap[i] + heightmap[(i+1) & 0xFFFF] +
                      heightmap[(i+256) & 0xFFFF] + heightmap[(i+257) & 0xFFFF]) >> 2;
        }
    }

    // === Camera height: bilinear interpolation of heightmap at position ===
    // Binary CS:105C (file 0x125C). Computes terrain height at camera (posX, posY).
    // Result used as "heading" for perspective scale and sky gradient.
    // Uses ROR to split position into map coords (>>4) and fractional part (&0xF).
    function cameraHeight(posX, posY) {
        const mapX = (posX >> 4) & 0xFF;
        const mapY = (posY >> 4) & 0xFF;
        const fracX = posX & 0xF;
        const fracY = posY & 0xF;

        // Interpolate X at row Y
        const bx0 = (mapY << 8) | mapX;
        const h00 = heightmap[bx0];
        const h10 = heightmap[(bx0 + 1) & 0xFFFF];
        let d0 = h10 - h00;
        d0 = (d0 << 24) >> 24; // sign-extend (SUB AL + SBB AH,0)
        const imul0 = Math.imul(d0, fracX); // IMUL CX (signed 16×16→32, low 16 used)
        const interp0 = ((imul0 & 0xFFFF) + ((h00 << 4) & 0xFFFF)) & 0xFFFF;

        // Interpolate X at row Y+1
        const bx1 = (((mapY + 1) & 0xFF) << 8) | mapX;
        const h01 = heightmap[bx1];
        const h11 = heightmap[(bx1 + 1) & 0xFFFF];
        let d1 = h11 - h01;
        d1 = (d1 << 24) >> 24;
        const imul1 = Math.imul(d1, fracX);
        const interp1 = ((imul1 & 0xFFFF) + ((h01 << 4) & 0xFFFF)) & 0xFFFF;

        // Interpolate Y: (interp1 - interp0) * fracY + interp0 << 4
        let rowDelta = ((interp1 - interp0) << 16) >> 16; // sign-extend to 16-bit
        const imulY = Math.imul(rowDelta, fracY);
        const result = ((imulY & 0xFFFF) + ((interp0 << 4) & 0xFFFF)) & 0xFFFF;
        return result;
    }

    // === Renderer ===
    function render(posX, posY) {
        const iPosX = posX | 0, iPosY = posY | 0;
        // Binary: CALL cameraHeight → ADD AH,19h → JNC +3 → MOV AX,FFFF → MOV [0359],AX
        // ADD AH,19h adds 0x1900 to AX; if AH overflows (carry), clamp to 0xFFFF
        const camH = cameraHeight(iPosX, iPosY);
        const ah = ((camH >> 8) + 0x19) & 0xFF;
        const carry = ((camH >> 8) + 0x19) >= 0x100;
        const heading = carry ? 0xFFFF : ((ah << 8) | (camH & 0xFF));

        // === Pass 1: Floor plane ===
        const negH = ((-heading) & 0xFFFF) >>> 0;
        const ray_dx = (((negH >>> 3) + 0x4000) & 0xFFFF) << 13;
        const ray_x = (iPosX << 9) | 0;
        const ray_y = (iPosY << 9) | 0;

        for (let ecx = 99; ecx >= 1; ecx--) {
            const row = 99 - ecx;
            const step = (ray_dx / ecx) | 0;
            const esi = (ray_x - step) | 0;
            const ebp = (ray_y + step) | 0;
            const startY = (ebp >>> 16) & 0xFF;
            const startX = (esi >>> 16) & 0xFF;
            let si = (startY << 8) | startX;
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

        // === Sky fill ===
        const skyBase = 99;
        for (let x = 0; x < W; x++) renderBuf[skyBase * W + x] = 0x50;
        const skyVal = ((heading & 0xFFFF) >>> 1) + 10;
        for (let bl = 4; bl < 44; bl++) {
            let val = ((skyVal / bl) | 0) >>> 7;
            if (val > 63) val = 63;
            const off = (skyBase + (bl - 3)) * W;
            for (let x = 0; x < W; x++) renderBuf[off + x] = val;
        }

        // === Pass 2: Voxel heightmap ===
        const horizon = new Int32Array(W);
        horizon.fill(0x7D00);
        const prevColor = new Int16Array(W);

        for (let stIdx = stepTable.length - 1; stIdx >= 1; stIdx--) {
            const dist = stepTable[stIdx];
            const SI = (dist << 4) | (15 - (iPosY & 0xF));
            const perspScale = (stIdx === 1) ? 0x7D00 : ((((heading & 0xFFFF) / SI) | 0) + 100) | 0;
            const heightScale = (stIdx === 1) ? 0 : (0x10000 / SI) | 0;

            const stepSize = (SI << 6) >>> 0;
            const stepLo = stepSize & 0xFFFF;
            const stepHi = (stepSize >>> 16) & 0xFF;

            let ecxRay = ((iPosX << 12) - ((stepSize << 7) >>> 0)) | 0;
            const dxShifted = (iPosY << 4) & 0xFFFF;
            let bx = (ecxRay >>> 16) & 0xFFFF;
            bx = (bx & 0x00FF) | ((dxShifted >> 8) << 8);
            bx = (bx & 0x00FF) | ((((bx >> 8) + ((SI >> 4) & 0xFF)) & 0xFF) << 8);

            let cx = ecxRay & 0xFFFF;
            cx = (cx >>> 1) & 0xFFFF;
            cx = (cx << 1) & 0xFFFF;
            let addResult = cx + stepLo;
            let carry = addResult > 0xFFFF ? 1 : 0;
            cx = addResult & 0xFFFF;
            bx = (((bx & 0xFF) + stepHi + carry) & 0xFF) | (bx & 0xFF00);
            cx = (cx >>> 1) & 0xFFFF;

            for (let renderCol = 0; renderCol < W; renderCol++) {
                const binCol = 255 - renderCol;
                const halfFrac = cx & 0x7FFF;
                const mapIdx = ((bx >> 8) & 0xFF) << 8 | (bx & 0xFF);
                const nextIdx = (bx + 1) & 0xFFFF;

                const h0 = heightmap[mapIdx];
                const h1 = heightmap[nextIdx];
                let hDelta = (h1 - h0) | 0;
                hDelta = (hDelta << 16) >> 16;
                const hProduct = (hDelta * halfFrac) | 0;
                const hShifted = (hProduct >> 7) | 0;
                const interpAH = (((hShifted >> 8) + h0) & 0xFF);
                const interpAX = ((interpAH << 8) | (hShifted & 0xFF)) & 0xFFFF;

                let screenY = (perspScale - (interpAX * heightScale >>> 16)) | 0;
                if (screenY < 0) screenY = -1;
                if (screenY >= H) screenY = H - 1;

                const oldHorizon = horizon[binCol];
                horizon[binCol] = screenY;
                const columnHeight = (oldHorizon - screenY) | 0;

                const CH = (halfFrac >>> 8) & 0xFF;
                const c0 = slopemap[mapIdx];
                const c1 = slopemap[nextIdx];
                let cDelta = ((c1 - c0) << 24) >> 24;
                let cProd = (cDelta * CH) | 0;
                cProd = (cProd << 1) | 0;
                const colorHi = ((cProd >> 8) + c0) & 0xFF;
                const colorAX = ((colorHi << 8) | (cProd & 0xFF)) & 0xFFFF;

                if (columnHeight >= 0) {
                    prevColor[binCol] = colorAX;
                } else {
                    const oldColor = prevColor[binCol];
                    prevColor[binCol] = colorAX;

                    const drawStart = (oldHorizon + 1) < 0 ? 0 : ((oldHorizon + 1) > H ? H : (oldHorizon + 1));
                    const drawEnd = (screenY + 1) < 0 ? 0 : ((screenY + 1) > H ? H : (screenY + 1));
                    if (drawStart < drawEnd) {
                        const negHeight = -columnHeight;
                        const colorDiff = (oldColor - colorAX) | 0;
                        const colorStep = (negHeight > 0) ? ((-colorDiff / negHeight) | 0) : 0;
                        let drawColor = oldColor;
                        for (let y = drawStart; y < drawEnd; y++) {
                            renderBuf[y * W + renderCol] = (drawColor >> 8) & 0xFF;
                            drawColor = (drawColor + colorStep) | 0;
                        }
                    }
                }

                // Per-column DDA advance
                cx = (cx << 1) & 0xFFFF;
                addResult = cx + stepLo;
                carry = addResult > 0xFFFF ? 1 : 0;
                cx = addResult & 0xFFFF;
                bx = (((bx & 0xFF) + stepHi + carry) & 0xFF) | (bx & 0xFF00);
                cx = (cx >>> 1) & 0xFFFF;
            }
        }
    }

    // Init
    genColormap();
    genHeightmap();

    return {
        heightmap, slopemap, colormap, renderBuf,
        render, cameraHeight,
        W, H,
    };
}

// Export for Node, no-op in browser (where it's a global via <script>)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createMars, PAL6, stepTable, W, H };
}
