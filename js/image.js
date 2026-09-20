/* image.js — the display pipeline.
 *
 * Stored pixel value
 *   -> Modality LUT   (Rescale Slope/Intercept, or a Modality LUT Sequence)
 *   -> VOI LUT        (window centre/width, or a VOI LUT Sequence)
 *   -> Presentation   (MONOCHROME1 inversion, user invert)
 *   -> 8-bit RGBA
 *
 * For single-sample images the whole chain is baked into one lookup table
 * indexed by stored value, so re-windowing a 512x512 frame is a table rebuild
 * plus a flat copy rather than per-pixel maths.
 */
(function (global) {
  'use strict';

  var T = {
    windowCenter: '00281050', windowWidth: '00281051',
    rescaleIntercept: '00281052', rescaleSlope: '00281053',
    rescaleType: '00281054', voiLutFunction: '00281056',
    windowExplanation: '00281055',
    voiLutSequence: '00283010', modalityLutSequence: '00283000',
    lutDescriptor: '00283002', lutData: '00283006', lutExplanation: '00283003',
    redDescriptor: '00281101', greenDescriptor: '00281102', blueDescriptor: '00281103',
    redData: '00281201', greenData: '00281202', blueData: '00281203',
    pixelPadding: '00280120', pixelPaddingLimit: '00280121',
    smallestValue: '00280106', largestValue: '00280107',
    pixelSpacing: '00280030', imagerPixelSpacing: '00181164',
    pixelAspectRatio: '00280034',
    modality: '00080060', presentationLutShape: '20500020'
  };

  var WINDOW_PRESETS = [
    { key: 'ct-soft',    label: 'Soft tissue', center: 50,   width: 400,  modality: 'CT' },
    { key: 'ct-lung',    label: 'Lung',        center: -600, width: 1500, modality: 'CT' },
    { key: 'ct-bone',    label: 'Bone',        center: 400,  width: 1800, modality: 'CT' },
    { key: 'ct-brain',   label: 'Brain',       center: 40,   width: 80,   modality: 'CT' },
    { key: 'ct-abdomen', label: 'Abdomen',     center: 60,   width: 400,  modality: 'CT' },
    { key: 'ct-liver',   label: 'Liver',       center: 90,   width: 150,  modality: 'CT' },
    { key: 'ct-angio',   label: 'Angio',       center: 300,  width: 600,  modality: 'CT' },
    { key: 'ct-mediast', label: 'Mediastinum', center: 50,   width: 350,  modality: 'CT' }
  ];

  /* -------------------------------------------------------------- utilities */

  function firstNumber(values, fallback) {
    for (var i = 0; i < values.length; i++) {
      if (typeof values[i] === 'number' && isFinite(values[i])) return values[i];
    }
    return fallback;
  }

  /* Reads a LUT Sequence item into { firstValue, bits, data }. */
  function readLutItem(dataSet, item) {
    var ds = dataSet.item(item);
    var desc = ds.numbers(T.lutDescriptor);
    if (desc.length < 3) return null;
    var entries = desc[0] === 0 ? 65536 : desc[0];
    var firstValue = desc[1];
    var bits = desc[2];
    var el = ds.element(T.lutData);
    if (!el) return null;

    var data;
    if (bits > 8 || el.length >= entries * 2) {
      data = ds.uint16Array(T.lutData);
    } else {
      data = new Uint8Array(dataSet.buffer, el.dataOffset, el.length);
    }
    if (!data) return null;

    /* Descriptor value 1 is signed when the image is signed; DICOM stores it
     * as US, so re-read it as SS when it looks like a wrapped negative. */
    if (firstValue > 32767) firstValue = firstValue - 65536;
    return { entries: Math.min(entries, data.length), firstValue: firstValue, bits: bits, data: data };
  }

  /* ---------------------------------------------------------- the LUT chain */

  function Modality(dataSet) {
    this.slope = firstNumber(dataSet.numbers(T.rescaleSlope), 1);
    this.intercept = firstNumber(dataSet.numbers(T.rescaleIntercept), 0);
    if (!isFinite(this.slope) || this.slope === 0) this.slope = 1;
    if (!isFinite(this.intercept)) this.intercept = 0;
    this.type = dataSet.string(T.rescaleType) || (dataSet.string(T.modality) === 'CT' ? 'HU' : '');
    this.lut = null;

    var seq = dataSet.sequence(T.modalityLutSequence);
    if (seq && seq.length) {
      this.lut = readLutItem(dataSet, seq[0]);
      var ds = dataSet.item(seq[0]);
      this.type = ds.string('00283004') || this.type;
    }
  }
  Modality.prototype.apply = function (stored) {
    if (this.lut) {
      var i = stored - this.lut.firstValue;
      if (i < 0) i = 0;
      if (i >= this.lut.entries) i = this.lut.entries - 1;
      return this.lut.data[i];
    }
    return stored * this.slope + this.intercept;
  };

  /* Builds the list of window presets carried by the file itself. */
  function readFileWindows(dataSet) {
    var centers = dataSet.numbers(T.windowCenter);
    var widths = dataSet.numbers(T.windowWidth);
    var explanations = dataSet.strings(T.windowExplanation);
    var out = [];
    for (var i = 0; i < Math.min(centers.length, widths.length); i++) {
      if (!isFinite(centers[i]) || !isFinite(widths[i]) || widths[i] <= 0) continue;
      out.push({
        center: centers[i],
        width: widths[i],
        label: (explanations[i] && explanations[i].length) ? explanations[i] : 'From file' + (centers.length > 1 ? ' ' + (i + 1) : '')
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- Frame */

  /* Wraps one decoded frame with everything needed to paint it. */
  function Frame(dataSet, pixels, info, frameIndex) {
    this.dataSet = dataSet;
    this.pixels = pixels;
    this.info = info;
    this.frameIndex = frameIndex;
    this.rows = info.rows;
    this.columns = info.columns;
    this.color = info.samplesPerPixel > 1;

    this.modality = new Modality(dataSet);
    if (info.decodedByBrowser) {
      /* A browser-decoded JPEG is already display-ready 8-bit; rescaling it
       * with the file's slope/intercept would be wrong. */
      this.modality.slope = 1;
      this.modality.intercept = 0;
      this.modality.lut = null;
    }

    this.invertPhotometric = info.photometric === 'MONOCHROME1';
    this.palette = this.color ? null : this.readPalette(dataSet);
    if (info.photometric === 'PALETTECOLOR' && this.palette) this.color = true;

    this.voiLuts = [];
    var voiSeq = dataSet.sequence(T.voiLutSequence);
    if (voiSeq) {
      for (var i = 0; i < voiSeq.length; i++) {
        var lut = readLutItem(dataSet, voiSeq[i]);
        if (lut) {
          lut.label = dataSet.item(voiSeq[i]).string(T.lutExplanation) || ('VOI LUT ' + (i + 1));
          this.voiLuts.push(lut);
        }
      }
    }

    this.voiFunction = (dataSet.string(T.voiLutFunction) || 'LINEAR').toUpperCase();
    this.fileWindows = readFileWindows(dataSet);
    this.spacing = this.readSpacing(dataSet);
    this.padding = this.readPadding(dataSet);

    this.computeRange();
    this._lut = null;
    this._lutKey = '';
  }

  Frame.prototype.readPalette = function (dataSet) {
    if (!dataSet.has(T.redDescriptor) || !dataSet.has(T.redData)) return null;
    function channel(descTag, dataTag) {
      var desc = dataSet.numbers(descTag);
      if (desc.length < 3) return null;
      var entries = desc[0] === 0 ? 65536 : desc[0];
      var first = desc[1] > 32767 ? desc[1] - 65536 : desc[1];
      var bits = desc[2];
      var el = dataSet.element(dataTag);
      if (!el) return null;
      var data;
      if (bits === 8 && el.length <= entries) {
        data = new Uint8Array(dataSet.buffer, el.dataOffset, el.length);
      } else {
        data = dataSet.uint16Array(dataTag);
      }
      return { entries: entries, first: first, bits: bits, data: data };
    }
    var r = channel(T.redDescriptor, T.redData);
    var g = channel(T.greenDescriptor, T.greenData);
    var b = channel(T.blueDescriptor, T.blueData);
    if (!r || !g || !b) return null;
    return { r: r, g: g, b: b };
  };

  Frame.prototype.readSpacing = function (dataSet) {
    var sp = dataSet.numbers(T.pixelSpacing);
    var source = 'Pixel Spacing';
    if (sp.length < 2) {
      sp = dataSet.numbers(T.imagerPixelSpacing);
      source = 'Imager Pixel Spacing';
    }
    if (sp.length < 2) {
      /* Enhanced multi-frame objects hide spacing in a functional group. */
      var fromGroup = dataSet.frameValue('52009230', T.pixelSpacing, this.frameIndex, function (ds) {
        var v = ds.numbers(T.pixelSpacing);
        return v.length >= 2 ? v : undefined;
      });
      if (fromGroup && fromGroup.length >= 2) { sp = fromGroup; source = 'Pixel Measures'; }
    }
    if (sp.length >= 2 && sp[0] > 0 && sp[1] > 0) {
      return { row: sp[0], column: sp[1], calibrated: true, source: source };
    }
    var aspect = dataSet.numbers(T.pixelAspectRatio);
    if (aspect.length >= 2 && aspect[0] > 0 && aspect[1] > 0) {
      return { row: aspect[0] / aspect[1], column: 1, calibrated: false, source: 'Pixel Aspect Ratio' };
    }
    return { row: 1, column: 1, calibrated: false, source: null };
  };

  Frame.prototype.readPadding = function (dataSet) {
    if (!dataSet.has(T.pixelPadding)) return null;
    var v = dataSet.number(T.pixelPadding);
    if (v === undefined) return null;
    if (this.info.pixelRepresentation === 1 && v > 32767) v -= 65536;
    var limit = dataSet.has(T.pixelPaddingLimit) ? dataSet.number(T.pixelPaddingLimit) : v;
    if (this.info.pixelRepresentation === 1 && limit > 32767) limit -= 65536;
    return { low: Math.min(v, limit), high: Math.max(v, limit) };
  };

  /* Scans stored values once for min/max, ignoring padding. */
  Frame.prototype.computeRange = function () {
    var px = this.pixels;
    var min = Infinity, max = -Infinity;
    var pad = this.padding;
    var step = px.length > 4194304 ? 4 : 1;   /* subsample very large frames */
    for (var i = 0; i < px.length; i += step) {
      var v = px[i];
      if (pad && v >= pad.low && v <= pad.high) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min === max) max = min + 1;
    this.storedMin = min;
    this.storedMax = max;
    this.valueMin = Math.min(this.modality.apply(min), this.modality.apply(max));
    this.valueMax = Math.max(this.modality.apply(min), this.modality.apply(max));
  };

  /* The window this frame should open with. */
  Frame.prototype.defaultWindow = function () {
    if (this.voiLuts.length) return { center: null, width: null, lutIndex: 0, label: this.voiLuts[0].label };
    if (this.fileWindows.length) {
      return { center: this.fileWindows[0].center, width: this.fileWindows[0].width, lutIndex: -1, label: this.fileWindows[0].label };
    }
    var center = (this.valueMax + this.valueMin) / 2;
    var width = Math.max(1, this.valueMax - this.valueMin);
    return { center: center, width: width, lutIndex: -1, label: 'Full range' };
  };

  /* Converts a stored pixel value to its modality-corrected value (e.g. HU). */
  Frame.prototype.valueAt = function (x, y) {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return null;
    var index = (y * this.columns + x) * this.info.samplesPerPixel;
    if (this.color) {
      return { r: this.pixels[index], g: this.pixels[index + 1], b: this.pixels[index + 2], color: true };
    }
    var stored = this.pixels[index];
    return { stored: stored, value: this.modality.apply(stored), unit: this.modality.type };
  };

  /* ------------------------------------------------------------ LUT build */

  function windowedByte(value, center, width, fn) {
    var y;
    if (fn === 'SIGMOID') {
      y = 255 / (1 + Math.exp(-4 * (value - center) / width));
    } else if (fn === 'LINEAR_EXACT') {
      if (value <= center - width / 2) y = 0;
      else if (value > center + width / 2) y = 255;
      else y = ((value - center) / width + 0.5) * 255;
    } else {
      /* PS3.3 C.11.2.1.2 LINEAR */
      var c = center - 0.5;
      var w = width - 1;
      if (w < 1) w = 1;
      if (value <= c - w / 2) y = 0;
      else if (value > c + w / 2) y = 255;
      else y = ((value - c) / w + 0.5) * 255;
    }
    return y < 0 ? 0 : y > 255 ? 255 : y;
  }

  /* Builds a stored-value -> 8-bit table covering [storedMin, storedMax]. */
  Frame.prototype.buildLut = function (opts) {
    var key = [opts.center, opts.width, opts.lutIndex, opts.invert, opts.voiFunction].join('|');
    if (this._lut && this._lutKey === key) return this._lut;

    var min = this.storedMin;
    var max = this.storedMax;
    var size = max - min + 1;
    if (size > 65536) size = 65536;
    var lut = new Uint8Array(size);

    var useLut = opts.lutIndex >= 0 && opts.lutIndex < this.voiLuts.length ? this.voiLuts[opts.lutIndex] : null;
    var invert = !!opts.invert !== !!this.invertPhotometric;
    var fn = opts.voiFunction || this.voiFunction;

    for (var i = 0; i < size; i++) {
      var stored = min + i;
      var value = this.modality.apply(stored);
      var out;
      if (useLut) {
        var idx = Math.round(value) - useLut.firstValue;
        if (idx < 0) idx = 0;
        if (idx >= useLut.entries) idx = useLut.entries - 1;
        var raw = useLut.data[idx];
        var shift = useLut.bits > 8 ? (useLut.bits - 8) : 0;
        out = shift ? (raw >> shift) : raw;
        if (out > 255) out = 255;
      } else {
        out = windowedByte(value, opts.center, opts.width, fn);
      }
      lut[i] = invert ? 255 - out : out;
    }

    this._lut = lut;
    this._lutKey = key;
    return lut;
  };

  /* Paints the frame into an ImageData sized rows x columns. */
  Frame.prototype.render = function (imageData, opts) {
    var out = imageData.data;
    var px = this.pixels;
    var count = this.rows * this.columns;
    var i, p;

    if (this.info.photometric === 'PALETTECOLOR' && this.palette) {
      var pal = this.palette;
      var invertPal = !!opts.invert;
      for (i = 0; i < count; i++) {
        var pv = px[i];
        out[i * 4]     = lookupPalette(pal.r, pv, invertPal);
        out[i * 4 + 1] = lookupPalette(pal.g, pv, invertPal);
        out[i * 4 + 2] = lookupPalette(pal.b, pv, invertPal);
        out[i * 4 + 3] = 255;
      }
      return imageData;
    }

    if (this.color) {
      var planar = this.info.planarConfiguration === 1;
      var ybr = /^YBR/.test(this.info.photometric) && !this.info.decodedByBrowser;
      for (i = 0; i < count; i++) {
        var r, g, b;
        if (planar) { r = px[i]; g = px[count + i]; b = px[count * 2 + i]; }
        else { p = i * 3; r = px[p]; g = px[p + 1]; b = px[p + 2]; }
        if (ybr) {
          var Y = r, Cb = g - 128, Cr = b - 128;
          r = Y + 1.402 * Cr;
          g = Y - 0.344136 * Cb - 0.714136 * Cr;
          b = Y + 1.772 * Cb;
        }
        if (opts.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
        out[i * 4]     = r < 0 ? 0 : r > 255 ? 255 : r;
        out[i * 4 + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[i * 4 + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        out[i * 4 + 3] = 255;
      }
      return imageData;
    }

    var lut = this.buildLut(opts);
    var min = this.storedMin;
    var last = lut.length - 1;
    for (i = 0; i < count; i++) {
      var idx = px[i] - min;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      var v = lut[idx];
      p = i * 4;
      out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255;
    }
    return imageData;
  };

  function lookupPalette(channel, value, invert) {
    var i = value - channel.first;
    if (i < 0) i = 0;
    if (i >= channel.data.length) i = channel.data.length - 1;
    var v = channel.data[i];
    if (channel.bits > 8) v = v >> (channel.bits - 8);
    if (v > 255) v = 255;
    return invert ? 255 - v : v;
  }

  /* Loads frame `index` of a dataset and wraps it as a Frame. */
  function loadFrame(dataSet, index) {
    return global.DICOMDecode.decodeFrame(dataSet, index).then(function (res) {
      return new Frame(dataSet, res.pixels, res.info, index);
    });
  }

  global.DICOMImage = {
    Frame: Frame,
    loadFrame: loadFrame,
    WINDOW_PRESETS: WINDOW_PRESETS,
    windowedByte: windowedByte,
    TAGS: T
  };
})(this);
