import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

type Options = vscode.WebviewPanelOptions & vscode.WebviewOptions;
type Position = vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean };
type Factory = (type: string, title: string, position: Position, options: Options) => vscode.WebviewPanel;
let factory: Factory | undefined;
let revealHost: (() => boolean) | undefined;
export const revealWorkbench = (): boolean => revealHost?.() ?? false;
export const workbenchHostEnabled = (): boolean => !!factory;
/** Controllers keep their own validated bridges and cancellation lifetimes. */
export function createWorkbenchPanel(api: typeof vscode, type: string, title: string, position: Position, options: Options): vscode.WebviewPanel {
  return factory ? factory(type, title, position, options) : api.window.createWebviewPanel(type, title, position, options);
}

const hostScript = `const api=acquireVsCodeApi(),frames=new Map(),saved=api.getState()||{};
function theme(frame){const doc=frame.contentDocument;if(!doc?.body)return;const source=getComputedStyle(document.body);for(const name of source)if(name.startsWith('--vscode-'))doc.documentElement.style.setProperty(name,source.getPropertyValue(name));for(const name of ['vscode-light','vscode-dark','vscode-high-contrast','vscode-high-contrast-light'])doc.body.classList.toggle(name,document.body.classList.contains(name))}
window.__workbenchBridge=(id,source)=>{const frame=frames.get(id)?.frame;if(!frame||frame.contentWindow!==source)throw Error('Invalid workbench owner');return{getState:()=>saved[id]===undefined?undefined:structuredClone(saved[id]),setState:state=>{saved[id]=structuredClone(state);api.setState(saved);return state},postMessage:message=>api.postMessage({type:'workbench.host.message',id,message})}};
window.addEventListener('message',event=>{if([...frames.values()].some(entry=>entry.frame.contentWindow===event.source))return;const m=event.data;if(!m||typeof m!=='object'||m.nonce!==workbenchNonce)return;if(m.type==='workbench.host.page'){let entry=frames.get(m.id);if(!entry){const frame=document.createElement('iframe');frame.className='workbench-frame';frame.title=m.title;frame.dataset.page=m.id;entry={frame,loaded:false,queue:[],html:''};frames.set(m.id,entry);frame.addEventListener('load',()=>{entry.loaded=true;theme(frame);for(const message of entry.queue.splice(0))frame.contentWindow.postMessage(message,'*')});document.body.append(frame)}if(entry.html!==m.html){entry.html=m.html;entry.loaded=false;entry.frame.srcdoc=m.html}entry.frame.title=m.title;if(m.active)for(const[id,value]of frames)value.frame.hidden=id!==m.id}if(m.type==='workbench.host.show')for(const[id,value]of frames)value.frame.hidden=id!==m.id;if(m.type==='workbench.host.dispose'){frames.get(m.id)?.frame.remove();frames.delete(m.id);delete saved[m.id];api.setState(saved)}if(m.type==='workbench.host.deliver'){const entry=frames.get(m.id);if(entry?.loaded)entry.frame.contentWindow.postMessage(m.message,'*');else entry?.queue.push(m.message)}});
const sync=()=>{for(const entry of frames.values())theme(entry.frame)};new MutationObserver(sync).observe(document.body,{attributes:true});new MutationObserver(sync).observe(document.head,{attributes:true,childList:true,subtree:true});api.postMessage({type:'workbench.host.ready'});`;

/** One editor, with persistent documents for visited modules; no page is preloaded. */
export function registerWorkbenchHost(context: vscode.ExtensionContext) {
  type Page = { proxy: vscode.WebviewPanel; title: string; html: string; options: Options; receive: vscode.EventEmitter<unknown>; closed: vscode.EventEmitter<void>; changed: vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>; messages: unknown[] };
  const pages = new Map<string, Page>();
  let owner: vscode.WebviewPanel | undefined, active = '', ready = false, disposed = false, nonce = '';
  const sendPage = (id: string, page: Page) => {
    if (!owner || !ready || !page.html) return;
    const html = page.html.replace(/nonce="[^"]+"/g, `nonce="${nonce}"`).replace(/'nonce-[^']+'/g, `'nonce-${nonce}'`).replace(/<head>/i, `<head><script nonce="${nonce}">window.acquireVsCodeApi=()=>window.parent.__workbenchBridge(${JSON.stringify(id)},window);</script>`);
    void owner.webview.postMessage({ nonce, type: 'workbench.host.page', id, title: page.title, html, active: id === active });
    for (const message of page.messages.splice(0)) void owner.webview.postMessage({ nonce, type: 'workbench.host.deliver', id, message });
  };
  const roots = () => {
    if (!owner) return;
    const unique = new Map<string, vscode.Uri>();
    for (const page of pages.values()) for (const uri of page.options.localResourceRoots ?? []) unique.set(uri.toString(), uri);
    owner.webview.options = { enableScripts: true, localResourceRoots: [...unique.values()] };
  };
  const ensure = (position: Position) => {
    if (owner) return owner;
    ready = false; nonce = randomBytes(16).toString('hex');
    const native = vscode.window.createWebviewPanel('antigravityWorkbench', 'Antigravity Workbench', position, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }); owner = native;
    native.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; img-src ${native.webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--vscode-editor-background)}.workbench-frame{display:block;width:100%;height:100%;border:0}.workbench-frame[hidden]{display:none}</style></head><body><script nonce="${nonce}">${'const workbenchNonce='+JSON.stringify(nonce)+';'}${hostScript}</script></body></html>`;
    context.subscriptions.push(native.webview.onDidReceiveMessage((message: unknown) => {
      if (owner !== native || disposed || !message || typeof message !== 'object') return;
      const m = message as Record<string, unknown>;
      if (m.type === 'workbench.host.ready' && Object.keys(m).length === 1) { ready = true; for (const [id, page] of pages) sendPage(id, page); return; }
      if (m.type === 'workbench.host.message' && Object.keys(m).length === 3 && typeof m.id === 'string') pages.get(m.id)?.receive.fire(m.message);
    }), native.onDidDispose(() => {
      if (owner !== native) return; owner = undefined; ready = false; active = '';
      const previous = [...pages.values()]; pages.clear(); for (const page of previous) { page.closed.fire(); page.receive.dispose(); page.closed.dispose(); page.changed.dispose(); }
    }), native.onDidChangeViewState(() => { for (const page of pages.values()) page.changed.fire({ webviewPanel: page.proxy }); }));
    return native;
  };
  const implementation: Factory = (id, title, position, options) => {
    if (disposed) throw Error('Workbench disposed');
    const native = ensure(position), previous = pages.get(id);
    if (previous) { previous.proxy.reveal(typeof position === 'number' ? position : position.viewColumn); return previous.proxy; }
    const page = { title, html: '', options, receive: new vscode.EventEmitter<unknown>(), closed: new vscode.EventEmitter<void>(), changed: new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>(), messages: [] as unknown[] } as Page;
    const webview = {
      get html() { return page.html; }, set html(value: string) { page.html = value; sendPage(id, page); },
      get options() { return page.options; }, set options(value: vscode.WebviewOptions) { page.options = { ...page.options, ...value }; roots(); },
      get cspSource() { return native.webview.cspSource; }, asWebviewUri: (uri: vscode.Uri) => native.webview.asWebviewUri(uri), onDidReceiveMessage: page.receive.event,
      postMessage: (message: unknown): Thenable<boolean> => { if (!pages.has(id) || owner !== native) return Promise.resolve(false); if (!ready || !page.html) { page.messages.push(message); return Promise.resolve(true); } return native.webview.postMessage({ nonce, type: 'workbench.host.deliver', id, message }); },
    };
    page.proxy = {
      viewType: id, webview, options, get title() { return page.title; }, set title(value: string) { page.title = value; if (ready) sendPage(id, page); },
      get viewColumn() { return native.viewColumn; }, get active() { return active === id && native.active; }, get visible() { return active === id && native.visible; },
      onDidDispose: page.closed.event, onDidChangeViewState: page.changed.event,
      reveal: (column?: vscode.ViewColumn, preserveFocus?: boolean) => { if (!pages.has(id) || owner !== native) return; active = id; native.reveal(column, preserveFocus); if (ready) void native.webview.postMessage({ nonce, type: 'workbench.host.show', id }); for (const current of pages.values()) current.changed.fire({ webviewPanel: current.proxy }); },
      dispose: () => { if (!pages.delete(id)) return; page.closed.fire(); page.receive.dispose(); page.closed.dispose(); page.changed.dispose(); if (ready) void native.webview.postMessage({ nonce, type: 'workbench.host.dispose', id }); roots(); if (!pages.size) native.dispose(); },
    } as unknown as vscode.WebviewPanel;
    pages.set(id, page); active = id; roots(); native.reveal(typeof position === 'number' ? position : position.viewColumn, typeof position === 'number' ? false : position.preserveFocus); return page.proxy;
  };
  factory = implementation;
  revealHost = () => { if (disposed || !owner) return false; owner.reveal(); return true; };
  context.subscriptions.push({ dispose() { disposed = true; if (factory === implementation) { factory = undefined; revealHost = undefined; } owner?.dispose(); } });
  return { inspect: () => ({ ready, active, pages: [...pages].map(([id, page]) => ({ id, htmlLength: page.html.length, queued: page.messages.length })) }) };
}
