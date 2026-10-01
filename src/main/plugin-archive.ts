// Minimal, dependency-free ZIP reader + validating extractor for plugin
// archives downloaded from GitHub's codeload service.
//
// Why hand-rolled: the packaged app must install plugins without Git and
// without pulling a general-purpose archive library into the main process.
// Plugin archives are untrusted executable code, so the reader deliberately
// supports only the subset GitHub emits (stored/deflate, no encryption, no
// ZIP64, no multi-disk) and rejects everything else instead of guessing.
//
// Pure Node — no electron import — so it is unit-testable under node:test.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export class ArchiveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArchiveError';
    }
}

export interface ArchiveLimits {
    /** Maximum number of central-directory entries (files + directories). */
    maxEntries: number;
    /** Maximum total uncompressed size of all file entries, in bytes. */
    maxTotalBytes: number;
    /** Maximum uncompressed size of any single file entry, in bytes. */
    maxEntryBytes: number;
    /** Maximum length of an entry path, in bytes. */
    maxPathLength: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
    maxEntries: 20000,
    maxTotalBytes: 256 * 1024 * 1024,
    maxEntryBytes: 128 * 1024 * 1024,
    maxPathLength: 1024,
};

export interface ArchiveEntry {
    /** Full path inside the archive, '/'-separated; directories end in '/'. */
    name: string;
    isDirectory: boolean;
    method: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    executable: boolean;
}

export interface ParsedArchive {
    entries: ArchiveEntry[];
    comment: string;
    totalUncompressedBytes: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

let crcTable: Uint32Array | null = null;
export function crc32(buf: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// Names Windows refuses (or silently aliases to a device) regardless of
// extension. Rejected on every platform so an archive installs identically
// everywhere instead of failing only on Windows machines.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const UNSAFE_SEGMENT_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

/**
 * Validate one archive path and return its segments. Rejects absolute paths,
 * drive letters, backslashes, traversal, empty segments, and names that are
 * unsafe on any supported filesystem.
 */
export function validateEntryPath(name: string, maxPathLength: number): string[] {
    if (!name) throw new ArchiveError('archive contains an entry with an empty name');
    if (Buffer.byteLength(name, 'utf8') > maxPathLength) {
        throw new ArchiveError('archive contains an entry path that is too long');
    }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw new ArchiveError('archive contains an absolute path');
    }
    const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
    const segments = trimmed.split('/');
    for (const segment of segments) {
        if (segment === '') throw new ArchiveError('archive contains an empty path segment');
        if (segment === '.' || segment === '..') throw new ArchiveError('archive contains a path traversal segment');
        if (UNSAFE_SEGMENT_CHARS.test(segment)) throw new ArchiveError('archive contains a file name with unsafe characters');
        if (segment.endsWith('.') || segment.endsWith(' ')) {
            throw new ArchiveError('archive contains a file name ending in a dot or space');
        }
        if (WINDOWS_RESERVED.test(segment)) throw new ArchiveError('archive contains a reserved file name');
    }
    return segments;
}

function decodeName(raw: Buffer, flags: number): string {
    if (flags & FLAG_UTF8) {
        const text = raw.toString('utf8');
        // A lossy decode means the bytes were not valid UTF-8 despite the flag.
        if (!Buffer.from(text, 'utf8').equals(raw)) throw new ArchiveError('archive contains an invalid UTF-8 file name');
        return text;
    }
    // Without the UTF-8 flag the encoding is CP437; accept only the ASCII
    // subset rather than guess at legacy code pages.
    for (const byte of raw) {
        if (byte > 0x7e) throw new ArchiveError('archive contains a non-ASCII file name without UTF-8 encoding');
    }
    return raw.toString('latin1');
}

function findEocd(buf: Buffer): number {
    const minStart = Math.max(0, buf.length - (EOCD_MIN + 0xffff));
    for (let i = buf.length - EOCD_MIN; i >= minStart; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD && i + EOCD_MIN + buf.readUInt16LE(i + 20) === buf.length) return i;
    }
    throw new ArchiveError('download is not a valid ZIP archive');
}

/** Parse and structurally validate a ZIP archive held in memory. */
export function parseArchive(buf: Buffer, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ParsedArchive {
    if (buf.length < EOCD_MIN) throw new ArchiveError('download is not a valid ZIP archive');
    const eocd = findEocd(buf);
    const diskNumber = buf.readUInt16LE(eocd + 4);
    const cdDisk = buf.readUInt16LE(eocd + 6);
    const entriesOnDisk = buf.readUInt16LE(eocd + 8);
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const commentLength = buf.readUInt16LE(eocd + 20);
    if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
        throw new ArchiveError('multi-volume archives are not supported');
    }
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new ArchiveError('ZIP64 archives are not supported');
    }
    if (totalEntries > limits.maxEntries) throw new ArchiveError('archive contains too many entries');
    if (cdOffset + cdSize !== eocd) throw new ArchiveError('archive central directory is malformed');
    const comment = buf.subarray(eocd + 22, eocd + 22 + commentLength).toString('latin1');

    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();
    let totalUncompressedBytes = 0;
    let p = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (p + CENTRAL_FIXED > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) {
            throw new ArchiveError('archive central directory is malformed');
        }
        const madeBy = buf.readUInt16LE(p + 4);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const compressedSize = buf.readUInt32LE(p + 20);
        const uncompressedSize = buf.readUInt32LE(p + 24);
        const nameLength = buf.readUInt16LE(p + 28);
        const extraLength = buf.readUInt16LE(p + 30);
        const entryCommentLength = buf.readUInt16LE(p + 32);
        const diskStart = buf.readUInt16LE(p + 34);
        const externalAttrs = buf.readUInt32LE(p + 38);
        const localHeaderOffset = buf.readUInt32LE(p + 42);
        const nameEnd = p + CENTRAL_FIXED + nameLength;
        const next = nameEnd + extraLength + entryCommentLength;
        if (next > eocd) throw new ArchiveError('archive central directory is malformed');
        if (diskStart !== 0) throw new ArchiveError('multi-volume archives are not supported');
        if (flags & FLAG_ENCRYPTED) throw new ArchiveError('encrypted archives are not supported');
        if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
            throw new ArchiveError('archive uses an unsupported compression method');
        }
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new ArchiveError('ZIP64 archives are not supported');
        }

        const name = decodeName(buf.subarray(p + CENTRAL_FIXED, nameEnd), flags);
        validateEntryPath(name, limits.maxPathLength);
        const isDirectory = name.endsWith('/');

        // Unix hosts encode the file type in the high 16 bits. Symlinks (and
        // device/fifo/socket entries) are rejected outright: a plugin never
        // needs one, and a link is the classic way to make a later write land
        // outside the extraction root.
        const mode = (externalAttrs >>> 16) & 0xffff;
        const fileType = mode & S_IFMT;
        if ((madeBy >>> 8) === HOST_UNIX && fileType !== 0) {
            if (fileType === S_IFLNK) throw new ArchiveError('archive contains a symbolic link');
            if (fileType !== S_IFREG && fileType !== S_IFDIR) throw new ArchiveError('archive contains a special file');
            if ((fileType === S_IFDIR) !== isDirectory) throw new ArchiveError('archive entry type is inconsistent');
        }
        if (isDirectory && (uncompressedSize !== 0 || compressedSize !== 0)) {
            throw new ArchiveError('archive directory entry carries data');
        }

        // Case- and normalization-insensitive duplicate check: on macOS and
        // Windows two such names collide on disk and the second would
        // silently overwrite the first.
        const key = name.normalize('NFC').toLowerCase().replace(/\/$/, '');
        if (seen.has(key)) throw new ArchiveError('archive contains duplicate file names');
        seen.add(key);

        if (!isDirectory) {
            if (uncompressedSize > limits.maxEntryBytes) throw new ArchiveError('archive contains a file that is too large');
            totalUncompressedBytes += uncompressedSize;
            if (totalUncompressedBytes > limits.maxTotalBytes) throw new ArchiveError('archive expands beyond the size limit');
        }

        entries.push({
            name,
            isDirectory,
            method,
            crc32: crc,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            executable: (madeBy >>> 8) === HOST_UNIX && fileType === S_IFREG && (mode & 0o111) !== 0,
        });
        p = next;
    }
    if (p !== eocd) throw new ArchiveError('archive central directory is malformed');

    // Local records must sit before the central directory and must not
    // overlap: overlapping records are how "zip bombs" reuse one compressed
    // payload for many entries.
    const byOffset = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    let cursor = 0;
    for (const entry of byOffset) {
        if (entry.localHeaderOffset < cursor) throw new ArchiveError('archive contains overlapping entries');
        const start = localDataStart(buf, entry, cdOffset);
        cursor = start + entry.compressedSize;
        if (cursor > cdOffset) throw new ArchiveError('archive entry extends past its bounds');
    }

    return { entries, comment, totalUncompressedBytes };
}

function localDataStart(buf: Buffer, entry: ArchiveEntry, limit: number): number {
    const p = entry.localHeaderOffset;
    if (p + LOCAL_FIXED > limit || buf.readUInt32LE(p) !== SIG_LOCAL) {
        throw new ArchiveError('archive local header is malformed');
    }
    const nameLength = buf.readUInt16LE(p + 26);
    const extraLength = buf.readUInt16LE(p + 28);
    const localFlags = buf.readUInt16LE(p + 6);
    const localName = decodeName(buf.subarray(p + LOCAL_FIXED, p + LOCAL_FIXED + nameLength), localFlags);
    if (localName !== entry.name) throw new ArchiveError('archive local header does not match its directory entry');
    if (buf.readUInt16LE(p + 8) !== entry.method) throw new ArchiveError('archive local header does not match its directory entry');
    return p + LOCAL_FIXED + nameLength + extraLength;
}

/** Decompress one file entry, enforcing its declared size and CRC. */
export function readEntryData(buf: Buffer, entry: ArchiveEntry): Buffer {
    if (entry.isDirectory) return Buffer.alloc(0);
    const start = localDataStart(buf, entry, buf.length);
    const raw = buf.subarray(start, start + entry.compressedSize);
    let data: Buffer;
    if (entry.method === METHOD_STORED) {
        data = Buffer.from(raw);
    } else {
        try {
            // maxOutputLength bounds the inflate itself, so a lying size
            // field cannot make us allocate more than the declared amount.
            data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
        } catch {
            throw new ArchiveError('archive contains corrupt compressed data');
        }
    }
    if (data.length !== entry.uncompressedSize) throw new ArchiveError('archive entry size does not match its header');
    if (crc32(data) !== entry.crc32) throw new ArchiveError('archive entry failed its CRC check');
    return data;
}

/**
 * Return the single top-level directory every entry lives under. GitHub
 * archives always wrap the tree in `<repo>-<commit>/`; anything else (loose
 * files at the root, several roots) is an unexpected layout.
 */
export function singleRootPrefix(archive: ParsedArchive): string {
    let root: string | null = null;
    for (const entry of archive.entries) {
        if (!entry.name.includes('/')) throw new ArchiveError('archive has an unexpected layout');
        const first = entry.name.split('/')[0];
        if (root === null) root = first;
        else if (root !== first) throw new ArchiveError('archive has an unexpected layout');
    }
    if (root === null) throw new ArchiveError('archive is empty');
    return `${root}/`;
}

/**
 * Extract every entry under `prefix` into `destDir` (which must not exist
 * yet). Paths are re-validated and resolved against the destination, files
 * are created exclusively ('wx'), and no link is ever created, so a write can
 * never follow something outside `destDir`.
 */
export function extractArchive(buf: Buffer, archive: ParsedArchive, prefix: string, destDir: string): void {
    const root = path.resolve(destDir);
    fs.mkdirSync(root, { recursive: false });
    for (const entry of archive.entries) {
        if (!entry.name.startsWith(prefix)) throw new ArchiveError('archive has an unexpected layout');
        const relative = entry.name.slice(prefix.length);
        if (relative === '') continue; // the root directory entry itself
        const segments = validateEntryPath(relative, DEFAULT_ARCHIVE_LIMITS.maxPathLength);
        const target = path.resolve(root, ...segments);
        const rel = path.relative(root, target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new ArchiveError('archive entry escapes the install directory');
        }
        if (entry.isDirectory) {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }
        const data = readEntryData(buf, entry);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
    }
}
