export interface DebounceOptions { leading?: boolean; trailing?: boolean; maxWait?: number; }
interface Entry { timer: number | null; maxTimer: number | null; lastInvoke: number; fn: (...args: any[])=>any; opts: DebounceOptions; lastArgs: any[]; leadingInvoked: boolean; }
export class Debouncer {
  private static entries = new Map<string, Entry>();
  static debounce<T extends (...a:any[])=>any>(key:string, wait:number, fn:T, opts:DebounceOptions = {}, ...args:Parameters<T>) {
    let e = this.entries.get(key); const now = Date.now();
    if(!e){ e={timer:null,maxTimer:null,lastInvoke:0,fn,opts:{trailing:true,...opts},lastArgs:[],leadingInvoked:false}; this.entries.set(key,e);} else { e.fn=fn; e.opts={trailing:true,...e.opts,...opts}; }
    e.lastArgs = args;
    const invoke = () => { e!.timer=null; if(e!.maxTimer){ clearTimeout(e!.maxTimer); e!.maxTimer=null;} e!.lastInvoke=Date.now(); e!.leadingInvoked=false; return e!.fn(...e!.lastArgs); };
    if(e.opts.leading && !e.leadingInvoked){ e.leadingInvoked=true; e.lastInvoke=now; fn(...args); }
    if(e.timer) clearTimeout(e.timer);
    e.timer = window.setTimeout(()=>{ if(e!.opts.trailing!==false) invoke(); }, wait);
    if(e.opts.maxWait && !e.maxTimer){ e.maxTimer = window.setTimeout(()=>{ if(e!.timer){ clearTimeout(e!.timer); e!.timer=null;} invoke(); }, e.opts.maxWait); }
  }
  static flush(key:string){ const e=this.entries.get(key); if(!e) return; if(e.timer){ clearTimeout(e.timer); e.timer=null;} if(e.maxTimer){ clearTimeout(e.maxTimer); e.maxTimer=null;} e.fn(...e.lastArgs); e.lastInvoke=Date.now(); e.leadingInvoked=false; }
  static cancel(key:string){ const e=this.entries.get(key); if(!e) return; if(e.timer) clearTimeout(e.timer); if(e.maxTimer) clearTimeout(e.maxTimer); this.entries.delete(key);} }
