import type { Database } from "bun:sqlite";
import { GateUnavailable, integer, interval } from "./api-clock.ts";
import type { GateRecord, GateSnapshot, GateStore, ServerWait } from "./api-gate.ts";

/** Uses the engine's exclusive FULL-synchronous connection. Never opens a second owner. */
export function sqliteGateStore(db: Database): {store: GateStore; snapshot: GateSnapshot} {
 const get=(name: string)=>db.query<{value:string},[string]>("SELECT value FROM settings WHERE name=?").get(name)?.value;
 const save=(name: string,value: unknown)=>db.query("INSERT INTO settings(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(name,JSON.stringify(value));
 const raw=get("api_state_v3");
 let state: Omit<GateSnapshot,"records">=raw===undefined?{lastSeq:0,legacy:get("api_legacy_used")==="true"}:JSON.parse(raw);
 if(typeof state!=="object" || state===null)throw new GateUnavailable("Corrupt API snapshot");
 integer(state.lastSeq);
 if(raw===undefined) {
  const blocked=get("api_blocked_until"),cooldown=get("api_cooldown_until");
  if(blocked!==undefined) state.server={unknown:true,reason:"legacy blocked duration unknown"};
  else if(cooldown!==undefined) { if(!Number.isSafeInteger(Number(cooldown)))throw new GateUnavailable("Corrupt legacy cooldown"); state.server={b:0,d:60000,blocked:false}; }
  if(state.server)state.legacy=true;
 }
 const columns=new Set(db.query<{name:string},[]>("PRAGMA table_info(api_permits)").all().map(c=>c.name));
 db.transaction(()=>{
  if(!columns.has("stamp"))db.exec("ALTER TABLE api_permits ADD COLUMN stamp INTEGER; ALTER TABLE api_permits ADD COLUMN kind TEXT");
 })();
 let maxRecords=0;
 if(raw!==undefined) {
  try {const frame=JSON.parse(state.frame!);const rate=[BigInt(frame[1][0]),BigInt(frame[1][1])] as const;maxRecords=Math.ceil(interval(state.horizon!,rate)/interval(frame[3].botSpacingMs,rate))+1;if(!Number.isSafeInteger(maxRecords) || maxRecords<1 || maxRecords>3600001)throw new Error();}
  catch {throw new GateUnavailable("Unrecognized API snapshot frame");}
 }
 const records: GateRecord[]=[];
 // Page and validate even legacy data; never load arbitrary old keys into memory.
 for(let after=0;;) {
  const page=db.query<{seq:string;at:string;rate_key:string|null;stamp:string|null;kind:GateRecord["kind"]},[number]>("SELECT CAST(seq AS TEXT) AS seq, CAST(at AS TEXT) AS at, rate_key, CAST(stamp AS TEXT) AS stamp, kind FROM api_permits WHERE api_permits.seq>? ORDER BY api_permits.seq LIMIT 256").all(after);
  for(const r of page) {
   const number=(s:string)=>{if(!/^\d+$/.test(s))throw new GateUnavailable("Corrupt API integer encoding");const n=Number(s);integer(n);if(BigInt(s)!==BigInt(n))throw new GateUnavailable("Unsafe API integer");return n;};
   const seq=number(r.seq),b=number(r.at); after=seq;
   if(raw===undefined) {state.legacy=true;state.lastSeq=Math.max(state.lastSeq,seq);}
   else {records.push({seq,b,key:r.rate_key,stamp:r.stamp===null?null:number(r.stamp),kind:r.kind}); if(records.length>maxRecords)throw new GateUnavailable("Oversized API history");}
  }
  if(page.length<256)break;
 }
 const stamp=(r:GateRecord|undefined)=>{if(r?.stamp!==null && r!==undefined)db.query("UPDATE api_permits SET stamp=? WHERE seq=? AND stamp IS NULL").run(r.stamp,r.seq);};
 const prune=(seq:number)=>db.query("DELETE FROM api_permits WHERE seq<=?").run(seq);
 const insert=(r:GateRecord)=>db.query("INSERT INTO api_permits(seq,at,rate_key,kind,stamp) VALUES (?,?,?,?,?)").run(r.seq,r.b,r.key,r.kind,r.stamp);
 const store:GateStore={
  recover(snapshot) { db.transaction(()=>{db.exec("DELETE FROM api_permits");for(const r of snapshot.records)insert(r);const {records:_,...next}=snapshot;save("api_state_v3",next);state=next;})(); },
  reserve(record,previous,pruneThrough) { const next={...state,lastSeq:record.seq};db.transaction(()=>{stamp(previous);prune(pruneThrough);insert(record);save("api_state_v3",next);})();state=next; },
  sweep(previous,pruneThrough) {db.transaction(()=>{stamp(previous);prune(pruneThrough);})();},
  cooldown(server:ServerWait) {const next={...state,server};db.transaction(()=>save("api_state_v3",next))();state=next;},
 };
 return {store,snapshot:{...state,records}};
}
