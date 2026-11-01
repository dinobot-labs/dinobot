/** Existing explicit lang preference; ordinary anchors still work without JS. */
export function setLangCookie(lang:'en'|'ko'):void {
 const secure=location.protocol==='https:'?'; Secure':'';
 document.cookie='lang='+lang+'; Path=/; Max-Age=31536000; SameSite=Lax'+secure;
}
export function mountLocaleToggle():void {
 for(const link of document.querySelectorAll<HTMLAnchorElement>('[data-locale-toggle]')){
  const url=new URL(link.href,location.href);url.search=location.search;url.hash=location.hash;link.href=url.href;
  link.addEventListener('click',event=>{
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   setLangCookie(link.dataset.localeToggle==='ko'?'ko':'en');
   const target=new URL(link.href,location.href);target.search=location.search;target.hash=location.hash;
   event.preventDefault();if(link.getAttribute('aria-current')!=='true')location.assign(target.href);
  });
 }
}
