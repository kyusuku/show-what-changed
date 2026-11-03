# Privacy scanner repair evidence

The release goal is a general web-app comparison tool whose public repository, package, and intended history contain no private application context. This record covers the bounded scanner and fresh checks for its TAR record repair. It does not approve a release candidate.

## Exact scanner inputs

| Input | SHA-256 |
| --- | --- |
| `scripts/check-public-privacy.py` | `a38f0d05adddff5f5047c3346c97f723a7e417840312f3ab868b05d8c0ead1a5` |
| `scripts/test_public_privacy.py` | `6070ffedefc0b457e8d44f98ceec3926d4b7ac6ffa6671689bbf78a9b0d91f52` |

The deny policy lives outside the release tree. This record contains neither its values nor its location. Every regression test uses synthetic content.

## Reproduced failure and root cause

The original 41-test suite passed before this repair. An independent CLI canary still returned `passed`, exit 0, for a TAR whose one-byte clean file was followed by gzip-compressed deny content inside its data-block padding. The scanner read the extracted file and checked bytes after `TarFile.offset`. It did not validate the padding in between. High-level TAR iteration also hid PAX and GNU extension records, so checking only ordinary members could not account for every physical record.

Before implementation, the expanded 48-test suite reported 19 assertion failures. The final suite has 51 tests and passes. The original TAR canary now returns the following result.

```json
{"exitCode": 2, "status": "error"}
```

The earlier independent ZIP and compression reproductions were rerun with the repaired scanner. Every case returned `error`, exit 2.

| Synthetic input | Fresh result |
| --- | --- |
| A ZIP containing a compressed deny term followed by a clean ZIP | `error`, exit 2 |
| A clean bzip2 stream followed by gzip containing the deny term | `error`, exit 2 |
| A clean xz stream followed by gzip containing the deny term | `error`, exit 2 |
| A clean gzip stream followed by bzip2 containing the deny term | `error`, exit 2 |

Both independent reproduction scripts exited 0 after the repair. Neither reported a false pass.

## Physical TAR coverage

The shared archive reader now walks physical 512-byte records instead of using `TarFile` iteration. A record has a validated header, a bounded payload span, and zero-only payload padding. This applies to ordinary members and PAX or GNU extension records. Ordinary file data passes through the existing bounded content reader by its declared byte span. No member is extracted.

The accepted header layouts are V7 with an all-zero extension region, POSIX ustar, and GNU headers with only the supported timestamp fields in their extension region. Header checksums, numeric field syntax, string padding, and unused header bytes are validated. Sparse headers, unknown layouts, special member types, and payloads on directories or links return an error. Regular files, contiguous files, directories, symlinks, and hard links retain their name or content checks.

PAX records must consume their complete declared payload with valid length framing. Supported keys are `path`, `linkpath`, `size`, `uid`, `gid`, `uname`, `gname`, `mtime`, `atime`, `ctime`, `hdrcharset`, and `comment`. Local and global overrides determine the next physical payload span, including a PAX size that replaces the ordinary header size. GNU long-name and long-link records require a NUL terminator followed only by zero bytes. Unknown PAX keys, sparse metadata, conflicting local overrides, ambiguous extension order, and dangling local extensions return an error.

Every physical record and PAX attribute consumes the shared entry budget. Extension payloads stay within the input byte bound. The reader requires two zero end records, an aligned zero-only trailer, and complete coverage of the input. Nonzero payload padding, missing end records, partial trailing blocks, and nonzero trailers return an error.

The same reader handles source files, nested members, and reachable historical blobs. A padding canary returns an error through each route. Clean V7, ustar, GNU long-name and long-link combinations, PAX overrides, empty TAR, git archive TAR, git archive tar.gz, and a real npm package pass their acceptance checks.

## Existing scanner contract

The scanner performs Unicode case-folded literal matching over names and incremental UTF-8 content. Invalid UTF-8 bytes are preserved with `surrogateescape`. It also checks directory and symlink names, link targets, archive filenames, full historical paths, selected ref names, and complete commit and annotated-tag payloads. A complete scan with findings returns exit 1. A complete scan without findings returns exit 0. Unreadable inputs, unsupported advertised archives, unsupported recognized signatures, and exceeded bounds return exit 2.

ZIP validation still accounts for local records, the central directory, end records, and the declared comment. Prefixes, trailers, gaps, overlapping records, conflicting sizes, and incorrect checksums return an error. Canonical single-volume ZIP64, forced ZIP64 local sizes, streamed data descriptors, and the supported stored, deflate, bzip2, and LZMA methods retain their tests. Compressed members must finish and consume their complete declared compressed region.

Same-format concatenated gzip, bzip2, and xz streams are decoded and scanned together. Mixed formats, truncation, and nonpadding trailers return an error. Accepted wrapper padding remains gzip zero padding and xz zero padding in multiples of four bytes. The existing bounded decompression and decoder-memory checks remain in use.

| Bound | Default | CLI override |
| --- | --- | --- |
| Nested archive layers | 8 | `--max-depth` |
| Bytes in one input or decoded member | 268435456 | `--max-input-bytes` |
| Total bytes read across inputs and archive layers | 1073741824 | `--max-total-bytes` |
| Input entries, including physical records, metadata attributes, and compressed streams | 100000 | `--max-entries` |

Decoded output is limited before each write, with at most 1 MiB returned by a decoder call. Temporary data spills to disk after 8 MiB. Findings contain an input SHA-256 and a rule index. Errors remain generic JSON without input values, paths, or Git stderr.

Real `.git` and `node_modules` directories remain the only tree exclusions. Ignored and untracked files are included. Symlink targets are not followed. History scans use all refs and HEAD by default, support explicit roots, and disable replacement and graft views. Shallow history returns an error.

## Fresh verification

The focused command passed all 51 tests with no failures or errors.

```sh
python3 -B -m unittest discover -s scripts -p test_public_privacy.py -q
```

The suite preserves the previous 41 tests. New cases check ordinary member padding, PAX and GNU extension padding, malformed metadata, unsupported header layouts, nonzero unused header bytes, complete end records, aligned trailers, dangling and conflicting extensions, physical-record limits, valid controls, and tree, nested-member, and historical-blob coverage. Existing tests continue to check Unicode folding, chunk boundaries, symlinks, full Git names and messages, ref selection, corrupt archives, wrapper consumption, resource bounds, and redacted results.

A fresh working-tree scan with the external private policy returned `passed`, with 2039 checked inputs, no findings, and empty stderr. The tree was under parallel revision. This count does not identify a frozen release tree.

A temporary package generated by `npm pack --ignore-scripts` passed the repaired scanner with the external private policy. It checked 149 inputs, found no findings, and produced empty stderr. Its SHA-256 was `e870a075884ce4c4b3be62c8185654dec1f3615286954da1ab2a6b6971433daf`. The package was removed after the check. This establishes npm TAR compatibility for that working snapshot, not final package approval.

The Model the Domain principle shaped the physical record cursor and bounded global and pending metadata maps. The Fix Root Causes principle changed the repair from a member-padding check to complete supported-record coverage. The Prove It Works principle required the independent CLI reproductions, synthetic git archive controls, external-policy tree scan, and real npm package check.

## Remaining review boundaries

The scanner is a bounded literal UTF-8 and name matcher with supported archive traversal. It does not detect every opaque encoding, arbitrary embedded compressed payload, semantic disclosure, or steganographic channel. Unicode normalization, UTF-16 and other text encodings, OCR, media interpretation, and credential classification remain outside its contract. Unknown proprietary formats cannot all be identified by a signature list. Reflogs, unreachable Git objects, and external submodule contents remain outside the history scan.

The existing development Git history is intentionally excluded from the planned public release. This repair did not rescan or approve that history. The final public tree, intended public refs, source archive, and exact package still require checks after the candidate is frozen. Contextual review, media provenance review, and credential review remain mandatory release checks. No commit, push, or publication was performed by this repair.
