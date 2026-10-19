import { ApiGate, type GateClock, type GatePolicy, type GateRecord, type GateSnapshot, type GateStore, TELEGRAM_GATE_POLICY } from "../../src/channels/api-gate.ts";
export async function flush() { for(let i=0;i<8;i++)await Promise.resolve(); }
export class FakeClock implements GateClock {
 t:number; frame="fake-boot"; rate:readonly [bigint,bigint]=[0n,1n]; exact=true;
 hook: (()=>void) | undefined;
 constructor(start=1800000000000){this.t=start;}
 observeNs=()=>{this.hook?.();return BigInt(this.t)*1000000n;};
 now=()=>this.t;
 #timers=new Map<number,{at:number;fn:()=>void}>(); #id=0;
 timer=(fn:()=>void,ms:number)=>{const id=++this.#id;this.#timers.set(id,{at:this.t+ms,fn});return ()=>{this.#timers.delete(id);};};
 get pending(){return this.#timers.size;}
 async advance(ms:number){const until=this.t+ms;for(;;){let next:[number,{at:number;fn:()=>void}]|undefined;for(const e of this.#timers)if(e[1].at<=until && (!next || e[1].at<next[1].at))next=e;if(!next)break;this.#timers.delete(next[0]);this.t=Math.max(this.t,next[1].at);next[1].fn();await flush();}this.t=Math.max(this.t,until);await flush();}
}
export function memoryStore(initial?:Partial<GateSnapshot>) {
 let state:GateSnapshot={records:[],lastSeq:0,...initial}; let fail=false,order=0;
 const reserved:(GateRecord & {at:number;order:number})[]=[];
 const stamp=(previous:GateRecord|undefined)=>{const r=state.records.find(r=>r.seq===previous?.seq);if(r && previous)r.stamp=previous.stamp;};
 const store:GateStore={
 recover(s){state=structuredClone(s);},
 reserve(r,previous,through){if(fail){fail=false;throw new Error("disk full");}stamp(previous);state.records=state.records.filter(r=>r.seq>through);state.records.push({...r});state.lastSeq=r.seq;reserved.push({...r,at:r.b,order:++order});},
 sweep(previous,through){stamp(previous);state.records=state.records.filter(r=>r.seq>through);},
 cooldown(server){state.server=structuredClone(server);},
 };
 return {store,reserved,snapshot:()=>structuredClone(state),get live(){return state.records;},failReserve(){fail=true;}};
}
export function rawGate(clock:GateClock,mem=memoryStore(),policy:GatePolicy=TELEGRAM_GATE_POLICY,onFailClosed=()=>{}){return new ApiGate(policy,mem.store,mem.snapshot(),{clock,onFailClosed});}
