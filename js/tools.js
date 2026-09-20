/* tools.js — measurement annotations.
 *
 * Annotations are stored in image coordinates so they track the pixels as the
 * view is panned, zoomed, rotated or flipped. Distances and areas are reported
 * in millimetres when the file carries Pixel Spacing, and in pixels when it
 * does not — a measurement is never silently presented as physical when the
 * calibration is unknown.
 */
(function (global) {
  'use strict';

  var HANDLE_RADIUS = 4;
  var HIT_SLOP = 8;

  var COLORS = {
    normal: '#ffcf5c',
    active: '#4cc2ff',
    text: '#ffffff',
    shadow: 'rgba(0,0,0,0.85)'
  };

  var TOOL_LABELS = {
    length: 'Length',
    angle: 'Angle',
    rect: 'Rectangle ROI',
    ellipse: 'Ellipse ROI',
    probe: 'Probe'
  };

  var nextId = 1;

  function create(type, point) {
    var a = { id: nextId++, type: type, points: [{ x: point.x, y: point.y }], complete: false };
    if (type === 'length' || type === 'rect' || type === 'ellipse') {
      a.points.push({ x: point.x, y: point.y });
      a.activeHandle = 1;
    } else if (type === 'angle') {
      a.points.push({ x: point.x, y: point.y });
      a.activeHandle = 1;
      a.stage = 1;               /* angle needs a third click */
    } else if (type === 'probe') {
      a.complete = true;
    }
    return a;
  }

  /* --------------------------------------------------------------- geometry */

  function distance(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* Physical length of a vector in image space, honouring Pixel Spacing.
   * Column spacing scales x, row spacing scales y (PS3.3 C.7.6.3.1.1). */
  function physicalLength(frame, a, b) {
    var sp = frame.spacing;
    var dx = (a.x - b.x) * (sp.calibrated ? sp.column : 1);
    var dy = (a.y - b.y) * (sp.calibrated ? sp.row : 1);
    var d = Math.sqrt(dx * dx + dy * dy);
    return { value: d, unit: sp.calibrated ? 'mm' : 'px' };
  }

  function formatNumber(v) {
    if (!isFinite(v)) return '--';
    var abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    if (abs >= 100) return v.toFixed(1);
    return v.toFixed(2);
  }

  function boundsOf(points) {
    var x0 = Math.min(points[0].x, points[1].x);
    var x1 = Math.max(points[0].x, points[1].x);
    var y0 = Math.min(points[0].y, points[1].y);
    var y1 = Math.max(points[0].y, points[1].y);
    return { x0: x0, y0: y0, x1: x1, y1: y1, width: x1 - x0, height: y1 - y0 };
  }

  /* ------------------------------------------------------------ statistics */

  /* Walks every pixel inside a ROI once, collecting mean / SD / min / max and
   * the area. Values are modality-corrected (HU for CT), matching the readout
   * a radiologist expects. */
  function regionStats(frame, annotation) {
    if (frame.color) return { unsupported: 'Colour image — pixel statistics are not meaningful.' };
    var b = boundsOf(annotation.points);
    var x0 = Math.max(0, Math.floor(b.x0));
    var x1 = Math.min(frame.columns - 1, Math.ceil(b.x1));
    var y0 = Math.max(0, Math.floor(b.y0));
    var y1 = Math.min(frame.rows - 1, Math.ceil(b.y1));
    if (x1 < x0 || y1 < y0) return null;

    var isEllipse = annotation.type === 'ellipse';
    var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    var rx = b.width / 2, ry = b.height / 2;
    if (isEllipse && (rx <= 0 || ry <= 0)) return null;

    var count = 0, sum = 0, sumSq = 0;
    var min = Infinity, max = -Infinity;
    var px = frame.pixels;
    var cols = frame.columns;
    var modality = frame.modality;

    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (isEllipse) {
          var nx = (x + 0.5 - cx) / rx;
          var ny = (y + 0.5 - cy) / ry;
          if (nx * nx + ny * ny > 1) continue;
        }
        var v = modality.apply(px[y * cols + x]);
        count++;
        sum += v;
        sumSq += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!count) return null;

    var mean = sum / count;
    var variance = Math.max(0, sumSq / count - mean * mean);
    var sp = frame.spacing;
    var pixelArea = sp.calibrated ? sp.row * sp.column : 1;
    var area = isEllipse
      ? Math.PI * rx * ry * pixelArea
      : b.width * b.height * pixelArea;

    return {
      count: count,
      mean: mean,
      stdDev: Math.sqrt(variance),
      min: min,
      max: max,
      area: area,
      areaUnit: sp.calibrated ? 'mm²' : 'px²',
      unit: modality.type || ''
    };
  }

  /* The text block shown next to a finished annotation. */
  function labelLines(frame, annotation) {
    var lines = [];
    var p = annotation.points;
    switch (annotation.type) {
      case 'length': {
        var d = physicalLength(frame, p[0], p[1]);
        lines.push(formatNumber(d.value) + ' ' + d.unit);
        break;
      }
      case 'angle': {
        if (p.length < 3) break;
        var sp = frame.spacing;
        var sx = sp.calibrated ? sp.column : 1;
        var sy = sp.calibrated ? sp.row : 1;
        var v1 = { x: (p[0].x - p[1].x) * sx, y: (p[0].y - p[1].y) * sy };
        var v2 = { x: (p[2].x - p[1].x) * sx, y: (p[2].y - p[1].y) * sy };
        var dot = v1.x * v2.x + v1.y * v2.y;
        var m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
        if (m1 > 0 && m2 > 0) {
          var deg = Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2)))) * 180 / Math.PI;
          lines.push(deg.toFixed(1) + '°');
        }
        break;
      }
      case 'rect':
      case 'ellipse': {
        var stats = regionStats(frame, annotation);
        if (!stats) break;
        if (stats.unsupported) { lines.push(stats.unsupported); break; }
        var u = stats.unit ? ' ' + stats.unit : '';
        lines.push('Mean ' + formatNumber(stats.mean) + u);
        lines.push('SD ' + formatNumber(stats.stdDev));
        lines.push('Min ' + formatNumber(stats.min) + '  Max ' + formatNumber(stats.max));
        lines.push('Area ' + formatNumber(stats.area) + ' ' + stats.areaUnit);
        lines.push(stats.count + ' px');
        break;
      }
      case 'probe': {
        var v = frame.valueAt(Math.floor(p[0].x), Math.floor(p[0].y));
        if (!v) break;
        if (v.color) lines.push('R ' + v.r + '  G ' + v.g + '  B ' + v.b);
        else {
          lines.push(formatNumber(v.value) + (v.unit ? ' ' + v.unit : ''));
          if (v.stored !== v.value) lines.push('raw ' + v.stored);
        }
        lines.push('(' + Math.floor(p[0].x) + ', ' + Math.floor(p[0].y) + ')');
        break;
      }
    }
    return lines;
  }

  /* ---------------------------------------------------------------- drawing */

  function drawTextBlock(ctx, lines, x, y, color, bounds) {
    if (!lines.length) return;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    var lineHeight = 14;
    var pad = 5;
    var width = 0;
    for (var i = 0; i < lines.length; i++) width = Math.max(width, ctx.measureText(lines[i]).width);
    var boxW = width + pad * 2;
    var boxH = lines.length * lineHeight + pad * 2 - 2;

    /* Keep the block on screen. */
    if (bounds) {
      if (x + boxW > bounds.width - 4) x = bounds.width - boxW - 4;
      if (y + boxH > bounds.height - 4) y = bounds.height - boxH - 4;
      if (x < 4) x = 4;
      if (y < 4) y = 4;
    }

    ctx.fillStyle = 'rgba(8,10,13,0.78)';
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 3);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    for (var j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], x + pad, y + pad + j * lineHeight);
    }
  }

  function drawHandle(ctx, x, y, color) {
    ctx.beginPath();
    ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0d10';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function draw(ctx, viewport, annotations, selectedId) {
    if (!annotations || !annotations.length || !viewport.frame) return;
    var bounds = { width: viewport.width, height: viewport.height };

    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      var selected = a.id === selectedId;
      var color = selected ? COLORS.active : COLORS.normal;
      var pts = a.points.map(function (p) { return viewport.imageToScreen(p.x, p.y); });

      ctx.save();
      ctx.shadowColor = COLORS.shadow;
      ctx.shadowBlur = 3;
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      var labelAnchor = pts[pts.length - 1];

      if (a.type === 'length' && pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
        /* End caps perpendicular to the line make the endpoints unambiguous. */
        var ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) + Math.PI / 2;
        var capX = Math.cos(ang) * 5, capY = Math.sin(ang) * 5;
        ctx.beginPath();
        ctx.moveTo(pts[0].x - capX, pts[0].y - capY); ctx.lineTo(pts[0].x + capX, pts[0].y + capY);
        ctx.moveTo(pts[1].x - capX, pts[1].y - capY); ctx.lineTo(pts[1].x + capX, pts[1].y + capY);
        ctx.stroke();
      } else if (a.type === 'angle' && pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        if (pts.length >= 3) ctx.lineTo(pts[2].x, pts[2].y);
        ctx.stroke();
        if (pts.length >= 3) {
          /* Arc at the vertex showing which angle is measured. */
          var r = Math.min(26, distance(pts[0], pts[1]) * 0.4, distance(pts[2], pts[1]) * 0.4);
          if (r > 4) {
            var a1 = Math.atan2(pts[0].y - pts[1].y, pts[0].x - pts[1].x);
            var a2 = Math.atan2(pts[2].y - pts[1].y, pts[2].x - pts[1].x);
            var delta = a2 - a1;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            ctx.beginPath();
            ctx.arc(pts[1].x, pts[1].y, r, a1, a1 + delta, delta < 0);
            ctx.stroke();
          }
          labelAnchor = pts[1];
        }
      } else if (a.type === 'rect' && pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[0].x, pts[1].y);
        ctx.closePath();
        ctx.stroke();
        labelAnchor = { x: Math.max(pts[0].x, pts[1].x), y: Math.min(pts[0].y, pts[1].y) };
      } else if (a.type === 'ellipse' && pts.length >= 2) {
        /* Drawn in screen space from the transformed corners so the outline
         * matches the rotated/flipped view exactly. */
        var mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
        var ex = Math.abs(pts[1].x - pts[0].x) / 2, ey = Math.abs(pts[1].y - pts[0].y) / 2;
        ctx.beginPath();
        ctx.ellipse(mx, my, Math.max(ex, 0.5), Math.max(ey, 0.5), 0, 0, Math.PI * 2);
        ctx.stroke();
        labelAnchor = { x: mx + ex, y: my - ey };
      } else if (a.type === 'probe') {
        ctx.beginPath();
        ctx.moveTo(pts[0].x - 7, pts[0].y); ctx.lineTo(pts[0].x + 7, pts[0].y);
        ctx.moveTo(pts[0].x, pts[0].y - 7); ctx.lineTo(pts[0].x, pts[0].y + 7);
        ctx.stroke();
      }

      ctx.shadowBlur = 0;
      if (a.type !== 'probe') {
        for (var h = 0; h < pts.length; h++) drawHandle(ctx, pts[h].x, pts[h].y, color);
      }

      var lines = labelLines(viewport.frame, a);
      drawTextBlock(ctx, lines, labelAnchor.x + 10, labelAnchor.y + 6, color, bounds);
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------ hit testing */

  function hitTest(viewport, annotations, screenPoint) {
    for (var i = annotations.length - 1; i >= 0; i--) {
      var a = annotations[i];
      for (var h = 0; h < a.points.length; h++) {
        var s = viewport.imageToScreen(a.points[h].x, a.points[h].y);
        if (distance(s, screenPoint) <= HANDLE_RADIUS + HIT_SLOP) {
          return { annotation: a, handle: h };
        }
      }
      /* Outline hit: drags the whole annotation. ROIs are grabbed by their
       * outline rather than their interior, so the enclosed pixels stay
       * available for probing and for drawing a new region inside. */
      if (a.type === 'rect' || a.type === 'ellipse') {
        if (outlineDistance(viewport, a, screenPoint) <= HIT_SLOP) return { annotation: a, handle: -1 };
      } else if (a.type === 'length' || a.type === 'angle') {
        for (var k = 0; k + 1 < a.points.length; k++) {
          var s0 = viewport.imageToScreen(a.points[k].x, a.points[k].y);
          var s1 = viewport.imageToScreen(a.points[k + 1].x, a.points[k + 1].y);
          if (pointToSegment(screenPoint, s0, s1) <= HIT_SLOP) return { annotation: a, handle: -1 };
        }
      } else if (a.type === 'probe') {
        var sp = viewport.imageToScreen(a.points[0].x, a.points[0].y);
        if (distance(sp, screenPoint) <= HIT_SLOP) return { annotation: a, handle: 0 };
      }
    }
    return null;
  }

  /* Screen-space distance from a point to a ROI's outline. */
  function outlineDistance(viewport, annotation, point) {
    var p0 = viewport.imageToScreen(annotation.points[0].x, annotation.points[0].y);
    var p1 = viewport.imageToScreen(annotation.points[1].x, annotation.points[1].y);
    var left = Math.min(p0.x, p1.x), right = Math.max(p0.x, p1.x);
    var top = Math.min(p0.y, p1.y), bottom = Math.max(p0.y, p1.y);

    if (annotation.type === 'rect') {
      var corners = [
        { x: left, y: top }, { x: right, y: top },
        { x: right, y: bottom }, { x: left, y: bottom }
      ];
      var best = Infinity;
      for (var i = 0; i < 4; i++) {
        best = Math.min(best, pointToSegment(point, corners[i], corners[(i + 1) % 4]));
      }
      return best;
    }

    var cx = (left + right) / 2, cy = (top + bottom) / 2;
    var rx = (right - left) / 2, ry = (bottom - top) / 2;
    if (rx < 0.5 || ry < 0.5) return distance(point, { x: cx, y: cy });
    /* Normalise into unit-circle space, then scale the radial error back by
     * the smaller semi-axis — a close approximation of the true distance. */
    var nx = (point.x - cx) / rx;
    var ny = (point.y - cy) / ry;
    var r = Math.hypot(nx, ny);
    return Math.abs(r - 1) * Math.min(rx, ry);
  }

  function pointToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return distance(p, a);
    var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function translate(annotation, dx, dy) {
    for (var i = 0; i < annotation.points.length; i++) {
      annotation.points[i].x += dx;
      annotation.points[i].y += dy;
    }
  }

  /* Exports a plain-text summary of every measurement on the current image. */
  function exportText(frame, annotations) {
    var out = [];
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      var lines = labelLines(frame, a);
      out.push((TOOL_LABELS[a.type] || a.type) + ': ' + lines.join(' | '));
    }
    return out.join('\n');
  }

  global.DICOMTools = {
    create: create,
    draw: draw,
    hitTest: hitTest,
    translate: translate,
    regionStats: regionStats,
    labelLines: labelLines,
    physicalLength: physicalLength,
    exportText: exportText,
    TOOL_LABELS: TOOL_LABELS
  };
})(this);
