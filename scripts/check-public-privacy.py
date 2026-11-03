#!/usr/bin/env python3
"""Scan release inputs with private patterns supplied from outside the repository."""
import argparse
import bz2
import codecs
from dataclasses import dataclass
import hashlib
import json
import lzma
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import zlib


CHUNK_BYTES = 1024 * 1024
ARCHIVE_SUFFIXES = (
    '.tar', '.tgz', '.tar.gz', '.tbz', '.tbz2', '.txz', '.zip', '.gz', '.bz2',
    '.xz', '.svgz', '.jar', '.war', '.apk', '.docx', '.xlsx', '.pptx', '.epub',
    '.7z', '.rar', '.zst', '.zstd', '.lz4', '.br', '.cab', '.ar', '.a', '.deb',
    '.rpm', '.iso', '.dmg', '.wim', '.z', '.lz', '.lzo',
)
UNSUPPORTED_MAGIC = (
    b'7z\xbc\xaf\x27\x1c', b'Rar!\x1a\x07', b'\x28\xb5\x2f\xfd',
    b'\x04\x22\x4d\x18', b'MSCF', b'!<arch>\n', b'\x1f\x9d', b'LZIP',
    b'\x89LZO\x00\x0d\x0a\x1a\x0a', b'MSWIM\x00\x00\x00', b'\xed\xab\xee\xdb',
)


@dataclass(frozen=True)
class Limits:
    max_depth: int = 8
    max_input_bytes: int = 256 * 1024 * 1024
    max_total_bytes: int = 1024 * 1024 * 1024
    max_entries: int = 100000


def identity(value):
    return hashlib.sha256(value.encode('utf-8', 'surrogateescape')).hexdigest()


def archive_expected(name):
    return name.casefold().endswith(ARCHIVE_SUFFIXES)


def tar_header(header):
    layout = header[257:265]
    strings = [(0, 100), (157, 257)]
    numbers = [(100, 108), (108, 116), (116, 124), (124, 136), (136, 148), (148, 156)]
    if layout == b'\x00' * 8:
        reserved = header[257:512]
    elif layout == b'ustar\x0000':
        strings.append((345, 500))
        reserved = header[500:512]
    elif layout == b'ustar  \x00':
        numbers.extend([(345, 357), (357, 369)])
        reserved = header[369:512]
    else:
        raise ValueError('Unsupported tar header layout.')
    if layout != b'\x00' * 8:
        strings.extend([(265, 297), (297, 329)])
        numbers.extend([(329, 337), (337, 345)])
    if reserved.strip(b'\x00'):
        raise ValueError('Unconsumed tar header bytes.')
    for start, end in strings:
        field = header[start:end]
        if b'\x00' in field and field.partition(b'\x00')[2].strip(b'\x00'):
            raise ValueError('Unconsumed tar string padding.')
    for start, end in numbers:
        field = header[start:end]
        if field[0] not in {0x80, 0xff} and any(byte not in b'01234567' for byte in field.strip(b'\x00 ')):
            raise ValueError('Unsupported tar numeric field.')
    return tarfile.TarInfo.frombuf(header, 'utf-8', 'surrogateescape')


class ArchiveSlice:
    def __init__(self, stream, offset, size, checksum=None):
        self.stream = stream
        self.remaining = size
        self.checksum = checksum
        self.crc = 0
        stream.seek(offset)

    def read(self, size):
        data = self.stream.read(min(size, self.remaining))
        self.remaining -= len(data)
        if not data and self.remaining:
            raise ValueError('Truncated ZIP member data.')
        if self.checksum is not None:
            self.crc = zlib.crc32(data, self.crc)
            if not self.remaining and self.crc != self.checksum:
                raise ValueError('ZIP member checksum mismatch.')
        return data


class Scanner:
    def __init__(self, terms, limits=Limits()):
        self.terms = [term.casefold() for term in terms]
        self.overlap = max(map(len, self.terms)) - 1
        self.limits = limits
        self.findings = set()
        self.checked = 0
        self.total_bytes = 0
        self.entries = 0

    def match(self, name, data):
        for index, term in enumerate(self.terms):
            if term in data:
                self.findings.add((identity(name), index))

    def name(self, name):
        self.entries += 1
        if self.entries > self.limits.max_entries:
            raise ValueError('Input entry limit exceeded.')
        self.checked += 1
        self.match(name, name.casefold())

    def link(self, name, target):
        self.name(name)
        self.match(name, target.casefold())

    def content(self, name, stream, depth=0, require_archive=False):
        self.name(name)
        decoder = codecs.getincrementaldecoder('utf-8')(errors='surrogateescape')
        tail = ''
        size = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * CHUNK_BYTES) as payload:
            while chunk := stream.read(min(CHUNK_BYTES, self.limits.max_input_bytes - size + 1)):
                size += len(chunk)
                self.total_bytes += len(chunk)
                if size > self.limits.max_input_bytes or self.total_bytes > self.limits.max_total_bytes:
                    raise ValueError('Input byte limit exceeded.')
                payload.write(chunk)
                data = tail + decoder.decode(chunk).casefold()
                self.match(name, data)
                tail = data[-self.overlap:] if self.overlap else ''
            self.match(name, tail + decoder.decode(b'', final=True).casefold())
            payload.seek(0)
            self.archive(name, payload, depth, require_archive)

    def decoded_content(self, name, source, depth, factory, magic=b'', padding=0, expected=None, required=False):
        available = min(self.limits.max_input_bytes, self.limits.max_total_bytes - self.total_bytes)
        size = 0
        crc = 0
        streams = 0
        pending = source.read(CHUNK_BYTES)
        with tempfile.SpooledTemporaryFile(max_size=8 * CHUNK_BYTES) as decoded:
            while pending:
                streams += 1
                self.entries += 1
                if self.entries > self.limits.max_entries:
                    raise ValueError('Compressed stream limit exceeded.')
                while len(pending) < len(magic):
                    more = source.read(CHUNK_BYTES)
                    if not more:
                        break
                    pending += more
                if not pending.startswith(magic):
                    raise ValueError('Unexpected compressed stream format.')
                decoder = factory()
                data = pending
                while True:
                    block = decoder.decompress(data, min(CHUNK_BYTES, available - size + 1))
                    size += len(block)
                    if size > available:
                        raise ValueError('Decoded byte limit exceeded.')
                    decoded.write(block)
                    crc = zlib.crc32(block, crc)
                    if decoder.eof:
                        pending = decoder.unused_data
                        break
                    if hasattr(decoder, 'needs_input'):
                        data = b''
                        needs_input = decoder.needs_input
                    else:
                        data = decoder.unconsumed_tail
                        needs_input = not data
                    if needs_input:
                        data = source.read(CHUNK_BYTES)
                        if not data:
                            raise ValueError('Truncated compressed stream.')
                if not pending:
                    pending = source.read(CHUNK_BYTES)
                if not magic:
                    if pending:
                        raise ValueError('Unconsumed compressed member data.')
                    break
                padding_size = 0
                if padding:
                    while pending:
                        trimmed = pending.lstrip(b'\x00')
                        padding_size += len(pending) - len(trimmed)
                        pending = trimmed
                        if pending:
                            break
                        pending = source.read(CHUNK_BYTES)
                    if padding_size % padding:
                        raise ValueError('Invalid compressed stream padding.')
            if not streams or expected is not None and (size, crc) != expected:
                raise ValueError('Compressed member size or checksum mismatch.')
            decoded.seek(0)
            self.content(name, decoded, depth, required)

    def zip_content(self, name, payload, depth):
        payload.seek(0, os.SEEK_END)
        size = payload.tell()
        payload.seek(max(0, size - 65557))
        tail = payload.read(65557)
        position = tail.rfind(b'PK\x05\x06')
        if position < 0 or len(tail) - position < 22:
            raise ValueError('Unreadable ZIP end record.')
        _, disk, directory_disk, disk_count, count, directory_size, directory_offset, comment_size = struct.unpack_from('<4s4H2IH', tail, position)
        if position + 22 + comment_size != len(tail) or disk or directory_disk or disk_count != count:
            raise ValueError('Noncanonical ZIP end record.')
        directory_end = size - len(tail) + position
        payload.seek(max(0, directory_end - 20))
        locator = payload.read(20)
        if locator.startswith(b'PK\x06\x07'):
            _, zip64_disk, zip64_offset, disks = struct.unpack('<4sIQI', locator)
            if zip64_disk or disks != 1 or zip64_offset >= directory_end - 20:
                raise ValueError('Unsupported ZIP volume layout.')
            payload.seek(zip64_offset)
            record = payload.read(56)
            signature, record_size, _, _, zip64_disk, zip64_directory_disk, zip64_disk_count, zip64_count, zip64_size, zip64_start = struct.unpack('<4sQ2H2I4Q', record)
            if signature != b'PK\x06\x06' or record_size < 44 or zip64_offset + 12 + record_size != directory_end - 20:
                raise ValueError('Noncanonical ZIP64 end record.')
            if zip64_disk or zip64_directory_disk or zip64_disk_count != zip64_count:
                raise ValueError('Unsupported ZIP64 volume layout.')
            for ordinary, extended, sentinel in [(count, zip64_count, 65535), (directory_size, zip64_size, 0xffffffff), (directory_offset, zip64_start, 0xffffffff)]:
                if ordinary not in {sentinel, extended}:
                    raise ValueError('Conflicting ZIP end records.')
            count, directory_size, directory_offset = zip64_count, zip64_size, zip64_start
            directory_end = zip64_offset
        elif count == 65535 or directory_size == 0xffffffff or directory_offset == 0xffffffff:
            raise ValueError('Missing ZIP64 end record.')
        if count > self.limits.max_entries - self.entries or directory_offset + directory_size != directory_end:
            raise ValueError('ZIP directory bounds or entry limit exceeded.')
        cursor = directory_offset
        raw_names = []
        for _ in range(count):
            payload.seek(cursor)
            header = payload.read(46)
            if len(header) != 46 or header[:4] != b'PK\x01\x02':
                raise ValueError('Unreadable ZIP directory entry.')
            filename_size, extra_size, member_comment_size = struct.unpack_from('<3H', header, 28)
            raw_names.append(payload.read(filename_size))
            cursor += 46 + filename_size + extra_size + member_comment_size
            if cursor > directory_end:
                raise ValueError('ZIP directory entry exceeds bounds.')
        if cursor != directory_end:
            raise ValueError('Unconsumed ZIP directory data.')
        payload.seek(0)
        with zipfile.ZipFile(payload) as archive:
            members = archive.infolist()
            if archive.start_dir != directory_offset or len(members) != count:
                raise ValueError('Conflicting ZIP directory layout.')
            records = []
            for member, raw_name in zip(members, raw_names):
                records.append((member.header_offset, member, raw_name))
            cursor = 0
            for offset, member, raw_name in sorted(records, key=lambda record: record[0]):
                if offset != cursor:
                    raise ValueError('Unconsumed or overlapping ZIP records.')
                payload.seek(offset)
                header = payload.read(30)
                if len(header) != 30 or header[:4] != b'PK\x03\x04':
                    raise ValueError('Unreadable ZIP local entry.')
                flags, method = struct.unpack_from('<2H', header, 6)
                local_crc, compressed_size, decoded_size, filename_size, extra_size = struct.unpack_from('<3I2H', header, 14)
                if flags != member.flag_bits or method != member.compress_type or flags & 1 or payload.read(filename_size) != raw_name:
                    raise ValueError('Conflicting ZIP local entry.')
                extra = payload.read(extra_size)
                zip64 = compressed_size == 0xffffffff or decoded_size == 0xffffffff
                extra_cursor = 0
                zip64_values = None
                while extra_cursor < len(extra):
                    kind, length = struct.unpack_from('<2H', extra, extra_cursor)
                    extra_cursor += 4
                    if extra_cursor + length > len(extra):
                        raise ValueError('Unreadable ZIP extra field.')
                    if kind == 1:
                        if zip64_values is not None:
                            raise ValueError('Repeated ZIP64 extra field.')
                        zip64_values = extra[extra_cursor:extra_cursor + length]
                    extra_cursor += length
                if zip64:
                    if zip64_values is None:
                        raise ValueError('Missing ZIP64 local sizes.')
                    extra_cursor = 0
                    if decoded_size == 0xffffffff:
                        decoded_size = struct.unpack_from('<Q', zip64_values, extra_cursor)[0]
                        extra_cursor += 8
                    if compressed_size == 0xffffffff:
                        compressed_size = struct.unpack_from('<Q', zip64_values, extra_cursor)[0]
                if flags & 8:
                    if local_crc not in {0, member.CRC} or compressed_size not in {0, member.compress_size} or decoded_size not in {0, member.file_size}:
                        raise ValueError('Conflicting ZIP descriptor sizes.')
                elif (local_crc, compressed_size, decoded_size) != (member.CRC, member.compress_size, member.file_size):
                    raise ValueError('Conflicting ZIP member sizes.')
                start = offset + 30 + filename_size + extra_size
                cursor = start + member.compress_size
                if cursor > directory_offset:
                    raise ValueError('Overlapping ZIP member data.')
                if flags & 8:
                    payload.seek(cursor)
                    descriptor_size = 20 if zip64 else 12
                    descriptor = payload.read(4)
                    if descriptor == b'PK\x07\x08':
                        cursor += 4
                        descriptor = b''
                    descriptor += payload.read(descriptor_size - len(descriptor))
                    if struct.unpack('<I2Q' if zip64 else '<3I', descriptor) != (member.CRC, member.compress_size, member.file_size):
                        raise ValueError('Conflicting ZIP data descriptor.')
                    cursor += descriptor_size
                label = name + ':' + member.filename
                if method == zipfile.ZIP_STORED:
                    if member.compress_size != member.file_size:
                        raise ValueError('Conflicting stored ZIP sizes.')
                    stream = ArchiveSlice(payload, start, member.compress_size, member.CRC)
                    self.content(label, stream, depth + 1, archive_expected(member.filename))
                else:
                    source = ArchiveSlice(payload, start, member.compress_size)
                    if method == zipfile.ZIP_DEFLATED:
                        factory = lambda: zlib.decompressobj(-zlib.MAX_WBITS)
                    elif method == zipfile.ZIP_BZIP2:
                        factory = bz2.BZ2Decompressor
                    elif method == zipfile.ZIP_LZMA and flags & 2:
                        _, _, properties_size = struct.unpack('<2BH', source.read(4))
                        if properties_size != 5:
                            raise ValueError('Unsupported ZIP LZMA properties.')
                        properties = source.read(properties_size)
                        options = properties[0]
                        dictionary = int.from_bytes(properties[1:], 'little')
                        if options >= 225 or dictionary > self.limits.max_input_bytes:
                            raise ValueError('ZIP LZMA dictionary limit exceeded.')
                        filters = [{'id': lzma.FILTER_LZMA1, 'dict_size': dictionary, 'lc': options % 9, 'lp': options // 9 % 5, 'pb': options // 45}]
                        factory = lambda: lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filters)
                    else:
                        raise ValueError('Unsupported ZIP compression method.')
                    self.decoded_content(label, source, depth + 1, factory, expected=(member.file_size, member.CRC), required=archive_expected(member.filename))
            if cursor != directory_offset:
                raise ValueError('Unconsumed ZIP local records.')

    def tar_pax(self, data):
        headers = {}
        cursor = 0
        supported = {'path', 'linkpath', 'size', 'uid', 'gid', 'uname', 'gname', 'mtime', 'atime', 'ctime', 'hdrcharset', 'comment'}
        while cursor < len(data):
            self.entries += 1
            if self.entries > self.limits.max_entries:
                raise ValueError('Tar metadata entry limit exceeded.')
            separator = data.find(b' ', cursor, cursor + 22)
            digits = data[cursor:separator] if separator >= 0 else b''
            if not digits or not digits.isdigit():
                raise ValueError('Unreadable tar metadata length.')
            size = int(digits)
            end = cursor + size
            if size < separator - cursor + 4 or end > len(data) or data[end - 1:end] != b'\n':
                raise ValueError('Unreadable tar metadata record.')
            key, equals, value = data[separator + 1:end - 1].partition(b'=')
            key = key.decode('utf-8', 'surrogateescape')
            value = value.decode('utf-8', 'surrogateescape')
            if not equals or key not in supported or '\x00' in value:
                raise ValueError('Unsupported tar metadata layout.')
            if key == 'size' and value:
                digits = value.lstrip('0') or '0'
                if not digits.isascii() or not digits.isdigit() or len(digits) > 20:
                    raise ValueError('Unsupported tar metadata size.')
                value = int(digits)
            if key == 'hdrcharset' and value not in {'', 'BINARY', 'ISO-IR 10646 2000 UTF-8'}:
                raise ValueError('Unsupported tar metadata encoding.')
            headers[key] = value if value != '' else None
            cursor = end
        return headers

    def tar_content(self, name, payload, depth):
        payload.seek(0, os.SEEK_END)
        length = payload.tell()
        if length % 512:
            raise ValueError('Unaligned tar archive.')
        cursor = 0
        global_headers = {}
        pending_headers = None
        extensions = {tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK}
        while cursor < length:
            payload.seek(cursor)
            header = payload.read(512)
            if not header.strip(b'\x00'):
                if length - cursor < 1024 or pending_headers is not None:
                    raise ValueError('Incomplete tar end records.')
                while trailing := payload.read(CHUNK_BYTES):
                    if trailing.strip(b'\x00'):
                        raise ValueError('Unconsumed trailing tar data.')
                return
            member = tar_header(header)
            if member.size < 0:
                raise ValueError('Negative tar member size.')
            attributes = global_headers.copy()
            for key, value in (pending_headers or {}).items():
                if value is None:
                    attributes.pop(key, None)
                else:
                    attributes[key] = value
            extension = member.type in extensions
            size = member.size if extension else attributes.get('size', member.size)
            start = cursor + 512
            end = start + size
            cursor = end + (-size % 512)
            if cursor > length or size > self.limits.max_input_bytes:
                raise ValueError('Tar member exceeds input bounds.')
            payload.seek(end)
            if payload.read(cursor - end).strip(b'\x00'):
                raise ValueError('Nonzero tar payload padding.')
            if extension:
                self.name(name + ':' + member.name)
                payload.seek(start)
                data = payload.read(size)
                if member.type in {tarfile.XHDTYPE, tarfile.XGLTYPE}:
                    attributes = self.tar_pax(data)
                    if member.type == tarfile.XGLTYPE:
                        if pending_headers is not None:
                            raise ValueError('Ambiguous tar extension order.')
                        for key, value in attributes.items():
                            if value is None:
                                global_headers.pop(key, None)
                            else:
                                global_headers[key] = value
                    else:
                        if pending_headers is None:
                            pending_headers = {}
                        if pending_headers.keys() & attributes.keys():
                            raise ValueError('Conflicting tar extension records.')
                        pending_headers.update(attributes)
                else:
                    value, terminator, padding = data.partition(b'\x00')
                    if not terminator or padding.strip(b'\x00'):
                        raise ValueError('Unreadable GNU tar extension.')
                    key = 'path' if member.type == tarfile.GNUTYPE_LONGNAME else 'linkpath'
                    if pending_headers is None:
                        pending_headers = {}
                    if key in pending_headers:
                        raise ValueError('Conflicting tar extension records.')
                    pending_headers[key] = value.decode('utf-8', 'surrogateescape')
                continue
            member_name = attributes.get('path', member.name)
            label = name + ':' + member_name
            pending_headers = None
            if member.type in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.CONTTYPE}:
                self.content(label, ArchiveSlice(payload, start, size), depth + 1, archive_expected(member_name))
            elif member.type in {tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE}:
                if size:
                    raise ValueError('Nonfile tar member has a payload.')
                if member.isdir():
                    self.name(label)
                else:
                    self.link(label, attributes.get('linkpath', member.linkname))
            else:
                raise ValueError('Unsupported tar member type.')
        raise ValueError('Missing tar end records.')

    def archive(self, name, payload, depth, required):
        head = payload.read(512)
        payload.seek(0)
        if head.startswith(UNSUPPORTED_MAGIC):
            raise ValueError('Unsupported archive format.')
        wrappers = [
            (b'\x1f\x8b', lambda: zlib.decompressobj(16 + zlib.MAX_WBITS), 1),
            (b'BZh', bz2.BZ2Decompressor, 0),
            (b'\xfd7zXZ\x00', lambda: lzma.LZMADecompressor(memlimit=self.limits.max_input_bytes), 4),
        ]
        wrapper = next((item for item in wrappers if head.startswith(item[0])), None)
        is_zip = head.startswith((b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08')) or zipfile.is_zipfile(payload)
        payload.seek(0)
        is_tar = len(head) == 512 and not head.strip(b'\x00')
        try:
            tarfile.TarInfo.frombuf(head, 'utf-8', 'surrogateescape')
            is_tar = True
        except tarfile.HeaderError:
            if head[257:263] in {b'ustar\x00', b'ustar '}:
                raise ValueError('Unreadable tar archive.') from None
        payload.seek(0)
        if not (wrapper or is_zip or is_tar):
            if required:
                raise ValueError('Archive format was not recognized.')
            return
        if depth >= self.limits.max_depth:
            raise ValueError('Nested archive depth exceeded.')
        if wrapper:
            magic, factory, padding = wrapper
            self.decoded_content(name + ':decoded', payload, depth + 1, factory, magic, padding)
        elif is_tar:
            self.tar_content(name, payload, depth)
        else:
            self.zip_content(name, payload, depth)

    def file(self, path, name=None, require_archive=False):
        name = name or str(path)
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError('Input must be a regular file.')
        with path.open('rb') as stream:
            self.content(name, stream, require_archive=require_archive or archive_expected(path.name))

    def tree(self, root):
        if not root.is_dir():
            raise ValueError('Source tree must be a directory.')

        def walk_error(error):
            raise error

        for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
            retained = []
            for name in sorted(dirs):
                path = Path(directory) / name
                relative = path.relative_to(root).as_posix()
                if path.is_symlink():
                    self.link(relative, os.readlink(path))
                elif name not in {'.git', 'node_modules'}:
                    self.name(relative)
                    retained.append(name)
            dirs[:] = retained
            for name in sorted(files):
                path = Path(directory) / name
                relative = path.relative_to(root).as_posix()
                if path.is_symlink():
                    self.link(relative, os.readlink(path))
                else:
                    self.file(path, relative)

    def history(self, root, refs):
        git_env = dict(os.environ, GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1', GIT_GRAFT_FILE=os.devnull)

        def git(*args, input=None):
            return subprocess.run(
                ['git', '-C', str(root), *args], input=input,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, env=git_env,
            ).stdout

        if git('rev-parse', '--is-shallow-repository').strip() != b'false':
            raise ValueError('Complete local Git history is required.')
        if refs == ['--all']:
            roots = []
            for record in git('for-each-ref', '--format=%(refname)%00%(objectname)').splitlines():
                refname, oid = record.split(b'\x00')
                self.name('git-ref:' + refname.decode('utf-8', 'surrogateescape'))
                roots.append(oid.decode('ascii'))
            head = subprocess.run(
                ['git', '-C', str(root), 'rev-parse', '--verify', 'HEAD'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=git_env,
            )
            if head.returncode == 0:
                roots.append(head.stdout.strip().decode('ascii'))
        else:
            roots = []
            for ref in refs:
                if ref.startswith('-'):
                    raise ValueError('History roots must be refs or object IDs.')
                self.name('git-ref:' + ref)
                roots.append(git('rev-parse', '--verify', '--end-of-options', ref).strip().decode('ascii'))
                for full_ref in git('rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', ref).splitlines():
                    self.name('git-ref:' + full_ref.decode('utf-8', 'surrogateescape'))
        if not roots:
            return
        objects = git('rev-list', '--objects', '--no-object-names', *roots, '--').splitlines()
        if len(objects) > self.limits.max_entries:
            raise ValueError('Git object limit exceeded.')
        records = git('cat-file', '--batch-check=%(objectname) %(objecttype)', input=b'\n'.join(objects) + b'\n').splitlines()
        kinds = dict(record.split(b' ') for record in records)
        trees = set(git('rev-list', '--format=%T', '--no-commit-header', *roots, '--').splitlines())
        for root_oid in roots:
            peeled = git('rev-parse', '--verify', root_oid + '^{}').strip()
            if kinds[peeled] == b'tree':
                trees.add(peeled)
        expected_archives = set()
        for tree in sorted(trees):
            for record in git('ls-tree', '-r', '-t', '-z', '--full-tree', tree.decode('ascii')).split(b'\x00'):
                if not record:
                    continue
                metadata, raw_name = record.split(b'\t', 1)
                _, kind, oid = metadata.split(b' ')
                name = raw_name.decode('utf-8', 'surrogateescape')
                self.name('git-tree:' + tree.decode('ascii') + ':' + name)
                if kind == b'blob' and archive_expected(name):
                    expected_archives.add(oid)
        for oid, kind in sorted(kinds.items()):
            if kind not in {b'blob', b'commit', b'tag'}:
                continue
            with subprocess.Popen(
                ['git', '-C', str(root), 'cat-file', kind.decode('ascii'), oid.decode('ascii')],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=git_env,
            ) as proc:
                try:
                    self.content('git:' + oid.decode('ascii'), proc.stdout, require_archive=oid in expected_archives)
                except BaseException:
                    proc.kill()
                    proc.wait()
                    raise
                if proc.wait():
                    raise RuntimeError('Git object read failed.')


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('Invalid privacy scanner arguments.')


def main():
    parser = PrivateArgumentParser(description=__doc__)
    parser.add_argument('--deny-file', type=Path, required=True, help='External JSON array of private strings; values never appear in reports.')
    parser.add_argument('--tree', type=Path)
    parser.add_argument('--archive', type=Path, action='append', default=[])
    parser.add_argument('--history', type=Path)
    parser.add_argument('--ref', action='append', default=[], help='History roots. Defaults to all refs and HEAD; explicit roots must be refs or object IDs.')
    defaults = Limits()
    for option in ('max_depth', 'max_input_bytes', 'max_total_bytes', 'max_entries'):
        parser.add_argument('--' + option.replace('_', '-'), type=int, default=getattr(defaults, option))
    args = parser.parse_args()
    if not args.tree and not args.archive and not args.history:
        parser.error('Choose at least one scan target.')
    limits = Limits(args.max_depth, args.max_input_bytes, args.max_total_bytes, args.max_entries)
    if limits.max_depth < 0 or min(limits.max_input_bytes, limits.max_total_bytes, limits.max_entries) < 1:
        raise ValueError('Privacy scan limits must be positive.')
    terms = json.loads(args.deny_file.read_text(encoding='utf-8'))
    if not isinstance(terms, list) or not terms or any(not isinstance(t, str) or not 3 <= len(t.encode('utf-8')) <= 1024 for t in terms):
        raise ValueError('Deny file must contain strings of 3 to 1024 UTF-8 bytes.')
    if args.tree and args.deny_file.resolve().is_relative_to(args.tree.resolve()):
        raise ValueError('Deny file must live outside the scanned source tree.')
    scanner = Scanner(terms, limits)
    if args.tree:
        scanner.tree(args.tree.resolve())
    for path in args.archive:
        scanner.file(path.absolute(), 'archive:' + path.name, require_archive=True)
    if args.history:
        scanner.history(args.history.resolve(), args.ref or ['--all'])
    print(json.dumps({
        'status': 'failed' if scanner.findings else 'passed',
        'checkedInputs': scanner.checked,
        'findings': [{'inputSha256': item, 'ruleIndex': rule} for item, rule in sorted(scanner.findings)],
        'limits': {
            'matching': 'Unicode case-folded names and incremental UTF-8 content. Invalid UTF-8 bytes are preserved with surrogateescape. No Unicode normalization, UTF-16 decoding, OCR, media, or credential classification.',
            'archives': 'Content-detected tar, ZIP, gzip, bzip2, and xz. Physical tar records, ZIP records, and compressed streams must be consumed completely. Tar supports canonical V7/ustar headers, bounded PAX metadata, and GNU long names/links, with zero payload padding and complete zero end records. Canonical single-volume ZIP and same-format concatenated wrappers are supported. gzip zero padding and xz four-byte zero padding are accepted. Mixed streams, unsupported layouts/signatures, unrecognized advertised archives, unreadable members, and exceeded bounds fail closed. Other opaque encodings require separate review. No archive extraction or symlink following.',
            'tree': 'Every entry is scanned except real .git and node_modules directories. Ignored files are included. Use --history for reachable Git contents, full tree paths, ref names, and commit/tag payloads. Reflogs, unreachable objects, and external submodule contents are outside scope.',
            'maxArchiveDepth': limits.max_depth,
            'maxInputBytes': limits.max_input_bytes,
            'maxTotalBytes': limits.max_total_bytes,
            'maxEntries': limits.max_entries,
        },
    }, indent=2))
    return 1 if scanner.findings else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({'status': 'error', 'message': 'Privacy scan could not complete. Inspect the inputs privately.'}))
        sys.exit(2)
