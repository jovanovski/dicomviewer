# DICOM Viewer

A DICOM viewer that is just an HTML page. No build step, no server, no
dependencies, no network access. Open `index.html` in a browser and drop a
study on it.

Images are read with the `File` API and decoded in the page. Nothing is
uploaded anywhere and no remote script is loaded, so it works on an air-gapped
machine and behaves identically there.

## Quick start

```sh
git clone https://github.com/jovanovski/dicomviewer.git
cd dicomviewer
open index.html          # macOS   (xdg-open on Linux, start on Windows)
```

That is the whole install. The scripts are classic `<script>` tags rather than
ES modules and nothing is fetched at runtime, so opening the file directly over
`file://` works. Serving it over HTTP also works and buys nothing.

Then drag DICOM files — or an entire study folder — onto the window, or use
**Open files** / **Open folder**.

## Features

- Reads uncompressed, RLE and baseline-JPEG DICOM without any external codec
- Groups files into series automatically and sorts slices along the scan axis
- Window/level by dragging, with presets from the file and standard CT presets
- Length, angle, rectangle ROI, ellipse ROI and pixel probe, in real units
- ROI statistics (mean, SD, min, max, area) in modality-corrected values
- Multi-frame objects and cine playback
- Pan, zoom, rotate, flip, invert, fit, 1:1
- Patient/study overlay with orientation markers that follow the transforms
- Full metadata browser with tag names, nested sequences and a filter
- Export the current view as a PNG, or copy measurements to the clipboard

## What it reads

### Transfer syntaxes

| Syntax | Status |
| --- | --- |
| Implicit VR Little Endian | decoded |
| Explicit VR Little Endian | decoded |
| Explicit VR Big Endian | decoded |
| Deflated Explicit VR Little Endian | decoded, via `DecompressionStream` |
| RLE Lossless | decoded |
| JPEG Baseline / Extended, 8-bit | decoded by the browser's own JPEG decoder |
| JPEG Lossless, JPEG-LS, JPEG 2000, HTJ2K | **not decoded** — reported by name |
| MPEG2 / H.264 | **not decoded** — reported by name |

The unsupported set all require a codec that browsers do not ship. Rather than
failing vaguely, the viewer names the transfer syntax and explains why, so it
is clear the file is fine and the viewer is the limitation.

### Pixel formats

1, 8, 16 and 32-bit, signed and unsigned; Bits Stored smaller than Bits
Allocated (12-in-16 is handled); float and double pixel data; MONOCHROME1 and
MONOCHROME2; RGB; PALETTE COLOR; YBR with conversion; planar configuration 0
and 1; and multi-frame objects.

### Also handled

Files with no preamble or `DICM` magic, nested sequences, Modality LUT and VOI
LUT sequences, Pixel Padding, multi-valued Window Center/Width with their
explanations, enhanced multi-frame functional groups, and character sets
beyond ASCII.

## Controls

### Mouse

| Action | Result |
| --- | --- |
| Left drag | the active tool — window/level by default |
| Wheel | scroll through the series, or through frames |
| Shift / Ctrl + wheel | zoom about the cursor |
| Right drag | zoom |
| Middle drag, or Alt / Shift + left drag | pan |
| Double click | fit to window |

### Keyboard — tools

| Key | Tool |
| --- | --- |
| `W` | window / level |
| `P` | pan |
| `Z` | zoom |
| `B` | probe |
| `L` | length |
| `A` | angle |
| `R` | rectangle ROI |
| `E` | ellipse ROI |

### Keyboard — view and navigation

| Key | Action |
| --- | --- |
| `I` | invert greyscale |
| `O` | toggle the overlay text |
| `F` | fit to window |
| `0` | reset the view |
| `+` / `-` | zoom in / out |
| arrow keys, `PageUp` / `PageDown` | scroll the series or frames |
| `Home` / `End` | first / last image |
| `Space` | play or pause cine |
| `Delete` | remove the selected measurement |
| `Esc` | cancel the current measurement |

## Measurements

Distances and areas are reported in millimetres and mm² when the file carries
Pixel Spacing, and in pixels otherwise. An uncalibrated image is labelled
`UNCALIBRATED` in the corner, so a pixel measurement is never mistaken for a
physical one.

ROI statistics are given in modality-corrected units, so a CT reads in
Hounsfield units rather than raw stored values.

Drag a measurement by its outline or one of its handles. ROI interiors are
deliberately not grabbable, so you can probe or draw inside an existing region.

## Project layout

```
index.html          markup and the SVG icon sprite
css/app.css         all styling
js/dictionary.js    tag names, and VR lookup for implicit VR datasets
js/parser.js        Part 10 reader: file meta, datasets, sequences, fragments
js/decode.js        pixel extraction, RLE, browser JPEG, bit-depth unpacking
js/image.js         modality LUT, VOI/windowing, palettes, RGBA output
js/viewport.js      canvas transform, image <-> screen coordinates
js/tools.js         measurement geometry, statistics, hit testing, drawing
js/app.js           loading, series assembly, panels, input handling
```

Each file is an IIFE that hangs one object off the global scope, and they load
in the order listed above.

The display pipeline follows the standard, in order: stored value → Modality
LUT (rescale slope/intercept, or a Modality LUT Sequence) → VOI LUT (window, or
a VOI LUT Sequence) → presentation (MONOCHROME1 inversion) → 8-bit. For
greyscale images the whole chain is baked into a single lookup table indexed by
stored value, so re-windowing is a table rebuild plus a flat copy rather than
per-pixel arithmetic.

## Browser support

Any current Chrome, Edge, Firefox or Safari. Two features degrade rather than
break where they are missing: `DecompressionStream` (Safari 16.4+) is needed
only for deflated datasets, and `createImageBitmap` only for JPEG-compressed
ones. Everything else uses long-stable APIs.

## Limitations

- The codecs marked as not decoded above are genuinely not decoded. Supporting
  one means bringing in a WASM codec, which would end the no-dependency
  property that is the point of this project.
- `DICOMDIR` index files are skipped — load the image files themselves.
- No 3-D work: no MPR, no reconstruction, no volume rendering. This is a 2-D
  viewer.
- Measurements live in memory for the session, keyed to SOP Instance UID and
  frame number. They are not written back as DICOM presentation states.

## Not a medical device

This is not validated for diagnostic use, and it is not a medical device. Do
not make clinical decisions from it.

## License

MIT — see [LICENSE](LICENSE).
