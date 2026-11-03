#!/usr/bin/env python3
"""Behavioral canaries for the public privacy scanner. All inputs are synthetic."""
import bz2
import gzip
import io
import json
import lzma
import os
from pathlib import Path
import subprocess
import struct
import sys
import tarfile
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).with_name('check-public-privacy.py')
CANARY = 'synthetic-secret-canary'
CHUNK_BYTES = 1024 * 1024


def tar_bytes(name, data):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        member = tarfile.TarInfo(name)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def zip_bytes(name, data):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, data)
    return output.getvalue()


def tar_record(name, data=b'', kind=tarfile.REGTYPE, format=tarfile.USTAR_FORMAT):
    member = tarfile.TarInfo(name)
    member.type = kind
    member.size = len(data)
    return member.tobuf(format=format) + data + b'\x00' * (-len(data) % 512)


def pax_record(key, value):
    body = (' ' + key + '=' + value + '\n').encode()
    size = len(body) + 1
    while len(str(size)) + len(body) != size:
        size = len(str(size)) + len(body)
    return str(size).encode() + body


class PrivacyScannerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='public-privacy-canary-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.tree = self.base / 'tree'
        self.tree.mkdir()
        self.deny = self.base / 'rules.json'
        self.deny.write_text(json.dumps([CANARY]))

    def scan(self, *args, terms=None, status='failed'):
        if terms is not None:
            self.deny.write_text(json.dumps(terms))
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--deny-file', str(self.deny), *map(str, args)],
            capture_output=True, text=True, timeout=30,
        )
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, {'passed': 0, 'failed': 1, 'error': 2}[status], report)
        self.assertEqual(report['status'], status)
        for term in terms or [CANARY]:
            self.assertNotIn(term, result.stdout + result.stderr)
        self.assertNotIn(str(self.base), result.stdout + result.stderr)
        self.assertEqual(result.stderr, '')
        if status == 'failed':
            self.assertTrue(report['findings'])
            for finding in report['findings']:
                self.assertRegex(finding['inputSha256'], r'^[0-9a-f]{64}$')
                self.assertIsInstance(finding['ruleIndex'], int)
        return report

    def git(self, *args, input=None):
        return subprocess.run(
            ['git', '-C', str(self.tree), *args], input=input,
            capture_output=True, check=True,
        ).stdout

    def repository(self):
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic Tester')
        self.git('config', 'user.email', 'synthetic@example.invalid')

    def commit(self, message='Synthetic snapshot'):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)

    def test_ignored_source_files_are_scanned_and_dependencies_are_excluded(self):
        (self.tree / '.gitignore').write_text('ignored.txt\n')
        (self.tree / 'ignored.txt').write_text(CANARY)
        dependencies = self.tree / 'node_modules'
        dependencies.mkdir()
        (dependencies / 'payload').write_text(CANARY)
        self.scan('--tree', self.tree)
        (self.tree / 'ignored.txt').unlink()
        self.scan('--tree', self.tree, status='passed')

    def test_directory_symlink_names_and_targets_are_scanned(self):
        target = self.base / 'outside'
        target.mkdir()
        (self.tree / CANARY).symlink_to(target, target_is_directory=True)
        self.scan('--tree', self.tree)
        (self.tree / CANARY).unlink()
        private_target = self.base / CANARY
        target.rename(private_target)
        (self.tree / 'link').symlink_to(private_target, target_is_directory=True)
        self.scan('--tree', self.tree)

    def test_symlinks_are_not_followed(self):
        target = self.base / 'outside'
        target.mkdir()
        (target / 'payload').write_text(CANARY)
        (self.tree / 'link').symlink_to(target, target_is_directory=True)
        (self.tree / 'file-link').symlink_to(target / 'payload')
        self.scan('--tree', self.tree, status='passed')

    def test_plain_directory_names_are_scanned(self):
        (self.tree / CANARY).mkdir()
        self.scan('--tree', self.tree)

    def test_nested_archives_are_detected_without_filename_extensions(self):
        nested = gzip.compress(tar_bytes('clean.txt', CANARY.encode()))
        path = self.base / 'release.data'
        path.write_bytes(zip_bytes('payload.data', nested))
        self.scan('--archive', path)

    def test_archive_input_filename_is_scanned_without_reporting_it(self):
        path = self.base / (CANARY + '.zip')
        path.write_bytes(zip_bytes('clean', b'clean'))
        self.scan('--archive', path)

    def test_compression_wrappers_are_detected_from_content(self):
        for compressor in [gzip.compress, bz2.compress, lzma.compress]:
            with self.subTest(compressor=compressor.__module__):
                path = self.base / 'release.data'
                path.write_bytes(compressor(CANARY.encode()))
                self.scan('--archive', path)

    def test_clean_supported_archives_pass(self):
        for payload in [
            tar_bytes('clean', b'clean'), zip_bytes('clean', b'clean'),
            zip_bytes('nested.data', gzip.compress(tar_bytes('clean', b'clean'))),
            tar_bytes('nested.data', zip_bytes('clean', b'clean')),
            gzip.compress(tar_bytes('package/nested.zip', zip_bytes('clean', b'clean'))),
            bz2.compress(b'clean'), lzma.compress(b'clean'),
        ]:
            with self.subTest(prefix=payload[:4]):
                path = self.base / 'release.data'
                path.write_bytes(payload)
                self.scan('--archive', path, status='passed')

    def test_concatenated_zip_and_mixed_compressed_streams_fail_closed(self):
        path = self.base / 'release.data'
        for payload in [
            zip_bytes('hidden', CANARY.encode()) + zip_bytes('clean', b'clean'),
            bz2.compress(b'clean') + gzip.compress(CANARY.encode()),
            lzma.compress(b'clean') + gzip.compress(CANARY.encode()),
        ]:
            with self.subTest(prefix=payload[:4]):
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')

    def test_zip_prefixes_trailers_and_unreferenced_records_fail_closed(self):
        path = self.base / 'release.data'
        clean = zip_bytes('clean', b'clean')
        for payload in [
            b'unparsed-prefix' + clean, clean + b'unparsed-trailer',
            b'\x00' + clean, clean + b'\x00', clean + clean,
        ]:
            with self.subTest(size=len(payload)):
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')
        payload = bytearray(clean)
        local_end = payload.index(b'PK\x01\x02')
        payload[local_end:local_end] = b'unreferenced-gap'
        end = payload.index(b'PK\x05\x06')
        struct.pack_into('<I', payload, end + 16, local_end + len(b'unreferenced-gap'))
        path.write_bytes(payload)
        self.scan('--archive', path, status='error')

    def test_zip_overlapping_records_and_member_trailers_fail_closed(self):
        path = self.base / 'release.data'
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('one', b'clean')
            archive.writestr('two', b'clean')
        payload = bytearray(output.getvalue())
        first = payload.index(b'PK\x01\x02')
        second = payload.index(b'PK\x01\x02', first + 4)
        struct.pack_into('<I', payload, second + 42, 0)
        path.write_bytes(payload)
        self.scan('--archive', path, status='error')
        payload = bytearray(zip_bytes('clean', b'clean'))
        central = payload.index(b'PK\x01\x02')
        compressed_size = struct.unpack_from('<I', payload, 18)[0]
        hidden = gzip.compress(CANARY.encode())
        payload[central:central] = hidden
        struct.pack_into('<I', payload, 18, compressed_size + len(hidden))
        struct.pack_into('<I', payload, central + len(hidden) + 20, compressed_size + len(hidden))
        end = payload.index(b'PK\x05\x06')
        struct.pack_into('<I', payload, end + 16, central + len(hidden))
        path.write_bytes(payload)
        self.scan('--archive', path, status='error')

    def test_compression_trailers_mixed_streams_and_truncation_fail_closed(self):
        path = self.base / 'release.data'
        compressors = [gzip.compress, bz2.compress, lzma.compress]
        for compressor in compressors:
            clean = compressor(b'clean')
            cases = [clean + b'unparsed-trailer', clean[:-1], b'prefix' + clean]
            cases.extend(clean + other(CANARY.encode()) for other in compressors if other != compressor)
            if compressor == bz2.compress:
                cases.append(clean + b'\x00')
            if compressor == lzma.compress:
                cases.append(clean + b'\x00')
            for payload in cases:
                with self.subTest(compressor=compressor.__module__, size=len(payload)):
                    path.write_bytes(payload)
                    self.scan('--archive', path, status='error')

    def test_same_format_compressed_members_and_allowed_padding_are_consumed(self):
        path = self.base / 'release.data'
        for compressor in [gzip.compress, bz2.compress, lzma.compress]:
            with self.subTest(compressor=compressor.__module__):
                path.write_bytes(compressor(b'clean') + compressor(CANARY.encode()))
                self.scan('--archive', path)
                path.write_bytes(compressor(b'') + compressor(b'clean'))
                self.scan('--archive', path, status='passed')
        for compressor, padding in [(gzip.compress, b'\x00'), (lzma.compress, b'\x00' * 4)]:
            with self.subTest(padding=len(padding)):
                path.write_bytes(compressor(b'clean') + padding + compressor(CANARY.encode()) + padding)
                self.scan('--archive', path)
                path.write_bytes(compressor(b'clean') + padding)
                self.scan('--archive', path, status='passed')

    def test_empty_zip_comments_and_supported_zip_methods_pass(self):
        path = self.base / 'release.data'
        for method in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA]:
            with self.subTest(method=method):
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w', compression=method) as archive:
                    archive.comment = b'ordinary comment'
                    archive.writestr('clean', b'clean')
                path.write_bytes(output.getvalue())
                self.scan('--archive', path, status='passed')
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w', compression=method) as archive:
                    archive.writestr('clean', CANARY.encode())
                path.write_bytes(output.getvalue())
                self.scan('--archive', path)
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w'):
            pass
        path.write_bytes(output.getvalue())
        self.scan('--archive', path, status='passed')

    def test_zip64_end_records_and_malformed_directory_counts(self):
        path = self.base / 'release.data'
        payload = zip_bytes('clean', b'clean')
        end = payload.index(b'PK\x05\x06')
        count = struct.unpack_from('<H', payload, end + 10)[0]
        directory_size, directory_offset = struct.unpack_from('<2I', payload, end + 12)
        zip64 = struct.pack('<4sQ2H2I4Q', b'PK\x06\x06', 44, 45, 45, 0, 0, count, count, directory_size, directory_offset)
        locator = struct.pack('<4sIQI', b'PK\x06\x07', 0, end, 1)
        ending = struct.pack('<4s4H2IH', b'PK\x05\x06', 0, 0, 65535, 65535, 0xffffffff, 0xffffffff, 0)
        canonical = payload[:end] + zip64 + locator + ending
        path.write_bytes(canonical)
        self.scan('--archive', path, status='passed')
        for location, value in [(end + 4, 43), (end + len(zip64) + 8, end + 1)]:
            malformed = bytearray(canonical)
            struct.pack_into('<Q', malformed, location, value)
            path.write_bytes(malformed)
            self.scan('--archive', path, status='error')
        for count in [0, 2]:
            malformed = bytearray(payload)
            struct.pack_into('<2H', malformed, end + 8, count, count)
            path.write_bytes(malformed)
            self.scan('--archive', path, status='error')

    def test_zip_member_checksums_sizes_and_decoded_limits_fail_closed(self):
        path = self.base / 'release.data'
        for method in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA]:
            with self.subTest(method=method):
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w', compression=method) as archive:
                    archive.writestr('clean', b'clean')
                payload = bytearray(output.getvalue())
                central = payload.index(b'PK\x01\x02')
                for local, directory in [(14, central + 16), (22, central + 24)]:
                    malformed = bytearray(payload)
                    struct.pack_into('<I', malformed, local, 1234)
                    struct.pack_into('<I', malformed, directory, 1234)
                    path.write_bytes(malformed)
                    self.scan('--archive', path, status='error')
                if method != zipfile.ZIP_STORED:
                    output = io.BytesIO()
                    with zipfile.ZipFile(output, 'w', compression=method) as archive:
                        archive.writestr('clean', b'x' * (4 * CHUNK_BYTES))
                    path.write_bytes(output.getvalue())
                    self.scan('--archive', path, '--max-input-bytes', CHUNK_BYTES, status='error')
                    self.scan('--archive', path, '--max-total-bytes', CHUNK_BYTES, status='error')

    def test_compressed_stream_count_limit_and_chunk_boundaries(self):
        path = self.base / 'release.data'
        for compressor in [gzip.compress, bz2.compress, lzma.compress]:
            with self.subTest(compressor=compressor.__module__):
                path.write_bytes(compressor(b'') * 4)
                self.scan('--archive', path, '--max-entries', 3, status='error')
                data = b'x' * (CHUNK_BYTES - 2) + CANARY.encode() + b'x' * CHUNK_BYTES
                path.write_bytes(compressor(data))
                self.scan('--archive', path)

    def test_streaming_zip_descriptors_and_forced_zip64_pass(self):
        class NonSeekable(io.BytesIO):
            def seekable(self):
                return False

            def seek(self, *args):
                raise io.UnsupportedOperation('synthetic nonseekable output')

        path = self.base / 'release.data'
        for streaming in [False, True]:
            for zip64 in [False, True]:
                with self.subTest(streaming=streaming, zip64=zip64):
                    output = NonSeekable() if streaming else io.BytesIO()
                    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                        with archive.open('clean', 'w', force_zip64=zip64) as member:
                            member.write(b'clean')
                    path.write_bytes(output.getvalue())
                    self.scan('--archive', path, status='passed')

    def test_ambiguous_archives_in_tree_nested_members_and_history_fail_closed(self):
        ambiguous = bz2.compress(b'clean') + gzip.compress(CANARY.encode())
        (self.tree / 'payload.data').write_bytes(ambiguous)
        self.scan('--tree', self.tree, status='error')
        path = self.base / 'release.data'
        path.write_bytes(zip_bytes('nested.data', ambiguous))
        self.scan('--archive', path, status='error')
        self.repository()
        self.commit()
        (self.tree / 'payload.data').unlink()
        self.commit()
        self.scan('--history', self.tree, status='error')

    def test_compressed_output_limits_fail_closed(self):
        path = self.base / 'release.data'
        for compressor in [gzip.compress, bz2.compress, lzma.compress]:
            with self.subTest(compressor=compressor.__module__):
                path.write_bytes(compressor(b'x' * (4 * CHUNK_BYTES)))
                self.scan('--archive', path, '--max-input-bytes', CHUNK_BYTES, status='error')
                self.scan('--archive', path, '--max-total-bytes', CHUNK_BYTES, status='error')

    def test_archive_names_links_and_traversal_names_are_scanned_without_extraction(self):
        path = self.base / 'release.data'
        path.write_bytes(zip_bytes('../' + CANARY, b'clean'))
        self.scan('--archive', path)
        self.assertFalse((self.base / CANARY).exists())
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            member = tarfile.TarInfo('link')
            member.type = tarfile.SYMTYPE
            member.linkname = '/' + CANARY
            archive.addfile(member)
        path.write_bytes(output.getvalue())
        self.scan('--archive', path)

    def test_archives_in_reachable_history_are_inspected(self):
        self.repository()
        (self.tree / 'payload.data').write_bytes(gzip.compress(tar_bytes('clean', CANARY.encode())))
        self.commit()
        (self.tree / 'payload.data').unlink()
        self.commit()
        self.scan('--history', self.tree)

    def test_duplicate_blob_names_and_historical_renames_are_scanned(self):
        self.repository()
        (self.tree / 'a-clean').write_text('identical content')
        (self.tree / ('z-' + CANARY)).write_text('identical content')
        self.commit()
        (self.tree / ('z-' + CANARY)).rename(self.tree / 'renamed-clean')
        self.commit()
        self.scan('--history', self.tree)

    def test_full_historical_paths_are_scanned(self):
        self.repository()
        folder = self.tree / 'synthetic-parent'
        folder.mkdir()
        (folder / 'synthetic-child').write_text('clean')
        self.commit()
        self.scan('--history', self.tree, terms=['synthetic-parent/synthetic-child'])

    def test_git_commit_tag_messages_and_ref_names_are_scanned(self):
        self.repository()
        (self.tree / 'clean').write_text('clean')
        self.commit()
        with self.subTest(location='branch name'):
            self.git('branch', CANARY)
            self.scan('--history', self.tree)
            self.git('branch', '-D', CANARY)
        with self.subTest(location='annotated tag message'):
            self.git('tag', '-a', 'synthetic-tag', '-m', CANARY)
            self.scan('--history', self.tree)
            self.git('tag', '-d', 'synthetic-tag')
        with self.subTest(location='commit message'):
            self.git('commit', '--allow-empty', '-q', '-m', CANARY)
            self.scan('--history', self.tree)

    def test_utf8_case_folding_expansion_and_chunk_boundaries(self):
        for term, content in [('éclair', 'ÉCLAIR'), ('strasse', 'STRAẞE'), ('straße', 'STRASSE'), ('synthetic-term', 'SYNTHETIC-TERM')]:
            with self.subTest(term=term):
                data = content.encode()
                (self.tree / 'payload').write_bytes(b'\xff' + b'x' * (CHUNK_BYTES - 2) + data + b'\xfe')
                self.scan('--tree', self.tree, terms=[term])

    def test_unicode_names_use_the_same_case_folding(self):
        (self.tree / 'STRAẞE').mkdir()
        self.scan('--tree', self.tree, terms=['strasse'])

    def test_archive_depth_size_member_and_total_limits_fail_closed(self):
        path = self.base / 'release.data'
        path.write_bytes(zip_bytes('payload.data', gzip.compress(b'clean')))
        self.scan('--archive', path, '--max-depth', 0, status='error')
        self.scan('--archive', path, '--max-input-bytes', 4, status='error')
        path.write_bytes(zip_bytes('payload.data', b'x' * 4096))
        self.scan('--archive', path, '--max-input-bytes', 1024, status='error')
        self.scan('--archive', path, '--max-total-bytes', 1024, status='error')
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('one', b'clean')
            archive.writestr('two', b'clean')
        path.write_bytes(output.getvalue())
        self.scan('--archive', path, '--max-entries', 1, status='error')

    def test_unreadable_corrupt_and_unsupported_inputs_fail_closed(self):
        self.scan('--tree', self.base / 'absent', status='error')
        self.scan('--archive', self.base / 'absent', status='error')
        self.scan('--history', self.base, status='error')
        for payload in [b'PK\x03\x04broken', b'\x1f\x8bbroken', b'7z\xbc\xaf\x27\x1ccompressed-data', b'Rar!\x1a\x07\x00data']:
            with self.subTest(payload=payload[:4]):
                path = self.base / 'release.data'
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')
        path.write_bytes(b'plain bytes')
        self.scan('--archive', path, status='error')

    def test_nested_unsupported_and_advertised_archives_fail_closed(self):
        path = self.base / 'release.data'
        path.write_bytes(zip_bytes('renamed.data', b'7z\xbc\xaf\x27\x1ccompressed-data'))
        self.scan('--archive', path, status='error')
        path.write_bytes(zip_bytes('advertised.rar', b'opaque-data'))
        self.scan('--archive', path, status='error')

    def test_tar_corruption_special_members_and_trailing_data_fail_closed(self):
        path = self.base / 'release.data'
        payload = bytearray(tar_bytes('clean', b'clean'))
        payload[148] = 0
        path.write_bytes(payload)
        self.scan('--archive', path, status='error')
        path.write_bytes(tar_bytes('clean', b'clean') + b'unparsed-trailing-data')
        self.scan('--archive', path, status='error')
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            member = tarfile.TarInfo('pipe')
            member.type = tarfile.FIFOTYPE
            archive.addfile(member)
        path.write_bytes(output.getvalue())
        self.scan('--archive', path, status='error')

    def test_tar_member_payload_padding_must_be_zero(self):
        path = self.base / 'release.data'
        for size in [1, 511, 513]:
            with self.subTest(size=size):
                payload = bytearray(tar_record('clean', b'x' * size) + b'\x00' * 1024)
                hidden = gzip.compress(CANARY.encode()) if size != 511 else b'x'
                payload[512 + size:512 + size + len(hidden)] = hidden
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')

    def test_tar_extension_payload_padding_must_be_zero(self):
        path = self.base / 'release.data'
        for kind, data, format in [
            (tarfile.XHDTYPE, pax_record('path', 'clean'), tarfile.PAX_FORMAT),
            (tarfile.XGLTYPE, pax_record('comment', 'ordinary comment'), tarfile.PAX_FORMAT),
            (tarfile.GNUTYPE_LONGNAME, b'clean\x00', tarfile.GNU_FORMAT),
            (tarfile.GNUTYPE_LONGLINK, b'target\x00', tarfile.GNU_FORMAT),
        ]:
            with self.subTest(kind=kind):
                payload = bytearray(tar_record('extension', data, kind, format) + tar_record('clean', b'x') + b'\x00' * 1024)
                hidden = gzip.compress(CANARY.encode())
                payload[512 + len(data):512 + len(data) + len(hidden)] = hidden
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')

    def test_tar_extension_framing_and_unknown_layouts_fail_closed(self):
        path = self.base / 'release.data'
        for kind, data, format in [
            (tarfile.XHDTYPE, pax_record('path', 'clean') + gzip.compress(CANARY.encode()), tarfile.PAX_FORMAT),
            (tarfile.XHDTYPE, b'999 path=clean\n', tarfile.PAX_FORMAT),
            (tarfile.XHDTYPE, pax_record('size', '-1'), tarfile.PAX_FORMAT),
            (tarfile.XHDTYPE, pax_record('GNU.sparse.map', '0,1'), tarfile.PAX_FORMAT),
            (tarfile.XHDTYPE, pax_record('unknown-layout', 'clean'), tarfile.PAX_FORMAT),
            (tarfile.GNUTYPE_LONGNAME, b'clean\x00' + gzip.compress(CANARY.encode()), tarfile.GNU_FORMAT),
            (tarfile.GNUTYPE_LONGNAME, b'clean', tarfile.GNU_FORMAT),
        ]:
            with self.subTest(kind=kind, prefix=data[:20]):
                path.write_bytes(tar_record('extension', data, kind, format) + tar_record('clean', b'x') + b'\x00' * 1024)
                self.scan('--archive', path, status='error')
        for format, offset in [(tarfile.USTAR_FORMAT, 500), (tarfile.USTAR_FORMAT, 90), (tarfile.USTAR_FORMAT, 257), (tarfile.USTAR_FORMAT, 134), (tarfile.GNU_FORMAT, 400)]:
            with self.subTest(format=format, offset=offset):
                payload = bytearray(tar_record('clean', b'x', format=format) + b'\x00' * 1024)
                payload[offset] = ord('x')
                payload[148:156] = b'        '
                payload[148:156] = ('%06o\x00 ' % sum(payload[:512])).encode()
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')

    def test_dangling_and_conflicting_tar_extensions_fail_closed(self):
        path = self.base / 'release.data'
        local = tar_record('pax', pax_record('size', '1'), tarfile.XHDTYPE)
        global_record = tar_record('global', pax_record('comment', 'ordinary'), tarfile.XGLTYPE)
        for records in [
            tar_record('pax', b'', tarfile.XHDTYPE), local,
            local + local + tar_record('clean', b'x'),
            local + global_record + tar_record('clean', b'x'),
            tar_record('long', b'clean\x00', tarfile.GNUTYPE_LONGNAME, tarfile.GNU_FORMAT) * 2 + tar_record('clean', b'x'),
        ]:
            with self.subTest(size=len(records)):
                path.write_bytes(records + b'\x00' * 1024)
                self.scan('--archive', path, status='error')

    def test_tar_requires_complete_zero_end_records_and_aligned_trailer(self):
        path = self.base / 'release.data'
        record = tar_record('clean', b'x')
        for payload in [record, record + b'\x00' * 512, record + b'\x00' * 1025, record + b'\x00' * 512 + record, b'\x00' * 512]:
            with self.subTest(size=len(payload)):
                path.write_bytes(payload)
                self.scan('--archive', path, status='error')

    def test_canonical_tar_layouts_extensions_and_pax_size_override_pass(self):
        path = self.base / 'release.data'
        controls = [b'\x00' * 1024]
        for format in [tarfile.USTAR_FORMAT, tarfile.GNU_FORMAT, tarfile.PAX_FORMAT]:
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w', format=format) as archive:
                member = tarfile.TarInfo('clean' if format == tarfile.USTAR_FORMAT else 'directory/' * 20 + 'clean')
                member.size = 1
                archive.addfile(member, io.BytesIO(b'x'))
                link = tarfile.TarInfo('link' if format == tarfile.USTAR_FORMAT else 'links/' * 25 + 'link')
                link.type = tarfile.SYMTYPE
                link.linkname = 'target' if format == tarfile.USTAR_FORMAT else 'target/' * 30
                archive.addfile(link)
            controls.append(output.getvalue())
        controls.append(tar_record('global', pax_record('comment', 'ordinary comment'), tarfile.XGLTYPE) + tar_record('clean', b'x') + b'\x00' * 1024)
        controls.append(tar_record('pax', pax_record('size', '1'), tarfile.XHDTYPE) + tar_record('clean') + b'x' + b'\x00' * (511 + 1024))
        for payload in controls:
            with self.subTest(size=len(payload), prefix=payload[:20]):
                path.write_bytes(payload)
                self.scan('--archive', path, status='passed')
        data = CANARY.encode()
        path.write_bytes(tar_record('pax', pax_record('size', str(len(data))), tarfile.XHDTYPE) + tar_record('clean') + data + b'\x00' * (-len(data) % 512 + 1024))
        self.scan('--archive', path)

    def test_v7_tar_headers_have_no_unparsed_extension_region(self):
        path = self.base / 'release.data'
        payload = bytearray(tar_record('clean', b'x') + b'\x00' * 1024)
        payload[257:512] = b'\x00' * 255
        payload[148:156] = b'        '
        payload[148:156] = ('%06o\x00 ' % sum(payload[:512])).encode()
        path.write_bytes(payload)
        self.scan('--archive', path, status='passed')
        payload[300] = ord('x')
        payload[148:156] = b'        '
        payload[148:156] = ('%06o\x00 ' % sum(payload[:512])).encode()
        path.write_bytes(payload)
        self.scan('--archive', path, status='error')

    def test_tar_physical_extensions_consume_the_entry_budget(self):
        path = self.base / 'release.data'
        path.write_bytes(tar_record('global', pax_record('comment', 'ordinary'), tarfile.XGLTYPE) * 4 + tar_record('clean', b'x') + b'\x00' * 1024)
        self.scan('--archive', path, '--max-entries', 3, status='error')

    def test_git_archive_tar_and_pax_controls_pass(self):
        self.repository()
        folder = self.tree / ('nested-' * 20)
        folder.mkdir()
        (folder / 'clean').write_text('ordinary contents')
        self.commit()
        path = self.base / 'release.data'
        path.write_bytes(self.git('archive', '--format=tar', 'HEAD'))
        self.scan('--archive', path, status='passed')
        path.write_bytes(self.git('archive', '--format=tar.gz', 'HEAD'))
        self.scan('--archive', path, status='passed')

    def test_tar_padding_validation_is_shared_by_tree_nested_and_history_inputs(self):
        payload = bytearray(tar_record('clean', b'x') + b'\x00' * 1024)
        hidden = gzip.compress(CANARY.encode())
        payload[513:513 + len(hidden)] = hidden
        (self.tree / 'payload.data').write_bytes(payload)
        self.scan('--tree', self.tree, status='error')
        path = self.base / 'release.data'
        path.write_bytes(zip_bytes('nested.data', gzip.compress(payload)))
        self.scan('--archive', path, status='error')
        self.repository()
        self.commit()
        (self.tree / 'payload.data').unlink()
        self.commit()
        self.scan('--history', self.tree, status='error')

    def test_git_paths_with_tabs_and_newlines_are_not_split_into_records(self):
        self.repository()
        (self.tree / ('clean\t' + CANARY + '\nname')).write_text('clean')
        self.commit()
        self.scan('--history', self.tree)

    def test_historical_directory_names_and_direct_tree_refs_are_scanned(self):
        self.repository()
        directory = self.tree / CANARY
        directory.mkdir()
        (directory / 'clean').write_text('clean')
        self.commit()
        tree = self.git('rev-parse', 'HEAD^{tree}').strip().decode()
        self.git('update-ref', 'refs/tags/synthetic-tree', tree)
        self.scan('--history', self.tree, '--ref', 'refs/tags/synthetic-tree')

    def test_history_blob_refs_and_annotated_tree_tags_are_scanned(self):
        self.repository()
        (self.tree / 'clean').write_text('clean')
        self.commit()
        blob = self.git('hash-object', '-w', '--stdin', input=CANARY.encode()).strip().decode()
        self.git('update-ref', 'refs/tags/synthetic-blob', blob)
        self.scan('--history', self.tree)
        self.git('tag', '-a', 'synthetic-tree', 'HEAD^{tree}', '-m', CANARY)
        self.scan('--history', self.tree, '--ref', 'refs/tags/synthetic-tree')

    def test_source_archive_names_and_unreadable_directory_are_not_omitted(self):
        (self.tree / 'broken.rar').write_bytes(b'opaque bytes')
        self.scan('--tree', self.tree, status='error')
        (self.tree / 'broken.rar').unlink()
        locked = self.tree / 'unreadable'
        locked.mkdir()
        (locked / 'payload').write_text('clean')
        locked.chmod(0)
        try:
            if os.geteuid() != 0:
                self.scan('--tree', self.tree, status='error')
        finally:
            locked.chmod(0o700)

    def test_unreadable_archive_members_and_bad_historical_archives_fail_closed(self):
        path = self.base / 'release.data'
        payload = bytearray(zip_bytes('clean', b'clean'))
        position = payload.index(b'PK\x01\x02')
        payload[position + 10:position + 12] = (99).to_bytes(2, 'little')
        payload[8:10] = (99).to_bytes(2, 'little')
        path.write_bytes(payload)
        self.scan('--archive', path, status='error')
        self.repository()
        (self.tree / 'advertised.rar').write_bytes(b'opaque bytes')
        self.commit()
        self.scan('--history', self.tree, status='error')

    def test_explicit_history_ref_does_not_scan_other_refs(self):
        self.repository()
        (self.tree / 'clean').write_text('clean')
        self.commit()
        clean = self.git('rev-parse', 'HEAD').strip().decode()
        (self.tree / 'payload').write_text(CANARY)
        self.commit()
        self.scan('--history', self.tree, '--ref', clean, status='passed')
        self.scan('--history', self.tree)

    def test_git_replace_cannot_hide_original_contents(self):
        self.repository()
        (self.tree / 'payload').write_text(CANARY)
        self.commit()
        original = self.git('rev-parse', 'HEAD:payload').strip().decode()
        replacement = self.git('hash-object', '-w', '--stdin', input=b'clean').strip().decode()
        self.git('replace', original, replacement)
        self.scan('--history', self.tree)

    def test_incomplete_git_history_fails_closed(self):
        self.repository()
        (self.tree / 'clean').write_text('clean')
        self.commit()
        (self.tree / '.git' / 'shallow').write_bytes(self.git('rev-parse', 'HEAD'))
        self.scan('--history', self.tree, status='error')

    def test_invalid_arguments_and_deny_files_fail_without_values(self):
        self.scan('--tree', self.tree, '--unknown-' + CANARY, status='error')
        self.scan('--tree', self.tree, '--max-depth', -1, status='error')
        self.deny.write_text('{"' + CANARY + '":')
        self.scan('--tree', self.tree, status='error')
        self.deny.write_text(json.dumps([CANARY]))
        self.deny.rename(self.tree / 'rules.json')
        self.deny = self.tree / 'rules.json'
        self.scan('--tree', self.tree, status='error')

    def test_git_failures_do_not_print_private_paths_or_refs(self):
        self.repository()
        self.scan('--history', self.tree, '--ref', CANARY, status='error')


if __name__ == '__main__':
    unittest.main()
