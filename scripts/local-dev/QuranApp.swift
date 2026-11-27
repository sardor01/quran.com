// A small native macOS app around the private local copy of the site, so it has its own window and
// Dock icon. It runs `local-app.sh serve` (build if needed, then app + gateway on 127.0.0.1), shows a
// loading screen until the site answers, and stops the servers when it quits.
//
// Built by `scripts/local-dev/local-app.sh make-app`; the launcher path comes from Info.plist.

import Cocoa
import WebKit

let appURL = URL(string: "http://127.0.0.1:3200/")!
let supportDir = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/QuranLocal")
let statusFile = supportDir.appendingPathComponent("status")

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var server: Process?
  var pollTimer: Timer?
  var isQuitting = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()

    let config = WKWebViewConfiguration()
    config.mediaTypesRequiringUserActionForPlayback = []
    config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15"
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 850),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Quran"
    window.contentView = webView
    window.center()
    window.setFrameAutosaveName("QuranMainWindow")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    showLoading("Starting…")
    startServer()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    isQuitting = true
    pollTimer?.invalidate()
    // The launcher stops the app server and gateway when it receives SIGTERM.
    if let server = server, server.isRunning {
      server.terminate()
      let deadline = Date().addingTimeInterval(5)
      while server.isRunning && Date() < deadline { usleep(100_000) }
    }
  }

  // MARK: - Server

  func startServer() {
    guard let launcher = Bundle.main.object(forInfoDictionaryKey: "QuranLauncher") as? String else {
      showLoading("This app was built without a launcher path. Run make-app again.", isError: true)
      return
    }
    try? FileManager.default.removeItem(at: statusFile)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [launcher, "serve"]
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self, !self.isQuitting else { return }
        self.pollTimer?.invalidate()
        self.showLoading(
          "Quran stopped unexpectedly. Details: ~/Library/Logs/quran-local/app.log", isError: true)
      }
    }
    do {
      try process.run()
      server = process
    } catch {
      showLoading("Could not start: \(error.localizedDescription)", isError: true)
      return
    }

    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      self?.checkServer()
    }
  }

  func checkServer() {
    if let status = try? String(contentsOf: statusFile, encoding: .utf8), !status.isEmpty {
      updateLoadingText(status.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    var request = URLRequest(url: appURL)
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
      DispatchQueue.main.async {
        guard let self = self, self.pollTimer != nil else { return }
        self.pollTimer?.invalidate()
        self.pollTimer = nil
        self.webView.load(URLRequest(url: appURL))
      }
    }.resume()
  }

  // MARK: - Loading screen

  func showLoading(_ text: String, isError: Bool = false) {
    let html = """
      <html><head><meta charset="utf-8"><style>
      html,body{height:100%;margin:0;background:#1f2125;color:#e8e8e8;
        font:15px -apple-system,BlinkMacSystemFont,sans-serif}
      body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
      .spinner{width:28px;height:28px;border:3px solid #3a3d42;border-top-color:#2ca4ab;
        border-radius:50%;animation:spin 1s linear infinite}
      @keyframes spin{to{transform:rotate(360deg)}}
      #text{max-width:460px;text-align:center;line-height:1.5}
      </style></head><body>
      \(isError ? "" : "<div class=\"spinner\"></div>")
      <div id="text"></div>
      </body></html>
      """
    webView.loadHTMLString(html, baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.updateLoadingText(text) }
  }

  func updateLoadingText(_ text: String) {
    guard webView.url?.host != appURL.host else { return }
    let escaped = text.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "'", with: "\\'")
    webView.evaluateJavaScript(
      "var t=document.getElementById('text'); if (t) t.textContent='\(escaped)';")
  }

  // MARK: - Self-test (only with QURAN_SELFTEST=1; prints results and quits)

  var selfTestStarted = false
  let isSelfTest = ProcessInfo.processInfo.environment["QURAN_SELFTEST"] == "1"

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard isSelfTest, webView.url?.host == appURL.host else { return }
    if webView.url?.path != "/1" {
      if !selfTestStarted { webView.load(URLRequest(url: appURL.appendingPathComponent("1"))) }
      return
    }
    guard !selfTestStarted else { return }
    selfTestStarted = true
    runSelfTest()
  }

  func runSelfTest() {
    let state = """
      const el = document.getElementById('audio-player');
      return JSON.stringify({visibility: document.visibilityState, paused: el.paused,
        t: +el.currentTime.toFixed(2), title: document.title, mediaSession: 'mediaSession' in navigator});
      """
    let play = """
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60 && !window.audioPlayerEl; i++) await wait(250);
      [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Listen').click();
      const player = document.getElementById('audio-player');
      for (let i = 0; i < 60 && !(!player.paused && player.currentTime > 1.5); i++) await wait(250);
      """ + state
    func run(_ label: String, _ js: String, then next: @escaping () -> Void) {
      webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
        let value = (try? result.get()).map { "\($0)" } ?? "error: \(result)"
        print("SELFTEST \(label): \(value)")
        fflush(stdout)
        next()
      }
    }
    run("playing", play) {
      self.window.miniaturize(nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
        run("minimized", state) {
          self.window.deminiaturize(nil)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            run("restored", state) { NSApp.terminate(nil) }
          }
        }
      }
    }
  }

  // MARK: - Links

  // Links to other sites open in the default browser; the app only shows the local site.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if let url = navigationAction.request.url, isExternal(url),
      navigationAction.navigationType == .linkActivated
    {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  // target="_blank" links and window.open().
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url {
      if isExternal(url) { NSWorkspace.shared.open(url) } else { webView.load(URLRequest(url: url)) }
    }
    return nil
  }

  func isExternal(_ url: URL) -> Bool {
    guard let scheme = url.scheme, scheme == "http" || scheme == "https" else { return false }
    return url.host != appURL.host || url.port != appURL.port
  }

  // MARK: - Menu

  func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Hide Quran", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Quran", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    viewMenu.addItem(withTitle: "Back", action: #selector(goBack), keyEquivalent: "[")
    viewMenu.addItem(withTitle: "Forward", action: #selector(goForward), keyEquivalent: "]")
    viewItem.submenu = viewMenu
    main.addItem(viewItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)

    NSApp.mainMenu = main
    NSApp.windowsMenu = windowMenu
  }

  @objc func reload() { webView.reload() }
  @objc func goBack() { webView.goBack() }
  @objc func goForward() { webView.goForward() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
