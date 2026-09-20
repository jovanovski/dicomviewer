/* decode.js — pixel data extraction and decompression.
 *
 * Uncompressed syntaxes are unpacked directly. RLE Lossless is decoded here.
 * JPEG variants the browser can already decode (baseline / extended 8-bit) are
 * handed to the platform image decoder. Anything else reports a clear reason.
 */
(function (global) {
  'use strict';

  var TAG = {
    rows: '00280010', columns: '00280011',
    samplesPerPixel: '00280002', photometric: '00280004',
    planarConfiguration: '00280006', numberOfFrames: '00280008',
    bitsAllocated: '00280100', bitsStored: '00280101',
    highBit: '00280102', pixelRepresentation: '00280103',
    pixelData: '7fe00010', floatPixelData: '7fe00008', doubleFloatPixelData: '7fe00009'
  };

  /* --------------------------------------------------------- PackBits / RLE */

  function decodePackBits(src, srcStart, srcLength, dst, dstStride, dstStart) {
    var i = srcStart;
    var end = srcStart + srcLength;
    var o = dstStart;
    var limit = dst.length;

    while (i < end && o < limit) {
      var n = src[i++];
      if (n < 128) {                       /* literal run of n+1 bytes        */
        var count = n + 1;
        for (var k = 0; k < count && i < end && o < limit; k++) {
          dst[o] = src[i++];
          o += dstStride;
        }
      } else if (n > 128) {                /* repeat next byte 257-n times    */
        var repeat = 257 - n;
        var value = src[i++];
        for (var r = 0; r < repeat && o < limit; r++) {
          dst[o] = value;
          o += dstStride;
        }
      }
      /* n === 128 is a no-op padding marker. */
    }
    return o;
  }

  /* RLE frames carry a 64-byte header of up to 15 segment offsets. Multi-byte
   * samples are stored as separate byte planes, most significant plane first. */
  function decodeRLEFrame(bytes, info) {
    if (bytes.length < 64) throw new Error('RLE frame is missing its segment header.');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var segmentCount = view.getUint32(0, true);
    if (segmentCount < 1 || segmentCount > 15) throw new Error('RLE frame declares ' + segmentCount + ' segments.');

    var offsets = [];
    for (var s = 0; s < segmentCount; s++) offsets.push(view.getUint32(4 + s * 4, true));

    var bytesPerSample = info.bitsAllocated >> 3;
    if (bytesPerSample < 1) bytesPerSample = 1;
    var pixelCount = info.rows * info.columns;
    var out = new Uint8Array(pixelCount * info.samplesPerPixel * bytesPerSample);

    for (var seg = 0; seg < segmentCount; seg++) {
      var start = offsets[seg];
      var end = (seg + 1 < segmentCount && offsets[seg + 1] > start) ? offsets[seg + 1] : bytes.length;
      if (start >= bytes.length) break;

      var sample = Math.floor(seg / bytesPerSample);
      var byteIndexInSample = seg % bytesPerSample;
      /* Segment 0 of a sample is the most significant byte; we write into a
       * little-endian buffer, so it lands at the high byte position. */
      var destByte = bytesPerSample - 1 - byteIndexInSample;
      var dstStart = sample * bytesPerSample + destByte;
      var dstStride = info.samplesPerPixel * bytesPerSample;

      decodePackBits(bytes, start, end - start, out, dstStride, dstStart);
    }
    return out;
  }

  /* ------------------------------------------------------------- bit depths */

  /* Unpacks 1-bit-per-pixel data (bitmaps, overlays) into one byte per pixel. */
  function unpackBits(bytes, pixelCount) {
    var out = new Uint8Array(pixelCount);
    for (var i = 0; i < pixelCount; i++) {
      var byteIndex = i >> 3;
      if (byteIndex >= bytes.length) break;
      out[i] = (bytes[byteIndex] >> (i & 7)) & 1;
    }
    return out;
  }

  function byteSwap16(bytes) {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      out[i] = bytes[i + 1];
      out[i + 1] = bytes[i];
    }
    return out;
  }

  /* A Uint16Array view reads in the host's byte order, while everything that
   * reaches toTypedArray has already been normalised to little-endian. The
   * shortcut below is therefore only valid on a little-endian host. */
  var PLATFORM_LE = (function () {
    return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  })();

  /* Turns a raw little-endian byte buffer into the typed array the pixel
   * geometry calls for, applying Bits Stored masking and sign extension. */
  function toTypedArray(raw, info) {
    var count = info.rows * info.columns * info.samplesPerPixel;
    var signed = info.pixelRepresentation === 1;

    if (info.floatPixels) {
      var fView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      var fOut = new Float32Array(Math.min(count, Math.floor(raw.byteLength / (info.bitsAllocated >> 3))));
      for (var fi = 0; fi < fOut.length; fi++) {
        fOut[fi] = info.bitsAllocated === 64 ? fView.getFloat64(fi * 8, true) : fView.getFloat32(fi * 4, true);
      }
      return fOut;
    }

    if (info.bitsAllocated === 1) return unpackBits(raw, count);

    if (info.bitsAllocated === 8) {
      var a8 = new Uint8Array(raw.buffer, raw.byteOffset, Math.min(count, raw.byteLength));
      if (!signed) return a8;
      var s8 = new Int8Array(a8.length);
      for (var i8 = 0; i8 < a8.length; i8++) s8[i8] = (a8[i8] << 24) >> 24;
      return s8;
    }

    if (info.bitsAllocated === 16) {
      var available = Math.min(count, raw.byteLength >> 1);
      var bitsStored = info.bitsStored || 16;
      var needsMask = bitsStored < 16;
      var shift = 16 - bitsStored;
      var mask = (1 << bitsStored) - 1;

      /* Reading through a Uint16Array view rather than per-pixel DataView
       * calls is roughly an order of magnitude quicker, which matters because
       * every scroll step decodes a frame. Needs a little-endian host and a
       * 2-byte-aligned buffer; otherwise fall through to the general path. */
      if (PLATFORM_LE && (raw.byteOffset & 1) === 0) {
        var src = new Uint16Array(raw.buffer, raw.byteOffset, available);
        /* Copy rather than alias: callers expect an array they own, and the
         * source may be a window onto the whole file. */
        if (!needsMask && !signed) return new Uint16Array(src);
        var fast = signed ? new Int16Array(available) : new Uint16Array(available);
        if (!needsMask) {
          /* Int16Array assignment already truncates to a signed 16-bit value. */
          fast.set(src);
          return fast;
        }
        for (var q = 0; q < available; q++) {
          var qv = src[q] & mask;
          /* Sign-extend from the stored high bit, not from bit 15. */
          fast[q] = signed ? ((qv << shift) >> shift) : qv;
        }
        return fast;
      }

      var view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      var out16 = signed ? new Int16Array(available) : new Uint16Array(available);
      for (var i = 0; i < available; i++) {
        var v = view.getUint16(i * 2, true);
        if (needsMask) {
          /* Keep only the stored bits, then sign-extend from the high bit. */
          v = v & ((1 << bitsStored) - 1);
          if (signed) v = (v << shift) >> shift;
        } else if (signed) {
          v = (v << 16) >> 16;
        }
        out16[i] = v;
      }
      return out16;
    }

    if (info.bitsAllocated === 32) {
      var av32 = Math.min(count, raw.byteLength >> 2);
      var v32 = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      var o32 = signed ? new Int32Array(av32) : new Uint32Array(av32);
      for (var j = 0; j < av32; j++) o32[j] = signed ? v32.getInt32(j * 4, true) : v32.getUint32(j * 4, true);
      return o32;
    }

    throw new Error('Unsupported Bits Allocated value: ' + info.bitsAllocated);
  }

  /* ------------------------------------------------------- browser JPEG path */

  var canDecodeImageBitmap = (typeof createImageBitmap === 'function');

  function decodeWithBrowser(bytes, mimeType, info) {
    if (!canDecodeImageBitmap) {
      return Promise.reject(new Error('This browser cannot decode embedded ' + mimeType + ' frames.'));
    }
    var blob = new Blob([bytes], { type: mimeType });
    return createImageBitmap(blob).then(function (bitmap) {
      var canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      var rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var pixelCount = bitmap.width * bitmap.height;

      /* The platform decoder already applied any YBR->RGB conversion, so the
       * result is RGB (or gray replicated across channels). */
      if (info.samplesPerPixel === 1) {
        var gray = new Uint8Array(pixelCount);
        for (var i = 0; i < pixelCount; i++) gray[i] = rgba[i * 4];
        return { pixels: gray, photometricOverride: 'MONOCHROME2', bitsOverride: 8, signedOverride: 0 };
      }
      var rgb = new Uint8Array(pixelCount * 3);
      for (var p = 0; p < pixelCount; p++) {
        rgb[p * 3] = rgba[p * 4];
        rgb[p * 3 + 1] = rgba[p * 4 + 1];
        rgb[p * 3 + 2] = rgba[p * 4 + 2];
      }
      return { pixels: rgb, photometricOverride: 'RGB', bitsOverride: 8, signedOverride: 0, planarOverride: 0 };
    });
  }

  /* --------------------------------------------------------------- geometry */

  function readGeometry(dataSet) {
    var photometric = (dataSet.string(TAG.photometric) || 'MONOCHROME2').toUpperCase().replace(/\s+/g, '');
    var samples = dataSet.number(TAG.samplesPerPixel);
    if (samples === undefined) samples = /RGB|YBR|PALETTE/.test(photometric) ? 3 : 1;

    var floatPixels = !dataSet.has(TAG.pixelData) &&
      (dataSet.has(TAG.floatPixelData) || dataSet.has(TAG.doubleFloatPixelData));

    var bitsAllocated = dataSet.number(TAG.bitsAllocated);
    if (bitsAllocated === undefined) bitsAllocated = floatPixels ? (dataSet.has(TAG.doubleFloatPixelData) ? 64 : 32) : 8;

    var info = {
      rows: dataSet.number(TAG.rows) || 0,
      columns: dataSet.number(TAG.columns) || 0,
      samplesPerPixel: samples,
      photometric: photometric,
      planarConfiguration: dataSet.number(TAG.planarConfiguration) || 0,
      numberOfFrames: Math.max(1, parseInt(dataSet.string(TAG.numberOfFrames) || '1', 10) || 1),
      bitsAllocated: bitsAllocated,
      bitsStored: dataSet.number(TAG.bitsStored) || bitsAllocated,
      highBit: dataSet.number(TAG.highBit),
      pixelRepresentation: dataSet.number(TAG.pixelRepresentation) || 0,
      floatPixels: floatPixels
    };
    if (info.bitsStored > info.bitsAllocated) info.bitsStored = info.bitsAllocated;
    return info;
  }

  /* -------------------------------------------------------------- the entry */

  /* Resolves to { pixels, info } where pixels is a typed array of stored
   * values for one frame, length rows*columns*samplesPerPixel. */
  function decodeFrame(dataSet, frameIndex) {
    var info = readGeometry(dataSet);
    if (!info.rows || !info.columns) {
      return Promise.reject(new Error('This object has no image dimensions (Rows/Columns are absent) — it may be a report, not an image.'));
    }

    var pixelTag = dataSet.has(TAG.pixelData) ? TAG.pixelData
      : dataSet.has(TAG.floatPixelData) ? TAG.floatPixelData
      : dataSet.has(TAG.doubleFloatPixelData) ? TAG.doubleFloatPixelData : null;
    if (!pixelTag) return Promise.reject(new Error('This object contains no Pixel Data.'));

    var el = dataSet.element(pixelTag);
    var frame = Math.max(0, Math.min(frameIndex | 0, info.numberOfFrames - 1));

    /* ---- encapsulated (compressed) ---- */
    if (el.encapsulated) {
      var codec = dataSet.syntax.codec;
      var frags = el.fragments.fragments;
      var bot = el.fragments.basicOffsetTable;
      if (!frags.length) return Promise.reject(new Error('Compressed Pixel Data contains no fragments.'));

      /* Map frame -> fragment range: prefer the Basic Offset Table, else assume
       * one fragment per frame, else treat every fragment as a single frame. */
      var startFrag = 0, endFrag = frags.length;
      if (bot.length === info.numberOfFrames && info.numberOfFrames > 1) {
        var firstOffset = frags[0].offset;
        startFrag = -1;
        for (var f = 0; f < frags.length; f++) {
          var rel = frags[f].offset - firstOffset + 8;
          if (startFrag === -1 && rel >= bot[frame] + 8) startFrag = f;
          if (frame + 1 < bot.length && rel >= bot[frame + 1] + 8) { endFrag = f; break; }
        }
        if (startFrag === -1) startFrag = Math.min(frame, frags.length - 1);
      } else if (frags.length === info.numberOfFrames) {
        startFrag = frame;
        endFrag = frame + 1;
      } else if (info.numberOfFrames === 1) {
        startFrag = 0;
        endFrag = frags.length;
      } else {
        startFrag = Math.min(frame, frags.length - 1);
        endFrag = startFrag + 1;
      }

      var total = 0, fi;
      for (fi = startFrag; fi < endFrag; fi++) total += frags[fi].length;
      var joined = new Uint8Array(total);
      var at = 0;
      for (fi = startFrag; fi < endFrag; fi++) {
        joined.set(new Uint8Array(dataSet.buffer, frags[fi].offset, frags[fi].length), at);
        at += frags[fi].length;
      }

      if (codec === 'rle') {
        try {
          var rleRaw = decodeRLEFrame(joined, info);
          var rleInfo = Object.assign({}, info, { planarConfiguration: 0 });
          return Promise.resolve({ pixels: toTypedArray(rleRaw, rleInfo), info: rleInfo });
        } catch (err) {
          return Promise.reject(err);
        }
      }

      if (codec === 'jpeg') {
        return decodeWithBrowser(joined, 'image/jpeg', info).then(function (res) {
          var jInfo = Object.assign({}, info, {
            photometric: res.photometricOverride,
            bitsAllocated: res.bitsOverride,
            bitsStored: res.bitsOverride,
            pixelRepresentation: res.signedOverride,
            planarConfiguration: 0,
            decodedByBrowser: true
          });
          return { pixels: res.pixels, info: jInfo };
        }).catch(function () {
          throw new Error('This frame is ' + dataSet.syntax.name + '. The browser could not decode it — 12-bit JPEG and arithmetic-coded JPEG are not supported natively.');
        });
      }

      var reason = {
        'jpeg-lossless': 'JPEG Lossless is not decodable in the browser without an external codec.',
        'jpeg-ls': 'JPEG-LS is not decodable in the browser without an external codec.',
        'jpeg2000': 'JPEG 2000 is not decodable in the browser without an external codec.',
        'mpeg': 'MPEG/H.264 video frames are not supported by this viewer.'
      }[codec] || 'This transfer syntax is not supported by this viewer.';
      return Promise.reject(new Error(dataSet.syntax.name + ': ' + reason));
    }

    /* ---- native (uncompressed) ---- */
    var bytesPerSample = Math.max(1, info.bitsAllocated >> 3);
    var frameLength = info.bitsAllocated === 1
      ? Math.ceil(info.rows * info.columns * info.samplesPerPixel / 8)
      : info.rows * info.columns * info.samplesPerPixel * bytesPerSample;

    var offset = el.dataOffset + frame * frameLength;
    var available = Math.max(0, Math.min(frameLength, el.dataOffset + el.length - offset));
    if (available <= 0) return Promise.reject(new Error('Pixel Data is shorter than the declared frame count.'));

    var raw = new Uint8Array(dataSet.buffer, offset, available);
    if (!dataSet.le && info.bitsAllocated === 16) raw = byteSwap16(raw);
    else raw = new Uint8Array(raw);   /* copy so the typed view is aligned */

    try {
      return Promise.resolve({ pixels: toTypedArray(raw, info), info: info });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  global.DICOMDecode = {
    decodeFrame: decodeFrame,
    readGeometry: readGeometry,
    decodeRLEFrame: decodeRLEFrame,
    decodePackBits: decodePackBits,
    toTypedArray: toTypedArray,
    TAG: TAG
  };
})(this);
