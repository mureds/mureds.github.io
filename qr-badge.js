/* qr-badge.js — shared across mureds.github.io sites.
 * Adds a small bottom-right button that shows a QR code of the current page,
 * so viewers can open it on a phone during a talk or from a printed poster.
 *
 * Usage:  <script defer src="/qr-badge.js"></script>
 * Opt-out of the auto badge: <script defer src="/qr-badge.js" data-auto="off"></script>
 * Manual:  QRBadge.svg("https://example.com", "H", 8, 4)  ->  SVG string
 *
 * Self-contained: no external requests, nothing is sent anywhere.
 * QR encoder implements ISO/IEC 18004 byte mode, versions 1-40.
 */
(function () {
  'use strict';

  // ---------- QR encoder ----------
  const ECC_CW = {
    L: [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    M: [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    Q: [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    H: [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  };
  const NUM_BLOCKS = {
    L: [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    M: [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    Q: [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    H: [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
  };
  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    const r = new Uint8Array(degree); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = new Uint8Array(div.length);
    for (const b of data) {
      const factor = b ^ r[0];
      r.copyWithin(0, 1); r[r.length - 1] = 0;
      for (let i = 0; i < div.length; i++) r[i] ^= gfMul(div[i], factor);
    }
    return r;
  }
  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const a = Math.floor(ver / 7) + 2;
      n -= (25 * a - 10) * a - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = (ver, ecl) =>
    Math.floor(rawModules(ver) / 8) - ECC_CW[ecl][ver] * NUM_BLOCKS[ecl][ver];

  function QRCode(version, ecl, codewords) {
    this.version = version; this.ecl = ecl;
    const size = this.size = version * 4 + 17;
    this.modules = []; this.isFunction = [];
    for (let y = 0; y < size; y++) {
      this.modules.push(new Array(size).fill(false));
      this.isFunction.push(new Array(size).fill(false));
    }
    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(codewords));
    let best = 0, min = Infinity;
    for (let m = 0; m < 8; m++) {
      this.applyMask(m); this.drawFormatBits(m);
      const p = this.penalty();
      if (p < min) { min = p; best = m; }
      this.applyMask(m);
    }
    this.mask = best;
    this.applyMask(best); this.drawFormatBits(best);
  }
  const P = QRCode.prototype;
  P.get = function (x, y) { return this.modules[y][x]; };
  P.setFn = function (x, y, dark) { this.modules[y][x] = dark; this.isFunction[y][x] = true; };

  P.drawFunctionPatterns = function () {
    const size = this.size;
    for (let i = 0; i < size; i++) { this.setFn(6, i, i % 2 === 0); this.setFn(i, 6, i % 2 === 0); }
    this.finder(3, 3); this.finder(size - 4, 3); this.finder(3, size - 4);
    const pos = this.alignPositions(), n = pos.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        this.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };
  P.finder = function (x, y) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, d !== 2 && d !== 4);
    }
  };
  P.alignPositions = function () {
    const v = this.version;
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2;
    const step = (v === 32) ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = v * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  };
  P.drawFormatBits = function (mask) {
    const size = this.size, data = (FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412, bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(i));
    this.setFn(8, 7, bit(6)); this.setFn(8, 8, bit(7)); this.setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFn(8, size - 15 + i, bit(i));
    this.setFn(8, size - 8, true);
  };
  P.drawVersion = function () {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) !== 0, a = this.size - 11 + (i % 3), c = Math.floor(i / 3);
      this.setFn(a, c, b); this.setFn(c, a, b);
    }
  };
  P.addEccAndInterleave = function (data) {
    const ver = this.version, ecl = this.ecl;
    const numBlocks = NUM_BLOCKS[ecl][ver], eccLen = ECC_CW[ecl][ver];
    const raw = Math.floor(rawModules(ver) / 8);
    const numShort = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks);
    const blocks = [], div = rsDivisor(eccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div), blk = dat.slice();
      if (i < numShort) blk.push(0);
      blocks.push(blk.concat(Array.from(ecc)));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++)
      for (let j = 0; j < blocks.length; j++)
        if (i !== shortLen - eccLen || j >= numShort) out.push(blocks[j][i]);
    return out;
  };
  P.drawCodewords = function (data) {
    const size = this.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  };
  P.applyMask = function (mask) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (this.isFunction[y][x]) continue;
      let inv;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        case 7: inv = (((x + y) % 2) + (x * y) % 3) % 2 === 0; break;
      }
      if (inv) this.modules[y][x] = !this.modules[y][x];
    }
  };
  P.penalty = function () {
    const size = this.size, N1 = 3, N2 = 3, N3 = 40, N4 = 10, mod = this.modules;
    let result = 0;
    const count = (h) => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };
    const add = (len, h) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
    const term = (color, len, h) => { if (color) { add(len, h); len = 0; } add(len + size, h); return count(h); };
    for (let y = 0; y < size; y++) {
      let color = false, run = 0; const h = [0,0,0,0,0,0,0];
      for (let x = 0; x < size; x++) {
        if (mod[y][x] === color) { run++; if (run === 5) result += N1; else if (run > 5) result++; }
        else { add(run, h); if (!color) result += count(h) * N3; color = mod[y][x]; run = 1; }
      }
      result += term(color, run, h) * N3;
    }
    for (let x = 0; x < size; x++) {
      let color = false, run = 0; const h = [0,0,0,0,0,0,0];
      for (let y = 0; y < size; y++) {
        if (mod[y][x] === color) { run++; if (run === 5) result += N1; else if (run > 5) result++; }
        else { add(run, h); if (!color) result += count(h) * N3; color = mod[y][x]; run = 1; }
      }
      result += term(color, run, h) * N3;
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x+1] && c === mod[y+1][x] && c === mod[y+1][x+1]) result += N2;
    }
    let dark = 0;
    for (const row of mod) for (const c of row) if (c) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * N4;
    return result;
  };

  function encode(text, ecl) {
    ecl = ecl || 'H';
    const bytes = new TextEncoder().encode(text);
    let version = 0, cap = 0;
    for (let v = 1; v <= 40; v++) {
      const c = dataCodewords(v, ecl) * 8, lenBits = v <= 9 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= c) { version = v; cap = c; break; }
    }
    if (!version) throw new Error('data too long for a QR code');
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, cap - bits.length));
    push(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      cw.push(b);
    }
    return new QRCode(version, ecl, cw);
  }

  function toSVG(text, ecl, scale, margin) {
    const qr = encode(text, ecl || 'H');
    scale = scale || 8; margin = margin == null ? 4 : margin;
    const dim = (qr.size + margin * 2) * scale;
    let d = '';
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++)
        if (qr.get(x, y)) d += `M${(x + margin) * scale},${(y + margin) * scale}h${scale}v${scale}h-${scale}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
      + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  // ---------- Badge UI ----------
  function pageURL() {
    // Canonical page link: drop query/hash so the QR stays stable and short.
    return location.origin + location.pathname;
  }

  function mount() {
    if (document.getElementById('qr-badge-btn')) return;
    const url = pageURL();
    let thumb;
    try { thumb = toSVG(url, 'H', 4, 2); } catch (e) { return; }

    const css = document.createElement('style');
    css.textContent = `
      #qr-badge-btn{position:fixed;right:14px;bottom:14px;z-index:2147483000;
        width:52px;height:52px;padding:5px;border:none;border-radius:10px;background:#fff;
        box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;line-height:0;transition:transform .12s}
      #qr-badge-btn:hover{transform:scale(1.07)}
      /* On narrow screens a full-width footer/legend can sit at the bottom edge,
         so lift the badge clear of it. */
      @media (max-width:900px){#qr-badge-btn{width:44px;height:44px;bottom:76px}}
      #qr-badge-btn svg{width:100%;height:100%;display:block}
      #qr-badge-modal{position:fixed;inset:0;z-index:2147483001;display:none;
        align-items:center;justify-content:center;background:rgba(0,0,0,.62);
        font:14px/1.5 system-ui,"Segoe UI","Noto Sans KR",sans-serif}
      #qr-badge-modal.open{display:flex}
      #qr-badge-card{background:#fff;color:#111;border-radius:16px;padding:22px;text-align:center;
        max-width:min(88vw,360px);box-shadow:0 10px 40px rgba(0,0,0,.5)}
      #qr-badge-card svg{width:min(70vw,260px);height:auto;display:block;margin:0 auto}
      #qr-badge-card .u{margin:12px 0 0;font-size:12.5px;color:#444;word-break:break-all}
      #qr-badge-card .t{margin:0 0 12px;font-size:13px;color:#666}
      #qr-badge-close{margin-top:14px;border:1px solid #ccc;background:#f5f5f5;color:#111;
        border-radius:8px;padding:7px 16px;cursor:pointer;font-size:13px}
      @media print{#qr-badge-btn,#qr-badge-modal{display:none!important}}
    `;
    document.head.appendChild(css);

    const btn = document.createElement('button');
    btn.id = 'qr-badge-btn';
    btn.type = 'button';
    btn.title = '이 페이지 QR 코드 — 휴대폰으로 열기';
    btn.setAttribute('aria-label', '이 페이지 QR 코드 보기');
    btn.innerHTML = thumb;

    const modal = document.createElement('div');
    modal.id = 'qr-badge-modal';
    modal.innerHTML = `<div id="qr-badge-card">
        <p class="t">휴대폰 카메라로 스캔하세요</p>
        ${toSVG(url, 'H', 8, 4)}
        <p class="u">${url.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</p>
        <button id="qr-badge-close" type="button">닫기</button>
      </div>`;

    const open = () => modal.classList.add('open');
    const close = () => modal.classList.remove('open');
    btn.addEventListener('click', open);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#qr-badge-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    document.body.appendChild(btn);
    document.body.appendChild(modal);
  }

  window.QRBadge = { svg: toSVG, encode, mount };

  const self = document.currentScript;
  if (!self || self.dataset.auto !== 'off') {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})();
