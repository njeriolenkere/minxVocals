//  Human vocal ranges in Hz (approximate)
const VOCAL_RANGES = {
  bass:         { min: 82,  max: 330 }, // E2 to E4 - men
  baritone:     { min: 110, max: 440 }, // A2 to A4- men
  tenor:        { min: 130, max: 523 }, // C3 to C5 - men
  countertenor: { min: 165, max: 660}, //E3 TO E5 - men/women
  alto:         { min: 175, max: 700 }, // F3 to F5 - women
  mezzo:        { min: 220, max: 880 }, // A3-A5 --women
  soprano:      { min: 261, max: 1046 }, // C4 to C6 -- women/children
  coloratura:   {min: 1300, max: 2093}, //F6 TO C7
  //whistleRegister: {min: 2000, max: 25000} //F3 TO G10
};

// Ranges you want to allow; 
const MIN_FREQ = 82;   // bass low E2
const MAX_FREQ = 2093; // soprano high C7

const A4 = 440;
function freqToNote(freq){
  if(!freq || freq <= 0) return null;
  const noteNum = 12 * (Math.log(freq / A4) / Math.log(2)) + 69; // MIDI float
  const midiRounded = Math.round(noteNum);
  const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const name = noteNames[midiRounded % 12];
  const octave = Math.floor(midiRounded/12) - 1;
  return { name, midiRounded, midiFloat: noteNum, octave, freq };
}
function noteToFreq(midi){ return A4 * Math.pow(2, (midi - 69)/12); }

// getUserMedia wrapper
function getUserMediaCompat(constraints){
  if(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return navigator.mediaDevices.getUserMedia(constraints);
  const g = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if(!g) return Promise.reject(new Error( 'getUserMedia not supported'));
  return new Promise((resolve,reject)=> g.call(navigator,constraints,resolve,reject));
}

// autocorrelation (unchanged)
function autoCorrelate(buf, sampleRate){
  let size = buf.length; let rms=0; for(let i=0;i<size;i++){ rms += buf[i]*buf[i]; }
  rms = Math.sqrt(rms/size); if(rms<0.01) return -1;
  let r1=0,r2=size-1,thres=0.2; for(let i=0;i<size/2;i++){ if(Math.abs(buf[i])<thres){ r1=i; break; } }
  for(let i=1;i<size/2;i++){ if(Math.abs(buf[size-i])<thres){ r2=size-i; break; } }
  buf = buf.slice(r1,r2); size = buf.length; const c = new Array(size).fill(0);
  for(let i=0;i<size;i++) for(let j=0;j<size-i;j++) c[i]+=buf[j]*buf[j+i];
  let d=0; while(c[d]>c[d+1]) d++; let maxval=-1,maxpos=-1; for(let i=d;i<size;i++){ if(c[i]>maxval){ maxval=c[i]; maxpos=i; } }
  let T0 = maxpos; if(T0==0) return -1; const x1=c[T0-1], x2=c[T0], x3=c[T0+1]; const a=(x1+x3-2*x2)/2, b=(x3-x1)/2; if(a) T0 = T0 - b/(2*a);
  return sampleRate / T0;
}

// state
let audioContext = null; let analyser = null, sourceNode = null; let isRunning=false; const FFT_SIZE = 2048;
let sessionMinMidi = Infinity, sessionMaxMidi = -Infinity; // track using midiFloat for accuracy
let noteHistory = [];

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const lockCheckbox = document.getElementById('lockRange');
const currentNoteEl = document.getElementById('currentNote');
const currentFreqEl = document.getElementById('currentFreq');
const highestEl = document.getElementById('highest');
const highestFreqEl = document.getElementById('highestFreq');
const lowestEl = document.getElementById('lowest');
const lowestFreqEl = document.getElementById('lowestFreq');
const summaryEl = document.getElementById('summary');
const rangeList = document.getElementById('rangeList');
const confidenceEl = document.getElementById('confidence');
const canvas = document.getElementById('viz'); const ctx = canvas.getContext('2d');
const keyboard = document.getElementById('keyboard');

function ensureAudioContext(){ if(!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)(); return audioContext; }

// build keyboard 3 octaves to give room
const KEY_START = 48; // C3
const KEY_COUNT = 36; // 3 octaves
function buildKeyboard(){ keyboard.innerHTML = ''; const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  for(let i=0;i<KEY_COUNT;i++){ const midi = KEY_START + i; const name = names[midi%12]; const key = document.createElement('div'); key.className = 'key' + (name.includes('#') ? ' black' : ''); key.dataset.midi = midi; key.title = name + (Math.floor(midi/12)-1); key.innerText = name.replace('#','♯'); keyboard.appendChild(key); }
}
buildKeyboard();

function setKeyLocked(midi, locked){ const el = document.querySelector('#keyboard .key[data-midi="'+midi+'"]'); if(!el) return; if(locked) el.classList.add('locked'); else el.classList.remove('locked'); }

function highlightKey(midi){ document.querySelectorAll('#keyboard .key').forEach(k=>k.classList.remove('active')); if(!midi) return; const el = document.querySelector('#keyboard .key[data-midi="'+midi+'"]'); if(el) el.classList.add('active'); }

// accurate tone playback
function playTone(midi){ try{ const ctx = ensureAudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.type='sine'; o.frequency.value = noteToFreq(midi); g.gain.setValueAtTime(0, ctx.currentTime); o.connect(g); g.connect(ctx.destination); o.start(); g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6); setTimeout(()=>{ try{ o.stop(); }catch(e){} },700); } catch(e){ console.warn('playTone error', e); } }

// keyboard pointer handling with lock logic
keyboard.addEventListener('pointerdown', e=>{
  const k = e.target.closest('.key'); if(!k) return; const midi = Number(k.dataset.midi);
  // if locked and outside range -> ignore
  if(lockCheckbox.checked){ const low = Math.ceil(sessionMinMidi); const high = Math.floor(sessionMaxMidi); if(!(midi >= low && midi <= high)) return; }
  playTone(midi);
});

// canvas dpi
function resizeCanvas(){ const ratio = window.devicePixelRatio || 1; canvas.width = Math.floor(canvas.clientWidth * ratio); canvas.height = Math.floor(canvas.clientHeight * ratio); }
window.addEventListener('resize', resizeCanvas); resizeCanvas();

function drawStaff(){ const w = canvas.width, h = canvas.height; ctx.clearRect(0,0,w,h); ctx.strokeStyle = 'rgba(255,255,255,0.03)'; for(let i=0;i<5;i++){ ctx.beginPath(); ctx.moveTo(8,60+i*14); ctx.lineTo(w-8,60+i*14); ctx.stroke(); } }
let scrollX = 0; function plotNote(x,midi){ const w = canvas.width, h = canvas.height; const minMidi = 48, maxMidi = 84; const t = (midi - minMidi) / (maxMidi - minMidi); const y = h - 40 - t*(h - 120); ctx.fillStyle = 'rgba(125,211,252,0.95)'; ctx.beginPath(); ctx.ellipse((x%w)+20, y, 8,6,0,0,Math.PI*2); ctx.fill(); }

function updateRangeWithNote(note){ if(!note) return; // note.midiFloat used for accurate extremes
  const midiF = note.midiFloat;
  if(midiF < sessionMinMidi) sessionMinMidi = midiF;
  if(midiF > sessionMaxMidi) sessionMaxMidi = midiF;
  // display nearest rounded names
  const minRounded = Math.round(sessionMinMidi);
  const maxRounded = Math.round(sessionMaxMidi);
  const minName = midiToName(minRounded);
  const maxName = midiToName(maxRounded);
  document.getElementById('lowest').innerText = 'Lowest: ' + minName;
  document.getElementById('lowestFreq').innerText = noteToFreq(minRounded).toFixed(1) + ' Hz';
  document.getElementById('highest').innerText = 'Highest: ' + maxName;
  document.getElementById('highestFreq').innerText = noteToFreq(maxRounded).toFixed(1) + ' Hz';
  summaryEl.innerText = `${minName} → ${maxName}`;

  // update recent list
  noteHistory.push({name: note.name, octave: note.octave, freq: note.freq.toFixed(1)});
  const last = noteHistory.slice(-12).reverse(); rangeList.innerHTML = '';
  last.forEach(n=>{ const el = document.createElement('div'); el.className='range-item'; el.innerHTML = `<div>${n.name}${n.octave}</div><div class=\"muted\">${n.freq} Hz</div>`; rangeList.appendChild(el); });

  // if lock enabled, mark keys outside range as locked
  if(lockCheckbox.checked){ applyKeyLock(); }
}

function midiToName(midi){ const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']; return names[midi%12] + (Math.floor(midi/12)-1); }

function applyKeyLock(){ const low = Math.ceil(sessionMinMidi); const high = Math.floor(sessionMaxMidi); document.querySelectorAll('#keyboard .key').forEach(k=>{ const midi = Number(k.dataset.midi); if(midi < low || midi > high) k.classList.add('locked'); else k.classList.remove('locked'); }); }

function clearSession(){ sessionMinMidi = Infinity; sessionMaxMidi = -Infinity; noteHistory = []; rangeList.innerHTML=''; summaryEl.innerText='No data yet'; document.getElementById('highest').innerText='Highest: —'; document.getElementById('lowest').innerText='Lowest: —'; document.getElementById('highestFreq').innerText='—'; document.getElementById('lowestFreq').innerText='—'; currentNoteEl.innerText='—'; currentFreqEl.innerText='— Hz'; document.querySelectorAll('#keyboard .key').forEach(k=>k.classList.remove('locked','active')); }
clearSession();
// draw note

// audio pipeline
async function start(){ if(isRunning) return; try{ ensureAudioContext(); const stream = await getUserMediaCompat({audio:{echoCancellation:true,noiseSuppression:true}}); analyser = audioContext.createAnalyser(); analyser.fftSize = FFT_SIZE; sourceNode = audioContext.createMediaStreamSource(stream); sourceNode.connect(analyser); isRunning = true; startBtn.disabled=true; stopBtn.disabled=false; runAnalysis(); } catch(err){ console.error(err); alert('Microphone error or permission blocked. Mobile requires HTTPS/localhost. ' + (err && err.message ? err.message : err)); }}
function stop(){ if(!isRunning) return; isRunning=false; startBtn.disabled=false; stopBtn.disabled=true; if(sourceNode) try{ sourceNode.disconnect(); }catch(e){} analyser = null; sourceNode = null; }

function runAnalysis(){ const buffer = new Float32Array(FFT_SIZE);
  function frame(){ if(!isRunning) return; analyser.getFloatTimeDomainData(buffer); const sr = audioContext.sampleRate; const f = autoCorrelate(buffer, sr);
    drawStaff(); // draw waveform
    ctx.lineWidth = 1.4; ctx.beginPath(); const w = canvas.width, h = canvas.height;
    for(let i=0;i<buffer.length;i++){ const x=(i/buffer.length)*w; const y=h/2 + buffer[i]*h/3; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.strokeStyle = 'rgba(125,211,252,0.6)'; ctx.stroke();

    if(f && f!==-1) { 
      // --- Add vocal range check ---
    if(f < MIN_FREQ || f > MAX_FREQ){
        confidenceEl.innerText = 'Out of range';
        requestAnimationFrame(frame); // skip updating the note
        return;
    }
    // ------------------------------

    const note = freqToNote(f);
    currentNoteEl.innerText = note.name + note.octave;
    currentFreqEl.innerText = f.toFixed(1) + ' Hz';
    confidenceEl.innerText = 'Good';
    highlightKey(note.midiRounded);
    updateRangeWithNote(note);
    plotNote(scrollX, note.midiRounded);
    scrollX += 8;  }
    else { confidenceEl.innerText = '—'; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}


// wire UI
startBtn.addEventListener('click', start); stopBtn.addEventListener('click', stop); clearBtn.addEventListener('click', clearSession);
lockCheckbox.addEventListener('change', ()=>{ if(lockCheckbox.checked) applyKeyLock(); else document.querySelectorAll('#keyboard .key').forEach(k=>k.classList.remove('locked')); });

// helpful note for mobile: browsers require secure context
console.info('If mic fails on mobile: serve over HTTPS or use localhost. Example: python -m http.server and open http://localhost:8000');
