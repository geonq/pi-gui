const { app, BrowserWindow } = require("electron");

const userDataPath = process.env.PI_REMOTE_CONTEXT_BRIDGE_USER_DATA;
if (userDataPath) app.setPath("userData", userDataPath);

const preloadPath = process.env.PI_REMOTE_CONTEXT_BRIDGE_PRELOAD;
if (!preloadPath) throw new Error("Context bridge smoke preload path is missing.");

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    await window.loadURL("data:text/html,<title>remote context bridge smoke</title>");
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
