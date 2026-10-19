import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sqliteGateStore} from "../src/channels/api-gate-store.ts";
import {ApiGate,TELEGRAM_GATE_POLICY as P} from "../src/channels/api-gate.ts";
import {FakeClock} from "./fixtures/issuance.ts";
const launch=()=>({started:true as const,value:undefined});
function database(path:string){const db=new Database(path);db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS api_permits(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,rate_key TEXT)");return db;}
// Functional I/O budget, not a performance target: 20 x 50 FULL-synchronous permits plus
// reopen/recovery commits exceeded Bun's default 5s on hosted CI (9.07s). Keep durability and workload intact.
test("SQLite same-frame NULL reconstruction and foreign rebase commit one hold; repeated reopen never grows old keys",()=>{
 const dir=mkdtempSync(join(tmpdir(),"issuance-db-")),path=join(dir,"gate.sqlite"),clock=new FakeClock(0);let db=database(path),g:ApiGate|undefined;
 const open=()=>{const {store,snapshot}=sqliteGateStore(db);return new ApiGate(P,store,snapshot,{clock});};
 try{
  g=open();expect(g.final("old",launch).started).toBe(true);g.close();db.close();clock.t=2000;db=database(path);g=open();
  expect((db.query("SELECT stamp FROM api_permits").get() as any).stamp).toBe(2000);g.close();db.close();clock.t=2010;db=database(path);g=open();expect((db.query("SELECT stamp FROM api_permits").get() as any).stamp).toBe(2000);g.close();
  for(let epoch=0;epoch<20;epoch++){
   clock.frame="boot"+epoch;clock.t=0;g=open();expect((db.query("SELECT count(*) AS n FROM api_permits").get() as any).n).toBe(0);expect(g.final("blocked",launch).started).toBe(false);g.releaseDemand("blocked");g.close();
   const before=JSON.parse((db.query("SELECT value FROM settings WHERE name='api_state_v3'").get() as any).value);clock.t=30000;g=open();const after=JSON.parse((db.query("SELECT value FROM settings WHERE name='api_state_v3'").get() as any).value);expect(after.hold).toEqual(before.hold);expect(g.final("blocked",launch).started).toBe(false);g.releaseDemand("blocked");clock.t=60000;
   for(let i=0;i<50;i++){expect(g.final(epoch+":"+i,launch).started).toBe(true);clock.t+=40;}
   expect((db.query("SELECT count(*) AS n FROM api_permits").get() as any).n).toBe(50);g.close();
  }
  expect((db.query("PRAGMA integrity_check").get() as any).integrity_check).toBe("ok");
 }finally{g?.close();db.close();rmSync(dir,{recursive:true,force:true});}
},30000);
test("SQLite rollback leaves previous stamp, sequence and reservation atomic; unknown server sentinel survives opens",()=>{
 const dir=mkdtempSync(join(tmpdir(),"issuance-atomic-")),db=database(join(dir,"gate.sqlite")),clock=new FakeClock(0);let g:ApiGate|undefined;
 try{
  let state=sqliteGateStore(db);g=new ApiGate(P,state.store,state.snapshot,{clock});expect(g.final("a",launch).started).toBe(true);
  db.exec("CREATE TRIGGER fail_reserve BEFORE INSERT ON api_permits WHEN NEW.seq=2 BEGIN SELECT RAISE(ABORT,'injected'); END");clock.t=1000;expect(()=>g!.final("a",launch)).toThrow("injected");
  expect(db.query("SELECT seq,stamp FROM api_permits").all()).toEqual([{seq:1,stamp:null}]);g.close();db.exec("DROP TRIGGER fail_reserve");state=sqliteGateStore(db);g=new ApiGate(P,state.store,state.snapshot,{clock});expect(g.rateLimited(Infinity)).toBe(false);g.close();
  for(let i=0;i<5;i++){clock.frame="reboot"+i;state=sqliteGateStore(db);expect(()=>new ApiGate(P,state.store,state.snapshot,{clock})).toThrow("blocked");expect(JSON.parse((db.query("SELECT value FROM settings WHERE name='api_state_v3'").get() as any).value).server.unknown).toBe(true);}
 }finally{g?.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
