"""Second-pass patch: NBSP-flanked emphasis pairs the main fixer missed
(the new renderer's (?!\\s) flanking checks treat U+00A0 as whitespace).
Applies exact replacements to the six adopted book files where present."""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
BASE = Path(r'C:\Users\scott\QuarantineZone\Tools to Build')
FILES = [
    BASE / 'entropy' / 'Chicken Whispering 20260607.json',
    BASE / 'entropy' / 'Chicken Whispering 20260608.json',
    BASE / 'entropy' / 'Chicken Whispering 20260610.json',
    BASE / 'frauddyscotty' / 'Chicken Whispering 20260610.json',
    BASE / 'frauddyscotty' / 'Chicken Whispering 202600806.json',
    BASE / 'frauddyscotty' / 'Chicken Whispering - Textbook Edition.entropy.json',
]

# (node, old, new) — NBSP moved outside the marker (or dropped when outer
# whitespace already separates the words).
REPLACEMENTS = [
    ('claudemd-files-muds-memory-or-prompts',
     "*Sure, an MCP does that if you don't want to.\u00a0*",
     "*Sure, an MCP does that if you don't want to.*"),
    ('claudemd-files-muds-memory-or-prompts',
     '*Why not.\u00a0*',
     '*Why not.*'),
    ('claudemd-files-muds-memory-or-prompts',
     "garage?*\u00a0Probably not. Just keep that secret between you and Grandpappy.*",
     "garage?\u00a0*Probably not. Just keep that secret between you and Grandpappy.*"),
    ('stateless-stateful-systems',
     'what I actually think about them.\u00a0*',
     'what I actually think about them.*'),
    ('random-chickenshit',
     'The impact of inappropriate GenAI use on student success\u00a0*was',
     'The impact of inappropriate GenAI use on student success*\u00a0was'),
    ('chicken-steroirds',
     '1 minute / 238 words *\u00a0 1 day / 1440 minutes*',
     '1 minute / 238 words *1 day / 1440 minutes*'),
]

for path in FILES:
    data = json.loads(path.read_text(encoding='utf-8'))
    applied = []
    for nid, old, new in REPLACEMENTS:
        node = data['nodes'].get(nid)
        if not node:
            continue
        c = node.get('content') or ''
        n = c.count(old)
        if n > 1:
            raise AssertionError(f'{path.name} [{nid}]: {n} occurrences of {old!r}')
        if n == 1:
            node['content'] = c.replace(old, new)
            applied.append(nid)
    if applied:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8')
        json.loads(path.read_text(encoding='utf-8'))
    print(f'{path.name}: {len(applied)} NBSP fixes ({", ".join(applied) or "none"})')
