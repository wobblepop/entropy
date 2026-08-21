"""Hand-patch the REVIEW-flagged emphasis sites in the .emphasis-fixed book
files, then adopt each over its original (original preserved as
<name>.json.pre-emphasis-fix.bak, matching the repo's .bak convention).

Every replacement is exact-match and asserted to occur exactly once per
target content; any mismatch aborts that file before adoption.
"""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
BASE = Path(r'C:\Users\scott\QuarantineZone\Tools to Build')

OLD_FILES = [
    BASE / 'entropy' / 'Chicken Whispering 20260607.json',
    BASE / 'entropy' / 'Chicken Whispering 20260608.json',
    BASE / 'entropy' / 'Chicken Whispering 20260610.json',
    BASE / 'frauddyscotty' / 'Chicken Whispering 20260610.json',
    BASE / 'frauddyscotty' / 'Chicken Whispering - Textbook Edition.entropy.json',
]
LIVE_FILE = BASE / 'frauddyscotty' / 'Chicken Whispering 202600806.json'


def fixed_path(orig: Path) -> Path:
    return orig.with_name(re.sub(r'\.json$', '', orig.name) + '.emphasis-fixed.json')


def replace_once(content: str, old: str, new: str, label: str) -> str:
    n = content.count(old)
    if n != 1:
        raise AssertionError(f'{label}: expected 1 occurrence, found {n} of {old!r}')
    return content.replace(old, new)


def rebuild_line_101(orig_data) -> str:
    """Rebuild the space-station blockquote from the ORIGINAL text: strip
    asterisk walls, collapse the resulting double spaces (prose-only line),
    then resolve the wall-residue markers into five clean italic spans."""
    lines = orig_data['nodes']['how-to-become-a-chicken-whisperer']['content'].split('\n')
    line = lines[100]
    if 'Aight boss' not in line:
        raise AssertionError('line 101 is not the Aight-boss blockquote')
    line = re.sub(r'\*{4,}', ' ', line)
    line = re.sub(r'  +', ' ', line).strip()
    line = replace_once(line, "scraps.*** *I'm talking", "scraps.* *I'm talking", 'L101 scraps')
    line = replace_once(line, 'array.* ***Build', 'array.* *Build', 'L101 Build')
    line = replace_once(line, "for a small station. *We'll", "for a small station.* *We'll", 'L101 station closer')
    return line


def patch_old(fixed_data, orig_data, name):
    n = fixed_data['nodes']
    lines = n['how-to-become-a-chicken-whisperer']['content'].split('\n')
    lines[100] = rebuild_line_101(orig_data)
    n['how-to-become-a-chicken-whisperer']['content'] = '\n'.join(lines)
    n['understanding-the-chicken']['content'] = replace_once(
        n['understanding-the-chicken']['content'],
        'absolutely should not be used. *For example',
        'absolutely should not be used.*** For example', f'{name} L62')
    n['stateless-stateful-systems']['content'] = replace_once(
        n['stateless-stateful-systems']['content'],
        'safer to trust the user**. The user said',
        'safer to trust the user. The user said', f'{name} L111')


def patch_live(fixed_data, name):
    n = fixed_data['nodes']
    n['how-to-become-a-chicken-whisperer']['content'] = replace_once(
        n['how-to-become-a-chicken-whisperer']['content'],
        '**For example, listing explicit tools or approaches that should be followed.*',
        '*For example, listing explicit tools or approaches that should be followed.',
        f'{name} footnote')
    n['stateless-stateful-systems']['content'] = replace_once(
        n['stateless-stateful-systems']['content'],
        'safer to trust the user**. The user said',
        'safer to trust the user. The user said', f'{name} L111')
    c = n['chickenmancers']['content']
    c = replace_once(c, "*Do so by calling: get_policy(category: str) -> str\n",
                     "*Do so by calling: get_policy(category: str) -> str*\n",
                     f'{name} guardian-32')
    c = replace_once(c, "\nwith category = 'election_voting'.*",
                     "\n*with category = 'election_voting'.*",
                     f'{name} guardian-33')
    n['chickenmancers']['content'] = c


def adopt(orig: Path, fixed_data):
    bak = orig.with_name(orig.name + '.pre-emphasis-fix.bak')
    if bak.exists():
        raise AssertionError(f'backup already exists, refusing to overwrite: {bak}')
    bak.write_bytes(orig.read_bytes())
    orig.write_text(json.dumps(fixed_data, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8')
    json.loads(orig.read_text(encoding='utf-8'))  # must re-parse cleanly
    fixed_path(orig).unlink()
    print(f'  adopted: {orig.name}  (backup: {bak.name})')


def main():
    for orig in OLD_FILES + [LIVE_FILE]:
        fp = fixed_path(orig)
        if not orig.is_file() or not fp.is_file():
            print(f'SKIP (missing original or fixed copy): {orig}')
            continue
        print(f'== {orig}')
        orig_data = json.loads(orig.read_text(encoding='utf-8'))
        fixed_data = json.loads(fp.read_text(encoding='utf-8'))
        if orig == LIVE_FILE:
            patch_live(fixed_data, orig.name)
        else:
            patch_old(fixed_data, orig_data, orig.name)
        adopt(orig, fixed_data)


if __name__ == '__main__':
    main()
