const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createBulkTagging, parsePeriod } = require('../bulk-tagging.cjs');
const period = parsePeriod('2025-09-01', '2025-09-30');
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, status: 5, groupId: 8, closedDate: '2025-09-15T10:00:00Z', ...extra });
function setup(overrides = {}) {
 const state = { calls: [], writes: [], ai: [], tasks: [task(1)], current: task(1), group: 'Обычный проект', enabled: true };
 const deps = {
  request: async(method, url, body) => {
   state.calls.push({method, url, body});
   if (url === '/tasks/search') return { data: state.tasks, meta: { hasMore: false } };
   if (url.startsWith('/workgroups/')) return {data:{name:state.group}};
   return {data:state.current};
  },
  normalizeTask: response => response.data,
  normalizeTasks: response => response.data,
  getGroupId: task => task.groupId,
  getGroupName: task => task.groupName || task.group?.name || task.group?.NAME,
  isCollab: name => String(name || '').toLowerCase().includes('коллаб'),
  excludedGroupIds: new Set(['12','58','92','140','376','490']),
  enabled: () => state.enabled,
  classify: async(id, validate) => { state.ai.push(id); const reason=await validate(state.current);return reason ? {skipped:true,reason} : {tagClassification:{found:true,type:'консультация',products:[],objects:[]}}; },
  updateTags: async(id, classification, current) => {state.writes.push({id,classification,current});return {updated:true,tags:['manual','type: консультация']};},
  deadline: fn => fn(), ...overrides,
 };
 return {state, deps, bulk:createBulkTagging(deps)};
}
async function waitUntil(predicate) { for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}throw Error('Job did not settle'); }
async function select(bulk) { const job=bulk.createSelection(period.from,period.to);await waitUntil(()=>job.status!=='selecting');return job; }
async function route(bulk, url, method='GET', body='') {
 const req=Readable.from(body ? [body] : []);Object.assign(req,{url,method,headers:{}});
 let status, result;
 await bulk.handle(req,{writeHead(code){status=code;},end(data){result=JSON.parse(data);}});
 return {status,result};
}
test('validates calendar dates and inclusive Moscow bounds',()=>{
 assert.equal(new Date(period.start).toISOString(),'2025-08-31T21:00:00.000Z');
 assert.equal(new Date(period.end).toISOString(),'2025-09-30T21:00:00.000Z');
 for(const dates of [['2025-02-30','2025-03-01'],['2025-10-01','2025-09-01'],['','2025-09-01'],['2025-9-01','2025-09-01']])assert.throws(()=>parsePeriod(...dates),{statusCode:400});
 assert.equal(parsePeriod('2024-02-29','2024-02-29').end-parsePeriod('2024-02-29','2024-02-29').start,86400000);
});
test('selection paginates short pages using hasMore, deduplicates, and sends server group/date filters',async()=>{
 const {state,deps}=setup();
 const original=deps.request;
 deps.request=async(method,url,body)=>url==='/tasks/search' ? (state.calls.push({method,url,body}), {data:body.offset===0?[task(1),task(2)]:[task(2),task(3)],meta:{hasMore:body.offset===0}}) : original(method,url,body);
 const bulk=createBulkTagging(deps),job=await select(bulk);
 assert.equal(job.status,'ready');assert.deepEqual(job.tasks.map(t=>t.id),['1','2','3']);assert.equal(state.writes.length,0);assert.equal(state.ai.length,0);
 const calls=state.calls.filter(c=>c.url==='/tasks/search');assert.deepEqual(calls.map(c=>c.body.offset),[0,2]);
 assert.equal(calls[0].body.autoWindow,false);assert.equal('realStatus' in calls[0].body.filter,false);assert.equal('status' in calls[0].body.filter,false);
 assert.deepEqual(calls[0].body.filter.groupId.$nin,[0,12,58,92,140,376,490]);
 assert.deepEqual(calls[0].body.filter.closedDate,{$gte:'2025-08-31T21:00:00.000Z',$lt:'2025-09-30T21:00:00.000Z'});
});
test('selection independently excludes IDs, collabs and exact upper bound but accepts reopened tasks',async()=>{
 const {bulk,state}=setup();
 state.tasks=[task(1),task(2,{groupId:12}),task(3,{groupName:'Коллаб партнёров'}),task(4,{status:2}),task(5,{closedDate:'2025-09-30T21:00:00Z'}),task(6,{closedDate:'2025-08-31T20:59:59Z'}),task(7,{closedDate:'2025-08-31T21:00:00Z'}),task(8,{closedDate:'2025-09-30T20:59:59.999Z'})];
 const job=await select(bulk);assert.equal(job.status,'ready');assert.deepEqual(job.tasks.map(t=>t.id),['1','4','7','8']);assert.equal(job.excluded,4);
});
test('missing group name is fetched and collabs/unknown groups never reach AI',async()=>{
 for(const name of ['Коллаб проект','']){
  const {bulk,state}=setup();state.group=name;
  const result=await bulk.processTask('1',period);assert(result.skipped);assert.equal(state.ai.length,0);assert.equal(state.writes.length,0);
 }
});
test('historical task without summary is processed; fresh task and current manual tags passed to write',async()=>{
 const {bulk,state}=setup();state.current.tags=['manual'];
 const result=await bulk.processTask('1',period);assert(result.updated);assert.equal(state.ai.length,1);assert.equal(state.writes.length,1);assert.deepEqual(state.writes[0].current.tags,['manual']);
});
test('changed group or close date during AI blocks write',async()=>{
 for(const change of [{groupId:12},{closedDate:'2025-10-01T00:00:00Z'}]){
  const {state,deps}=setup();deps.classify=async()=>{Object.assign(state.current,change);return {tagClassification:{found:true}};};
  const bulk=createBulkTagging(deps);assert((await bulk.processTask('1',period)).skipped);assert.equal(state.writes.length,0);
 }
});
test('group renamed to collab while AI runs blocks write without stale cache',async()=>{
 const {state,deps}=setup();deps.classify=async()=>{state.group='Коллаб';return {tagClassification:{found:true}};};
 assert.equal((await createBulkTagging(deps).processTask('1',period)).reason,'collab_group');assert.equal(state.writes.length,0);
});
test('selection refuses incomplete and stalled pages; no partial selection can be started',async()=>{
 for(const response of [{data:[task(1)],meta:{hasMore:true,pageErrorSample:{code:'FAIL'}}},{data:[],meta:{hasMore:true}},{data:[task(1)],meta:{hasMore:true}}]){
  const {bulk}=setup({request:async()=>response});const job=await select(bulk);assert.equal(job.status,'failed');assert.throws(()=>bulk.start(job),{statusCode:409});
 }
});
test('job runs sequentially, retains errors and skips, and repeated start is idempotent',async()=>{
 const {state,deps}=setup();state.tasks=[task(1),task(2),task(3)];let inFlight=0,max=0;
 deps.classify=async id=>{inFlight++;max=Math.max(max,inFlight);await new Promise(resolve=>setImmediate(resolve));inFlight--;if(id==='2')throw Error('AI unavailable');if(id==='3')return {skipped:true,reason:'classification_empty'};return {tagClassification:{found:true}};};
 const bulk=createBulkTagging(deps),job=await select(bulk);bulk.start(job);bulk.start(job);
 await waitUntil(()=>job.status==='completed');assert.equal(max,1);assert.equal(job.updated,1);assert.equal(job.failed,1);assert.equal(job.skipped,1);assert.equal(job.results.length,3);assert.equal(state.writes.length,1);
});
test('cancel stops after current task; competing selection is rejected while running',async()=>{
 const {state,deps}=setup();state.tasks=[task(1),task(2)];let release;
 deps.classify=()=>new Promise(resolve=>{release=()=>resolve({tagClassification:{found:true}});});
 const bulk=createBulkTagging(deps),job=await select(bulk);bulk.start(job);await waitUntil(()=>release);
 assert.throws(()=>bulk.createSelection(period.from,period.to),{statusCode:409});
 const response=await route(bulk,'/tagging/cancel?jobId='+job.id,'POST');assert.equal(response.status,200);release();
 await waitUntil(()=>job.status==='cancelled');assert.equal(state.writes.length,1);assert.equal(job.results.length,1);
});
test('API works without tokens, rejects invalid dates/JSON and starts only an existing ready selection',async()=>{
 const {bulk}=setup();
 assert.equal((await route(bulk,'/tagging/select','POST','no-json')).status,400);
 assert.equal((await route(bulk,'/tagging/select','POST','{}')).status,400);
 assert.equal((await route(bulk,'/tagging/start?jobId=missing','POST')).status,404);
 const response=await route(bulk,'/tagging/select','POST',JSON.stringify({from:period.from,to:period.to}));assert.equal(response.status,202);
 const job=bulk.jobs.get(response.result.job_id);await waitUntil(()=>job.status==='ready');
 assert.equal((await route(bulk,'/tagging/status?jobId='+job.id+'&offset=-1')).status,400);
 assert.equal((await route(bulk,'/tagging/start?jobId='+job.id,'GET')).status,404);
 assert.equal((await route(bulk,'/tagging/job?jobId='+job.id,'DELETE')).status,200);assert.equal(bulk.jobs.size,0);
});
test('tagging disabled blocks selection and historical writes',async()=>{
 const {bulk,state}=setup();state.enabled=false;
 assert.throws(()=>bulk.createSelection(period.from,period.to),{statusCode:409});assert.equal((await bulk.processTask('1',period)).reason,'tagging_disabled');assert.equal(state.ai.length,0);
});

test('unknown group after workgroup 404 and task fallback is excluded while later pages continue',async()=>{
 const {state,deps}=setup();const original=deps.request;let groupCalls=0;
 deps.request=async(method,url,body)=>{
  if(url==='/tasks/search')return {data:body.offset===0?[task(1,{groupId:276}),task(2,{groupId:276})]:[task(3)],meta:{hasMore:body.offset===0}};
  if(url==='/tasks/1'||url==='/tasks/2')return {data:task(Number(url.split('/').pop()),{groupId:276})};
  if(url==='/workgroups/276'){groupCalls++;throw Object.assign(Error('workgroup 276 not found'),{statusCode:404,apiCode:'ENTITY_NOT_FOUND'});}
  return original(method,url,body);
 };
 const bulk=createBulkTagging(deps),job=await select(bulk);
 assert.equal(job.status,'ready');assert.equal(job.found,3);assert.equal(job.excluded,2);assert.deepEqual(job.tasks.map(t=>t.id),['3']);assert.equal(job.excludedReasons.group_unknown,2);assert.equal(groupCalls,1);assert.equal(state.ai.length,0);assert.equal(state.writes.length,0);
});
test('group disappearing before analysis or before write skips task without writing tags',async()=>{
 for(const disappearsAfterAI of [false,true]){
  const {state,deps}=setup();const original=deps.request;let missing=!disappearsAfterAI;
  deps.request=async(method,url,body)=>{if(url.startsWith('/workgroups/')&&missing)throw Object.assign(Error('Not found'),{statusCode:404});return original(method,url,body);};
  deps.classify=async()=>{state.ai.push('1');missing=true;return {tagClassification:{found:true}};};
  const result=await createBulkTagging(deps).processTask('1',period);
  assert.equal(result.reason,'group_unknown');assert.equal(state.writes.length,0);assert.equal(state.ai.length,disappearsAfterAI?1:0);
 }
});
test('group authentication and transient API failures remain visible, not treated as missing groups',async()=>{
 for(const statusCode of [401,403,429,500,503]){
  const {deps}=setup();const original=deps.request;
  deps.request=async(method,url,body)=>{if(url.startsWith('/workgroups/'))throw Object.assign(Error('API failure'),{statusCode});return original(method,url,body);};
  const job=await select(createBulkTagging(deps));assert.equal(job.status,'failed');assert.equal(job.error,'API failure');assert.equal(job.excluded,0);
 }
});

test('tagging ignores current or changed status when close date remains in range',async()=>{
 for(const status of [2,3,5,undefined]){
  const {state,deps}=setup();state.current.status=status;
  deps.classify=async()=>{state.current.status=2;return {tagClassification:{found:true}};};
  const result=await createBulkTagging(deps).processTask('1',period);
  assert.equal(result.updated,true);assert.equal(state.writes.length,1);
 }
});

test('group zero is excluded from selection for numeric and string IDs without group lookups',async()=>{
 const {bulk,state}=setup();state.tasks=[task(1,{groupId:0}),task(2,{groupId:'0'}),task(3)];
 const job=await select(bulk);assert.equal(job.status,'ready');assert.deepEqual(job.tasks.map(t=>t.id),['3']);assert.equal(job.excludedReasons.excluded_group,2);
 assert(!state.calls.some(call=>call.url==='/workgroups/0'));assert.equal(state.ai.length,0);assert.equal(state.writes.length,0);
 assert(bulk.publicJob(job).excluded_groups.includes('0'));
});
test('group zero blocks analysis and moving to group zero during AI blocks writes',async()=>{
 for(const movesDuringAI of [false,true]){
  const {state,deps}=setup();if(!movesDuringAI)state.current.groupId=0;
  deps.classify=async()=>{state.ai.push('1');state.current.groupId='0';return {tagClassification:{found:true}};};
  const result=await createBulkTagging(deps).processTask('1',period);
  assert.equal(result.reason,'excluded_group');assert.equal(state.ai.length,movesDuringAI?1:0);assert.equal(state.writes.length,0);
 }
});

test('accessible task with embedded ordinary group is accepted without requesting workgroup endpoint',async()=>{
 const {state,deps}=setup();state.tasks=[task(1,{group:{name:'Проект'}})];state.current=state.tasks[0];
 const original=deps.request;deps.request=async(method,url,body)=>{if(url.startsWith('/workgroups/'))throw Error('Workgroup endpoint must not be used');return original(method,url,body);};
 const bulk=createBulkTagging(deps),job=await select(bulk);assert.equal(job.status,'ready');assert.equal(job.tasks.length,1);
 assert((await bulk.processTask('1',period)).updated);assert.equal(state.writes.length,1);
});
test('workgroup 404 falls back to task group on every task instead of caching a false exclusion',async()=>{
 const {state,deps}=setup();let groupReads=0;
 state.tasks=[task(1,{groupId:276}),task(2,{groupId:276}),task(3,{groupId:276})];
 deps.request=async(method,url)=>{
  if(url==='/tasks/search')return {data:state.tasks,meta:{hasMore:false}};
  if(url.startsWith('/workgroups/')){groupReads++;throw Object.assign(Error('Not found'),{statusCode:404});}
  const id=Number(url.split('/').pop());return {data:task(id,{groupId:276,group:{NAME:id===2?'Коллаб партнёров':'Проект'}})};
 };
 const bulk=createBulkTagging(deps),job=await select(bulk);
 assert.equal(job.status,'ready');assert.deepEqual(job.tasks.map(t=>t.id),['1','3']);assert.equal(job.excludedReasons.collab_group,1);assert.equal(groupReads,1);
 assert.deepEqual(bulk.publicJob(job).excluded_group_details,[{group_id:276,reason:'collab_group',count:1}]);
 assert((await bulk.processTask('1',period)).updated);
});
test('embedded group changing to collab before write still blocks tagging',async()=>{
 const {state,deps}=setup();state.current.group={name:'Проект'};
 deps.classify=async()=>{state.current.group.name='Коллаб';return {tagClassification:{found:true}};};
 assert.equal((await createBulkTagging(deps).processTask('1',period)).reason,'collab_group');assert.equal(state.writes.length,0);
});
test('40-task regression: 404 on group lookup does not discard 20 accessible ordinary tasks',async()=>{
 const {deps}=setup();
 deps.request=async(method,url)=>{
  if(url==='/tasks/search')return {data:Array.from({length:40},(_,i)=>task(i+1,{groupId:i<10?8:276})),meta:{hasMore:false}};
  if(url==='/workgroups/8')return {data:{name:'Проект'}};
  if(url==='/workgroups/276')throw Object.assign(Error('Not found'),{statusCode:404});
  const id=Number(url.split('/').pop());return {data:task(id,{groupId:276,group:{name:id>30?'Коллаб':'Проект'}})};
 };
 const job=await select(createBulkTagging(deps));assert.equal(job.status,'ready');assert.equal(job.found,40);assert.equal(job.tasks.length,30);assert.equal(job.excluded,10);assert.equal(job.excludedReasons.collab_group,10);
});
