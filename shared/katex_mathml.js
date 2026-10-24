// TeX -> MathML for the EPUB exporter (see katex_assets.render_mathml).
// stdin: JSON [[tex, display], ...]   stdout: JSON [{mathml, error}, ...]
'use strict';
const katex = require('./vendor/katex/katex.min.js');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    let items;
    try { items = JSON.parse(input); } catch (e) { process.stderr.write('bad input: ' + e.message); process.exit(2); }
    if (!Array.isArray(items)) { process.stderr.write('expected a JSON array'); process.exit(2); }
    const out = items.map(item => {
        if (!Array.isArray(item) || typeof item[0] !== 'string') return { mathml: null, error: 'bad item' };
        try {
            const html = katex.renderToString(item[0], { output: 'mathml', displayMode: !!item[1], throwOnError: true, trust: false });
            const m = html.match(/<math[\s\S]*<\/math>/);
            return m ? { mathml: m[0], error: null } : { mathml: null, error: 'no MathML produced' };
        } catch (e) {
            return { mathml: null, error: String((e && e.message) || e) };
        }
    });
    process.stdout.write(JSON.stringify(out));
});
