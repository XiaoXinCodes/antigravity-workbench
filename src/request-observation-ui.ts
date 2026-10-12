import { routeWorkbenchNavigation } from './workbench-navigation';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { locale, onLanguageChange, t as tr } from './i18n';
import { readLocalGenerationDb } from './local-generation-db';
import { nativeDiscoveryRuntime, readNativeGenerations, readConversationDirectory, type DiscoveryRuntime, type GenerationScope } from './local-generation-discovery';
import { mergeLocalRecords, type LocalGenerationRecord } from './local-generation-record';
import { observationsHtml } from './request-observation-view';
import { buildLocalGenerationStats, type GenerationStatsRange } from './local-generation-stats';
import { generationStatsExportContent, prepareGenerationExport, writeGenerationExport } from './local-generation-export';
/** No directory discovery or DB access during activation or panel opening. */
export function registerObservationsUi(context: vscode.ExtensionContext, deps: { pick?: (directory: boolean) => Promise<readonly vscode.Uri[] | undefined>; read?: typeof readLocalGenerationDb; runtime?: DiscoveryRuntime; save?: (format: 'csv' | 'json') => Promise<vscode.Uri | undefined>; confirmOverwrite?: (name: string) => Promise<boolean> } = {}) {
  let panel: vscode.WebviewPanel | undefined, rows: LocalGenerationRecord[] = [], busy = false, notice = '', scope: GenerationScope | undefined;
  let active: AbortController | undefined;
  let range: GenerationStatsRange = 'all', model = '', project = '', revision = 0, exporting = false;
  const snapshot = () => buildLocalGenerationStats(rows, {range, ...(model ? {model} : {}), ...(project ? {project} : {})});
  const emit = () => {
    const stats = snapshot();
    // Keys and response identities stay in the host. Raw field provenance is
    // available only in the explicitly expanded technical details.
    const safeRows = stats.rows.map(row => ({ client:row.client,session:row.session,index:row.index,requested:row.requested,returned:row.returned,tokens:row.tokens,usageInterpretation:row.usageInterpretation,timestamp:row.timestamp,project:row.project,...(row.issue?{issue:row.issue}:{}) }));
    return panel?.webview.postMessage({type:'state',rows:safeRows,stats:{...stats,rows:undefined,undatedRows:undefined},filter:{range,model,project},busy,exporting,notice,scope});
  };
  const localPath = (uri: vscode.Uri): string | undefined => uri.scheme==='file'&&!uri.authority?uri.fsPath:process.platform==='linux'&&vscode.env.remoteName==='wsl'&&process.env.WSL_DISTRO_NAME&&uri.scheme==='vscode-remote'&&uri.authority===`wsl+${process.env.WSL_DISTRO_NAME}`&&path.posix.isAbsolute(uri.path)?uri.path:undefined;
  const exportRecords = async (owner: vscode.WebviewPanel, format: 'csv' | 'json') => {
    if (busy || panel!==owner || !vscode.workspace.isTrusted) return;
    const captured = snapshot(); if (!captured.rows.length) return;
    const controller = new AbortController(), capturedRevision = revision; active=controller;busy=true;exporting=true;notice='exporting';void emit();
    const current = () => panel===owner && active===controller && revision===capturedRevision && !controller.signal.aborted;
    try {
      const content = generationStatsExportContent(captured,format,scope?{files:scope.files,skipped:scope.skipped,limited:scope.limited}:undefined);
      const uri = await (deps.save ? deps.save(format) : vscode.window.showSaveDialog({title:tr('observations.exportSave'),saveLabel:tr('observations.export'),filters:{[format.toUpperCase()]:[format]}}));
      if (!current()) return;
      if (!uri) {notice='';return;}
      const targetPath=localPath(uri);if(!targetPath)throw Error('LOCAL_EXPORT_PATH_UNSAFE');
      const target=await prepareGenerationExport(targetPath);if(!current())return;
      let approved=false;
      if(target.exists)approved=await (deps.confirmOverwrite?deps.confirmOverwrite(path.basename(targetPath)):vscode.window.showWarningMessage(tr('observations.exportOverwrite',{name:path.basename(targetPath)}),{modal:true},tr('observations.overwrite')).then(value=>value===tr('observations.overwrite')));
      if(!current())return;if(target.exists&&!approved){notice='';return;}
      await writeGenerationExport(target,content,{allowOverwrite:approved,signal:controller.signal,isCurrent:current});
      if(current())notice='exported';
    } catch(error) {
      if(current()){const code=error instanceof Error?error.message:'';notice=code==='LOCAL_EXPORT_CHANGED'?'exportChanged':code==='LOCAL_EXPORT_PATH_UNSAFE'?'exportUnsafe':code==='LOCAL_EXPORT_CANCELLED'?'':'exportFailed';}
    } finally {
      if(active===controller){if(!current()&&notice==='exporting')notice='';active=undefined;busy=false;exporting=false;void emit();}
    }
  };
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
        const file=localPath(uri);
        if (!file) throw Error('LOCAL_DB_UNSAFE');
        if (directory) result=await readConversationDirectory(file,controller.signal,options);
        else { const loaded=await (deps.read ?? readLocalGenerationDb)(file,controller.signal);const imported=mergeLocalRecords(loaded.rows.map(row=>({...row,client:'selected' as const})));result={rows:imported,scope:{host:runtime.platform,files:1,rows:imported.length,skipped:0,limited:loaded.limited},found:true}; }
      }
      check();
      if (panel===owner&&active===controller) { rows=result.rows;scope=result.scope;revision++;const all=buildLocalGenerationStats(rows,{range:'all'});if(model&&!all.modelOptions.some(value=>value.key===model))model='';if(project&&!all.projectOptions.some(value=>value.key===project))project='';notice=scope.limited?'limited':scope.skipped?'someSkipped':!result.found?'noDirectories':!rows.length?'noRecords':''; }
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
      if(routeWorkbenchNavigation(message))return;
      if(message.type==='ready')void emit();
      if(message.type==='read')void read(owner,'read');
      if(message.type==='choose')void read(owner,'file');
      if(message.type==='directory')void read(owner,'directory');
      if(message.type==='cancel')active?.abort();
      if(message.type==='filter'&&(!busy||exporting)){
        const choices=buildLocalGenerationStats(rows,{range:'all'});
        if(!['today','7d','30d','all'].includes(message.range)||typeof message.model!=='string'||message.model.length>300||message.model&&!choices.modelOptions.some(value=>value.key===message.model)||typeof message.project!=='string'||message.project&&!choices.projectOptions.some(value=>value.key===message.project))return;
        if(message.range===range&&message.model===model&&message.project===project)return;
        range=message.range;model=message.model;project=message.project;revision++;if(exporting)active?.abort();void emit();
      }
      if(message.type==='export'&&(message.format==='csv'||message.format==='json'))void exportRecords(owner,message.format);
      if(message.type==='clear'&&(!busy||exporting)){revision++;if(exporting)active?.abort();rows=[];scope=undefined;model='';project='';notice='';void emit();}
    },undefined,context.subscriptions);
    owner.onDidDispose(()=>{if(panel===owner){revision++;panel=undefined;rows=[];scope=undefined;notice='';model='';project='';active?.abort();active=undefined;busy=false;exporting=false;}},undefined,context.subscriptions);
  }),onLanguageChange(()=>{if(panel){panel.title=tr('observations.title');void panel.webview.postMessage({type:'language',language:locale()});void emit();}}),{dispose:()=>{active?.abort();panel?.dispose();}});
}
