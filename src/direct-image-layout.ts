/** Presentation preferences only: never stores prompts, accounts or image data. */
export type ImageLayout = { resultsShare: number; resultsCollapsed: boolean };
export const IMAGE_LAYOUT_KEY = 'images.layout.v1';
export function readImageLayout(value: unknown): ImageLayout {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    resultsShare: typeof input.resultsShare === 'number' && Number.isFinite(input.resultsShare)
      ? Math.max(.2, Math.min(.6, input.resultsShare)) : .4,
    resultsCollapsed: input.resultsCollapsed === true,
  };
}

/** Runs inside the image webview, using its existing api/el/local/persist helpers. */
export function imageLayoutScript(initial: ImageLayout): string {
  return `
const layoutInitial=${JSON.stringify(readImageLayout(initial))};
const layoutSaved=local().layout;
let layout=layoutSaved&&typeof layoutSaved.resultsShare==='number'&&Number.isFinite(layoutSaved.resultsShare)
  ?{resultsShare:Math.max(.2,Math.min(.6,layoutSaved.resultsShare)),resultsCollapsed:layoutSaved.resultsCollapsed===true}:layoutInitial;
const workspace=el('workspace'),splitter=el('resultsSplitter'),results=el('results'),resultsToggle=el('resultsToggle');
const wideLayout=matchMedia('(min-width:801px)');
let layoutDrag;
const layoutBounds=()=>{const available=Math.max(1,workspace.getBoundingClientRect().width-20);return{available,min:Math.max(260,available*.2),max:Math.min(available-360,available*.6)}};
const layoutWidth=()=>{const b=layoutBounds();return Math.max(b.min,Math.min(b.max,b.available*layout.resultsShare))};
function applyLayout(){
  const wide=wideLayout.matches,collapsed=layout.resultsCollapsed;
  if(el('layoutNotice').textContent)el('layoutNotice').textContent=tr("directImageLayout.79a3d2f82d");
  workspace.classList.toggle('results-collapsed',collapsed);
  results.hidden=collapsed;splitter.hidden=collapsed||!wide;
  workspace.style.gridTemplateColumns=collapsed||!wide?'minmax(0,1fr)':'minmax(0,1fr) 20px '+layoutWidth()+'px';
  resultsToggle.textContent=collapsed?tr("directImageLayout.0a81ebddf4"):tr("directImageLayout.e6fe633174");resultsToggle.setAttribute('aria-expanded',String(!collapsed));
  if(wide&&!collapsed){const b=layoutBounds();splitter.setAttribute('aria-valuemin',String(Math.round(b.min/b.available*100)));splitter.setAttribute('aria-valuemax',String(Math.round(b.max/b.available*100)));splitter.setAttribute('aria-valuenow',String(Math.round(layoutWidth()/b.available*100)));splitter.setAttribute('aria-valuetext',tr("directImageLayout.21ba08f562")+Math.round(layoutWidth()/b.available*100)+'%');}
}
function saveLayout(){persist('layout',{...layout});api.postMessage({type:'layout',...layout});el('layoutNotice').textContent='';}
function setResultsWidth(width){const b=layoutBounds();layout.resultsShare=Math.max(b.min,Math.min(b.max,width))/b.available;applyLayout();}
function finishLayoutDrag(cancel=false){
  if(!layoutDrag)return;const previous=layoutDrag;layoutDrag=undefined;
  if(cancel)layout.resultsShare=previous.share;
  if(splitter.hasPointerCapture(previous.id))splitter.releasePointerCapture(previous.id);
  document.body.classList.remove('resizing-results');applyLayout();if(!cancel)saveLayout();
}
splitter.addEventListener('pointerdown',event=>{
  if(event.button!==0||!event.isPrimary||splitter.hidden||layoutDrag)return;
  event.preventDefault();splitter.focus();layoutDrag={id:event.pointerId,x:event.clientX,width:layoutWidth(),share:layout.resultsShare};
  splitter.setPointerCapture(event.pointerId);document.body.classList.add('resizing-results');
});
splitter.addEventListener('pointermove',event=>{if(layoutDrag?.id===event.pointerId)setResultsWidth(layoutDrag.width+layoutDrag.x-event.clientX)});
splitter.addEventListener('pointerup',event=>{if(layoutDrag?.id===event.pointerId)finishLayoutDrag()});
splitter.addEventListener('pointercancel',()=>finishLayoutDrag(true));
splitter.addEventListener('lostpointercapture',()=>finishLayoutDrag(true));
splitter.addEventListener('dblclick',()=>{finishLayoutDrag(true);layout.resultsShare=.4;applyLayout();saveLayout()});
splitter.addEventListener('keydown',event=>{
  if(splitter.hidden||!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;
  event.preventDefault();finishLayoutDrag(true);
  if(event.key==='Enter'){resultsToggle.click();return}
  const b=layoutBounds(),step=event.shiftKey?48:16;
  setResultsWidth(event.key==='Home'?b.min:event.key==='End'?b.max:layoutWidth()+(event.key==='ArrowLeft'?step:-step));saveLayout();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&layoutDrag){event.preventDefault();finishLayoutDrag(true)}});
resultsToggle.addEventListener('click',()=>{finishLayoutDrag(true);layout.resultsCollapsed=!layout.resultsCollapsed;applyLayout();saveLayout();resultsToggle.focus()});
window.addEventListener('blur',()=>finishLayoutDrag(true));
document.addEventListener('visibilitychange',()=>{if(document.hidden)finishLayoutDrag(true);else applyLayout()});
window.addEventListener('resize',()=>{finishLayoutDrag(true);applyLayout()});
new ResizeObserver(()=>applyLayout()).observe(workspace);
window.addEventListener('message',event=>{if(event.data?.type==='layoutPersistenceError')el('layoutNotice').textContent=tr("directImageLayout.79a3d2f82d")});
applyLayout();
`;
}
