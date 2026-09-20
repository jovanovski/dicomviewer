/* archive.js — reading study archives without unpacking them first.
 *
 * Studies are handed around as .zip far more often than as loose files, so the
 * viewer opens them directly. ZIP entries are found through the central
 * directory and pulled out one at a time with File.slice(), and the deflate is
 * done by the platform's own DecompressionStream — so a 500 MB archive is
 * never held in memory whole and nothing is bundled to make it work.
 *
 * Tar (plain and gzipped) is handled too, since it costs little on top.
 * RAR and 7z are recognised only so the viewer can say why it cannot open
 * them: both are proprietary formats with no decoder in the browser.
 *
 * Entries come back shaped like File — { name, size, arrayBuffer() } — which
 * is all the loader ever asks of one.
 */
(function (global) {
  'use strict';

  var ZIP_EOCD = 0x06054b50;
  var ZIP64_EOCD = 0x06064b50;
  var ZIP64_LOCATOR = 0x07064b50;
  var ZIP_CENTRAL = 0x02014b50;
  var U32_MAX = 0xffffffff;
  var U16_MAX = 0xffff;

  /* 64 KB is the largest comment a ZIP may carry, plus the record itself. */
  var EOCD_SEARCH = 65557;
  var TAR_BLOCK = 512;

  /* ------------------------------------------------------------- platform */

  var inflateSupport = null;
  function canInflate() {
    if (inflateSupport === null) {
      try {
        /* eslint-disable-next-line no-new */
        new global.DecompressionStream('deflate-raw');
        inflateSupport = true;
      } catch (e) {
        inflateSupport = false;
      }
    }
    return inflateSupport;
  }

  function decompress(blob, format) {
    var stream = blob.stream().pipeThrough(new global.DecompressionStream(format));
    return new global.Response(stream).arrayBuffer();
  }

  /* --------------------------------------------------------------- slices */

  function readSlice(file, start, length) {
    if (start < 0) start = 0;
    var end = Math.min(file.size, start + length);
    if (end <= start) return global.Promise.resolve(new ArrayBuffer(0));
    return file.slice(start, end).arrayBuffer();
  }

  function view(buffer) {
    return new DataView(buffer);
  }

  /* ZIP stores 64-bit values as two 32-bit halves. Sizes beyond 2^53 are not
   * representable here, but nothing that large is going through a canvas. */
  function u64(dv, offset) {
    return dv.getUint32(offset, true) + dv.getUint32(offset + 4, true) * 4294967296;
  }

  /* ---------------------------------------------------------- identifying */

  var SIGNATURES = [
    { kind: 'zip',  bytes: [0x50, 0x4b, 0x03, 0x04] },
    { kind: 'zip',  bytes: [0x50, 0x4b, 0x05, 0x06] },   /* empty archive     */
    { kind: 'zip',  bytes: [0x50, 0x4b, 0x07, 0x08] },   /* spanned           */
    { kind: 'rar',  bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
    { kind: '7z',   bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
    { kind: 'gzip', bytes: [0x1f, 0x8b] }
  ];

  function matchSignature(head) {
    for (var i = 0; i < SIGNATURES.length; i++) {
      var sig = SIGNATURES[i];
      if (head.length < sig.bytes.length) continue;
      var hit = true;
      for (var b = 0; b < sig.bytes.length; b++) {
        if (head[b] !== sig.bytes[b]) { hit = false; break; }
      }
      if (hit) return sig.kind;
    }
    return null;
  }

  /* Tar has no leading magic — the "ustar" marker sits 257 bytes in. */
  function looksLikeTar(head) {
    if (head.length < 263) return false;
    var magic = String.fromCharCode(head[257], head[258], head[259], head[260], head[261]);
    return magic === 'ustar';
  }

  function identify(file) {
    return readSlice(file, 0, 512).then(function (buf) {
      var head = new Uint8Array(buf);
      var kind = matchSignature(head);
      if (kind === 'gzip') {
        /* .tar.gz and a bare .dcm.gz are told apart after inflating. */
        return /\.t(ar\.)?gz$/i.test(file.name) ? 'tar.gz' : 'gzip';
      }
      if (kind) return kind;
      if (looksLikeTar(head)) return 'tar';
      return null;
    });
  }

  /* A cheap name test, so a folder drop of thousands of files does not pay for
   * a read per file just to discover none of them are archives. */
  function looksLikeArchive(file) {
    return /\.(zip|rar|7z|tar|tgz|gz)$/i.test(file.name);
  }

  /* ------------------------------------------------------------------ zip */

  function findEocd(file) {
    return readSlice(file, file.size - EOCD_SEARCH, EOCD_SEARCH).then(function (buf) {
      var dv = view(buf);
      var base = Math.max(0, file.size - EOCD_SEARCH);
      for (var p = buf.byteLength - 22; p >= 0; p--) {
        if (dv.getUint32(p, true) !== ZIP_EOCD) continue;
        var record = {
          entries: dv.getUint16(p + 10, true),
          size: dv.getUint32(p + 12, true),
          offset: dv.getUint32(p + 16, true),
          at: base + p
        };
        /* A ZIP64 locator sits immediately before the classic record. */
        if (p >= 20 && dv.getUint32(p - 20, true) === ZIP64_LOCATOR) {
          record.zip64At = u64(dv, p - 20 + 8);
        }
        return record;
      }
      throw new Error('not a ZIP archive (no end-of-central-directory record)');
    });
  }

  function readZip64Eocd(file, at, record) {
    return readSlice(file, at, 56).then(function (buf) {
      var dv = view(buf);
      if (dv.byteLength < 56 || dv.getUint32(0, true) !== ZIP64_EOCD) return record;
      record.entries = u64(dv, 32);
      record.size = u64(dv, 40);
      record.offset = u64(dv, 48);
      return record;
    });
  }

  function decodeName(bytes, utf8) {
    try {
      return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);
    } catch (e) {
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
  }

  /* Pulls the 64-bit replacements out of the Zip64 extra field. The fields are
   * in a fixed order but each is present only when its 32-bit slot was
   * saturated, so they have to be walked in step with the header. */
  function applyZip64Extra(entry, extra) {
    var dv = view(extra.buffer.slice(extra.byteOffset, extra.byteOffset + extra.byteLength));
    var p = 0;
    while (p + 4 <= dv.byteLength) {
      var id = dv.getUint16(p, true);
      var size = dv.getUint16(p + 2, true);
      var body = p + 4;
      if (id === 0x0001) {
        var q = body;
        if (entry.size === U32_MAX && q + 8 <= body + size) { entry.size = u64(dv, q); q += 8; }
        if (entry.compressedSize === U32_MAX && q + 8 <= body + size) { entry.compressedSize = u64(dv, q); q += 8; }
        if (entry.headerOffset === U32_MAX && q + 8 <= body + size) { entry.headerOffset = u64(dv, q); q += 8; }
        if (entry.diskStart === U16_MAX && q + 4 <= body + size) { entry.diskStart = dv.getUint32(q, true); }
        return;
      }
      p = body + size;
    }
  }

  function parseCentralDirectory(buffer) {
    var dv = view(buffer);
    var bytes = new Uint8Array(buffer);
    var entries = [];
    var p = 0;
    while (p + 46 <= dv.byteLength && dv.getUint32(p, true) === ZIP_CENTRAL) {
      var flags = dv.getUint16(p + 8, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var entry = {
        name: decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0),
        encrypted: (flags & 0x0001) !== 0,
        method: dv.getUint16(p + 10, true),
        compressedSize: dv.getUint32(p + 20, true),
        size: dv.getUint32(p + 24, true),
        diskStart: dv.getUint16(p + 34, true),
        headerOffset: dv.getUint32(p + 42, true)
      };
      if (extraLen) {
        applyZip64Extra(entry, bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      }
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* The local header repeats the name and extra field, and its lengths may
   * differ from the central copy, so the data offset has to be read from it
   * rather than assumed. */
  function dataOffset(file, entry) {
    return readSlice(file, entry.headerOffset, 30).then(function (buf) {
      var dv = view(buf);
      if (dv.byteLength < 30) throw new Error('truncated local header');
      return entry.headerOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    });
  }

  function zipEntryBuffer(file, entry) {
    return dataOffset(file, entry).then(function (start) {
      var blob = file.slice(start, start + entry.compressedSize);
      if (entry.method === 0) return blob.arrayBuffer();
      if (entry.method === 8) return decompress(blob, 'deflate-raw');
      throw new Error('compression method ' + entry.method + ' is not supported');
    });
  }

  function readZip(file, notes) {
    return findEocd(file)
      .then(function (record) {
        return record.zip64At !== undefined
          ? readZip64Eocd(file, record.zip64At, record)
          : record;
      })
      .then(function (record) {
        return readSlice(file, record.offset, record.size);
      })
      .then(function (buf) {
        var entries = parseCentralDirectory(buf);
        var out = [];
        var encrypted = 0;
        var unsupported = 0;

        entries.forEach(function (entry) {
          if (isJunk(entry.name) || /\/$/.test(entry.name)) return;
          if (entry.encrypted) { encrypted++; return; }
          if (entry.method !== 0 && entry.method !== 8) { unsupported++; return; }
          if (entry.method === 8 && !canInflate()) { unsupported++; return; }
          out.push({
            name: baseName(entry.name),
            path: entry.name,
            size: entry.size,
            arrayBuffer: function () { return zipEntryBuffer(file, entry); }
          });
        });

        if (encrypted) {
          notes.push(encrypted + ' entr' + (encrypted === 1 ? 'y is' : 'ies are') +
            ' password-protected in ' + file.name + ' and were skipped');
        }
        if (unsupported) {
          notes.push(unsupported + ' entr' + (unsupported === 1 ? 'y uses' : 'ies use') +
            ' a compression method this browser cannot decode in ' + file.name);
        }
        return out;
      });
  }

  /* ------------------------------------------------------------------ tar */

  function octal(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c === 0 || c === 32) break;
      s += String.fromCharCode(c);
    }
    var n = parseInt(s, 8);
    return isFinite(n) ? n : 0;
  }

  function ascii(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]);
    }
    return s;
  }

  function readTarBuffer(buffer, notes, label) {
    var bytes = new Uint8Array(buffer);
    var out = [];
    var p = 0;
    var longName = null;

    while (p + TAR_BLOCK <= bytes.length) {
      var header = bytes.subarray(p, p + TAR_BLOCK);
      /* Two zero blocks mark the end; a single one ends it just as well. */
      var empty = true;
      for (var i = 0; i < TAR_BLOCK; i++) { if (header[i] !== 0) { empty = false; break; } }
      if (empty) break;

      var size = octal(header.subarray(124, 136));
      var type = String.fromCharCode(header[156] || 48);
      var name = ascii(header.subarray(0, 100));
      var prefix = ascii(header.subarray(345, 500));
      if (prefix) name = prefix + '/' + name;
      var body = p + TAR_BLOCK;
      var padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

      if (type === 'L') {
        /* GNU long name: the next header's name lives in this entry's body. */
        longName = ascii(bytes.subarray(body, body + size));
      } else if (type === '0' || type === '\0' || type === '7') {
        if (longName) { name = longName; longName = null; }
        if (!isJunk(name)) {
          out.push({
            name: baseName(name),
            path: name,
            size: size,
            /* slice() on the typed array shares nothing with the archive. */
            arrayBuffer: (function (from, len) {
              return function () {
                return global.Promise.resolve(bytes.slice(from, from + len).buffer);
              };
            })(body, size)
          });
        }
      } else if (type !== '5' && type !== 'x' && type !== 'g') {
        longName = null;
      }

      p = body + padded;
    }
    if (!out.length) notes.push('no readable entries in ' + label);
    return out;
  }

  function readTar(file, notes) {
    return file.arrayBuffer().then(function (buf) {
      return readTarBuffer(buf, notes, file.name);
    });
  }

  function readTarGz(file, notes) {
    if (!canInflate()) {
      return global.Promise.reject(new Error('this browser cannot decompress gzip'));
    }
    return decompress(file, 'gzip').then(function (buf) {
      return readTarBuffer(buf, notes, file.name);
    });
  }

  /* A bare .gz holding one file — some exports ship .dcm.gz per slice. */
  function readGz(file) {
    if (!canInflate()) {
      return global.Promise.reject(new Error('this browser cannot decompress gzip'));
    }
    var name = file.name.replace(/\.gz$/i, '');
    return decompress(file, 'gzip').then(function (buf) {
      return [{
        name: baseName(name),
        path: name,
        size: buf.byteLength,
        arrayBuffer: function () { return global.Promise.resolve(buf); }
      }];
    });
  }

  /* ---------------------------------------------------------------- shared */

  function baseName(path) {
    var parts = String(path).split('/');
    return parts[parts.length - 1] || path;
  }

  /* Archives made on a Mac carry a parallel __MACOSX tree of resource forks
   * that look like headerless DICOM to the parser. */
  function isJunk(path) {
    return /(^|\/)__MACOSX\//.test(path) ||
      /(^|\/)\._/.test(path) ||
      /(^|\/)\.DS_Store$/i.test(path) ||
      /(^|\/)Thumbs\.db$/i.test(path);
  }

  var UNREADABLE = {
    rar: 'RAR archives cannot be opened in a browser — the format is proprietary ' +
         'and has no decoder here. Please extract it and open the files or folder.',
    '7z': '7z archives cannot be opened in a browser. Please extract it and open ' +
          'the files or folder.'
  };

  /* Expands one archive into File-like entries. */
  function expand(file) {
    var notes = [];
    return identify(file).then(function (kind) {
      if (UNREADABLE[kind]) {
        return { entries: [], notes: [UNREADABLE[kind]], fatal: true };
      }
      var job;
      if (kind === 'zip') job = readZip(file, notes);
      else if (kind === 'tar.gz') job = readTarGz(file, notes);
      else if (kind === 'tar') job = readTar(file, notes);
      else if (kind === 'gzip') job = readGz(file, notes);
      else return { entries: [], notes: ['"' + file.name + '" is not an archive this viewer can read'], fatal: true };

      return job.then(function (entries) {
        return { entries: entries, notes: notes, fatal: false };
      });
    }).catch(function (err) {
      return {
        entries: [],
        notes: ['Could not read ' + file.name + ': ' + ((err && err.message) || 'unreadable')],
        fatal: true
      };
    });
  }

  /* Replaces every archive in a selection with its contents, leaving loose
   * files as they are. Order is preserved so series still sort predictably. */
  function expandAll(files, onProgress) {
    var list = Array.prototype.slice.call(files);
    var archives = list.filter(looksLikeArchive);
    if (!archives.length) {
      return global.Promise.resolve({ files: list, notes: [] });
    }

    var out = [];
    var notes = [];
    var done = 0;

    return list.reduce(function (chain, file) {
      return chain.then(function () {
        if (!looksLikeArchive(file)) { out.push(file); return null; }
        if (onProgress) {
          onProgress('Expanding ' + file.name + (archives.length > 1
            ? ' (' + (done + 1) + ' of ' + archives.length + ')' : '') + '…');
        }
        return expand(file).then(function (res) {
          done++;
          res.entries.forEach(function (e) { out.push(e); });
          res.notes.forEach(function (m) { notes.push(m); });
        });
      });
    }, global.Promise.resolve()).then(function () {
      return { files: out, notes: notes };
    });
  }

  global.DICOMArchive = {
    expandAll: expandAll,
    expand: expand,
    identify: identify,
    looksLikeArchive: looksLikeArchive,
    canInflate: canInflate,
    /* exposed for tests */
    parseCentralDirectory: parseCentralDirectory,
    readTarBuffer: readTarBuffer
  };
})(this);
