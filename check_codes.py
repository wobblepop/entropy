"""Verify every group code unwraps the same content key; wrong codes fail.

Codes are passed via stdin (one per line, 'label=code') so they never land
in a file or command line. This script prints labels only, never codes.
"""
import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENTROPY = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(ENTROPY, 'reader_gate_dist', 'manifest.json')
with open(path, encoding='utf-8') as fh:
    m = json.load(fh)

pairs = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    if '=' not in line:
        sys.exit(f'bad stdin line (expected label=code)')
    label, code = line.split('=', 1)
    pairs.append((label.strip(), code.strip().upper()))

if len(pairs) != len(m['codes']):
    sys.exit(f"expected {len(m['codes'])} codes, got {len(pairs)} on stdin")

entries = {c['label']: c for c in m['codes']}
keys = {}
for label, code in pairs:
    if label not in entries:
        sys.exit(f'label {label} not in manifest (has: {sorted(entries)})')
    e = entries[label]
    kek = hashlib.pbkdf2_hmac('sha256', code.encode(), base64.b64decode(e['salt']),
                              m['kdf']['iterations'], dklen=32)
    try:
        k = AESGCM(kek).decrypt(base64.b64decode(e['iv']), base64.b64decode(e['wrapped']), None)
    except Exception:
        sys.exit(f'FAIL: code for {label} did NOT unwrap its entry')
    if len(k) != 32:
        sys.exit(f'FAIL: {label} unwrapped key wrong length {len(k)}')
    keys[label] = k
    print(f'{label}: unwraps OK')

if len(set(keys.values())) == 1:
    print('All labels unwrap the IDENTICAL content key.')
else:
    sys.exit('FAIL: labels unwrap DIFFERENT keys')

bad = hashlib.pbkdf2_hmac('sha256', b'WRONGCODE', base64.b64decode(entries['group1']['salt']),
                          m['kdf']['iterations'], dklen=32)
try:
    AESGCM(bad).decrypt(base64.b64decode(entries['group1']['iv']),
                        base64.b64decode(entries['group1']['wrapped']), None)
    sys.exit('FAIL: wrong code unexpectedly unwrapped group1')
except Exception:
    print('Wrong code correctly rejected (GCM auth failure).')

key = next(iter(keys.values()))
for kind, info in m['files'].items():
    blob_path = os.path.join(ENTROPY, 'reader_gate_dist', info['path'])
    with open(blob_path, 'rb') as fh:
        blob = fh.read()
    try:
        plain = AESGCM(key).decrypt(blob[:12], blob[12:], None)
        print(f'{kind}: decrypts OK ({len(plain)} plaintext bytes)')
    except Exception:
        sys.exit(f'FAIL: {kind} blob does not decrypt with the content key')
print('All blobs decrypt with the shared content key.')
