# Map Layers

An installable web app (PWA) for stacking separate map layer images: align each layer to a base layer on a laptop, then view them on iPhone and Android with per-layer opacity and color controls.

Read `docs/ARCHITECTURE.md` for the full design and `docs/wireframes/` for the agreed screens. Where this file and the architecture doc disagree, this file wins: it records decisions made after the doc was written.

## Working rules

- **Never commit or push.** No `git commit`, `git push`, `gh pr create` or `gh pr merge`, even if asked in passing; the owner does all of these. This is enforced by `.claude/settings.json`; don't change that file.
- **Don't write code until the owner explicitly says to start.** Answering a planning question is not a go-ahead.
- **Build one phase at a time and stop for review at the end of each.** Phases 1–3 are built; phase 3 works on a real Android phone but still has a problem on iPhone (see the roadmap in the architecture doc). Don't start the next phase without the owner's go-ahead.
- **Images and project data never leave the device.** No analytics, no telemetry, no third-party scripts or fonts loaded at runtime, no network calls except loading the app's own files. Bundle every dependency. The app must work fully in airplane mode once installed.
- **Keep dependencies small.** Plain TypeScript + Vite, WebGL for rendering, fflate for zip. No UI framework unless there is a clear need; ask first.
- **Version the project file from day one.** `project.json` carries `formatVersion` (starts at 1); the importer must handle older versions.

## Decisions made after the architecture doc

- **No blend modes for now.** No Normal/Multiply/Screen control anywhere in the UI. Listed under "Later, if needed".
- **Pinch-zoom anchors at the point between the fingers.** Two-finger pan at the same time, zoom limits (can't zoom out past the whole map or in absurdly far), double-tap to zoom in. Laptop: trackpad pinch and scroll wheel zoom toward the cursor. Prevent the browser's own page zoom (iPhone Safari needs extra care).
- **Create mode is laptop-only.** Phones get the Library and View screens only; there is no "Edit alignment" entry on phones.
- **Phone layer rows have no expand button until phase 4,** when brightness and recolor arrive. Phase 3 rows are visibility, opacity slider and percentage.
- **Android testing comes later:** the owner will have an Android phone soon. Until then, test on the owner's iPhone 12 mini and with Android emulation.
- **Layer order:** top of the list draws on top. Reordering happens in Create mode only.
- **Phone layer panel:** one row per layer (visibility, opacity slider, percentage, expand button). Expanding a row shows brightness and recolor swatches.
- **Originals stay full size; phones get smaller copies.** The laptop keeps and exports the original images. Large layers also get phone copies at 6,000 px and 4,096 px on the longest side (`PHONE_SIZES` in `src/sizes.ts`), made when the layer is added, or when an older map is opened or exported on a laptop. One zip holds everything (project.json `phoneCopies`, format version 2). Each device opens the sharpest version within its limit: laptops the original, Android and other touch devices 6,000 px, iPhones and iPads 4,096 px (an iPhone 12 mini crashed at 6,000 px). If the page is killed while a map is opening, the device steps its limit down one size and says so. Copies are drawn at the original's size so points still line up. The renderer splits large images into tiles. Overlay layers are PNGs with transparent backgrounds.
- **Fitting:** similarity by default from 2 points; affine is a per-layer toggle available from 3 points. Show the average (RMS) error for both modes and each point's error; highlight outliers.
- **Saving uses a Save button, not autosave.** Show when there are unsaved changes, and warn before leaving a map with unsaved changes.
- **Map and layer names are editable** in Create mode.
- **Opacity and visibility are saved with the map,** whether changed in Create or View. Separate per-device viewer settings with "Reset to defaults" stay in phase 4.

## Hosting

- Cloudflare Workers (static assets), free plan, configured in `wrangler.jsonc` to serve `./dist`, at `maps.opicartes.com` (subdomain name still to be confirmed). This replaces the Pages plan in the architecture doc.
- `opicartes.com` is registered and managed in Cloudflare and is used for email by another app. Only add the `maps` subdomain as a Custom Domain on the Worker (Settings → Domains & Routes). Never change nameservers, the root domain, or any MX/SPF/DKIM/DMARC records.

## Backlog (not scheduled; don't build until the owner asks)

- **"Small copy" export for sharing.** Discussed 2026-10-10. A clearly labelled zip with only the 4,096 px phone copies (no originals), about a quarter of the size, that opens on any device. It's a viewing copy, not a backup: the library should mark maps imported from it, and aligning on it is less precise.
- **Export as JPEG.** Requested 2026-10-09. Details to agree before building: whether it exports the current view or the whole map, at what resolution, and whether it's available on phones.

## Open questions

See the checklist at the end of `docs/ARCHITECTURE.md`. The biggest unknown is the real layer image sizes; test with the owner's sample files when available.
