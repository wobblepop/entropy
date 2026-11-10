#!/usr/bin/env python3
"""
build_chickenwhispering_multi.py - Assemble the MULTI-EDITION reader gate for
the "Chicken Whispering" page (frauddyscotty.com/chickenwhispering).

One gate page; each reader enters one access code. Every edition is encrypted
independently (its own content key) and its manifest lists ONLY the codes that
may open it, so the editions a reader gets are decided by their code and
enforced by the encryption, not just by what the page shows.

The editions the gate knows about, in page display order, are EDITION_CATALOG
below. A build includes any subset of them; the page lists only the editions
in that build (the builder writes the list into index.html).

Access codes come from a codes file: a box-drawn table such as
frauddyscotty/codes.txt with three columns,

    │ Label     │ Code         │ Opens    │
    │ group1    │ ...          │ all      │
    │ students1 │ ...          │ textbook │

"Opens" is "all" or a comma-separated list of edition keys. Codes are never
printed. Labels are internal: they appear in manifests and the access log,
never on the page. Use reader_gate/add_access_code.py to add a code.

Layout produced in --out:

    <out>/
      index.html     (reader_gate/gate_template_multi.html + this build's edition list)
      vendor/        (pdf-lib.min.js, jszip.min.js)
      <dir>/         manifest.json, html.bin, pdf.bin, epub.bin   (one per edition)

Each edition comes from one of:
  --edition KEY=DIR          an already-built bundle (manifest + 3 .bin), copied
                             byte-for-byte after its codes are verified
  --edition-json KEY=FILE    a book JSON to build now (runs the slow PDF render
                             unless --reuse finds <stem>.html/.pdf/.epub siblings)

Checked before the output folder is written:
  * every code row is valid; labels and codes are unique; every Opens key is known
  * each edition gets at least one code
  * each edition's manifest lists exactly the labels whose code opens it
  * every listed code unwraps its entry, all entries unwrap the same content
    key, and all three blobs decrypt with that key

Examples (run from the entropy folder):

  # Re-assemble the two live editions with the current gate page:
  py build_chickenwhispering_multi.py --codes-file "../frauddyscotty/codes.txt" \
      --edition appropriate="../frauddyscotty/prod/chickenwhispering/appropriate" \
      --edition unhinged="../frauddyscotty/prod/chickenwhispering/unhinged" \
      --out "../frauddyscotty/staging/chickenwhispering_YYYYMMDD"

  # Later, add the textbook edition (built now from its book JSON):
  py build_chickenwhispering_multi.py --codes-file "../frauddyscotty/codes.txt" \
      --edition appropriate=... --edition unhinged=... \
      --edition-json textbook="../frauddyscotty/<textbook book>.json" \
      --out "../frauddyscotty/staging/chickenwhispering_YYYYMMDD"
"""

import argparse
import base64
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

# Reuse the proven single-edition builder + helpers (same folder).
import build_reader_gate as brg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = Path(__file__).resolve().parent
GATE_MULTI_TEMPLATE = HERE / "reader_gate" / "gate_template_multi.html"
VENDOR_DIR = HERE / "reader_gate" / "vendor"
VENDOR_FILES = ("pdf-lib.min.js", "jszip.min.js")
BIN_NAMES = ("html.bin", "pdf.bin", "epub.bin")
KINDS = ("html", "pdf", "epub")
# The Formspree access-log endpoint currently in use (see project memory). It is
# the one manifest field treated as plain config; override with --log-endpoint.
DEFAULT_LOG_ENDPOINT = "https://formspree.io/f/xgobljap"

# Editions the gate knows about, in the order the page shows them. `key` is the
# value used in the codes file's Opens column and in the access log; `dir` is
# the subfolder holding that edition's bundle; `label`/`blurb` are shown to
# readers. A blurb may be empty.
EDITION_CATALOG = (
    {"key": "appropriate", "dir": "appropriate", "label": "Sorta Appropriate",
     "blurb": "(The version with less swearing)"},
    {"key": "unhinged", "dir": "unhinged", "label": "Unhinged Version",
     "blurb": "(The version with more swearing)"},
    {"key": "textbook", "dir": "textbook", "label": "Textbook Version",
     "blurb": ""},
)

CONFIG_TOKEN = "__EDITION_CONFIG__"   # placeholder in gate_template_multi.html
OPENS_ALL = "all"
BOX_V = "│"                      # │ column separator in the codes file
KEY_RE = re.compile(r"^[a-z0-9-]{1,32}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
MIN_CODE_LEN = 6                      # same floor as build_reader_gate.parse_codes


# ---------------------------------------------------------------------------
# Edition catalog
# ---------------------------------------------------------------------------
def validate_catalog(catalog=EDITION_CATALOG):
    """Fail loudly if the catalog itself is malformed. Returns {key: entry}."""
    if not catalog:
        raise ValueError("EDITION_CATALOG is empty")
    by_key, dirs = {}, set()
    for e in catalog:
        if not isinstance(e, dict):
            raise ValueError("EDITION_CATALOG entries must be dicts")
        key, d = e.get("key"), e.get("dir")
        label, blurb = e.get("label"), e.get("blurb", "")
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise ValueError(f"catalog key {key!r} must match {KEY_RE.pattern}")
        if not isinstance(d, str) or not KEY_RE.match(d):
            raise ValueError(f"catalog dir {d!r} for '{key}' must match {KEY_RE.pattern}")
        if not isinstance(label, str) or not label.strip() or len(label) > 80:
            raise ValueError(f"catalog label for '{key}' must be 1-80 characters")
        if not isinstance(blurb, str) or len(blurb) > 200:
            raise ValueError(f"catalog blurb for '{key}' must be a string of at most 200 characters")
        if key in by_key or d in dirs:
            raise ValueError(f"catalog key/dir '{key}'/'{d}' is not unique")
        by_key[key] = e
        dirs.add(d)
    return by_key


# ---------------------------------------------------------------------------
# Codes file
# ---------------------------------------------------------------------------
def parse_opens(text, label, catalog):
    """'all' -> None (every edition); 'a, b' -> frozenset({'a','b'})."""
    t = text.strip()
    if not t:
        raise ValueError(f"code '{label}': the Opens column is empty (use 'all' or edition keys)")
    if t.lower() == OPENS_ALL:
        return None
    keys = [k.strip() for k in t.split(",")]
    if any(not k for k in keys):
        raise ValueError(f"code '{label}': Opens has an empty item: {t!r}")
    unknown = [k for k in keys if k not in catalog]
    if unknown:
        raise ValueError(f"code '{label}': unknown edition(s) {unknown} in Opens; "
                         f"known: {sorted(catalog)} or '{OPENS_ALL}'")
    return frozenset(keys)


def read_codes_file(path, catalog=None):
    """Parse the codes table. Returns [{'label', 'code', 'opens'}] in file order.

    'code' is normalized (NFC, strip, upper) exactly as the gate does.
    'opens' is None for all editions, else a frozenset of edition keys.
    Error messages name labels and line numbers, never codes.
    """
    catalog = catalog if catalog is not None else validate_catalog()
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"codes file not found: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ValueError(f"could not read codes file {path}: {exc}")

    rows, labels, codes = [], set(), set()
    for n, line in enumerate(text.splitlines(), 1):
        if BOX_V not in line:
            continue                      # borders / separators
        cells = [c.strip() for c in line.split(BOX_V)[1:-1]]
        if not cells or cells[0].lower() == "label":
            continue                      # header row
        if len(cells) != 3:
            raise ValueError(f"codes file line {n}: expected 3 columns "
                             f"(Label | Code | Opens), found {len(cells)}")
        label, raw_code, opens_text = cells
        if not LABEL_RE.match(label):
            raise ValueError(f"codes file line {n}: label must match {LABEL_RE.pattern}")
        norm = brg.normalize_code(raw_code)
        if len(norm) < MIN_CODE_LEN:
            raise ValueError(f"code '{label}' is shorter than {MIN_CODE_LEN} characters")
        if label in labels:
            raise ValueError(f"label '{label}' appears twice in the codes file")
        if norm in codes:
            raise ValueError(f"code '{label}' duplicates an earlier code (after normalization)")
        labels.add(label)
        codes.add(norm)
        rows.append({"label": label, "code": norm,
                     "opens": parse_opens(opens_text, label, catalog)})
    if not rows:
        raise ValueError(f"codes file has no code rows: {path}")
    return rows


def codes_for(edition_key, rows):
    """[(label, code)] of every row that opens this edition, in file order."""
    return [(r["label"], r["code"]) for r in rows
            if r["opens"] is None or edition_key in r["opens"]]


# ---------------------------------------------------------------------------
# Bundle validation + cryptographic verification
# ---------------------------------------------------------------------------
def load_and_validate_manifest(manifest_path):
    """Read a manifest.json and run the same shape checks the gate does."""
    if not manifest_path.exists():
        raise FileNotFoundError(f"manifest not found: {manifest_path}")
    try:
        m = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read manifest {manifest_path}: {exc}")
    if not isinstance(m, dict):
        raise ValueError(f"{manifest_path}: manifest is not an object")
    if m.get("version") != brg.MANIFEST_VERSION:
        raise ValueError(f"{manifest_path}: unsupported manifest version {m.get('version')!r}")
    kdf = m.get("kdf")
    if (not isinstance(kdf, dict) or kdf.get("name") != "PBKDF2" or kdf.get("hash") != "SHA-256"
            or not isinstance(kdf.get("iterations"), int) or kdf["iterations"] < 1):
        raise ValueError(f"{manifest_path}: kdf must be PBKDF2 / SHA-256 with integer iterations")
    codes = m.get("codes")
    if not isinstance(codes, list) or not codes:
        raise ValueError(f"{manifest_path}: no access codes")
    for i, c in enumerate(codes):
        if not isinstance(c, dict) or not c.get("label"):
            raise ValueError(f"{manifest_path}: code entry {i} missing label")
        for fld in ("salt", "iv", "wrapped"):
            v = c.get(fld)
            if not isinstance(v, str) or not v:
                raise ValueError(f"{manifest_path}: code entry {i} missing {fld}")
    files = m.get("files")
    if not isinstance(files, dict):
        raise ValueError(f"{manifest_path}: missing files block")
    for kind in KINDS:
        f = files.get(kind)
        if not isinstance(f, dict) or not f.get("path"):
            raise ValueError(f"{manifest_path}: files.{kind} missing/invalid")
    if not isinstance(m.get("watermark"), str) or not m.get("watermark"):
        raise ValueError(f"{manifest_path}: missing watermark template")
    return m


def validate_bundle_dir(src, name):
    """A bundle dir must hold a valid manifest.json + the 3 named .bin files."""
    src = Path(src)
    if not src.is_dir():
        raise FileNotFoundError(f"{name} bundle dir not found: {src}")
    m = load_and_validate_manifest(src / "manifest.json")
    for kind in KINDS:
        path = m["files"][kind]["path"]
        if path not in BIN_NAMES:
            raise ValueError(
                f"{name}: manifest files.{kind}.path is {path!r}; "
                f"expected one of {BIN_NAMES} (bundle must be self-contained)")
    for bn in BIN_NAMES:
        b = src / bn
        if not b.exists() or b.stat().st_size == 0:
            raise FileNotFoundError(f"{name}: missing/empty encrypted blob: {b}")
    return src, m


def code_labels(manifest):
    return [c["label"] for c in manifest["codes"]]


def _unwrap(entry, code, kdf):
    """Content key bytes if `code` opens this manifest entry, else None."""
    try:
        salt = base64.b64decode(entry["salt"], validate=True)
        iv = base64.b64decode(entry["iv"], validate=True)
        wrapped = base64.b64decode(entry["wrapped"], validate=True)
    except (ValueError, TypeError):
        raise ValueError(f"manifest entry '{entry.get('label')}' has malformed base64")
    kek = hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), salt,
                              kdf["iterations"], dklen=brg.KEY_BYTES)
    try:
        key = AESGCM(kek).decrypt(iv, wrapped, None)
    except InvalidTag:
        return None
    return key if len(key) == brg.KEY_BYTES else None


def verify_bundle(src, edition_key, expected):
    """Check a bundle against the codes that should open it.

    expected = [(label, code)]. Verifies the manifest's labels equal the
    expected labels, every code unwraps its own entry to one shared content
    key, and every blob matches its size/hash and decrypts with that key.
    Returns the validated manifest.
    """
    src, m = validate_bundle_dir(src, edition_key)
    labels = code_labels(m)
    if len(set(labels)) != len(labels):
        raise ValueError(f"{edition_key}: manifest lists a code label more than once")
    want = [label for label, _ in expected]
    missing = sorted(set(want) - set(labels))
    extra = sorted(set(labels) - set(want))
    if missing or extra:
        raise ValueError(
            f"{edition_key}: the bundle's code labels do not match the codes file.\n"
            f"  should open this edition but are not in the bundle: {missing}\n"
            f"  in the bundle but should not open this edition:     {extra}\n"
            "  A prebuilt bundle's code list cannot change by copying it; "
            "rebuild this edition with --edition-json.")
    entries = {c["label"]: c for c in m["codes"]}
    content_key = None
    for label, code in expected:
        k = _unwrap(entries[label], code, m["kdf"])
        if k is None:
            raise ValueError(f"{edition_key}: the codes-file code for '{label}' does not open "
                             f"the bundle's '{label}' entry")
        if content_key is None:
            content_key = k
        elif k != content_key:
            raise ValueError(f"{edition_key}: '{label}' unwraps a different content key "
                             "than the other codes")
    for kind in KINDS:
        info = m["files"][kind]
        blob = (src / info["path"]).read_bytes()
        if isinstance(info.get("size"), int) and info["size"] != len(blob):
            raise ValueError(f"{edition_key}: {info['path']} is {len(blob)} bytes; "
                             f"manifest says {info['size']}")
        if info.get("v") and hashlib.sha256(blob).hexdigest()[:16] != info["v"]:
            raise ValueError(f"{edition_key}: {info['path']} does not match its manifest hash")
        if len(blob) < brg.IV_BYTES + 17:
            raise ValueError(f"{edition_key}: {info['path']} is too small to be a valid blob")
        try:
            AESGCM(content_key).decrypt(blob[:brg.IV_BYTES], blob[brg.IV_BYTES:], None)
        except InvalidTag:
            raise ValueError(f"{edition_key}: {info['path']} does not decrypt with the "
                             "content key its codes unwrap")
    return m


# ---------------------------------------------------------------------------
# Edition selection (CLI) + building editions from book JSON
# ---------------------------------------------------------------------------
def parse_edition_args(src_args, json_args, catalog):
    """-> {key: ('src'|'json', Path)} in catalog order."""
    chosen = {}
    for kind, items in (("src", src_args or []), ("json", json_args or [])):
        for item in items:
            if "=" not in item:
                raise ValueError(f"bad edition argument {item!r}: expected KEY=PATH")
            key, p = (s.strip() for s in item.split("=", 1))
            if key not in catalog:
                raise ValueError(f"unknown edition '{key}'; known: {sorted(catalog)}")
            if key in chosen:
                raise ValueError(f"edition '{key}' is given more than once")
            if not p:
                raise ValueError(f"edition '{key}': empty path")
            chosen[key] = (kind, Path(p))
    if not chosen:
        raise ValueError("no editions given: use --edition KEY=DIR and/or --edition-json KEY=FILE")
    resolved = [p.resolve() for _, p in chosen.values()]
    if len(set(resolved)) != len(resolved):
        raise ValueError("two editions point at the same bundle folder or book JSON")
    return {k: chosen[k] for k in catalog if k in chosen}


def check_out_dir(out_dir):
    out_dir = Path(out_dir).resolve()
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise FileExistsError(
            f"--out already exists and is not empty: {out_dir}\n"
            "  Refusing to overwrite. Remove it or choose a fresh --out.")
    return out_dir


# ---------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------
def render_index(template_text, editions):
    """Insert the edition list (catalog entries) into the gate template."""
    if template_text.count(CONFIG_TOKEN) != 1:
        raise ValueError(f"gate template must contain {CONFIG_TOKEN} exactly once")
    config = [{"key": e["key"], "dir": e["dir"], "label": e["label"],
               "blurb": e.get("blurb", "")} for e in editions]
    # "<" escaped so no value can close the <script> element it sits in.
    payload = json.dumps(config, ensure_ascii=False).replace("<", "\\u003c")
    return template_text.replace(CONFIG_TOKEN, payload)


def print_access_table(rows, keys):
    """Label x edition matrix. Labels only -- codes are never printed."""
    w = max([len("label")] + [len(r["label"]) for r in rows])
    cols = [max(len(k), 3) for k in keys]
    print("  Access (labels only; codes are never printed):")
    print("    " + "label".ljust(w) + "  " + "  ".join(k.ljust(c) for k, c in zip(keys, cols)))
    for r in rows:
        cells = []
        for k, c in zip(keys, cols):
            ok = r["opens"] is None or k in r["opens"]
            cells.append(("yes" if ok else "-").ljust(c))
        note = ""
        if r["opens"] is not None and not (r["opens"] & set(keys)):
            note = f"   (opens {', '.join(sorted(r['opens']))}: not in this build)"
        print("    " + r["label"].ljust(w) + "  " + "  ".join(cells) + note)


def assemble(sources, rows, out_dir, catalog):
    """sources = {key: bundle_dir} (catalog order). Verifies, then writes out_dir."""
    out_dir = check_out_dir(out_dir)
    keys = [k for k in catalog if k in sources]
    if not keys:
        raise ValueError("no editions to assemble")

    # Verify every bundle against the codes file BEFORE writing anything.
    for k in keys:
        expected = codes_for(k, rows)
        if not expected:
            raise ValueError(f"no code in the codes file opens edition '{k}'")
        verify_bundle(sources[k], k, expected)
        print(f"  [{k}] verified: {len(expected)} code(s) open it; all 3 blobs decrypt")

    if not GATE_MULTI_TEMPLATE.exists():
        raise FileNotFoundError(f"multi-edition gate template missing: {GATE_MULTI_TEMPLATE}")
    for vf in VENDOR_FILES:
        if not (VENDOR_DIR / vf).exists():
            raise FileNotFoundError(f"vendor file missing: {VENDOR_DIR / vf}")
    index_html = render_index(GATE_MULTI_TEMPLATE.read_text(encoding="utf-8"),
                              [catalog[k] for k in keys])

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(index_html, encoding="utf-8")
    (out_dir / "vendor").mkdir(exist_ok=True)
    for vf in VENDOR_FILES:
        shutil.copy2(VENDOR_DIR / vf, out_dir / "vendor" / vf)
    for k in keys:
        dest = out_dir / catalog[k]["dir"]
        dest.mkdir(parents=True, exist_ok=True)
        src = Path(sources[k])
        shutil.copy2(src / "manifest.json", dest / "manifest.json")
        for bn in BIN_NAMES:
            shutil.copy2(src / bn, dest / bn)

    # --- Post-assembly safety checks ---------------------------------------
    for k in keys:
        validate_bundle_dir(out_dir / catalog[k]["dir"], k)
    leftover = [str(p.relative_to(out_dir)) for p in out_dir.rglob("*")
                if p.is_file() and p.suffix in (".html", ".pdf", ".epub")
                and p.name != "index.html"]
    if leftover:
        raise RuntimeError(f"plaintext artifacts found in output folder: {leftover}")
    for k in keys:
        for bn in BIN_NAMES:
            src_b, out_b = Path(sources[k]) / bn, out_dir / catalog[k]["dir"] / bn
            if out_b.read_bytes() != src_b.read_bytes():
                raise RuntimeError(f"copied blob differs from its source: {out_b}")

    total = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
    print(f"\nDone -> {out_dir}")
    print(f"  Editions on the page: {', '.join(catalog[k]['label'] for k in keys)}")
    print(f"  Total size: {total / 1024 / 1024:.1f} MB")
    print_access_table(rows, keys)
    print("  Requires HTTPS hosting. This is a NEW folder -- review it, then promote it yourself.")
    return out_dir


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv):
    ap = argparse.ArgumentParser(
        description="Assemble the multi-edition Chicken Whispering reader gate.")
    ap.add_argument("--codes-file", required=True,
                    help="codes table (Label | Code | Opens), e.g. ../frauddyscotty/codes.txt")
    ap.add_argument("--edition", action="append", metavar="KEY=DIR",
                    help="reuse an already-built edition bundle (repeatable)")
    ap.add_argument("--edition-json", action="append", metavar="KEY=FILE",
                    help="build an edition now from a book JSON (repeatable)")
    ap.add_argument("--log-endpoint", default=DEFAULT_LOG_ENDPOINT,
                    help=f"access-log endpoint for editions built now (default: {DEFAULT_LOG_ENDPOINT})")
    ap.add_argument("--watermark", default=brg.DEFAULT_WATERMARK,
                    help="watermark template with {email}/{group} for editions built now")
    ap.add_argument("--reuse", action="store_true",
                    help="reuse existing .html/.pdf/.epub siblings of each --edition-json book")
    ap.add_argument("--out", required=True, help="output folder (must be empty/new)")
    args = ap.parse_args(argv)

    work_root = None
    try:
        catalog = validate_catalog()
        rows = read_codes_file(args.codes_file, catalog)
        chosen = parse_edition_args(args.edition, args.edition_json, catalog)
        for k in chosen:
            if not codes_for(k, rows):
                raise ValueError(f"no code in the codes file opens edition '{k}'")
        check_out_dir(args.out)          # fail fast, before any slow build
        if "{email}" not in args.watermark:
            raise ValueError("--watermark must contain the {email} placeholder")

        sources = {}
        for k, (kind, p) in chosen.items():
            if kind == "src":
                sources[k] = p
        for k, (kind, p) in chosen.items():
            if kind != "json":
                continue
            if work_root is None:
                work_root = Path(tempfile.mkdtemp(prefix="cw_multi_"))
            out = work_root / k
            print(f"\n[{k}] Building encrypted bundle from: {p}")
            brg.build(p, codes_for(k, rows), out, args.log_endpoint, args.watermark,
                      args.reuse, print_codes=False)
            sources[k] = out

        assemble({k: sources[k] for k in catalog if k in sources}, rows, args.out, catalog)
    except (ValueError, FileNotFoundError, FileExistsError, RuntimeError) as exc:
        print(f"Error: {exc}")
        return 1
    finally:
        if work_root and work_root.exists():
            shutil.rmtree(work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
