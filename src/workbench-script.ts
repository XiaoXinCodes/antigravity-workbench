import { clientI18n } from './i18n';
export interface QuotaViewState { search: string; compare: string; sort: string; compareOwners: string[]; compareLabel: string; expanded: Record<string, boolean> }
/** Accept only bounded display preferences, never account or quota snapshots. */
export function quotaViewState(value: unknown): QuotaViewState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some(key => !['search', 'compare', 'sort', 'compareOwners', 'compareLabel', 'expanded'].includes(key)) ||
      !['search', 'compare', 'compareLabel'].every(key => typeof state[key] === 'string' && (state[key] as string).length <= 4096) ||
      typeof state.sort !== 'string' || !['saved', 'high', 'low', 'updated', 'reset'].includes(state.sort) ||
      !Array.isArray(state.compareOwners) || state.compareOwners.length > 1000 || !state.compareOwners.every(id => typeof id === 'string' && id.length <= 128) ||
      !state.expanded || typeof state.expanded !== 'object' || Array.isArray(state.expanded) || Object.keys(state.expanded).length > 1000 ||
      !Object.entries(state.expanded).every(([key, open]) => key.length <= 1024 && typeof open === 'boolean')) return;
  if (state.compare) {
    try { const key: unknown = JSON.parse(state.compare as string); if (!Array.isArray(key) || key.length !== 4 || key[0] !== 'bucket' || !key.slice(1).every(part => typeof part === 'string') || !key[2]) return; }
    catch { return; }
  }
  return state as unknown as QuotaViewState;
}
/** Incremental reconciliation preserves existing DOM nodes. There is no backend
 * polling here; sorting/filtering and passive freshness repaint are local only. */
export function workbenchScript(independentCommands: string[], storedState?: QuotaViewState): string {
  return `${clientI18n()}
const api=acquireVsCodeApi();const savedApi=api.getState();const previous=savedApi&&typeof savedApi.sort==='string'?savedApi:${JSON.stringify(storedState ?? {}).replace(/</g, '\\u003c')};const expanded=previous.expanded||{};
const controls={search:typeof previous.search==='string'?previous.search:'',compare:typeof previous.compare==='string'?previous.compare:'',sort:['saved','high','low','updated','reset'].includes(previous.sort)?previous.sort:'saved'};
let compareOwners=Array.isArray(previous.compareOwners)?previous.compareOwners.filter(id=>typeof id==='string'):[],compareLabel=typeof previous.compareLabel==='string'?previous.compareLabel:'';
const save=()=>{const state={...controls,compareOwners,compareLabel,expanded};api.setState(state);api.postMessage({type:'viewState',state})};
const independent=new Set(${JSON.stringify(independentCommands)});const pending=new Map();const session=Math.random().toString(36).slice(2);let sequence=0;
// A rebuilt webview starts from its original HTML. Only the ready-handshake
// patch contains the host's current catalog and may establish deletion.
let synchronized=false;
const key=node=>node.nodeType===1?(node.id||node.getAttribute('data-key')||''):'';
const morph=(oldNode,newNode)=>{
 if(oldNode.nodeType!==newNode.nodeType||oldNode.nodeName!==newNode.nodeName){const replacement=newNode.cloneNode(true);oldNode.replaceWith(replacement);return replacement}
 if(oldNode.nodeType===3){if(oldNode.nodeValue!==newNode.nodeValue)oldNode.nodeValue=newNode.nodeValue;return oldNode}
 if(oldNode.nodeType!==1||oldNode.isEqualNode(newNode))return oldNode;
 for(const attr of [...oldNode.attributes])if(!(oldNode.tagName==='DETAILS'&&attr.name==='open')&&!newNode.hasAttribute(attr.name))oldNode.removeAttribute(attr.name);
 for(const attr of [...newNode.attributes])if(!(oldNode.tagName==='DETAILS'&&attr.name==='open')&&oldNode.getAttribute(attr.name)!==attr.value)oldNode.setAttribute(attr.name,attr.value);
 const retained=new Set();let index=0;
 for(const next of [...newNode.childNodes]){const id=key(next);let current=id?[...oldNode.childNodes].find(child=>key(child)===id):oldNode.childNodes[index];
  if(!current||(key(current)&&!id)){current=next.cloneNode(true);oldNode.insertBefore(current,oldNode.childNodes[index]||null)}
  else{if(current!==oldNode.childNodes[index])oldNode.insertBefore(current,oldNode.childNodes[index]||null);current=morph(current,next)}
  retained.add(current);index++;
 }
 for(const child of [...oldNode.childNodes])if(!retained.has(child))child.remove();
 return oldNode;
};
const boundDetails=new WeakSet();
const bindDetails=()=>{for(const detail of document.querySelectorAll('details[data-persist]')){
 if(boundDetails.has(detail))continue;boundDetails.add(detail);if(Object.hasOwn(expanded,detail.id))detail.open=!!expanded[detail.id];else detail.open=detail.hasAttribute('data-default-open');
 detail.addEventListener('toggle',()=>{expanded[detail.id]=detail.open;save()});
}};
const applyControls=()=>{
 const search=document.getElementById('quota-search'),compare=document.getElementById('quota-compare'),sort=document.getElementById('quota-sort'),list=document.querySelector('.account-list');
 const cards=list?[...list.querySelectorAll(':scope > .account')]:[],accountsReady=synchronized&&document.getElementById('accounts-section')?.dataset.accountsReady==='true';
 const selectedRow=card=>[...card.querySelectorAll('.quota-row[data-quota-key]')].find(row=>row.dataset.quotaKey===controls.compare&&row.dataset.comparable==='true');
 const choice=compare&&[...compare.options].find(option=>option.value===controls.compare&&!option.hasAttribute('data-pending-compare'));
 if(compare&&(!controls.compare||choice))for(const waiting of compare.querySelectorAll('[data-pending-compare]'))waiting.remove();
 if(controls.compare){
  if(choice){const owners=[...new Set([...compareOwners.filter(id=>{const card=cards.find(card=>card.dataset.key===id);return card?!synchronized||card.dataset.quotaReady!=='true'||!!selectedRow(card):!accountsReady}),...cards.filter(selectedRow).map(card=>card.dataset.key)])];
   if(JSON.stringify(owners)!==JSON.stringify(compareOwners)||compareLabel!==choice.textContent){compareOwners=owners;compareLabel=choice.textContent;save()}
  }else{const deleted=accountsReady&&(compareOwners.length?compareOwners.every(id=>{const card=cards.find(card=>card.dataset.key===id);return !card||card.dataset.quotaReady==='true'}):cards.every(card=>card.dataset.quotaReady==='true'));
   if(deleted){controls.compare='';compareOwners=[];compareLabel='';compare?.querySelector('[data-pending-compare]')?.remove();save()}
   else if(compare){let waiting=compare.querySelector('[data-pending-compare]');if(!waiting){waiting=document.createElement('option');waiting.setAttribute('data-pending-compare','');waiting.disabled=true;compare.append(waiting)}waiting.value=controls.compare;waiting.textContent=compareLabel||tr('quota.compare')}
  }
 }
 if(!search||!compare||!sort||!list)return;
 search.value=controls.search;compare.value=controls.compare;
 sort.value=controls.sort;
 const info=card=>{const rows=[...card.querySelectorAll('.quota-row[data-quota-key]')],selected=controls.compare?rows.filter(item=>item.dataset.quotaKey===controls.compare&&item.dataset.comparable==='true'):rows;
 // All-items sorting compares the lowest known fraction or earliest known reset
 // within each account. It does not infer a shared pool or turn unknown into zero.
 const earliest=field=>{const values=selected.filter(row=>row.dataset[field]!=='').map(row=>Number(row.dataset[field])).filter(Number.isFinite);return values.length?Math.min(...values):NaN};
 return{value:earliest('fraction'),reset:earliest('reset'),stale:card.dataset.stale==='true',updated:card.dataset.updated?Number(card.dataset.updated):NaN};};
 const metric=card=>{const i=info(card);return controls.sort==='updated'?i.updated:controls.sort==='reset'?i.reset:i.value};
 const compareCards=(a,b)=>{
 if(controls.sort==='saved')return Number(a.dataset.order)-Number(b.dataset.order);
 const av=metric(a),bv=metric(b),ak=Number.isFinite(av),bk=Number.isFinite(bv);if(ak!==bk)return ak?-1:1;
 if(ak&&controls.sort!=='updated'&&info(a).stale!==info(b).stale)return info(a).stale?1:-1;
 return ak&&av!==bv?(['high','updated'].includes(controls.sort)?bv-av:av-bv):Number(a.dataset.order)-Number(b.dataset.order);
 };
 let matches=0;
 for(const card of cards){card.hidden=!card.dataset.search.toLocaleLowerCase().includes(controls.search.toLocaleLowerCase().trim());if(!card.hidden)matches++;
 const selected=controls.compare&&[...card.querySelectorAll('[data-quota-key]')].find(item=>item.dataset.quotaKey===controls.compare&&item.dataset.comparable==='true');
 const reading=card.querySelector('[data-compare-value]');if(reading){reading.hidden=!controls.compare;reading.textContent=selected?selected.dataset.reading+(card.dataset.stale==='true'?tr('quota.staleSuffix'):''):tr('workbenchView.4d8c1c5b42')}
 }
 const ordered=cards.sort(compareCards);for(let i=0;i<ordered.length;i++)if(list.children[i]!==ordered[i])list.insertBefore(ordered[i],list.children[i]||null);
 const empty=document.getElementById('quota-no-matches');if(empty)empty.hidden=matches>0;
};
document.addEventListener('input',event=>{if(event.target.id==='quota-search'){controls.search=event.target.value;applyControls();save()}});
document.addEventListener('change',event=>{if(event.target.id==='quota-compare'||event.target.id==='quota-sort'){if(event.target.id==='quota-compare'){compareOwners=[];compareLabel=''}controls[event.target.id==='quota-compare'?'compare':'sort']=event.target.value;applyControls();save()}});
document.addEventListener('click',event=>{const target=event.target.closest('button[data-command]');if(!target||target.disabled)return;const command=target.dataset.command;
 const requestKey=command+':'+(target.dataset.id||'')+':'+(target.dataset.quotaKey||'');
 if(pending.has(requestKey)||(!independent.has(command)&&[...pending.values()].some(item=>!independent.has(item.command))))return;
 const requestId=session+'-'+(++sequence);pending.set(requestKey,{requestId,command});if(!independent.has(command))document.body.classList.add('waiting');
 api.postMessage({command,requestId,...(target.dataset.id?(command==='live.processEnd'?{processId:target.dataset.id}:{accountId:target.dataset.id}):{}),...(target.dataset.quotaKey?{quotaKey:target.dataset.quotaKey}:{})});
});
window.addEventListener('message',event=>{const message=event.data;if(!message)return;
 if(message.type==='patch'){
  const hadFocus=document.hasFocus(),active=document.activeElement,focusKey=active?.getAttribute('data-focus'),scroll={x:window.scrollX,y:window.scrollY};
  const incoming=new DOMParser().parseFromString(message.main,'text/html').querySelector('main');if(!incoming)return;
  if(typeof message.language==='string'&&Object.hasOwn(dictionaries,message.language)){language=message.language;document.documentElement.lang=language}
  morph(document.querySelector('main'),incoming);synchronized=true;bindDetails();applyControls();
  const restore=active?.isConnected?active:focusKey?[...document.querySelectorAll('[data-focus]')].find(node=>node.getAttribute('data-focus')===focusKey):null;
  if(hadFocus&&restore&&document.activeElement!==restore){for(let parent=restore.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;restore.focus({preventScroll:true})}
  window.scrollTo(scroll.x,scroll.y);return;
 }
 if(message.type!=='complete')return;for(const [k,item]of pending)if(item.command===message.command&&item.requestId===message.requestId)pending.delete(k);
 if(![...pending.values()].some(item=>!independent.has(item.command)))document.body.classList.remove('waiting');
});
bindDetails();applyControls();const catalogReport=document.getElementById('catalog-report');if(catalogReport)catalogReport.scrollIntoView({block:'nearest'});api.postMessage({type:'ready'});`;
}
