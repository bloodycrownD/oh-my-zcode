// OMZ 品牌资产生成器（一次性 + 可复用的再生成管线）。
/* eslint-disable max-lines -- 一次性资产再生成管线：几何构造、扫描线栅格化、PNG/ICO 编码与产物发射
   一体化便于整体拷贝复用，拆文件反而增加维护成本。 */
// 用途：把原 Z 字标替换为 OMZ 三字母字标，并生成 SVG / PNG / ICO 全套图标。
// 设计语言沿用原 Z 字标：笔画厚 32（字高 218）、笔画末端 0.95 斜切、对角斜率呼应 Z 对角线。
// 纯 Node 实现（zlib + 扫描线栅格化 + 4x 超采样），不引入 sharp 等新依赖。
// 用法：node scripts/generate-omz-brand-assets.mjs [输出目录]（默认写到仓库外的人工过目目录，
//       目标资产文件确认后再拷贝，脚本不直接覆盖仓库资产）。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "../.tools/brand-preview");
mkdirSync(outDir, { recursive: true });

// ---------- 几何参数（与原 Z 字标同源） ----------
const H = 218; // 字高
const T = 32; // 笔画厚
const CUT = 30.4; // 角切水平量（≈0.95*T，与 Z 笔画末端斜切一致）
const CUT_Y = 32; // 角切竖直量
const SLANT = 0.42; // M 斜笔水平斜率（dx/dy；Z 对角线为 0.706，M 受宽度限制取更陡）

// 原 Z 字标的三段 path（折线化后逐字沿用，保证新字标的 Z 与旧标志同形）
const Z_PATHS_D = [
  "M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z",
  "M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z",
  "M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z",
];

// ---------- 基础工具 ----------
// d 字符串极简解析（M/L/C/H/V/Z，C 用 8 段折线近似）→ 折线点集数组（每子路径一个）
function flattenD(d) {
  const polys = [];
  let cur = [];
  const re = /([MLCHVZ])([^MLCHVZ]*)/g;
  let cx = 0;
  let cy = 0;
  let m;
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const nums = m[2].trim().length ? m[2].trim().split(/[\s,]+/).map(Number) : [];
    if (cmd === "M") {
      if (cur.length) polys.push(cur);
      cur = [[nums[0], nums[1]]];
      cx = nums[0];
      cy = nums[1];
    } else if (cmd === "L") {
      cur.push([nums[0], nums[1]]);
      cx = nums[0];
      cy = nums[1];
    } else if (cmd === "H") {
      cx = nums[0];
      cur.push([cx, cy]);
    } else if (cmd === "V") {
      cy = nums[0];
      cur.push([cx, cy]);
    } else if (cmd === "C") {
      const [x1, y1, x2, y2, x3, y3] = nums;
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        const mt = 1 - t;
        cur.push([
          mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
          mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
        ]);
      }
      cx = x3;
      cy = y3;
    } else if (cmd === "Z") {
      if (cur.length) polys.push(cur);
      cur = [];
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}
const fmt = (n) => Math.round(n * 100) / 100;
function polyToD(points) {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p[0])} ${fmt(p[1])}`).join("") + "Z";
}
const shiftPoly = (points, dx) => points.map(([x, y]) => [x + dx, y]);

// ---------- 字母几何（全部以「点集」为唯一事实源，SVG 与栅格共用） ----------
// O：切角方环（外八边形 + 内八边形 evenodd 成环）。角切方向与 Z 笔画末端斜切一致。
function octagon(w, h, cutX, cutY) {
  return [
    [0, cutY],
    [cutX, 0],
    [w - cutX, 0],
    [w, cutY],
    [w, h - cutY],
    [w - cutX, h],
    [cutX, h],
    [0, h - cutY],
  ];
}
// 凸多边形向内缩进 t（各边沿线内移后求交，法向自动朝内）
function insetConvex(points, t) {
  const n = points.length;
  const centroid = points.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  const edges = points.map((p, i) => {
    const q = points[(i + 1) % n];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    let nx = -dy / len;
    let ny = dx / len;
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if ((centroid[0] - mid[0]) * nx + (centroid[1] - mid[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { p, nx, ny };
  });
  return edges.map((e, i) => {
    const f = edges[(i + n - 1) % n];
    const a1 = [f.p[0] + f.nx * t, f.p[1] + f.ny * t];
    const b1 = [e.p[0] + e.nx * t, e.p[1] + e.ny * t];
    const d1x = -f.ny;
    const d1y = f.nx;
    const d2x = -e.ny;
    const d2y = e.nx;
    const den = d1x * d2y - d1y * d2x;
    const s = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / den;
    return [a1[0] + d1x * s, a1[1] + d1y * s];
  });
}

const O_W = 176;
const oOuter = octagon(O_W, H, CUT, CUT_Y);
const oInner = insetConvex(oOuter, T);

// M：左右竖笔（各 32 宽）+ 两条平行四边形斜笔在底部会聚成尖（斜笔水平厚 48，与 Z 的粗对角线同一手法）。
const M_W = 256;
const M_STROKE = 48;
const mShift = SLANT * H; // 斜笔整高水平位移
const mPolys = [
  [
    [0, 0],
    [T, 0],
    [T, H],
    [0, H],
  ], // 左竖笔
  [
    [M_W - T, 0],
    [M_W, 0],
    [M_W, H],
    [M_W - T, H],
  ], // 右竖笔
  // 左斜笔：顶边 (T..T+M_STROKE)，整高右移 mShift
  [
    [T, 0],
    [T + M_STROKE, 0],
    [T + M_STROKE + mShift, H],
    [T + mShift, H],
  ],
  // 右斜笔（关于字轴镜像）
  [
    [M_W - T - M_STROKE, 0],
    [M_W - T, 0],
    [M_W - T - mShift, H],
    [M_W - T - M_STROKE - mShift, H],
  ],
];

const zPolys = Z_PATHS_D.map((d) => flattenD(d)[0]);

// ---------- 排版（O 176 + 间距 + M 256 + 间距 + Z 256） ----------
const GAP = 44;
const mX = O_W + GAP;
const zX = mX + M_W + GAP;
const WORDMARK_W = zX + 256;

// 组版后的折线集合；结构：[[O外环,O内环(evenodd 成环)], M×4, Z×3]
// 栅格化时除 O 环外逐子路径独立填充（M 斜笔交叠区用叠加覆盖而不是 even-odd，避免掏洞）
const oRing = [shiftPoly(oOuter, 0), shiftPoly(oInner, 0)];
const mPlaced = mPolys.map((p) => shiftPoly(p, mX));
const zPlaced = zPolys.map((p) => shiftPoly(p, zX));
const wordmarkShapesPolys = [oRing, ...mPlaced.map((p) => [p]), ...zPlaced.map((p) => [p])];

// path 数据（每字母一条 path；M 的交叠子路径在 nonzero 填充下自然并集）
const oD = polyToD(oRing[0]) + polyToD(oRing[1]);
const mD = mPlaced.map(polyToD).join("");
const zD = zPlaced.map(polyToD).join("");
const wordmarkViewBox = `0 0 ${WORDMARK_W} ${H}`;

// ---------- SVG 输出 ----------
function writeSvg(name, content) {
  writeFileSync(resolve(outDir, name), content + "\n", "utf8");
  console.log(`✓ ${name}`);
}

// 形态 A：字标本体（currentColor，三 path 便于逐笔动画，与旧 Z 的三 path 结构对齐）
writeSvg(
  "form-a-wordmark.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${wordmarkViewBox}" fill="none">\n` +
    `  <path fill="currentColor" fill-rule="evenodd" d="${oD}"/>\n` +
    `  <path fill="currentColor" d="${mD}"/>\n` +
    `  <path fill="currentColor" d="${zD}"/>\n` +
    `</svg>`,
);

// 形态 B：应用方标（沿用 logo-zai.svg 的深色圆角方 + 灰描边壳，内部换 OMZ 白色小字标），18×18 坐标系
const WM_IN_BOX = 14.4; // 字标在 18 宽方壳内的占宽（左右各留 1.8）
const boxScale = WM_IN_BOX / WORDMARK_W;
const wmBoxH = H * boxScale;
const wmBoxY = (18 - wmBoxH) / 2;
writeSvg(
  "form-b-app-logo.svg",
  `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">\n` +
    `  <path d="M2.91528 17.32C1.40918 17.32 0.183716 16.0946 0.183716 14.5885V2.91906C0.183716 1.41296 1.40918 0.1875 2.91528 0.1875H14.5847C16.0908 0.1875 17.3163 1.41296 17.3163 2.91906V14.5885C17.3163 16.0946 16.0908 17.32 14.5847 17.32H2.91528Z" fill="url(#omzBoxGrad)"/>\n` +
    `  <path d="M14.5847 0.367454C15.9918 0.367454 17.1325 1.50817 17.1325 2.91529V14.5847C17.1325 15.9918 15.9918 17.1325 14.5847 17.1325H2.91529C1.50817 17.1325 0.367454 15.9918 0.367454 14.5847V2.91529C0.367454 1.50817 1.50817 0.367454 2.91529 0.367454H14.5847ZM14.5847 0H2.91529C2.13652 0 1.40459 0.303149 0.853871 0.853871C0.303149 1.40459 0 2.13652 0 2.91529V14.5847C0 15.3635 0.303149 16.0954 0.853871 16.6461C1.40459 17.1969 2.13652 17.5 2.91529 17.5H14.5847C15.3635 17.5 16.0954 17.1969 16.6461 16.6461C17.1969 16.0954 17.5 15.3635 17.5 14.5847V2.91529C17.5 2.13652 17.1969 2.13652 16.6461 0.853871C16.0954 0.303149 15.3635 0 14.5847 0Z" fill="#B7BCBF"/>\n` +
    `  <g transform="translate(1.8 ${fmt(wmBoxY)}) scale(${fmt(boxScale)})" fill="white">\n` +
    `    <path fill-rule="evenodd" d="${oD}"/>\n` +
    `    <path d="${mD}"/>\n` +
    `    <path d="${zD}"/>\n` +
    `  </g>\n` +
    `  <defs>\n` +
    `    <linearGradient id="omzBoxGrad" x1="8.74999" y1="17.32" x2="8.74999" y2="0.187504" gradientUnits="userSpaceOnUse">\n` +
    `      <stop stop-color="black"/>\n` +
    `      <stop offset="1" stop-color="#151718"/>\n` +
    `    </linearGradient>\n` +
    `  </defs>\n` +
    `</svg>`,
);

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 扫描线栅格化（像素坐标 + 4x 超采样） ----------
// shapes = [{ polys: 点集数组（一组内 even-odd）, color: [r,g,b] | (y)=>[r,g,b] }]
function renderPixels(size, shapes, ss = 4) {
  const W = size * ss;
  const acc = new Float64Array(W * W * 3);
  const cov = new Float64Array(W * W);
  for (const shape of shapes) {
    const edges = [];
    for (const poly of shape.polys) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        if (p[1] !== q[1]) edges.push([p, q]);
      }
    }
    for (let y = 0; y < W; y++) {
      const wy = (y + 0.5) / ss;
      const xs = [];
      for (const [[x1, y1], [x2, y2]] of edges) {
        if (y1 <= wy !== y2 <= wy) xs.push(x1 + ((wy - y1) * (x2 - x1)) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      const color = typeof shape.color === "function" ? shape.color(wy) : shape.color;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k] * ss));
        const xb = Math.min(W - 1, Math.round(xs[k + 1] * ss) - 1);
        for (let x = xa; x <= xb; x++) {
          const idx = (y * W + x) * 3;
          acc[idx] += color[0];
          acc[idx + 1] += color[1];
          acc[idx + 2] += color[2];
          cov[y * W + x] += 1;
        }
      }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const p = (y * ss + sy) * W + x * ss + sx;
          const c = Math.min(1, cov[p]);
          if (c > 0) {
            const idx = p * 3;
            r += acc[idx] / cov[p];
            g += acc[idx + 1] / cov[p];
            b += acc[idx + 2] / cov[p];
          }
          a += c;
        }
      }
      const o = (y * size + x) * 4;
      const cover = a / (ss * ss);
      const div = ss * ss * cover || 1;
      out[o] = Math.round(r / div);
      out[o + 1] = Math.round(g / div);
      out[o + 2] = Math.round(b / div);
      out[o + 3] = Math.round(cover * 255);
    }
  }
  return out;
}

// 圆角方（多边形近似）
function roundRectPoly(x, y, w, h, r, seg = 8) {
  const pts = [];
  const corner = (cx, cy, a0, a1) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2, 0);
  corner(x + w - r, y + h - r, 0, Math.PI / 2);
  corner(x + r, y + h - r, Math.PI / 2, Math.PI);
  corner(x + r, y + r, Math.PI, Math.PI * 1.5);
  return pts;
}

// ---------- 形态 B（应用方标）像素构图 ----------
function formBShapes(size, marginRatio) {
  const margin = size * marginRatio;
  const boxV = (size - margin * 2) / 18; // 18 坐标系 → 像素
  const ox = margin;
  const oy = margin;
  const shapes = [];
  // 深色渐变方（0.1837..17.3163，半径 2.7316）
  const bx0 = 0.1837;
  const bx1 = 17.3163;
  const grad = (wy) => {
    const t = Math.min(1, Math.max(0, (wy - oy - bx0 * boxV) / ((bx1 - bx0) * boxV)));
    return [Math.round(21 * t), Math.round(23 * t), Math.round(24 * t)];
  };
  shapes.push({
    polys: [roundRectPoly(bx0 * boxV + ox, bx0 * boxV + oy, (bx1 - bx0) * boxV, (bx1 - bx0) * boxV, 2.7316 * boxV)],
    color: grad,
  });
  // 外圈灰描边（0..17.5 环，厚 0.367）
  shapes.push({
    polys: [
      roundRectPoly(ox, oy, 17.5 * boxV, 17.5 * boxV, 2.915 * boxV),
      roundRectPoly(0.367 * boxV + ox, 0.367 * boxV + oy, 16.766 * boxV, 16.766 * boxV, 2.548 * boxV),
    ],
    color: [0xb7, 0xbc, 0xbf],
  });
  // OMZ 白色字标（逐组填充：O 环 evenodd，M/Z 子路径独立叠加）
  const s = (WM_IN_BOX / WORDMARK_W) * boxV;
  const tx = 1.8 * boxV + ox;
  const ty = wmBoxY * boxV + oy;
  for (const group of wordmarkShapesPolys) {
    shapes.push({
      polys: group.map((poly) => poly.map(([x, y]) => [x * s + tx, y * s + ty])),
      color: [255, 255, 255],
    });
  }
  return shapes;
}

// ---------- 输出 PNG/ICO ----------
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const size of sizes) {
  writeFileSync(resolve(outDir, `icon-${size}.png`), encodePng(size, size, renderPixels(size, formBShapes(size, 0.07))));
}
// icon.png（留 7% 透明边）与 icon_windows.png（满幅：圆角方撑满画布）
writeFileSync(resolve(outDir, "icon.png"), encodePng(1024, 1024, renderPixels(1024, formBShapes(1024, 0.07))));
writeFileSync(
  resolve(outDir, "icon_windows.png"),
  encodePng(1024, 1024, renderPixels(1024, formBShapes(1024, 0.001))),
);
console.log("✓ PNG 图标集");

function buildIco(sizeList) {
  const entries = sizeList.map((s) => ({
    size: s,
    data: encodePng(s, s, renderPixels(s, formBShapes(s, 0.07))),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO 类型
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, i * 16);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2);
    dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(e.data.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}
writeFileSync(resolve(outDir, "icon.ico"), buildIco([16, 24, 32, 48, 64, 128, 256]));
console.log("✓ icon.ico");

// ---------- ASCII 目检输出（终端直接看字形结构） ----------
function asciiWordmark(cols, rows) {
  const sx = WORDMARK_W / cols;
  const sy = H / rows;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      let hit = 0;
      for (const [ox, oy] of [
        [0.3, 0.3],
        [0.7, 0.7],
      ]) {
        const px = (c + ox) * sx;
        const py = (r + oy) * sy;
        // 逐组 even-odd 后取并集（O 环成环、M 交叠区不掏洞）
        let inside = false;
        for (const group of wordmarkShapesPolys) {
          let crossings = 0;
          for (const poly of group) {
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [xi, yi] = poly[i];
              const [xj, yj] = poly[j];
              if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) crossings++;
            }
          }
          if (crossings % 2 === 1) {
            inside = true;
            break;
          }
        }
        if (inside) hit++;
      }
      line += hit === 2 ? "█" : hit === 1 ? "▓" : " ";
    }
    lines.push(line.replace(/ +$/, ""));
  }
  return lines.join("\n");
}
writeFileSync(resolve(outDir, "wordmark.ascii.txt"), asciiWordmark(150, 26) + "\n", "utf8");
console.log("✓ wordmark.ascii.txt（ASCII 目检）");
console.log(`\n输出目录：${outDir}`);
console.log(`字标 viewBox：${wordmarkViewBox}（宽高比 ${(WORDMARK_W / H).toFixed(2)}:1）`);
console.log("\n" + asciiWordmark(110, 20));
