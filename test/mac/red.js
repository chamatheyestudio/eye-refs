// A full screen red window to sit behind Eye Refs
const { app, BrowserWindow, screen } = require('electron');
app.whenReady().then(() => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ x: 0, y: 0, width, height, backgroundColor: '#ff0000', frame: false });
  w.loadURL('data:text/html,<body style="margin:0;background:red"></body>');
});
