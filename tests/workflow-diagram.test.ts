import {describe, it, expect} from "vitest";
import * as fs from "node:fs";
import {previewWorkflowDiagram, renderWorkflowDiagram} from "../extensions/workflow-diagram.ts";

const header = `export const meta = {name:'test'}; const g = graph();`;
describe("static workflow diagrams", () => {
 it("renders real Mermaid Unicode without evaluating hostile definitions or callbacks", async () => {
  const result = await renderWorkflowDiagram(`${header} throw new Error('MUST_NOT_EXECUTE'); g.node('one', command('touch /tmp/never')); g.node('two', (s)=>{throw new Error('NO');}); g.edge('one','two'); g.edge('two',END); g.run({});`);
  expect(result.mermaid).toContain('one (command)'); expect(result.lines.join('\n')).toContain('┌'); expect(result.lines.join('\n')).toContain('one -> two'); expect(result.lines.join('\n')).toContain('two -> END'); expect(result.warnings.join(' ')).toContain('incomplete');
 });
 it("marks conditional possibilities, retry loops, fan-out and unknown routes honestly", () => {
  const result = previewWorkflowDiagram(`${header} g.node('a',agent('worker',()=>'')); g.node('b',human('OK?',{options:['yes'],default:'yes'})); g.node('c',()=> ''); g.edge('a','b'); g.edge('a','c'); g.edge('b',(s,r)=> r.ok ? 'a' : END); g.edge('c',(s,r)=> r.next);`);
  expect(result.mermaid).toContain('possible route'); expect(result.lines.join('\n')).toContain('b -> a (possible)'); expect(result.lines.join('\n')).toContain('b -> END (possible)'); expect(result.lines.join('\n')).toContain('c -> UNKNOWN (dynamic)'); expect(result.mermaid).toContain('Dynamic route: unknown'); expect(result.lines.join('\n')).toContain('a -> c');
 });
 it("does not invent nodes/edges from helpers, loops or nested callbacks", () => {
  const result = previewWorkflowDiagram(`${header} for(const name of args.names) g.node(name,()=> ''); function helper(){g.node('hidden',()=> '');g.edge('hidden','a');} g.node('a',()=>{g.node('also_hidden',()=> ''); return 'x';}); g.edge(args.from,'a'); g.edge('a',choose);`);
  expect(result.mermaid).not.toContain('hidden'); expect(result.warnings.join(' ')).toContain('incomplete'); expect(result.warnings.join(' ')).toContain('Computed'); expect(result.lines.join('\n')).toContain('UNKNOWN');
 });
 it("handles syntax errors, unsupported construction and size limits without throwing", () => {
  for(const source of ['invalid {', 'const g = factory();', `${header} //${'a'.repeat(128*1024)}`, `${header}${Array.from({length:25},(_,i)=>`g.node('n${i}',()=> '');`).join('')}`]) expect(previewWorkflowDiagram(source).lines.join('\n')).toContain('unavailable');
 });
 it("bounds dense layout in a worker while the event loop stays responsive and supports cancellation", async () => {
  const source=header+Array.from({length:24},(_,i)=>`g.node('n${i}',()=> '');`).join('')+Array.from({length:60},(_,i)=>`g.edge('n${i%24}','n${(i*7+3)%24}');`).join('');
  let heartbeat=false;const timer=setTimeout(()=>{heartbeat=true;},10);const start=Date.now();
  const result=await renderWorkflowDiagram(source,undefined,100);clearTimeout(timer);expect(heartbeat).toBe(true);expect(Date.now()-start).toBeLessThan(2000);expect(result.lines.join('\n')).toContain('timed out');expect(result.lines.join('\n')).toContain('Declared routes');
  const controller=new AbortController();const pending=renderWorkflowDiagram(source,controller.signal);controller.abort();expect((await pending).lines.join('\n')).toContain('cancelled');
 });
 it("escapes label syntax and never emits terminal controls from identifiers", () => {
  const result = previewWorkflowDiagram(`${header} g.node('a[evil]\\u001b',()=> ''); g.edge('a[evil]\\u001b',END);`);
  expect(result.mermaid).not.toContain('\x1b'); expect(result.mermaid).toContain('a_evil_?');
 });
 it.each(['tdd','review_loop'])("renders bundled %s with retry direction reference", async name => {
  const result = await renderWorkflowDiagram(fs.readFileSync(`bundled-workflows/${name}.js`,'utf8'));
  expect(result.lines.join('\n')).toContain('Declared routes'); expect(result.lines.join('\n')).not.toContain('unavailable'); expect(result.mermaid).toContain('possible route');
 });
});
