'use strict';
// Acceptance check: render original vs fixed book files with the REAL updated
// renderer (explainer/js/markdown.js from the user's working tree) and count
// literal asterisk characters that survive into the visible HTML text.
const fs = require('fs');
const path = require('path');

const mdSrc = fs.readFileSync(
  'C:/Users/scott/QuarantineZone/Tools to Build/entropy/explainer/js/markdown.js', 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', mdSrc + '\nmodule.exports = Markdown;')(mod, mod.exports);
const Markdown = mod.exports;
if (typeof Markdown.parse !== 'function') { console.error('FAIL: Markdown.parse missing'); process.exit(1); }

function visibleStars(html) {
  // strip tags, then count * and ~ characters left in visible text
  const text = html.replace(/<[^>]*>/g, '');
  return (text.match(/[*]/g) || []).length;
}

function starReport(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const perNode = {};
  let total = 0;
  for (const [nid, node] of Object.entries(data.nodes)) {
    const c = node.content || '';
    let stars = 0;
    try { stars = visibleStars(Markdown.parse(c)); }
    catch (e) { console.error(`render error in ${path.basename(file)} [${nid}]: ${e.message}`); stars = -1; }
    if (stars) perNode[nid] = stars;
    total += Math.max(0, stars);
  }
  return { total, perNode };
}

const pairs = [
  ['entropy/Chicken Whispering 20260607.json', 'entropy/Chicken Whispering 20260607.emphasis-fixed.json'],
  ['entropy/Chicken Whispering 20260608.json', 'entropy/Chicken Whispering 20260608.emphasis-fixed.json'],
  ['entropy/Chicken Whispering 20260610.json', 'entropy/Chicken Whispering 20260610.emphasis-fixed.json'],
  ['frauddyscotty/Chicken Whispering 20260610.json', 'frauddyscotty/Chicken Whispering 20260610.emphasis-fixed.json'],
  ['frauddyscotty/Chicken Whispering 202600806.json', 'frauddyscotty/Chicken Whispering 202600806.emphasis-fixed.json'],
  ['frauddyscotty/Chicken Whispering - Textbook Edition.entropy.json', 'frauddyscotty/Chicken Whispering - Textbook Edition.entropy.emphasis-fixed.json'],
];

const base = 'C:/Users/scott/QuarantineZone/Tools to Build/';
for (const [orig, fixed] of pairs) {
  const o = starReport(base + orig);
  const f = starReport(base + fixed);
  console.log(`\n${path.basename(orig)}`);
  console.log(`  visible '*' chars in rendered HTML: ${o.total} -> ${f.total}`);
  const nodes = new Set([...Object.keys(o.perNode), ...Object.keys(f.perNode)]);
  for (const nid of [...nodes].sort()) {
    const a = o.perNode[nid] || 0, b = f.perNode[nid] || 0;
    if (a !== b || b > 0) console.log(`    [${nid}] ${a} -> ${b}`);
  }
}
