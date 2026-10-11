import { clientI18n, locale, t as tr } from './i18n';
import { readModelObservation, type ModelObservation } from './model-observation';
export function modelObservationText(value?: ModelObservation): string {
  const v = value ? readModelObservation(value) : undefined;
  return v ? v.status === 'provided' ? v.values[0]! : tr(`observations.${v.status}`) + (v.values.length ? ` · ${v.values.join(' / ')}` : '') : tr('observations.missing');
}
export function responseModelDetails(requested: string, values: readonly ModelObservation[] = [], includeSourceFields = false): string {
  return [tr('observations.requested', { value: requested }), ...(values.length ? values.map((value, i) =>
    tr('observations.returned', { index: i + 1, value: modelObservationText(value) }) + (includeSourceFields && value.fields.length ? `\n${tr('observations.source', { value: value.entries?.length ? value.entries.map(x => x.field + ' = ' + (x.value ?? tr('observations.invalid'))).join(', ') : value.fields.join(', ') })}` : '') + (value.truncated ? `\n${tr('observations.truncated')}` : '')) : [tr('observations.returned', { index: 1, value: tr('observations.missing') })]), tr('observations.declaration')].join('\n');
}
/** Uses textContent in every caller; no raw values enter HTML. */
export function modelObservationClientScript(): string {
  return `const observationText=v=>!v?tr('observations.missing'):v.status==='provided'?v.values[0]:tr('observations.'+v.status)+(v.values.length?' · '+v.values.join(' / '):'');
  const observationDetails=(requested,values=[],includeSourceFields=false)=>[tr('observations.requested',{value:requested}),...(values.length?values.map((v,i)=>tr('observations.returned',{index:i+1,value:observationText(v)})+(includeSourceFields&&v.fields.length?'\\n'+tr('observations.source',{value:v.entries?.length?v.entries.map(x=>x.field+' = '+(x.value??tr('observations.invalid'))).join(', '):v.fields.join(', ')}):'')+(v.truncated?'\\n'+tr('observations.truncated'):'')):[tr('observations.returned',{index:1,value:tr('observations.missing')})]),tr('observations.declaration')].join('\\n');`;
}
export function observationsHtml(nonce: string): string {
  return `<!doctype html><html lang="${locale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;font:var(--vscode-font-size)/1.6 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;overflow-wrap:anywhere}h1{font-size:20px}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:7px 12px;cursor:pointer;max-width:100%;white-space:normal;font:inherit}button:disabled{opacity:.5}button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder)}article{border:1px solid var(--vscode-panel-border);padding:12px;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}summary{cursor:pointer}</style></head><body><h1 data-i18n="observations.title">${tr('observations.title')}</h1><p data-i18n="observations.localHint">${tr('observations.localHint')}</p><button id="read" data-i18n="observations.read">${tr("observations.read")}</button> <button id="cancel" hidden data-i18n="observations.cancel">${tr("observations.cancel")}</button> <button id="clear" data-i18n="observations.clear">${tr('observations.clear')}</button><p id="scope"></p><details id="sources"><summary data-i18n="observations.importOptions">${tr("observations.importOptions")}</summary><p data-i18n="observations.sourceDirectory">${tr("observations.sourceDirectory")}</p><button id="directory" data-i18n="observations.chooseDirectory">${tr("observations.chooseDirectory")}</button> <button id="choose" data-i18n="observations.choose">${tr('observations.choose')}</button> </details><p id="notice" role="status"></p><div id="rows"></div><script nonce="${nonce}">${clientI18n()}const api=acquireVsCodeApi();let rows=[],notice='',busy=false,scope;${modelObservationClientScript()}
  const render=()=>{
    for(const id of ['read','directory','choose'])document.getElementById(id).disabled=busy;
    document.getElementById('cancel').hidden=!busy;
    document.getElementById('scope').textContent=scope?tr('observations.scope',scope)+Object.entries(scope.gaps||{}).map(([reason,count])=>' · '+tr('observations.gap.'+reason,{count})).join(''):'';
    if(notice==='noDirectories'||notice==='hostUnsupported')document.getElementById('sources').open=true;
    document.getElementById('clear').disabled=busy;
    document.getElementById('notice').textContent=notice?tr('observations.'+notice):rows.length?'':tr('observations.empty');
    const count=v=>v.status==='provided'?v.value:tr('observations.'+v.status);
    document.getElementById('rows').replaceChildren(...rows.map(r=>{
      const a=document.createElement('article'),title=document.createElement('strong'),brief=document.createElement('p'),d=document.createElement('details'),s=document.createElement('summary'),p=document.createElement('pre');
      title.textContent=tr('observations.generation',{index:r.index});
      brief.textContent=tr('observations.requested',{value:observationText(r.requested)})+' · '+tr('observations.returnedSingle',{value:observationText(r.returned)})+'\\n'+tr('observations.tokenSummary',{input:count(r.tokens.inputUncached),cache:count(r.tokens.cacheRead),output:count(r.tokens.outputTotal)});
      brief.style.whiteSpace='pre-wrap';d.className='record-details';s.textContent=tr('observations.details');
      p.textContent=observationDetails(observationText(r.requested),[r.returned])+'\\n'+Object.entries(r.tokens).map(([key,v])=>tr('observations.token.'+key)+': '+count(v)).join('\\n')+'\\n'+tr('observations.tokenHint')+(r.issue?'\\n'+tr('observations.'+r.issue):'');
      const technical=document.createElement('details'),ts=document.createElement('summary'),tp=document.createElement('pre');technical.className='technical-details';ts.textContent=tr('observations.technicalDetails');
      // Populate raw field provenance only after an explicit technical-details
      // toggle. Closing it removes those paths from ordinary page text again.
      technical.ontoggle=()=>{tp.textContent=technical.open?tr('observations.localSource',{client:tr('observations.client.'+(r.client||'selected')),session:r.session})+'\\n'+observationDetails(observationText(r.requested),[r.returned],true)+'\\n'+tr('observations.requestSourceUnknown')+'\\n'+Object.entries(r.tokens).map(([key,v])=>tr('observations.token.'+key)+': '+count(v)+(v.fields.length?' · '+v.fields.join(', '):'')).join('\\n'):''};
      technical.append(ts,tp);d.append(s,p,technical);a.append(title,brief,d);return a;
    }));
  };
  document.getElementById('read').onclick=()=>api.postMessage({type:'read'});document.getElementById('cancel').onclick=()=>api.postMessage({type:'cancel'});document.getElementById('directory').onclick=()=>api.postMessage({type:'directory'});document.getElementById('choose').onclick=()=>api.postMessage({type:'choose'});document.getElementById('clear').onclick=()=>api.postMessage({type:'clear'});window.addEventListener('message',e=>{const m=e.data;if(m.type==='state'){rows=m.rows;notice=m.notice;busy=m.busy;scope=m.scope;render()}if(m.type==='language'){language=m.language;applyLanguage();render()}});api.postMessage({type:'ready'});</script></body></html>`;
}
