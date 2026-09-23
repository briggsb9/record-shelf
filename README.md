# Record Shelf

Record Shelf is an album-first desktop music player for libraries stored on a NAS. It reads a normal mounted file share, builds a fast local SQLite catalogue, caches cover artwork locally, and plays the original files directly from the share.

![Record Shelf showing the album shelf, selected album and track list](docs/assets/record-shelf-main.png)

## macOS development

1. Mount the NAS share in Finder (`Go` → `Connect to Server…`, usually `smb://your-nas/music`).
2. Install dependencies with `npm install`.
3. Run `npm run dev`.
4. Choose the mounted music folder in Record Shelf.

The first scan reads tags and artwork sequentially to avoid overwhelming a NAS. Subsequent scans reuse unchanged records instead of rereading every file over the network. If the share is unavailable, the existing catalogue is retained rather than cleared. Supported formats include MP3, M4A/AAC/ALAC, FLAC, Ogg/Opus, WAV, AIFF and WMA where Chromium has a matching decoder.

## Album views and artwork

- **Shelf** presents a horizontally scrollable, trackpad-friendly row of records with the selected album's tracks below.
- **Album** keeps a large cover at the upper left with metadata and tracks on the right.
- **Covers** displays a traditional artwork grid.
- **List** displays compact album rows that expand to reveal their tracks.

Record Shelf uses embedded artwork first, then common folder images such as `cover.jpg` and `folder.jpg`. Use **Find Artwork** to retrieve missing covers from MusicBrainz and the Cover Art Archive. Individual albums can also be refreshed. Online artwork requests send the album and artist names to MusicBrainz and are limited to one search per second.

## Build installers

- macOS: `npm run package:mac`
- Windows: `npm run package:win`

Windows can use a mapped drive or UNC share. The shared Electron/TypeScript application needs no architectural rewrite for Windows; platform-specific packaging and media-key QA remain separate release work.

## Keyboard controls

- Space: play/pause
- Command/Ctrl + Right: next track
- Command/Ctrl + Left: previous track
- Command/Ctrl + .: stop
- Command/Ctrl + O: choose music folder
- Command/Ctrl + L: focus search

Hardware play/pause, previous and next media keys are registered while the app is running.
