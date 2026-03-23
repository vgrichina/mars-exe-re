"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// Cross-reference map: EXE offset → JS anchor & vice versa
// ═══════════════════════════════════════════════════════════════════════════
const XREFS = [
  { exe: '0x200', js: 'entry',         exeLabel: 'entry point',       jsLabel: 'Entry / init' },
  { exe: '0x224', js: 'palette',       exeLabel: 'set VGA palette',   jsLabel: 'PAL6[]' },
  { exe: '0x2A5', js: 'mainloop',      exeLabel: 'main loop',         jsLabel: 'Init calls' },
  { exe: '0x2F3', js: 'genColormap',   exeLabel: 'gen_colormap',      jsLabel: 'genColormap()' },
  { exe: '0x353', js: 'genHeightmap',  exeLabel: 'gen_heightmap',     jsLabel: 'genHeightmap()' },
  { exe: '0x419', js: 'subdivide',     exeLabel: 'subdivide',         jsLabel: 'subdivide()' },
  { exe: '0x608', js: 'input',         exeLabel: 'handle_input',      jsLabel: 'Input handlers' },
  { exe: '0x659', js: 'render',        exeLabel: 'render_columns',    jsLabel: 'render() Pass 1' },
  { exe: '0x6DA', js: 'unrolled',      exeLabel: 'unrolled MOVSB',    jsLabel: 'DDA floor loop' },
  { exe: '0xBDC', js: 'sky',           exeLabel: 'fill_sky',          jsLabel: 'Sky gradient' },
  { exe: '0xC1F', js: 'raymarch',      exeLabel: 'ray_march',         jsLabel: 'render() Pass 2' },
  { exe: '0xD3A', js: 'gouraud',       exeLabel: 'dispatch draw',     jsLabel: 'Gouraud fill' },
  { exe: '0x125C',js: 'cameraHeight',  exeLabel: 'camera_height',     jsLabel: 'cameraHeight()' },
  { exe: '0x12C0',js: 'jumptable',     exeLabel: 'jump table',        jsLabel: 'Jump table data' },
  { exe: '0x1450',js: 'stepTable',     exeLabel: 'step table',        jsLabel: 'stepTable[]' },
  { exe: '0x14CA',js: 'PAL6',          exeLabel: 'palette data',      jsLabel: 'PAL6[]' },
];

// Map from JS function/identifier to line ranges in mars.js (1-indexed)
const JS_ANCHORS = {
  'PAL6':          { start: 6,   end: 20 },
  'stepTable':     { start: 23,  end: 28 },
  'entry':         { start: 33,  end: 38 },
  'palette':       { start: 6,   end: 20 },
  'mainloop':      { start: 352, end: 360 },
  'genColormap':   { start: 131, end: 144 },
  'genHeightmap':  { start: 146, end: 173 },
  'subdivide':     { start: 61,  end: 129 },
  'input':         { start: 1,   end: 1 },  // in index.html, not mars.js
  'render':        { start: 211, end: 257 },
  'unrolled':      { start: 226, end: 246 },
  'sky':           { start: 249, end: 257 },
  'raymarch':      { start: 259, end: 349 },
  'gouraud':       { start: 329, end: 338 },
  'cameraHeight':  { start: 179, end: 208 },
  'jumptable':     { start: 23,  end: 28 },
};

// EXE offsets → line numbers in mars_annotated.txt (approximate, populated on load)
const EXE_LINE_MAP = {};

// ═══════════════════════════════════════════════════════════════════════════
// Source loading & rendering
// ═══════════════════════════════════════════════════════════════════════════

async function loadSources() {
  const [exeText, jsText] = await Promise.all([
    fetch('mars_annotated.txt').then(r => r.text()),
    fetch('mars.js').then(r => r.text()),
  ]);

  renderExeSource(exeText);
  renderJsSource(jsText);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Find line numbers for each EXE offset anchor
function buildExeLineMap(lines) {
  for (const xref of XREFS) {
    const offsetStr = xref.exe.replace('0x', '').toLowerCase().padStart(8, '0');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(offsetStr + ':') || lines[i].includes('; ' + xref.exeLabel) ||
          lines[i].includes('file ' + xref.exe + ')') || lines[i].includes('(file ' + xref.exe)) {
        EXE_LINE_MAP[xref.exe] = i + 1;
        break;
      }
    }
    // Fallback: search for the offset at line start
    if (!EXE_LINE_MAP[xref.exe]) {
      const short = xref.exe.replace('0x', '').toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].replace(/^0+/, '');
        if (trimmed.startsWith(short + ':') || trimmed.startsWith(short.padStart(8,'0') + ':')) {
          EXE_LINE_MAP[xref.exe] = i + 1;
          break;
        }
      }
    }
  }
}

function highlightExeLine(text) {
  if (text.startsWith('; ==')) return '<span class="lbl">' + escapeHtml(text) + '</span>';

  // Split on first semicolon to separate code from comment
  const semiIdx = text.indexOf(';');
  const codePart = semiIdx >= 0 ? text.slice(0, semiIdx) : text;
  const cmtPart = semiIdx >= 0 ? text.slice(semiIdx) : '';

  const REGS = /^(ax|bx|cx|dx|si|di|bp|sp|al|ah|bl|bh|cl|ch|dl|dh|cs|ds|es|fs|gs|ss|eax|ebx|ecx|edx|esi|edi|ebp|esp)$/i;
  const MNEMONICS = /^(mov|add|sub|mul|div|imul|idiv|xor|and|or|not|shr|shl|sar|sal|ror|rol|push|pop|call|ret|jmp|jnz|jz|jnc|jc|jge|jle|jg|jl|cmp|test|int|rep|stosd|stosw|stosb|movsb|movsd|outsb|inc|dec|setz|cld|cli|sti|out|cbw|cwd|adc|sbb|loop|lodsb|lodsw)$/i;

  function highlightCode(s) {
    const tokens = [];
    let i = 0;
    // Hex address at start
    const addrMatch = s.match(/^([0-9a-f]{8}:)/);
    if (addrMatch) {
      tokens.push({ type: 'hex', text: addrMatch[1] });
      i = addrMatch[1].length;
    }
    while (i < s.length) {
      if (/[a-zA-Z_]/.test(s[i])) {
        let j = i;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        const w = s.slice(i, j);
        if (MNEMONICS.test(w)) tokens.push({ type: 'kw', text: w });
        else if (REGS.test(w)) tokens.push({ type: 'reg', text: w });
        else tokens.push({ type: '', text: w });
        i = j;
      } else if (/[0-9]/.test(s[i])) {
        let j = i;
        while (j < s.length && /[0-9a-fA-Fx]/.test(s[j])) j++;
        tokens.push({ type: 'num', text: s.slice(i, j) });
        i = j;
      } else {
        let j = i;
        while (j < s.length && !/[a-zA-Z_0-9]/.test(s[j])) j++;
        if (j === i) j = i + 1;
        tokens.push({ type: '', text: s.slice(i, j) });
        i = j;
      }
    }
    return tokens.map(t => {
      const escaped = escapeHtml(t.text);
      return t.type ? `<span class="${t.type}">${escaped}</span>` : escaped;
    }).join('');
  }

  let result = highlightCode(codePart);
  if (cmtPart) result += '<span class="cmt">' + escapeHtml(cmtPart) + '</span>';
  return result;
}

function highlightJsLine(text) {
  // Tokenize first, then render — avoids regex matching inside already-inserted tags
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    // Comment
    if (text[i] === '/' && text[i+1] === '/') {
      tokens.push({ type: 'cmt', text: text.slice(i) });
      i = text.length;
    }
    // String
    else if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== q) { if (text[j] === '\\') j++; j++; }
      tokens.push({ type: 'str', text: text.slice(i, j + 1) });
      i = j + 1;
    }
    // Word
    else if (/[a-zA-Z_$]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_$]/.test(text[j])) j++;
      const w = text.slice(i, j);
      if (/^(const|let|var|function|return|if|else|for|while|new|typeof|module|exports)$/.test(w))
        tokens.push({ type: 'kw', text: w });
      else if (/^(createMars|prng|perturb|subdivide|genColormap|genHeightmap|cameraHeight|render|bufSum)$/.test(w))
        tokens.push({ type: 'fn', text: w });
      else
        tokens.push({ type: '', text: w });
      i = j;
    }
    // Number (0x... or digits)
    else if (/[0-9]/.test(text[i])) {
      let j = i;
      if (text[i] === '0' && text[i+1] === 'x') { j += 2; while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++; }
      else { while (j < text.length && /[0-9]/.test(text[j])) j++; }
      tokens.push({ type: 'num', text: text.slice(i, j) });
      i = j;
    }
    else {
      // Plain char
      let j = i;
      while (j < text.length && !/[a-zA-Z_$0-9"'/]/.test(text[j])) j++;
      if (j === i) j = i + 1;
      tokens.push({ type: '', text: text.slice(i, j) });
      i = j;
    }
  }
  return tokens.map(t => {
    const escaped = escapeHtml(t.text);
    return t.type ? `<span class="${t.type}">${escaped}</span>` : escaped;
  }).join('');
}

function renderExeSource(text) {
  const lines = text.split('\n');
  buildExeLineMap(lines);
  const container = document.getElementById('exe-source');
  const html = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const anchors = [];
    for (const xref of XREFS) {
      if (EXE_LINE_MAP[xref.exe] === lineNum) {
        anchors.push(`id="src-exe-${xref.exe}"`);
      }
    }
    const anchorAttr = anchors.length ? anchors[0] : '';

    // Add xref link if this line contains a function header
    let content = highlightExeLine(lines[i]);
    for (const xref of XREFS) {
      if (EXE_LINE_MAP[xref.exe] === lineNum) {
        content += ` <span class="xref-link" data-target="js-${xref.js}" title="Jump to ${xref.jsLabel} in mars.js">[&rarr; ${xref.jsLabel}]</span>`;
      }
    }

    html.push(`<div class="source-line" ${anchorAttr} data-line="${lineNum}"><span class="line-num">${lineNum}</span><span class="line-content">${content}</span></div>`);
  }

  container.innerHTML = html.join('');
}

function renderJsSource(text) {
  const lines = text.split('\n');
  const container = document.getElementById('js-source');
  const html = [];

  // Build reverse map: line → anchor id
  const lineAnchors = {};
  for (const xref of XREFS) {
    const anchor = JS_ANCHORS[xref.js];
    if (anchor) lineAnchors[anchor.start] = xref;
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let anchorAttr = '';
    let xrefHtml = '';
    for (const xref of XREFS) {
      const a = JS_ANCHORS[xref.js];
      if (a && a.start === lineNum) {
        anchorAttr = `id="src-js-${xref.js}"`;
        xrefHtml = ` <span class="xref-link" data-target="exe-${xref.exe}" title="Jump to ${xref.exeLabel} in hex dump">[&rarr; ${xref.exe} ${xref.exeLabel}]</span>`;
        break;
      }
    }

    const content = highlightJsLine(lines[i]) + xrefHtml;
    html.push(`<div class="source-line" ${anchorAttr} data-line="${lineNum}"><span class="line-num">${lineNum}</span><span class="line-content">${content}</span></div>`);
  }

  container.innerHTML = html.join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Cross-reference click handling
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('click', e => {
  const link = e.target.closest('.xref-link');
  if (!link) return;

  const target = link.dataset.target;
  if (!target) return;

  let el, panel;
  if (target.startsWith('js-')) {
    const key = target.slice(3);
    el = document.getElementById('src-js-' + key);
    panel = document.getElementById('js-source');
  } else if (target.startsWith('exe-')) {
    const offset = target.slice(4);
    el = document.getElementById('src-exe-' + offset);
    panel = document.getElementById('exe-source');
  }

  if (!el || !panel) return;

  // Remove old highlights
  document.querySelectorAll('.highlight-target').forEach(e => e.classList.remove('highlight-target'));

  // Highlight range
  el.classList.add('highlight-target');
  // Also highlight a few surrounding lines
  let sib = el;
  for (let i = 0; i < 8; i++) {
    sib = sib.nextElementSibling;
    if (sib) sib.classList.add('highlight-target');
  }

  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// Also handle table xref clicks
document.addEventListener('click', e => {
  const link = e.target.closest('a.xref');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || !href.startsWith('#src-')) return;
  e.preventDefault();

  const el = document.querySelector(href);
  if (!el) return;

  // Scroll section into view first
  document.getElementById('source').scrollIntoView({ behavior: 'smooth' });

  // Then scroll the panel
  setTimeout(() => {
    document.querySelectorAll('.highlight-target').forEach(e => e.classList.remove('highlight-target'));
    el.classList.add('highlight-target');
    let sib = el;
    for (let i = 0; i < 8; i++) {
      sib = sib.nextElementSibling;
      if (sib) sib.classList.add('highlight-target');
    }
    const panel = el.closest('.panel-body');
    if (panel) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 500);
});

// ═══════════════════════════════════════════════════════════════════════════
// Mars demo (hero + interactive)
// ═══════════════════════════════════════════════════════════════════════════

function setupDemo(canvas, initialSeed) {
  const mars = createMars(initialSeed);
  const ctx = canvas.getContext('2d');
  const SW = 320;

  const palette = new Uint32Array(256);
  for (let i = 0; i < 97; i++) {
    const r = (PAL6[i*3] << 2) | (PAL6[i*3] >> 4);
    const g = (PAL6[i*3+1] << 2) | (PAL6[i*3+1] >> 4);
    const b = (PAL6[i*3+2] << 2) | (PAL6[i*3+2] >> 4);
    palette[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
  }

  const imgData = ctx.createImageData(SW, H);
  const pixels = new Uint32Array(imgData.data.buffer);

  let posX = 1000, posY = 1000;
  let mouseDown = false, lastMX = 0, lastMY = 0;

  canvas.addEventListener('mousedown', e => { mouseDown = true; lastMX = e.clientX; lastMY = e.clientY; e.preventDefault(); });
  window.addEventListener('mouseup', () => mouseDown = false);
  window.addEventListener('mousemove', e => {
    if (!mouseDown) return;
    posX = (posX + (e.clientX - lastMX)) | 0;
    posY = (posY - (e.clientY - lastMY)) | 0;
    lastMX = e.clientX; lastMY = e.clientY;
  });
  canvas.addEventListener('touchstart', e => {
    const t = e.touches[0]; lastMX = t.clientX; lastMY = t.clientY; e.preventDefault();
  }, {passive:false});
  canvas.addEventListener('touchmove', e => {
    const t = e.touches[0];
    posX = (posX + (t.clientX - lastMX)) | 0;
    posY = (posY - (t.clientY - lastMY)) | 0;
    lastMX = t.clientX; lastMY = t.clientY;
    e.preventDefault();
  }, {passive:false});

  const keys = {};
  let recorder = null, recordedChunks = [];

  function getMimeType() {
    for (const t of ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  window.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (e.key === 'p' || e.key === 'P') {
      const c2 = document.createElement('canvas');
      c2.width = SW; c2.height = H;
      const ctx2 = c2.getContext('2d');
      ctx2.drawImage(canvas, 0, 0);
      const a = document.createElement('a');
      a.download = 'mars_screenshot.png';
      a.href = c2.toDataURL('image/png');
      a.click();
    }
    if (e.key === 'r' || e.key === 'R') {
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
      } else {
        const mime = getMimeType();
        if (!mime) { alert('Recording not supported in this browser'); return; }
        recordedChunks = [];
        const stream = canvas.captureStream(30);
        recorder = new MediaRecorder(stream, { mimeType: mime });
        recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        recorder.onstop = () => {
          const ext = mime.includes('mp4') ? 'mp4' : 'webm';
          const blob = new Blob(recordedChunks, { type: mime });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'mars_recording.' + ext;
          a.click();
          URL.revokeObjectURL(a.href);
        };
        recorder.start();
      }
    }
  });
  window.addEventListener('keyup', e => { keys[e.key] = false; });

  // Compass indicator pixels (matching binary)
  const compassPixels = [
    [199,310],[199,313],[199,314],[199,317],[199,318],[199,319],
    [198,310],[198,314],[198,317],
    [197,309],[197,310],[197,311],[197,313],[197,314],[197,315],[197,317],[197,318],[197,319]
  ];

  function frame() {
    if (keys['ArrowLeft'] || keys['a']) posX = (posX - 4) | 0;
    if (keys['ArrowRight'] || keys['d']) posX = (posX + 4) | 0;
    if (keys['ArrowUp'] || keys['w']) posY = (posY + 4) | 0;
    if (keys['ArrowDown'] || keys['s']) posY = (posY - 4) | 0;
    mars.render(posX, posY);

    // Blit to 320-wide screen (centered at cols 32-287)
    pixels.fill(0xFF000000);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        pixels[y * SW + x + 32] = palette[mars.renderBuf[y * W + x]];

    // Compass
    const cc = palette[0x60];
    for (const [y, x] of compassPixels) pixels[y * SW + x] = cc;

    ctx.putImageData(imgData, 0, 0);
    requestAnimationFrame(frame);
  }
  frame();

  return { setPos(x,y) { posX=x; posY=y; } };
}

// Single demo canvas in hero
const heroCanvas = document.getElementById('hero-canvas');
const seedInput = document.getElementById('seed-input');
const initialSeed = (Date.now() * 7) & 0x7FFF;
seedInput.value = initialSeed;
let heroDemo = setupDemo(heroCanvas, initialSeed);

document.getElementById('seed-btn').addEventListener('click', () => {
  const seed = parseInt(document.getElementById('seed-input').value) & 0x7FFF;
  heroCanvas.getContext('2d').clearRect(0, 0, heroCanvas.width, heroCanvas.height);
  heroDemo = setupDemo(heroCanvas, seed);
});

// Fullscreen toggle
const heroDemoEl = document.getElementById('demo');
function exitFullscreen() {
  heroDemoEl.classList.remove('fullscreen');
  document.body.classList.remove('is-fullscreen');
  document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function enterFullscreen() {
  heroDemoEl.classList.add('fullscreen');
  document.body.classList.add('is-fullscreen');
  document.body.style.overflow = 'hidden';
  if (heroDemoEl.requestFullscreen && window.innerWidth > 768) {
    heroDemoEl.requestFullscreen().catch(() => {});
  }
}
document.getElementById('fullscreen-btn').addEventListener('click', enterFullscreen);
document.getElementById('fullscreen-exit').addEventListener('click', exitFullscreen);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) exitFullscreen();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && heroDemoEl.classList.contains('fullscreen')) exitFullscreen();
});

// Load sources
loadSources();
