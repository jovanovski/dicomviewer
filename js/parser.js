/* parser.js — DICOM Part 10 reader. No dependencies.
 *
 * Handles: 128-byte preamble + DICM magic (and headerless datasets), the
 * Explicit VR LE file meta group, then the main dataset in Implicit VR LE,
 * Explicit VR LE/BE or Deflated Explicit VR LE, including nested sequences
 * and encapsulated (compressed) pixel data split into frames.
 */
(function (global) {
  'use strict';

  var UNDEFINED_LENGTH = 0xFFFFFFFF;

  var TRANSFER_SYNTAXES = {
    '1.2.840.10008.1.2':       { name: 'Implicit VR Little Endian',        explicit: false, le: true },
    '1.2.840.10008.1.2.1':     { name: 'Explicit VR Little Endian',        explicit: true,  le: true },
    '1.2.840.10008.1.2.1.99':  { name: 'Deflated Explicit VR Little Endian', explicit: true, le: true, deflated: true },
    '1.2.840.10008.1.2.2':     { name: 'Explicit VR Big Endian',           explicit: true,  le: false },
    '1.2.840.10008.1.2.5':     { name: 'RLE Lossless',                     explicit: true,  le: true, encapsulated: true, codec: 'rle' },
    '1.2.840.10008.1.2.4.50':  { name: 'JPEG Baseline (Process 1)',        explicit: true,  le: true, encapsulated: true, codec: 'jpeg' },
    '1.2.840.10008.1.2.4.51':  { name: 'JPEG Extended (Process 2 & 4)',    explicit: true,  le: true, encapsulated: true, codec: 'jpeg' },
    '1.2.840.10008.1.2.4.57':  { name: 'JPEG Lossless, Non-Hierarchical',  explicit: true,  le: true, encapsulated: true, codec: 'jpeg-lossless' },
    '1.2.840.10008.1.2.4.70':  { name: 'JPEG Lossless, First-Order Prediction', explicit: true, le: true, encapsulated: true, codec: 'jpeg-lossless' },
    '1.2.840.10008.1.2.4.80':  { name: 'JPEG-LS Lossless',                 explicit: true,  le: true, encapsulated: true, codec: 'jpeg-ls' },
    '1.2.840.10008.1.2.4.81':  { name: 'JPEG-LS Near-Lossless',            explicit: true,  le: true, encapsulated: true, codec: 'jpeg-ls' },
    '1.2.840.10008.1.2.4.90':  { name: 'JPEG 2000 Lossless',               explicit: true,  le: true, encapsulated: true, codec: 'jpeg2000' },
    '1.2.840.10008.1.2.4.91':  { name: 'JPEG 2000',                        explicit: true,  le: true, encapsulated: true, codec: 'jpeg2000' },
    '1.2.840.10008.1.2.4.201': { name: 'High-Throughput JPEG 2000 Lossless', explicit: true, le: true, encapsulated: true, codec: 'jpeg2000' },
    '1.2.840.10008.1.2.4.202': { name: 'High-Throughput JPEG 2000 RPCL',   explicit: true,  le: true, encapsulated: true, codec: 'jpeg2000' },
    '1.2.840.10008.1.2.4.203': { name: 'High-Throughput JPEG 2000',        explicit: true,  le: true, encapsulated: true, codec: 'jpeg2000' },
    '1.2.840.10008.1.2.4.100': { name: 'MPEG2 Main Profile',               explicit: true,  le: true, encapsulated: true, codec: 'mpeg' },
    '1.2.840.10008.1.2.4.102': { name: 'MPEG-4 AVC/H.264',                 explicit: true,  le: true, encapsulated: true, codec: 'mpeg' }
  };

  /* VRs whose explicit encoding carries 2 reserved bytes then a 32-bit length. */
  var LONG_FORM_VR = { OB: 1, OD: 1, OF: 1, OL: 1, OV: 1, OW: 1, SQ: 1, SV: 1, UC: 1, UN: 1, UR: 1, UT: 1 };
  var STRING_VR = { AE: 1, AS: 1, CS: 1, DA: 1, DS: 1, DT: 1, IS: 1, LO: 1, LT: 1, PN: 1, SH: 1, ST: 1, TM: 1, UC: 1, UI: 1, UR: 1, UT: 1 };
  var BINARY_VR = { OB: 1, OD: 1, OF: 1, OL: 1, OV: 1, OW: 1, UN: 1 };

  function tagString(group, element) {
    return ('0000' + group.toString(16)).slice(-4) + ('0000' + element.toString(16)).slice(-4);
  }

  /* ---------------------------------------------------------------- stream */

  function Stream(buffer, offset, length, littleEndian) {
    this.buffer = buffer;
    this.base = offset;
    this.length = length;
    this.view = new DataView(buffer, offset, length);
    this.le = littleEndian !== false;
    this.pos = 0;
  }
  Stream.prototype.u8 = function () { return this.view.getUint8(this.pos++); };
  Stream.prototype.u16 = function () { var v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; };
  Stream.prototype.u32 = function () { var v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; };
  Stream.prototype.ascii = function (n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.pos + i));
    this.pos += n;
    return s;
  };
  Stream.prototype.skip = function (n) { this.pos += n; };
  Stream.prototype.seek = function (p) { this.pos = p; };
  Stream.prototype.remaining = function () { return this.length - this.pos; };

  /* --------------------------------------------------------------- parsing */

  /* Reads one element header and returns it with the value left unparsed
   * (dataOffset/length point into the underlying ArrayBuffer). */
  function readElement(stream, explicit) {
    if (stream.remaining() < 8) return null;
    var group = stream.u16();
    var element = stream.u16();
    var tag = tagString(group, element);
    var vr = null;
    var length;

    /* Item and delimiter tags never carry a VR, whatever the transfer syntax. */
    if (group === 0xFFFE) {
      length = stream.u32();
      return { tag: tag, group: group, element: element, vr: 'NONE', length: length, dataOffset: stream.base + stream.pos };
    }

    if (explicit) {
      vr = stream.ascii(2);
      if (LONG_FORM_VR[vr]) {
        stream.skip(2);
        length = stream.u32();
      } else if (/^[A-Z][A-Z]$/.test(vr)) {
        length = stream.u16();
      } else {
        /* Not a valid VR — the file claims explicit but this element is
         * implicit. Rewind past the two bytes we consumed as a VR and read a
         * 32-bit length instead. Malformed files from older scanners do this. */
        stream.pos -= 2;
        vr = global.DICOMDictionary ? global.DICOMDictionary.vrOf(tag) : null;
        length = stream.u32();
        if (!vr || vr === 'NONE') vr = 'UN';
      }
    } else {
      length = stream.u32();
      vr = global.DICOMDictionary ? global.DICOMDictionary.vrOf(tag) : null;
      if (!vr || vr === 'NONE') vr = (length === UNDEFINED_LENGTH) ? 'SQ' : 'UN';
    }

    return { tag: tag, group: group, element: element, vr: vr, length: length, dataOffset: stream.base + stream.pos };
  }

  function parseDataset(stream, explicit, endPos, depth) {
    var elements = Object.create(null);
    if (endPos === undefined || endPos > stream.length) endPos = stream.length;

    while (stream.pos < endPos) {
      var startPos = stream.pos;
      var el = readElement(stream, explicit);
      if (!el) break;

      /* Delimiters close the enclosing item/sequence. */
      if (el.tag === 'fffee00d' || el.tag === 'fffee0dd') break;

      if (el.tag === '7fe00010' && el.length === UNDEFINED_LENGTH) {
        el.fragments = parseEncapsulated(stream);
        el.encapsulated = true;
        elements[el.tag] = el;
        continue;
      }

      if (el.vr === 'SQ' || (el.length === UNDEFINED_LENGTH && el.vr === 'UN')) {
        el.vr = 'SQ';
        el.items = parseSequence(stream, explicit, el.length, depth + 1);
        elements[el.tag] = el;
        continue;
      }

      if (el.length === UNDEFINED_LENGTH) {
        /* Undefined length on a non-sequence we cannot interpret: bail out of
         * this level rather than walking off into garbage. */
        stream.pos = startPos;
        break;
      }

      if (stream.pos + el.length > stream.length) {
        el.length = Math.max(0, stream.length - stream.pos);
        el.truncated = true;
      }
      stream.skip(el.length);
      elements[el.tag] = el;
    }
    return elements;
  }

  function parseSequence(stream, explicit, seqLength, depth) {
    var items = [];
    var endPos = (seqLength === UNDEFINED_LENGTH) ? stream.length : Math.min(stream.pos + seqLength, stream.length);
    if (depth > 12) { stream.pos = endPos; return items; }

    while (stream.pos + 8 <= endPos) {
      var g = stream.u16(), e = stream.u16(), len = stream.u32();
      var tag = tagString(g, e);
      if (tag === 'fffee0dd') break;               /* sequence delimiter      */
      if (tag !== 'fffee000') { stream.pos -= 8; break; } /* not an item: stop */

      var itemEnd = (len === UNDEFINED_LENGTH) ? endPos : Math.min(stream.pos + len, endPos);
      items.push(parseDataset(stream, explicit, itemEnd, depth));
      if (len !== UNDEFINED_LENGTH) stream.seek(itemEnd);
    }
    if (seqLength !== UNDEFINED_LENGTH) stream.seek(endPos);
    return items;
  }

  /* Encapsulated pixel data: a Basic Offset Table item followed by one or more
   * compressed fragments, terminated by the sequence delimiter. */
  function parseEncapsulated(stream) {
    var basicOffsetTable = [];
    var fragments = [];
    var first = true;

    while (stream.pos + 8 <= stream.length) {
      var g = stream.u16(), e = stream.u16(), len = stream.u32();
      var tag = tagString(g, e);
      if (tag === 'fffee0dd') break;
      if (tag !== 'fffee000') break;
      if (len === UNDEFINED_LENGTH || stream.pos + len > stream.length) break;

      if (first) {
        for (var i = 0; i + 4 <= len; i += 4) {
          basicOffsetTable.push(stream.view.getUint32(stream.pos + i, true));
        }
        first = false;
      } else {
        fragments.push({ offset: stream.base + stream.pos, length: len });
      }
      stream.skip(len);
      if (len % 2 === 1) stream.skip(1);
    }
    return { basicOffsetTable: basicOffsetTable, fragments: fragments };
  }

  /* --------------------------------------------------------- value decoding */

  function DataSet(buffer, elements, meta, syntax, charset) {
    this.buffer = buffer;
    this.elements = elements;
    this.meta = meta || Object.create(null);
    this.syntax = syntax;
    this.le = syntax.le;
    this.charset = charset || null;
    this._decoder = null;
  }

  DataSet.prototype.element = function (tag) {
    return this.elements[tag] || this.meta[tag] || null;
  };
  DataSet.prototype.has = function (tag) { return !!this.element(tag); };

  DataSet.prototype.decodeText = function (bytes) {
    if (!this._decoder) {
      var enc = 'windows-1252';
      var cs = this.charset || '';
      if (/192/.test(cs)) enc = 'utf-8';
      else if (/ISO[ _]?IR[ _]?100/i.test(cs)) enc = 'iso-8859-1';
      else if (/ISO[ _]?IR[ _]?101/i.test(cs)) enc = 'iso-8859-2';
      else if (/ISO[ _]?IR[ _]?144/i.test(cs)) enc = 'iso-8859-5';
      else if (/ISO[ _]?IR[ _]?126/i.test(cs)) enc = 'iso-8859-7';
      else if (/GB18030|GBK/i.test(cs)) enc = 'gb18030';
      try { this._decoder = new TextDecoder(enc); }
      catch (err) { this._decoder = new TextDecoder('utf-8'); }
    }
    return this._decoder.decode(bytes);
  };

  /* Raw bytes for an element, as a Uint8Array view over the original buffer. */
  DataSet.prototype.bytes = function (tag) {
    var el = this.element(tag);
    if (!el || el.length === UNDEFINED_LENGTH) return null;
    return new Uint8Array(this.buffer, el.dataOffset, el.length);
  };

  DataSet.prototype.string = function (tag, index) {
    var el = this.element(tag);
    if (!el || !el.length) return undefined;
    var raw = this.decodeText(new Uint8Array(this.buffer, el.dataOffset, el.length));
    raw = raw.replace(/\0+$/, '');
    if (index === undefined) return raw.trim();
    var parts = raw.split('\\');
    return index < parts.length ? parts[index].trim() : undefined;
  };

  DataSet.prototype.strings = function (tag) {
    var s = this.string(tag);
    if (s === undefined) return [];
    return s.split('\\').map(function (v) { return v.trim(); });
  };

  /* Numeric value. Handles both string VRs (DS/IS) and binary VRs. */
  DataSet.prototype.number = function (tag, index) {
    var values = this.numbers(tag);
    var i = index || 0;
    return i < values.length ? values[i] : undefined;
  };

  DataSet.prototype.numbers = function (tag) {
    var el = this.element(tag);
    if (!el || !el.length) return [];
    var vr = el.vr;

    if (vr === 'DS' || vr === 'IS') {
      return this.strings(tag)
        .filter(function (s) { return s !== ''; })
        .map(parseFloat)
        .filter(function (n) { return !isNaN(n); });
    }

    var view = new DataView(this.buffer, el.dataOffset, el.length);
    var out = [];
    var i;
    switch (vr) {
      case 'US': for (i = 0; i + 2 <= el.length; i += 2) out.push(view.getUint16(i, this.le)); break;
      case 'SS': for (i = 0; i + 2 <= el.length; i += 2) out.push(view.getInt16(i, this.le)); break;
      case 'UL': for (i = 0; i + 4 <= el.length; i += 4) out.push(view.getUint32(i, this.le)); break;
      case 'SL': for (i = 0; i + 4 <= el.length; i += 4) out.push(view.getInt32(i, this.le)); break;
      case 'FL': for (i = 0; i + 4 <= el.length; i += 4) out.push(view.getFloat32(i, this.le)); break;
      case 'FD': for (i = 0; i + 8 <= el.length; i += 8) out.push(view.getFloat64(i, this.le)); break;
      case 'UV': for (i = 0; i + 8 <= el.length; i += 8) out.push(Number(view.getBigUint64(i, this.le))); break;
      case 'SV': for (i = 0; i + 8 <= el.length; i += 8) out.push(Number(view.getBigInt64(i, this.le))); break;
      default: {
        /* UN or an unlabelled numeric: 2 bytes is almost always US. */
        if (el.length === 2) out.push(view.getUint16(0, this.le));
        else if (el.length === 4) out.push(view.getUint32(0, this.le));
        else {
          var s = this.string(tag);
          var n = parseFloat(s);
          if (!isNaN(n)) out.push(n);
        }
      }
    }
    return out;
  };

  DataSet.prototype.uint16Array = function (tag) {
    var el = this.element(tag);
    if (!el || !el.length) return null;
    var n = el.length >> 1;
    var out = new Uint16Array(n);
    var view = new DataView(this.buffer, el.dataOffset, el.length);
    for (var i = 0; i < n; i++) out[i] = view.getUint16(i * 2, this.le);
    return out;
  };

  DataSet.prototype.sequence = function (tag) {
    var el = this.element(tag);
    return el && el.items ? el.items : null;
  };

  /* Reads a tag out of a nested item, wrapping it so the same accessors work. */
  DataSet.prototype.item = function (elements) {
    var ds = new DataSet(this.buffer, elements, this.meta, this.syntax, this.charset);
    ds._decoder = this._decoder;
    return ds;
  };

  /* Walks Shared/Per-frame Functional Groups to find a tag for a given frame,
   * falling back to the top-level dataset. Used by enhanced multi-frame IODs. */
  DataSet.prototype.frameValue = function (sequenceTag, tag, frameIndex, reader) {
    var self = this;
    function search(items, index) {
      if (!items || !items.length) return undefined;
      var item = items[Math.min(index, items.length - 1)];
      if (!item) return undefined;
      var keys = Object.keys(item);
      for (var i = 0; i < keys.length; i++) {
        var el = item[keys[i]];
        if (keys[i] === tag) return reader(self.item(item));
        if (el && el.items) {
          for (var j = 0; j < el.items.length; j++) {
            if (el.items[j][tag] !== undefined) return reader(self.item(el.items[j]));
          }
        }
      }
      return undefined;
    }
    var perFrame = this.sequence('52009230');
    var v = search(perFrame, frameIndex);
    if (v !== undefined) return v;
    var shared = this.sequence('52009229');
    v = search(shared, 0);
    if (v !== undefined) return v;
    return reader(this);
  };

  /* ------------------------------------------------------------ entry point */

  function parseBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length < 8) throw new Error('File is too small to be a DICOM object.');

    var hasMagic = bytes.length > 132 &&
      bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4D;

    var meta = Object.create(null);
    var datasetOffset = 0;
    var syntaxUid = null;

    if (hasMagic) {
      var metaStream = new Stream(buffer, 132, buffer.byteLength - 132, true);
      var groupLengthEl = readElement(metaStream, true);
      var metaEnd;
      if (groupLengthEl && groupLengthEl.tag === '00020000') {
        var groupLength = new DataView(buffer).getUint32(groupLengthEl.dataOffset, true);
        meta['00020000'] = groupLengthEl;
        metaStream.skip(groupLengthEl.length);
        metaEnd = metaStream.pos + groupLength;
      } else {
        metaStream.seek(0);
        metaEnd = metaStream.length;
      }

      while (metaStream.pos < Math.min(metaEnd, metaStream.length)) {
        var save = metaStream.pos;
        var el = readElement(metaStream, true);
        if (!el || el.group !== 0x0002) { metaStream.pos = save; break; }
        metaStream.skip(el.length === UNDEFINED_LENGTH ? 0 : el.length);
        meta[el.tag] = el;
      }
      datasetOffset = 132 + metaStream.pos;

      var tsEl = meta['00020010'];
      if (tsEl) {
        syntaxUid = '';
        for (var i = 0; i < tsEl.length; i++) syntaxUid += String.fromCharCode(bytes[tsEl.dataOffset + i]);
        syntaxUid = syntaxUid.replace(/[\0\s]+$/, '');
      }
    } else {
      /* Headerless dataset (raw stream, or a file with the preamble stripped).
       * Sniff explicit VR by testing whether bytes 4-5 spell a valid VR. */
      var maybeVr = String.fromCharCode(bytes[4], bytes[5]);
      syntaxUid = /^(AE|AS|AT|CS|DA|DS|DT|FL|FD|IS|LO|LT|OB|OD|OF|OW|PN|SH|SL|SQ|SS|ST|TM|UI|UL|UN|US|UT)$/.test(maybeVr)
        ? '1.2.840.10008.1.2.1'
        : '1.2.840.10008.1.2';
    }

    var syntax = TRANSFER_SYNTAXES[syntaxUid] || null;
    if (!syntax) {
      /* Unknown syntax: assume Explicit VR LE so metadata is still readable,
       * and record the UID so the UI can explain why pixels may not decode. */
      syntax = { name: 'Unknown (' + (syntaxUid || 'not specified') + ')', explicit: true, le: true, unknown: true };
    }
    syntax = Object.assign({ uid: syntaxUid }, syntax);

    if (syntax.deflated) {
      var err = new Error('DEFLATED');
      err.deflated = true;
      err.datasetOffset = datasetOffset;
      err.meta = meta;
      err.syntax = syntax;
      throw err;
    }

    var stream = new Stream(buffer, datasetOffset, buffer.byteLength - datasetOffset, syntax.le);
    var elements = parseDataset(stream, syntax.explicit, stream.length, 0);

    var charset = null;
    if (elements['00080005']) {
      var csEl = elements['00080005'];
      charset = '';
      for (var c = 0; c < csEl.length; c++) charset += String.fromCharCode(bytes[csEl.dataOffset + c]);
    }

    return new DataSet(buffer, elements, meta, syntax, charset);
  }

  /* Async wrapper: transparently inflates Deflated Explicit VR LE datasets. */
  function parse(buffer) {
    try {
      return Promise.resolve(parseBuffer(buffer));
    } catch (e) {
      if (!e.deflated) return Promise.reject(e);
      if (typeof DecompressionStream === 'undefined') {
        return Promise.reject(new Error('This file uses Deflated Explicit VR Little Endian, which this browser cannot inflate.'));
      }
      var compressed = buffer.slice(e.datasetOffset);
      var stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer().then(function (inflated) {
        var syntax = Object.assign({}, e.syntax, { deflated: false });
        var s = new Stream(inflated, 0, inflated.byteLength, true);
        var elements = parseDataset(s, true, s.length, 0);
        return new DataSet(inflated, elements, e.meta, syntax, null);
      });
    }
  }

  global.DICOMParser = {
    parse: parse,
    parseSync: parseBuffer,
    tagString: tagString,
    TRANSFER_SYNTAXES: TRANSFER_SYNTAXES,
    UNDEFINED_LENGTH: UNDEFINED_LENGTH,
    STRING_VR: STRING_VR,
    BINARY_VR: BINARY_VR,
    DataSet: DataSet
  };
})(this);
