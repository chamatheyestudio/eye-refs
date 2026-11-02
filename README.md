# Eye Refs (beta)

Reference boards for EyeStudio, in the spirit of PureRef, with video and shared projects through Google Drive.
By Matte Black.

## How it saves

Everything lives in Google Drive for desktop. Nothing goes to any other server.

```
My Drive/
  Eye Refs Team/clients.json     the client list, kept in the admin's Drive and shared with the studio
  Eye Refs/
    Hutong/
      Spring Campaign/
        Spring Campaign.eyerefs  double click to open
        media/                   every image and video, with a unique name
        changes/                 one file per person per computer
        here/                    "I'm here" notes, refreshed every minute
```

* Each computer only ever writes its own change file, and the app merges everyone's. Drive never has two people saving one file.
* Saves go to a temporary file first and are then swapped in, so Drive never uploads half a file. A backup copy also stays on the computer.
* Media names look like `2026-11-02_CH_k7f3xa9p_lantern-reel.jpg`, so files never overwrite each other. Originals are never edited.
* Videos over 500MB, or in formats the board can't play, get one high quality H.264 copy (resolution kept up to 4K).

## First run

1. Install Google Drive for desktop and sign in with an eyestudio.ae account.
2. Admin: open Eye Refs, choose "Set up a new team as admin", add the clients, then share the `Eye Refs Team` folder in Drive with the studio (view access).
3. Everyone else: open the share email, choose Add shortcut to Drive, put it in My Drive, then open Eye Refs.
4. To share a project, press Share and give teammates edit access. They add a shortcut to it once, in the matching client folder.

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

Every push to `main` builds both installers with `.github/workflows/build.yml` and publishes them to the GitHub release for the version in `package.json`. Bump the version for each new release so the app can update.
