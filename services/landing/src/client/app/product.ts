/** One owner for OS and clipboard state. Native screenshot failures are disclosed. No installer is executed. */
export type OS = 'windows' | 'macos' | 'linux';
export const commands: Record<OS,string> = {
 windows:'irm https://releases.dinobot.workers.dev/install.ps1 | iex',
 macos:'curl -fsS https://releases.dinobot.workers.dev/install.sh | sh',
 linux:'curl -fsS https://releases.dinobot.workers.dev/install.sh | sh',
};
export function recommendedOS(agent: string): OS {
 if (/Windows/i.test(agent)) return 'windows';
 if (/Android|iPhone|iPad|Mobile/i.test(agent)) return 'macos';
 if (/Linux/i.test(agent)) return 'linux';
 return 'macos';
}
export type CopyState = 'idle' | 'pending' | 'copied' | 'manual';
/** Generation is invalidated even between platforms sharing command bytes. */
export function createInstaller(initial:OS, render:(os:OS,state:CopyState)=>void) {
 let os=initial, state:CopyState='idle', generation=0;
 const publish=()=>render(os,state);
 publish();
 return {
  select(next:OS){os=next;generation++;state='idle';publish();},
  async copy(write:(text:string)=>Promise<void>){
   if(state==='pending')return;
   const request=++generation, snapshot=commands[os];state='pending';publish();
   try{await write(snapshot);if(request!==generation)return;state='copied';}
   catch{if(request!==generation)return;state='manual';}
   publish();
  },
 };
}
export function mountProduct():void {
 // Native screenshots only; image failure never implies a successful demo.
 for(const image of document.querySelectorAll<HTMLImageElement>('[data-product-image]')){
  const status=image.closest('[data-product-figure]')?.querySelector<HTMLElement>('[data-preview-status]');
  if(!status)continue;
  const showError=()=>{status.textContent=status.dataset.error??'';};
  image.addEventListener('error',showError);
  image.addEventListener('load',()=>{status.textContent='';});
  if(image.complete && image.naturalWidth===0)showError();
 }
 const enhanced=document.querySelector<HTMLElement>('[data-install-enhanced]');
 const fallback=document.querySelector<HTMLElement>('[data-install-fallback]');
 const command=document.querySelector<HTMLElement>('[data-command]');
 const copy=document.querySelector<HTMLButtonElement>('[data-copy-command]');
 const status=document.querySelector<HTMLElement>('[data-copy-status]');
 if(!enhanced||!fallback||!command||!copy||!status)return;
 const choices=[...document.querySelectorAll<HTMLInputElement>('[data-os-choice]')];
 const installer=createInstaller(recommendedOS(navigator.userAgent),(os,state)=>{
  command.textContent=commands[os];
  for(const choice of choices)choice.checked=choice.value===os;
  // Native disabled buttons can drop keyboard focus; the controller fences duplicates.
  copy.setAttribute('aria-disabled',String(state==='pending'));
  copy.setAttribute('aria-busy',String(state==='pending'));
  copy.textContent=copy.dataset[state==='pending'?'pending':state==='copied'?'copied':'idle']??'';
  status.dataset.state=state;
  status.textContent=state==='copied'?(status.dataset.success??''):state==='manual'?(status.dataset.manual??''):'';
  if(state==='manual'){
   const selection=window.getSelection();const range=document.createRange();range.selectNodeContents(command);
   selection?.removeAllRanges();selection?.addRange(range);
  }
 });
 for(const choice of choices)choice.addEventListener('change',()=>{if(choice.checked)installer.select(choice.value as OS);});
 copy.addEventListener('click',()=>void installer.copy(async text=>{
  if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
 }));
 fallback.hidden=true;enhanced.hidden=false;
}
