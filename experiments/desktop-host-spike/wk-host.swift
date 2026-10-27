import AppKit
import WebKit

// A minimal native compatibility sampler. This is NOT a Tauri application.
final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var finished = false
    var result: [String: Any] = [:]
    let args = CommandLine.arguments
    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let errors = "window.spikeErrors=[];addEventListener('error',e=>spikeErrors.push({type:'error',message:e.message}));addEventListener('unhandledrejection',e=>spikeErrors.push({type:'rejection',message:String(e.reason)}));"
        configuration.userContentController.addUserScript(WKUserScript(source: errors, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 1000), configuration: configuration)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 50,y: 50,width: 1440,height: 1000),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.title = "WKWebView compatibility sample — not Tauri"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let bundle = Bundle(path: "/System/Library/Frameworks/WebKit.framework")!
        result = ["host":"Swift/AppKit/WKWebView (not Tauri)","webKitBundleVersion":bundle.object(forInfoDictionaryKey:"CFBundleVersion") ?? "unknown",
                  "webKitShortVersion":bundle.object(forInfoDictionaryKey:"CFBundleShortVersionString") ?? "unknown",
                  "os":ProcessInfo.processInfo.operatingSystemVersionString,"configuration":["show":true,"headless":false,"persistentDataStore":false]]
        web.load(URLRequest(url: URL(string: args[1])!))
        DispatchQueue.main.asyncAfter(deadline:.now()+35) { self.finish(error:"WKWebView 35s timeout") }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        do {
            let source = try String(contentsOfFile:args[2],encoding:.utf8)
            web.callAsyncJavaScript("return await (" + source + ");", arguments:[:],in:nil,in:.page) { response in
                switch response {
                case .success(let value): self.result["renderer"] = value
                case .failure(let error): self.result["failure"] = String(describing:error)
                }
                self.result["window"] = ["visible":self.window.isVisible,"key":self.window.isKeyWindow,"frame":NSStringFromRect(self.window.frame),"backingScale":self.window.backingScaleFactor]
                self.web.takeSnapshot(with:nil) { image,error in
                    if let image = image, let data=image.tiffRepresentation, let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]) {
                        try? png.write(to: URL(fileURLWithPath:self.args[4]))
                    }
                    if let error=error { self.result["snapshotError"]=String(describing:error) }
                    self.finish()
                }
            }
        } catch { finish(error:String(describing:error)) }
    }
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) { finish(error:String(describing:error)) }
    func finish(error:String? = nil) {
        if finished { return }; finished=true
        if let error=error { result["failure"]=error }
        if let data=try? JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]) { try? data.write(to:URL(fileURLWithPath:args[3])) }
        web.stopLoading(); window.orderOut(nil); NSApp.terminate(nil)
    }
}
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let delegate=Probe()
app.delegate=delegate
app.run()
