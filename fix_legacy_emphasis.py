#!/usr/bin/env python3
"""One-time cleanup of legacy emphasis damage in .entropy.json book files.

The pre-2026-06 editor serializer emitted space-flanked emphasis markers and
grew orphan asterisk runs on every save. The updated renderers require
non-space flanking (** text ** no longer renders as bold), so the baked-in
damage now shows as literal asterisks. This script rewrites node content to
the strict syntax while preserving what the old lenient renderer displayed:

  1. Asterisk walls (runs of 4+ '*') are removed entirely.
  2. Paired markers (***, **, *, ~~) whose inner text is space-flanked are
     re-hugged: '** text **' -> ' **text** ' (whitespace moves outside).
  3. Pairs enclosing only whitespace ('** **') are deleted.
  4. Unpaired leftover markers are NEVER auto-deleted -- they are logged for
     manual review, since literal asterisks can be intentional.

Fenced code blocks (``` ... ```) are left untouched. Only node 'content'
strings are modified; every other field is preserved byte-for-byte at the
JSON level. Output is written to '<stem>.emphasis-fixed.json' next to each
input; originals are never overwritten.

Usage:  py fix_legacy_emphasis.py "file1.json" ["file2.json" ...]
"""
import json
import re
import sys
from pathlib import Path

WALL_RE = re.compile(r'\*{4,}')
FENCE_RE = re.compile(r'^\s*```')
# a leading '* ' (optionally inside blockquote '>' prefixes) is a list bullet
BULLET_RE = re.compile(r'^(\s*(?:>\s*)*)\*(\s)')


def tokenize_markers(line, bullet_pos):
    """Return [(start, marker_text)] for emphasis tokens on one line.

    Longest-match at each position: *** before ** before *. '~~' handled too.
    Escaped markers (\\*) and the list-bullet asterisk are skipped. Runs of
    4+ must already be gone (walls removed first); if one survives it is
    skipped defensively rather than mis-tokenized.
    """
    tokens = []
    i, n = 0, len(line)
    while i < n:
        ch = line[i]
        if ch == '\\' and i + 1 < n:
            i += 2
            continue
        if ch == '*':
            j = i
            while j < n and line[j] == '*':
                j += 1
            run = j - i
            if i == bullet_pos and run == 1:
                pass  # list bullet, not emphasis
            elif run <= 3:
                tokens.append((i, line[i:j]))
            # run >= 4: defensive skip (walls handled earlier)
            i = j
        elif ch == '~' and i + 1 < n and line[i + 1] == '~':
            j = i
            while j < n and line[j] == '~':
                j += 1
            if j - i == 2:
                tokens.append((i, '~~'))
            i = j
        else:
            i += 1
    return tokens


SENTINEL = '\x00'
SENTINEL_RUN = re.compile(r'[ \t\x00]*\x00[ \t\x00]*')


def fix_line(line, stats, log, where):
    """Apply wall removal, orphan-pair deletion, and pair re-hugging to a line.

    Every edit site leaves a \\x00 sentinel; a final pass collapses each
    sentinel-containing whitespace run to one space (nothing at line edges),
    so spacing is normalized only where an edit happened.
    """
    if not isinstance(line, str):
        raise TypeError(f'{where}: line is not a string')
    if SENTINEL in line:
        raise ValueError(f'{where}: content contains NUL; refusing to edit')

    # 1. walls: runs of 4+ asterisks -> removed
    def wall_sub(m):
        stats['walls'] += 1
        return SENTINEL
    line = WALL_RE.sub(wall_sub, line)

    bullet_m = BULLET_RE.match(line)
    bullet_pos = len(bullet_m.group(1)) if bullet_m else -1
    tokens = tokenize_markers(line, bullet_pos)

    # 2./3. pair same-type markers left-to-right (mirrors the old lazy
    #    regexes) and rewrite each pair; *** first so *** never pairs with **.
    edits = []           # (start, end, replacement)
    used = set()
    for kind in ('***', '**', '*', '~~'):
        of_kind = [t for k, t in enumerate(tokens)
                   if t[1] == kind and k not in used]
        idx_of_kind = [k for k, t in enumerate(tokens)
                       if t[1] == kind and k not in used]
        p = 0
        while p + 1 < len(of_kind):
            (s1, m1), (s2, m2) = of_kind[p], of_kind[p + 1]
            used.add(idx_of_kind[p]); used.add(idx_of_kind[p + 1])
            inner = line[s1 + len(m1):s2]
            if inner.strip(' \t\x00') == '':
                # orphan pair: delete markers and inner whitespace
                edits.append((s1, s2 + len(m2), SENTINEL))
                stats['orphans'] += 1
            else:
                stripped = inner.strip(' \t\x00')
                if stripped != inner:
                    if stripped[0] == m1[0] or stripped[-1] == m1[0]:
                        # hugging would merge markers into a longer run
                        # (e.g. '*** *ital*' + '***') — genuinely ambiguous
                        # damage; leave it and flag for manual review.
                        ctx = line[max(0, s1 - 30):s2 + len(m2) + 30]
                        log.append(f'{where}: ambiguous {m1!r} pair left '
                                   f'in place (hug would merge markers): '
                                   f'...{ctx}...')
                        stats['leftover'] += 1
                    else:
                        lead = SENTINEL if inner[0] in ' \t\x00' else ''
                        trail = SENTINEL if inner[-1] in ' \t\x00' else ''
                        edits.append((s1, s2 + len(m2),
                                      lead + m1 + stripped + m2 + trail))
                        stats['hugged'] += 1
            p += 2
        if p < len(of_kind):  # 4. unpaired leftover: log, do not touch
            s, m = of_kind[p]
            ctx = line[max(0, s - 40):s + len(m) + 40]
            log.append(f'{where}: unpaired {m!r} left in place: ...{ctx}...')
            stats['leftover'] += 1

    for s, e, rep in sorted(edits, key=lambda x: -x[0]):
        line = line[:s] + rep + line[e:]

    # collapse whitespace only around edit sites: each sentinel-containing
    # run becomes one space, or nothing at a line edge.
    if SENTINEL in line:
        def collapse(m):
            return '' if m.start() == 0 or m.end() == len(m.string) else ' '
        line = SENTINEL_RUN.sub(collapse, line)
    return line


def fix_content(text, stats, log, where):
    if not isinstance(text, str):
        raise TypeError(f'{where}: content is not a string')
    out, in_fence = [], False
    for ln_no, line in enumerate(text.split('\n'), 1):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            out.append(line)
        elif in_fence:
            out.append(line)
        else:
            out.append(fix_line(line, stats, log, f'{where} line {ln_no}'))
    return '\n'.join(out)


def process_file(path):
    path = Path(path)
    if not path.is_file():
        print(f'SKIP (not found): {path}')
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f'SKIP (unreadable JSON): {path}: {e}')
        return None
    nodes = data.get('nodes')
    if not isinstance(nodes, dict) or not nodes:
        print(f'SKIP (no nodes object): {path}')
        return None

    log = []
    file_stats = {'walls': 0, 'orphans': 0, 'hugged': 0, 'leftover': 0}
    per_node = {}
    for nid, node in nodes.items():
        if not isinstance(node, dict):
            log.append(f'{path.name} [{nid}]: node is not an object, skipped')
            continue
        content = node.get('content')
        if not content:
            continue
        stats = {'walls': 0, 'orphans': 0, 'hugged': 0, 'leftover': 0}
        fixed = fix_content(content, stats, log, f'{path.name} [{nid}]')
        if fixed != content:
            node['content'] = fixed
            per_node[nid] = dict(stats)
        for k in file_stats:
            file_stats[k] += stats[k]

    print(f'\n=== {path}')
    print(f'  walls removed: {file_stats["walls"]}, orphan pairs deleted: '
          f'{file_stats["orphans"]}, pairs re-hugged: {file_stats["hugged"]}, '
          f'unpaired markers logged: {file_stats["leftover"]}')
    for nid, s in sorted(per_node.items()):
        parts = [f'{k}={v}' for k, v in s.items() if v and k != 'leftover']
        print(f'    [{nid}] ' + ', '.join(parts))
    for entry in log:
        print(f'  REVIEW: {entry}')

    if not per_node:
        print('  no changes needed — no fixed copy written')
        return file_stats

    out_path = path.with_name(re.sub(r'\.json$', '', path.name) + '.emphasis-fixed.json')
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8')
    print(f'  wrote: {out_path}')

    # verification: output parses, damage gone, nothing but content changed
    reread = json.loads(out_path.read_text(encoding='utf-8'))
    orig = json.loads(path.read_text(encoding='utf-8'))
    for nid, node in orig['nodes'].items():
        if isinstance(node, dict) and 'content' in node:
            node['content'] = None
    for nid, node in reread['nodes'].items():
        if isinstance(node, dict) and 'content' in node:
            node['content'] = None
    assert orig == reread, f'{path.name}: non-content fields changed!'
    for nid, node in json.loads(out_path.read_text(encoding='utf-8'))['nodes'].items():
        c = node.get('content') or ''
        assert not WALL_RE.search(c), f'{path.name} [{nid}]: wall survived'
    print('  verified: JSON valid, non-content fields identical, no walls remain')
    return file_stats


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    any_ok = False
    for arg in argv[1:]:
        if process_file(arg) is not None:
            any_ok = True
    return 0 if any_ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
