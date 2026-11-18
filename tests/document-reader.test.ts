import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {stripVTControlCharacters as plain} from "node:util";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {initTheme, type ExtensionAPI, type ExtensionUIContext} from "@earendil-works/pi-coding-agent";
import {visibleWidth} from "@earendil-works/pi-tui";
import {DocumentReader, documentBody} from "../extensions/document-reader.ts";
import {openPlansNavigator} from "../extensions/plan-ui.ts";
import {openContractsNavigator} from "../extensions/contract-ui.ts";
import {contractCreate} from "../extensions/contract-tool.ts";
import {planCreate} from "../extensions/plan-tool.ts";

const body = '# Heading 漢字\n\nSome **strong** and *emphasis*.\n\n- One\n- Two\n\n> Quoted\n\n```ts\nconst answer = 42;\n```\n\n[Docs](https://example.com) ![remote](https://example.com/image.png)\n\n'+Array.from({length:60},(_,i)=>`Paragraph ${i} `+'long word '.repeat(8)).join('\n\n')+'\nTAIL_MARKER';
let cwd:string;
beforeEach(()=>{initTheme('dark');cwd=fs.mkdtempSync(path.join(os.tmpdir(),'document-reader-'));});
afterEach(()=>{fs.rmSync(cwd,{recursive:true,force:true});});
describe('shared Markdown document reader',()=>{
 it('renders Markdown, retains source, hides only complete frontmatter and strips terminal actions',()=>{
  const reader=new DocumentReader();const source='---\nstatus: proposed\n---\n'+body+'\x1b[2J\x1b]52;c;evil\x07';
  const lines=reader.render(source,[],100,10000,0).lines;const text=plain(lines.join('\n'));
  expect(text).toContain('Heading 漢字');expect(text).toContain('strong');expect(text).not.toContain('**strong**');expect(text).not.toContain('status: proposed');expect(text).toContain('const answer');expect(lines.join('\n')).not.toContain('\x1b]');expect(lines.join('\n')).not.toContain('\x1b[2J');
  reader.toggle();const raw=plain(reader.render(source,[],100,10000,0).lines.join('\n'));expect(raw).toContain('status: proposed');expect(raw).toContain('**strong**');
  expect(documentBody('---\nNo ending delimiter')).toBe('---\nNo ending delimiter');expect(documentBody('---\nOrdinary prose\n---\nBody')).toBe('---\nOrdinary prose\n---\nBody');
  reader.reset();expect(reader.sourceView).toBe(false);
 });
 it('bounds width, scroll and resize, invalidates theme caches and guards large Markdown',()=>{
  const reader=new DocumentReader();
  for(const width of [1,8,25,80]) {const result=reader.render(body,[],width,20,Number.MAX_SAFE_INTEGER);expect(result.lines.length).toBeLessThanOrEqual(20);expect(result.lines.every(l=>visibleWidth(l)<=width)).toBe(true);expect(result.scroll).toBeLessThan(Number.MAX_SAFE_INTEGER);}
  const end=reader.render(body,[],80,20,Number.MAX_SAFE_INTEGER);expect(plain(end.lines.join('\n'))).toContain('TAIL_MARKER');
  reader.invalidate();expect(reader.render(body,[],80,20,0).scroll).toBe(0);
  expect(reader.render('x'.repeat(131073),[],80,20,0).lines.join('\n')).toContain('128 KiB');
 });
 it.each([['plans',openPlansNavigator],['contracts',openContractsNavigator]] as const)('drives actual %s overlay Enter, source toggle, paging and back without modifying files',async(kind,open)=>{
  if(kind==='plans')planCreate(cwd,'Markdown live',body);else contractCreate(cwd,{name:'Markdown live',type:'api',producer:'architect',consumer:'worker',content:body});
  const dir=path.join(cwd,'.pi-workflow',kind);const file=path.join(dir,fs.readdirSync(dir)[0]);const before=fs.readFileSync(file,'utf8');
  const theme={fg:(_k:string,s:string)=>s,bg:(_k:string,s:string)=>s,bold:(s:string)=>s};let closed=false;
  const ui={custom:async(factory:Function)=>{
   const component=factory({terminal:{rows:40},requestRender:vi.fn()},theme,{},()=>{closed=true;});
   const text=()=>plain(component.render(100).join('\n'));
   component.handleInput('\r');expect(text()).toContain('Markdown · v toggle');expect(text()).not.toContain('**strong**');
   component.handleInput('v');expect(text()).toContain('Source · v toggle');expect(text()).toContain('**strong**');
   if(kind==='contracts')expect(text()).toContain('producer: architect');
   component.handleInput('\x1b[6~');expect(text()).not.toContain('**strong**');
   component.handleInput('\x1b[F');expect(text()).toContain('TAIL_MARKER');
   component.handleInput('v');expect(text()).toContain('Markdown · v toggle');
   component.invalidate();expect(text()).toContain('Heading');
   for(const width of [8,30,80])expect(component.render(width).every((line:string)=>visibleWidth(line)<=width)).toBe(true);
   component.handleInput('\x1b[D');expect(text()).toContain('ID');component.handleInput('\r');expect(text()).toContain('Markdown · v toggle');component.handleInput('q');expect(closed).toBe(true);
  }} as unknown as ExtensionUIContext;
  await open({} as ExtensionAPI,cwd,ui);expect(fs.readFileSync(file,'utf8')).toBe(before);
 });
});
