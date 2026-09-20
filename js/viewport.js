/* viewport.js — canvas rendering and the image/screen coordinate mapping.
 *
 * The frame is painted once into an offscreen canvas at its native pixel size;
 * pan, zoom, rotation, flips and non-square pixel correction are applied as a
 * canvas transform when that buffer is blitted to the display canvas. Tools
 * work in image coordinates, so annotations stay put as the view changes.
 */
(function (global) {
  'use strict';

  function Viewport(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.offscreen = document.createElement('canvas');
    /* Nothing ever reads this buffer back — it is written with putImageData
     * and blitted to the display canvas — so it must stay GPU-resident.
     * Asking for willReadFrequently here pins it to a software surface and
     * turns every draw() into a fresh texture upload. */
    this.offctx = this.offscreen.getContext('2d');
    this.imageData = null;
    this.frame = null;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;         /* degrees, multiples of 90 */
    this.flipH = false;
    this.flipV = false;
    this.invert = false;
    this.interpolate = true;

    this.windowCenter = 0;
    this.windowWidth = 1;
    this.voiLutIndex = -1;
    this.voiFunction = 'LINEAR';

    this.width = 0;
    this.height = 0;
    this.dpr = 1;
  }

  Viewport.prototype.setFrame = function (frame, keepView) {
    var previous = this.frame;
    this.frame = frame;
    if (!frame) { this.imageData = null; return; }

    if (this.offscreen.width !== frame.columns || this.offscreen.height !== frame.rows) {
      this.offscreen.width = frame.columns;
      this.offscreen.height = frame.rows;
      this.imageData = this.offctx.createImageData(frame.columns, frame.rows);
    } else if (!this.imageData) {
      this.imageData = this.offctx.createImageData(frame.columns, frame.rows);
    }

    if (!keepView || !previous) {
      var w = frame.defaultWindow();
      this.voiLutIndex = w.lutIndex;
      if (w.center !== null) { this.windowCenter = w.center; this.windowWidth = w.width; }
      else {
        this.windowCenter = (frame.valueMax + frame.valueMin) / 2;
        this.windowWidth = Math.max(1, frame.valueMax - frame.valueMin);
      }
      this.voiFunction = frame.voiFunction;
    }
    this.repaintBuffer();
  };

  /* Re-runs the LUT and refills the offscreen buffer. */
  Viewport.prototype.repaintBuffer = function () {
    if (!this.frame || !this.imageData) return;
    this.frame.render(this.imageData, {
      center: this.windowCenter,
      width: this.windowWidth,
      lutIndex: this.voiLutIndex,
      invert: this.invert,
      voiFunction: this.voiFunction
    });
    this.offctx.putImageData(this.imageData, 0, 0);
  };

  Viewport.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = global.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = dpr;
  };

  /* Physical aspect correction for non-square pixels. */
  Viewport.prototype.aspect = function () {
    var f = this.frame;
    if (!f || !f.spacing) return { x: 1, y: 1 };
    var row = f.spacing.row, col = f.spacing.column;
    if (!row || !col || row === col) return { x: 1, y: 1 };
    /* Scale the axis with the larger spacing so nothing is ever undersampled. */
    if (row > col) return { x: 1, y: row / col };
    return { x: col / row, y: 1 };
  };

  Viewport.prototype.fitToWindow = function () {
    if (!this.frame || !this.width) return;
    var a = this.aspect();
    var rot = ((this.rotation % 360) + 360) % 360;
    var w = this.frame.columns * a.x;
    var h = this.frame.rows * a.y;
    if (rot === 90 || rot === 270) { var t = w; w = h; h = t; }
    var scale = Math.min(this.width / w, this.height / h);
    this.zoom = scale > 0 ? scale * 0.98 : 1;
    this.panX = 0;
    this.panY = 0;
  };

  Viewport.prototype.resetView = function () {
    this.rotation = 0;
    this.flipH = false;
    this.flipV = false;
    this.fitToWindow();
  };

  /* ------------------------------------------------- coordinate conversion */

  Viewport.prototype.imageToScreen = function (ix, iy) {
    var f = this.frame;
    if (!f) return { x: 0, y: 0 };
    var a = this.aspect();
    var rad = this.rotation * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var sx = this.zoom * a.x * (this.flipH ? -1 : 1);
    var sy = this.zoom * a.y * (this.flipV ? -1 : 1);
    var dx = (ix - f.columns / 2) * sx;
    var dy = (iy - f.rows / 2) * sy;
    return {
      x: this.width / 2 + this.panX + dx * cos - dy * sin,
      y: this.height / 2 + this.panY + dx * sin + dy * cos
    };
  };

  Viewport.prototype.screenToImage = function (x, y) {
    var f = this.frame;
    if (!f) return { x: 0, y: 0 };
    var a = this.aspect();
    var rad = this.rotation * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var ux = x - (this.width / 2 + this.panX);
    var uy = y - (this.height / 2 + this.panY);
    var dx = ux * cos + uy * sin;
    var dy = -ux * sin + uy * cos;
    var sx = this.zoom * a.x * (this.flipH ? -1 : 1);
    var sy = this.zoom * a.y * (this.flipV ? -1 : 1);
    return {
      x: dx / sx + f.columns / 2,
      y: dy / sy + f.rows / 2
    };
  };

  /* Screen distance covered by one image pixel — used to size handles. */
  Viewport.prototype.pixelScale = function () {
    var a = this.aspect();
    return this.zoom * Math.max(a.x, a.y);
  };

  /* ---------------------------------------------------------------- render */

  Viewport.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (!this.frame) return;

    var f = this.frame;
    var a = this.aspect();
    ctx.save();
    ctx.translate(this.width / 2 + this.panX, this.height / 2 + this.panY);
    ctx.rotate(this.rotation * Math.PI / 180);
    ctx.scale(
      this.zoom * a.x * (this.flipH ? -1 : 1),
      this.zoom * a.y * (this.flipV ? -1 : 1)
    );
    /* Smooth when minifying; keep hard pixel edges when magnified past 1:1,
     * which is what you want when inspecting individual voxels. */
    var magnified = this.pixelScale() > 1.3;
    ctx.imageSmoothingEnabled = this.interpolate && !magnified;
    ctx.drawImage(this.offscreen, -f.columns / 2, -f.rows / 2, f.columns, f.rows);
    ctx.restore();
  };

  global.DICOMViewport = Viewport;
})(this);
