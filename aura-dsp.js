/* ============================================================
   Aura — DSP engine

   Lives in the same document as the player, because Web Audio
   can only process an audio element in its own page. Opening
   the panel never interrupts playback.
   ============================================================ */
'use strict';

/* ---------- AudioWorklet source, delivered as a Blob ---------- */
const WORKLET_SRC = `
class Biq{
  constructor(b0,b1,b2,a1,a2){this.b0=b0;this.b1=b1;this.b2=b2;this.a1=a1;this.a2=a2;this.x1=0;this.x2=0;this.y1=0;this.y2=0;}
  run(x){const y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;
    this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;return y;}
}
// BS.1770 K-weighting: a high-shelf then a high-pass
function kw(sr){
  const f0=1681.974450955533,G=3.999843853973347,Q=0.7071752369554196;
  const K=Math.tan(Math.PI*f0/sr),Vh=Math.pow(10,G/20),Vb=Math.pow(Vh,0.4996667741545416);
  const d=1+K/Q+K*K;
  const s1=new Biq((Vh+Vb*K/Q+K*K)/d,2*(K*K-Vh)/d,(Vh-Vb*K/Q+K*K)/d,2*(K*K-1)/d,(1-K/Q+K*K)/d);
  const f1=38.13547087602444,Q1=0.5003270373238773,K1=Math.tan(Math.PI*f1/sr);
  const d1=1+K1/Q1+K1*K1;
  const s2=new Biq(1,-2,1,2*(K1*K1-1)/d1,(1-K1/Q1+K1*K1)/d1);
  return [s1,s2];
}
class Meter extends AudioWorkletProcessor{
  constructor(){
    super();
    this.kL=kw(sampleRate);this.kR=kw(sampleRate);
    this.hop=Math.round(sampleRate*0.1);
    this.acc=0;this.accN=0;this.blocks=[];this.mom=[];this.sh=[];
    this.tp=0;this.clips=0;this.sumSq=0;this.sumN=0;this.pk=0;
    this.cn=0;this.cl=0;this.cr=0;
    this.go=new Float32Array(160);this.gi=0;this.t=0;
    this.port.onmessage=e=>{if(e.data==='reset'){this.tp=0;this.clips=0;this.blocks=[];this.pk=0;}};
  }
  // Catmull-Rom between samples: reveals inter-sample peaks
  tpk(p,c,n,nn){
    let m=Math.abs(c);
    for(let i=1;i<4;i++){
      const t=i/4,t2=t*t,t3=t2*t;
      const v=0.5*((2*c)+(-p+n)*t+(2*p-5*c+4*n-nn)*t2+(-p+3*c-3*n+nn)*t3);
      const a=Math.abs(v);if(a>m)m=a;
    }
    return m;
  }
  process(inputs){
    const ip=inputs[0];
    if(!ip||!ip.length)return true;
    const L=ip[0],R=ip[1]||ip[0],n=L.length;
    for(let i=0;i<n;i++){
      const l=L[i],r=R[i];
      const lp=i>0?L[i-1]:l,ln=i<n-1?L[i+1]:l,lnn=i<n-2?L[i+2]:ln;
      const rp=i>0?R[i-1]:r,rn=i<n-1?R[i+1]:r,rnn=i<n-2?R[i+2]:rn;
      const tv=Math.max(this.tpk(lp,l,ln,lnn),this.tpk(rp,r,rn,rnn));
      if(tv>this.tp)this.tp=tv;
      if(tv>=0.9995)this.clips++;
      const ap=Math.max(Math.abs(l),Math.abs(r));
      if(ap>this.pk)this.pk=ap;
      this.sumSq+=(l*l+r*r)*0.5;this.sumN++;
      const kl=this.kL[1].run(this.kL[0].run(l));
      const kr=this.kR[1].run(this.kR[0].run(r));
      this.acc+=kl*kl+kr*kr;this.accN++;
      this.cn+=l*r;this.cl+=l*l;this.cr+=r*r;
      if((i&3)===0&&this.gi<158){this.go[this.gi++]=l;this.go[this.gi++]=r;}
      if(this.accN>=this.hop){
        const ms=this.acc/this.accN;
        const lk=ms>0?-0.691+10*Math.log10(ms):-70;
        this.mom.push(lk);if(this.mom.length>4)this.mom.shift();
        this.sh.push(lk);if(this.sh.length>30)this.sh.shift();
        if(lk>-70)this.blocks.push(lk);
        if(this.blocks.length>7200)this.blocks.shift();
        this.acc=0;this.accN=0;
      }
    }
    if(++this.t%3===0){
      const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:-70;
      let integ=-70,lra=0;
      if(this.blocks.length){
        const e=v=>Math.pow(10,v/10);
        const m1=10*Math.log10(this.blocks.reduce((s,v)=>s+e(v),0)/this.blocks.length);
        const g=this.blocks.filter(v=>v>m1-10);
        if(g.length){
          integ=10*Math.log10(g.reduce((s,v)=>s+e(v),0)/g.length);
          const s=g.slice().sort((a,b)=>a-b);
          if(s.length>8)lra=s[Math.floor(s.length*0.95)]-s[Math.floor(s.length*0.10)];
        }
      }
      const rms=this.sumN?Math.sqrt(this.sumSq/this.sumN):0;
      this.port.postMessage({
        tp:this.tp,clips:this.clips,mom:avg(this.mom),short:avg(this.sh),integ,lra,
        crest:rms>0?20*Math.log10(this.pk/rms):0,
        corr:(this.cl>0&&this.cr>0)?this.cn/Math.sqrt(this.cl*this.cr):0,
        go:this.go.slice(0,this.gi)
      });
      this.gi=0;this.cn=this.cl=this.cr=0;this.sumSq=0;this.sumN=0;this.pk=0;
    }
    return true;
  }
}
registerProcessor('aura-meter',Meter);

class Limit extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[{name:'ceil',defaultValue:-1,minValue:-12,maxValue:0,automationRate:'k-rate'}];}
  constructor(){
    super();
    this.look=Math.round(sampleRate*0.005);
    this.buf=[new Float32Array(this.look),new Float32Array(this.look)];
    this.bi=0;this.env=1;this.rel=Math.exp(-1/(sampleRate*0.06));
  }
  process(inputs,outputs,p){
    const ip=inputs[0],op=outputs[0];
    if(!ip||!ip.length)return true;
    const c=Math.pow(10,p.ceil[0]/20);
    const ch=Math.min(ip.length,op.length),n=ip[0].length;
    for(let i=0;i<n;i++){
      let mx=0;
      for(let k=0;k<ch;k++){const v=Math.abs(ip[k][i]);if(v>mx)mx=v;}
      const want=mx>c?c/mx:1;
      if(want<this.env)this.env=want;
      else this.env=want+(this.env-want)*this.rel;
      for(let k=0;k<ch;k++){
        const d=this.buf[k]||(this.buf[k]=new Float32Array(this.look));
        const held=d[this.bi];d[this.bi]=ip[k][i];
        op[k][i]=held*this.env;
      }
      this.bi=(this.bi+1)%this.look;
    }
    return true;
  }
}
registerProcessor('aura-limit',Limit);
`;

/* ---------- Band layout + presets ---------- */
const EQ_DEF = [
  {f:31,q:0.7},{f:63,q:0.7},{f:125,q:0.9},{f:250,q:0.9},{f:500,q:1.0},
  {f:1000,q:1.0},{f:2000,q:1.0},{f:4000,q:1.0},{f:8000,q:0.9},{f:16000,q:0.7}
].map(b => ({...b, g:0}));

const PRESETS = {
  'Flat':       [0,0,0,0,0,0,0,0,0,0],
  'Bass lift':  [6,5,3.5,1.5,0,0,0,0,.5,1],
  'V-shape':    [5,4,2,-1,-2.5,-2,0,2,4,4.5],
  'Vocal':      [-3,-2,0,2,3.5,4,3,1.5,0,-1],
  'Warm':       [3,2.5,2,1,0,-.5,-1.5,-2,-1,0],
  'Bright':     [-2,-1.5,-1,0,.5,1.5,2.5,3.5,4,3],
  'Loudness':   [5,4,1.5,0,-1,-1.5,-.5,1.5,4,5],
  'Late night': [-2,-1,0,1.5,2.5,2.5,1.5,0,-1.5,-3]
};

const DSP = {
  ctx: null, src: null, built: false, worklet: false,
  on: false, bg: true, bypass: false,
  eq: EQ_DEF.map(b => ({...b})),
  preamp: 0, balance: 0, width: 1, xfeed: 0,
  lim: false, conv: false, ir: null,
  nodes: {},
  meterData: null, go: new Float32Array(0),
  abx: { trials: 0, hits: 0, x: null },
  wake: null, sleepT: null, sleepEnd: 0, sleepEOT: false,

  /* ---------- graph ---------- */
  async build() {
    if (this.built) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio unsupported');

      const opts = { latencyHint: $('d-buf') ? $('d-buf').value : 'playback' };
      const rate = parseInt(($('d-rate')||{}).value || '0', 10);
      if (rate) opts.sampleRate = rate;
      try { this.ctx = new AC(opts); }
      catch (e) { this.ctx = new AC({ latencyHint: opts.latencyHint }); toast('That sample rate was refused — using the device default','err'); }

      const c = this.ctx, n = this.nodes;
      this.src = c.createMediaElementSource(AURA.audio);

      n.pre = c.createGain();
      n.bands = this.eq.map(b => {
        const f = c.createBiquadFilter();
        f.type = 'peaking'; f.frequency.value = b.f; f.Q.value = b.q; f.gain.value = 0;
        return f;
      });

      // mid/side width
      n.sp = c.createChannelSplitter(2);
      n.mg = c.createChannelMerger(2);
      n.mid = c.createGain(); n.side = c.createGain();
      n.l2m = c.createGain(); n.r2m = c.createGain();
      n.l2s = c.createGain(); n.r2s = c.createGain();
      n.m2l = c.createGain(); n.m2r = c.createGain();
      n.s2l = c.createGain(); n.s2r = c.createGain();
      n.l2m.gain.value = .5; n.r2m.gain.value = .5;
      n.l2s.gain.value = .5; n.r2s.gain.value = -.5;
      n.m2l.gain.value = 1; n.m2r.gain.value = 1;
      n.s2l.gain.value = 1; n.s2r.gain.value = -1;

      // crossfeed
      n.xsp = c.createChannelSplitter(2);
      n.xmg = c.createChannelMerger(2);
      n.dl = c.createGain(); n.dr = c.createGain();
      n.xdl = c.createDelay(.01); n.xdr = c.createDelay(.01);
      n.xdl.delayTime.value = .00027; n.xdr.delayTime.value = .00027;
      n.xll = c.createBiquadFilter(); n.xlr = c.createBiquadFilter();
      n.xll.type = n.xlr.type = 'lowpass';
      n.xll.frequency.value = n.xlr.frequency.value = 700;
      n.xfl = c.createGain(); n.xfr = c.createGain();
      n.xfl.gain.value = n.xfr.gain.value = 0;

      n.bal = c.createStereoPanner ? c.createStereoPanner() : null;
      n.cv = c.createConvolver(); n.cv.normalize = true;
      n.an = c.createAnalyser(); n.an.fftSize = 4096; n.an.smoothingTimeConstant = .78;
      n.out = c.createGain();

      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type:'application/javascript' }));
        await c.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        n.meter = new AudioWorkletNode(c, 'aura-meter', { numberOfOutputs: 0 });
        n.meter.port.onmessage = e => this.onMeter(e.data);
        n.limit = new AudioWorkletNode(c, 'aura-limit');
        this.worklet = true;
      } catch (err) {
        console.warn('[Aura] AudioWorklet unavailable:', err);
        this.worklet = false;
      }

      this.wire();
      this.built = true;
      Ambient.attach(n.an);
      this.apply();
      this.reportOut();
      return true;
    } catch (err) {
      console.error('[Aura] DSP graph failed:', err);
      toast('Could not start the engine: ' + err.message, 'err');
      return false;
    }
  },

  wire() {
    const n = this.nodes, c = this.ctx;
    const all = [this.src, n.pre, ...(n.bands||[]), n.sp, n.mg, n.mid, n.side,
      n.l2m,n.r2m,n.l2s,n.r2s,n.m2l,n.m2r,n.s2l,n.s2r,
      n.xsp,n.xmg,n.dl,n.dr,n.xdl,n.xdr,n.xll,n.xlr,n.xfl,n.xfr,
      n.bal,n.cv,n.limit,n.an,n.out];
    all.forEach(x => { try { x && x.disconnect(); } catch(e) {} });

    this.src.connect(n.pre);
    let tail = n.pre;
    n.bands.forEach(b => { tail.connect(b); tail = b; });

    tail.connect(n.sp);
    n.sp.connect(n.l2m, 0); n.sp.connect(n.r2m, 1);
    n.sp.connect(n.l2s, 0); n.sp.connect(n.r2s, 1);
    n.l2m.connect(n.mid); n.r2m.connect(n.mid);
    n.l2s.connect(n.side); n.r2s.connect(n.side);
    n.mid.connect(n.m2l); n.mid.connect(n.m2r);
    n.side.connect(n.s2l); n.side.connect(n.s2r);
    n.m2l.connect(n.mg, 0, 0); n.s2l.connect(n.mg, 0, 0);
    n.m2r.connect(n.mg, 0, 1); n.s2r.connect(n.mg, 0, 1);

    n.mg.connect(n.xsp);
    n.xsp.connect(n.dl, 0); n.xsp.connect(n.dr, 1);
    n.dl.connect(n.xmg, 0, 0); n.dr.connect(n.xmg, 0, 1);
    n.xsp.connect(n.xdl, 0); n.xdl.connect(n.xll); n.xll.connect(n.xfl); n.xfl.connect(n.xmg, 0, 1);
    n.xsp.connect(n.xdr, 1); n.xdr.connect(n.xlr); n.xlr.connect(n.xfr); n.xfr.connect(n.xmg, 0, 0);

    let node = n.xmg;
    if (n.bal) { node.connect(n.bal); node = n.bal; }
    if (this.conv && this.ir) { n.cv.buffer = this.ir; node.connect(n.cv); node = n.cv; }
    if (this.lim && this.worklet) { node.connect(n.limit); node = n.limit; }

    node.connect(n.an);
    n.an.connect(n.out);
    if (this.worklet && n.meter) n.an.connect(n.meter);
    n.out.connect(this.ctx.destination);
  },

  apply() {
    if (!this.built) { this.drawCurve(); this.chainLine(); return; }
    const n = this.nodes;
    const live = this.on && !this.bypass;

    n.pre.gain.value = live ? Math.pow(10, this.preamp/20) : 1;
    n.bands.forEach((f,i) => {
      f.frequency.value = this.eq[i].f;
      f.Q.value = this.eq[i].q;
      f.gain.value = live ? this.eq[i].g : 0;
    });
    n.mid.gain.value = 1;
    n.side.gain.value = live ? this.width : 1;
    const xf = live ? this.xfeed * .5 : 0;
    n.xfl.gain.value = xf; n.xfr.gain.value = xf;
    if (n.bal) n.bal.pan.value = live ? this.balance : 0;
    if (n.limit) { try { n.limit.parameters.get('ceil').value = -1; } catch(e) {} }

    this.drawCurve(); this.chainLine();
  },

  reportOut() {
    if (!this.ctx) return;
    const bl = this.ctx.baseLatency ? (this.ctx.baseLatency*1000).toFixed(1) : '?';
    const ol = this.ctx.outputLatency ? (this.ctx.outputLatency*1000).toFixed(1) : '?';
    const el = $('d-outinfo');
    if (el) el.innerHTML =
      `Running at <b>${(this.ctx.sampleRate/1000).toFixed(1)} kHz</b>, latency ${bl} / ${ol} ms — both measured.<br>` +
      `The OS mixer still sits after this. A web page can't take exclusive control of a DAC.`;
    const l = $('d-lat');
    if (l) l.textContent = `${(this.ctx.sampleRate/1000).toFixed(1)}k · ${ol}ms`;
  },

  /** Plain-English summary of what's engaged, shown under the dock. */
  chainLine() {
    const el = $('chain');
    if (!el) return;
    if (!this.on) { el.innerHTML = this.bg ? 'Direct · background priority' : 'Direct'; return; }
    if (this.bypass) { el.innerHTML = '<b>A/B</b> — hearing it flat'; return; }
    const p = [];
    const eqOn = this.eq.some(b => b.g !== 0);
    if (this.preamp) p.push(`pre ${this.preamp > 0 ? '+' : ''}${this.preamp}dB`);
    if (eqOn) {
      const mx = this.eq.reduce((a,b) => Math.abs(b.g) > Math.abs(a.g) ? b : a);
      p.push(`EQ ${mx.g > 0 ? '+' : ''}${mx.g}dB @ ${mx.f >= 1000 ? (mx.f/1000)+'k' : mx.f}`);
    }
    if (this.width !== 1) p.push(`width ${Math.round(this.width*100)}%`);
    if (this.balance) p.push(`bal ${this.balance < 0 ? 'L' : 'R'}${Math.round(Math.abs(this.balance)*100)}`);
    if (this.xfeed) p.push(`crossfeed ${Math.round(this.xfeed*100)}%`);
    if (this.conv && this.ir) p.push('convolution');
    if (this.lim) p.push('limiter');
    el.innerHTML = p.length ? '<b>' + p.join('</b> · <b>') + '</b>' : 'DSP on · flat';
  },

  /* ---------- meters ---------- */
  onMeter(d) {
    this.meterData = d;
    if (d.go && d.go.length) this.go = d.go;
    if (!$('d-panel') || !$('d-panel').classList.contains('on')) return;

    const tp = d.tp > 0 ? 20*Math.log10(d.tp) : -99;
    const e = $('m-tp');
    e.textContent = tp <= -99 ? '—' : (tp > 0 ? '+' : '') + tp.toFixed(1);
    e.className = 'n' + (tp > -0.1 ? ' clip' : tp > -3 ? ' hot' : ' good');
    $('m-tpb').style.width = clamp((tp+40)/40*100, 0, 100) + '%';

    const set = (id, v) => { $(id).textContent = (v <= -70 || !isFinite(v)) ? '—' : v.toFixed(1); };
    set('m-mom', d.mom); set('m-short', d.short); set('m-int', d.integ);
    $('m-lra').textContent = d.lra > 0 ? d.lra.toFixed(1) : '—';
    $('m-crest').textContent = d.crest > 0 ? d.crest.toFixed(1) : '—';
    $('m-clip').textContent = d.clips;
    $('m-clip').className = 'n' + (d.clips > 0 ? ' clip' : '');
    $('m-corr').textContent = d.corr.toFixed(2);
    $('m-corrd').style.left = ((d.corr+1)/2*100) + '%';

    // Clipping is caused by pre-amp and EQ boosts — warn where the cause is
    const warn = $('gain-warn');
    if (warn) {
      if (d.clips > 0 && !this.lim) {
        warn.className = 'hint w';
        warn.textContent = `${d.clips} clipped sample${d.clips===1?'':'s'} — lower the pre-amp or switch the limiter on.`;
      } else if (tp > -0.5 && !this.lim) {
        warn.className = 'hint w';
        warn.textContent = 'Peaks are at the ceiling. A little pre-amp cut would give you headroom.';
      } else { warn.className = 'hint'; warn.textContent = ''; }
    }
  }
};

/* ============================================================
   EQ CURVE — the filters' real computed response
   ============================================================ */
const F0 = 20, F1 = 20000, DBR = 18;
const xOfF = (f,w) => (Math.log(f/F0)/Math.log(F1/F0))*w;
const fOfX = (x,w) => F0*Math.pow(F1/F0, x/w);
const yOfDb = (db,h) => h/2 - (db/DBR)*(h/2);

function fitCanvas(c) {
  const dpr = Math.min(devicePixelRatio||1, 2);
  const r = c.getBoundingClientRect();
  if (!r.width) return false;
  c.width = Math.floor(r.width*dpr);
  c.height = Math.floor(r.height*dpr);
  c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
  return true;
}

DSP.drawCurve = function () {
  const c = $('eq-cv'); if (!c) return;
  const x = c.getContext('2d');
  const r = c.getBoundingClientRect(), w = r.width, h = r.height;
  if (!w) return;
  x.clearRect(0,0,w,h);

  x.font = '9px ui-monospace,monospace';
  [31,63,125,250,500,1000,2000,4000,8000,16000].forEach(f => {
    const px = xOfF(f,w);
    x.strokeStyle = 'rgba(255,255,255,.055)';
    x.beginPath(); x.moveTo(px,0); x.lineTo(px,h); x.stroke();
    x.fillStyle = 'rgba(255,255,255,.2)';
    x.fillText(f>=1000?(f/1000)+'k':f, px+2, h-3);
  });
  [-12,-6,0,6,12].forEach(db => {
    const py = yOfDb(db,h);
    x.strokeStyle = db===0 ? 'rgba(255,255,255,.15)' : 'rgba(255,255,255,.055)';
    x.beginPath(); x.moveTo(0,py); x.lineTo(w,py); x.stroke();
    if (db) { x.fillStyle='rgba(255,255,255,.2)'; x.fillText((db>0?'+':'')+db, 2, py-2); }
  });

  if (!this.built) {
    x.fillStyle = 'rgba(255,255,255,.26)'; x.font = '11px sans-serif';
    x.fillText('Switch DSP on to see the response', 10, h/2 - 6);
    return;
  }

  const N = Math.max(180, Math.floor(w));
  const freqs = new Float32Array(N);
  for (let i=0;i<N;i++) freqs[i] = fOfX(i*(w/N), w);
  const tot = new Float32Array(N).fill(1);
  const mag = new Float32Array(N), ph = new Float32Array(N);
  this.nodes.bands.forEach(b => {
    b.getFrequencyResponse(freqs, mag, ph);
    for (let i=0;i<N;i++) tot[i] *= mag[i];
  });

  const live = this.on && !this.bypass;
  const pre = live ? Math.pow(10, this.preamp/20) : 1;
  const cs = getComputedStyle(document.documentElement);
  const R = cs.getPropertyValue('--accent-r').trim()||192;
  const G = cs.getPropertyValue('--accent-g').trim()||132;
  const B = cs.getPropertyValue('--accent-b').trim()||252;

  x.beginPath(); x.moveTo(0, yOfDb(0,h));
  for (let i=0;i<N;i++) {
    const db = 20*Math.log10(Math.max(1e-6, tot[i]*pre));
    x.lineTo(i*(w/N), yOfDb(clamp(db,-DBR,DBR), h));
  }
  x.lineTo(w, yOfDb(0,h)); x.closePath();
  const g = x.createLinearGradient(0,0,0,h);
  g.addColorStop(0, `rgba(${R},${G},${B},.2)`);
  g.addColorStop(1, 'rgba(34,211,238,.05)');
  x.fillStyle = g; x.fill();

  x.beginPath();
  for (let i=0;i<N;i++) {
    const db = 20*Math.log10(Math.max(1e-6, tot[i]*pre));
    const px = i*(w/N), py = yOfDb(clamp(db,-DBR,DBR), h);
    i ? x.lineTo(px,py) : x.moveTo(px,py);
  }
  x.strokeStyle = live ? `rgb(${R},${G},${B})` : 'rgba(255,255,255,.28)';
  x.lineWidth = 2; x.stroke();

  this.eq.forEach(b => {
    const px = xOfF(b.f,w), py = yOfDb(clamp(b.g,-DBR,DBR), h);
    x.beginPath(); x.arc(px,py,4.5,0,Math.PI*2);
    x.fillStyle = b.g === 0 ? 'rgba(255,255,255,.32)' : '#22d3ee';
    x.fill();
  });
};

/* ============================================================
   ANALYSIS PANEL — one canvas, tabbed
   ============================================================ */
DSP.view = 'spectrum';
DSP.gramReady = false;

DSP.drawViz = function () {
  if (!this.built || !this.nodes.an) return;
  const panel = $('d-panel');
  if (!panel || !panel.classList.contains('on')) return;
  const c = $('viz-cv'); if (!c) return;
  const x = c.getContext('2d');
  const r = c.getBoundingClientRect(), w = r.width, h = r.height;
  if (!w) return;

  const an = this.nodes.an;
  const bins = an.frequencyBinCount;
  const nyq = this.ctx.sampleRate/2;

  if (this.view === 'spectrum') {
    const d = new Uint8Array(bins); an.getByteFrequencyData(d);
    x.clearRect(0,0,w,h);
    const bars = w < 420 ? 40 : 72, gap = 1.5, bw = (w-gap*(bars-1))/bars;
    for (let i=0;i<bars;i++) {
      const a = F0*Math.pow(F1/F0, i/bars), b = F0*Math.pow(F1/F0, (i+1)/bars);
      const b0 = Math.floor(a/nyq*bins), b1 = Math.max(b0+1, Math.floor(b/nyq*bins));
      let pk = 0;
      for (let k=b0;k<b1&&k<bins;k++) if (d[k]>pk) pk = d[k];
      const bh = Math.max(1.5, pk/255*h), px = i*(bw+gap), py = h-bh;
      const g = x.createLinearGradient(0,h,0,py);
      g.addColorStop(0,'rgba(192,132,252,.85)'); g.addColorStop(1,'rgba(34,211,238,.95)');
      x.fillStyle = g;
      x.beginPath();
      if (x.roundRect) x.roundRect(px,py,bw,bh,1.5); else x.rect(px,py,bw,bh);
      x.fill();
    }
  }
  else if (this.view === 'gram') {
    if (!this.gramReady) { x.fillStyle = '#07070a'; x.fillRect(0,0,w,h); this.gramReady = true; }
    const d = new Uint8Array(bins); an.getByteFrequencyData(d);
    x.putImageData(x.getImageData(2,0,w-2,h), 0, 0);
    x.clearRect(w-2,0,2,h);
    for (let y=0;y<h;y++) {
      const f = F0*Math.pow(F1/F0, 1-(y/h));
      const b = Math.min(bins-1, Math.floor(f/nyq*bins));
      const v = d[b]/255;
      x.fillStyle = v<.02 ? '#07070a'
        : v<.3  ? `rgba(80,40,140,${.25+v})`
        : v<.55 ? `rgba(192,132,252,${v})`
        : v<.78 ? `rgba(34,211,238,${v})`
        : `rgba(240,250,255,${v})`;
      x.fillRect(w-2,y,2,1);
    }
  }
  else if (this.view === 'gonio') {
    x.fillStyle = 'rgba(7,7,10,.3)'; x.fillRect(0,0,w,h);
    x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0,h); x.lineTo(w,0); x.moveTo(0,0); x.lineTo(w,h); x.stroke();
    x.beginPath(); x.arc(w/2,h/2,Math.min(w,h)*.42,0,Math.PI*2); x.stroke();
    x.fillStyle = 'rgba(34,211,238,.7)';
    for (let i=0;i+1<this.go.length;i+=2) {
      const l = this.go[i], rr = this.go[i+1];
      const px = (l-rr)*.7071, py = (l+rr)*.7071;
      x.fillRect(w/2 + px*w*.4, h/2 - py*h*.4, 1.7, 1.7);
    }
  }
  else if (this.view === 'wave') {
    this.drawWave();
  }
};

/* ---------- waveform overview ---------- */
DSP.peaks = null;
DSP.drawWave = function () {
  const c = $('viz-cv'); if (!c) return;
  const x = c.getContext('2d');
  const r = c.getBoundingClientRect(), w = r.width, h = r.height;
  x.clearRect(0,0,w,h);
  if (!this.peaks) {
    x.fillStyle = 'rgba(255,255,255,.2)'; x.font = '11px sans-serif';
    x.fillText('Play a track to build its waveform', 10, h/2+4);
    return;
  }
  const N = this.peaks.length, bw = w/N;
  const a = AURA.audio;
  const prog = isFinite(a.duration) && a.duration ? a.currentTime/a.duration : 0;
  for (let i=0;i<N;i++) {
    const bh = Math.max(1, this.peaks[i]*h*.9);
    x.fillStyle = (i/N) < prog ? 'rgba(192,132,252,.9)' : 'rgba(255,255,255,.16)';
    x.fillRect(i*bw, (h-bh)/2, Math.max(.6, bw-.3), bh);
  }
};

DSP.buildWave = async function (url) {
  this.peaks = null;
  const note = $('viz-note'); if (note) note.textContent = 'decoding…';
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const tmp = this.ctx || new AC();
    const buf = await tmp.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const N = 1200, ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length/N));
    const pk = new Float32Array(N);
    for (let i=0;i<N;i++) {
      let m = 0;
      const s = i*step, e = Math.min(ch.length, s+step);
      for (let j=s;j<e;j++) { const v = Math.abs(ch[j]); if (v>m) m = v; }
      pk[i] = m;
    }
    this.peaks = pk;
    if (note) note.textContent = `${fmtTime(buf.duration)} · ${buf.numberOfChannels}ch · ${(buf.sampleRate/1000).toFixed(1)}k`;
  } catch (e) {
    if (note) note.textContent = 'could not decode';
  }
  if (this.view === 'wave') this.drawWave();
};

/* ============================================================
   AUTOEQ
   ============================================================ */
DSP.applyAutoEq = function (txt) {
  const pre = txt.match(/Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const rows = [...txt.matchAll(/Filter\s+\d+:\s*ON\s+(\w+)\s+Fc\s+(\d+(?:\.\d+)?)\s*Hz\s+Gain\s+(-?\d+(?:\.\d+)?)\s*dB\s+Q\s+(\d+(?:\.\d+)?)/gi)];
  if (!rows.length) return { ok:false, msg:'No filter lines recognised in that text.' };

  this.eq.forEach(b => { b.g = 0; });
  let used = 0, shelves = 0;
  rows.forEach(m => {
    const type = m[1].toUpperCase(), fc = parseFloat(m[2]);
    const gain = parseFloat(m[3]), q = parseFloat(m[4]);
    if (type !== 'PK') { shelves++; return; }
    let best = 0, bd = Infinity;
    this.eq.forEach((b,i) => {
      const d = Math.abs(Math.log(b.f) - Math.log(fc));
      if (d < bd) { bd = d; best = i; }
    });
    if (Math.abs(this.eq[best].g) < Math.abs(gain)) {
      this.eq[best].g = clamp(gain, -12, 12);
      this.eq[best].q = clamp(q, .3, 6);
    }
    used++;
  });
  if (pre) this.preamp = clamp(parseFloat(pre[1]), -24, 12);
  return { ok:true, used, shelves };
};

/* ============================================================
   PERSISTENCE
   ============================================================ */
DSP.save = function () {
  lsSet(AURA.K.dsp, {
    eq: this.eq.map(b => ({...b})),
    preamp: this.preamp, balance: this.balance, width: this.width, xfeed: this.xfeed,
    lim: this.lim, conv: this.conv,
    rate: ($('d-rate')||{}).value, buf: ($('d-buf')||{}).value, view: this.view
  });
};
DSP.load = function () {
  const s = lsGet(AURA.K.dsp, null);
  if (!s) return;
  if (Array.isArray(s.eq) && s.eq.length === 10) this.eq = s.eq.map(b => ({...b}));
  this.preamp = s.preamp || 0;
  this.balance = s.balance || 0;
  this.width = s.width ?? 1;
  this.xfeed = s.xfeed || 0;
  this.lim = !!s.lim;
  if (s.view) this.view = s.view;
  if (s.rate && $('d-rate')) $('d-rate').value = s.rate;
  if (s.buf && $('d-buf')) $('d-buf').value = s.buf;
};

/* ============================================================
   INFO TEXT — plain language, including what things don't do
   ============================================================ */
registerInfo({
  eq: { t:'Parametric equaliser',
    d:'Ten filters that cut or boost a band of frequencies. The curve is the real computed response of those filters, not a drawing. Drag on the curve to grab the nearest band.' },
  q: { t:'Q (bandwidth)',
    d:'How wide a band each filter affects. Low Q is broad and gentle; high Q is narrow and surgical. Leave it alone unless you\'re chasing one specific resonance.' },
  preamp: { t:'Pre-amp',
    d:'Overall level before everything else. Boosting EQ bands adds level, which can clip — pulling pre-amp down a few dB gives that headroom back.',
    w:'Clipping shows up in the Gain card, right below this.' },
  limiter: { t:'True-peak limiter',
    d:'Catches peaks that would otherwise distort, including the ones that occur <i>between</i> samples and slip past a normal meter. 5 ms look-ahead, ceiling at −1 dB.' },
  width: { t:'Stereo width',
    d:'Below 100% pulls the image toward the centre; above pushes it wider. At 0% it\'s mono. Works by adjusting the side channel of a mid/side split.' },
  balance: { t:'Balance',
    d:'Shifts level between left and right. Useful if your hearing or your speakers aren\'t symmetrical.' },
  xfeed: { t:'Crossfeed',
    d:'Feeds a little of each channel into the other, delayed and low-passed, imitating what your ears naturally get from speakers. On headphones it softens hard-panned recordings that otherwise feel fatiguing.',
    w:'Older recordings with instruments hard left and right benefit most. On modern mixes the effect is subtle.' },
  autoeq: { t:'Headphone correction',
    d:'AutoEq publishes measured corrections for thousands of headphones. Paste the ParametricEQ file for your model and the bands are set from real measurements. This is the most audible thing on this page by a wide margin.',
    w:'Shelf filters get skipped — these are ten peaking bands, so the result is close but not identical to AutoEq\'s target.' },
  conv: { t:'Convolution',
    d:'Applies an impulse response — a recording of how a room or device changes sound. Load a room-correction filter from REW, a headphone IR, or a speaker cabinet model.' },
  loudness: { t:'Loudness metering',
    d:'LUFS to broadcast standard ITU-R BS.1770: K-weighted, gated, over momentary (400 ms), short-term (3 s) and integrated (whole track) windows. Range is the spread between quiet and loud passages.' },
  truepeak: { t:'True peak',
    d:'The real maximum level, measured by interpolating between samples. A conventional peak meter reads only the samples themselves and can miss overshoots that still distort.' },
  corr: { t:'Correlation',
    d:'+1 means both channels are identical (mono). 0 means fully independent. Negative means they partly cancel — usually a phase problem worth knowing about.' },
  crest: { t:'Crest factor',
    d:'The gap between peak and average level, in dB. High numbers mean dynamic music; low numbers mean heavily compressed mastering.' },
  gram: { t:'Spectrogram',
    d:'Time scrolls right to left, pitch runs bottom to top. A hard horizontal edge near the top is where a lossy encoder threw information away — lossless files run all the way to the ceiling.' },
  gonio: { t:'Stereo field',
    d:'A vertical trace means mono. A wide blob means broad stereo. Leaning to one side shows a channel imbalance.' },
  output: { t:'Output',
    d:'Picks the device, requests a sample rate, and sets the buffer size. Rate and buffer only take effect on reload — an audio context is fixed once created.',
    w:'A web page cannot take exclusive control of a DAC. There is no bit-perfect mode, no DSD, and no bypassing the OS mixer.' },
  abx: { t:'Blind A/B/X',
    d:'X is secretly either A (processed) or B (flat). Listen, then say which it was. Over enough trials this tells you whether the processing is genuinely audible to you, rather than something you expect to hear.' },
  bg: { t:'Background priority',
    d:'Leaves audio unrouted from the processing engine so it keeps playing when your screen locks. DSP is unavailable in this mode.',
    w:'Turning DSP on switches this off. On iOS especially, an audio engine may be suspended when the screen locks — that\'s an OS restriction, not something a web page can work around.' },
  ambient: { t:'Ambient visualiser',
    d:'The soft spectrum behind the page, tinted from the album art. Purely decorative — turn it off if you\'d rather save the battery.' },
  cache: { t:'Cached tracks',
    d:'Downloaded audio is kept on disk, so a track is fetched from Drive once and then plays instantly forever — through reloads and browser restarts. Nothing is removed until you press Purge.' }
});
