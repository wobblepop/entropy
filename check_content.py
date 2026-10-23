"""Decrypt the html blob (code via stdin) and confirm expected phrases present."""
import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENTROPY = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ENTROPY, 'reader_gate_dist')
with open(os.path.join(DIST, 'manifest.json'), encoding='utf-8') as fh:
    m = json.load(fh)

line = sys.stdin.readline().strip()
if '=' not in line:
    sys.exit('expected label=code on stdin')
label, code = line.split('=', 1)
entry = next((c for c in m['codes'] if c['label'] == label.strip()), None)
if entry is None:
    sys.exit(f'label {label} not found')

kek = hashlib.pbkdf2_hmac('sha256', code.strip().upper().encode(),
                          base64.b64decode(entry['salt']),
                          m['kdf']['iterations'], dklen=32)
key = AESGCM(kek).decrypt(base64.b64decode(entry['iv']),
                          base64.b64decode(entry['wrapped']), None)
with open(os.path.join(DIST, m['files']['html']['path']), 'rb') as fh:
    blob = fh.read()
html = AESGCM(key).decrypt(blob[:12], blob[12:], None).decode('utf-8')

checks = [
    ('NEW text (typo fix, Chicken Insanity)',
     'I think might cause AI to collapse is a bit like the chickens inbreeding', True),
    ('NEW heading (claude.md section; apostrophe may be entity-encoded)',
     ("It's all just text", "It’s all just text", 'It&#x27;s all just text',
      'It&#39;s all just text'), True),
    ('OLD text gone',
     'One of the reasons that I can cause a systemwide collapse', False),
]
fails = 0
for name, needle, expected in checks:
    needles = needle if isinstance(needle, tuple) else (needle,)
    found = any(n in html for n in needles)
    ok = found == expected
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: "
          f"{'present' if found else 'absent'} (expected {'present' if expected else 'absent'})")
    if not ok:
        fails += 1
sys.exit(1 if fails else 0)
