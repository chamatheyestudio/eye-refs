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
console.log('test media in', out);
