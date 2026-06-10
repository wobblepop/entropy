# Reader Gate — private early-reader distribution

Turns a `.entropy.json` book into one static folder you upload to frauddyscotty.com.
Readers enter a group access code + their own email and get the book as
watermarked HTML (read in browser), PDF, or EPUB — decrypted entirely in their
browser. No server code, no database, no per-reader work.

## One-time setup: access logging (optional)

1. Create a free form at https://formspree.io (sign in, "New form", name it
   e.g. "chicken-whispering-readers").
2. Copy the form endpoint URL — it looks like `https://formspree.io/f/abcdwxyz`.
3. Pass it to the build with `--log-endpoint`. Each unlock and each download
   then appears in your Formspree inbox as `{email, group, action, timestamp,
   book}`. Logging is best-effort: if it fails, the reader still gets the book.

## Build

From the `entropy` folder:

```
py build_reader_gate.py "Chicken Whispering 20260608.json" ^
    --codes students=YOUR-STUDENT-CODE family=YOUR-FAMILY-CODE ^
    --log-endpoint https://formspree.io/f/XXXXXXXX
```

- Codes: pick anything memorable, 6+ characters. They are case-insensitive.
  **They are not stored anywhere — write them down when the build prints them.**
- Output: `reader_gate_dist/` next to the book JSON. Regenerating the PDF via
  Playwright is the slow step; add `--reuse` to reuse existing
  `<stem>.html/.pdf/.epub` files sitting next to the JSON instead.

## Upload

Upload the **contents** of `reader_gate_dist/` to a folder on frauddyscotty.com,
e.g. `/book/`. Required files: `index.html`, `manifest.json`, `html.bin`,
`pdf.bin`, `epub.bin`, `vendor/` (2 JS files). Then share:

> Read the early copy at https://frauddyscotty.com/book/ — your access code is STUDENT-CODE.

**The site must be served over HTTPS** (browsers refuse to run the decryption
API on insecure pages). Any normal host with an SSL certificate is fine.

## Rotating / revoking codes

Re-run the build with new `--codes` and upload again. Every build generates a
fresh content key, so all old codes stop working immediately. To revoke just
one group, re-run with the other groups' codes unchanged plus a new code for
the revoked group (readers with the old code lose access; everyone else just
keeps using theirs).

## What this does and does not protect

- **Does:** keeps the book unreadable without a code (real AES-256-GCM
  encryption, not hidden text); stamps every delivered copy — HTML banner,
  every PDF page, every EPUB chapter — with the reader's email and group, so a
  leaked copy identifies its source; logs who unlocked what, when.
- **Does not:** stop a determined reader from copying text out of a copy they
  legitimately unlocked, or from manually removing watermarks. That is true of
  every DRM-free system (and effectively of DRM too). The protection model is
  encryption at the gate + social accountability after it.
