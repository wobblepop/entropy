#!/usr/bin/env python3
"""
build_chickenwhispering_multi.py - Assemble the MULTI-EDITION reader gate for
the "Chicken Whispering" early-reader page (frauddyscotty.com/chickenwhispering).

The page is one gate: the reader enters a single access code, then picks an
edition with a toggle:

    appropriate  ->  Sorta Appropriate  (the cleaned-up "Textbook Edition")
    unhinged     ->  Unhinged Version   (the original, uncensored edition)

Layout produced in --out:

    <out>/
      index.html              (reader_gate/gate_template_multi.html)
      vendor/                 (pdf-lib.min.js, jszip.min.js)
      appropriate/
        manifest.json, html.bin, pdf.bin, epub.bin
      unhinged/
        manifest.json, html.bin, pdf.bin, epub.bin

Both editions are encrypted INDEPENDENTLY (a fresh content key each, wrapped per
code) but with the SAME access codes, so one valid code unlocks both. The
existing original ("unhinged") bundle is REUSED byte-for-byte from --unhinged-src
-- its manifest.json / *.bin are never edited (only copied), per the project's
"never edit manifest.json or the .bin files" rule. Only the new "appropriate"
bundle is built fresh, which requires the access codes.

Two ways to supply each edition's encrypted bundle:
  * --unhinged-src DIR        reuse an already-built bundle (manifest + 3 .bin)
  * --appropriate-src DIR     reuse an already-built bundle (manifest + 3 .bin)
  * --appropriate-json FILE   build the appropriate bundle now from a book JSON
                              (requires --codes; runs the slow PDF render unless
                              --reuse finds <stem>.html/.pdf/.epub siblings)

Examples:

  # Full build of the clean edition + assemble (what Scott runs with real codes):
  py build_chickenwhispering_multi.py \
      --appropriate-json "../frauddyscotty/Chicken Whispering - Textbook Edition.entropy.json" \
      --unhinged-src "../frauddyscotty/staging/chickenwhispering" \
      --codes group1=CODE1 group2=CODE2 ... group7=CODE7 \
      --log-endpoint https://formspree.io/f/xgobljap \
      --out "../frauddyscotty/staging/chickenwhispering_multi"

  # Assemble from two already-built bundles (no codes needed here):
  py build_chickenwhispering_multi.py \
      --appropriate-src ./appropriate_dist \
      --unhinged-src "../frauddyscotty/staging/chickenwhispering" \
      --out ./chickenwhispering_multi
"""

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

# Reuse the proven single-edition builder + helpers (same folder).
import build_reader_gate as brg

HERE = Path(__file__).resolve().parent
GATE_MULTI_TEMPLATE = HERE / "reader_gate" / "gate_template_multi.html"
VENDOR_DIR = HERE / "reader_gate" / "vendor"
VENDOR_FILES = ("pdf-lib.min.js", "jszip.min.js")
BIN_NAMES = ("html.bin", "pdf.bin", "epub.bin")
# The Formspree access-log endpoint currently in use (see project memory). It is
# the one manifest field treated as plain config; override with --log-endpoint.
DEFAULT_LOG_ENDPOINT = "https://formspree.io/f/xgobljap"

EDITIONS = ("appropriate", "unhinged")  # must match gate_template_multi.html


# ---------------------------------------------------------------------------
# Validation helpers
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
    codes = m.get("codes")
    if not isinstance(codes, list) or not codes:
        raise ValueError(f"{manifest_path}: no access codes")
    for i, c in enumerate(codes):
        if not isinstance(c, dict) or not c.get("label"):
            raise ValueError(f"{manifest_path}: code entry {i} missing label")
        for fld, ln in (("salt", 24), ("iv", 16), ("wrapped", 64)):
            v = c.get(fld)
            if not isinstance(v, str) or not v:
                raise ValueError(f"{manifest_path}: code entry {i} missing {fld}")
    files = m.get("files")
    if not isinstance(files, dict):
        raise ValueError(f"{manifest_path}: missing files block")
    for kind in ("html", "pdf", "epub"):
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
    manifest = src / "manifest.json"
    m = load_and_validate_manifest(manifest)
    # The manifest's file paths must be the plain bin names we expect to copy.
    for kind in ("html", "pdf", "epub"):
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


# ---------------------------------------------------------------------------
# Build the appropriate edition (only when --appropriate-json is given)
# ---------------------------------------------------------------------------
def build_appropriate(json_path, codes, log_endpoint, watermark, reuse, work_root):
    """Run the single-edition builder into a temp dir; return that dir."""
    out_dir = work_root / "appropriate_build"
    print(f"\n[appropriate] Building encrypted bundle from: {json_path}")
    brg.build(json_path, codes, out_dir, log_endpoint, watermark, reuse)
    return out_dir


# ---------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------
def copy_bundle_into(src, dest):
    """Copy manifest.json + the 3 .bin files from src into dest (no plaintext)."""
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / "manifest.json", dest / "manifest.json")
    for bn in BIN_NAMES:
        shutil.copy2(src / bn, dest / bn)


def assemble(appropriate_src, unhinged_src, out_dir):
    out_dir = Path(out_dir).resolve()

    appropriate_src, m_app = validate_bundle_dir(appropriate_src, "appropriate")
    unhinged_src, m_unh = validate_bundle_dir(unhinged_src, "unhinged")

    # Same-codes invariant: a single reader code must unlock both editions, so
    # the two manifests must expose the same set of code labels. (The wrapped
    # keys differ per edition; only the labels need to line up.)
    if set(code_labels(m_app)) != set(code_labels(m_unh)):
        raise ValueError(
            "code labels differ between editions -- a single code could not "
            f"unlock both.\n  appropriate: {sorted(code_labels(m_app))}\n"
            f"  unhinged:    {sorted(code_labels(m_unh))}")

    if not GATE_MULTI_TEMPLATE.exists():
        raise FileNotFoundError(f"multi-edition gate template missing: {GATE_MULTI_TEMPLATE}")
    for vf in VENDOR_FILES:
        if not (VENDOR_DIR / vf).exists():
            raise FileNotFoundError(f"vendor file missing: {VENDOR_DIR / vf}")

    if out_dir.exists():
        if any(out_dir.iterdir()):
            raise FileExistsError(
                f"--out already exists and is not empty: {out_dir}\n"
                "  Refusing to overwrite. Remove it or choose a fresh --out.")
    else:
        out_dir.mkdir(parents=True)

    # Root page + vendor.
    shutil.copy2(GATE_MULTI_TEMPLATE, out_dir / "index.html")
    (out_dir / "vendor").mkdir(exist_ok=True)
    for vf in VENDOR_FILES:
        shutil.copy2(VENDOR_DIR / vf, out_dir / "vendor" / vf)

    # Per-edition encrypted bundles.
    copy_bundle_into(appropriate_src, out_dir / "appropriate")
    copy_bundle_into(unhinged_src, out_dir / "unhinged")

    # --- Post-assembly safety checks ---------------------------------------
    # 1. Re-validate both copied manifests.
    for ed in EDITIONS:
        load_and_validate_manifest(out_dir / ed / "manifest.json")
    # 2. No plaintext book artifacts anywhere (only index.html may be .html).
    leftover = [str(p.relative_to(out_dir)) for p in out_dir.rglob("*")
                if p.is_file() and p.suffix in (".html", ".pdf", ".epub")
                and p.name != "index.html"]
    if leftover:
        raise RuntimeError(f"plaintext artifacts found in output folder: {leftover}")
    # 3. All six blobs present and non-empty.
    for ed in EDITIONS:
        for bn in BIN_NAMES:
            b = out_dir / ed / bn
            if not b.exists() or b.stat().st_size == 0:
                raise RuntimeError(f"missing/empty blob after assembly: {b}")

    total = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
    print(f"\nDone -> {out_dir}")
    print(f"  Layout: index.html + vendor/ + appropriate/ + unhinged/")
    print(f"  Total size: {total / 1024 / 1024:.1f} MB")
    print(f"  Shared code labels: {sorted(code_labels(m_app))}")
    print("  Reader enters ONE code, then toggles edition. Requires HTTPS hosting.")
    print("  This is a NEW folder -- review it, then promote to staging/prod yourself.")
    return out_dir


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv):
    ap = argparse.ArgumentParser(
        description="Assemble the multi-edition Chicken Whispering reader gate.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--appropriate-src", help="dir with an already-built clean-edition bundle")
    g.add_argument("--appropriate-json", help="book JSON to build the clean edition from now")
    ap.add_argument("--unhinged-src", required=True,
                    help="dir with the existing original bundle (manifest + 3 .bin) to reuse")
    ap.add_argument("--codes", nargs="+", metavar="LABEL=CODE",
                    help="access codes (required with --appropriate-json); must match the "
                         "unhinged bundle's code labels")
    ap.add_argument("--log-endpoint", default=DEFAULT_LOG_ENDPOINT,
                    help=f"access-log endpoint for the built clean edition (default: {DEFAULT_LOG_ENDPOINT})")
    ap.add_argument("--watermark", default=brg.DEFAULT_WATERMARK,
                    help="watermark template with {email}/{group} (clean-edition build only)")
    ap.add_argument("--reuse", action="store_true",
                    help="reuse existing .html/.pdf/.epub siblings of --appropriate-json")
    ap.add_argument("--out", required=True, help="output folder (must be empty/new)")
    args = ap.parse_args(argv)

    work_root = None
    try:
        if args.appropriate_json:
            if not args.codes:
                raise ValueError("--codes is required when using --appropriate-json")
            codes = brg.parse_codes(args.codes)
            if "{email}" not in args.watermark:
                raise ValueError("--watermark must contain the {email} placeholder")
            work_root = Path(tempfile.mkdtemp(prefix="cw_multi_"))
            appropriate_src = build_appropriate(
                args.appropriate_json, codes, args.log_endpoint,
                args.watermark, args.reuse, work_root)
        else:
            if args.codes:
                print("Note: --codes ignored (using prebuilt --appropriate-src).")
            appropriate_src = Path(args.appropriate_src)

        assemble(appropriate_src, args.unhinged_src, args.out)
    except (ValueError, FileNotFoundError, FileExistsError, RuntimeError) as exc:
        print(f"Error: {exc}")
        return 1
    finally:
        if work_root and work_root.exists():
            shutil.rmtree(work_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
