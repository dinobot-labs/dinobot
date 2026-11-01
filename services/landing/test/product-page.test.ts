import {describe,expect,test} from 'bun:test';
import {commands,createInstaller,recommendedOS,type OS,type CopyState} from '../src/client/app/product.ts';
describe('installation command interaction',()=>{
 test('detection recommends desktop commands without claiming mobile compatibility',()=>{
 expect(recommendedOS('Windows NT 10')).toBe('windows');expect(recommendedOS('Linux x86_64')).toBe('linux');expect(recommendedOS('Macintosh')).toBe('macos');expect(recommendedOS('Android Linux Mobile')).toBe('macos');expect(recommendedOS('unknown')).toBe('macos');
 });
 for(const os of ['windows','macos','linux'] as OS[])test(os+' copies exact selected command and publishes success',async()=>{
 const states:CopyState[]=[];const model=createInstaller(os,(_,s)=>states.push(s));let actual='';await model.copy(async text=>{actual=text;});
 expect(actual).toBe(os==='windows'?'irm https://releases.dinobot.workers.dev/install.ps1 | iex':'curl -fsS https://releases.dinobot.workers.dev/install.sh | sh');expect(states).toEqual(['idle','pending','copied']);
 });
 test('clipboard rejection produces manual, then permits a fresh retry',async()=>{
 const states:CopyState[]=[];const model=createInstaller('windows',(_,s)=>states.push(s));await model.copy(async()=>{throw Error('denied');});await model.copy(async()=>{});expect(states).toEqual(['idle','pending','manual','pending','copied']);
 });
 for(const reject of [false,true])test('OS change fences late '+(reject?'failure':'success')+' even with equal command bytes',async()=>{
 let settle!:()=>void;const states:string[]=[];const model=createInstaller('macos',(os,s)=>states.push(os+':'+s));let calls=0;
 const pending=model.copy(()=>new Promise<void>((resolve,rejection)=>{calls++;settle=()=>reject?rejection(Error('denied')):resolve();}));
 await model.copy(async()=>{calls++;});expect(calls).toBe(1);model.select('linux');settle();await pending;expect(states).toEqual(['macos:idle','macos:pending','linux:idle']);
 });
 test('new copy may complete before stale request without being reset',async()=>{
 let resolve!:()=>void;const states:string[]=[];const model=createInstaller('windows',(os,s)=>states.push(os+':'+s));const pending=model.copy(()=>new Promise<void>(r=>resolve=r));model.select('macos');await model.copy(async text=>expect(text).toBe(commands.macos));resolve();await pending;expect(states.at(-1)).toBe('macos:copied');
 });
});
