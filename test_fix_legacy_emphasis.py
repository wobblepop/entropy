"""Unit tests for fix_legacy_emphasis.py. Run: py test_fix_legacy_emphasis.py"""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'fx', Path(__file__).with_name('fix_legacy_emphasis.py'))
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)

CASES = [
    ('normal text with **bold** and *ital*',
     'normal text with **bold** and *ital*', 'valid untouched'),
    ('**a** **b**', '**a** **b**', 'adjacent valid bolds untouched'),
    ('so ** text ** here', 'so **text** here', 'space-flanked bold hugged'),
    ('a** b **c', 'a** b **c'.replace('** b **', ' **b** '),
     'one-sided: spaces move outside markers'),
    ('x * 1 word / 4.6 bytes * y', 'x *1 word / 4.6 bytes* y',
     'space-flanked italic hugged'),
    ('end.********Start', 'end. Start', 'wall joining words -> single space'),
    ('end. ********Start', 'end. Start', 'wall after space -> removed'),
    ('140%.******* *********That is', '140%. That is', 'two walls with space'),
    ('so ** ** done', 'so done', 'orphan pair deleted'),
    ('word** **word', 'word word', 'orphan joining words -> space'),
    ('* bullet item with *ital* inside', '* bullet item with *ital* inside',
     'bullet not a marker'),
    ('> * quoted bullet', '> * quoted bullet', 'blockquote bullet'),
    ('~~ strike ~~', '~~strike~~', 'tilde hugged'),
    ('*** bold ital ***', '***bold ital***', 'triple hugged'),
    ('***good triple***', '***good triple***', 'valid triple untouched'),
    ('escaped \\* star * real ital *', 'escaped \\* star *real ital*',
     'escaped star skipped'),
]

fails = 0
for src, want, desc in CASES:
    stats = {'walls': 0, 'orphans': 0, 'hugged': 0, 'leftover': 0}
    log = []
    got = fx.fix_line(src, stats, log, 't')
    ok = got == want
    if not ok:
        fails += 1
        print(f'FAIL {desc}\n   in  : {src!r}\n   got : {got!r}\n   want: {want!r}')
    else:
        print(f'PASS {desc}')

stats = {'walls': 0, 'orphans': 0, 'hugged': 0, 'leftover': 0}
log = []
src = 'before ** x **\n```\ncode ** stays ** and ****\n```\nafter ** y **'
want = 'before **x**\n```\ncode ** stays ** and ****\n```\nafter **y**'
got = fx.fix_content(src, stats, log, 't')
if got == want:
    print('PASS fence protected')
else:
    fails += 1
    print(f'FAIL fence protected\n   got: {got!r}')

stats = {'walls': 0, 'orphans': 0, 'hugged': 0, 'leftover': 0}
log = []
src = 'scraps.*** *ital text* and *more.* ***Build'
got = fx.fix_line(src, stats, log, 't')
if got == src and stats['leftover'] == 1 and stats['hugged'] == 0:
    print('PASS ambiguous triple pair logged, not touched')
else:
    fails += 1
    print(f'FAIL ambiguous triple: got={got!r} stats={stats}')

stats = {'walls': 0, 'orphans': 0, 'hugged': 0, 'leftover': 0}
log = []
got = fx.fix_line('stray ** here only', stats, log, 't')
if got == 'stray ** here only' and stats['leftover'] == 1 and len(log) == 1:
    print('PASS unpaired logged, not touched')
else:
    fails += 1
    print(f'FAIL unpaired handling: got={got!r} stats={stats} log={log}')

print('FAILURES:', fails)
sys.exit(1 if fails else 0)
