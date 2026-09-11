// Shared geometry for artwork, labels, highlights and impacts.
export const BOARD_GEOMETRY = Object.freeze({"sectors":20,"center":50,"outer":42,"innerBull":7,"tripleInner":29.8,"tripleOuter":32.8,"impactOuter":37,"impactInner":22,"impactTriple":31.3});
export function renderDartboard(style="classic") {
  const g=BOARD_GEOMETRY, wood=style==="rustic";
  const p=(r,a)=>[500+r*10*Math.cos(a*Math.PI/180),500+r*10*Math.sin(a*Math.PI/180)].map(v=>v.toFixed(3)).join(",");
  const wedge=(r1,r2,a,b)=>`M${p(r1,a)} L${p(r2,a)} A${r2*10},${r2*10} 0 0 1 ${p(r2,b)} L${p(r1,b)} A${r1*10},${r1*10} 0 0 0 ${p(r1,a)} Z`;
  const out=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img"><title>${wood?"Гоблинская":"Классическая"} мишень — ровно 20 секторов</title>
<defs>
<radialGradient id="rim"><stop stop-color="${wood?"#a07b4d":"#616268"}"/><stop offset=".78" stop-color="${wood?"#725337":"#49494e"}"/><stop offset="1" stop-color="${wood?"#332419":"#292b30"}"/></radialGradient>
<linearGradient id="ivory" x2="1" y2="1"><stop stop-color="${wood?"#d9b887":"#fff2d4"}"/><stop offset="1" stop-color="${wood?"#a88655":"#e4d4af"}"/></linearGradient>
<linearGradient id="dark" x2="1" y2="1"><stop stop-color="${wood?"#393b32":"#51535a"}"/><stop offset="1" stop-color="${wood?"#25251f":"#393b41"}"/></linearGradient>
<radialGradient id="metal"><stop stop-color="#b2a58b"/><stop offset=".6" stop-color="#756c59"/><stop offset="1" stop-color="#2e2c25"/></radialGradient>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".008 .16" numOctaves="3" seed="28" result="n"/><feColorMatrix in="n" type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope=".45" intercept=".55"/><feFuncG type="linear" slope=".45" intercept=".55"/><feFuncB type="linear" slope=".45" intercept=".55"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/><feComposite in2="SourceGraphic" operator="in"/></filter>
<clipPath id="disc"><circle cx="500" cy="500" r="415"/></clipPath>
</defs>
<circle cx="500" cy="500" r="483" fill="url(#rim)" stroke="${wood?"#b19972":"#77777a"}" stroke-width="4"/>
<circle cx="500" cy="500" r="453" fill="none" stroke="${wood?"#2c2119":"#26272b"}" stroke-width="${wood?30:3}"/>`];
  if(wood) for(let i=0;i<20;i++) { const a=i*18-99;
    out.push(`<path d="${wedge(42.5,47.5,a+.5,a+17.5)}" fill="${i%2?"#705236":"#8b6942"}" stroke="#392b20" stroke-width="3" filter="url(#grain)"/>`);
  }
  out.push(`<g${wood?' filter="url(#grain)"':""}>`);
  for(let i=0;i<g.sectors;i++){
    const a=i*360/g.sectors-99,b=a+360/g.sectors;
    out.push(`<g data-sector="${i+1}"><path d="${wedge(g.innerBull,g.outer,a,b)}" fill="url(#${i%2?"ivory":"dark"})" stroke="${wood?"#30291f":"#303237"}" stroke-width="${wood?3.5:2.5}"/><path d="${wedge(g.tripleInner,g.tripleOuter,a,b)}" fill="${i%2?(wood?"#738d65":"#8eb6a4"):(wood?"#b86949":"#dc9289")}" stroke="#373d32" stroke-width="2"/></g>`);
  }
  out.push("</g>");
  if(wood) {
    out.push('<g clip-path="url(#disc)" opacity=".22" stroke="#f0d3a0" fill="none">');
    for(let i=0;i<90;i++){const x=100+(i*73)%800,y=90+(i*107)%820;out.push(`<path d="M${x} ${y} q${8+i%15} ${i%7-3} ${16+i%35} ${i%5-2}" stroke-width="${i%3+1}"/>`);}
    out.push("</g>");
    for(let i=0;i<20;i++){const a=i*18-90;const [x,y]=p(31.3,a).split(",");out.push(`<circle cx="${x}" cy="${y}" r="5" fill="url(#metal)" stroke="#352f25" stroke-width="1.5"/>`);}
    for(let i=0;i<4;i++){const a=i*90+45;out.push(`<path d="${wedge(42.8,47.8,a-2,a+2)}" fill="#514b3d" stroke="#292820" stroke-width="2"/>`);const [x,y]=p(45.3,a).split(",");out.push(`<circle cx="${x}" cy="${y}" r="7" fill="url(#metal)"/>`);}
    out.push('<circle cx="500" cy="500" r="475" fill="none" stroke="#b39a65" stroke-width="5" stroke-dasharray="5 3"/>');
  }
  out.push(`<circle cx="500" cy="500" r="70" fill="${wood?"#71835a":"#8bb49c"}" stroke="#30392e" stroke-width="4"/>
<circle cx="500" cy="500" r="32" fill="${wood?"#b56545":"#dc9289"}" stroke="#3b332c" stroke-width="4"/>`);
  if(wood) for(let i=0;i<6;i++){const [x,y]=p(5.2,i*60).split(",");out.push(`<circle cx="${x}" cy="${y}" r="4" fill="url(#metal)"/>`);}
  out.push("</svg>");
  return out.join("\n");
}
