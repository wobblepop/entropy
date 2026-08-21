'use strict';
// Post-adoption check: render each ADOPTED book file with the real updated
// renderer; report per-node visible '*' characters and whether they sit in
// code (<pre>/<code>) or prose.
const fs = require('fs');
const path = require('path');

const mdSrc = fs.readFileSync(
  'C:/Users/scott/QuarantineZone/Tools to Build/entropy/explainer/js/markdown.js', 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', mdSrc + '\nmodule.exports = Markdown;')(mod, mod.exports);
const Markdown = mod.exports;

function starCounts(html) {
  let inCode = 0, code = 0, prose = 0;
  const parts = html.split(/(<\/?(?:pre|code)[^>]*>)/);
  for (const part of parts) {
    if (/^<(pre|code)/.test(part)) { inCode++; continue; }
    if (/^<\/(pre|code)/.test(part)) { inCode = Math.max(0, inCode - 1); continue; }
    const text = part.replace(/<[^>]*>/g, '');
    const n = (text.match(/[*]/g) || []).length;
    if (inCode > 0) code += n; else prose += n;
  }
  return { code, prose };
}

const files = [
  'entropy/Chicken Whispering 20260607.json',
  'entropy/Chicken Whispering 20260608.json',
  'entropy/Chicken Whispering 20260610.json',
  'frauddyscotty/Chicken Whispering 20260610.json',
  'frauddyscotty/Chicken Whispering 202600806.json',
  'frauddyscotty/Chicken Whispering - Textbook Edition.entropy.json',
];
const base = 'C:/Users/scott/QuarantineZone/Tools to Build/';
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(base + f, 'utf8'));
  console.log('\n' + f + '  (' + Object.keys(data.nodes).length + ' nodes)');
  let totC = 0, totP = 0;
  for (const [nid, node] of Object.entries(data.nodes)) {
    const { code, prose } = starCounts(Markdown.parse(node.content || ''));
    totC += code; totP += prose;
    if (code || prose) console.log(`    [${nid}] code:${code} prose:${prose}`);
  }
  console.log(`  TOTAL visible '*' — in code blocks: ${totC}, in prose: ${totP}`);
}
