/* app.js — application shell: loading, series assembly, UI and interaction. */
(function (global) {
  'use strict';

  var T = {
    sopInstanceUid: '00080018', studyUid: '0020000d', seriesUid: '0020000e',
    studyDate: '00080020', studyTime: '00080030', studyDescription: '00081030',
    seriesDescription: '0008103e', seriesNumber: '00200011', instanceNumber: '00200013',
    modality: '00080060', institution: '00080080', manufacturer: '00080070',
    model: '00081090', stationName: '00081010', bodyPart: '00180015',
    patientName: '00100010', patientId: '00100020', patientBirthDate: '00100030',
    patientSex: '00100040', patientAge: '00101010', accession: '00080050',
    imagePosition: '00200032', imageOrientation: '00200037', sliceLocation: '00201041',
    sliceThickness: '00180050', spacingBetweenSlices: '00180088',
    kvp: '00180060', exposure: '00181152', tubeCurrent: '00181151',
    repetitionTime: '00180080', echoTime: '00180081', flipAngle: '00181314',
    magneticFieldStrength: '00180087', protocolName: '00181030',
    numberOfFrames: '00280008', frameTime: '00181063',
    patientPosition: '00185100', imageType: '00080008', kernel: '00181210',
    windowCenter: '00281050', windowWidth: '00281051', pixelData: '7fe00010'
  };

  var MAX_CACHED_FRAMES = 48;

  var state = {
    series: [],
    activeSeries: -1,
    activeIndex: 0,
    activeFrame: 0,
    tool: 'window',
    annotations: Object.create(null),
    selected: null,
    pending: null,
    showOverlay: true,
    cine: { playing: false, timer: null, fps: 15 },
    frames: new Map(),
    loadToken: 0
  };

  var dom = {};
  var viewport = null;
  var drag = null;
  var thumbQueue = [];
  var thumbRunning = false;

  /* Moving through a series is cheap; painting a frame is not. Wheel and
   * scrubber input arrive far faster than a frame can be decoded, so the paint
   * is coalesced onto an animation frame and never more than one runs at a
   * time. The latest position wins and the ones scrolled past are dropped. */
  var nav = { raf: 0, busy: false, dirty: false };

  /* The metadata tree is only built while its tab is on screen, and only when
   * it would actually differ — see renderMetadata. */
  var metaDirty = true;
  var metaShown = { dataSet: null, filter: null };

  /* ------------------------------------------------------------ formatting */

  /* DICOM person names are Family^Given^Middle^Prefix^Suffix. */
  function formatPersonName(raw) {
    if (!raw) return '';
    var parts = raw.split('^');
    var family = (parts[0] || '').trim();
    var given = (parts[1] || '').trim();
    var middle = (parts[2] || '').trim();
    var prefix = (parts[3] || '').trim();
    var suffix = (parts[4] || '').trim();
    var tail = [given, middle].filter(Boolean).join(' ');
    var name = family && tail ? family + ', ' + tail : (family || tail);
    if (prefix) name = prefix + ' ' + name;
    if (suffix) name = name + ', ' + suffix;
    return name.trim() || raw;
  }

  function formatDate(raw) {
    if (!raw || raw.length < 8) return raw || '';
    return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
  }

  function formatTime(raw) {
    if (!raw || raw.length < 4) return raw || '';
    var s = raw.slice(0, 2) + ':' + raw.slice(2, 4);
    if (raw.length >= 6) s += ':' + raw.slice(4, 6);
    return s;
  }

  function formatAge(raw) {
    if (!raw) return '';
    var m = /^(\d{3})([DWMY])$/.exec(raw.trim());
    if (!m) return raw;
    var n = parseInt(m[1], 10);
    return n + ' ' + { D: 'days', W: 'weeks', M: 'months', Y: 'y' }[m[2]];
  }

  function formatNumber(v, digits) {
    if (v === undefined || v === null || !isFinite(v)) return '';
    var d = digits === undefined ? 1 : digits;
    return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(d);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function bytesLabel(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* ---------------------------------------------------------- file loading */

  function isProbablyDicom(file) {
    if (/\.(dcm|dicom|ima|img)$/i.test(file.name)) return true;
    if (/^DICOMDIR$/i.test(file.name)) return false;
    /* Many exports have no extension at all; let those through and let the
     * parser decide. Skip obvious non-images so folder drops stay fast. */
    return !/\.(jpg|jpeg|png|gif|pdf|txt|xml|html|zip|gz|tar|doc|docx|csv|json|md|ini|db)$/i.test(file.name);
  }

  /* A selection may contain archives; those are expanded into their entries
   * first, and everything downstream treats the result as ordinary files. */
  function loadFiles(fileList) {
    var token = ++state.loadToken;
    var selection = Array.prototype.slice.call(fileList);
    var hasArchive = selection.some(global.DICOMArchive.looksLikeArchive);

    if (!hasArchive) {
      readAll(selection, [], token);
      return;
    }

    showLoading(true, 'Opening archive…');
    global.DICOMArchive.expandAll(selection, setLoadingText).then(function (res) {
      if (token !== state.loadToken) return;
      readAll(res.files, res.notes, token);
    });
  }

  function readAll(fileList, notes, token) {
    var files = fileList.filter(isProbablyDicom);
    if (!files.length) {
      showLoading(false);
      showMessage(notes.length ? notes.join(' ') : 'No DICOM files found in that selection.');
      return;
    }

    var loaded = [];
    var skipped = [];
    var index = 0;

    showLoading(true, 'Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…');

    function step() {
      if (token !== state.loadToken) return;
      var batchEnd = Math.min(index + 8, files.length);
      var jobs = [];
      for (; index < batchEnd; index++) jobs.push(readOne(files[index]));

      Promise.all(jobs).then(function (results) {
        results.forEach(function (r) {
          if (r.ok) loaded.push(r.instance);
          else skipped.push(r);
        });
        if (index < files.length) {
          setLoadingText('Reading ' + index + ' of ' + files.length + '…');
          setTimeout(step, 0);
        } else {
          finish();
        }
      });
    }

    function finish() {
      if (token !== state.loadToken) return;
      showLoading(false);
      var prefix = notes.length ? notes.join(' ') + ' ' : '';
      if (!loaded.length) {
        showMessage(prefix + 'None of those files could be read as DICOM.' +
          (skipped.length ? ' First problem: ' + skipped[0].error : ''));
        return;
      }
      mergeInstances(loaded);
      if (skipped.length) {
        showMessage(prefix + skipped.length + ' of ' + files.length + ' file' +
          (files.length === 1 ? '' : 's') + ' could not be read (' + skipped[0].error + ').');
      } else if (prefix) {
        showMessage(notes.join(' '));
      }
    }

    step();
  }

  function readOne(file) {
    return file.arrayBuffer()
      .then(function (buffer) { return global.DICOMParser.parse(buffer); })
      .then(function (dataSet) {
        if (!dataSet.has(T.pixelData) && !dataSet.has('7fe00008') && !dataSet.has('7fe00009')) {
          throw new Error('no image data in ' + file.name);
        }
        return { ok: true, instance: makeInstance(dataSet, file) };
      })
      .catch(function (err) {
        return { ok: false, name: file.name, error: (err && err.message) || 'unreadable' };
      });
  }

  function makeInstance(dataSet, file) {
    var frames = Math.max(1, parseInt(dataSet.string(T.numberOfFrames) || '1', 10) || 1);
    return {
      dataSet: dataSet,
      fileName: file.name,
      fileSize: file.size,
      sopInstanceUid: dataSet.string(T.sopInstanceUid) || file.name,
      instanceNumber: parseInt(dataSet.string(T.instanceNumber) || '0', 10) || 0,
      position: dataSet.numbers(T.imagePosition),
      orientation: dataSet.numbers(T.imageOrientation),
      sliceLocation: dataSet.number(T.sliceLocation),
      numberOfFrames: frames,
      thumbnail: null
    };
  }

  /* Groups instances into series and merges them into whatever is loaded. */
  function mergeInstances(instances) {
    var bySeries = Object.create(null);
    state.series.forEach(function (s) { bySeries[s.key] = s; });

    instances.forEach(function (inst) {
      var ds = inst.dataSet;
      var key = ds.string(T.seriesUid) ||
        (ds.string(T.studyUid) || '') + '|' + (ds.string(T.seriesNumber) || '') + '|' + (ds.string(T.modality) || '');
      if (!key.trim()) key = 'ungrouped';

      var series = bySeries[key];
      if (!series) {
        series = {
          key: key,
          uid: ds.string(T.seriesUid) || '',
          number: parseInt(ds.string(T.seriesNumber) || '0', 10) || 0,
          modality: ds.string(T.modality) || '?',
          description: ds.string(T.seriesDescription) || ds.string(T.studyDescription) || '(no description)',
          studyUid: ds.string(T.studyUid) || '',
          studyDescription: ds.string(T.studyDescription) || '',
          studyDate: ds.string(T.studyDate) || '',
          patientName: ds.string(T.patientName) || '',
          instances: []
        };
        bySeries[key] = series;
        state.series.push(series);
      }
      /* Re-loading the same file should not duplicate it. */
      var already = series.instances.some(function (i) {
        return i.sopInstanceUid === inst.sopInstanceUid && i.fileName === inst.fileName;
      });
      if (!already) series.instances.push(inst);
    });

    state.series.forEach(sortSeries);
    state.series.sort(function (a, b) {
      if (a.studyUid !== b.studyUid) return String(a.studyUid).localeCompare(String(b.studyUid));
      return (a.number || 0) - (b.number || 0);
    });

    renderSeriesList();
    /* One thumbnail per series, so the rail is legible before anything is
     * clicked. They render one at a time, off the interaction path. */
    state.series.forEach(function (s, i) { queueThumbnails(i); });
    if (state.activeSeries < 0) selectSeries(0, 0);
    else refreshScrub();
  }

  /* Orders slices along the scan axis when geometry is available, so a series
   * scrolls anatomically rather than in whatever order the files arrived. */
  function sortSeries(series) {
    var ref = series.instances.find(function (i) { return i.orientation && i.orientation.length === 6; });
    if (ref) {
      var o = ref.orientation;
      var normal = [
        o[1] * o[5] - o[2] * o[4],
        o[2] * o[3] - o[0] * o[5],
        o[0] * o[4] - o[1] * o[3]
      ];
      var usable = series.instances.every(function (i) { return i.position && i.position.length === 3; });
      if (usable) {
        series.instances.forEach(function (i) {
          i.axis = i.position[0] * normal[0] + i.position[1] * normal[1] + i.position[2] * normal[2];
        });
        series.instances.sort(function (a, b) {
          if (a.axis !== b.axis) return a.axis - b.axis;
          return a.instanceNumber - b.instanceNumber;
        });
        series.sortedBy = 'position';
        return;
      }
    }
    series.instances.sort(function (a, b) {
      if (a.instanceNumber !== b.instanceNumber) return a.instanceNumber - b.instanceNumber;
      return a.fileName.localeCompare(b.fileName, undefined, { numeric: true });
    });
    series.sortedBy = 'instance number';
  }

  /* ----------------------------------------------------------- frame access */

  function frameKey(seriesIdx, instanceIdx, frame) {
    return seriesIdx + ':' + instanceIdx + ':' + frame;
  }

  function getFrame(seriesIdx, instanceIdx, frameIdx) {
    var key = frameKey(seriesIdx, instanceIdx, frameIdx);
    var cached = state.frames.get(key);
    if (cached) {
      /* refresh LRU position */
      state.frames.delete(key);
      state.frames.set(key, cached);
      return Promise.resolve(cached);
    }
    var series = state.series[seriesIdx];
    if (!series) return Promise.reject(new Error('No series selected.'));
    var inst = series.instances[instanceIdx];
    if (!inst) return Promise.reject(new Error('No image at that position.'));

    return global.DICOMImage.loadFrame(inst.dataSet, frameIdx).then(function (frame) {
      state.frames.set(key, frame);
      while (state.frames.size > MAX_CACHED_FRAMES) {
        state.frames.delete(state.frames.keys().next().value);
      }
      return frame;
    });
  }

  function currentInstance() {
    var s = state.series[state.activeSeries];
    return s ? s.instances[state.activeIndex] : null;
  }

  function annotationKey() {
    var inst = currentInstance();
    if (!inst) return null;
    return inst.sopInstanceUid + '#' + state.activeFrame;
  }

  function currentAnnotations() {
    var key = annotationKey();
    if (!key) return [];
    if (!state.annotations[key]) state.annotations[key] = [];
    return state.annotations[key];
  }

  /* ------------------------------------------------------------- selection */

  function selectSeries(seriesIdx, instanceIdx) {
    if (seriesIdx < 0 || seriesIdx >= state.series.length) return;
    var changed = seriesIdx !== state.activeSeries;
    state.activeSeries = seriesIdx;
    state.activeIndex = Math.max(0, Math.min(instanceIdx || 0, state.series[seriesIdx].instances.length - 1));
    state.activeFrame = 0;
    stopCine();
    /* Drop any paint still queued for the series we are leaving. */
    nav.dirty = false;
    renderSeriesList();
    showCurrent(!changed).then(function () {
      if (changed) { viewport.fitToWindow(); redraw(); }
    });
    queueThumbnails(seriesIdx);
  }

  function showCurrent(keepView) {
    var seriesIdx = state.activeSeries;
    var instanceIdx = state.activeIndex;
    var frameIdx = state.activeFrame;
    hideDropzone();

    return getFrame(seriesIdx, instanceIdx, frameIdx).then(function (frame) {
      if (seriesIdx !== state.activeSeries || instanceIdx !== state.activeIndex || frameIdx !== state.activeFrame) return;
      hideMessage();
      viewport.setFrame(frame, keepView);
      if (!keepView) viewport.fitToWindow();
      populatePresets(frame);
      refreshScrub();
      redraw();
      renderInfo();
      renderMetadata();
      renderMeasurements();
    }).catch(function (err) {
      if (seriesIdx !== state.activeSeries || instanceIdx !== state.activeIndex) return;
      viewport.frame = null;
      viewport.draw();
      clearOverlay();
      showMessage(err.message || String(err));
      refreshScrub();
      renderInfo();
      renderMetadata();
    });
  }

  /* Requests a paint of whatever position the state now holds. Repeated calls
   * within one animation frame collapse into a single paint, and a paint that
   * is still decoding holds off the next one rather than queueing behind it. */
  function scheduleShow() {
    nav.dirty = true;
    if (nav.raf || nav.busy) return;
    nav.raf = global.requestAnimationFrame(function () {
      nav.raf = 0;
      if (!nav.dirty) return;
      nav.dirty = false;
      nav.busy = true;
      showCurrent(true).then(function () {
        nav.busy = false;
        if (nav.dirty) scheduleShow();
      });
    });
  }

  /* The scrubber is cheap enough to track the scroll exactly, so it updates
   * straight away while the image itself catches up. */
  function afterNavigate() {
    refreshScrub();
    scheduleShow();
  }

  function step(delta) {
    var series = state.series[state.activeSeries];
    if (!series) return;
    var inst = series.instances[state.activeIndex];
    if (!inst) return;

    if (inst.numberOfFrames > 1) {
      var f = state.activeFrame + delta;
      if (f >= 0 && f < inst.numberOfFrames) {
        state.activeFrame = f;
        afterNavigate();
        return;
      }
      /* Fall through to the next instance when running off either end. */
      var nextIdx = state.activeIndex + (delta > 0 ? 1 : -1);
      if (nextIdx >= 0 && nextIdx < series.instances.length) {
        state.activeIndex = nextIdx;
        var next = series.instances[nextIdx];
        state.activeFrame = delta > 0 ? 0 : next.numberOfFrames - 1;
        afterNavigate();
      }
      return;
    }

    var idx = state.activeIndex + delta;
    if (idx < 0 || idx >= series.instances.length) return;
    state.activeIndex = idx;
    state.activeFrame = 0;
    afterNavigate();
  }

  function goTo(position) {
    var series = state.series[state.activeSeries];
    if (!series) return;
    var inst = series.instances[state.activeIndex];
    if (inst && inst.numberOfFrames > 1) {
      state.activeFrame = Math.max(0, Math.min(position, inst.numberOfFrames - 1));
    } else {
      state.activeIndex = Math.max(0, Math.min(position, series.instances.length - 1));
      state.activeFrame = 0;
    }
    afterNavigate();
  }

  function scrubExtent() {
    var series = state.series[state.activeSeries];
    if (!series) return { count: 0, position: 0 };
    var inst = series.instances[state.activeIndex];
    if (inst && inst.numberOfFrames > 1) return { count: inst.numberOfFrames, position: state.activeFrame, unit: 'frame' };
    return { count: series.instances.length, position: state.activeIndex, unit: 'image' };
  }

  /* ------------------------------------------------------------------ cine */

  function toggleCine() { state.cine.playing ? stopCine() : startCine(); }

  function startCine() {
    var extent = scrubExtent();
    if (extent.count < 2) return;
    state.cine.playing = true;
    dom.btnCine.querySelector('use').setAttribute('href', '#i-pause');
    dom.btnCine.classList.add('active');
    var interval = 1000 / Math.max(1, Math.min(60, state.cine.fps));
    state.cine.timer = setInterval(function () {
      var e = scrubExtent();
      if (e.count < 2) return stopCine();
      var next = (e.position + 1) % e.count;
      goTo(next);
    }, interval);
  }

  function stopCine() {
    state.cine.playing = false;
    if (state.cine.timer) clearInterval(state.cine.timer);
    state.cine.timer = null;
    if (dom.btnCine) {
      dom.btnCine.querySelector('use').setAttribute('href', '#i-play');
      dom.btnCine.classList.remove('active');
    }
  }

  /* --------------------------------------------------------------- drawing */

  function redraw() {
    viewport.draw();
    if (viewport.frame) {
      var ctx = viewport.ctx;
      ctx.save();
      ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
      global.DICOMTools.draw(ctx, viewport, currentAnnotations(), state.selected && state.selected.id);
      ctx.restore();
    }
    updateOverlay();
    updateStatus();
  }

  /* Maps an image-space direction onto the screen edge it now points at. */
  function screenEdge(dx, dy) {
    var fx = viewport.flipH ? -1 : 1;
    var fy = viewport.flipV ? -1 : 1;
    var rad = viewport.rotation * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var x = dx * fx, y = dy * fy;
    var sx = x * cos - y * sin;
    var sy = x * sin + y * cos;
    if (Math.abs(sx) >= Math.abs(sy)) return sx > 0 ? 'right' : 'left';
    return sy > 0 ? 'bottom' : 'top';
  }

  /* Patient-relative letter for an LPS direction vector. */
  function orientationLabel(v) {
    if (!v) return '';
    var axes = [
      { letter: v[0] < 0 ? 'R' : 'L', mag: Math.abs(v[0]) },
      { letter: v[1] < 0 ? 'A' : 'P', mag: Math.abs(v[1]) },
      { letter: v[2] < 0 ? 'F' : 'H', mag: Math.abs(v[2]) }
    ].sort(function (a, b) { return b.mag - a.mag; });
    var out = '';
    for (var i = 0; i < axes.length; i++) {
      if (axes[i].mag > 0.15) out += axes[i].letter;
    }
    return out.slice(0, 2);
  }

  function clearOverlay() {
    ['ovTL', 'ovTR', 'ovBL', 'ovBR', 'ovTop', 'ovBottom', 'ovLeft', 'ovRight'].forEach(function (k) {
      if (dom[k]) dom[k].textContent = '';
    });
  }

  function updateOverlay() {
    if (!dom.overlay) return;
    dom.overlay.hidden = !state.showOverlay;
    if (!state.showOverlay || !viewport.frame) { clearOverlay(); return; }

    var inst = currentInstance();
    if (!inst) { clearOverlay(); return; }
    var ds = inst.dataSet;
    var series = state.series[state.activeSeries];
    var frame = viewport.frame;

    var tl = [];
    var name = formatPersonName(ds.string(T.patientName));
    if (name) tl.push(name);
    var idLine = [];
    if (ds.string(T.patientId)) idLine.push(ds.string(T.patientId));
    if (ds.string(T.patientSex)) idLine.push(ds.string(T.patientSex));
    if (ds.string(T.patientAge)) idLine.push(formatAge(ds.string(T.patientAge)));
    else if (ds.string(T.patientBirthDate)) idLine.push(formatDate(ds.string(T.patientBirthDate)));
    if (idLine.length) tl.push(idLine.join('  ·  '));
    if (ds.string(T.accession)) tl.push('Acc ' + ds.string(T.accession));

    var tr = [];
    if (ds.string(T.institution)) tr.push(ds.string(T.institution));
    if (series.studyDescription) tr.push(series.studyDescription);
    if (series.description) tr.push(series.description);
    var when = [formatDate(ds.string(T.studyDate)), formatTime(ds.string(T.studyTime))].filter(Boolean).join(' ');
    if (when) tr.push(when);

    var bl = [];
    var extent = scrubExtent();
    bl.push('Series ' + (series.number || '—') + '  ·  ' +
      (extent.unit === 'frame' ? 'Frame ' : 'Image ') + (extent.position + 1) + ' / ' + extent.count);
    if (inst.sliceLocation !== undefined && isFinite(inst.sliceLocation)) bl.push('Loc ' + formatNumber(inst.sliceLocation, 2) + ' mm');
    if (ds.number(T.sliceThickness) !== undefined) bl.push('Thk ' + formatNumber(ds.number(T.sliceThickness), 2) + ' mm');
    var tech = [];
    if (ds.number(T.kvp) !== undefined) tech.push(formatNumber(ds.number(T.kvp), 0) + ' kVp');
    if (ds.number(T.tubeCurrent) !== undefined) tech.push(formatNumber(ds.number(T.tubeCurrent), 0) + ' mA');
    if (ds.number(T.repetitionTime) !== undefined) tech.push('TR ' + formatNumber(ds.number(T.repetitionTime), 0));
    if (ds.number(T.echoTime) !== undefined) tech.push('TE ' + formatNumber(ds.number(T.echoTime), 1));
    if (tech.length) bl.push(tech.join('  ·  '));

    var br = [];
    if (!frame.color) {
      if (viewport.voiLutIndex >= 0 && frame.voiLuts[viewport.voiLutIndex]) {
        br.push('VOI LUT: ' + frame.voiLuts[viewport.voiLutIndex].label);
      } else {
        br.push('W ' + formatNumber(viewport.windowWidth, 0) + '  L ' + formatNumber(viewport.windowCenter, 0));
      }
    }
    br.push('Zoom ' + Math.round(viewport.zoom * 100) + '%');
    br.push(frame.columns + ' × ' + frame.rows + (frame.info.samplesPerPixel > 1 ? '  RGB' : '  ' + frame.info.bitsStored + '-bit'));
    if (viewport.invert) br.push('INVERTED');
    if (!frame.spacing.calibrated) br.push('UNCALIBRATED');

    dom.ovTL.innerHTML = tl.map(escapeHtml).join('<br>');
    dom.ovTR.innerHTML = tr.map(escapeHtml).join('<br>');
    dom.ovBL.innerHTML = bl.map(escapeHtml).join('<br>');
    dom.ovBR.innerHTML = br.map(escapeHtml).join('<br>');

    /* Orientation letters, repositioned for the current rotation and flips. */
    var edges = { top: '', bottom: '', left: '', right: '' };
    if (inst.orientation && inst.orientation.length === 6) {
      var row = inst.orientation.slice(0, 3);
      var col = inst.orientation.slice(3, 6);
      var neg = function (v) { return [-v[0], -v[1], -v[2]]; };
      edges[screenEdge(1, 0)] = orientationLabel(row);
      edges[screenEdge(-1, 0)] = orientationLabel(neg(row));
      edges[screenEdge(0, 1)] = orientationLabel(col);
      edges[screenEdge(0, -1)] = orientationLabel(neg(col));
    }
    dom.ovTop.textContent = edges.top;
    dom.ovBottom.textContent = edges.bottom;
    dom.ovLeft.textContent = edges.left;
    dom.ovRight.textContent = edges.right;
  }

  function updateStatus(imagePoint) {
    var inst = currentInstance();
    dom.statusFile.textContent = inst ? inst.fileName : 'No file';

    if (viewport.frame) {
      dom.statusWindow.textContent = viewport.frame.color ? 'RGB' :
        'W ' + formatNumber(viewport.windowWidth, 0) + ' / L ' + formatNumber(viewport.windowCenter, 0);
      dom.statusZoom.textContent = Math.round(viewport.zoom * 100) + '%';
    } else {
      dom.statusWindow.textContent = '';
      dom.statusZoom.textContent = '';
    }

    if (imagePoint && viewport.frame) {
      var x = Math.floor(imagePoint.x), y = Math.floor(imagePoint.y);
      if (x >= 0 && y >= 0 && x < viewport.frame.columns && y < viewport.frame.rows) {
        dom.statusPosition.textContent = '(' + x + ', ' + y + ')';
        var v = viewport.frame.valueAt(x, y);
        if (v && v.color) dom.statusValue.textContent = 'R ' + v.r + ' G ' + v.g + ' B ' + v.b;
        else if (v) dom.statusValue.textContent = formatNumber(v.value, 1) + (v.unit ? ' ' + v.unit : '');
      } else {
        dom.statusPosition.textContent = '';
        dom.statusValue.textContent = '';
      }
    } else if (!imagePoint) {
      dom.statusPosition.textContent = '';
      dom.statusValue.textContent = '';
    }
  }

  function refreshScrub() {
    var extent = scrubExtent();
    var show = extent.count > 1;
    dom.scrub.hidden = !show;
    if (!show) return;
    dom.scrubRange.max = String(extent.count - 1);
    dom.scrubRange.value = String(extent.position);
    dom.scrubLabel.textContent = (extent.position + 1) + ' / ' + extent.count +
      (extent.unit === 'frame' ? ' frames' : '');
  }

  /* --------------------------------------------------------------- panels */

  function renderSeriesList() {
    dom.seriesCount.textContent = String(state.series.length);
    if (!state.series.length) {
      dom.seriesList.innerHTML = '<p class="panel-empty">No images loaded.</p>';
      return;
    }

    var html = '';
    var lastStudy = null;
    state.series.forEach(function (series, si) {
      if (series.studyUid !== lastStudy) {
        lastStudy = series.studyUid;
        var header = [series.studyDescription || 'Study', formatDate(series.studyDate)].filter(Boolean).join(' · ');
        html += '<div class="study-head">' + escapeHtml(header) + '</div>';
      }
      var active = si === state.activeSeries;
      var representative = series.instances[Math.floor(series.instances.length / 2)] || series.instances[0];
      var thumb = representative && representative.thumbnail;
      html += '<button class="series-item' + (active ? ' active' : '') + '" data-series="' + si + '" type="button" role="option" aria-selected="' + active + '">' +
        '<span class="series-thumb">' + (thumb ? '<img src="' + thumb + '" alt="">' : '') + '</span>' +
        '<span class="series-meta">' +
          '<span class="series-title">' + escapeHtml(series.description) + '</span>' +
          '<span class="series-sub"><em class="modality">' + escapeHtml(series.modality) + '</em>' +
            ' · #' + (series.number || '—') +
            ' · ' + series.instances.length + ' image' + (series.instances.length === 1 ? '' : 's') +
          '</span>' +
        '</span>' +
      '</button>';
    });
    dom.seriesList.innerHTML = html;
  }

  /* Thumbnails are rendered one at a time off the main interaction path. */
  function queueThumbnails(seriesIdx) {
    var series = state.series[seriesIdx];
    if (!series) return;
    var target = series.instances[Math.floor(series.instances.length / 2)] || series.instances[0];
    if (!target || target.thumbnail) return;
    thumbQueue.push({ seriesIdx: seriesIdx, instance: target });
    runThumbnails();
  }

  function runThumbnails() {
    if (thumbRunning || !thumbQueue.length) return;
    thumbRunning = true;
    var job = thumbQueue.shift();
    global.DICOMImage.loadFrame(job.instance.dataSet, 0).then(function (frame) {
      var size = 56;
      var scale = Math.min(size / frame.columns, size / frame.rows);
      var w = Math.max(1, Math.round(frame.columns * scale));
      var h = Math.max(1, Math.round(frame.rows * scale));

      var full = document.createElement('canvas');
      full.width = frame.columns;
      full.height = frame.rows;
      var fctx = full.getContext('2d');
      var img = fctx.createImageData(frame.columns, frame.rows);
      var w0 = frame.defaultWindow();
      frame.render(img, {
        center: w0.center !== null ? w0.center : (frame.valueMax + frame.valueMin) / 2,
        width: w0.width !== null ? w0.width : Math.max(1, frame.valueMax - frame.valueMin),
        lutIndex: w0.lutIndex, invert: false, voiFunction: frame.voiFunction
      });
      fctx.putImageData(img, 0, 0);

      var thumb = document.createElement('canvas');
      thumb.width = w;
      thumb.height = h;
      thumb.getContext('2d').drawImage(full, 0, 0, w, h);
      job.instance.thumbnail = thumb.toDataURL('image/png');
      renderSeriesList();
    }).catch(function () {
      job.instance.thumbnail = null;
    }).then(function () {
      thumbRunning = false;
      if (thumbQueue.length) setTimeout(runThumbnails, 0);
    });
  }

  function infoRow(label, value) {
    if (value === undefined || value === null || value === '') return '';
    return '<div class="info-row"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd></div>';
  }

  function renderInfo() {
    var inst = currentInstance();
    if (!inst) {
      dom.infoBody.innerHTML = '<p class="panel-empty">No image selected.</p>';
      return;
    }
    var ds = inst.dataSet;
    var series = state.series[state.activeSeries];
    var frame = viewport.frame;
    var html = '';

    html += '<section class="info-group"><h3>Patient</h3><dl>';
    html += infoRow('Name', formatPersonName(ds.string(T.patientName)));
    html += infoRow('ID', ds.string(T.patientId));
    html += infoRow('Birth date', formatDate(ds.string(T.patientBirthDate)));
    html += infoRow('Sex', ds.string(T.patientSex));
    html += infoRow('Age', formatAge(ds.string(T.patientAge)));
    html += '</dl></section>';

    html += '<section class="info-group"><h3>Study &amp; series</h3><dl>';
    html += infoRow('Study', series.studyDescription);
    html += infoRow('Date', [formatDate(ds.string(T.studyDate)), formatTime(ds.string(T.studyTime))].filter(Boolean).join(' '));
    html += infoRow('Accession', ds.string(T.accession));
    html += infoRow('Series', series.description);
    html += infoRow('Modality', series.modality);
    html += infoRow('Body part', ds.string(T.bodyPart));
    html += infoRow('Protocol', ds.string(T.protocolName));
    html += infoRow('Sorted by', series.sortedBy);
    html += '</dl></section>';

    if (frame) {
      html += '<section class="info-group"><h3>Image</h3><dl>';
      html += infoRow('Dimensions', frame.columns + ' × ' + frame.rows + ' px');
      html += infoRow('Frames', inst.numberOfFrames > 1 ? inst.numberOfFrames : '1');
      html += infoRow('Photometric', frame.info.photometric);
      html += infoRow('Bits', frame.info.bitsStored + ' stored / ' + frame.info.bitsAllocated + ' allocated' +
        (frame.info.pixelRepresentation === 1 ? ', signed' : ', unsigned'));
      html += infoRow('Pixel spacing', frame.spacing.calibrated
        ? formatNumber(frame.spacing.row, 4) + ' × ' + formatNumber(frame.spacing.column, 4) + ' mm (' + frame.spacing.source + ')'
        : 'not specified — measurements are in pixels');
      html += infoRow('Rescale', frame.modality.lut ? 'Modality LUT Sequence'
        : 'slope ' + frame.modality.slope + ', intercept ' + frame.modality.intercept + (frame.modality.type ? ' → ' + frame.modality.type : ''));
      html += infoRow('Value range', formatNumber(frame.valueMin, 1) + ' … ' + formatNumber(frame.valueMax, 1) + (frame.modality.type ? ' ' + frame.modality.type : ''));
      html += '</dl></section>';
    }

    html += '<section class="info-group"><h3>Source</h3><dl>';
    html += infoRow('File', inst.fileName);
    html += infoRow('Size', bytesLabel(inst.fileSize));
    html += infoRow('Transfer syntax', ds.syntax.name);
    html += infoRow('Equipment', [ds.string(T.manufacturer), ds.string(T.model)].filter(Boolean).join(' '));
    html += infoRow('Station', ds.string(T.stationName));
    html += '</dl></section>';

    dom.infoBody.innerHTML = html;
  }

  function valuePreview(ds, el, tag) {
    var P = global.DICOMParser;
    if (el.items) return '<span class="meta-note">' + el.items.length + ' item' + (el.items.length === 1 ? '' : 's') + '</span>';
    if (tag === '7fe00010' || tag === '7fe00008' || tag === '7fe00009') {
      return '<span class="meta-note">' + (el.encapsulated
        ? 'encapsulated, ' + el.fragments.fragments.length + ' fragment(s)'
        : bytesLabel(el.length)) + '</span>';
    }
    if (!el.length) return '<span class="meta-note">empty</span>';
    if (P.BINARY_VR[el.vr]) return '<span class="meta-note">' + bytesLabel(el.length) + '</span>';
    if (P.STRING_VR[el.vr]) {
      var s = ds.string(tag) || '';
      if (el.vr === 'PN') s = formatPersonName(s);
      if (s.length > 140) s = s.slice(0, 140) + '…';
      return escapeHtml(s);
    }
    var nums = ds.numbers(tag);
    if (!nums.length) return '<span class="meta-note">' + bytesLabel(el.length) + '</span>';
    if (nums.length > 12) return escapeHtml(nums.slice(0, 12).join(', ')) + ' <span class="meta-note">+' + (nums.length - 12) + ' more</span>';
    return escapeHtml(nums.join(', '));
  }

  function metaRows(ds, elements, depth, filter) {
    var tags = Object.keys(elements).sort();
    var html = '';
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      var el = elements[tag];
      var name = global.DICOMDictionary.nameOf(tag);
      var display = '(' + tag.slice(0, 4).toUpperCase() + ',' + tag.slice(4).toUpperCase() + ')';
      var matches = !filter ||
        display.toLowerCase().indexOf(filter) >= 0 ||
        name.toLowerCase().indexOf(filter) >= 0 ||
        tag.indexOf(filter.replace(/[^0-9a-f]/gi, '')) >= 0;

      var childHtml = '';
      if (el.items) {
        for (var k = 0; k < el.items.length; k++) {
          /* Read nested values out of the item itself — passing the top-level
           * dataset down made valuePreview look tags up in the wrong scope. */
          var inner = metaRows(ds.item(el.items[k]), el.items[k], depth + 1, matches ? '' : filter);
          if (inner) {
            childHtml += '<div class="meta-item"><div class="meta-item-head">Item ' + (k + 1) + '</div>' + inner + '</div>';
          }
        }
      }
      if (!matches && !childHtml) continue;

      html += '<div class="meta-row" style="--depth:' + depth + '">' +
        '<code class="meta-tag">' + display + '</code>' +
        '<span class="meta-name">' + escapeHtml(name) + '</span>' +
        '<span class="meta-vr">' + escapeHtml(el.vr) + '</span>' +
        '<span class="meta-value">' + valuePreview(ds, el, tag) + '</span>' +
      '</div>';
      if (childHtml) html += '<div class="meta-children">' + childHtml + '</div>';
    }
    return html;
  }

  /* An enhanced multi-frame object carries one Per-frame Functional Groups
   * item per frame, so its tag tree runs to five figures — around 8,000 rows
   * and 2 MB of HTML for a 112-frame MR. Rebuilding that on every scroll step,
   * into a tab that is usually not even on screen, was what made scrolling
   * crawl. Scrolling now just marks it stale; it is built when it is looked
   * at. */
  function renderMetadata() {
    metaDirty = true;
    if (dom.tabMeta && dom.tabMeta.classList.contains('active')) renderMetadataNow();
  }

  function renderMetadataNow() {
    metaDirty = false;
    var inst = currentInstance();
    if (!inst) {
      metaShown.dataSet = null;
      dom.metaBody.innerHTML = '<p class="panel-empty">No image selected.</p>';
      return;
    }
    var ds = inst.dataSet;
    var filter = (dom.metaFilter.value || '').trim().toLowerCase();
    /* The panel shows instance-level tags, so every frame of a multi-frame
     * object produces byte-identical markup. Scrolling through one keeps the
     * tree it already has rather than rebuilding tens of thousands of nodes. */
    if (metaShown.dataSet === ds && metaShown.filter === filter) return;
    metaShown.dataSet = ds;
    metaShown.filter = filter;
    var html = '';
    var metaKeys = Object.keys(ds.meta);
    if (metaKeys.length) {
      var metaHtml = metaRows(ds, ds.meta, 0, filter);
      if (metaHtml) html += '<div class="meta-section-head">File meta information</div>' + metaHtml;
    }
    var bodyHtml = metaRows(ds, ds.elements, 0, filter);
    if (bodyHtml) html += '<div class="meta-section-head">Dataset</div>' + bodyHtml;
    dom.metaBody.innerHTML = html || '<p class="panel-empty">Nothing matches that filter.</p>';
  }

  function renderMeasurements() {
    var list = currentAnnotations();
    if (!viewport.frame || !list.length) {
      dom.measureBody.innerHTML = '<p class="panel-empty">No measurements on this image.</p>';
      return;
    }
    var TL = global.DICOMTools.TOOL_LABELS;
    var html = '';
    list.forEach(function (a) {
      var lines = global.DICOMTools.labelLines(viewport.frame, a);
      html += '<div class="measure-item' + (state.selected && state.selected.id === a.id ? ' active' : '') + '" data-annotation="' + a.id + '">' +
        '<div class="measure-head"><span>' + escapeHtml(TL[a.type] || a.type) + '</span>' +
        '<button class="icon-btn" data-delete="' + a.id + '" type="button" aria-label="Delete measurement"><svg class="icon"><use href="#i-close"/></svg></button></div>' +
        '<div class="measure-value">' + lines.map(escapeHtml).join('<br>') + '</div>' +
      '</div>';
    });
    dom.measureBody.innerHTML = html;
  }

  function populatePresets(frame) {
    var select = dom.presetSelect;
    var html = '<option value="">Window preset…</option>';
    if (frame.voiLuts.length) {
      html += '<optgroup label="VOI LUT">';
      frame.voiLuts.forEach(function (lut, i) {
        html += '<option value="lut:' + i + '">' + escapeHtml(lut.label) + '</option>';
      });
      html += '</optgroup>';
    }
    if (frame.fileWindows.length) {
      html += '<optgroup label="From file">';
      frame.fileWindows.forEach(function (w, i) {
        html += '<option value="file:' + i + '">' + escapeHtml(w.label) + ' (W ' + formatNumber(w.width, 0) + ' / L ' + formatNumber(w.center, 0) + ')</option>';
      });
      html += '</optgroup>';
    }
    var modality = state.series[state.activeSeries] ? state.series[state.activeSeries].modality : '';
    if (modality === 'CT' || frame.modality.type === 'HU') {
      html += '<optgroup label="CT">';
      global.DICOMImage.WINDOW_PRESETS.forEach(function (p) {
        html += '<option value="preset:' + p.key + '">' + escapeHtml(p.label) + ' (W ' + p.width + ' / L ' + p.center + ')</option>';
      });
      html += '</optgroup>';
    }
    html += '<optgroup label="Computed"><option value="auto">Full value range</option></optgroup>';
    select.innerHTML = html;
    select.value = '';
    select.disabled = frame.color;
  }

  function applyPreset(value) {
    var frame = viewport.frame;
    if (!frame || !value) return;
    var parts = value.split(':');
    if (parts[0] === 'lut') {
      viewport.voiLutIndex = parseInt(parts[1], 10);
    } else if (parts[0] === 'file') {
      var w = frame.fileWindows[parseInt(parts[1], 10)];
      if (w) { viewport.voiLutIndex = -1; viewport.windowCenter = w.center; viewport.windowWidth = w.width; }
    } else if (parts[0] === 'preset') {
      var p = global.DICOMImage.WINDOW_PRESETS.find(function (x) { return x.key === parts[1]; });
      if (p) { viewport.voiLutIndex = -1; viewport.windowCenter = p.center; viewport.windowWidth = p.width; }
    } else if (value === 'auto') {
      viewport.voiLutIndex = -1;
      viewport.windowCenter = (frame.valueMax + frame.valueMin) / 2;
      viewport.windowWidth = Math.max(1, frame.valueMax - frame.valueMin);
    }
    viewport.repaintBuffer();
    redraw();
  }

  /* ---------------------------------------------------------- interaction */

  function canvasPoint(event) {
    var rect = dom.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function effectiveTool(event) {
    if (event.button === 1 || (event.button === 0 && event.altKey)) return 'pan';
    if (event.button === 2) return 'zoom';
    if (event.button === 0 && event.shiftKey) return 'pan';
    return state.tool;
  }

  function onPointerDown(event) {
    if (!viewport.frame) return;
    dom.canvas.focus();
    var point = canvasPoint(event);
    var tool = effectiveTool(event);
    var isMeasure = ['length', 'angle', 'rect', 'ellipse', 'probe'].indexOf(tool) >= 0;

    /* Grabbing an existing annotation always wins over starting a new one. */
    if (event.button === 0 && !event.altKey && !event.shiftKey) {
      var hit = global.DICOMTools.hitTest(viewport, currentAnnotations(), point);
      if (hit) {
        state.selected = hit.annotation;
        drag = {
          mode: 'annotation', handle: hit.handle, annotation: hit.annotation,
          last: viewport.screenToImage(point.x, point.y)
        };
        dom.canvas.setPointerCapture(event.pointerId);
        renderMeasurements();
        redraw();
        event.preventDefault();
        return;
      }
    }

    if (isMeasure && event.button === 0) {
      var img = viewport.screenToImage(point.x, point.y);
      if (state.pending && state.pending.type === 'angle' && state.pending.stage === 1) {
        /* Second click on an angle fixes the vertex; the third completes it. */
        state.pending.points.push({ x: img.x, y: img.y });
        state.pending.stage = 2;
        drag = { mode: 'annotation', handle: 2, annotation: state.pending, last: img };
        dom.canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      var created = global.DICOMTools.create(tool, img);
      currentAnnotations().push(created);
      state.selected = created;
      if (tool === 'angle') {
        state.pending = created;
        drag = { mode: 'annotation', handle: 1, annotation: created, last: img };
      } else if (tool === 'probe') {
        state.pending = null;
        drag = { mode: 'annotation', handle: 0, annotation: created, last: img };
      } else {
        state.pending = null;
        drag = { mode: 'annotation', handle: 1, annotation: created, last: img };
      }
      dom.canvas.setPointerCapture(event.pointerId);
      renderMeasurements();
      redraw();
      event.preventDefault();
      return;
    }

    drag = {
      mode: tool, start: point, last: point,
      startWindow: { c: viewport.windowCenter, w: viewport.windowWidth },
      startPan: { x: viewport.panX, y: viewport.panY },
      startZoom: viewport.zoom,
      startIndex: state.activeIndex
    };
    if (state.selected) { state.selected = null; renderMeasurements(); redraw(); }
    dom.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    var point = canvasPoint(event);

    if (!drag) {
      if (viewport.frame) updateStatus(viewport.screenToImage(point.x, point.y));
      return;
    }

    if (drag.mode === 'annotation') {
      var img = viewport.screenToImage(point.x, point.y);
      var a = drag.annotation;
      if (drag.handle >= 0) {
        while (a.points.length <= drag.handle) a.points.push({ x: img.x, y: img.y });
        a.points[drag.handle].x = img.x;
        a.points[drag.handle].y = img.y;
      } else {
        global.DICOMTools.translate(a, img.x - drag.last.x, img.y - drag.last.y);
      }
      drag.last = img;
      renderMeasurements();
      redraw();
      updateStatus(img);
      return;
    }

    var dx = point.x - drag.last.x;
    var dy = point.y - drag.last.y;

    if (drag.mode === 'window') {
      /* Scale sensitivity to the data range so both CT (thousands of HU) and
       * 8-bit images feel the same under the hand. */
      var frame = viewport.frame;
      var range = Math.max(1, frame.valueMax - frame.valueMin);
      var perPixel = range / 400;
      viewport.windowWidth = Math.max(1, viewport.windowWidth + dx * perPixel);
      viewport.windowCenter = viewport.windowCenter + dy * perPixel;
      viewport.voiLutIndex = -1;
      viewport.repaintBuffer();
      dom.presetSelect.value = '';
      redraw();
    } else if (drag.mode === 'pan') {
      viewport.panX += dx;
      viewport.panY += dy;
      redraw();
    } else if (drag.mode === 'zoom') {
      var factor = Math.exp(-dy * 0.008);
      setZoom(viewport.zoom * factor, drag.start);
      redraw();
    }
    drag.last = point;
  }

  function onPointerUp(event) {
    if (!drag) return;
    if (drag.mode === 'annotation') {
      var a = drag.annotation;
      if (a.type === 'angle' && a.stage === 1) {
        /* Waiting for the third point — keep it pending, don't finish. */
      } else {
        a.complete = true;
        state.pending = null;
        /* A click with no drag leaves a degenerate shape; drop it. */
        if ((a.type === 'length' || a.type === 'rect' || a.type === 'ellipse') &&
            Math.abs(a.points[0].x - a.points[1].x) < 0.5 && Math.abs(a.points[0].y - a.points[1].y) < 0.5) {
          removeAnnotation(a.id);
        }
      }
      renderMeasurements();
    }
    drag = null;
    if (dom.canvas.hasPointerCapture && dom.canvas.hasPointerCapture(event.pointerId)) {
      dom.canvas.releasePointerCapture(event.pointerId);
    }
    redraw();
  }

  function setZoom(next, anchor) {
    var clamped = Math.max(0.05, Math.min(60, next));
    if (anchor && viewport.frame) {
      /* Keep the point under the cursor fixed while zooming. */
      var before = viewport.screenToImage(anchor.x, anchor.y);
      viewport.zoom = clamped;
      var after = viewport.imageToScreen(before.x, before.y);
      viewport.panX += anchor.x - after.x;
      viewport.panY += anchor.y - after.y;
    } else {
      viewport.zoom = clamped;
    }
  }

  function onWheel(event) {
    if (!viewport.frame) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      setZoom(viewport.zoom * Math.exp(-event.deltaY * 0.0016), canvasPoint(event));
      redraw();
      return;
    }
    var extent = scrubExtent();
    if (extent.count < 2) return;
    step(event.deltaY > 0 ? 1 : -1);
  }

  function removeAnnotation(id) {
    var list = currentAnnotations();
    var i = list.findIndex(function (a) { return a.id === id; });
    if (i >= 0) list.splice(i, 1);
    if (state.selected && state.selected.id === id) state.selected = null;
    if (state.pending && state.pending.id === id) state.pending = null;
  }

  function setTool(tool) {
    state.tool = tool;
    state.pending = null;
    Array.prototype.forEach.call(dom.toolGroup.querySelectorAll('[data-tool]'), function (b) {
      var on = b.dataset.tool === tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    dom.canvas.dataset.tool = tool;
  }

  /* ------------------------------------------------------------- messages */

  function showMessage(text) {
    dom.stageMessageText.textContent = text;
    dom.stageMessage.hidden = false;
  }
  function hideMessage() { dom.stageMessage.hidden = true; }

  function showLoading(on, text) {
    dom.loading.hidden = !on;
    if (text) dom.loadingText.textContent = text;
  }
  function setLoadingText(text) { dom.loadingText.textContent = text; }

  function hideDropzone() { dom.dropzone.hidden = true; }

  /* ------------------------------------------------------- series drawer */

  /* Below the layout breakpoint the series rail slides in over the image
   * instead of holding a column of its own. Must match the media query in
   * app.css, which is the only place the rail becomes a drawer. */
  function narrowLayout() {
    return global.matchMedia && global.matchMedia('(max-width: 680px)').matches;
  }

  function setDrawer(open) {
    dom.panelLeft.classList.toggle('open', open);
    dom.scrim.classList.toggle('open', open);
    dom.btnMenu.setAttribute('aria-expanded', String(open));
    dom.btnMenu.setAttribute('aria-label', open ? 'Hide series' : 'Show series');
  }

  function closeDrawer() {
    if (dom.panelLeft.classList.contains('open')) setDrawer(false);
  }

  /* --------------------------------------------------------------- export */

  function exportPng() {
    if (!viewport.frame) return;
    var out = document.createElement('canvas');
    out.width = dom.canvas.width;
    out.height = dom.canvas.height;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(dom.canvas, 0, 0);

    if (state.showOverlay) {
      ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(214,228,238,0.92)';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 3;
      var pad = 12;
      var corners = [
        { el: dom.ovTL, x: pad, y: pad, align: 'left', baseline: 'top' },
        { el: dom.ovTR, x: viewport.width - pad, y: pad, align: 'right', baseline: 'top' },
        { el: dom.ovBL, x: pad, y: viewport.height - pad, align: 'left', baseline: 'bottom' },
        { el: dom.ovBR, x: viewport.width - pad, y: viewport.height - pad, align: 'right', baseline: 'bottom' }
      ];
      corners.forEach(function (c) {
        var lines = c.el.innerText.split('\n').filter(Boolean);
        ctx.textAlign = c.align;
        ctx.textBaseline = c.baseline === 'top' ? 'top' : 'alphabetic';
        lines.forEach(function (line, i) {
          var y = c.baseline === 'top' ? c.y + i * 15 : c.y - (lines.length - 1 - i) * 15;
          ctx.fillText(line, c.x, y);
        });
      });
    }

    var inst = currentInstance();
    var base = (inst ? inst.fileName.replace(/\.[^.]+$/, '') : 'image');
    out.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = base + '_view.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }, 'image/png');
  }

  /* ----------------------------------------------------------------- init */

  function cache() {
    var ids = {
      canvas: 'canvas', stage: 'stage', dropzone: 'dropzone', overlay: 'overlay',
      ovTL: 'ov-tl', ovTR: 'ov-tr', ovBL: 'ov-bl', ovBR: 'ov-br',
      ovTop: 'ov-top', ovBottom: 'ov-bottom', ovLeft: 'ov-left', ovRight: 'ov-right',
      seriesList: 'series-list', seriesCount: 'series-count',
      panelLeft: 'panel-left', scrim: 'scrim', btnMenu: 'btn-menu',
      infoBody: 'info-body', metaBody: 'meta-body', metaFilter: 'meta-filter',
      tabMeta: 'tab-meta',
      measureBody: 'measure-body', presetSelect: 'preset-select',
      statusFile: 'status-file', statusPosition: 'status-position', statusValue: 'status-value',
      statusWindow: 'status-window', statusZoom: 'status-zoom',
      scrub: 'scrub', scrubRange: 'scrub-range', scrubLabel: 'scrub-label',
      btnCine: 'btn-cine', cineFps: 'cine-fps',
      stageMessage: 'stage-message', stageMessageText: 'stage-message-text',
      loading: 'loading', loadingText: 'loading-text',
      toolGroup: 'tool-group', inputFiles: 'input-files', inputFolder: 'input-folder'
    };
    Object.keys(ids).forEach(function (k) { dom[k] = document.getElementById(ids[k]); });
  }

  function bind() {
    document.getElementById('btn-open-files').addEventListener('click', function () { dom.inputFiles.click(); });
    document.getElementById('btn-open-folder').addEventListener('click', function () { dom.inputFolder.click(); });
    dom.inputFiles.addEventListener('change', function (e) { loadFiles(e.target.files); e.target.value = ''; });
    dom.inputFolder.addEventListener('change', function (e) { loadFiles(e.target.files); e.target.value = ''; });

    dom.toolGroup.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tool]');
      if (btn) setTool(btn.dataset.tool);
    });

    dom.presetSelect.addEventListener('change', function (e) { applyPreset(e.target.value); });

    document.getElementById('btn-invert').addEventListener('click', function (e) {
      viewport.invert = !viewport.invert;
      e.currentTarget.classList.toggle('active', viewport.invert);
      e.currentTarget.setAttribute('aria-pressed', String(viewport.invert));
      viewport.repaintBuffer();
      redraw();
    });
    document.getElementById('btn-rot-left').addEventListener('click', function () { viewport.rotation = (viewport.rotation + 270) % 360; redraw(); });
    document.getElementById('btn-rot-right').addEventListener('click', function () { viewport.rotation = (viewport.rotation + 90) % 360; redraw(); });
    document.getElementById('btn-flip-h').addEventListener('click', function (e) { viewport.flipH = !viewport.flipH; e.currentTarget.classList.toggle('active', viewport.flipH); redraw(); });
    document.getElementById('btn-flip-v').addEventListener('click', function (e) { viewport.flipV = !viewport.flipV; e.currentTarget.classList.toggle('active', viewport.flipV); redraw(); });
    document.getElementById('btn-fit').addEventListener('click', function () { viewport.fitToWindow(); redraw(); });
    document.getElementById('btn-actual').addEventListener('click', function () { setZoom(1); viewport.panX = 0; viewport.panY = 0; redraw(); });
    document.getElementById('btn-reset').addEventListener('click', function () {
      viewport.resetView();
      if (viewport.frame) {
        var w = viewport.frame.defaultWindow();
        viewport.voiLutIndex = w.lutIndex;
        if (w.center !== null) { viewport.windowCenter = w.center; viewport.windowWidth = w.width; }
        viewport.repaintBuffer();
      }
      document.getElementById('btn-flip-h').classList.remove('active');
      document.getElementById('btn-flip-v').classList.remove('active');
      dom.presetSelect.value = '';
      redraw();
    });

    document.getElementById('btn-overlay').addEventListener('click', function (e) {
      state.showOverlay = !state.showOverlay;
      e.currentTarget.classList.toggle('active', state.showOverlay);
      e.currentTarget.setAttribute('aria-pressed', String(state.showOverlay));
      updateOverlay();
    });
    document.getElementById('btn-clear-annotations').addEventListener('click', function () {
      var key = annotationKey();
      if (key) state.annotations[key] = [];
      state.selected = null;
      state.pending = null;
      renderMeasurements();
      redraw();
    });
    document.getElementById('btn-export').addEventListener('click', exportPng);
    document.getElementById('stage-message-close').addEventListener('click', hideMessage);

    document.getElementById('btn-copy-measurements').addEventListener('click', function (e) {
      if (!viewport.frame) return;
      var text = global.DICOMTools.exportText(viewport.frame, currentAnnotations());
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () {
        var b = e.currentTarget;
        var original = b.textContent;
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = original; }, 1200);
      }).catch(function () { showMessage('Could not copy to the clipboard.'); });
    });

    dom.seriesList.addEventListener('click', function (e) {
      var item = e.target.closest('[data-series]');
      if (!item) return;
      selectSeries(parseInt(item.dataset.series, 10), 0);
      /* Picking a series is the reason the drawer was opened, so get it back
       * out of the way of the image. */
      closeDrawer();
    });

    dom.btnMenu.addEventListener('click', function () {
      setDrawer(!dom.panelLeft.classList.contains('open'));
    });
    dom.scrim.addEventListener('click', closeDrawer);

    dom.measureBody.addEventListener('click', function (e) {
      var del = e.target.closest('[data-delete]');
      if (del) {
        removeAnnotation(parseInt(del.dataset.delete, 10));
        renderMeasurements();
        redraw();
        return;
      }
      var item = e.target.closest('[data-annotation]');
      if (item) {
        var id = parseInt(item.dataset.annotation, 10);
        state.selected = currentAnnotations().find(function (a) { return a.id === id; }) || null;
        renderMeasurements();
        redraw();
      }
    });

    dom.metaFilter.addEventListener('input', renderMetadataNow);

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
          var on = t === tab;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', String(on));
        });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (p) {
          p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab);
        });
        /* Catch up on whatever was scrolled past while this tab was hidden. */
        if (tab.dataset.tab === 'meta' && metaDirty) renderMetadataNow();
      });
    });

    dom.scrubRange.addEventListener('input', function (e) { goTo(parseInt(e.target.value, 10)); });
    dom.btnCine.addEventListener('click', toggleCine);
    dom.cineFps.addEventListener('change', function (e) {
      state.cine.fps = Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 15));
      e.target.value = state.cine.fps;
      if (state.cine.playing) { stopCine(); startCine(); }
    });

    dom.canvas.addEventListener('pointerdown', onPointerDown);
    dom.canvas.addEventListener('pointermove', onPointerMove);
    dom.canvas.addEventListener('pointerup', onPointerUp);
    dom.canvas.addEventListener('pointercancel', onPointerUp);
    dom.canvas.addEventListener('pointerleave', function () { if (!drag) updateStatus(null); });
    dom.canvas.addEventListener('wheel', onWheel, { passive: false });
    dom.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    dom.canvas.addEventListener('dblclick', function () { viewport.fitToWindow(); redraw(); });

    /* Drag and drop, including folders dropped from the desktop. */
    ['dragenter', 'dragover'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        e.preventDefault();
        dom.stage.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        e.preventDefault();
        if (type === 'drop' || e.relatedTarget === null) dom.stage.classList.remove('drag-over');
      });
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      var items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        collectEntries(items).then(function (files) { if (files.length) loadFiles(files); });
      } else if (e.dataTransfer.files.length) {
        loadFiles(e.dataTransfer.files);
      }
    });

    document.addEventListener('keydown', onKeyDown);
    /* Rotating a phone or widening the window puts the rail back in its own
     * column, where a leftover "open" class would strand the scrim. */
    global.addEventListener('resize', function () {
      if (!narrowLayout()) closeDrawer();
      viewport.resize();
      redraw();
    });
  }

  /* Recursively walks dropped directory entries. */
  function collectEntries(items) {
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    var files = [];

    function walk(entry) {
      return new Promise(function (resolve) {
        if (entry.isFile) {
          entry.file(function (f) { files.push(f); resolve(); }, function () { resolve(); });
        } else if (entry.isDirectory) {
          var reader = entry.createReader();
          var all = [];
          (function readBatch() {
            reader.readEntries(function (batch) {
              if (!batch.length) {
                Promise.all(all.map(walk)).then(resolve);
                return;
              }
              all = all.concat(Array.prototype.slice.call(batch));
              readBatch();
            }, function () { resolve(); });
          })();
        } else resolve();
      });
    }
    return Promise.all(entries.map(walk)).then(function () { return files; });
  }

  function onKeyDown(e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    var handled = true;
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': case 'PageDown': step(1); break;
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp': step(-1); break;
      case 'Home': goTo(0); break;
      case 'End': goTo(scrubExtent().count - 1); break;
      case ' ': toggleCine(); break;
      case 'w': case 'W': setTool('window'); break;
      case 'p': case 'P': setTool('pan'); break;
      case 'z': case 'Z': setTool('zoom'); break;
      case 'b': case 'B': setTool('probe'); break;
      case 'l': case 'L': setTool('length'); break;
      case 'a': case 'A': setTool('angle'); break;
      case 'r': case 'R': setTool('rect'); break;
      case 'e': case 'E': setTool('ellipse'); break;
      case 'i': case 'I': document.getElementById('btn-invert').click(); break;
      case 'o': case 'O': document.getElementById('btn-overlay').click(); break;
      case 'f': case 'F': viewport.fitToWindow(); redraw(); break;
      case '0': document.getElementById('btn-reset').click(); break;
      case '+': case '=': setZoom(viewport.zoom * 1.2); redraw(); break;
      case '-': case '_': setZoom(viewport.zoom / 1.2); redraw(); break;
      case 'Delete': case 'Backspace':
        if (state.selected) { removeAnnotation(state.selected.id); renderMeasurements(); redraw(); }
        else handled = false;
        break;
      case 'Escape':
        if (dom.panelLeft.classList.contains('open')) closeDrawer();
        else if (state.pending) { removeAnnotation(state.pending.id); state.pending = null; renderMeasurements(); redraw(); }
        else if (state.selected) { state.selected = null; renderMeasurements(); redraw(); }
        else handled = false;
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  function init() {
    cache();
    viewport = new global.DICOMViewport(dom.canvas);
    viewport.resize();
    setTool('window');
    bind();

    var observer = new ResizeObserver(function () {
      viewport.resize();
      if (viewport.frame) redraw();
    });
    observer.observe(dom.stage);

    /* Samples ship next to the page but file:// cannot list a directory, so
     * they are opened through the normal file picker. */
    redraw();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.DICOMApp = { state: state, loadFiles: loadFiles, getViewport: function () { return viewport; } };
})(this);
