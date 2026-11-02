# Eye Refs (beta)

Reference boards for EyeStudio, in the spirit of PureRef, with video and shared projects through Google Drive.
By Matte Black.

## How it saves

* **Start right away** like PureRef: the app opens on a blank untitled board. Press Ctrl or Cmd+S to name it and save it into Documents/Eye Refs. Untitled boards are kept safe until you save them.
* **Your projects stay on your computer** in `Documents/Eye Refs/<Project>/`. Nothing leaves your machine unless you share it.
* **Save as one file** packs a board with all its images and videos into one `.eyerefs` file to send anywhere, like a PureRef file. Opening it makes your own copy.
* **Sharing** uploads the board to the EyeStudio Google Drive at the same path, `Eye Refs/<Project>/`, through the Apps Script in `server/`. Everyone on the board gets a synced copy in their own Documents folder.
* Sign in is by email with a 6 digit code. Anyone can be invited or ask to join with the board's join code; the owner approves.
* Each computer only writes its own change file, and the app merges everyone's, so nothing is ever overwritten.
* Media names look like `2026-11-02_CH_k7f3xa9p_lantern-reel.jpg`, and originals are never edited.
* Videos over 500MB, or in formats the board can't play, get one high quality H.264 copy.

## Server

`server/Code.gs` runs as an Apps Script web app in the EyeStudio Google account (Execute as: Me, Access: Anyone). It keeps every shared board in that account's Drive and sends sign in codes from its Gmail. `chamath@eyestudio.ae` is the admin.

## Shortcuts

PureRef's defaults: right drag moves the window, Alt drag pans, scroll zooms, hold C to crop, Ctrl or Cmd+Shift+A keeps it on top, Ctrl or Cmd+T clicks through, Ctrl or Cmd+P arranges. Press Ctrl+H for the full list.

## Building

```
npm install
npm test          # merge, naming, sync and media tests
npm start         # run from source
npm run dist:win  # Windows installer (on Windows, or Linux with Wine)
npm run dist:mac  # Mac disk image (on a Mac)
```

Every push to `main` builds both installers with `.github/workflows/build.yml`. They are published only when `package.json` has a new version, always as a pre-release while in beta. To ship a new beta, bump `1.0.0-beta.1` to `1.0.0-beta.2` and push.
