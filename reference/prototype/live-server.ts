import {ReviewRepo} from './review-core';
import {AgentReviews} from './agent-review';
import {join} from 'node:path';
const root=process.env.BRANCHROOM_REPO;
if(!root)throw new Error('请设置 BRANCHROOM_REPO 为要审查的本地仓库绝对路径');
const stateDir=join(import.meta.dir,'.review-data');
const repo=new ReviewRepo(root,join(stateDir,'fde-study.json'));
const agents=new AgentReviews(repo,stateDir);
const allowed=new Map([['/','live.html'],['/live.js','live.js'],['/agent-ui.js','agent-ui.js']]);
let queue=Promise.resolve();
Bun.serve({hostname:'127.0.0.1',port:7457,async fetch(req){const url=new URL(req.url);if(!['127.0.0.1:7457','localhost:7457'].includes(url.host))return new Response('Invalid host',{status:403});try{
if(url.pathname==='/api/snapshot'&&req.method==='GET')return Response.json(await repo.snapshot(),{headers:{'Cache-Control':'no-store'}});
if(url.pathname==='/api/agent-review'&&req.method==='GET')return Response.json(await agents.status(),{headers:{'Cache-Control':'no-store'}});
if(req.method==='POST'&&['/api/review','/api/agent-review','/api/agent-review/cancel'].includes(url.pathname)){
if(req.headers.get('Origin')!==url.origin||!req.headers.get('Content-Type')?.startsWith('application/json'))return new Response('Invalid origin',{status:403});
if(+(req.headers.get('Content-Length')||0)>20000)return new Response('Too large',{status:413});const raw=await req.text();if(raw.length>20000)return new Response('Too large',{status:413});const body=JSON.parse(raw);
if(url.pathname==='/api/agent-review/cancel')return Response.json(await agents.cancel());
if(url.pathname==='/api/agent-review'){if(typeof body.provider!=='string'||typeof body.scope!=='string')return new Response('Invalid request',{status:400});return Response.json(await agents.start(body.provider,body.scope,body.path,body.fingerprint))}
if(typeof body.path!=='string'||typeof body.fingerprint!=='string'||typeof body.state!=='string'||(body.note!==undefined&&typeof body.note!=='string'))return new Response('Invalid request',{status:400});const result=queue.then(()=>repo.review(body.path,body.fingerprint,body.state,body.note));queue=result.then(()=>{},()=>{});return Response.json(await result)}
const file=allowed.get(url.pathname);if(file&&req.method==='GET')return new Response(Bun.file(join(import.meta.dir,file)),{headers:{'Cache-Control':'no-store'}});return new Response('Not found',{status:404})}catch(e:any){return Response.json({error:e.message},{status:409})}}});
console.log('Branchroom live review: http://127.0.0.1:7457');
