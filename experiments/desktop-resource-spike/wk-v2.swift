import AppKit
import WebKit

// Minimal AppKit host, explicitly NOT a Tauri app.
final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var mode = "blank"
    let args = CommandLine.arguments
    var origin: String { args[1] }
    var run: String { args[2] }
    func mark(_ kind:String,_ phase:String,_ data:[String:Any]=[:],_ done:@escaping ()->Void={}) {
        var payload=data; payload["kind"]=kind; payload["phase"]=phase; payload["run"]=run
        var request=URLRequest(url:URL(string:origin+"/mark")!);request.httpMethod="POST"
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody=try! JSONSerialization.data(withJSONObject:payload)
        URLSession.shared.dataTask(with:request) { _,_,_ in DispatchQueue.main.async { done() } }.resume()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { false }
    func applicationDidFinishLaunching(_ notification:Notification) {
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        web=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:700),configuration:config)
        web.navigationDelegate=self
        window=NSWindow(contentRect:NSRect(x:60,y:60,width:1000,height:700),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.title="Resource spike v2 — WK (not Tauri)";window.contentView=web
        let bundle=Bundle(path:"/System/Library/Frameworks/WebKit.framework")!
        mark("register","setup",["pid":ProcessInfo.processInfo.processIdentifier,
          "webkitBuild":bundle.object(forInfoDictionaryKey:"CFBundleVersion") ?? "unknown", "persistentDataStore":false]) {
            self.web.load(URLRequest(url:URL(string:self.origin+"/empty")!))
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+65) { self.mark("failure","host",["error":"65s timeout"]) { NSApp.terminate(nil) } }
    }
    func native()->[String:Any] { ["visible":window.isVisible,"focus":window.isKeyWindow,"appActive":NSApp.isActive,
      "frame":NSStringFromRect(window.frame),"content":NSStringFromRect(web.frame),"backingScale":window.backingScaleFactor] }
    func webView(_ view:WKWebView,didFinish navigation:WKNavigation!) {
        runPhase()
    }
    func runPhase() {
        window.setContentSize(NSSize(width:1000,height:700));window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true);window.makeFirstResponder(web)
        mark("native",mode,["native":native()])
        do {
            let source=try String(contentsOfFile:args[3],encoding:.utf8)
            let json=try JSONSerialization.data(withJSONObject:[origin,run,mode]);let list=String(data:json,encoding:.utf8)!
            web.callAsyncJavaScript(source+";return await resourceProbe(..."+list+");",arguments:[:],in:nil,in:.page) { response in
                switch response {
                case .failure(let error):self.mark("failure","host",["error":String(describing:error)]) { NSApp.terminate(nil) }
                case .success:
                    self.mark("native",self.mode+"-end",["native":self.native()]) {
                        if self.mode == "blank" {
                            self.mode="reading";self.web.load(URLRequest(url:URL(string:self.origin+"/?count=500&mode=managed&dynamic=1")!))
                        } else if self.mode == "reading" {self.mode="load";self.runPhase()}
                        else { self.closeAndSample() }
                    }
                }
            }
        }catch { mark("failure","host",["error":String(describing:error)]) { NSApp.terminate(nil) } }
    }
    func closeAndSample() {
        web.stopLoading();window.contentView=nil;web=nil;window.close();window=nil
        DispatchQueue.main.asyncAfter(deadline:.now()+2) {
            self.mark("begin","closed",["windows":NSApp.windows.filter{$0.isVisible}.count]) {
                DispatchQueue.main.asyncAfter(deadline:.now()+8) {
                    self.mark("end","closed",["windows":NSApp.windows.filter{$0.isVisible}.count]) { NSApp.terminate(nil) }
                }
            }
        }
    }
}
let app=NSApplication.shared;app.setActivationPolicy(.regular)
let delegate=Probe();app.delegate=delegate;app.run()
