/** Draw only the backend's already-filtered daily aggregates; missing usage stays a gap. */
export const localGenerationTrendScript = `
function renderTokenTrend(container,points){
 if(typeof document.createElementNS!=='function')return;
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 700 220');svg.setAttribute('role','img');svg.setAttribute('aria-label',tr('observations.trend'));svg.classList.add('wb-token-trend');
 const add=(tag,attrs,text)=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;svg.append(el);return el};
 const value=aggregate=>aggregate&&['complete','partial'].includes(aggregate.status)&&Number.isFinite(aggregate.sum)&&aggregate.sum>=0?aggregate.sum:null;
 const known=points.flatMap(p=>[value(p.tokens.input),value(p.tokens.outputTotal)]).filter(v=>v!==null),max=Math.max(1,...known),width=620/Math.max(1,points.length),bar=Math.min(20,width*.28),shownEvery=Math.max(1,Math.ceil(points.length/7));
 for(let i=0;i<4;i++){const y=180-i*48;add('line',{x1:55,x2:680,y1:y,y2:y,class:'wb-trend-gridline'});add('text',{x:4,y:y+4},new Intl.NumberFormat(language,{notation:'compact',maximumFractionDigits:1}).format(max*i/3));}
 points.forEach((point,index)=>{const x=55+(index+.5)*width;for(const[metric,offset,style]of [['input',-bar-1,'wb-trend-input'],['outputTotal',1,'wb-trend-output']]){const v=value(point.tokens[metric]),height=v===null?0:v/max*144;if(v===null){add('text',{x:x+offset+bar/2,y:176,'text-anchor':'middle',class:'wb-trend-unknown'},'—');continue;}const rect=add('rect',{x:x+offset,y:180-Math.max(2,height),width:bar,height:Math.max(2,height),rx:2,class:style});const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=point.day+' · '+tr('observations.token.'+metric)+': '+new Intl.NumberFormat(language).format(v)+(point.tokens[metric].status==='partial'?' · '+tr('observations.knownSubtotal'):'');rect.append(title);}
 if(index%shownEvery===0||index===points.length-1)add('text',{x,y:205,'text-anchor':'middle'},point.day.slice(5));
 });
 const legend=document.createElement('p');legend.className='wb-trend-legend';for(const[key,style]of [['input','wb-trend-input'],['outputTotal','wb-trend-output']]){const span=document.createElement('span'),dot=document.createElement('i');dot.className=style;span.append(dot,document.createTextNode(tr('observations.token.'+key)));legend.append(span);}container.append(legend,svg);
}
`;
