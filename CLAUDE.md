# Map Layers

An installable web app (PWA) for stacking separate map layer images: align each layer to a base layer on a laptop, then view them on iPhone and Android with per-layer opacity and color controls.

Read `docs/ARCHITECTURE.md` for the full design and `docs/wireframes/` for the agreed screens. Where this file and the architecture doc disagree, this file wins: it records decisions made after the doc was written.

## Working rules

- **Build one phase at a time and stop for review at the end of each.** Start with phase 1 only (see the roadmap in the architecture doc). Don't start the next phase without the owner's go-ahead.
- **Images and project data never leave the device.** No analytics, no telemetry, no third-party scripts or fonts loaded at runtime, no network calls except loading the app's own files. Bundle every dependency. The app must work fully in airplane mode once installed.
- **Keep dependencies small.** Plain TypeScript + Vite, WebGL for rendering, fflate for zip. No UI framework unless there is a clear need; ask first.
- **Version the project file from day one.** `project.json` carries `formatVersion` (starts at 1); the importer must handle older versions.

## Decisions made after the architecture doc

- **No blend modes for now.** No Normal/Multiply/Screen control anywhere in the UI. Listed under "Later, if needed".
- **Pinch-zoom anchors at the point between the fingers.** Two-finger pan at the same time, zoom limits (can't zoom out past the whole map or in absurdly far), double-tap to zoom in. Laptop: trackpad pinch and scroll wheel zoom toward the cursor. Prevent the browser's own page zoom (iPhone Safari needs extra care).
- **Create mode is laptop-only.** Phones get the Library and View screens. Create mode is reachable on a phone only through "Edit alignment" in the library menu, and that entry may be removed.
- **Layer order:** top of the list draws on top. Reordering happens in Create mode only.
- **Phone layer panel:** one row per layer (visibility, opacity slider, percentage, expand button). Expanding a row shows brightness and recolor swatches.
- **Fitting:** similarity by default from 2 points; affine is a per-layer toggle available from 3 points. Show the average (RMS) error for both modes and each point's error; highlight outliers.

## Hosting

- Cloudflare Pages, free plan, at `maps.opicartes.com` (subdomain name still to be confirmed).
- `opicartes.com` is registered and managed in Cloudflare and is used for email by another app. Only add the `maps` subdomain through the Pages project's Custom domains screen. Never change nameservers, the root domain, or any MX/SPF/DKIM/DMARC records.

## Open questions

See the checklist at the end of `docs/ARCHITECTURE.md`. The biggest unknown is the real layer image sizes; test with the owner's sample files when available.
