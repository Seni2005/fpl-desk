/* Fixture-difficulty ramp: pick fills whose LIGHTNESS is monotonic across the
   five tiers, so the scale still orders correctly under total colour loss —
   then verify text contrast and three CVD simulations. */
const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
const srgb=c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4};
const lum=h=>{const[r,g,b]=hex(h).map(srgb);return .2126*r+.7152*g+.0722*b};
const cr=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05)};
const Lstar=h=>{const y=lum(h);return y<=216/24389?y*24389/27:Math.cbrt(y)*116-16};
// Viénot–Brettel–Mollon simulation. The RGB→LMS matrix and the projection
// coefficients must come from the SAME basis or neutrals shift, which is the
// give-away that the maths is wrong — a grey must simulate as itself.
const RGB2LMS=[[17.8824,43.5161,4.11935],[3.45565,27.1554,3.86714],[0.0299566,0.184309,1.46709]];
const LMS2RGB=[[0.0809444479,-0.130504409,0.116721066],[-0.0102485335,0.0540193266,-0.113614708],[-0.000365296938,-0.00412161469,0.693511405]];
const mul=(m,v)=>m.map(r=>r[0]*v[0]+r[1]*v[1]+r[2]*v[2]);
const CVD={
  deuter:[[1,0,0],[0.494207,0,1.24827],[0,0,1]],
  protan:[[0,2.02344,-2.52581],[0,1,0],[0,0,1]],
  tritan:[[1,0,0],[0,1,0],[-0.395913,0.801109,0]],
};
function sim(h,kind){
  const lin=hex(h).map(srgb);
  const out=mul(LMS2RGB,mul(CVD[kind],mul(RGB2LMS,lin)));
  return out.map(v=>Math.max(0,Math.min(1,v)));
}
const simL=(h,k)=>{const[r,g,b]=sim(h,k);const y=.2126*r+.7152*g+.0722*b;
  return y<=216/24389?y*24389/27:Math.cbrt(y)*116-16};

function report(name,tiers,bg){
  console.log(`\n── ${name} ──`);
  let ok=true;
  const Ls=tiers.map(t=>Lstar(t.bg));
  tiers.forEach((t,i)=>{
    const c=cr(t.fg,t.bg), cbg=cr(t.bg,bg);
    const pass=c>=4.5;
    if(!pass) ok=false;
    console.log(`  ${i+1}  fill ${t.bg}  text ${t.fg}  L*${Ls[i].toFixed(1).padStart(5)}  text-contrast ${c.toFixed(2)}${pass?'':'  ✗ under 4.5'}  chip-vs-page ${cbg.toFixed(2)}`);
  });
  // monotonic lightness?
  const dir=Ls[0]>Ls[4]?-1:1;
  const mono=Ls.every((v,i)=>i===0||(dir<0?v<Ls[i-1]:v>Ls[i-1]));
  const gaps=Ls.slice(1).map((v,i)=>Math.abs(v-Ls[i]));
  console.log(`  lightness ${mono?'MONOTONIC':'NOT monotonic ✗'}  min step ${Math.min(...gaps).toFixed(1)} L*`);
  if(!mono||Math.min(...gaps)<4) ok=false;
  for(const k of ['deuter','protan','tritan']){
    const S=tiers.map(t=>simL(t.bg,k));
    const m=S.every((v,i)=>i===0||(dir<0?v<S[i-1]:v>S[i-1]));
    const g=S.slice(1).map((v,i)=>Math.abs(v-S[i]));
    console.log(`  ${k.padEnd(7)} order ${m?'holds':'BREAKS ✗'}  min step ${Math.min(...g).toFixed(1)} L*`);
    if(!m||Math.min(...g)<3) ok=false;
  }
  console.log(`  => ${ok?'PASS':'FAIL'}`);
  return ok;
}
export {report,cr,Lstar,simL};
