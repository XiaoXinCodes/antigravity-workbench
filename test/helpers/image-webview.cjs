const vm=require('node:vm');
const {directImageHtml}=require('../../out/direct-image-view');

/** Executes the production webview script. Only DOM and VSCode bridge APIs are synthetic. */
exports.imageWebview=()=>{
 const elements=new Map(),sent=[],events=new Map();
 const element=tag=>({tagName:tag,value:'',textContent:'',className:'',dataset:{},children:[],disabled:false,hidden:false,open:false,style:{},listeners:new Map(),
  classList:{add(){},remove(){},toggle(){}},get options(){return this.children},
  append(...children){for(const child of children){child.parent=this;this.children.push(child)}},prepend(child){child.parent=this;this.children.unshift(child)},
  replaceChildren(...children){this.children=[];this.append(...children)},remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this)},
  addEventListener(name,fn){const rows=this.listeners.get(name)||[];rows.push(fn);this.listeners.set(name,rows)},dispatch(name){for(const fn of this.listeners.get(name)||[])fn({})},
  setAttribute(){},getAttribute(){return ''},getBoundingClientRect(){return{width:1200}},hasPointerCapture(){return false},
  querySelector(selector){const matches=child=>selector.startsWith('.')&&child.className.split(' ').includes(selector.slice(1));const search=root=>{for(const child of root.children){if(matches(child))return child;const nested=search(child);if(nested)return nested}};return search(this)},
  focus(){document.activeElement=this},click(){if(!this.disabled){this.onclick?.();this.dispatch('click')}}
 });
 const el=id=>{if(!elements.has(id))elements.set(id,element('div'));return elements.get(id)};
 const document={activeElement:null,documentElement:{lang:'zh-CN'},body:element('body'),getElementById:el,createElement:element,querySelectorAll:()=>[],addEventListener(){}};
 const window={addEventListener:(name,fn)=>{const rows=events.get(name)||[];rows.push(fn);events.set(name,rows)}};
 const script=directImageHtml('fixture').match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
 vm.runInNewContext(script,{document,window,matchMedia:()=>({matches:true}),ResizeObserver:class{observe(){}},acquireVsCodeApi:()=>({postMessage:msg=>sent.push(structuredClone(msg)),getState:()=>({}),setState(){}})});
 return{el,sent,document,message:data=>{for(const fn of events.get('message')||[])fn({data})}};
};
