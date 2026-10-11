import * as path from 'node:path';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { locale, onLanguageChange, t as tr } from './i18n';
import { readLocalGenerationDb } from './local-generation-db';
import { nativeDiscoveryRuntime, readNativeGenerations, readConversationDirectory, type DiscoveryRuntime, type GenerationScope } from './local-generation-discovery';
import { mergeLocalRecords, type LocalGenerationRecord } from './local-generation-record';
import { observationsHtml } from './request-observation-view';
/** No directory discovery or DB access during activation or panel opening. */
export function registerObservationsUi(context: vscode.ExtensionContext, deps: { pick?: (directory: boolean) => Promise<readonly vscode.Uri[] | undefined>; read?: typeof readLocalGenerationDb; runtime?: DiscoveryRuntime } = {}) {
  let panel: vscode.WebviewPanel | undefined, rows: LocalGenerationRecord[] = [], busy = false, notice = '', scope: GenerationScope | undefined;
  let active: AbortController | undefined;
  const emit = () => panel?.webview.postMessage({ type: 'state', rows: rows.map(row => ({ client:row.client,session: row.session, index: row.index, requested: row.requested, returned: row.returned, tokens: row.tokens, ...(row.issue ? {issue: row.issue} : {}) })), busy, notice, scope });
  const read = async (owner: vscode.WebviewPanel, kind: 'read' | 'file' | 'directory') => {
    if (busy || panel !== owner) return;
    if (!vscode.workspace.isTrusted) { notice = 'trust'; void emit(); return; }
    busy = true; notice = 'busy'; void emit();
    const controller = new AbortController(); active = controller;
    const check = () => { if(controller.signal.aborted)throw Error('LOCAL_DB_CANCELLED'); };
    try {
      const runtime=deps.runtime ?? {...nativeDiscoveryRuntime(),...(vscode.env.remoteName ? {remoteName:vscode.env.remoteName} : {})};
      const options={runtime,...(deps.read ? {read:deps.read} : {})};
      let result: Awaited<ReturnType<typeof readNativeGenerations>>;
      if (kind==='read') result=await readNativeGenerations(controller.signal,options);
      else {
        const directory=kind==='directory';
        const files=await (deps.pick ? deps.pick(directory) : vscode.window.showOpenDialog({canSelectMany:false,canSelectFiles:!directory,canSelectFolders:directory,...(directory?{}:{filters:{SQLite:['db']}}),title:tr(directory?'observations.chooseDirectory':'observations.choose')}));
        check();
        if (!files?.[0]) { if(panel===owner)notice='';return; }
        const uri=files[0];
        const file=uri.scheme==='file'&&!uri.authority?uri.fsPath:process.platform==='linux'&&vscode.env.remoteName==='wsl'&&process.env.WSL_DISTRO_NAME&&uri.scheme==='vscode-remote'&&uri.authority===`wsl+${process.env.WSL_DISTRO_NAME}`&&path.posix.isAbsolute(uri.path)?uri.path:undefined;
        if (!file) throw Error('LOCAL_DB_UNSAFE');
        if (directory) result=await readConversationDirectory(file,controller.signal,options);
        else { const loaded=await (deps.read ?? readLocalGenerationDb)(file,controller.signal);const imported=mergeLocalRecords(loaded.rows.map(row=>({...row,client:'selected' as const})));result={rows:imported,scope:{host:runtime.platform,files:1,rows:imported.length,skipped:0,limited:loaded.limited},found:true}; }
      }
      check();
      if (panel===owner&&active===controller) { rows=result.rows;scope=result.scope;notice=scope.limited?'limited':scope.skipped?'someSkipped':!result.found?'noDirectories':!rows.length?'noRecords':''; }
    } catch (error) {
      if (panel===owner&&active===controller) { const code=controller.signal.aborted?'LOCAL_DB_CANCELLED':error instanceof Error?error.message:'';notice=({LOCAL_DB_CHANGED:'changed',LOCAL_DB_UNSUPPORTED:'unsupported',LOCAL_DB_UNSAFE:'unsafe',LOCAL_DB_LIMIT:'fileLimit',LOCAL_DB_CANCELLED:'cancelled',LOCAL_DB_HOST_UNSUPPORTED:'hostUnsupported'} as Record<string,string>)[code]??'unavailable'; }
    } finally { if(active===controller){active=undefined;busy=false;void emit();} }
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.observations.open', () => {
    if (panel) { panel.reveal(); return; }
    panel=vscode.window.createWebviewPanel('antigravityRequestObservations',tr('observations.title'),vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[]});
    const owner=panel;owner.webview.html=observationsHtml(randomBytes(16).toString('hex'));
    owner.webview.onDidReceiveMessage(message=>{
      if(panel!==owner||!message||typeof message!=='object')return;
      if(message.type==='ready')void emit();
      if(message.type==='read')void read(owner,'read');
      if(message.type==='choose')void read(owner,'file');
      if(message.type==='directory')void read(owner,'directory');
      if(message.type==='cancel')active?.abort();
      if(message.type==='clear'&&!busy){rows=[];scope=undefined;notice='';void emit();}
    },undefined,context.subscriptions);
    owner.onDidDispose(()=>{if(panel===owner){panel=undefined;rows=[];scope=undefined;notice='';active?.abort();active=undefined;busy=false;}},undefined,context.subscriptions);
  }),onLanguageChange(()=>{if(panel){panel.title=tr('observations.title');void panel.webview.postMessage({type:'language',language:locale()});void emit();}}),{dispose:()=>{active?.abort();panel?.dispose();}});
}
