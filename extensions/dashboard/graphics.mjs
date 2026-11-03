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

// ── Graph layout and visual geometry ────────────────────────────────────

/** Condense strongly connected components, then layer the resulting DAG.
 * Real retry loops remain close together instead of scrambling the entire graph.
 * Returned edgePairs are exclusively the input graph's actual links.
 */
export function layoutGraph(nodes, edges) {
  const index = new Map(nodes.map((n,i)=>[n.id,i]));
  const adjacency = nodes.map(()=>[]), edgePairs=[];
  for(const edge of edges) {
    const a=index.get(edge.from), b=index.get(edge.to);
    if(a===undefined||b===undefined)continue;
    adjacency[a].push(b);edgePairs.push([a,b]);
  }
  let cursor=0;const numbers=[],low=[],stack=[],inside=new Set(),components=[];
  function visit(v) {
    numbers[v]=low[v]=cursor++;stack.push(v);inside.add(v);
    for(const w of adjacency[v]) {
      if(numbers[w]===undefined){visit(w);low[v]=Math.min(low[v],low[w]);}
      else if(inside.has(w))low[v]=Math.min(low[v],numbers[w]);
    }
    if(low[v]===numbers[v]) {
      const group=[];let w;
      do{w=stack.pop();inside.delete(w);group.push(w);}while(w!==v);
      components.push(group.sort((a,b)=>a-b));
    }
  }
  nodes.forEach((_,i)=>{if(numbers[i]===undefined)visit(i);});
  const owner=[];components.forEach((group,c)=>group.forEach(i=>owner[i]=c));
  const next=components.map(()=>new Set()),degree=components.map(()=>0),depth=components.map(()=>0);
  for(const [a,b] of edgePairs)if(owner[a]!==owner[b]&&!next[owner[a]].has(owner[b])) {
    next[owner[a]].add(owner[b]);degree[owner[b]]++;
  }
  const queue=degree.flatMap((d,i)=>d===0?[i]:[]);
  for(let head=0;head<queue.length;head++)for(const to of next[queue[head]]) {
    depth[to]=Math.max(depth[to],depth[queue[head]]+1);if(--degree[to]===0)queue.push(to);
  }
  const layers=new Map();
  nodes.forEach((_,i)=>{const d=depth[owner[i]];if(!layers.has(d))layers.set(d,[]);layers.get(d).push(i);});
  // Barycentric ordering reduces crossing in fan-out/fan-in graphs.
  const order=new Map();
  for(const [d,group] of [...layers].sort((a,b)=>a[0]-b[0])) {
    const score=i=>{const parents=edgePairs.filter(([a,b])=>b===i&&depth[owner[a]]<d).map(([a])=>order.get(a)??a);return parents.length?parents.reduce((a,b)=>a+b,0)/parents.length:i;};
    group.sort((a,b)=>score(a)-score(b)||a-b);group.forEach((i,k)=>order.set(i,k));
  }
  const maxLayer=Math.max(0,...depth);
  const positions=[];
  for(const [d,group] of layers)group.forEach((i,k)=>positions.push({id:nodes[i].id,index:i,layer:d,
    x:maxLayer?d/maxLayer:.5,y:(k+1)/(group.length+1)}));
  return {positions,maxLayer,edgePairs};
}

/** Shared geometry for pixels, terminal labels, and mouse hit targets. */
export function graphGeometry(nodes,edges,columns,rows,cellRatio=.5) {
  const layout=layoutGraph(nodes,edges);
  const layerCount=layout.maxLayer+1;
  const vertical=layerCount>Math.max(1,Math.floor(columns/15));
  const maxGroup=Math.max(1,...layout.positions.map(p=>layout.positions.filter(q=>q.layer===p.layer).length));
  const across=vertical?maxGroup:layerCount,down=vertical?layerCount:maxGroup;
  const cardW=Math.max(7,Math.min(24,Math.floor((columns-4)/Math.max(1,across))-4));
  const cardH=Math.max(2,Math.min(5,Math.floor((rows-2)/Math.max(1,down))-1));
  const cards=layout.positions.map(p=>{
    const peers=layout.positions.filter(q=>q.layer===p.layer).sort((a,b)=>a.y-b.y);
    const slot=peers.findIndex(q=>q.id===p.id);
    const x=vertical?(slot+.5)*columns/peers.length:layerCount===1?columns/2:2+cardW/2+p.x*(columns-cardW-4);
    const y=vertical?1+cardH/2+(layerCount===1?.5:p.layer/(layerCount-1))*(rows-cardH-2):(slot+1)*rows/(peers.length+1);
    return {id:p.id,index:p.index,x:Math.round(x-cardW/2),y:Math.round(y-cardH/2),w:cardW,h:cardH};
  });
  const rawWidth=Math.min(1100,Math.max(240,Math.round(columns*9)));
  const rawHeight=rawWidth*rows/(columns*cellRatio);
  const scale=Math.min(1,850/rawHeight);
  const width=Math.max(1,Math.round(rawWidth*scale));
  const height=Math.max(1,Math.round(rawHeight*scale));
  return {cards,width,height,columns,rows,vertical,edgePairs:layout.edgePairs};
}

function curve(a,b,t) {
  const u=1-t;
  return {x:u*u*u*a[0].x+3*u*u*t*a[1].x+3*u*t*t*b[1].x+t*t*t*b[0].x,
    y:u*u*u*a[0].y+3*u*u*t*a[1].y+3*u*t*t*b[1].y+t*t*t*b[0].y};
}
function strokeCurve(px,a,b,color,alpha,trail=false,time=0) {
  let previous=curve(a,b,0);
  for(let j=1;j<=90;j++) {
    const point=curve(a,b,j/90);
    px.line(previous.x,previous.y,point.x,point.y,color,alpha);previous=point;
  }
  if(trail)for(let packet=0;packet<2;packet++) {
    const head=(time*.28+packet*.5)%1;
    for(let k=16;k>=0;k--) {
      const t=(head-k*.006+1)%1,p=curve(a,b,t);
      px.dot(p.x,p.y,k===0?2.2:1.2,color,(1-k/17)*.85);
    }
    const p=curve(a,b,head);px.dot(p.x,p.y,1.2,[230,255,255],1);
  }
  const end=curve(a,b,.98),prior=curve(a,b,.93),angle=Math.atan2(end.y-prior.y,end.x-prior.x);
  for(const side of [-.55,.55])px.line(end.x,end.y,end.x-7*Math.cos(angle+side),end.y-7*Math.sin(angle+side),color,alpha);
}
function roundedRect(px,x,y,w,h,r,fill,border,alpha=1) {
  // Solid card interior prevents connections showing through node bodies.
  for(let row=Math.floor(y);row<=y+h;row++)for(let col=Math.floor(x);col<=x+w;col++) {
    const dx=Math.max(x+r-col,0,col-(x+w-r)),dy=Math.max(y+r-row,0,row-(y+h-r));
    if(dx*dx+dy*dy<=r*r)px.blend(col,row,fill,1);
  }
  const points=[];
  for(const [cx,cy,start] of [[x+w-r,y+r,-Math.PI/2],[x+w-r,y+h-r,0],
    [x+r,y+h-r,Math.PI/2],[x+r,y+r,Math.PI]]) {
    for(let i=0;i<=16;i++) {
      const t=start+i/16*Math.PI/2;
      points.push({x:cx+r*Math.cos(t),y:cy+r*Math.sin(t)});
    }
  }
  points.push(points[0]);
  for(let i=1;i<points.length;i++)px.line(points[i-1].x,points[i-1].y,points[i].x,points[i].y,border,alpha);
}

/** Pixel cards + curved routes. Text overlay remains crisp/selectable terminal text. */
export function renderGraphPng(nodes,edges,width,height,time=0,options={}) {
  const px=new Pixels(width,height,[13,16,26]);
  const geometry=options.geometry??graphGeometry(nodes,edges,100,28,.5);
  const sx=width/geometry.columns,sy=height/geometry.rows;
  const cards=geometry.cards.map(c=>({...c,x:c.x*sx,y:c.y*sy,w:c.w*sx,h:c.h*sy}));
  const byId=new Map(cards.map(c=>[c.id,c]));
  // Quiet dot-grid and guide lines add depth without competing with execution.
  for(let y=12;y<height;y+=20)for(let x=12;x<width;x+=20)px.blend(x,y,[52,68,92],.45);
  for(const [ai,bi] of geometry.edgePairs) {
    const source=nodes[ai],target=nodes[bi],a=byId.get(source.id),b=byId.get(target.id);
    if(!a||!b)continue;
    const observed=edges.some(e=>e.from===source.id&&e.to===target.id&&e.observed);
    const active=observed&&target.status==='running';
    const completed=observed&&(source.status==='done'||source.status==='cached');
    const tint=active?[80,220,240]:completed?[77,151,132]:[62,76,102];
    let start,end,ca,cb;
    if(ai===bi) {
      start={x:a.x+a.w,y:a.y+a.h*.65};end={x:a.x+a.w*.7,y:a.y};
      ca={x:start.x+28,y:start.y-40};cb={x:end.x+45,y:end.y-25};
    }else if(geometry.vertical) {
      const forward=b.y>a.y;
      start={x:a.x+a.w/2,y:forward?a.y+a.h:a.y};end={x:b.x+b.w/2,y:forward?b.y:b.y+b.h};
      const bend=Math.max(20,Math.abs(end.y-start.y)*.5);
      ca={x:start.x+(forward?0:40),y:start.y+(forward?bend:-bend)};cb={x:end.x+(forward?0:40),y:end.y+(forward?-bend:bend)};
    }else {
      const forward=b.x>a.x;
      start={x:forward?a.x+a.w:a.x,y:a.y+a.h/2};end={x:forward?b.x:b.x+b.w,y:b.y+b.h/2};
      const bend=Math.max(22,Math.abs(end.x-start.x)*.5);
      ca={x:start.x+(forward?bend:-bend),y:start.y+(forward?0:30)};cb={x:end.x+(forward?-bend:bend),y:end.y+(forward?0:30)};
    }
    strokeCurve(px,[start,ca],[end,cb],tint,active?.9:completed?.6:.38,active,time+ai*.2);
  }
  for(const c of cards) {
    const node=nodes[c.index],active=node.status==='running',selected=c.index===options.selected;
    const tint=statusInfo(node.status).rgb;
    const fill=active?[16,34,45]:selected?[24,29,47]:[18,23,35];
    const pulse=active?.55+.2*Math.sin(time*3):.5;
    roundedRect(px,c.x,c.y,c.w,c.h,Math.min(10,c.h*.2),fill,selected?[178,143,255]:tint,selected?.95:pulse);
    // Coloured top accent, port lights and activity meter communicate state.
    px.line(c.x+12,c.y+1,c.x+c.w-12,c.y+1,tint,active?.9:.45);
    const port=geometry.vertical?{x:c.x+c.w/2,y:c.y+c.h}:{x:c.x+c.w,y:c.y+c.h/2};
    px.dot(port.x,port.y,active?5:3,tint,active?.4:.65);
    if(active) {
      const ring=3+((time*.65)%1)*9;
      const opacity=(1-((time*.65)%1))*.4;
      for(let j=0;j<32;j++) {
        const a=j/32*Math.PI*2,b=(j+1)/32*Math.PI*2;
        px.line(port.x+ring*Math.cos(a),port.y+ring*Math.sin(a),port.x+ring*Math.cos(b),port.y+ring*Math.sin(b),tint,opacity);
      }
      px.dot(port.x,port.y,1.5,[220,255,255],.9);
      const arc=(time*.2)%1;
      for(let k=0;k<12;k++) {
        const t=(arc+k/180)%1;
        px.line(c.x+9+t*(c.w-18),c.y+c.h-5,c.x+10+t*(c.w-18),c.y+c.h-5,tint,(k+1)/12);
      }
    }
    for(let k=0;k<Math.min(8,node.visits??0);k++)px.line(c.x+9+k*5,c.y+c.h-2,c.x+11+k*5,c.y+c.h-2,tint,.7);
  }
  return px.toPng();
}
