const { app, Menu, BrowserWindow, BrowserView, ipcMain, shell, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const { connect } = require('@holochain/hc-web-client')
const net = require('net')
const conductor = require('./conductor.js')
const { HappUiController, sanitizeUINameForScheme, setupWindowDevProduction } = require('./happ-ui-controller')
const cli = require('./cli')

function installLogFile(){
  return path.join(conductor.rootConfigPath(), 'installed_happ_bundles.json')
}

function loadInstallLog() {
  if(!fs.existsSync(installLogFile())) {
      return {}
  } else {
      return JSON.parse(fs.readFileSync(installLogFile()))
  }
}
/// This is the main controller of the whole application.
/// There is one instance of Holoscape that gets created in main.
/// All build-in UIs get created from here and references to the window
/// objects are kept here as well (logWindow, confingWindow)
class Holoscape {
    /// Sub-controllors:
    happUiController;

    /// Window references for built-in views:
    mainWindow;
    splash;
    logWindow;
    configWindow;
    uiConfigWindow;
    debuggerWindow;
    installBundleView;

    activeView;

    /// Conductor references (mabe move to conductor.js?)
    conductorProcess; // Handle to the return value of spawn
    conductorPassphraseClient; // Handle to the socket through which the conductor requests passphrases

    /// Misc.:
    logMessages = [];
    quitting = false;

    /// hApp bundle install log
    installLog;

    async init() {
      this.installLog = loadInstallLog()
      this.happUiController = new HappUiController(this)
      this.createLogWindow()
      this.createConfigWindow()
      this.createUiConfigWindow()
      this.createDebuggerWindow()
      
      this.updateTrayMenu()
      this.splash.webContents.send('splash-status', "Booting conductor...")
      this.bootConductor()

      setTimeout(()=> {
        if(!global.conductor_call) {
          this.splash.hide()
          dialog.showMessageBoxSync({
            type: "warning",
            message: "Holoscape could not connect to the newly started conductor within 60 seconds. The log window will be shown now. Please read it carefully and check for any errors. The most probable reason for this is another conductor process running on that same port - watch out for 'Address already in use'.",
            buttons: ["Ok"]
          })
          this.splash.show()
          this.showHideLogs()
        }
      }, 60000)
    }

    addToInstallLog(key, bundle) {
      this.installLog[key] = bundle
      this.saveInstallLog()
    }

    saveInstallLog() {
      fs.writeFileSync(installLogFile(), JSON.stringify(this.installLog))
    }

    createViews() {
      this.createInstallBundleView()
    }

    showSplashScreen() {
      let window = new BrowserWindow({
        width:843,
        height:600,
        webPreferences: {
          nodeIntegration: true
        },
        minimizable: false,
        alwaysOnTop: true,
        frame: false,
        transparent: true,
        icon: systemTrayIconFull(),
      })
      window.loadURL(path.join('file://', __dirname, 'views/splash.html'))
      //window.webContents.openDevTools()
      this.splash = window

      return new Promise((resolve) => {
        window.webContents.on('did-finish-load', ()=>{
            resolve()
        })
      })
    }

    checkConductorConnection() {
      if(this.conductorProcess && !global.conductor_call) {
        this.connectConductor()
        // this.dnaViewSwitchSignals()
      }
    }

    checkConductorPassphraseSocket() {
      if(this.conductorProcess && !this.conductorPassphraseClient) {
        this.connectPassphraseSocket()
      }
    }

    connectPassphraseSocket() {
      if(!fs.existsSync(conductor.passphraseSocketPath)) {
        console.log('Passphrase socket not found (yet)')
        return
      }

      let client
      try{
        client = net.createConnection(conductor.passphraseSocketPath)
      } catch(e) {
        console.log('Error trying to connect to passphrase socket:', e)
      }


      const that = this
      client.on("connect", () => {
        that.conductorPassphraseClient = client
      })

      /// The conductor requests a passphrase by sending something over the socket.
      /// We are not yet caring about what it sends, but we might want to add different
      /// styles of passphrase requests: setting a new one or unlocking a keystore that
      /// has already a passphrase set (should be different UI).
      /// That is not yet implement in the conductor.
      /// Also, there is currently no way to retry entering the passphrase if it is wrong.
      /// Conductor will just exit...
      client.on("data", async (data) => {
        let splashWasVisible = that.splash.isVisible()
        if(!splashWasVisible) {
          that.splash.show()
        }

        that.splash.webContents.send('request-passphrase', "Booting conductor...")
        that.splash.webContents.send('splash-status', "Prompting for passphrase...")
        let passphrase = await new Promise((resolve)=>{
          ipcMain.on('passphrase-set', (event, message)=>{
            resolve(message)
          })
        })

        /// Ok, when we're here, we got the passphrase from the splash-screen dialog.
        /// We need to append a new-line so the conductor knows where the passphrase ends.
        /// (the channel is kept open as long as Holoscape and conductor live...)
        client.write(""+passphrase+"\n")

        that.splash.webContents.send('splash-status', "Unlocking keystore...")
        if(!splashWasVisible) {
          that.splash.hide()
        }
      });
    }

    createMainWindow() {
      if(this.mainWindow) {
        return
      }
      let window = new BrowserWindow({
        width:1000,
        height:800,
        webPreferences: {
          nodeIntegration: true
        },
        show: true,
        icon: systemTrayIconFull(),
      })
      window.loadURL(path.join('file://', __dirname, 'views/main_window.html'))
      setupWindowDevProduction(window)

      let holoscape = this
      window.on('close', (event) => {
        if(!holoscape.quitting) event.preventDefault();
        window.hide();
        holoscape.updateTrayMenu()
      })

      this.mainWindow = window
      this.happUiController.setMainWindow(window)
      this.createViews()
      this.mainWindow.on('resize', () => {
        if(this.activeView) {
            this.showView(this.activeView)
        }
      })
    }

    createLogWindow() {
      let window = new BrowserWindow({
        width:1000,
        height:800,
        webPreferences: {
          nodeIntegration: true
        },
        minimizable: false,
        alwaysOnTop: true,
        show: false,
        icon: systemTrayIconFull(),
      })
      window.loadURL(path.join('file://', __dirname, 'views/conductor_log.html'))
      setupWindowDevProduction(window)

      let holoscape = this
      window.on('close', (event) => {
        if(!holoscape.quitting) event.preventDefault();
        window.hide();
        holoscape.updateTrayMenu()
      })

      this.logWindow = window
    }

    createConfigWindow() {
      let window = new BrowserWindow({
        width:1200,
        height:1200,
        webPreferences: {
          nodeIntegration: true
        },
        show: false,
        icon: systemTrayIconFull(),
      })
      window.loadURL(path.join('file://', __dirname, 'views/conductor_config.html'))
      setupWindowDevProduction(window)
      window.initialized = new Promise((resolve) => {
        ipcMain.on('config-window-initialized', ()=>{
          resolve()
        })
      })

      let holoscape = this
      window.on('close', (event) => {
        if(!holoscape.quitting) event.preventDefault();
        window.hide();
        holoscape.updateTrayMenu()
      })

      this.configWindow = window
    }

    createUiConfigWindow() {
      let window = new BrowserWindow({
        width:1200,
        height:800,
        webPreferences: {
          nodeIntegration: true
        },
        show: false,
        icon: systemTrayIconFull(),
      })
      window.loadURL(path.join('file://', __dirname, 'views/ui_config.html'))
      setupWindowDevProduction(window)

      window.initialized = new Promise((resolve) => {
        ipcMain.on('ui-config-window-initialized', ()=>{
          resolve()
        })
      })

      let holoscape = this
      window.on('close', (event) => {
        if(!holoscape.quitting) event.preventDefault();
        window.hide();
        holoscape.updateTrayMenu()
      })

      this.uiConfigWindow = window
    }

    createDebuggerWindow() {
      let window = new BrowserWindow({
        width:1200,
        height:800,
        webPreferences: {
          nodeIntegration: true
        },
        show: false,
        icon: systemTrayIconFull(),
      })
      window.loadURL(path.join('file://', __dirname, 'views/debug_view.html'))
      setupWindowDevProduction(window)

      window.initialized = new Promise((resolve) => {
        ipcMain.on('debug-window-initialized', ()=>{
          resolve()
        })
      })

      ipcMain.on('show-debug-view', () => {
        window.show()
      })

      let holoscape = this
      window.on('close', (event) => {
        if(!holoscape.quitting) event.preventDefault();
        window.hide();
        holoscape.updateTrayMenu()
      })

      this.debuggerWindow = window
    }

    createInstallBundleView() {
      let view = new BrowserView({
        webPreferences: {
          nodeIntegration: true
        },
        show: false,
        icon: systemTrayIconFull(),
      })
      view.webContents.loadURL(path.join('file://', __dirname, 'views/install_bundle_view.html'))
      //setupWindowDevProduction(view)

      view.initialized = new Promise((resolve) => {
        ipcMain.on('install-window-initialized', ()=>{
          resolve()
        })
      })

      this.mainWindow.addBrowserView(view)
      this.installBundleView = view
    }

    showInstallBundleView() {
      this.showView(this.installBundleView)
    }

    showView(view) {
      this.activeView = view
      let mainWindowBounds = this.mainWindow.getBounds()

      view.setBounds({x: 300, y: process.platform === "darwin" ? 21 : 0, width: mainWindowBounds.width-300, height: mainWindowBounds.height-66})
    }

    hideViews() {
      this.activeView = null
      this.installBundleView.setBounds({x: -200, y: 0, width: 100, height: 100})
    }

    updateTrayMenu(opt) {
      if(this.quitting) {
        return
      }
      const happMenu = Menu.buildFromTemplate(this.happUiController.createUiMenuTemplate())
      const settingsMenu = Menu.buildFromTemplate([
        { label: 'Conductor config...', type: 'checkbox', checked: this.configWindow.isVisible(), enabled: global.conductor_call != null, click: ()=>this.showHideConfig() },
        { label: 'Install UI...', click: ()=>this.happUiController.installUI() },
        { label: 'UI <> interface connections...', type: 'checkbox', checked: this.uiConfigWindow.isVisible(), enabled: global.conductor_call != null, click: ()=>this.showHideUiConfig() },
        { label: 'Reveal config directory', click: ()=>shell.openItem(conductor.rootConfigPath()) },
      ])
      const conductorMenu = Menu.buildFromTemplate([
        { label: 'Debug view', type: 'checkbox', checked: this.debuggerWindow.isVisible(), click: ()=>this.showHideDebuggerWindow() },
        { label: 'Show conductor log window', type: 'checkbox', checked: this.logWindow.isVisible(), click: ()=>this.showHideLogs() },
        { label: 'Shutdown conductor', visible: this.conductorProcess!=null, click: ()=>this.shutdownConductor() },
        { label: 'Boot conductor', visible: this.conductorProcess==null, click: ()=>this.bootConductor() },
      ])
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Holoscape', click: ()=>this.mainWindow.show() },
        { type: 'separator' },
        { label: 'Settings-'+conductor.persona(), type: 'submenu', submenu: settingsMenu },
        { label: 'Conductor Run-Time', type: 'submenu', submenu: conductorMenu },
        { type: 'separator' },
        { label: 'Quit', click: ()=> this.quit() }
      ])
      mb.tray.setToolTip('HoloScape')
      mb.tray.setContextMenu(contextMenu)
    }

    bootConductor() {
      if(this.conductorProcess) this.shutdownConductor()

      const log = (level, message) => {
        if(global.holoscape.quitting) return
        if(level == 'error') console.error(message)
        else console.log(message)
        global.holoscape.logMessages.push({level, message})
        while(global.holoscape.logMessages.length > 100) {
          global.holoscape.logMessages.shift()
        }
        if(global.holoscape.logWindow && global.holoscape.logWindow.webContents) {
          global.holoscape.logWindow.webContents.send('log', {level,message})
        }
        if(global.holoscape.splash && global.holoscape.splash.webContents) {
          global.holoscape.splash.webContents.send('log', {level,message})
        }
      }

      const onExit = () => {
        this.conductorProcess = null
        this.updateTrayMenu()
        mb.tray.setImage(systemTrayIconEmpty())
      }

      let process = conductor.start(log, onExit)

      app.on('before-quit', () => {
        process.kill('SIGINT');
      })
      this.conductorProcess = process
      this.connectConductor()
    }

    shutdownConductor() {
      if(this.conductorProcess) {
        this.conductorProcess.kill('SIGINT')
        this.conductorProcess = null
        this.conductorPassphraseClient = null
        global.conductor_call = null
        this.updateTrayMenu()
        mb.tray.setImage(systemTrayIconEmpty())
      }
    }

    showHideLogs() {
      if(this.logWindow.isVisible()) {
        this.logWindow.hide()
      } else {
        this.logWindow.show()
      }
    }

    showHideConfig() {
      if(this.configWindow.isVisible()) {
        this.configWindow.hide()
      } else {
        this.configWindow.webContents.send('refresh')
        this.configWindow.show()
      }
    }

    showHideUiConfig() {
      if(this.uiConfigWindow.isVisible()) {
        this.uiConfigWindow.hide()
      } else {
        this.uiConfigWindow.show()
      }
    }

    showHideDebuggerWindow() {
      if(this.debuggerWindow.isVisible()) {
        this.debuggerindow.hide()
      } else {
        this.debuggerWindow.show()
      }
    }

    connectConductor() {
      console.log(`connectConductor ws://localhost:${conductor.adminPort()}`)
      connect({url:`ws://localhost:${conductor.adminPort()}`}).then(({call, callZome, close, onSignal}) => {
        onSignal((params) => {
          if(this.quitting) return
          this.debuggerWindow.webContents.send('hc-signal', params)
          if(params.instance_stats) {
            this.mainWindow.webContents.send('instance-stats', params.instance_stats)
          }
          //console.log(JSON.stringify(params))
          if (params.signal && params.signal.name === 'switch_view') {
            const { view, location } = JSON.parse(params.signal.arguments)
            console.log('Open ' + view + ' for ' + location)
            this.happUiController.showAndRiseUI(view, `${location}`)
          }
        })
        console.log(`connectConductor connected`)
        global.conductor_call = call
        mb.tray.setImage(systemTrayIconFull())
        this.updateTrayMenu()
        this.splash.hide()
        this.createMainWindow()

        for(let window of [this.configWindow, this.uiConfigWindow, this.debuggerWindow, this.installBundleView]) {
          window.initialized.then(() => window.webContents.send('conductor-call-set'))
        }

      }).catch((error)=> {
        console.error('Holoscape could not connect to conductor', error)
        global.holoscape.checkConductorConnection()
      })
    }

    quit() {
      this.shutdownConductor()
      this.quitting=true
      mb.app.quit()
    }

    hash(params) {
      return cli.hash(params)
    }

    notifyNewHapp(name, ui) {
      this.mainWindow.webContents.send('happ-added', {name, ui})
    }

    notifyUiActivated(name) {
      this.mainWindow.webContents.send('ui-activated', {name})
    }
  }

const systemTrayIconFull = () => {
  if(process.platform === "darwin") {
    return path.join(__dirname, 'images/HoloScape-22px.png')
  } else {
    return path.join(__dirname, 'images/HoloScape-system-tray.png')
  }
}

const systemTrayIconEmpty = () => {
  if(process.platform === "darwin") {
    return path.join(__dirname, 'images/Holochain-22px.png')
  } else {
    return path.join(__dirname, 'images/Holochain50+alpha.png')
  }
}

module.exports = {
    Holoscape,
    sanitizeUINameForScheme,
    systemTrayIconFull,
    systemTrayIconEmpty,
}
