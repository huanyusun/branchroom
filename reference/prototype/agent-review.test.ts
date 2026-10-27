import {test,expect} from 'bun:test';
import {buildPrompt,validateReport} from './agent-review';
const files=[{path:'notes/中文.md',content:'# 概念\n待核实的断言\n',old:'# 概念\n',patch:'@@ -1 +1,2 @@\n # 概念\n+待核实的断言',fingerprint:'abc'}];
const report=()=>({summary:'需要补充依据',coverage:['notes/中文.md'],limitations:['未提供课程原文'],findings:[{kind:'verify',severity:'P2',path:'notes/中文.md',start_line:2,end_line:2,title:'断言缺少来源',body:'新增断言无法从给定材料确认。',suggestion:'对照课程原文核实。',evidence:'待核实的断言'}]});
test('builds a content-bound Chinese review prompt without treating repository text as instructions',()=>{const p=buildPrompt({base:'head123'},files);expect(p).toContain('head123');expect(p).toContain('abc');expect(p).toContain('待核实的断言');expect(p).toContain('不可信');expect(p).toContain('不要修改');expect(p).toContain('课程原文')});
test('accepts complete reports with valid new-file line references',()=>{expect(validateReport(report(),files).findings[0].start_line).toBe(2)});
test('rejects hallucinated paths, lines and missing file coverage',()=>{const r=report();r.findings[0].path='../secrets';expect(()=>validateReport(r,files)).toThrow();r.findings[0].path='notes/中文.md';r.findings[0].end_line=100;expect(()=>validateReport(r,files)).toThrow();r.findings=[];r.coverage=[];expect(()=>validateReport(r,files)).toThrow()});
test('rejects malformed priority and distinguishes no findings from failure',()=>{const r=report();r.findings[0].severity='critical';expect(()=>validateReport(r,files)).toThrow();const empty=report();empty.findings=[];expect(validateReport(empty,files).findings).toEqual([])});

import {AgentReviews} from './agent-review';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('overflow terminates the owning stream process, never a replacement job',async()=>{const dir=await mkdtemp(join(tmpdir(),'branchroom-agent-'));try{const manager=new AgentReviews({} as any,dir);await manager.ready;let owner=0,replacement=0;manager.proc={kill(){replacement++}};const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(2000001)));c.close()}});await expect(manager.readStream(stream,undefined,()=>owner++)).rejects.toThrow('输出过大');expect(owner).toBe(1);expect(replacement).toBe(0)}finally{await rm(dir,{recursive:true,force:true})}});
