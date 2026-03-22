#!/usr/bin/env node
"use strict";

// emu86.js — Minimal 16-bit x86 (386+) emulator for mars.exe
// Direct opcode execution, no disassembly. Trace = address: hex ; side effects.
// State: flat 1MB memory + registers. Snapshots as binary dumps.

const fs = require("fs");

// ============================================================================
// CPU STATE
// ============================================================================

class CPU {
    constructor() {
        // 1MB flat address space
        this.mem = new Uint8Array(1048576);
        // General-purpose registers (32-bit storage, 16/8-bit access via helpers)
        this.eax = 0; this.ebx = 0; this.ecx = 0; this.edx = 0;
        this.esi = 0; this.edi = 0; this.ebp = 0; this.esp = 0;
        // Segment registers
        this.cs = 0; this.ds = 0; this.es = 0; this.ss = 0;
        this.fs = 0; this.gs = 0;
        // Instruction pointer (offset within CS)
        this.ip = 0;
        // Flags
        this.cf = 0; this.zf = 0; this.sf = 0; this.of = 0; this.df = 0;
        // VGA DAC state
        this.dacIndex = 0;
        this.dacComponent = 0; // 0=R, 1=G, 2=B
        this.dacPalette = new Uint8Array(768); // 256 * 3
        // Interrupt/input stubs
        this.mousePresent = true;
        this.mouseDX = 0; this.mouseDY = 0;
        this.mouseButtons = 0;
        this.keyBuffer = []; // push scancodes here
        this.timerTicks = 0x1234; // INT 1Ah seed
        // Execution state
        this.halted = false;
        this.trace = [];
        this.traceEnabled = true;
        this.cycleCount = 0;
        this.maxCycles = 0; // 0 = unlimited
        // Breakpoints: Map of IP → callback(cpu)
        // callback returns true to halt, false/undefined to continue
        this.breakpoints = new Map();
        // Memory watchpoints: Map of linear address → callback(cpu, addr, val, size)
        // callback returns true to halt. Fires on write.
        this.watchpoints = new Map();
        // Prefix state (reset each instruction)
        this._segOverride = -1;
        this._opSz32 = false; // 0x66 prefix
        this._addrSz32 = false; // 0x67 prefix
        this._rep = 0; // 0=none, 1=REP/REPE, 2=REPNE
    }

    // --- Register access ---
    get ax() { return this.eax & 0xFFFF; }
    set ax(v) { this.eax = (this.eax & 0xFFFF0000) | (v & 0xFFFF); }
    get bx() { return this.ebx & 0xFFFF; }
    set bx(v) { this.ebx = (this.ebx & 0xFFFF0000) | (v & 0xFFFF); }
    get cx() { return this.ecx & 0xFFFF; }
    set cx(v) { this.ecx = (this.ecx & 0xFFFF0000) | (v & 0xFFFF); }
    get dx() { return this.edx & 0xFFFF; }
    set dx(v) { this.edx = (this.edx & 0xFFFF0000) | (v & 0xFFFF); }
    get si() { return this.esi & 0xFFFF; }
    set si(v) { this.esi = (this.esi & 0xFFFF0000) | (v & 0xFFFF); }
    get di() { return this.edi & 0xFFFF; }
    set di(v) { this.edi = (this.edi & 0xFFFF0000) | (v & 0xFFFF); }
    get bp() { return this.ebp & 0xFFFF; }
    set bp(v) { this.ebp = (this.ebp & 0xFFFF0000) | (v & 0xFFFF); }
    get sp() { return this.esp & 0xFFFF; }
    set sp(v) { this.esp = (this.esp & 0xFFFF0000) | (v & 0xFFFF); }

    get al() { return this.eax & 0xFF; }
    set al(v) { this.eax = (this.eax & 0xFFFFFF00) | (v & 0xFF); }
    get ah() { return (this.eax >> 8) & 0xFF; }
    set ah(v) { this.eax = (this.eax & 0xFFFF00FF) | ((v & 0xFF) << 8); }
    get bl() { return this.ebx & 0xFF; }
    set bl(v) { this.ebx = (this.ebx & 0xFFFFFF00) | (v & 0xFF); }
    get bh() { return (this.ebx >> 8) & 0xFF; }
    set bh(v) { this.ebx = (this.ebx & 0xFFFF00FF) | ((v & 0xFF) << 8); }
    get cl() { return this.ecx & 0xFF; }
    set cl(v) { this.ecx = (this.ecx & 0xFFFFFF00) | (v & 0xFF); }
    get ch() { return (this.ecx >> 8) & 0xFF; }
    set ch(v) { this.ecx = (this.ecx & 0xFFFF00FF) | ((v & 0xFF) << 8); }
    get dl() { return this.edx & 0xFF; }
    set dl(v) { this.edx = (this.edx & 0xFFFFFF00) | (v & 0xFF); }
    get dh() { return (this.edx >> 8) & 0xFF; }
    set dh(v) { this.edx = (this.edx & 0xFFFF00FF) | ((v & 0xFF) << 8); }

    // Named register arrays for ModRM indexing
    getReg16(i) {
        return [this.ax, this.cx, this.dx, this.bx, this.sp, this.bp, this.si, this.di][i];
    }
    setReg16(i, v) {
        v &= 0xFFFF;
        switch(i) {
            case 0: this.ax = v; break; case 1: this.cx = v; break;
            case 2: this.dx = v; break; case 3: this.bx = v; break;
            case 4: this.sp = v; break; case 5: this.bp = v; break;
            case 6: this.si = v; break; case 7: this.di = v; break;
        }
    }
    getReg32(i) {
        return [this.eax, this.ecx, this.edx, this.ebx, this.esp, this.ebp, this.esi, this.edi][i];
    }
    setReg32(i, v) {
        v = v | 0;
        switch(i) {
            case 0: this.eax = v; break; case 1: this.ecx = v; break;
            case 2: this.edx = v; break; case 3: this.ebx = v; break;
            case 4: this.esp = v; break; case 5: this.ebp = v; break;
            case 6: this.esi = v; break; case 7: this.edi = v; break;
        }
    }
    getReg8(i) {
        return [this.al, this.cl, this.dl, this.bl, this.ah, this.ch, this.dh, this.bh][i];
    }
    setReg8(i, v) {
        v &= 0xFF;
        switch(i) {
            case 0: this.al = v; break; case 1: this.cl = v; break;
            case 2: this.dl = v; break; case 3: this.bl = v; break;
            case 4: this.ah = v; break; case 5: this.ch = v; break;
            case 6: this.dh = v; break; case 7: this.bh = v; break;
        }
    }
    getSegReg(i) {
        return [this.es, this.cs, this.ss, this.ds, this.fs, this.gs][i];
    }
    setSegReg(i, v) {
        v &= 0xFFFF;
        switch(i) {
            case 0: this.es = v; break; case 1: this.cs = v; break;
            case 2: this.ss = v; break; case 3: this.ds = v; break;
            case 4: this.fs = v; break; case 5: this.gs = v; break;
        }
    }
    static regName16 = ["AX","CX","DX","BX","SP","BP","SI","DI"];
    static regName32 = ["EAX","ECX","EDX","EBX","ESP","EBP","ESI","EDI"];
    static regName8 = ["AL","CL","DL","BL","AH","CH","DH","BH"];
    static segName = ["ES","CS","SS","DS","FS","GS"];

    // --- Memory access ---
    linear(seg, off) { return ((seg << 4) + (off & 0xFFFF)) & 0xFFFFF; }

    readByte(seg, off) { return this.mem[this.linear(seg, off)]; }
    readWord(seg, off) {
        const a = this.linear(seg, off);
        return this.mem[a] | (this.mem[(a + 1) & 0xFFFFF] << 8);
    }
    readDword(seg, off) {
        const a = this.linear(seg, off);
        return (this.mem[a] | (this.mem[(a+1)&0xFFFFF] << 8) |
                (this.mem[(a+2)&0xFFFFF] << 16) | (this.mem[(a+3)&0xFFFFF] << 24)) >>> 0;
    }
    writeByte(seg, off, v) {
        const a = this.linear(seg, off);
        this.mem[a] = v & 0xFF;
        this._checkWatch(a, v & 0xFF, 1);
    }
    writeWord(seg, off, v) {
        const a = this.linear(seg, off);
        this.mem[a] = v & 0xFF;
        this.mem[(a + 1) & 0xFFFFF] = (v >> 8) & 0xFF;
        this._checkWatch(a, v & 0xFFFF, 2);
    }
    writeDword(seg, off, v) {
        const a = this.linear(seg, off);
        this.mem[a] = v & 0xFF;
        this.mem[(a+1)&0xFFFFF] = (v >> 8) & 0xFF;
        this.mem[(a+2)&0xFFFFF] = (v >> 16) & 0xFF;
        this.mem[(a+3)&0xFFFFF] = (v >> 24) & 0xFF;
        this._checkWatch(a, v >>> 0, 4);
    }

    _checkWatch(addr, val, size) {
        if (this.watchpoints.size === 0) return;
        for (let i = 0; i < size; i++) {
            const wp = this.watchpoints.get((addr + i) & 0xFFFFF);
            if (wp && wp(this, addr, val, size)) { this.halted = true; }
        }
    }

    // Fetch from CS:IP, advance IP
    fetchByte() { const v = this.readByte(this.cs, this.ip); this.ip = (this.ip + 1) & 0xFFFF; return v; }
    fetchWord() { const v = this.readWord(this.cs, this.ip); this.ip = (this.ip + 2) & 0xFFFF; return v; }
    fetchDword() { const v = this.readDword(this.cs, this.ip); this.ip = (this.ip + 4) & 0xFFFF; return v; }
    fetchSByte() { let v = this.fetchByte(); if (v > 127) v -= 256; return v; }
    fetchSWord() { let v = this.fetchWord(); if (v > 32767) v -= 65536; return v; }

    // Stack
    push16(v) { this.sp = (this.sp - 2) & 0xFFFF; this.writeWord(this.ss, this.sp, v); }
    pop16() { const v = this.readWord(this.ss, this.sp); this.sp = (this.sp + 2) & 0xFFFF; return v; }

    // Default segment for ModRM memory reference
    _defaultSeg(rm) {
        if (this._segOverride >= 0) return this.getSegReg(this._segOverride);
        // BP-based addressing defaults to SS
        if (rm === 2 || rm === 3 || rm === 6) return this.ss;
        return this.ds;
    }

    // --- Flags ---
    setFlagsArith8(result, op1, op2, isSub) {
        const r = result & 0xFF;
        this.zf = r === 0 ? 1 : 0;
        this.sf = (r >> 7) & 1;
        this.cf = isSub ? (((op1 & 0xFF) < (op2 & 0xFF)) ? 1 : 0) : ((result > 0xFF) ? 1 : 0);
        this.of = isSub
            ? (((op1 ^ op2) & (op1 ^ r) & 0x80) ? 1 : 0)
            : (((~(op1 ^ op2) & (op1 ^ r)) & 0x80) ? 1 : 0);
    }
    setFlagsArith16(result, op1, op2, isSub) {
        const r = result & 0xFFFF;
        this.zf = r === 0 ? 1 : 0;
        this.sf = (r >> 15) & 1;
        this.cf = isSub ? (((op1 & 0xFFFF) < (op2 & 0xFFFF)) ? 1 : 0) : ((result > 0xFFFF) ? 1 : 0);
        this.of = isSub
            ? (((op1 ^ op2) & (op1 ^ r) & 0x8000) ? 1 : 0)
            : (((~(op1 ^ op2) & (op1 ^ r)) & 0x8000) ? 1 : 0);
    }
    setFlagsArith32(result, op1, op2, isSub) {
        const r = result >>> 0;
        this.zf = r === 0 ? 1 : 0;
        this.sf = (r >>> 31) & 1;
        if (isSub) {
            this.cf = ((op1 >>> 0) < (op2 >>> 0)) ? 1 : 0;
            this.of = (((op1 ^ op2) & (op1 ^ r) & 0x80000000) ? 1 : 0);
        } else {
            // For add, carry if result wrapped
            const full = (op1 >>> 0) + (op2 >>> 0);
            this.cf = full > 0xFFFFFFFF ? 1 : 0;
            this.of = (((~(op1 ^ op2) & (op1 ^ r)) & 0x80000000) ? 1 : 0);
        }
    }
    setFlagsLogic8(r) { this.zf = (r & 0xFF) === 0 ? 1 : 0; this.sf = (r >> 7) & 1; this.cf = 0; this.of = 0; }
    setFlagsLogic16(r) { this.zf = (r & 0xFFFF) === 0 ? 1 : 0; this.sf = (r >> 15) & 1; this.cf = 0; this.of = 0; }
    setFlagsLogic32(r) { this.zf = (r >>> 0) === 0 ? 1 : 0; this.sf = (r >>> 31) & 1; this.cf = 0; this.of = 0; }

    // --- ModRM decoding ---
    // Returns { val, set(v), seg, off } for memory, or { val, set(v), reg } for register
    decodeModRM(wide, is32) {
        const modrm = this.fetchByte();
        const mod = (modrm >> 6) & 3;
        const reg = (modrm >> 3) & 7;
        const rm = modrm & 7;
        let operand;

        if (mod === 3) {
            // Register
            if (is32) {
                operand = { val: this.getReg32(rm), set: v => this.setReg32(rm, v), isReg: true, regIdx: rm };
            } else if (wide) {
                operand = { val: this.getReg16(rm), set: v => this.setReg16(rm, v), isReg: true, regIdx: rm };
            } else {
                operand = { val: this.getReg8(rm), set: v => this.setReg8(rm, v), isReg: true, regIdx: rm };
            }
        } else {
            // Memory
            let off = 0;
            let defSeg = this.ds;
            switch (rm) {
                case 0: off = (this.bx + this.si) & 0xFFFF; break;
                case 1: off = (this.bx + this.di) & 0xFFFF; break;
                case 2: off = (this.bp + this.si) & 0xFFFF; defSeg = this.ss; break;
                case 3: off = (this.bp + this.di) & 0xFFFF; defSeg = this.ss; break;
                case 4: off = this.si; break;
                case 5: off = this.di; break;
                case 6:
                    if (mod === 0) { off = this.fetchWord(); defSeg = this.ds; }
                    else { off = this.bp; defSeg = this.ss; }
                    break;
                case 7: off = this.bx; break;
            }
            if (mod === 1) {
                off = (off + this.fetchSByte()) & 0xFFFF;
            } else if (mod === 2) {
                off = (off + this.fetchSWord()) & 0xFFFF;
            }
            const seg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : defSeg;
            if (is32) {
                operand = {
                    val: this.readDword(seg, off),
                    set: v => this.writeDword(seg, off, v),
                    seg, off, isReg: false
                };
            } else if (wide) {
                operand = {
                    val: this.readWord(seg, off),
                    set: v => this.writeWord(seg, off, v),
                    seg, off, isReg: false
                };
            } else {
                operand = {
                    val: this.readByte(seg, off),
                    set: v => this.writeByte(seg, off, v),
                    seg, off, isReg: false
                };
            }
        }
        return { operand, reg };
    }

    // --- ALU helpers ---
    aluOp(op, dst, src, wide, is32) {
        const bits = is32 ? 32 : (wide ? 16 : 8);
        const mask = is32 ? 0xFFFFFFFF : (wide ? 0xFFFF : 0xFF);
        const signBit = is32 ? 0x80000000 : (wide ? 0x8000 : 0x80);
        let result;
        const setFlags = is32 ? this.setFlagsArith32.bind(this) : (wide ? this.setFlagsArith16.bind(this) : this.setFlagsArith8.bind(this));
        const setLogic = is32 ? this.setFlagsLogic32.bind(this) : (wide ? this.setFlagsLogic16.bind(this) : this.setFlagsLogic8.bind(this));

        switch (op) {
            case 0: // ADD
                result = ((is32 ? (dst >>> 0) : dst) + (is32 ? (src >>> 0) : src));
                setFlags(result, dst, src, false);
                return is32 ? (result >>> 0) : (result & mask);
            case 1: // OR
                result = (dst | src) & mask;
                setLogic(result);
                return result;
            case 2: // ADC
                result = ((is32 ? (dst >>> 0) : dst) + (is32 ? (src >>> 0) : src) + this.cf);
                setFlags(result, dst, src, false);
                return is32 ? (result >>> 0) : (result & mask);
            case 3: // SBB
                result = dst - src - this.cf;
                setFlags(result, dst, src, true);
                return is32 ? (result >>> 0) : (result & mask);
            case 4: // AND
                result = (dst & src) & mask;
                setLogic(result);
                return result;
            case 5: // SUB
                result = dst - src;
                setFlags(result, dst, src, true);
                return is32 ? (result >>> 0) : (result & mask);
            case 6: // XOR
                result = (dst ^ src) & mask;
                setLogic(result);
                return result;
            case 7: // CMP
                result = dst - src;
                setFlags(result, dst, src, true);
                return dst; // CMP doesn't store
        }
    }

    // --- I/O ports ---
    portOut(port, val) {
        if (port === 0x3C8) {
            this.dacIndex = val & 0xFF;
            this.dacComponent = 0;
        } else if (port === 0x3C9) {
            this.dacPalette[this.dacIndex * 3 + this.dacComponent] = val & 0x3F;
            this.dacComponent++;
            if (this.dacComponent >= 3) {
                this.dacComponent = 0;
                this.dacIndex = (this.dacIndex + 1) & 0xFF;
            }
        }
    }

    // --- Interrupt stubs ---
    handleInt(num) {
        switch (num) {
            case 0x10: // BIOS Video
                if (this.ax === 0x0013) {
                    // Set mode 13h — no-op in emulator
                } else if (this.ax === 0x0003) {
                    // Restore text mode — no-op
                }
                break;
            case 0x1A: // BIOS Timer
                this.cx = (this.timerTicks >> 16) & 0xFFFF;
                this.dx = this.timerTicks & 0xFFFF;
                break;
            case 0x16: // BIOS Keyboard
                if (this.ah === 0x01) {
                    // Check key buffer
                    if (this.keyBuffer.length > 0) {
                        this.zf = 0;
                        this.ax = this.keyBuffer[0];
                    } else {
                        this.zf = 1;
                    }
                } else if (this.ah === 0x00) {
                    // Get key
                    if (this.keyBuffer.length > 0) {
                        this.ax = this.keyBuffer.shift();
                    } else {
                        this.ax = 0;
                    }
                }
                break;
            case 0x21: // DOS
                if (this.ax === 0x4C00) {
                    this.halted = true;
                }
                break;
            case 0x33: // Mouse
                if (this.ax === 0x0000) {
                    // Reset — return FFFF if present
                    this.ax = this.mousePresent ? 0xFFFF : 0;
                } else if (this.ax === 0x000B) {
                    // Read motion
                    this.cx = this.mouseDX & 0xFFFF;
                    this.dx = this.mouseDY & 0xFFFF;
                    this.mouseDX = 0; this.mouseDY = 0;
                } else if (this.ax === 0x0005) {
                    // Read button status
                    this.ax = this.mouseButtons;
                }
                break;
        }
    }

    // --- Main execution ---
    step() {
        if (this.halted) return false;

        const startIP = this.ip;
        const startCS = this.cs;
        this._segOverride = -1;
        this._opSz32 = false;
        this._rep = 0;
        const effects = [];

        // Decode prefixes
        let prefix = true;
        while (prefix) {
            const pb = this.readByte(this.cs, this.ip);
            switch (pb) {
                case 0x26: this._segOverride = 0; this.ip = (this.ip + 1) & 0xFFFF; break; // ES:
                case 0x2E: this._segOverride = 1; this.ip = (this.ip + 1) & 0xFFFF; break; // CS:
                case 0x36: this._segOverride = 2; this.ip = (this.ip + 1) & 0xFFFF; break; // SS:
                case 0x3E: this._segOverride = 3; this.ip = (this.ip + 1) & 0xFFFF; break; // DS:
                case 0x64: this._segOverride = 4; this.ip = (this.ip + 1) & 0xFFFF; break; // FS:
                case 0x65: this._segOverride = 5; this.ip = (this.ip + 1) & 0xFFFF; break; // GS:
                case 0x66: this._opSz32 = true; this.ip = (this.ip + 1) & 0xFFFF; break;
                case 0xF3: this._rep = 1; this.ip = (this.ip + 1) & 0xFFFF; break; // REP/REPE
                case 0xF2: this._rep = 2; this.ip = (this.ip + 1) & 0xFFFF; break; // REPNE
                default: prefix = false;
            }
        }

        const opcode = this.fetchByte();
        const is32 = this._opSz32;

        switch (opcode) {
            // === ALU r/m, reg  and  reg, r/m ===
            // 00-05: ADD, 08-0D: OR, 10-15: ADC, 18-1D: SBB, 20-25: AND, 28-2D: SUB, 30-35: XOR, 38-3D: CMP
            case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05:
            case 0x08: case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D:
            case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
            case 0x18: case 0x19: case 0x1A: case 0x1B: case 0x1C: case 0x1D:
            case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25:
            case 0x28: case 0x29: case 0x2A: case 0x2B: case 0x2C: case 0x2D:
            case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
            case 0x38: case 0x39: case 0x3A: case 0x3B: case 0x3C: case 0x3D: {
                const aluIdx = (opcode >> 3) & 7;
                const subOp = opcode & 7;
                if (subOp <= 3) {
                    const wide = (subOp & 1) !== 0;
                    const dir = (subOp & 2) !== 0; // 0=r/m,reg  2=reg,r/m
                    const { operand, reg } = this.decodeModRM(wide, wide && is32);
                    let regVal, rmVal;
                    if (wide && is32) {
                        regVal = this.getReg32(reg);
                        rmVal = operand.val;
                    } else if (wide) {
                        regVal = this.getReg16(reg);
                        rmVal = operand.val;
                    } else {
                        regVal = this.getReg8(reg);
                        rmVal = operand.val;
                    }
                    if (dir) {
                        // reg = op(reg, r/m)
                        const result = this.aluOp(aluIdx, regVal, rmVal, wide, wide && is32);
                        if (aluIdx !== 7) { // not CMP
                            if (wide && is32) this.setReg32(reg, result);
                            else if (wide) this.setReg16(reg, result);
                            else this.setReg8(reg, result);
                            effects.push(`${is32 ? CPU.regName32[reg] : (wide ? CPU.regName16[reg] : CPU.regName8[reg])}=${hex(result, wide && is32 ? 8 : (wide ? 4 : 2))}`);
                        }
                    } else {
                        // r/m = op(r/m, reg)
                        const result = this.aluOp(aluIdx, rmVal, regVal, wide, wide && is32);
                        if (aluIdx !== 7) {
                            operand.set(result);
                            if (operand.isReg) {
                                effects.push(`${is32 ? CPU.regName32[operand.regIdx] : (wide ? CPU.regName16[operand.regIdx] : CPU.regName8[operand.regIdx])}=${hex(result, wide && is32 ? 8 : (wide ? 4 : 2))}`);
                            } else {
                                effects.push(`[${hex(operand.seg,4)}:${hex(operand.off,4)}]=${hex(result, wide && is32 ? 8 : (wide ? 4 : 2))}`);
                            }
                        }
                    }
                } else if (subOp === 4) {
                    // AL, imm8
                    const imm = this.fetchByte();
                    const result = this.aluOp(aluIdx, this.al, imm, false, false);
                    if (aluIdx !== 7) { this.al = result; effects.push(`AL=${hex(result,2)}`); }
                } else if (subOp === 5) {
                    // AX/EAX, imm16/32
                    if (is32) {
                        const imm = this.fetchDword();
                        const result = this.aluOp(aluIdx, this.eax, imm, true, true);
                        if (aluIdx !== 7) { this.eax = result; effects.push(`EAX=${hex(result,8)}`); }
                    } else {
                        const imm = this.fetchWord();
                        const result = this.aluOp(aluIdx, this.ax, imm, true, false);
                        if (aluIdx !== 7) { this.ax = result; effects.push(`AX=${hex(result,4)}`); }
                    }
                }
                break;
            }

            // === INC/DEC reg16/32 ===
            case 0x40: case 0x41: case 0x42: case 0x43:
            case 0x44: case 0x45: case 0x46: case 0x47: {
                const reg = opcode & 7;
                const oldCf = this.cf;
                if (is32) {
                    const v = this.getReg32(reg);
                    const r = this.aluOp(0, v, 1, true, true);
                    this.setReg32(reg, r);
                    effects.push(`${CPU.regName32[reg]}=${hex(r,8)}`);
                } else {
                    const v = this.getReg16(reg);
                    const r = this.aluOp(0, v, 1, true, false);
                    this.setReg16(reg, r);
                    effects.push(`${CPU.regName16[reg]}=${hex(r,4)}`);
                }
                this.cf = oldCf; // INC doesn't affect CF
                break;
            }
            case 0x48: case 0x49: case 0x4A: case 0x4B:
            case 0x4C: case 0x4D: case 0x4E: case 0x4F: {
                const reg = opcode & 7;
                const oldCf = this.cf;
                if (is32) {
                    const v = this.getReg32(reg);
                    const r = this.aluOp(5, v, 1, true, true);
                    this.setReg32(reg, r);
                    effects.push(`${CPU.regName32[reg]}=${hex(r,8)}`);
                } else {
                    const v = this.getReg16(reg);
                    const r = this.aluOp(5, v, 1, true, false);
                    this.setReg16(reg, r);
                    effects.push(`${CPU.regName16[reg]}=${hex(r,4)}`);
                }
                this.cf = oldCf; // DEC doesn't affect CF
                break;
            }

            // === PUSH reg16 ===
            case 0x50: case 0x51: case 0x52: case 0x53:
            case 0x54: case 0x55: case 0x56: case 0x57: {
                const reg = opcode & 7;
                this.push16(this.getReg16(reg));
                effects.push(`PUSH ${CPU.regName16[reg]}`);
                break;
            }
            // === POP reg16 ===
            case 0x58: case 0x59: case 0x5A: case 0x5B:
            case 0x5C: case 0x5D: case 0x5E: case 0x5F: {
                const reg = opcode & 7;
                const v = this.pop16();
                this.setReg16(reg, v);
                effects.push(`${CPU.regName16[reg]}=${hex(v,4)}`);
                break;
            }

            // === PUSH imm8 ===
            case 0x6A: {
                let v = this.fetchSByte();
                this.push16(v & 0xFFFF);
                effects.push(`PUSH ${hex(v & 0xFFFF, 4)}`);
                break;
            }
            // === PUSH imm16 ===
            case 0x68: {
                const v = this.fetchWord();
                this.push16(v);
                effects.push(`PUSH ${hex(v,4)}`);
                break;
            }

            // === Jcc rel8 ===
            case 0x70: case 0x71: case 0x72: case 0x73:
            case 0x74: case 0x75: case 0x76: case 0x77:
            case 0x78: case 0x79: case 0x7A: case 0x7B:
            case 0x7C: case 0x7D: case 0x7E: case 0x7F: {
                const rel = this.fetchSByte();
                const cond = this._testCC(opcode & 0xF);
                if (cond) {
                    this.ip = (this.ip + rel) & 0xFFFF;
                    effects.push(`JMP → ${hex(this.ip,4)}`);
                }
                break;
            }

            // === Group 1: 80/81/83 r/m, imm ===
            case 0x80: case 0x81: case 0x82: case 0x83: {
                const wide = (opcode & 1) !== 0;
                const signExt = (opcode === 0x83);
                const { operand, reg: aluIdx } = this.decodeModRM(wide, wide && is32);
                let imm;
                if (opcode === 0x80 || opcode === 0x82) {
                    imm = this.fetchByte();
                } else if (signExt) {
                    imm = this.fetchSByte();
                    if (is32) imm = imm & 0xFFFFFFFF;
                    else imm = imm & 0xFFFF;
                } else {
                    imm = is32 ? this.fetchDword() : this.fetchWord();
                }
                const result = this.aluOp(aluIdx, operand.val, imm, wide, wide && is32);
                if (aluIdx !== 7) {
                    operand.set(result);
                    if (operand.isReg) {
                        const nm = is32 ? CPU.regName32[operand.regIdx] : (wide ? CPU.regName16[operand.regIdx] : CPU.regName8[operand.regIdx]);
                        effects.push(`${nm}=${hex(result, is32 ? 8 : (wide ? 4 : 2))}`);
                    } else {
                        effects.push(`[${hex(operand.seg,4)}:${hex(operand.off,4)}]=${hex(result, is32 ? 8 : (wide ? 4 : 2))}`);
                    }
                }
                break;
            }

            // === TEST r/m, reg ===
            case 0x84: case 0x85: {
                const wide = (opcode & 1) !== 0;
                const { operand, reg } = this.decodeModRM(wide, wide && is32);
                const regVal = wide ? (is32 ? this.getReg32(reg) : this.getReg16(reg)) : this.getReg8(reg);
                const r = operand.val & regVal;
                if (is32) this.setFlagsLogic32(r);
                else if (wide) this.setFlagsLogic16(r);
                else this.setFlagsLogic8(r);
                break;
            }

            // === XCHG r/m, reg ===
            case 0x86: case 0x87: {
                const wide = (opcode & 1) !== 0;
                const { operand, reg } = this.decodeModRM(wide, wide && is32);
                if (wide && is32) {
                    const rv = this.getReg32(reg);
                    this.setReg32(reg, operand.val);
                    operand.set(rv);
                    effects.push(`${CPU.regName32[reg]}=${hex(operand.val,8)}`);
                } else if (wide) {
                    const rv = this.getReg16(reg);
                    this.setReg16(reg, operand.val);
                    operand.set(rv);
                    effects.push(`${CPU.regName16[reg]}=${hex(operand.val,4)}`);
                } else {
                    const rv = this.getReg8(reg);
                    this.setReg8(reg, operand.val);
                    operand.set(rv);
                    effects.push(`${CPU.regName8[reg]}=${hex(operand.val,2)}`);
                }
                break;
            }

            // === MOV r/m, reg ===
            case 0x88: case 0x89: {
                const wide = (opcode & 1) !== 0;
                const { operand, reg } = this.decodeModRM(wide, wide && is32);
                const val = wide ? (is32 ? this.getReg32(reg) : this.getReg16(reg)) : this.getReg8(reg);
                operand.set(val);
                if (operand.isReg) {
                    const nm = is32 ? CPU.regName32[operand.regIdx] : (wide ? CPU.regName16[operand.regIdx] : CPU.regName8[operand.regIdx]);
                    effects.push(`${nm}=${hex(val, is32 ? 8 : (wide ? 4 : 2))}`);
                } else {
                    effects.push(`[${hex(operand.seg,4)}:${hex(operand.off,4)}]=${hex(val, is32 ? 8 : (wide ? 4 : 2))}`);
                }
                break;
            }
            // === MOV reg, r/m ===
            case 0x8A: case 0x8B: {
                const wide = (opcode & 1) !== 0;
                const { operand, reg } = this.decodeModRM(wide, wide && is32);
                if (wide && is32) {
                    this.setReg32(reg, operand.val);
                    effects.push(`${CPU.regName32[reg]}=${hex(operand.val,8)}`);
                } else if (wide) {
                    this.setReg16(reg, operand.val);
                    effects.push(`${CPU.regName16[reg]}=${hex(operand.val,4)}`);
                } else {
                    this.setReg8(reg, operand.val);
                    effects.push(`${CPU.regName8[reg]}=${hex(operand.val,2)}`);
                }
                break;
            }

            // === MOV r/m, sreg ===
            case 0x8C: {
                const { operand, reg } = this.decodeModRM(true, false);
                const v = this.getSegReg(reg);
                operand.set(v);
                effects.push(`${operand.isReg ? CPU.regName16[operand.regIdx] : `[${hex(operand.seg,4)}:${hex(operand.off,4)}]`}=${hex(v,4)}`);
                break;
            }

            // === LEA reg, r/m ===
            case 0x8D: {
                const { operand, reg } = this.decodeModRM(true, is32);
                // operand.off is the effective address
                if (is32) {
                    this.setReg32(reg, operand.off);
                    effects.push(`${CPU.regName32[reg]}=${hex(operand.off,8)}`);
                } else {
                    this.setReg16(reg, operand.off);
                    effects.push(`${CPU.regName16[reg]}=${hex(operand.off,4)}`);
                }
                break;
            }

            // === MOV sreg, r/m ===
            case 0x8E: {
                const { operand, reg } = this.decodeModRM(true, false);
                this.setSegReg(reg, operand.val);
                effects.push(`${CPU.segName[reg]}=${hex(operand.val,4)}`);
                break;
            }

            // === NOP (XCHG AX,AX) ===
            case 0x90: break;

            // === CBW ===
            case 0x98: {
                if (is32) {
                    // CWDE: sign-extend AX → EAX
                    let v = this.ax;
                    if (v & 0x8000) v |= 0xFFFF0000;
                    this.eax = v >>> 0;
                    effects.push(`EAX=${hex(this.eax,8)}`);
                } else {
                    // CBW: sign-extend AL → AX
                    let v = this.al;
                    if (v & 0x80) v |= 0xFF00;
                    this.ax = v & 0xFFFF;
                    effects.push(`AX=${hex(this.ax,4)}`);
                }
                break;
            }
            // === CWD ===
            case 0x99: {
                if (is32) {
                    // CDQ: sign-extend EAX → EDX:EAX
                    this.edx = (this.eax & 0x80000000) ? 0xFFFFFFFF : 0;
                    effects.push(`EDX=${hex(this.edx,8)}`);
                } else {
                    // CWD: sign-extend AX → DX:AX
                    this.dx = (this.ax & 0x8000) ? 0xFFFF : 0;
                    effects.push(`DX=${hex(this.dx,4)}`);
                }
                break;
            }

            // === MOV moffs ===
            case 0xA0: { // MOV AL, [moffs16]
                const off = this.fetchWord();
                const seg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                this.al = this.readByte(seg, off);
                effects.push(`AL=${hex(this.al,2)}`);
                break;
            }
            case 0xA1: { // MOV AX/EAX, [moffs16]
                const off = this.fetchWord();
                const seg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                if (is32) {
                    this.eax = this.readDword(seg, off);
                    effects.push(`EAX=${hex(this.eax,8)}`);
                } else {
                    this.ax = this.readWord(seg, off);
                    effects.push(`AX=${hex(this.ax,4)}`);
                }
                break;
            }
            case 0xA2: { // MOV [moffs16], AL
                const off = this.fetchWord();
                const seg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                this.writeByte(seg, off, this.al);
                effects.push(`[${hex(seg,4)}:${hex(off,4)}]=${hex(this.al,2)}`);
                break;
            }
            case 0xA3: { // MOV [moffs16], AX/EAX
                const off = this.fetchWord();
                const seg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                if (is32) {
                    this.writeDword(seg, off, this.eax);
                    effects.push(`[${hex(seg,4)}:${hex(off,4)}]=${hex(this.eax,8)}`);
                } else {
                    this.writeWord(seg, off, this.ax);
                    effects.push(`[${hex(seg,4)}:${hex(off,4)}]=${hex(this.ax,4)}`);
                }
                break;
            }

            // === MOVSB ===
            case 0xA4: {
                if (this._rep) {
                    while (this.cx > 0) {
                        const v = this.readByte(this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds, this.si);
                        this.writeByte(this.es, this.di, v);
                        this.si = (this.si + (this.df ? -1 : 1)) & 0xFFFF;
                        this.di = (this.di + (this.df ? -1 : 1)) & 0xFFFF;
                        this.cx--;
                    }
                    effects.push(`REP MOVSB done`);
                } else {
                    const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                    const v = this.readByte(srcSeg, this.si);
                    this.writeByte(this.es, this.di, v);
                    this.si = (this.si + (this.df ? -1 : 1)) & 0xFFFF;
                    this.di = (this.di + (this.df ? -1 : 1)) & 0xFFFF;
                    effects.push(`[${hex(this.es,4)}:${hex((this.di + (this.df ? 1 : -1)) & 0xFFFF,4)}]=${hex(v,2)}`);
                }
                break;
            }

            // === MOVSD (66 A5) ===
            case 0xA5: {
                if (is32) {
                    // MOVSD
                    if (this._rep) {
                        while (this.cx > 0) {
                            const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                            const v = this.readDword(srcSeg, this.si);
                            this.writeDword(this.es, this.di, v);
                            this.si = (this.si + (this.df ? -4 : 4)) & 0xFFFF;
                            this.di = (this.di + (this.df ? -4 : 4)) & 0xFFFF;
                            this.cx--;
                        }
                        effects.push(`REP MOVSD done`);
                    } else {
                        const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                        const v = this.readDword(srcSeg, this.si);
                        this.writeDword(this.es, this.di, v);
                        this.si = (this.si + (this.df ? -4 : 4)) & 0xFFFF;
                        this.di = (this.di + (this.df ? -4 : 4)) & 0xFFFF;
                        effects.push(`MOVSD`);
                    }
                } else {
                    // MOVSW
                    if (this._rep) {
                        while (this.cx > 0) {
                            const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                            const v = this.readWord(srcSeg, this.si);
                            this.writeWord(this.es, this.di, v);
                            this.si = (this.si + (this.df ? -2 : 2)) & 0xFFFF;
                            this.di = (this.di + (this.df ? -2 : 2)) & 0xFFFF;
                            this.cx--;
                        }
                        effects.push(`REP MOVSW done`);
                    } else {
                        const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                        const v = this.readWord(srcSeg, this.si);
                        this.writeWord(this.es, this.di, v);
                        this.si = (this.si + (this.df ? -2 : 2)) & 0xFFFF;
                        this.di = (this.di + (this.df ? -2 : 2)) & 0xFFFF;
                        effects.push(`MOVSW`);
                    }
                }
                break;
            }

            // === STOSD/STOSW/STOSB ===
            case 0xAA: { // STOSB
                if (this._rep) {
                    while (this.cx > 0) {
                        this.writeByte(this.es, this.di, this.al);
                        this.di = (this.di + (this.df ? -1 : 1)) & 0xFFFF;
                        this.cx--;
                    }
                    effects.push(`REP STOSB done`);
                } else {
                    this.writeByte(this.es, this.di, this.al);
                    this.di = (this.di + (this.df ? -1 : 1)) & 0xFFFF;
                    effects.push(`STOSB`);
                }
                break;
            }
            case 0xAB: { // STOSW / STOSD
                if (is32) {
                    if (this._rep) {
                        while (this.cx > 0) {
                            this.writeDword(this.es, this.di, this.eax);
                            this.di = (this.di + (this.df ? -4 : 4)) & 0xFFFF;
                            this.cx--;
                        }
                        effects.push(`REP STOSD done`);
                    } else {
                        this.writeDword(this.es, this.di, this.eax);
                        this.di = (this.di + (this.df ? -4 : 4)) & 0xFFFF;
                        effects.push(`STOSD`);
                    }
                } else {
                    if (this._rep) {
                        while (this.cx > 0) {
                            this.writeWord(this.es, this.di, this.ax);
                            this.di = (this.di + (this.df ? -2 : 2)) & 0xFFFF;
                            this.cx--;
                        }
                        effects.push(`REP STOSW done`);
                    } else {
                        this.writeWord(this.es, this.di, this.ax);
                        this.di = (this.di + (this.df ? -2 : 2)) & 0xFFFF;
                        effects.push(`STOSW`);
                    }
                }
                break;
            }

            // === MOV reg, imm (B0-BF) ===
            case 0xB0: case 0xB1: case 0xB2: case 0xB3:
            case 0xB4: case 0xB5: case 0xB6: case 0xB7: {
                const reg = opcode & 7;
                const v = this.fetchByte();
                this.setReg8(reg, v);
                effects.push(`${CPU.regName8[reg]}=${hex(v,2)}`);
                break;
            }
            case 0xB8: case 0xB9: case 0xBA: case 0xBB:
            case 0xBC: case 0xBD: case 0xBE: case 0xBF: {
                const reg = opcode & 7;
                if (is32) {
                    const v = this.fetchDword();
                    this.setReg32(reg, v);
                    effects.push(`${CPU.regName32[reg]}=${hex(v,8)}`);
                } else {
                    const v = this.fetchWord();
                    this.setReg16(reg, v);
                    effects.push(`${CPU.regName16[reg]}=${hex(v,4)}`);
                }
                break;
            }

            // === RET ===
            case 0xC3: {
                this.ip = this.pop16();
                effects.push(`RET → ${hex(this.ip,4)}`);
                break;
            }

            // === MOV r/m, imm ===
            case 0xC6: { // MOV r/m8, imm8
                const { operand } = this.decodeModRM(false, false);
                const v = this.fetchByte();
                operand.set(v);
                if (operand.isReg) {
                    effects.push(`${CPU.regName8[operand.regIdx]}=${hex(v,2)}`);
                } else {
                    effects.push(`[${hex(operand.seg,4)}:${hex(operand.off,4)}]=${hex(v,2)}`);
                }
                break;
            }
            case 0xC7: { // MOV r/m16, imm16 (or r/m32, imm32)
                const { operand } = this.decodeModRM(true, is32);
                const v = is32 ? this.fetchDword() : this.fetchWord();
                operand.set(v);
                if (operand.isReg) {
                    effects.push(`${is32 ? CPU.regName32[operand.regIdx] : CPU.regName16[operand.regIdx]}=${hex(v, is32 ? 8 : 4)}`);
                } else {
                    effects.push(`[${hex(operand.seg,4)}:${hex(operand.off,4)}]=${hex(v, is32 ? 8 : 4)}`);
                }
                break;
            }

            // === Shift/rotate group (C0, C1, D0, D1, D2, D3) ===
            case 0xC0: case 0xC1: case 0xD0: case 0xD1: case 0xD2: case 0xD3: {
                const wide = (opcode & 1) !== 0;
                const { operand, reg: shiftOp } = this.decodeModRM(wide, wide && is32);
                let count;
                if (opcode === 0xC0 || opcode === 0xC1) {
                    count = this.fetchByte() & 0x1F;
                } else if (opcode === 0xD0 || opcode === 0xD1) {
                    count = 1;
                } else {
                    count = this.cl & 0x1F;
                }
                if (count === 0) break;
                const bits = is32 && wide ? 32 : (wide ? 16 : 8);
                const mask = bits === 32 ? 0xFFFFFFFF : ((1 << bits) - 1);
                let val = operand.val;

                switch (shiftOp) {
                    case 0: // ROL
                        for (let i = 0; i < count; i++) {
                            const msb = (val >> (bits - 1)) & 1;
                            val = ((val << 1) | msb) & mask;
                            this.cf = msb;
                        }
                        break;
                    case 1: // ROR
                        for (let i = 0; i < count; i++) {
                            const lsb = val & 1;
                            val = ((val >>> 1) | (lsb << (bits - 1))) & mask;
                            this.cf = lsb;
                        }
                        break;
                    case 4: // SHL
                        for (let i = 0; i < count; i++) {
                            this.cf = (val >> (bits - 1)) & 1;
                            val = (val << 1) & mask;
                        }
                        this.zf = val === 0 ? 1 : 0;
                        this.sf = (val >> (bits - 1)) & 1;
                        break;
                    case 5: // SHR
                        for (let i = 0; i < count; i++) {
                            this.cf = val & 1;
                            val = (val >>> 1) & mask;
                        }
                        this.zf = val === 0 ? 1 : 0;
                        this.sf = (val >> (bits - 1)) & 1;
                        break;
                    case 7: // SAR
                        for (let i = 0; i < count; i++) {
                            this.cf = val & 1;
                            const signBit = val & (1 << (bits - 1));
                            val = ((val >>> 1) | signBit) & mask;
                        }
                        this.zf = val === 0 ? 1 : 0;
                        this.sf = (val >> (bits - 1)) & 1;
                        break;
                    default:
                        this._unimpl(opcode, `shift op ${shiftOp}`);
                }
                operand.set(val);
                if (operand.isReg) {
                    const nm = is32 && wide ? CPU.regName32[operand.regIdx] : (wide ? CPU.regName16[operand.regIdx] : CPU.regName8[operand.regIdx]);
                    effects.push(`${nm}=${hex(val, is32 && wide ? 8 : (wide ? 4 : 2))}`);
                } else {
                    effects.push(`[${hex(operand.seg,4)}:${hex(operand.off,4)}]=${hex(val, is32 && wide ? 8 : (wide ? 4 : 2))}`);
                }
                break;
            }

            // === CALL rel16 ===
            case 0xE8: {
                const rel = this.fetchSWord();
                this.push16(this.ip);
                this.ip = (this.ip + rel) & 0xFFFF;
                effects.push(`CALL ${hex(this.ip,4)}`);
                break;
            }

            // === JMP rel16 ===
            case 0xE9: {
                const rel = this.fetchSWord();
                this.ip = (this.ip + rel) & 0xFFFF;
                effects.push(`JMP ${hex(this.ip,4)}`);
                break;
            }
            // === JMP rel8 ===
            case 0xEB: {
                const rel = this.fetchSByte();
                this.ip = (this.ip + rel) & 0xFFFF;
                effects.push(`JMP ${hex(this.ip,4)}`);
                break;
            }

            // === INT imm8 ===
            case 0xCD: {
                const num = this.fetchByte();
                this.handleInt(num);
                effects.push(`INT ${hex(num,2)}`);
                break;
            }

            // === OUT DX, AL ===
            case 0xEE: {
                this.portOut(this.dx, this.al);
                effects.push(`OUT ${hex(this.dx,4)},${hex(this.al,2)}`);
                break;
            }

            // === OUTSB (REP) ===
            case 0x6E: {
                if (this._rep) {
                    const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                    while (this.cx > 0) {
                        const v = this.readByte(srcSeg, this.si);
                        this.portOut(this.dx, v);
                        this.si = (this.si + (this.df ? -1 : 1)) & 0xFFFF;
                        this.cx--;
                    }
                    effects.push(`REP OUTSB done`);
                } else {
                    const srcSeg = this._segOverride >= 0 ? this.getSegReg(this._segOverride) : this.ds;
                    const v = this.readByte(srcSeg, this.si);
                    this.portOut(this.dx, v);
                    this.si = (this.si + (this.df ? -1 : 1)) & 0xFFFF;
                    effects.push(`OUTSB`);
                }
                break;
            }

            // === CLC/STC/CMC/CLD/STD/CLI/STI ===
            case 0xF8: this.cf = 0; break;
            case 0xF9: this.cf = 1; break;
            case 0xF5: this.cf = this.cf ? 0 : 1; break;
            case 0xFC: this.df = 0; break;
            case 0xFD: this.df = 1; break;
            case 0xFA: break; // CLI — no-op in emulator
            case 0xFB: break; // STI — no-op in emulator

            // === Group 3: F6/F7 (TEST/NOT/NEG/MUL/IMUL/DIV/IDIV) ===
            case 0xF6: case 0xF7: {
                const wide = (opcode & 1) !== 0;
                const { operand, reg: grpOp } = this.decodeModRM(wide, wide && is32);
                switch (grpOp) {
                    case 0: case 1: { // TEST r/m, imm
                        const imm = wide ? (is32 ? this.fetchDword() : this.fetchWord()) : this.fetchByte();
                        const r = operand.val & imm;
                        if (is32 && wide) this.setFlagsLogic32(r);
                        else if (wide) this.setFlagsLogic16(r);
                        else this.setFlagsLogic8(r);
                        break;
                    }
                    case 2: { // NOT
                        const mask = is32 && wide ? 0xFFFFFFFF : (wide ? 0xFFFF : 0xFF);
                        const r = (~operand.val) & mask;
                        operand.set(r);
                        effects.push(`NOT → ${hex(r, is32 && wide ? 8 : (wide ? 4 : 2))}`);
                        break;
                    }
                    case 3: { // NEG
                        const bits = is32 && wide ? 32 : (wide ? 16 : 8);
                        const mask = bits === 32 ? 0xFFFFFFFF : ((1 << bits) - 1);
                        const r = (-operand.val) & mask;
                        operand.set(r);
                        this.cf = operand.val !== 0 ? 1 : 0;
                        if (bits === 32) this.setFlagsArith32(r, 0, operand.val, true);
                        else if (bits === 16) this.setFlagsArith16(r, 0, operand.val, true);
                        else this.setFlagsArith8(r, 0, operand.val, true);
                        effects.push(`NEG → ${hex(r, bits === 32 ? 8 : (bits === 16 ? 4 : 2))}`);
                        break;
                    }
                    case 4: { // MUL (unsigned)
                        if (is32 && wide) {
                            const result = BigInt(this.eax >>> 0) * BigInt(operand.val >>> 0);
                            this.eax = Number(result & 0xFFFFFFFFn) >>> 0;
                            this.edx = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
                            this.cf = this.of = this.edx !== 0 ? 1 : 0;
                            effects.push(`EDX:EAX=${hex(this.edx,8)}:${hex(this.eax,8)}`);
                        } else if (wide) {
                            const result = (this.ax & 0xFFFF) * (operand.val & 0xFFFF);
                            this.ax = result & 0xFFFF;
                            this.dx = (result >> 16) & 0xFFFF;
                            this.cf = this.of = this.dx !== 0 ? 1 : 0;
                            effects.push(`DX:AX=${hex(this.dx,4)}:${hex(this.ax,4)}`);
                        } else {
                            const result = this.al * operand.val;
                            this.ax = result & 0xFFFF;
                            this.cf = this.of = this.ah !== 0 ? 1 : 0;
                            effects.push(`AX=${hex(this.ax,4)}`);
                        }
                        break;
                    }
                    case 5: { // IMUL (signed, one-operand)
                        if (is32 && wide) {
                            const a = this.eax | 0;
                            const b = operand.val | 0;
                            const result = BigInt(a) * BigInt(b);
                            this.eax = Number(result & 0xFFFFFFFFn) >>> 0;
                            this.edx = Number((result >> 32n) & 0xFFFFFFFFn) >>> 0;
                            effects.push(`EDX:EAX=${hex(this.edx,8)}:${hex(this.eax,8)}`);
                        } else if (wide) {
                            let a = this.ax; if (a & 0x8000) a -= 0x10000;
                            let b = operand.val; if (b & 0x8000) b -= 0x10000;
                            const result = a * b;
                            this.ax = result & 0xFFFF;
                            this.dx = (result >> 16) & 0xFFFF;
                            effects.push(`DX:AX=${hex(this.dx,4)}:${hex(this.ax,4)}`);
                        } else {
                            let a = this.al; if (a > 127) a -= 256;
                            let b = operand.val; if (b > 127) b -= 256;
                            const result = a * b;
                            this.ax = result & 0xFFFF;
                            effects.push(`AX=${hex(this.ax,4)}`);
                        }
                        break;
                    }
                    case 6: { // DIV (unsigned)
                        if (is32 && wide) {
                            const dividend = (BigInt(this.edx >>> 0) << 32n) | BigInt(this.eax >>> 0);
                            const divisor = BigInt(operand.val >>> 0);
                            if (divisor === 0n) { this.halted = true; effects.push(`DIV/0!`); break; }
                            this.eax = Number(dividend / divisor) >>> 0;
                            this.edx = Number(dividend % divisor) >>> 0;
                            effects.push(`EAX=${hex(this.eax,8)} EDX=${hex(this.edx,8)}`);
                        } else if (wide) {
                            const dividend = (((this.dx & 0xFFFF) << 16) | (this.ax & 0xFFFF)) >>> 0;
                            const divisor = operand.val & 0xFFFF;
                            if (divisor === 0) { this.halted = true; effects.push(`DIV/0!`); break; }
                            this.ax = ((dividend / divisor) >>> 0) & 0xFFFF;
                            this.dx = ((dividend % divisor) >>> 0) & 0xFFFF;
                            effects.push(`AX=${hex(this.ax,4)} DX=${hex(this.dx,4)}`);
                        } else {
                            const dividend = this.ax & 0xFFFF;
                            const divisor = operand.val & 0xFF;
                            if (divisor === 0) { this.halted = true; effects.push(`DIV/0!`); break; }
                            this.al = ((dividend / divisor) | 0) & 0xFF;
                            this.ah = (dividend % divisor) & 0xFF;
                            effects.push(`AX=${hex(this.ax,4)}`);
                        }
                        break;
                    }
                    case 7: { // IDIV (signed)
                        if (is32 && wide) {
                            const dividend = (BigInt(this.edx | 0) << 32n) | BigInt(this.eax >>> 0);
                            const divisor = BigInt(operand.val | 0);
                            if (divisor === 0n) { this.halted = true; effects.push(`IDIV/0!`); break; }
                            // JS BigInt division truncates toward zero (matches x86)
                            this.eax = Number(dividend / divisor) >>> 0;
                            // Remainder: dividend - (quotient * divisor)
                            const quot = dividend / divisor;
                            this.edx = Number(dividend - quot * divisor) >>> 0;
                            effects.push(`EAX=${hex(this.eax,8)} EDX=${hex(this.edx,8)}`);
                        } else if (wide) {
                            let dividend = ((this.dx & 0xFFFF) << 16) | (this.ax & 0xFFFF);
                            // << and | already produce signed 32-bit in JS; no extra sign extension needed
                            let divisor = operand.val & 0xFFFF;
                            if (divisor & 0x8000) divisor -= 0x10000;
                            if (divisor === 0) { this.halted = true; effects.push(`IDIV/0!`); break; }
                            const q = (dividend / divisor) | 0;
                            const r = dividend - q * divisor;
                            this.ax = q & 0xFFFF;
                            this.dx = r & 0xFFFF;
                            effects.push(`AX=${hex(this.ax,4)} DX=${hex(this.dx,4)}`);
                        } else {
                            let dividend = this.ax & 0xFFFF;
                            if (dividend & 0x8000) dividend -= 0x10000;
                            let divisor = operand.val & 0xFF;
                            if (divisor & 0x80) divisor -= 0x100;
                            if (divisor === 0) { this.halted = true; effects.push(`IDIV/0!`); break; }
                            const q = (dividend / divisor) | 0;
                            const r = dividend - q * divisor;
                            this.al = q & 0xFF;
                            this.ah = r & 0xFF;
                            effects.push(`AX=${hex(this.ax,4)}`);
                        }
                        break;
                    }
                }
                break;
            }

            // === Group 5: FF (INC/DEC/CALL/JMP r/m) ===
            case 0xFF: {
                const { operand, reg: grpOp } = this.decodeModRM(true, is32);
                switch (grpOp) {
                    case 0: { // INC r/m16
                        const oldCf = this.cf;
                        const r = this.aluOp(0, operand.val, 1, true, is32);
                        operand.set(r);
                        this.cf = oldCf;
                        effects.push(`INC → ${hex(r, is32 ? 8 : 4)}`);
                        break;
                    }
                    case 1: { // DEC r/m16
                        const oldCf = this.cf;
                        const r = this.aluOp(5, operand.val, 1, true, is32);
                        operand.set(r);
                        this.cf = oldCf;
                        effects.push(`DEC → ${hex(r, is32 ? 8 : 4)}`);
                        break;
                    }
                    case 4: { // JMP r/m16
                        this.ip = operand.val & 0xFFFF;
                        effects.push(`JMP ${hex(this.ip,4)}`);
                        break;
                    }
                    case 6: { // PUSH r/m16
                        this.push16(operand.val & 0xFFFF);
                        effects.push(`PUSH ${hex(operand.val & 0xFFFF, 4)}`);
                        break;
                    }
                    default:
                        this._unimpl(opcode, `FF/${grpOp}`);
                }
                break;
            }

            // === Group FE (INC/DEC r/m8) ===
            case 0xFE: {
                const { operand, reg: grpOp } = this.decodeModRM(false, false);
                if (grpOp === 0) {
                    const oldCf = this.cf;
                    const r = this.aluOp(0, operand.val, 1, false, false);
                    operand.set(r);
                    this.cf = oldCf;
                    effects.push(`INC → ${hex(r,2)}`);
                } else if (grpOp === 1) {
                    const oldCf = this.cf;
                    const r = this.aluOp(5, operand.val, 1, false, false);
                    operand.set(r);
                    this.cf = oldCf;
                    effects.push(`DEC → ${hex(r,2)}`);
                }
                break;
            }

            // === 0F two-byte opcodes ===
            case 0x0F: {
                const op2 = this.fetchByte();
                switch (op2) {
                    // === Jcc rel16 (0F 80-8F) ===
                    case 0x80: case 0x81: case 0x82: case 0x83:
                    case 0x84: case 0x85: case 0x86: case 0x87:
                    case 0x88: case 0x89: case 0x8A: case 0x8B:
                    case 0x8C: case 0x8D: case 0x8E: case 0x8F: {
                        const rel = this.fetchSWord();
                        const cond = this._testCC(op2 & 0xF);
                        if (cond) {
                            this.ip = (this.ip + rel) & 0xFFFF;
                            effects.push(`JMP → ${hex(this.ip,4)}`);
                        }
                        break;
                    }
                    // === SETZ / SETNZ etc ===
                    case 0x94: case 0x95: case 0x90: case 0x91:
                    case 0x92: case 0x93: case 0x96: case 0x97:
                    case 0x98: case 0x99: case 0x9A: case 0x9B:
                    case 0x9C: case 0x9D: case 0x9E: case 0x9F: {
                        const { operand } = this.decodeModRM(false, false);
                        const v = this._testCC(op2 & 0xF) ? 1 : 0;
                        operand.set(v);
                        effects.push(`SETcc → ${v}`);
                        break;
                    }
                    // === SHRD r/m, reg, imm8 ===
                    case 0xAC: {
                        const { operand, reg } = this.decodeModRM(true, is32);
                        const count = this.fetchByte() & 0x1F;
                        if (count > 0) {
                            if (is32) {
                                const regVal = this.getReg32(reg) >>> 0;
                                const rmVal = operand.val >>> 0;
                                const result = ((rmVal >>> count) | (regVal << (32 - count))) >>> 0;
                                this.cf = (rmVal >>> (count - 1)) & 1;
                                operand.set(result);
                                effects.push(`SHRD → ${hex(result,8)}`);
                            } else {
                                const regVal = this.getReg16(reg);
                                const rmVal = operand.val;
                                const combined = (regVal << 16) | rmVal;
                                const result = (combined >>> count) & 0xFFFF;
                                this.cf = (rmVal >>> (count - 1)) & 1;
                                operand.set(result);
                                effects.push(`SHRD → ${hex(result,4)}`);
                            }
                        }
                        break;
                    }
                    // === MOVZX ===
                    case 0xB6: { // MOVZX reg16/32, r/m8
                        const { operand, reg } = this.decodeModRM(false, false);
                        if (is32) {
                            this.setReg32(reg, operand.val & 0xFF);
                            effects.push(`${CPU.regName32[reg]}=${hex(operand.val & 0xFF,8)}`);
                        } else {
                            this.setReg16(reg, operand.val & 0xFF);
                            effects.push(`${CPU.regName16[reg]}=${hex(operand.val & 0xFF,4)}`);
                        }
                        break;
                    }
                    case 0xB7: { // MOVZX reg32, r/m16
                        const { operand, reg } = this.decodeModRM(true, false);
                        this.setReg32(reg, operand.val & 0xFFFF);
                        effects.push(`${CPU.regName32[reg]}=${hex(operand.val & 0xFFFF,8)}`);
                        break;
                    }
                    default:
                        this._unimpl(0x0F, `0F ${hex(op2,2)}`);
                }
                break;
            }

            // === 1E PUSH DS ===
            case 0x1E: {
                this.push16(this.ds);
                effects.push(`PUSH DS`);
                break;
            }
            // === 1F POP DS ===
            case 0x1F: {
                this.ds = this.pop16();
                effects.push(`DS=${hex(this.ds,4)}`);
                break;
            }
            // === 06 PUSH ES ===
            case 0x06: {
                this.push16(this.es);
                effects.push(`PUSH ES`);
                break;
            }
            // === 07 POP ES ===
            case 0x07: {
                this.es = this.pop16();
                effects.push(`ES=${hex(this.es,4)}`);
                break;
            }

            // === 8BEC = MOV BP, SP (covered by 8B) ===
            // Already handled in MOV reg, r/m

            default:
                this._unimpl(opcode);
        }

        // Build trace line
        if (this.traceEnabled) {
            const endIP = this.ip;
            const instrLen = ((endIP - startIP + 0x10000) & 0xFFFF);
            let hexBytes = "";
            for (let i = 0; i < instrLen && i < 12; i++) {
                hexBytes += hex(this.readByte(startCS, (startIP + i) & 0xFFFF), 2);
            }
            const line = `${hex(startCS,4)}:${hex(startIP,4)}  ${hexBytes.padEnd(24)} ; ${effects.join(" | ")}`;
            this.trace.push(line);
        }

        this.cycleCount++;
        if (this.maxCycles > 0 && this.cycleCount >= this.maxCycles) {
            this.halted = true;
        }

        return !this.halted;
    }

    _testCC(cc) {
        switch (cc) {
            case 0x0: return this.of === 1;  // O
            case 0x1: return this.of === 0;  // NO
            case 0x2: return this.cf === 1;  // B/C
            case 0x3: return this.cf === 0;  // NB/NC
            case 0x4: return this.zf === 1;  // Z/E
            case 0x5: return this.zf === 0;  // NZ/NE
            case 0x6: return this.cf === 1 || this.zf === 1;  // BE
            case 0x7: return this.cf === 0 && this.zf === 0;  // A
            case 0x8: return this.sf === 1;  // S
            case 0x9: return this.sf === 0;  // NS
            case 0xA: return false; // P (not tracked)
            case 0xB: return false; // NP
            case 0xC: return this.sf !== this.of;  // L
            case 0xD: return this.sf === this.of;  // GE
            case 0xE: return this.zf === 1 || this.sf !== this.of;  // LE
            case 0xF: return this.zf === 0 && this.sf === this.of;  // G
        }
    }

    _unimpl(op, extra) {
        const msg = `Unimplemented opcode ${hex(op,2)}${extra ? ` (${extra})` : ""} at ${hex(this.cs,4)}:${hex(this.ip - 1,4)}`;
        console.error(msg);
        this.trace.push(`!!! ${msg}`);
        this.halted = true;
    }

    // === Run N steps or until halted ===
    // Set breakpoint at CS:IP offset. callback(cpu) called before execution.
    // If callback returns true, cpu halts. Address is code offset (IP value).
    addBreakpoint(ip, callback) {
        this.breakpoints.set(ip, callback);
    }

    removeBreakpoint(ip) {
        this.breakpoints.delete(ip);
    }

    // Watch memory writes at a linear address. callback(cpu, addr, val, size).
    // Returns true to halt.
    addWatchpoint(linearAddr, callback) {
        this.watchpoints.set(linearAddr & 0xFFFFF, callback);
    }

    // Convenience: watch a seg:off address
    watchMemory(seg, off, callback) {
        this.addWatchpoint(this.linear(seg, off), callback);
    }

    removeWatchpoint(linearAddr) {
        this.watchpoints.delete(linearAddr & 0xFFFFF);
    }

    run(maxSteps) {
        let n = 0;
        while (!this.halted && (maxSteps === undefined || n < maxSteps)) {
            // Check breakpoints before executing
            const bp = this.breakpoints.get(this.ip);
            if (bp && bp(this)) { this.halted = true; break; }
            this.step();
            n++;
        }
        return n;
    }

    // === Snapshot: save/load ===
    saveSnapshot(path) {
        // Format: 32 bytes register header + 1MB memory
        const buf = Buffer.alloc(32 + 1048576);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        dv.setUint32(0, this.eax, true);
        dv.setUint32(4, this.ebx, true);
        dv.setUint32(8, this.ecx, true);
        dv.setUint32(12, this.edx, true);
        dv.setUint16(16, this.si, true);
        dv.setUint16(18, this.di, true);
        dv.setUint16(20, this.bp, true);
        dv.setUint16(22, this.sp, true);
        dv.setUint16(24, this.cs, true);
        dv.setUint16(26, this.ds, true);
        // Pack segment regs + IP + flags into remaining space
        const flags = (this.cf) | (this.zf << 1) | (this.sf << 2) | (this.of << 3) | (this.df << 4);
        // Extended header at offset 28
        dv.setUint16(28, this.ip, true);
        dv.setUint16(30, flags, true);
        buf.set(this.mem, 32);
        // Additional segment registers after main buffer
        const extBuf = Buffer.alloc(8);
        const edv = new DataView(extBuf.buffer);
        edv.setUint16(0, this.es, true);
        edv.setUint16(2, this.ss, true);
        edv.setUint16(4, this.fs, true);
        edv.setUint16(6, this.gs, true);
        const final = Buffer.concat([buf, extBuf]);
        fs.writeFileSync(path, final);
    }

    loadSnapshot(path) {
        const data = fs.readFileSync(path);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.eax = dv.getUint32(0, true);
        this.ebx = dv.getUint32(4, true);
        this.ecx = dv.getUint32(8, true);
        this.edx = dv.getUint32(12, true);
        this.si = dv.getUint16(16, true);
        this.di = dv.getUint16(18, true);
        this.bp = dv.getUint16(20, true);
        this.sp = dv.getUint16(22, true);
        this.cs = dv.getUint16(24, true);
        this.ds = dv.getUint16(26, true);
        this.ip = dv.getUint16(28, true);
        const flags = dv.getUint16(30, true);
        this.cf = flags & 1;
        this.zf = (flags >> 1) & 1;
        this.sf = (flags >> 2) & 1;
        this.of = (flags >> 3) & 1;
        this.df = (flags >> 4) & 1;
        this.mem.set(new Uint8Array(data.buffer, data.byteOffset + 32, 1048576));
        if (data.byteLength >= 32 + 1048576 + 8) {
            this.es = dv.getUint16(32 + 1048576, true);
            this.ss = dv.getUint16(32 + 1048576 + 2, true);
            this.fs = dv.getUint16(32 + 1048576 + 4, true);
            this.gs = dv.getUint16(32 + 1048576 + 6, true);
        }
        this.halted = false;
    }
}

// === MZ Loader ===
function loadMZ(cpu, path) {
    const data = fs.readFileSync(path);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    if (dv.getUint16(0, true) !== 0x5A4D) throw new Error("Not MZ");

    const lastPageSize = dv.getUint16(2, true);
    const pages = dv.getUint16(4, true);
    const numRelocs = dv.getUint16(6, true);
    const headerParas = dv.getUint16(8, true);
    const minAlloc = dv.getUint16(10, true);
    const initSS = dv.getUint16(14, true);
    const initSP = dv.getUint16(16, true);
    const initIP = dv.getUint16(20, true);
    const initCS = dv.getUint16(22, true);
    const relocOff = dv.getUint16(24, true);

    const headerBytes = headerParas * 16;
    const imageSize = (pages - 1) * 512 + (lastPageSize || 512) - headerBytes;

    // Load segment — place code at paragraph boundary
    const loadSeg = 0x0100; // arbitrary, but room for PSP etc.
    const loadAddr = loadSeg * 16;

    // Copy image to memory
    for (let i = 0; i < imageSize && i < data.byteLength - headerBytes; i++) {
        cpu.mem[loadAddr + i] = data[headerBytes + i];
    }

    // Apply relocations
    for (let i = 0; i < numRelocs; i++) {
        const off = dv.getUint16(relocOff + i * 4, true);
        const seg = dv.getUint16(relocOff + i * 4 + 2, true);
        const addr = loadAddr + seg * 16 + off;
        const val = cpu.mem[addr] | (cpu.mem[addr + 1] << 8);
        const relocated = (val + loadSeg) & 0xFFFF;
        cpu.mem[addr] = relocated & 0xFF;
        cpu.mem[addr + 1] = (relocated >> 8) & 0xFF;
    }

    // Set registers
    cpu.cs = (loadSeg + initCS) & 0xFFFF;
    cpu.ip = initIP;
    cpu.ss = (loadSeg + initSS) & 0xFFFF;
    cpu.sp = initSP;
    // DS/ES initially point to PSP (we skip PSP, just set to load seg for now)
    // The binary sets DS itself via MOV AX, seg; MOV DS, AX
    cpu.ds = loadSeg;
    cpu.es = loadSeg;

    return { loadSeg, imageSize };
}

// === Helpers ===
function hex(v, digits) {
    if (v < 0) v = v + (1 << (digits * 4));
    return (v >>> 0).toString(16).toUpperCase().padStart(digits, "0");
}

// === CLI ===
function main() {
    const args = process.argv.slice(2);
    const cpu = new CPU();

    let mode = "run"; // run | step | snapshot
    let steps = undefined;
    let snapIn = null, snapOut = null;
    let exePath = null;
    let traceFile = null;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--exe": exePath = args[++i]; break;
            case "--steps": steps = parseInt(args[++i]); break;
            case "--snap-in": snapIn = args[++i]; break;
            case "--snap-out": snapOut = args[++i]; break;
            case "--trace": traceFile = args[++i]; break;
            case "--no-trace": cpu.traceEnabled = false; break;
            case "--seed": cpu.timerTicks = parseInt(args[++i]); break;
            case "--key": cpu.keyBuffer.push(parseInt(args[++i])); break;
            case "--mouse-dx": cpu.mouseDX = parseInt(args[++i]); break;
            case "--mouse-dy": cpu.mouseDY = parseInt(args[++i]); break;
            case "--no-mouse": cpu.mousePresent = false; break;
            case "--break": {
                const addr = parseInt(args[++i]);
                cpu.addBreakpoint(addr, () => true);
                break;
            }
            case "--watch": {
                const waddr = parseInt(args[++i]);
                cpu.addWatchpoint(waddr, (c, addr, val, size) => {
                    console.error(`WATCH ${hex(addr,5)}: ${size === 1 ? hex(val,2) : (size === 2 ? hex(val,4) : hex(val,8))} @ ${hex(c.cs,4)}:${hex(c.ip,4)}`);
                    return false;
                });
                break;
            }
            case "--watch-break": {
                const wbaddr = parseInt(args[++i]);
                cpu.addWatchpoint(wbaddr, (c, addr, val, size) => {
                    console.error(`WATCH-BREAK ${hex(addr,5)}: ${size === 1 ? hex(val,2) : (size === 2 ? hex(val,4) : hex(val,8))} @ ${hex(c.cs,4)}:${hex(c.ip,4)}`);
                    return true;
                });
                break;
            }
            case "--watch-seg": case "--watch-break-seg": {
                const brk = args[i] === "--watch-break-seg";
                const parts = args[++i].toUpperCase().split(":");
                const segName = parts[0];
                const off = parseInt("0x" + parts[1]);
                // Defer resolution until after snapshot/exe loaded
                cpu._deferredWatches = cpu._deferredWatches || [];
                cpu._deferredWatches.push({ segName, off, brk });
                break;
            }
            case "--help":
                console.log(`emu86.js — mars.exe emulator
Usage:
  --exe <path>       Load MZ executable
  --snap-in <path>   Load state snapshot
  --snap-out <path>  Save state after execution
  --steps <N>        Execute N instructions (default: run until halt)
  --trace <path>     Write trace to file (default: stdout)
  --no-trace         Disable trace output
  --seed <N>         Set timer seed (INT 1Ah)
  --key <scancode>   Push key to buffer
  --mouse-dx <N>     Set mouse delta X
  --mouse-dy <N>     Set mouse delta Y
  --no-mouse         Disable mouse
  --break <IP>       Break at code offset (hex: 0x0A1F)
  --watch <addr>     Log writes to linear address (hex, e.g. 0x27AA)
  --watch-break <a>  Break on write to linear address (hex)
  --watch-seg <s:o>  Log writes to seg:off address (hex, e.g. DS:07AA)
  --watch-break-seg <s:o>  Break on write to seg:off address

Trace format:
  SSSS:OOOO  HEXBYTES             ; register/memory effects`);
                return;
            default:
                console.error(`Unknown arg: ${args[i]}`);
                process.exit(1);
        }
    }

    if (snapIn) {
        cpu.loadSnapshot(snapIn);
    } else if (exePath) {
        const info = loadMZ(cpu, exePath);
        console.error(`Loaded ${exePath}: loadSeg=${hex(info.loadSeg,4)}, ${info.imageSize} bytes, CS:IP=${hex(cpu.cs,4)}:${hex(cpu.ip,4)}`);
    } else {
        console.error("Need --exe or --snap-in");
        process.exit(1);
    }

    // Resolve deferred seg:off watchpoints now that segments are known
    if (cpu._deferredWatches) {
        const segMap = { CS: cpu.cs, DS: cpu.ds, ES: cpu.es, SS: cpu.ss, FS: cpu.fs, GS: cpu.gs };
        for (const w of cpu._deferredWatches) {
            const seg = segMap[w.segName];
            if (seg === undefined) { console.error(`Unknown segment: ${w.segName}`); process.exit(1); }
            const linear = cpu.linear(seg, w.off);
            cpu.addWatchpoint(linear, (c, addr, val, size) => {
                const vStr = size === 1 ? hex(val,2) : (size === 2 ? hex(val,4) : hex(val,8));
                console.error(`WATCH${w.brk ? '-BREAK' : ''} ${w.segName}:${hex(w.off,4)} [${hex(addr,5)}]: ${vStr} @ ${hex(c.cs,4)}:${hex(c.ip,4)}`);
                return w.brk;
            });
        }
    }

    const n = cpu.run(steps);
    console.error(`Executed ${n} instructions, halted=${cpu.halted}`);
    if (cpu.halted) {
        console.error(`Regs: AX=${hex(cpu.ax,4)} BX=${hex(cpu.bx,4)} CX=${hex(cpu.cx,4)} DX=${hex(cpu.dx,4)} SI=${hex(cpu.si,4)} DI=${hex(cpu.di,4)} BP=${hex(cpu.bp,4)} SP=${hex(cpu.sp,4)}`);
        console.error(`      EAX=${hex(cpu.eax,8)} EBX=${hex(cpu.ebx,8)} ECX=${hex(cpu.ecx,8)} EDX=${hex(cpu.edx,8)}`);
        console.error(`      CS=${hex(cpu.cs,4)} DS=${hex(cpu.ds,4)} ES=${hex(cpu.es,4)} FS=${hex(cpu.fs,4)} GS=${hex(cpu.gs,4)} IP=${hex(cpu.ip,4)} CF=${cpu.cf} ZF=${cpu.zf} SF=${cpu.sf}`);
    }

    if (cpu.traceEnabled) {
        const traceText = cpu.trace.join("\n") + "\n";
        if (traceFile) {
            fs.writeFileSync(traceFile, traceText);
            console.error(`Trace written to ${traceFile}`);
        } else {
            process.stdout.write(traceText);
        }
    }

    if (snapOut) {
        cpu.saveSnapshot(snapOut);
        console.error(`Snapshot saved to ${snapOut}`);
    }
}

// Export for use as module
module.exports = { CPU, loadMZ, hex };

if (require.main === module) {
    main();
}
