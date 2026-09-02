/**
 * Generates the fixture-difficulty ramp and proves it is safe.
 *
 *   node tools/palette.mjs
 *
 * Difficulty is an ORDERED quantity, so the scale's job is to preserve order.
 * Hue alone cannot do that for a colourblind reader, so the tiers are placed
 * at fixed OKLCH lightness targets and the result is checked three ways:
 * text contrast (4.5:1), monotonic real lightness, and monotonic lightness
 * under deuteranope / protanope / tritanope simulation.
 *
 * If you change a tier, run this. If it prints FAIL, the palette is not
 * shippable — that is the whole point of the file.
 */
import {report,cr,Lstar,simL} from './cvd.mjs';
const f=x=>x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055;
function oklch(L,C,h){const a=C*Math.cos(h*Math.PI/180),b=C*Math.sin(h*Math.PI/180);
  const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.2914855480*b)**3;
  return [4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.7076147010*s]
    .map(v=>Math.round(Math.max(0,Math.min(1,f(v)))*255));}
const hx=a=>'#'+a.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
function fit(L,h,want){let c=want;for(;c>.005;c-=.005){const A=c*Math.cos(h*Math.PI/180),B=c*Math.sin(h*Math.PI/180);
  const l=(L+.3963377774*A+.2158037573*B)**3,m=(L-.1055613458*A-.0638541728*B)**3,s=(L-.0894841775*A-1.2914855480*B)**3;
  const r=4.0767416621*l-3.3077115913*m+0.2309699292*s,g=-1.2684380046*l+2.6097574011*m-0.3413193965*s,bb=-0.0041960863*l-0.7034186147*m+1.7076147010*s;
  if([r,g,bb].every(v=>v>=-.001&&v<=1.001))break;} return c;}
const build=spec=>spec.map(s=>{const c=fit(s.L,s.h,s.c),bg=hx(oklch(s.L,c,s.h));
  const dk=hx(oklch(.17,Math.min(c,.05),s.h));
  return {bg,fg:cr(dk,bg)>=cr('#FFFFFF',bg)?dk:'#FFFFFF'};});

const DARK=build([{L:.880,h:155,c:.17},{L:.775,h:148,c:.17},{L:.680,h:238,c:.020},{L:.545,h:44,c:.16},{L:.470,h:22,c:.18}]);
const LIGHT=build([{L:.860,h:155,c:.18},{L:.755,h:148,c:.17},{L:.672,h:238,c:.022},{L:.520,h:42,c:.16},{L:.440,h:22,c:.18}]);
const okD=report('dark  (page #0B0D0E)', DARK, '#0B0D0E');
const okL=report('light (page #F2F3F1)', LIGHT, '#F2F3F1');
const emit=(t,n)=>t.map((x,i)=>`  --f${i+1}bg:${x.bg}; --f${i+1}:${x.fg};`).join('\n');
console.log('\n/* dark */\n'+emit(DARK));
console.log('\n/* light */\n'+emit(LIGHT));
console.log('\nboth pass:', okD&&okL);
