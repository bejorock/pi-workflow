// Pure pixel-graphics helpers for the standalone workspace dashboard viewer.
//
// Everything in this file is deterministic and free of TTY/process side effects
// so tests can import and exercise it directly. The Kitty graphics protocol is
// emitted as plain APC escape sequences (see the reference demo protocol in
// /tmp/terminal-dashboard-kitty.py): chunked base64 uploads with a=t, followed
// by a=p placement and a=d deletion. PNG frames are encoded with Node's zlib.
//
// Status colour model (dark cyan / purple / amber palette):
//   running -> cyan pulse, queued/waiting -> muted slate, done -> green,
//   error -> red, skipped -> grey, cached -> amber, paused -> amber.

import zlib from "node:zlib";

const APC = "\x1b_G";
const ST = "\x1b\\";
const CSI = "\x1b[";

// ── Status helpers ──────────────────────────────────────────────────────

export const STATUS = {
  running: { glyph: "\u25b8", label: "running", rgb: [80, 220, 240] },
  done: { glyph: "\u2713", label: "done", rgb: [95, 205, 140] },
  queued: { glyph: "\u2026", label: "queued", rgb: [150, 150, 175] },
  waiting: { glyph: "\u2026", label: "waiting", rgb: [232, 182, 82] },
  error: { glyph: "\u2717", label: "error", rgb: [238, 96, 86] },
  skipped: { glyph: "\u2212", label: "skipped", rgb: [105, 112, 132] },
  cached: { glyph: "\u25c6", label: "cached", rgb: [214, 172, 92] },
  paused: { glyph: "\u2016", label: "paused", rgb: [232, 182, 82] },
  completed: { glyph: "\u2713", label: "completed", rgb: [95, 205, 140] },
  stopped: { glyph: "\u25a0", label: "stopped", rgb: [150, 150, 175] },
};

const DEFAULT_STATUS = { glyph: "\u25cb", label: "unknown", rgb: [150, 150, 175] };

/** Resolve a status string to its style entry, tolerating unknown values. */
export function statusInfo(status) {
  if (!status) return DEFAULT_STATUS;
  return STATUS[String(status).toLowerCase()] ?? DEFAULT_STATUS;
}

/** True for statuses whose nodes/edges should animate. */
export function isActiveStatus(status) {
  const s = String(status ?? "").toLowerCase();
  return s === "running";
}

// ── Kitty graphics protocol ─────────────────────────────────────────────

/** Chunked kitty image upload (transmit+store, quiet). Returns one APC string. */
export function kittyUpload(base64Data, imageId) {
  const CHUNK = 4096;
  const out = [];
  for (let offset = 0; offset < base64Data.length; offset += CHUNK) {
    const chunk = base64Data.slice(offset, offset + CHUNK);
    const more = offset + CHUNK < base64Data.length ? 1 : 0;
    let ctl = `m=${more},q=2`;
    if (offset === 0) ctl = `a=t,f=100,t=d,i=${imageId},${ctl}`;
    out.push(`${APC}${ctl};${chunk}${ST}`);
  }
  return out.join("");
}

/** Place a previously uploaded image in the given cell rectangle. */
export function kittyPlace(imageId, columns, rows) {
  return `${APC}a=p,i=${imageId},p=1,c=${columns},r=${rows},C=1,z=-1,q=2${ST}`;
}

/** Delete an image by id, freeing its stored data (uppercase I). */
export function kittyDelete(imageId) {
  return `${APC}a=d,d=I,i=${imageId},q=2${ST}`;
}

/** The graphics capability probe: APC query + primary device attributes. */
export function kittyProbeSequence(imageId) {
  return `${APC}a=q,i=${imageId},s=1,v=1,f=24,t=d;AAAA${ST}${CSI}c`;
}

/** Kitty cell-size query; reply is `ESC [ 6 ; height ; width t`. */
export const CELL_SIZE_QUERY = `${CSI}16t`;

/** Regex matching a successful kitty graphics probe reply. */
export function probeReplyPattern(imageId) {
  return new RegExp(`\\x1b_G(?:[^;]*,)?i=${imageId}(?:,[^;]*)?;OK\\x1b\\\\`);
}

// ── PNG encoding (Node zlib only) ───────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode raw RGB pixel data as a PNG Buffer. */
export function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 2 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Soft pixel canvas ───────────────────────────────────────────────────

export class Pixels {
  constructor(width, height, bg = [13, 16, 26]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 3] = bg[0];
      this.data[i * 3 + 1] = bg[1];
      this.data[i * 3 + 2] = bg[2];
    }
  }

  blend(x, y, color, alpha) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const o = (yi * this.width + xi) * 3;
    for (let c = 0; c < 3; c++) {
      this.data[o + c] = Math.round(this.data[o + c] + (color[c] - this.data[o + c]) * alpha);
    }
  }

  dot(cx, cy, radius, color, strength = 1) {
    const r = Math.max(0.8, radius);
    const reach = Math.ceil(r * 2);
    for (let py = Math.round(cy) - reach; py <= Math.round(cy) + reach; py++) {
      for (let px = Math.round(cx) - reach; px <= Math.round(cx) + reach; px++) {
        const d = (px - cx) ** 2 + (py - cy) ** 2;
        const a = strength * Math.exp(-d / (r * r * 0.65));
        if (a > 0.015) this.blend(px, py, color, Math.min(1, a));
      }
    }
  }

  line(x1, y1, x2, y2, color, alpha = 0.6) {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 1.2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      for (const [dx, dy, w] of [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
      ]) {
        this.blend(ix + dx, iy + dy, color, alpha * w);
      }
    }
  }

  toPng() {
    return encodePng(this.width, this.height, this.data);
  }
}

// ── Graph layout ────────────────────────────────────────────────────────

/**
 * Layered (longest-path) layout for a directed graph, in normalised
 * [0,1] x [0,1] space. The topology comes strictly from `edges`; no synthetic
 * edges are invented. Legitimate workflow cycles use a circular layout.
 */
export function layoutGraph(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const N = nodes.length;
  const adj = Array.from({ length: N }, () => []);
  const indeg = new Array(N).fill(0);
  const edgePairs = [];
  for (const e of edges) {
    const a = index.get(e?.from);
    const b = index.get(e?.to);
    if (a == null || b == null) continue;
    adj[a].push(b);
    indeg[b]++;
    edgePairs.push([a, b]);
  }

  const layer = new Array(N).fill(0);
  const queue = [];
  const indegWork = indeg.slice();
  for (let i = 0; i < N; i++) if (indegWork[i] === 0) queue.push(i);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const v of adj[u]) {
      layer[v] = Math.max(layer[v], layer[u] + 1);
      if (--indegWork[v] === 0) queue.push(v);
    }
  }
  // Workflows legitimately loop. Use a circular layout for cyclic graphs so
  // a retry does not collapse every participant into one vertical layer.
  if (queue.length < N) {
    return { positions: nodes.map((n, i) => ({ id: n.id, index: i,
      x: .5 + .42 * Math.cos(i * Math.PI * 2 / N - Math.PI / 2),
      y: .5 + .42 * Math.sin(i * Math.PI * 2 / N - Math.PI / 2) })), maxLayer: 0, edgePairs };
  }
  const maxLayer = layer.reduce((m, l) => Math.max(m, l), 0);
  for (let i = 0; i < N; i++) if (indegWork[i] > 0) layer[i] = maxLayer + 1;

  const groups = new Map();
  for (let i = 0; i < N; i++) {
    const l = layer[i];
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  }
  const layerKeys = [...groups.keys()].sort((a, b) => a - b);
  const top = layerKeys[layerKeys.length - 1] ?? 0;

  // Fully disconnected graph: lay nodes out in a single horizontal row.
  if (edgePairs.length === 0 && N > 1) {
    return {
      positions: nodes.map((n, i) => ({
        id: n.id,
        index: i,
        x: N === 1 ? 0.5 : i / (N - 1),
        y: 0.5,
      })),
      maxLayer: 0,
      edgePairs,
    };
  }

  const positions = [];
  for (const l of layerKeys) {
    const members = groups.get(l).sort((a, b) => a - b);
    const count = members.length;
    members.forEach((nodeIndex, k) => {
      positions.push({
        id: ids[nodeIndex],
        index: nodeIndex,
        x: top === 0 ? 0.5 : l / top,
        y: count === 1 ? 0.5 : k / (count - 1),
      });
    });
  }
  return { positions, maxLayer: top, edgePairs };
}

// ── Pixel graph renderer ────────────────────────────────────────────────

function nodePixelColor(status, time) {
  const s = String(status ?? "").toLowerCase();
  const info = statusInfo(status);
  if (s === "running") {
    const pulse = 0.75 + 0.25 * Math.sin(time * 4);
    return info.rgb.map((v) => Math.round(v * pulse));
  }
  return info.rgb;
}

function edgePixelColor(aStatus, bStatus) {
  const a = String(aStatus ?? "").toLowerCase();
  const b = String(bStatus ?? "").toLowerCase();
  if (a === "error" || b === "error") return [238, 96, 86];
  if (isActiveStatus(a) || isActiveStatus(b)) return [80, 220, 240];
  if (a === "done" || b === "done") return [88, 200, 160];
  if (a === "cached" && b === "cached") return [214, 172, 92];
  return [90, 100, 122];
}

/**
 * Render the actual workflow graph to a PNG Buffer. `time` (seconds) drives
 * the animation of active nodes and the pulses travelling along active edges.
 */
export function renderGraphPng(nodes, edges, width, height, time = 0) {
  const px = new Pixels(width, height, [13, 16, 26]);
  const { positions, edgePairs } = layoutGraph(nodes, edges);
  const marginX = Math.max(26, Math.floor(width * 0.09));
  const marginY = Math.max(26, Math.floor(height * 0.1));
  const W = Math.max(1, width - 2 * marginX);
  const H = Math.max(1, height - 2 * marginY);

  const pts = positions.map((p) => ({
    ...p,
    x: marginX + p.x * W,
    y: marginY + p.y * H,
  }));
  const byId = new Map(pts.map((p) => [p.id, p]));

  for (const [a, b] of edgePairs) {
    const A = byId.get(nodes[a].id);
    const B = byId.get(nodes[b].id);
    if (!A || !B) continue;
    const observed = edges.some(e => e.from === nodes[a].id && e.to === nodes[b].id && e.observed);
    const active = observed && (isActiveStatus(nodes[a].status) || isActiveStatus(nodes[b].status));
    const color = observed ? edgePixelColor(nodes[a].status, nodes[b].status) : [65, 80, 105];
    // Arrowhead distinguishes direction; self-loop is shown as an arc.
    if (a === b) {
      for (let j = 0; j < 60; j++) {
        const t = j / 60 * Math.PI * 2;
        const u = (j + 1) / 60 * Math.PI * 2;
        px.line(A.x + 12 + 12*Math.cos(t), A.y - 12 + 12*Math.sin(t),
          A.x + 12 + 12*Math.cos(u), A.y - 12 + 12*Math.sin(u), color, .6);
      }
    } else {
      px.line(A.x, A.y, B.x, B.y, color, active ? 0.85 : 0.32);
      const angle = Math.atan2(B.y-A.y, B.x-A.x);
      const tx = B.x - 10*Math.cos(angle), ty = B.y - 10*Math.sin(angle);
      for (const side of [-.5,.5]) px.line(tx,ty,tx-7*Math.cos(angle+side),ty-7*Math.sin(angle+side),color,.8);
    }
    if (active) {
      const t = (time * 0.55 + a * 0.17 + b * 0.11) % 1;
      const ex = A.x + (B.x - A.x) * t;
      const ey = A.y + (B.y - A.y) * t;
      px.dot(ex, ey, 3.2, [255, 228, 170], 0.5);
      px.dot(ex, ey, 1.3, [255, 246, 214], 1);
    }
  }

  for (const p of pts) {
    const node = nodes[p.index];
    const color = nodePixelColor(node.status, time);
    const active = isActiveStatus(node.status);
    const glow = active ? 6 + Math.sin(time * 4) * 1.6 : 4.6;
    px.dot(p.x, p.y, glow, color, 0.22);
    px.dot(p.x, p.y, 4.4, color, 1);
    px.dot(p.x, p.y, 1.9, [255, 255, 255], 0.32);
  }
  return px.toPng();
}
