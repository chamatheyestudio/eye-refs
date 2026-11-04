// Puts server/viewer.html into server/Code.gs as one string, so the server is
// still a single file to paste into Apps Script. Run after editing viewer.html.
const fs = require('fs');
const path = require('path');
const gs = path.join(__dirname, '..', 'server', 'Code.gs');
const html = fs.readFileSync(path.join(__dirname, '..', 'server', 'viewer.html'), 'utf8');
const src = fs.readFileSync(gs, 'utf8');
const re = /(\/\/ VIEWER_HTML_START[^\n]*\n)[\s\S]*?(\n\/\/ VIEWER_HTML_END)/;
if (!re.test(src)) throw new Error('VIEWER_HTML markers missing in Code.gs');
// Keep it plain ASCII so nothing changes on the way into the Apps Script editor
const lit = JSON.stringify(html).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
fs.writeFileSync(gs, src.replace(re, `$1var VIEWER_HTML = ${lit};$2`));
console.log('Embedded viewer.html (' + html.length + ' characters)');
