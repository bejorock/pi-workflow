#!/usr/bin/env node
/** Standalone, read-only PTY viewer. Started only by /workspace-dashboard. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sliceByColumn } from '@earendil-works/pi-tui';
import { kittyUpload, kittyPlace, kittyDelete, kittyProbeSequence, probeReplyPattern,
  CELL_SIZE_QUERY, renderGraphPng, graphGeometry, statusInfo } from './graphics.mjs';
import { color, fg, palette, fit, safeText, renderMarkdown } from './markdown.mjs';

const CSI='\x1b[';
export const stale = (s, now=Date.now()) => !s?.connected || now-s.updatedAt > 5000;
export function readSnapshot(file) {
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  if (s.version!==1 || !Array.isArray(s.runs) || !Array.isArray(s.plans) || !Array.isArray(s.contracts)) throw Error('Unsupported snapshot');
  return s;
}
export const filtered = (items,query) => items.filter(item => `${item.name} ${item.id ?? item.runId} ${item.status ?? ''}`.toLowerCase().includes(query.toLowerCase()));

/** Stateful decoder handles split CSI/APC responses and mouse packets. */
export function decodeInput(buffer) {
  const events=[]; let pos=0;
  while (pos<buffer.length) {
    const tail=buffer.slice(pos);
    if (tail.startsWith('\x1b_G')) {
      const end=tail.indexOf('\x1b\\'); if(end<0) break;
      pos+=end+2; continue;
    }
    if(tail.startsWith('\x1b[')) {
      const mouse=/^\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(tail);
      if(mouse) { events.push({mouse:true,button:+mouse[1],x:+mouse[2]-1,y:+mouse[3]-1,release:mouse[4]==='m'}); pos+=mouse[0].length; continue; }
      const seq=/^\x1b\[[0-9;?]*[A-Za-z~]/.exec(tail);
      if(!seq) { if(tail.length>128) { pos++; continue; } break; }
      const keys={'\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left','\x1b[5~':'pageup','\x1b[6~':'pagedown','\x1b[H':'home','\x1b[F':'end'};
      if(keys[seq[0]]) events.push({key:keys[seq[0]]}); pos+=seq[0].length; continue;
    }
    if(tail==='\x1b') { events.push({key:'escape'}); pos++; continue; }
    const cp=String.fromCodePoint(tail.codePointAt(0)); events.push({key:cp}); pos+=cp.length;
  }
  return {events,rest:buffer.slice(pos)};
}

export function findNext(state) {
  if(!state.search)return;
  const query=state.search.toLowerCase();
  for(let step=1;step<=state.docLines.length;step++) {
    const index=(state.offset+step)%state.docLines.length;
    const plain=state.docLines[index].replace(/\x1b\[[0-9;]*m/g,'');
    if(plain.toLowerCase().includes(query)){state.offset=index;return;}
  }
}

export function createViewState() {
  return {tab:0,selection:[0,0,0],selectedIds:[],offset:0,node:0,query:'',editing:false,docKey:'',docLines:[],hits:[],listStart:0,search:'',searching:false};
}

export function draw(snapshot,state,width,height,elapsed,cellRatio=.5) {
  const lines=Array.from({length:height},()=> ' '.repeat(width));
  const put=(x,y,text,w=width-x) => {
    if(y<0||y>=height||x<0) return;
    w=Math.max(0,Math.min(w,width-x));
    const reset=CSI+'0m'+CSI+'48;2;13;16;26m'+CSI+'38;2;215;226;240m';
    lines[y]=sliceByColumn(lines[y],0,x)+reset+fit(text.replace(/[\r\n\t]/g,' '),w)
      +reset+sliceByColumn(lines[y],x+w,width-x-w);
  };
  state.hits=[];
  put(0,0,color('cyan',' ◈ PI WORKSPACE')+color('muted','  /  read-only observatory'));
  if(width<86||height<28) {
    put(2,3,color('amber',`Resize to at least 86 × 28 (current ${width} × ${height}). q to quit.`));
    return {text:serializeRows(lines),rows:lines,width,height,graph:null};
  }
  const tabs=['Workflows','Plans','Contracts'];
  for(let i=0;i<3;i++) {
    put(i*19,2,color(state.tab===i?'cyan':'muted',` ${i+1}  ${tabs[i]} `),19);
    state.hits.push({x:i*19,y:2,w:19,h:1,action:()=>{state.tab=i;state.offset=0;state.node=0;}});
  }
  put(width-25,0,color(stale(snapshot)?'amber':'green',stale(snapshot)?'● OWNER DISCONNECTED':'● LIVE · Kitty graphics'),25);
  put(1,3,color('muted',safeText(snapshot.cwd)));
  const split=Math.min(36,Math.max(25,Math.floor(width*.25)));
  const rx=split+2,rw=width-rx-2;
  for(let y=5;y<height-2;y++) put(split,y,color('border','│'),1);
  put(1,5,color('purple',state.editing?`Filter: ${state.query}▏`:`/ filter: ${state.query||'all items'}`),split-2);
  const collection=[snapshot.runs,snapshot.plans,snapshot.contracts][state.tab];
  const items=filtered(collection,state.query);
  const previous=state.selectedIds[state.tab];
  const found=items.findIndex(item=>(item.runId??item.id)===previous);
  if(found>=0) state.selection[state.tab]=found;
  state.selection[state.tab]=Math.max(0,Math.min(items.length-1,state.selection[state.tab]));
  const selected=state.selection[state.tab];
  const capacity=height-10;
  state.listStart=Math.max(0,selected-capacity+1);
  for(let row=0;row<capacity;row++) {
    const index=state.listStart+row,item=items[index]; if(!item)break;
    const chosen=index===selected;
    const text=(chosen?'▸ ':'  ')+safeText(item.name);
    put(1,7+row,color(chosen?'cyan':'text',text),split-2);
    state.hits.push({x:1,y:7+row,w:split-2,h:1,action:()=>{state.selection[state.tab]=index;state.selectedIds[state.tab]=null;state.offset=0;state.node=0;}});
  }
  put(1,height-3,color('muted',`${items.length} ${tabs[state.tab].toLowerCase()}`),split-2);
  const item=items[selected];
  let graph=null;
  if(!item) put(rx,7,color('muted','No items match. Documents and runs appear automatically.'),rw);
  else {
    state.selectedIds[state.tab]=item.runId??item.id;
    put(rx,5,color('cyan',safeText(item.name)),rw);
    if(state.tab===0) {
      const nodes=item.nodes??[],edges=item.edges??[];
      const disconnected=stale(snapshot);
      const displayNodes=disconnected?nodes.map(n=>n.status==='running'?{...n,status:'paused'}:n):nodes;
      const duration=item.durationMs/1000;
      put(rx,6,color('muted',`${safeText(item.status)} · ${item.totalTokens.toLocaleString()} tokens · ${duration.toFixed(1)}s · ${nodes.length} nodes`),rw);
      const gx=rx,gy=8,gw=rw,gh=Math.max(7,height-19);
      const geometry=graphGeometry(nodes,edges,gw,gh,cellRatio);
      graph={x:gx,y:gy,w:gw,h:gh,nodes:displayNodes,edges,width:geometry.width,height:geometry.height,time:elapsed,geometry,selected:state.node};
      for(const card of geometry.cards) {
        const n=displayNodes[card.index],info=statusInfo(n.status);
        const lx=gx+card.x+1,ly=gy+card.y;
        const labelWidth=Math.max(1,card.w-2);
        const type=n.nodeType==='command'?'⌘ CMD':n.nodeType==='human'?'◇ HUMAN':n.nodeType==='fn'?'ƒ FUNCTION':n.id==='END'?'◆ END':'◈ AGENT';
        if(card.h>=4)put(lx,ly+1,color('muted',`${String(card.index+1).padStart(2,'0')} ${type}`),labelWidth);
        put(lx,ly+(card.h>=4?2:0),color(card.index===state.node?'purple':'text',safeText(n.label)),labelWidth);
        if(card.h>=3)put(lx,ly+card.h-1,fg(info.rgb,`${info.glyph} ${info.label}${n.visits>1?` ×${n.visits}`:''}`),labelWidth);
        state.hits.push({x:gx+card.x,y:gy+card.y,w:card.w,h:card.h,action:()=>{state.node=card.index;}});
      }
      state.node=Math.max(0,Math.min(nodes.length-1,state.node));
      const node=nodes[state.node];
      const detailY=gy+gh+1;
      put(rx,detailY,color('purple',node?`NODE ${state.node+1}/${nodes.length} · ${safeText(node.label)} · ${safeText(node.status)}`:'No nodes yet'),rw);
      if(node) put(rx,detailY+1,color('text',safeText(node.preview||`${node.visits} visit(s) · ${node.nodeType??'agent'}`).replace(/\n/g,' ')),rw);
      const done=nodes.filter(n=>['done','cached','completed'].includes(n.status)).length;
      const active=displayNodes.filter(n=>n.status==='running').length;
      const waiting=displayNodes.filter(n=>n.status==='waiting').length;
      const barWidth=Math.max(4,rw-29),filled=Math.round(barWidth*done/Math.max(1,nodes.length));
      put(rx,detailY+2,color('green','━'.repeat(filled))+color('border','━'.repeat(barWidth-filled))+color('muted',`  ${done}/${nodes.length} settled · ${active} active`),rw);
      put(rx,detailY+3,color('cyan',`● running  `)+color('green','✓ done  ')+color('amber',`◇ waiting ${waiting}  `)+color('muted','dim = unvisited route'),rw);
      for(let j=0;j<2;j++)put(rx,detailY+4+j,color('muted',safeText(item.logs?.slice(-2)[j]??'').replace(/\n/g,' ')),rw);
    } else {
      put(rx,6,color('muted',state.tab===2?`${safeText(item.type)} · ${safeText(item.status)} · ${safeText(item.producer)} → ${safeText(item.consumer)}`:`Updated ${safeText(item.updatedAt)}`),rw);
      const key=`${state.tab}:${item.id}:${rw}:${item.content}`;
      if(state.docKey!==key) { state.docLines=renderMarkdown(item.content,rw);state.docKey=key; }
      const page=height-12;
      state.offset=Math.max(0,Math.min(state.offset,Math.max(0,state.docLines.length-page)));
      for(let row=0;row<page;row++)put(rx,8+row,state.docLines[state.offset+row]??'',rw);
      put(rx,height-3,color('muted',state.searching?`Find in document: ${state.search}▏`:`Lines ${state.offset+1}–${Math.min(state.docLines.length,state.offset+page)} / ${state.docLines.length} · f find · n next`),rw);
    }
  }
  put(0,height-1,color('muted',state.editing?' Type to filter · Enter: apply · Esc: clear':' 1/2/3 sections · ↑↓ select · ←→ node · PgUp/PgDn scroll · / filter · q quit'));
  // No clear-screen during normal repaint: it would remove graphics each frame.
  return {text:serializeRows(lines),rows:lines,width,height,graph};
}

const ROW_STYLE=CSI+'0m'+CSI+'48;2;13;16;26m'+CSI+'38;2;215;226;240m';
function serializeRows(rows) {
  return rows.map((row,y)=>`${CSI}${y+1};1H${ROW_STYLE}${row}`).join('');
}

/** Diff final rows, not drawing commands. Keep the displayed image untouched
 * during upload; atomically swap text/placement/deletion in DEC synchronized
 * output. Static documents and settled graphs generate zero repeated output.
 */
export class FramePresenter {
  constructor(imageId) { this.id=imageId;this.rows=[];this.size='';this.image=null;this.graphKey='';this.frame=0; }
  present(view) {
    const size=`${view.width}:${view.height}`;
    const resized=this.size!==size;
    const changed=[];
    for(let y=0;y<view.rows.length;y++)if(resized||view.rows[y]!==this.rows[y]) {
      changed.push(`${CSI}${y+1};1H${ROW_STYLE}${view.rows[y]}`);
    }
    this.rows=[...view.rows];this.size=size;
    let upload='',swap='';
    if(view.graph) {
      const g=view.graph;
      const key=JSON.stringify([g.nodes,g.edges,g.geometry,g.selected]);
      const animate=g.nodes.some(n=>n.status==='running');
      if(resized||key!==this.graphKey||animate||this.image===null) {
        const current=this.id+(this.frame++%2);
        const png=renderGraphPng(g.nodes,g.edges,g.width,g.height,g.time,{geometry:g.geometry,selected:g.selected});
        // Large base64 transfer is outside the synchronized paint interval.
        // This ID is not the visible one, so slow transfer cannot blank it.
        upload=kittyUpload(png.toString('base64'),current);
        swap=`${CSI}${g.y+1};${g.x+1}H`+kittyPlace(current,g.w,g.h);
        if(this.image!==null)swap+=kittyDelete(this.image);
        this.image=current;this.graphKey=key;
      }
    } else if(this.image!==null) {
      swap=kittyDelete(this.image);this.image=null;this.graphKey='';
    }
    if(!changed.length&&!swap)return '';
    // A single write does not imply a single terminal frame; PTYs split writes.
    return upload+CSI+'?2026h'+changed.join('')+swap+CSI+'?2026l';
  }
}

export async function runViewer(file) {
  if(!process.stdin.isTTY||!process.stdout.isTTY||process.platform==='win32') throw Error('Dashboard requires a Linux/macOS terminal PTY.');
  let entered=false,timer,watcher,input='',stopped=false;
  const initialEncoding=process.stdin.readableEncoding;
  const initialRaw=process.stdin.isRaw;
  const id=100000+Math.floor(Math.random()*1000000000),queryId=id+2;
  const state=createViewState();
  let snapshot=readSnapshot(file),ratio=.5;
  const cleanup=()=>{
    if(stopped)return;stopped=true;
    clearInterval(timer);clearInterval(watcher);
    process.stdin.removeListener('data',onData);
    process.removeListener('SIGINT',cleanup);process.removeListener('SIGTERM',cleanup);
    if(entered)process.stdout.write(CSI+'?2026l'+kittyDelete(id)+kittyDelete(id+1)+'\x1b[0m'+CSI+'?1000l'+CSI+'?1006l'+CSI+'?7h'+CSI+'?25h'+CSI+'?1049l');
    process.stdin.setRawMode(!!initialRaw);process.stdin.pause();
    if(initialEncoding)process.stdin.setEncoding(initialEncoding);
  };
  const onData=data=>{
    input+=data.toString('utf8');
    const decoded=decodeInput(input);input=decoded.rest;
    for(const e of decoded.events) {
      if(e.mouse) {
        if(e.release)continue;
        if(e.button===64||e.button===65)state.offset+=e.button===64?-3:3;
        else if((e.button&3)===0)state.hits.find(h=>e.x>=h.x&&e.x<h.x+h.w&&e.y>=h.y&&e.y<h.y+h.h)?.action();
        continue;
      }
      const k=e.key;
      if(k==='\x03'){cleanup();return;}
      if(state.searching) {
        if(k==='escape'){state.searching=false;state.search='';}
        else if(k==='\r'||k==='\n'){state.searching=false;findNext(state);}
        else if(k==='\x7f')state.search=state.search.slice(0,-1);
        else if(k.length===1&&k>=' ')state.search+=k;
        continue;
      }
      if(!state.editing&&k==='f'&&state.tab!==0){state.searching=true;continue;}
      if(!state.editing&&k==='n'&&state.tab!==0){findNext(state);continue;}
      if(state.editing) {
        if(k==='\r'||k==='\n')state.editing=false;
        else if(k==='escape'){state.query='';state.editing=false;}
        else if(k==='\x7f')state.query=state.query.slice(0,-1);
        else if(k.length===1&&k>=' ')state.query+=k;
        state.selectedIds=[];state.selection=[0,0,0];state.offset=0;continue;
      }
      if(k==='q'){cleanup();return;}
      if(['1','2','3'].includes(k)){state.tab=+k-1;state.offset=0;}
      if(k==='\t'){state.tab=(state.tab+1)%3;state.offset=0;}
      if(k==='/')state.editing=true;
      if(k==='up'||k==='down') {state.selection[state.tab]+=k==='up'?-1:1;state.selectedIds[state.tab]=null;state.offset=0;state.node=0;}
      if(k==='left'||k==='right')state.node+=k==='left'?-1:1;
      if(k==='pageup'||k==='pagedown')state.offset+=(k==='pageup'?-1:1)*Math.max(5,(process.stdout.rows??30)-12);
      if(k==='home')state.offset=0;
      if(k==='end')state.offset=Number.MAX_SAFE_INTEGER;
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);process.stdin.resume();
  process.on('SIGINT',cleanup);process.on('SIGTERM',cleanup);
  try {
    const supported=await new Promise(resolve=>{
      let reply='';
      const listen=data=>{
        reply+=data.toString();
        const cell=/\x1b\[6;(\d+);(\d+)t/.exec(reply);
        if(cell&&+cell[1]>0&&+cell[2]>0)ratio=+cell[2]/+cell[1];
        if(probeReplyPattern(queryId).test(reply))finish(true);
      };
      const finish=ok=>{clearTimeout(timeout);process.stdin.off('data',listen);resolve(ok);};
      const timeout=setTimeout(()=>finish(false),1800);
      process.stdin.on('data',listen);
      process.stdout.write(CELL_SIZE_QUERY+kittyProbeSequence(queryId));
    });
    if(stopped)return;
    if(!supported)throw Error('Kitty graphics was not acknowledged by this terminal path. Use a compatible terminal/Herdr client. Existing /workflows, /plans and /contracts remain available.');
    entered=true;process.stdout.write(CSI+'?1049h'+CSI+'?25l'+CSI+'?7l'+CSI+'?1000h'+CSI+'?1006h'+CSI+'48;2;13;16;26m'+CSI+'2J');
    process.stdin.on('data',onData);
    watcher=setInterval(()=>{try{snapshot=readSnapshot(file);}catch{/* Keep final snapshot; heartbeat makes disconnect visible. */}},1000);
    const presenter=new FramePresenter(id);
    const start=Date.now();
    const paint=()=>{
      if(stopped||process.stdout.writableNeedDrain)return;
      try {
        const view=draw(snapshot,state,process.stdout.columns??110,process.stdout.rows??34,(Date.now()-start)/1000,ratio);
        const output=presenter.present(view);
        if(output)process.stdout.write(output);
      } catch(error){cleanup();console.error(`Dashboard: ${safeText(error.message)}`);}
    };
    paint();timer=setInterval(paint,100);
    await new Promise(resolve=>{const poll=setInterval(()=>{if(stopped){clearInterval(poll);resolve();}},100);});
  } finally {cleanup();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const i=process.argv.indexOf('--snapshot');
  if(i<0||!process.argv[i+1]){console.error('Usage: node viewer.mjs --snapshot PATH (normally opened by /workspace-dashboard)');process.exitCode=1;}
  else runViewer(process.argv[i+1]).catch(async error=>{
    console.error(`Dashboard: ${safeText(error.message)}`);process.exitCode=1;
    // An argv-backed Herdr pane vanishes on exit. Keep errors visible until
    // acknowledged, instead of making unsupported graphics look like a crash.
    if(process.stdin.isTTY) {
      console.error('\nPress q or Ctrl-C to close this dashboard tab.');
      process.stdin.setRawMode(true);process.stdin.resume();
      await new Promise(resolve=>{
        const done=data=>{if(/[qQ\x03]/.test(data.toString())){process.stdin.off('data',done);resolve();}};
        process.stdin.on('data',done);
      });
      process.stdin.setRawMode(false);process.stdin.pause();
    }
  });
}
