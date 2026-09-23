import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture, request } from './helpers.js';
import { createUnreadEvents, createSseParser, parseUnreadEvent } from '../integrations/opencode/unread-events.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check, label, timeout=3500) {
  const start=Date.now();
  while (!check()) {
    if (Date.now()-start>timeout) throw new Error(`Timed out waiting for ${label}`);
    await pause(10);
  }
}
// Test-only TCP source-address relay: all framing, parser, server and client core
// remain real. No mocked SSE frames, summaries or source authentication.
async function clientRelay(t, destination) {
  const requests=[];
  const streams=new Set();
  const proxy=http.createServer((req,res)=>{
    const record={path:req.url,headers:req.headers,events:[],raw:''};
    requests.push(record);
    const upstream=http.request(new URL(req.url,destination()),{
      method:req.method,localAddress:'127.0.0.2',agent:false,headers:req.headers,
    },response=>{
      res.writeHead(response.statusCode,response.headers);
      const parser=createSseParser(frame=>record.events.push(parseUnreadEvent(frame)));
      response.on('data',bytes=>{record.raw+=bytes.toString('utf8');parser.push(bytes);});
      response.pipe(res);
    });
    streams.add(upstream);
    upstream.on('close',()=>{streams.delete(upstream);if (!res.destroyed) res.destroy();});
    upstream.on('error',()=>{if (!res.headersSent) res.writeHead(502);res.end();});
    res.on('close',()=>upstream.destroy());
    req.on('aborted',()=>upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    for(const stream of streams) stream.destroy();
    proxy.closeAllConnections();
    await new Promise(resolve=>proxy.close(resolve));
  });
  return {url:`http://127.0.0.1:${proxy.address().port}`,requests,
    disconnect(){for(const stream of streams) stream.destroy();}};
}
function startClient(t,relay) {
  const toasts=[];
  const calls=[];
  const client=createUnreadEvents({baseUrl:relay.url,
    fetchImpl:(url,init)=>{calls.push({url,headers:init.headers});return fetch(url,init);},
    toast:count=>toasts.push(count),retryBaseMs:25,retryMaxMs:25,random:()=>1});
  client.start();t.after(()=>client.stop());
  return {client,toasts,calls};
}
const sent=async(f,body)=>{
  const response=await request(`${f.url}/api/messages`,'127.0.0.1','POST',body);
  assert.equal(response.status,201);
  return response.data.id;
};
const count=client=>client.getState().summary?.total;
const checkPaths=(relay,calls)=>{
  assert.ok(calls.length>0);
  assert.ok(calls.every(c=>new URL(c.url).pathname==='/api/unread-events'));
  assert.ok(relay.requests.every(r=>r.path==='/api/unread-events'));
};

test('real stream: fresh seq0 snapshot, global sequence gaps, 500ms merge, two devices read; no content/summary polling',async t=>{
  const f=await fixture(t),relay=await clientRelay(t,()=>f.url);
  const first=startClient(t,relay),second=startClient(t,relay);
  await until(()=>first.client.getState().summary&&second.client.getState().summary,'initial snapshots');
  assert.equal(count(first.client),0);assert.equal(count(second.client),0);
  assert.deepEqual(first.toasts,[]);assert.deepEqual(second.toasts,[]);
  assert.equal(first.calls[0].headers['Last-Event-ID'],undefined);
  assert.equal(relay.requests[0].events[0].reason,'snapshot');
  assert.match(relay.requests[0].events[0].cursor,/^[\da-f-]{36}:0$/);
  const id1=await sent(f,{to:'B',title:'PRIVATE_TITLE_1',text:'PRIVATE_BODY_1'});
  await sent(f,{to:'C',title:'OTHER_TITLE',text:'OTHER_BODY'}); // global seq gap for B
  const id2=await sent(f,{to:'B',title:'PRIVATE_TITLE_2',text:'PRIVATE_BODY_2'});
  await until(()=>count(first.client)===2&&count(second.client)===2,'both devices count 2');
  await until(()=>relay.requests.every(r=>r.events.length>=3),'parsed message frames');
  const firstFrames=relay.requests[0].events;
  assert.deepEqual(firstFrames.slice(1).map(e=>e.reason),['message','message']);
  const seq=firstFrames.map(e=>Number(e.cursor.split(':')[1]));
  assert.deepEqual(seq,[0,1,3]); // C's commit consumes seq 2, never delivered to B.
  await until(()=>first.toasts.length===1&&second.toasts.length===1,'merged notification',1800);
  assert.deepEqual(first.toasts,[2]);assert.deepEqual(second.toasts,[2]);
  const marked=await request(`${f.url}/api/messages/mark-read`,'127.0.0.2','POST',{ids:[id1,id2]});
  assert.equal(marked.data.markedCount,2);
  await until(()=>count(first.client)===0&&count(second.client)===0,'read on both devices');
  await pause(550);
  assert.deepEqual(first.toasts,[2]);assert.deepEqual(second.toasts,[2]);
  checkPaths(relay,[...first.calls,...second.calls]);
  const wirePaths=relay.requests.map(r=>r.raw).join('');
  for(const secret of ['PRIVATE_TITLE_1','PRIVATE_BODY_1','PRIVATE_TITLE_2','PRIVATE_BODY_2'])
    assert.ok(!wirePaths.includes(secret));
  assert.equal(f.app.db.prepare('SELECT read_at FROM messages WHERE id=?').get(id1).read_at!==null,true);
});

test('real reconnect replays only unprocessed cursor and dedupes snapshot, restart epoch resets with no historical toast',async t=>{
  const f=await fixture(t),relay=await clientRelay(t,()=>f.url);
  const {client,toasts,calls}=startClient(t,relay);
  await until(()=>count(client)===0,'fresh snapshot');
  const initialCursor=relay.requests[0].events[0].cursor;
  // Force transport loss with the last processed cursor still at seq 0.
  relay.disconnect();await until(()=>client.getState().error,'disconnect');
  await sent(f,{to:'B',title:'PRIVATE_REPLAY',text:'PRIVATE_REPLAY_BODY'});
  await until(()=>calls.length>=2&&count(client)===1,'replayed event');
  assert.equal(calls[1].headers['Last-Event-ID'],initialCursor);
  await until(()=>relay.requests[1].events.length>=2,'replay plus snapshot');
  assert.deepEqual(relay.requests[1].events.map(e=>e.reason),['message','snapshot']);
  assert.equal(relay.requests[1].events[1].cursor,relay.requests[1].events[0].cursor);
  await until(()=>toasts.length===1,'one replay notification',1800);
  assert.deepEqual(toasts,[1]);
  // Duplicate snapshot delivered after replay must not notify again.
  await pause(550);assert.deepEqual(toasts,[1]);
  await f.restart();
  await until(()=>calls.length>=3&&client.getState().summary?.total===1&&!client.getState().error,
    'new epoch reset');
  await until(()=>relay.requests[2].events.length>=1,'epoch frame');
  assert.equal(relay.requests[2].events[0].reason,'reset');
  assert.equal(relay.requests[2].events[0].summary.total,1);
  assert.equal(Number(relay.requests[2].events[0].cursor.split(':')[1]),0);
  assert.notEqual(relay.requests[2].events[0].cursor.split(':')[0],initialCursor.split(':')[0]);
  await pause(550);assert.deepEqual(toasts,[1]);
  assert.notEqual(calls[2].headers['Last-Event-ID'],undefined);
  checkPaths(relay,calls);
});

test('real ring expiry returns reset rather than historical notifications; teardown closes streams',async t=>{
  const f=await fixture(t),relay=await clientRelay(t,()=>f.url);
  const {client,toasts,calls}=startClient(t,relay);
  await until(()=>count(client)===0,'seq0 snapshot');
  relay.disconnect();client.stop();
  for(let i=0;i<130;i++) await sent(f,{to:'B',title:'batch',text:'body'});
  assert.deepEqual(toasts,[]);
  client.start();
  await until(()=>count(client)===130,'expired cursor reset',4500);
  assert.equal(relay.requests.at(-1).events[0].reason,'reset');
  assert.equal(relay.requests.at(-1).events[0].summary.total,130);
  assert.match(calls.at(-1).headers['Last-Event-ID'],/^[\da-f-]{36}:0$/);
  await pause(550);assert.deepEqual(toasts,[]);
  client.stop();
  await f.app.close();
  await until(()=>relay.requests.length>=2,'reconnection exercised');
  checkPaths(relay,calls);
});
