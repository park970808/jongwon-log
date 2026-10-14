# Third-party provenance

This project integrates the open-source rhwp web editor; it does not decompile proprietary Hancom Office binaries.

- rhwp editor source: [edwardkim/rhwp](https://github.com/edwardkim/rhwp), tag `v0.8.6`, commit `f1f9c6ae58344ee9368996d3543f76b9345cf227`, MIT. See `vendor/rhwp/LICENSE`, `vendor/rhwp/THIRD_PARTY_LICENSES.md`, and `vendor/rhwp/PROVENANCE.json`.
- WASM and its matching generated JavaScript bindings: user-provided `alhangeul-macos-0.2.2.dmg`, `Alhangeul.app/Contents/Resources/rhwp-studio`. The supplied manifest identifies rhwp v0.8.6. The standalone JS file in the DMG did not match its WASM imports; the compatible wasm-bindgen module was recovered from the included production JS bundle and its public exports restored. No native macOS executable/framework is distributed here.
- Alhangeul notices are retained as `vendor/rhwp/ALHANGEUL_LICENSE` and `vendor/rhwp/ALHANGEUL_THIRD_PARTY_LICENSES.md`. The supplied notice mentions an older upstream snapshot; the actual extracted asset version/hash is recorded separately in `PROVENANCE.json`.
- Bundled fonts: see `public/fonts/FONTS.md` and `public/fonts/SourceHanSerifK-OFL.txt`. Proprietary Hancom/Microsoft font files are not included. Font fallback can alter line breaks and pagination.
- Yjs (MIT), y-indexeddb (MIT), Firebase JavaScript SDK (Apache-2.0), fflate (MIT), diff-match-patch (Apache-2.0), @xmldom/xmldom (MIT), @noble/hashes (MIT), CanvasKit/Skia (BSD-3-Clause). Exact dependency versions are pinned in package-lock.json. Their licenses remain with the respective upstream packages.

Local modifications to the vendored editor are confined to the collaboration bridge in `vendor/rhwp/src/main.ts` and the generated bindings described above. The existing activity-log HTML and HWPX template are retained from this repository.
