import {expect,test} from "bun:test";
import {ApiGate, GateUnavailable, TELEGRAM_GATE_POLICY as P, type GateClock} from "../src/channels/api-gate.ts";
import {enclosure,interval,systemClock} from "../src/channels/api-clock.ts";
import {telegramRateLimitDelay} from "../src/channels/messaging.ts";
import {FakeClock,memoryStore,rawGate,flush} from "./fixtures/issuance.ts";
const start=()=>({started:true as const,value:undefined});

class NativeModel extends FakeClock {
 override exact=false;
 override rate:readonly [bigint,bigint]=[1n,1000n];
 ns=999900n;
 override observeNs=()=>{this.hook?.();return this.ns;};
 set(ms:number){this.ns=BigInt(ms)*1000000n;this.t=ms;}
}
test("P1/P2: BigInt enclosure, checked deadlines, upward physical-rate margins and rejected fast-clock trace",()=>{
 expect(enclosure(9007199254999999n)).toEqual({lo:9007199254,hi:9007199255});
 expect(Math.floor(Number(9007199254999999n)/1e6)).toBe(9007199255); // negative control
 expect(()=>enclosure(BigInt(Number.MAX_SAFE_INTEGER)*1000000n)).toThrow(GateUnavailable);
 for(const [d,n] of [[40,41],[1000,1001],[60000,60060],[4000,4004]])expect(interval(d!,[1n,1000n])).toBe(n!);
 expect(telegramRateLimitDelay("1.0000000000000000001",null)).toBe(1001);
 expect(telegramRateLimitDelay("1e9999",null)).toBe(Infinity);
 expect(telegramRateLimitDelay("Wed, 21 Oct 2015 07:28:00 GMT",null)).toBe(Infinity);
 // Malformed headers (some of which Date.parse accepts) are ignored; the valid body lower bound applies.
 for (const junk of ["1,5","soon 1","1 2","abc","-3"]) expect(telegramRateLimitDelay(junk,"2")).toBe(2000);
 expect(telegramRateLimitDelay(".5",null)).toBe(1000);
 expect(telegramRateLimitDelay("1,5",null)).toBe(1000);
 for(const rate of [999n,1000n,1001n])for(const phase of [0n,1n,999900n,999999n])for(const same of [true,false]){
  const c=new NativeModel(),m=memoryStore();c.ns=phase;const g=rawGate(c,m);const calls:bigint[]=[];
  const launch=()=>{calls.push(c.ns);return start();};
  expect(g.final("a",launch).started).toBe(true);
  const d=same?1000:40, transformed=interval(d,[1n,1000n]);
  c.set(transformed);expect(g.final(same?"a":"b",launch).started).toBe(false);
  c.set(transformed+1);expect(g.final(same?"a":"b",launch).started).toBe(true);
  // Physical ns = RAW ns * 1000/rate. Exact rational oracle, no floating-point ms comparison.
  expect((calls[1]!-calls[0]!)*1000n>=BigInt(d)*1000000n*rate).toBe(true);g.close();
 }
 expect((41000000n-999900n)*1000n < 40000000n*1001n).toBe(true); // original unsafe unconverted grant
});
test("P2: 21st write and physical 4s typing boundary use converted windows, not RAW milliseconds",async()=>{
 const c=new NativeModel(),m=memoryStore(),g=rawGate(c,m);const calls:bigint[]=[];
 const launch=()=>{calls.push(c.ns);return start();};
 for(let i=0;i<20;i++){if(i)c.set(i*1002);expect(g.final("a",launch).started).toBe(true);}
 c.set(60060);expect(g.final("a",launch).started).toBe(false);c.set(60061);expect(g.final("a",launch).started).toBe(true);
 expect((calls[20]!-calls[0]!)*1000n>=60000000000n*1001n).toBe(true);g.releaseDemand("a");
 c.set(70000);const off=g.registerTyping("a","1"),control=new AbortController();
 expect((await g.progress("a",false,control.signal,launch,0,"1")).started).toBe(true);
 c.set(74004);expect((await g.progress("a",false,control.signal,launch,0,"1")).started).toBe(false);
 c.set(74005);expect((await g.progress("a",false,control.signal,launch,0,"1")).started).toBe(true);
 expect((calls.at(-1)!-calls.at(-2)!)*1000n>=4000000000n*1001n).toBe(true);off();g.close();
});
test("P3/P5/P8: suspend180s then commit120s same-boot restart; repeated sleep, reboot, unknown and full duration merge",()=>{
 const c=new NativeModel();c.set(10000);const m=memoryStore();let g=rawGate(c,m);
 expect(g.final("a",start).started).toBe(true);
 // Suspend advances physical time but RAW excludes it. Receipt occurs after resume, same shared RAW value.
 expect(g.rateLimited(120000)).toBe(false);const saved=m.snapshot().server;g.close();
 for(let i=0;i<20;i++){expect(()=>rawGate(c,m)).toThrow("blocked");expect(m.snapshot().server).toEqual(saved);}
 c.set(130120);expect(()=>rawGate(c,m)).toThrow("blocked");c.set(130121);g=rawGate(c,m);expect(g.final("a",start).started).toBe(true);g.close();
 c.frame="reboot";c.set(0);g=rawGate(c,m);expect(m.live).toHaveLength(0);expect(g.final("other",start).started).toBe(false);c.set(60061);expect(g.final("other",start).started).toBe(true);g.close();
 const d=new FakeClock(0),n=memoryStore();g=rawGate(d,n);g.rateLimited(60000);d.t=59000;g.rateLimited(2000);expect(n.snapshot().server).toEqual({b:59000,d:60000,blocked:false});g.close();
 d.frame="new";g=rawGate(d,n);expect(n.snapshot().server).toEqual({b:59000,d:60000,blocked:false});g.rateLimited(Infinity);g.close();
 for(let i=0;i<5;i++){d.frame="foreign"+i;expect(()=>rawGate(d,n)).toThrow("blocked");expect(n.snapshot().server).toEqual({unknown:true,reason:"unrepresentable server bound"});}
});
test("P4/P11: 100 foreign epochs, 1000 old keys then 502 new keys; one hold, zero rebased keys, bounded history",()=>{
 const c=new NativeModel(),m=memoryStore();c.set(0);let g=rawGate(c,m),peak=0;
 for(let epoch=0;epoch<100;epoch++){
  if(epoch){g.close();c.frame="boot"+epoch;c.set(0);g=rawGate(c,m);expect(m.live).toHaveLength(0);expect(g.health().api_rate_keys).toBe(0);expect(g.final("during-hold",start).started).toBe(false);g.releaseDemand("during-hold");c.set(60061);}
  for(let i=0;i<1502;i++){const r=g.final(epoch+":"+i,start);if(!r.started){c.set(r.at);expect(g.final(epoch+":"+i,start).started).toBe(true);}peak=Math.max(peak,m.live.length,g.health().api_history!);c.set(c.t+42);}
  expect(m.live.length).toBeLessThanOrEqual(1466);
 }
 expect(peak).toBeLessThanOrEqual(1466);g.close();console.log("foreign-epochs=100 starts=150200 retained-peak="+peak+" limit=1466");
},30000);
test("P5: NULL last reconstructs once after arbitrary slow commit and snapshot crash points",()=>{
 const c=new FakeClock(0),m=memoryStore();const reserve=m.store.reserve;m.store.reserve=(...a)=>{reserve(...a);c.t+=2000;};
 let g=rawGate(c,m);expect(g.final("a",start).started).toBe(true);g.close();expect(m.live[0]!.stamp).toBeNull();
 g=rawGate(c,m);const stamp=m.live[0]!.stamp;expect(stamp).toBe(2000);g.close();c.t+=10;g=rawGate(c,m);expect(m.live[0]!.stamp).toBe(stamp);expect(g.final("a",start).started).toBe(false);g.close();
});
test("P6/P7: full-frame reentry denial, close veto, pre/post clock failure and raw adoption survives failure",async()=>{
 for(const injection of ["observe","reserve","start","post"]){
  const c=new FakeClock(0),m=memoryStore();let calls=0,nested=0;const g=rawGate(c,m);const control=new AbortController();
  const reenter=()=>{expect(g.final("nested",()=>{nested++;return start();}).started).toBe(false);void g.poll(control.signal,()=>{nested++;return start();});void g.progress("n",true,control.signal,()=>{nested++;return start();});g.health();};
  if(injection==="observe")c.hook=reenter;
  if(injection==="reserve"){const reserve=m.store.reserve;m.store.reserve=(...a)=>{reenter();reserve(...a);};}
  expect(g.final("a",()=>{if(injection==="start")reenter();if(injection==="post")c.hook=reenter;calls++;return start();}).started).toBe(true);
  await flush();expect(nested).toBe(0);expect(calls).toBe(1);c.hook=undefined;c.t=1000;expect(g.final("a",start).started).toBe(true);g.close();expect(c.pending).toBe(0);
 }
 const c=new FakeClock(0),m=memoryStore(),g=rawGate(c,m);const reserve=m.store.reserve;m.store.reserve=(...a)=>{reserve(...a);g.close();};let invoked=0;
 expect(g.final("a",()=>{invoked++;return start();}).started).toBe(false);expect(invoked).toBe(0);
 for(const failure of ["throw","decrease","range"]){
  const c=new NativeModel(),m=memoryStore(),g=rawGate(c,m);let resolve!:()=>void;const raw=new Promise<void>(r=>resolve=r);const owned=new Set<Promise<void>>();
  const r=g.final("a",()=>{owned.add(raw);void raw.then(()=>owned.delete(raw));c.hook=()=>{if(failure==="throw")throw new Error("read failure");c.ns=failure==="range"?BigInt(Number.MAX_SAFE_INTEGER)*1000000n:0n;};return {started:true,value:raw};});
  expect(r.started).toBe(true);expect(g.health().api_closed).toBe(1);expect(m.live[0]!.stamp).toBeNull();expect(owned.size).toBe(1);expect(g.final("b",start).started).toBe(false);resolve();await raw;expect(owned.size).toBe(0);g.close();
 }
});
test("P10/P11/P12: typing churn count fairness, member deletion, single maintenance timer and unsafe state rejection",async()=>{
 const c=new FakeClock(0),m=memoryStore(),g=rawGate(c,m);const control=new AbortController(),off=Array.from({length:16},(_,i)=>g.registerTyping("a",String(i))),served:number[]=[];
 for(let round=0;round<16;round++){
  for(let i=0;i<16;i++){await g.progress("a",false,control.signal,()=>{served.push(i);return start();},0,String(i));}
  expect(g.health().api_typing_members).toBe(16);await c.advance(4000);
 }
 expect(served.slice(0,16)).toEqual(Array.from({length:16},(_,i)=>i));for(const f of off)f();expect(g.health().api_typing_members).toBe(0);expect(c.pending).toBe(1);await c.advance(60000);expect(g.health().api_history).toBe(0);expect(m.live).toHaveLength(0);expect(c.pending).toBe(0);g.close();
 for(const bad of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1,Number.MAX_SAFE_INTEGER])expect(()=>rawGate(new FakeClock(0),memoryStore({lastSeq:bad}))).toThrow();
 const unavailable=new FakeClock(0);unavailable.hook=()=>{throw new Error("clock unavailable");};expect(()=>rawGate(unavailable)).toThrow("clock unavailable");
});
test("native provider reads shared RAW directly and ignores wall jumps (not a host P3 certification)",()=>{
 const c=systemClock(),wall=Date.now;const n=c.observeNs();try{Date.now=()=>wall()+86400000;expect(c.observeNs()>=n).toBe(true);const m=memoryStore(),g=rawGate(c,m);expect(g.final("a",start).started).toBe(true);g.rateLimited(60000);Date.now=()=>wall()-86400000;expect(g.final("a",start).started).toBe(false);g.close();}finally{Date.now=wall;}
});
