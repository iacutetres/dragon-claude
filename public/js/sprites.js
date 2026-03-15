// ══════════════════════════════════════════════
//  DATA
// ══════════════════════════════════════════════
const CHAR_DATA = [
  { id:'goku',      name:'GOKU',       sprite:'sp-goku',      col:'#ff6600', glow:'#ff660044', defaultFeature:'auth'     },
  { id:'vegeta',    name:'VEGETA',     sprite:'sp-vegeta',    col:'#bb66ff', glow:'#bb66ff44', defaultFeature:'profile'  },
  { id:'gohan',     name:'GOHAN',      sprite:'sp-gohan',     col:'#00d4ff', glow:'#00d4ff44', defaultFeature:'home'     },
  { id:'piccolo',   name:'PICCOLO',    sprite:'sp-piccolo',   col:'#00ff88', glow:'#00ff8844', defaultFeature:'payments' },
  { id:'krillin',   name:'KRILLIN',    sprite:'sp-krillin',   col:'#f5c400', glow:'#f5c40044', defaultFeature:'settings' },
  { id:'trunks',    name:'TRUNKS',     sprite:'sp-trunks',    col:'#cc44aa', glow:'#cc44aa44', defaultFeature:''         },
  { id:'bulma',     name:'BULMA',      sprite:'sp-bulma',     col:'#3399ff', glow:'#3399ff44', defaultFeature:''         },
  { id:'frieza',    name:'FRIEZA',     sprite:'sp-frieza',    col:'#cc88ff', glow:'#cc88ff44', defaultFeature:''         },
  { id:'beerus',    name:'BEERUS',     sprite:'sp-beerus',    col:'#aa22cc', glow:'#aa22cc44', defaultFeature:''         },
  { id:'android17', name:'N°17',       sprite:'sp-android17', col:'#0088ff', glow:'#0088ff44', defaultFeature:''         },
  { id:'cell',      name:'CELL',       sprite:'sp-cell',      col:'#88cc00', glow:'#88cc0044', defaultFeature:''         },
  { id:'buu',       name:'MAJIN BUU',  sprite:'sp-buu',       col:'#ff88aa', glow:'#ff88aa44', defaultFeature:''         },
];

// Import pixel sprites from dragonball-chars.html and inject them into existing SVG symbols.
const DB_SC = 1;
const sk='#F4C27A', skD='#C8884A';
const bk='#1a1a1a', bkL='#444444';
const gO='#FF6B00', gOL='#FF9A00', gB='#4a8cff', gBL='#7ab0ff';
const sy='#FFD700', syL='#FFEE88';
const vA='#e8e8e8', vB='#1a2a6c', vBL='#2a3d9e';
const ghP='#6a0080', ghPL='#9b00bb';
const pG='#2d7a2d', pGL='#3daa3d', pP='#7a2d7a', pPL='#9a3d9a', pC='#cc2200', pR='#cc0000';
const kO='#FF7722', kOL='#FF9944', kB='#4488ff', kBL='#88aaff';
const tP='#8800cc', tPL='#bb44ff', tB='#0055aa', tBL='#2266cc';
const bH='#44aaff', bHL='#88ccff', bPk='#ff66aa', bPkL='#ffaacc', bW='#f5f0ff';
const fW='#f0e8ff', fWL='#ffffff', fP='#9933cc', fPL='#cc77ff', fR='#cc0000';
const beG='#7a6aaa', beGL='#9a8acc', beY='#ddcc00', beYL='#ffee66';
const beP='#5500aa', bePL='#8844cc', beW='#ddcc88';
const x = null;

function mc(w,h){ const c=document.createElement('canvas'); c.width=w*DB_SC; c.height=h*DB_SC; return c; }
function ds(ctx,g){ g.forEach((row,y)=>row.forEach((col,px)=>{ if(!col)return; ctx.fillStyle=col; ctx.fillRect(px*DB_SC,y*DB_SC,DB_SC,DB_SC); })); }

function drawGoku(){ const c=mc(14,21); ds(c.getContext('2d'),[
  [x,x,x,sy,sy,sy,sy,sy,sy,sy,x,x,x,x],[x,x,sy,syL,sy,syL,sy,syL,sy,syL,sy,x,x,x],[x,sy,syL,sy,syL,sy,syL,sy,syL,sy,syL,sy,x,x],[x,sy,sy,sy,sy,sy,sy,sy,sy,sy,sy,sy,x,x],[x,sy,sy,sk,sk,sk,sk,sk,sk,sy,sy,sy,x,x],[x,sy,sk,sk,sk,sk,sk,sk,sk,sk,sy,x,x,x],[x,sk,sk,bk,skD,sk,sk,skD,bk,sk,sk,x,x,x],[x,sk,sk,sk,sk,skD,sk,sk,sk,sk,sk,x,x,x],[x,sk,sk,sk,sk,sk,sk,sk,sk,sk,sk,x,x,x],[x,gO,gOL,gOL,sk,sk,sk,sk,gOL,gOL,gO,x,x,x],[sk,gO,gOL,gO,gOL,gOL,gOL,gO,gOL,gO,gOL,gO,sk,x],[sk,gO,gOL,gO,gB,gBL,gBL,gB,gO,gO,gOL,gO,sk,x],[sk,gO,gO,gO,gB,gBL,gBL,gB,gO,gO,gO,gO,sk,x],[x,sk,bk,bk,bk,bk,bk,bk,bk,bk,bk,sk,x,x],[x,sk,gB,gBL,gB,x,x,gB,gBL,gB,gBL,sk,x,x],[x,x,gB,gBL,gB,x,x,gB,gBL,gB,x,x,x,x],[x,x,gO,gOL,gO,x,x,gO,gOL,gO,x,x,x,x],[x,x,gO,gOL,gO,x,x,gO,gOL,gO,x,x,x,x],[x,x,bk,bkL,bk,x,x,bk,bkL,bk,x,x,x,x],[x,bk,bkL,bk,bk,x,x,bk,bkL,bk,bk,x,x,x],
]); return c; }

function drawVegeta(){ const c=mc(13,19); ds(c.getContext('2d'),[
  [x,x,sy,sy,x,sy,sy,x,sy,sy,x,x,x],[x,sy,syL,sy,sy,syL,sy,sy,syL,sy,sy,x,x],[x,sy,syL,syL,syL,syL,syL,syL,syL,syL,sy,x,x],[x,sy,sy,sy,sy,sy,sy,sy,sy,sy,sy,x,x],[x,sy,sy,sk,sk,sk,sk,sk,sk,sy,sy,x,x],[x,sy,sk,sk,sk,sk,sk,sk,sk,sk,sy,x,x],[x,sk,sk,bk,skD,sk,sk,skD,bk,sk,sk,x,x],[x,sk,sk,sk,sk,sk,sk,sk,sk,sk,sk,x,x],[x,vA,vA,vA,sk,sk,sk,sk,vA,vA,vA,x,x],[sk,vA,vA,vA,vA,vA,vA,vA,vA,vA,vA,sk,x],[sk,vA,vB,vBL,vB,vBL,vBL,vB,vBL,vB,vA,sk,x],[sk,vA,vB,vBL,vB,vBL,vBL,vB,vBL,vB,vA,sk,x],[x,sk,bk,bk,bk,bk,bk,bk,bk,bk,sk,x,x],[x,sk,vB,vBL,vB,x,x,vB,vBL,vB,sk,x,x],[x,x,vB,vBL,vB,x,x,vB,vBL,vB,x,x,x],[x,x,vA,vA,vA,x,x,vA,vA,vA,x,x,x],[x,x,bk,bkL,bk,x,x,bk,bkL,bk,x,x,x],[x,bk,bkL,bk,bk,x,x,bk,bkL,bk,bk,x,x],
]); return c; }

function drawPiccolo(){ const c=mc(12,20); ds(c.getContext('2d'),[
  [x,x,x,pGL,pG,x,pGL,pG,x,x,x,x],[x,x,pGL,pG,x,x,x,pGL,pG,x,x,x],[x,pGL,pG,x,x,x,x,x,pGL,pG,x,x],[x,x,pG,pGL,pG,pG,pG,pG,pGL,pG,x,x],[x,pG,pGL,pG,pG,pG,pG,pG,pGL,pG,pG,x],[x,pG,pG,pR,pG,pG,pG,pR,pG,pG,pG,x],[x,pG,pG,pG,pGL,pG,pGL,pG,pG,pG,pG,x],[x,pG,pG,pG,pG,pG,pG,pG,pG,pG,pG,x],[x,x,pC,pC,pG,pG,pG,pG,pC,pC,x,x],[x,pC,pP,pP,pP,pP,pP,pP,pP,pC,x,x],[pC,pP,pP,pP,pP,pP,pP,pP,pP,pP,pC,x],[pC,pP,pP,pP,pP,pP,pP,pP,pP,pP,pC,x],[x,pC,bk,bk,bk,bk,bk,bk,bk,pC,x,x],[x,pC,pP,pPL,pP,x,x,pP,pPL,pC,x,x],[x,x,pP,pPL,pP,x,x,pP,pPL,pP,x,x],[x,x,pG,pGL,pG,x,x,pG,pGL,pG,x,x],[x,x,pG,pGL,pG,x,x,pG,pGL,pG,x,x],[x,x,bk,bkL,bk,x,x,bk,bkL,bk,x,x],[x,bk,bkL,bk,bk,x,x,bk,bkL,bk,bk,x],
]); return c; }

function drawGohan(){ const c=mc(13,19); ds(c.getContext('2d'),[
  [x,x,bk,bk,bk,bk,bk,bk,bk,bk,x,x,x],[x,bk,bkL,bk,bk,bkL,bk,bkL,bk,bkL,bk,x,x],[x,bk,bk,bk,bk,bk,bk,bk,bk,bk,bk,x,x],[x,bk,bk,sk,sk,sk,sk,sk,bk,bk,bk,x,x],[x,bk,sk,sk,sk,sk,sk,sk,sk,sk,bk,x,x],[x,sk,sk,bk,skD,sk,sk,skD,bk,sk,sk,x,x],[x,sk,sk,sk,sk,skD,sk,sk,sk,sk,sk,x,x],[x,sk,sk,sk,sk,sk,sk,sk,sk,sk,sk,x,x],[x,ghP,ghPL,ghP,sk,sk,sk,ghP,ghPL,ghP,x,x,x],[sk,ghP,ghPL,ghP,ghP,ghPL,ghPL,ghP,ghPL,ghP,ghP,sk,x],[sk,ghP,ghPL,ghP,gO,gOL,gOL,gO,ghP,ghPL,ghP,sk,x],[sk,ghP,ghP,ghP,gO,gOL,gOL,gO,ghP,ghP,ghP,sk,x],[x,sk,bk,bk,bk,bk,bk,bk,bk,bk,sk,x,x],[x,sk,ghP,ghPL,ghP,x,x,ghP,ghPL,ghP,sk,x,x],[x,x,ghP,ghPL,ghP,x,x,ghP,ghPL,ghP,x,x,x],[x,x,gO,gOL,gO,x,x,gO,gOL,gO,x,x,x],[x,x,bk,bkL,bk,x,x,bk,bkL,bk,x,x,x],[x,bk,bkL,bk,bk,x,x,bk,bkL,bk,bk,x,x],
]); return c; }

function drawKrillin(){ const c=mc(11,17); ds(c.getContext('2d'),[
  [x,x,bk,bk,bk,bk,bk,bk,bk,x,x],[x,bk,sk,sk,sk,sk,sk,sk,sk,bk,x],[x,sk,skD,sk,skD,sk,skD,sk,skD,sk,x],[x,sk,sk,bk,skD,sk,skD,bk,sk,sk,x],[x,sk,sk,sk,sk,skD,sk,sk,sk,sk,x],[x,sk,sk,sk,sk,sk,sk,sk,sk,sk,x],[x,kO,kOL,kO,sk,sk,sk,kO,kOL,kO,x],[sk,kO,kOL,kO,kO,kOL,kO,kO,kOL,kO,sk],[sk,kO,kO,kO,kB,kBL,kB,kO,kO,kO,sk],[x,sk,bk,bk,bk,bk,bk,bk,bk,sk,x],[x,sk,kB,kBL,kB,x,kB,kBL,kB,sk,x],[x,x,kB,kBL,kB,x,kB,kBL,kB,x,x],[x,x,kO,kOL,kO,x,kO,kOL,kO,x,x],[x,x,bk,bkL,bk,x,bk,bkL,bk,x,x],[x,bk,bkL,bk,bk,x,bk,bkL,bk,bk,x],
]); return c; }

function drawTrunks(){ const c=mc(13,19); ds(c.getContext('2d'),[
  [x,x,tP,tPL,tP,tP,tP,tP,tPL,tP,x,x,x],[x,tP,tPL,tP,tPL,tP,tPL,tP,tPL,tPL,tP,x,x],[x,tP,tP,tP,tP,tP,tP,tP,tP,tP,tP,x,x],[x,tP,tP,sk,sk,sk,sk,sk,tP,tP,tP,x,x],[x,tP,sk,sk,sk,sk,sk,sk,sk,sk,tP,x,x],[x,sk,sk,bk,skD,sk,sk,skD,bk,sk,sk,x,x],[x,sk,sk,sk,sk,skD,sk,sk,sk,sk,sk,x,x],[x,sk,sk,sk,sk,sk,sk,sk,sk,sk,sk,x,x],[x,tB,tBL,tB,sk,sk,sk,tB,tBL,tB,x,x,x],[sk,tB,tBL,tB,tB,tBL,tBL,tB,tBL,tB,tBL,sk,x],[sk,tB,tBL,tB,tB,tBL,tBL,tB,tBL,tB,tBL,sk,x],[sk,tB,tB,tB,sk,'#fff','#fff',sk,tB,tB,tB,sk,x],[x,sk,bk,bk,bk,bk,bk,bk,bk,bk,sk,x,x],[x,x,tP,tPL,tP,x,x,tP,tPL,tP,x,x,x],[x,x,tP,tPL,tP,x,x,tP,tPL,tP,x,x,x],[x,x,bk,bkL,bk,x,x,bk,bkL,bk,x,x,x],[x,bk,bkL,bk,bk,x,x,bk,bkL,bk,bk,x,x],
]); return c; }

function drawBulma(){ const c=mc(12,19); ds(c.getContext('2d'),[
  [x,x,bH,bHL,bH,bH,bH,bH,bHL,bH,x,x],[x,bH,bHL,bH,bH,bH,bH,bH,bH,bHL,bH,x],[x,bH,bH,bH,bH,bH,bH,bH,bH,bH,bH,x],[x,bH,bH,sk,sk,sk,sk,sk,sk,bH,bH,x],[x,bH,sk,sk,sk,sk,sk,sk,sk,sk,bH,x],[x,sk,sk,bk,skD,sk,sk,skD,bk,sk,sk,x],[x,sk,sk,sk,sk,sk,bPk,bPk,sk,sk,sk,x],[x,bPk,bPkL,bPk,sk,sk,sk,bPk,bPkL,bPk,x,x],[bPk,bPkL,bPk,bPk,bPk,bPkL,bPkL,bPk,bPk,bPkL,bPk,bPk],[bPk,bPkL,bW,bW,bPk,bPkL,bPkL,bPk,bW,bW,bPkL,bPk],[x,bPk,bPk,bPk,bPk,bPk,bPk,bPk,bPk,bPk,bPk,x],[x,x,bPk,bPkL,bPk,bPk,bPk,bPk,bPkL,bPk,x,x],[x,x,sk,skD,sk,x,x,sk,skD,sk,x,x],[x,x,sk,skD,sk,x,x,sk,skD,sk,x,x],[x,x,sk,skD,sk,x,x,sk,skD,sk,x,x],[x,x,bk,bkL,bk,x,x,bk,bkL,bk,x,x],[x,bk,bkL,bk,bk,x,x,bk,bkL,bk,bk,x],
]); return c; }

function drawFrieza(){ const c=mc(13,19); ds(c.getContext('2d'),[
  [x,x,x,fW,fW,fW,fW,fW,fW,x,x,x,x],[x,x,fW,fWL,fWL,fWL,fWL,fWL,fWL,fW,x,x,x],[x,fW,fWL,fWL,fWL,fWL,fWL,fWL,fWL,fWL,fW,x,x],[x,fW,fP,fW,fW,fW,fW,fW,fW,fP,fW,x,x],[x,fW,fP,fR,fW,fW,fW,fW,fR,fP,fW,x,x],[x,fW,fP,fW,fW,fWL,fWL,fW,fW,fP,fW,x,x],[x,fW,fW,fP,fP,fW,fW,fP,fP,fW,fW,x,x],[x,x,fW,fW,fW,fW,fW,fW,fW,fW,x,x,x],[x,fP,fPL,fPL,fW,fW,fW,fW,fPL,fPL,fP,x,x],[fP,fPL,fP,fP,fP,fPL,fPL,fP,fP,fP,fPL,fP,x],[fP,fPL,fW,fW,fW,fWL,fWL,fW,fW,fW,fPL,fP,x],[fP,fPL,fW,fWL,fW,fWL,fWL,fW,fWL,fW,fPL,fP,x],[x,fP,fW,fW,fW,fWL,fWL,fW,fW,fW,fP,x,x],[x,fP,fPL,fPL,fP,x,x,fP,fPL,fPL,fP,x,x],[x,x,fP,fPL,fP,x,x,fP,fPL,fP,x,x,x],[x,x,fW,fWL,fW,x,x,fW,fWL,fW,x,x,x],[x,fW,fWL,fW,fW,x,x,fW,fWL,fW,fW,x,x],
]); return c; }

function drawBeerus(){ const c=mc(13,19); ds(c.getContext('2d'),[
  [x,beG,x,x,x,x,x,x,x,x,beG,x,x],[beG,beGL,x,x,x,x,x,x,x,x,beGL,beG,x],[beG,beGL,beG,x,x,x,x,x,x,beG,beGL,beG,x],[x,beG,beGL,beG,beG,beG,beG,beG,beG,beGL,beG,x,x],[x,beG,beGL,beGL,beG,beG,beG,beG,beGL,beGL,beG,x,x],[x,beG,beG,beY,beYL,beG,beG,beYL,beY,beG,beG,x,x],[x,beG,beG,beY,'#333',beG,beG,'#333',beY,beG,beG,x,x],[x,beG,beG,beG,beG,beG,beG,beG,beG,beG,beG,x,x],[x,beG,beGL,beG,beG,beGL,beGL,beG,beG,beGL,beG,x,x],[x,beP,bePL,beP,beG,beG,beG,beG,bePL,beP,x,x,x],[beP,bePL,beP,beP,beP,bePL,bePL,beP,beP,beP,bePL,beP,x],[beP,bePL,beW,beW,beP,bePL,bePL,beP,beW,beW,bePL,beP,x],[beP,bePL,beW,beW,beP,bePL,bePL,beP,beW,beW,bePL,beP,x],[x,beP,beP,beP,beP,bePL,bePL,beP,beP,beP,beP,x,x],[x,beG,beP,bePL,beP,x,x,beP,bePL,beP,beG,x,x],[x,x,beG,beGL,beG,x,x,beG,beGL,beG,x,x,x],[x,x,beG,beGL,beG,x,x,beG,beGL,beG,x,x,x],[x,beG,beGL,beG,beG,x,x,beG,beGL,beG,beG,x,x],
]); return c; }

function installDragonballSprites() {
  const replacements = {
    'sp-goku': drawGoku,
    'sp-vegeta': drawVegeta,
    'sp-gohan': drawGohan,
    'sp-piccolo': drawPiccolo,
    'sp-krillin': drawKrillin,
    'sp-trunks': drawTrunks,
    'sp-bulma': drawBulma,
    'sp-frieza': drawFrieza,
    'sp-beerus': drawBeerus,
  };

  Object.entries(replacements).forEach(([symbolId, drawFn]) => {
    const symbol = document.getElementById(symbolId);
    if (!symbol) return;
    const canvas = drawFn();
    const w = canvas.width;
    const h = canvas.height;
    symbol.setAttribute('viewBox', `0 0 ${w} ${h}`);
    symbol.innerHTML = `<image href="${canvas.toDataURL('image/png')}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" />`;
  });
}

