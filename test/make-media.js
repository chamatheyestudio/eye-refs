// Makes the pictures and videos the app tests use, on any computer.
// node test/make-media.js [folder]
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const out = process.argv[2] || process.env.REFSRC || path.join(os.tmpdir(), 'refsrc');
fs.mkdirSync(out, { recursive: true });
const ff = require('ffmpeg-static');
const run = (name, args) => {
  const f = path.join(out, name);
  if (fs.existsSync(f)) return;
  execFileSync(ff, ['-y', '-loglevel', 'error', ...args, f], { stdio: 'inherit' });
};

run('mandel.png', ['-f', 'lavfi', '-i', 'mandelbrot=size=1200x800', '-frames:v', '1']);
run('warm.jpg', ['-f', 'lavfi', '-i', 'gradients=size=900x600:c0=0xE07A3F:c1=0xF2C14E:c2=0x9E2A2B:nb_colors=3:seed=4', '-frames:v', '1', '-q:v', '3']);
run('night.jpg', ['-f', 'lavfi', '-i', 'gradients=size=400x300:c0=0x0B1A33:c1=0x1F3A5F:seed=2', '-frames:v', '1', '-q:v', '5']);
run('pattern.png', ['-f', 'lavfi', '-i', 'testsrc2=size=600x600', '-frames:v', '1']);
run('reel.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
// A video the board can't play as it is, so it has to be converted
run('clip.avi', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '4', '-c:v', 'mpeg4', '-q:v', '4']);

// A small three page PDF, written by hand so no extra tools are needed
function makePdf(file, pages) {
  if (fs.existsSync(file)) return;
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  const pagesId = objs.length + 1 + pages.length * 2;
  pages.forEach((p, i) => {
    const body = `${p.bg} rg 0 0 ${p.w} ${p.h} re f 0 0 0 rg BT /F1 64 Tf 60 ${p.h - 140} Td (Page ${i + 1}) Tj ET`;
    const c = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  });
  add(`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
  const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
}
makePdf(path.join(out, 'brief.pdf'), [{ w: 612, h: 792, bg: '1 0.85 0.4' }, { w: 612, h: 792, bg: '0.6 0.8 1' }, { w: 792, h: 612, bg: '0.8 1 0.6' }]);
// Files that aren't pictures: they come in as cards
fs.writeFileSync(path.join(out, 'notes.txt'), 'Shot list\\n1. Wide\\n2. Close\\n');
fs.writeFileSync(path.join(out, 'deck.key'), Buffer.alloc(2048, 7));
fs.writeFileSync(path.join(out, 'setup.sh'), 'echo hi\n');
console.log('test media in', out);
