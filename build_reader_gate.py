#!/usr/bin/env python3
"""
build_reader_gate.py - Build an encrypted early-reader distribution folder
from a .entropy.json book.

Produces a static folder you upload to any web host (e.g. frauddyscotty.com).
Readers open index.html, enter an access code plus their own email address,
and the page decrypts the book in their browser and hands them a personally
watermarked copy in any of three formats:

  - HTML  (read in the browser, watermark banner injected)
  - PDF   (every page stamped with the reader's email, via pdf-lib)
  - EPUB  (watermark footer injected into every chapter, via JSZip)

Security model (matches reader_gate/gate_template.html exactly):
  - One random 32-byte content key K encrypts each artifact with AES-256-GCM
    (blob layout: 12-byte IV || ciphertext+tag).
  - For each access code: KEK = PBKDF2-HMAC-SHA256(normalized code, salt,
    ITERATIONS) and K is wrapped with AES-256-GCM under the KEK.
  - Code normalization on BOTH sides: NFC, strip, uppercase.
  - manifest.json stores only salts, IVs, and wrapped keys -- never the codes.
    Wrong code = GCM authentication failure = nothing decrypts.

Revoking a group or rotating codes = rerun this script with new codes and
re-upload (a fresh K is generated every build, so old codes stop working).

Usage:
    py build_reader_gate.py <input.entropy.json> --codes label=CODE [label=CODE ...]
        [--log-endpoint URL] [--out DIR] [--watermark TEXT] [--reuse]

Example:
    py build_reader_gate.py "Chicken Whispering 20260608.json" \
        --codes students=CLUCK-AND-LEARN family=EGGCELLENT-KIN \
        --log-endpoint https://formspree.io/f/XXXXXXXX

Options:
    --out DIR        Output folder (default: reader_gate_dist next to input).
    --log-endpoint   Form endpoint that receives {email, group, action,
                     timestamp, book} JSON posts (e.g. a Formspree form).
                     Empty/omitted = no logging.
    --watermark      Watermark template; {email} and {group} are replaced
                     per reader. Default below.
    --reuse          Reuse existing <stem>.html/.pdf/.epub siblings of the
                     input instead of regenerating (skips the slow PDF step;
                     all three files must exist).
"""

import argparse
import base64
import hashlib
import json
import os
import shutil
import sys
import unicodedata
from pathlib import Path

# AES-GCM needs the `cryptography` package (verified installed: 46.0.6).
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    print("Error: the 'cryptography' package is required. Install with: py -m pip install cryptography")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants -- must stay in sync with reader_gate/gate_template.html
# ---------------------------------------------------------------------------
MANIFEST_VERSION = 1
KDF_ITERATIONS = 600_000
SALT_BYTES = 16
IV_BYTES = 12
KEY_BYTES = 32
DEFAULT_WATERMARK = "Early reader copy · {email} · {group} · Please don't share or post."
GATE_DIR = Path(__file__).resolve().parent / "reader_gate"
GATE_TEMPLATE = GATE_DIR / "gate_template.html"
VENDOR_DIR = GATE_DIR / "vendor"
VENDOR_FILES = ("pdf-lib.min.js", "jszip.min.js")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def normalize_code(code):
    """NFC + strip + uppercase. MUST match the JavaScript side exactly."""
    if not isinstance(code, str):
        raise TypeError(f"access code must be a string, got {type(code).__name__}")
    return unicodedata.normalize("NFC", code).strip().upper()


def b64(raw):
    """Standard base64 (with padding) as ASCII string."""
    if not isinstance(raw, (bytes, bytearray)):
        raise TypeError("b64 expects bytes")
    return base64.b64encode(bytes(raw)).decode("ascii")


def parse_codes(pairs):
    """Parse ['students=CLUCK-2026', ...] -> [(label, normalized_code), ...]."""
    if not pairs:
        raise ValueError("at least one --codes label=CODE pair is required")
    out = []
    seen_labels = set()
    seen_codes = set()
    for pair in pairs:
        if "=" not in pair:
            raise ValueError(f"bad --codes entry '{pair}': expected label=CODE")
        label, code = pair.split("=", 1)
        label = label.strip()
        norm = normalize_code(code)
        if not label:
            raise ValueError(f"bad --codes entry '{pair}': empty label")
        if len(norm) < 6:
            raise ValueError(f"code for '{label}' is too short ({len(norm)} chars); use at least 6")
        if label in seen_labels:
            raise ValueError(f"duplicate label '{label}'")
        if norm in seen_codes:
            raise ValueError(f"two groups share the same code (after normalization): '{label}'")
        seen_labels.add(label)
        seen_codes.add(norm)
        out.append((label, norm))
    return out


def encrypt_blob(key, data):
    """Encrypt bytes with AES-256-GCM. Returns IV || ciphertext+tag."""
    if not isinstance(key, bytes) or len(key) != KEY_BYTES:
        raise ValueError("encrypt_blob: key must be 32 bytes")
    if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        raise ValueError("encrypt_blob: data must be non-empty bytes")
    iv = os.urandom(IV_BYTES)
    return iv + AESGCM(key).encrypt(iv, bytes(data), None)


def wrap_content_key(content_key, code_norm):
    """Derive a KEK from the code and wrap the content key. Returns manifest entry fields."""
    if len(content_key) != KEY_BYTES:
        raise ValueError("content key must be 32 bytes")
    salt = os.urandom(SALT_BYTES)
    iv = os.urandom(IV_BYTES)
    kek = hashlib.pbkdf2_hmac("sha256", code_norm.encode("utf-8"), salt, KDF_ITERATIONS, dklen=KEY_BYTES)
    wrapped = AESGCM(kek).encrypt(iv, content_key, None)
    return {"salt": b64(salt), "iv": b64(iv), "wrapped": b64(wrapped)}


def self_test_roundtrip(manifest_entry, code_norm, content_key):
    """Verify a wrapped key unwraps with the right code and fails with a wrong one."""
    salt = base64.b64decode(manifest_entry["salt"])
    iv = base64.b64decode(manifest_entry["iv"])
    wrapped = base64.b64decode(manifest_entry["wrapped"])
    kek = hashlib.pbkdf2_hmac("sha256", code_norm.encode("utf-8"), salt, KDF_ITERATIONS, dklen=KEY_BYTES)
    if AESGCM(kek).decrypt(iv, wrapped, None) != content_key:
        raise RuntimeError("round-trip failed: unwrapped key does not match")
    bad = hashlib.pbkdf2_hmac("sha256", b"WRONG-CODE", salt, KDF_ITERATIONS, dklen=KEY_BYTES)
    try:
        AESGCM(bad).decrypt(iv, wrapped, None)
    except Exception:
        return  # expected: wrong code must fail authentication
    raise RuntimeError("round-trip failed: wrong code unexpectedly decrypted the key")


# ---------------------------------------------------------------------------
# Artifact generation
# ---------------------------------------------------------------------------
def generate_artifacts(json_path, work_dir, reuse):
    """Produce (html_bytes, pdf_bytes, epub_bytes) for the book."""
    json_path = Path(json_path)
    stem = json_path.stem

    if reuse:
        paths = {ext: json_path.with_suffix("." + ext) for ext in ("html", "pdf", "epub")}
        missing = [str(p) for p in paths.values() if not p.exists()]
        if missing:
            raise FileNotFoundError("--reuse given but missing: " + ", ".join(missing))
        print("  Reusing existing artifacts:")
        for p in paths.values():
            print(f"    {p.name} ({p.stat().st_size / 1024:.0f} KB)")
        return tuple(paths[ext].read_bytes() for ext in ("html", "pdf", "epub"))

    work_dir.mkdir(parents=True, exist_ok=True)

    print("  [1/3] HTML ...")
    from entropy_to_html import generate_html
    html_path = generate_html(json_path, work_dir / f"{stem}.html")

    print("  [2/3] PDF (Playwright render -- this is the slow step) ...")
    from entropy_to_pdf_v2 import generate_pdf
    pdf_path = work_dir / f"{stem}.pdf"
    generate_pdf(json_path, pdf_path)
    if not pdf_path.exists():
        raise RuntimeError(f"PDF generation reported success but {pdf_path} does not exist")

    print("  [3/3] EPUB ...")
    from entropy_to_epub import build_epub
    epub_path = build_epub(json_path, work_dir / f"{stem}.epub")

    out = []
    for p in (Path(html_path), pdf_path, Path(epub_path)):
        data = p.read_bytes()
        if len(data) == 0:
            raise RuntimeError(f"generated artifact is empty: {p}")
        out.append(data)
    return tuple(out)


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build(json_path, codes, out_dir, log_endpoint, watermark, reuse):
    json_path = Path(json_path).resolve()
    if not json_path.exists():
        raise FileNotFoundError(f"input not found: {json_path}")
    try:
        meta = json.loads(json_path.read_text(encoding="utf-8")).get("meta", {}) or {}
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read book JSON: {exc}")

    if not GATE_TEMPLATE.exists():
        raise FileNotFoundError(f"gate template missing: {GATE_TEMPLATE}")
    for vf in VENDOR_FILES:
        if not (VENDOR_DIR / vf).exists():
            raise FileNotFoundError(f"vendor file missing: {VENDOR_DIR / vf}")
    if "{email}" not in watermark:
        raise ValueError("--watermark must contain the {email} placeholder")

    out_dir = Path(out_dir).resolve()
    work_dir = out_dir / ".build_tmp"

    print(f"Building reader gate for: {meta.get('title', json_path.name)}")
    html_b, pdf_b, epub_b = generate_artifacts(json_path, work_dir, reuse)

    print("  Encrypting (AES-256-GCM, fresh content key) ...")
    content_key = os.urandom(KEY_BYTES)
    blobs = {
        "html": ("html.bin", encrypt_blob(content_key, html_b)),
        "pdf": ("pdf.bin", encrypt_blob(content_key, pdf_b)),
        "epub": ("epub.bin", encrypt_blob(content_key, epub_b)),
    }

    code_entries = []
    for label, norm in codes:
        entry = {"label": label, **wrap_content_key(content_key, norm)}
        self_test_roundtrip(entry, norm, content_key)
        code_entries.append(entry)
    print(f"  Wrapped content key for {len(code_entries)} group code(s); round-trips verified.")

    manifest = {
        "version": MANIFEST_VERSION,
        "title": meta.get("title", ""),
        "subtitle": meta.get("subtitle", ""),
        "author": meta.get("author", ""),
        "generated": str(meta.get("modified", ""))[:10],
        "kdf": {"name": "PBKDF2", "hash": "SHA-256", "iterations": KDF_ITERATIONS},
        "codes": code_entries,
        "files": {k: {"path": fn, "size": len(data)} for k, (fn, data) in blobs.items()},
        "logEndpoint": log_endpoint or "",
        "watermark": watermark,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    for _, (fn, data) in blobs.items():
        (out_dir / fn).write_bytes(data)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    shutil.copy2(GATE_TEMPLATE, out_dir / "index.html")
    (out_dir / "vendor").mkdir(exist_ok=True)
    for vf in VENDOR_FILES:
        shutil.copy2(VENDOR_DIR / vf, out_dir / "vendor" / vf)

    # plaintext artifacts must not ship in the upload folder
    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    leftover = [p.name for p in out_dir.rglob("*")
                if p.is_file() and p.suffix in (".html", ".pdf", ".epub") and p.name != "index.html"]
    if leftover:
        raise RuntimeError(f"plaintext artifacts found in output folder: {leftover}")

    total = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
    print(f"\nDone -> {out_dir}")
    print(f"  Upload everything in that folder. Total size: {total / 1024 / 1024:.1f} MB")
    print(f"  Codes are NOT stored anywhere -- record them yourself:")
    for label, norm in codes:
        print(f"    {label}: {norm}")
    print("  Requires HTTPS hosting (browser crypto refuses insecure pages).")
    return out_dir


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv):
    ap = argparse.ArgumentParser(description="Build an encrypted early-reader distribution folder.")
    ap.add_argument("input", help="path to the .entropy.json book file")
    ap.add_argument("--codes", nargs="+", required=True, metavar="LABEL=CODE",
                    help="one or more group access codes, e.g. students=CLUCK-2026")
    ap.add_argument("--log-endpoint", default="", help="form endpoint URL for access logging (optional)")
    ap.add_argument("--out", default=None, help="output folder (default: reader_gate_dist next to input)")
    ap.add_argument("--watermark", default=DEFAULT_WATERMARK,
                    help="watermark template with {email} and {group} placeholders")
    ap.add_argument("--reuse", action="store_true",
                    help="reuse existing .html/.pdf/.epub siblings of the input instead of regenerating")
    args = ap.parse_args(argv)

    try:
        codes = parse_codes(args.codes)
        out_dir = args.out or (Path(args.input).resolve().parent / "reader_gate_dist")
        build(args.input, codes, out_dir, args.log_endpoint, args.watermark, args.reuse)
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        print(f"Error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
