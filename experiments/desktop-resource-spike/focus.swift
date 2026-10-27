import AppKit
import WebKit

func foreground()->[String:Any] {
    let f=NSWorkspace.shared.frontmostApplication
    return ["wallTime":Date().timeIntervalSince1970,"bundle":f?.bundleIdentifier ?? "unknown",
      "pid":f?.processIdentifier ?? -1,"name":f?.localizedName ?? "unknown"]
}
if CommandLine.arguments[1] == "observe" {
    for _ in 0..<80 {
        let d=try! JSONSerialization.data(withJSONObject:foreground(),options:[.sortedKeys])
        print(String(data:d,encoding:.utf8)!);fflush(stdout);Thread.sleep(forTimeInterval:0.2)
    }
} else {
    final class Focus: NSObject,NSApplicationDelegate,WKNavigationDelegate {
        var window:NSWindow!;var web:WKWebView!;var rows=[[String:Any]]();var count=0
        var timer:Timer!
        let args=CommandLine.arguments
        func applicationDidFinishLaunching(_ n:Notification) {
            let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
            web=WKWebView(frame:NSRect(x:0,y:0,width:1000,height:700),configuration:config);web.navigationDelegate=self
            window=NSWindow(contentRect:NSRect(x:60,y:60,width:1000,height:700),styleMask:[.titled,.closable],backing:.buffered,defer:false)
            window.contentView=web;window.title="One-shot focus diagnostic — WK"
            web.load(URLRequest(url:URL(string:args[1])!))
            DispatchQueue.main.asyncAfter(deadline:.now()+10) { self.finish() }
        }
        func webView(_ w:WKWebView,didFinish n:WKNavigation!) {
            // Exactly one activation attempt. No retries or persistent focus forcing.
            window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true);window.makeFirstResponder(web)
            timer=Timer.scheduledTimer(withTimeInterval:0.2,repeats:true) { _ in
                var row=foreground();row["nativeKey"]=self.window.isKeyWindow;row["nativeActive"]=NSApp.isActive
                self.web.evaluateJavaScript("({focus:document.hasFocus(),visible:document.visibilityState,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,ready:!!window.probe?.ready})") { value,error in
                    row["document"]=value ?? NSNull();if let e=error {row["error"]=String(describing:e)}
                    self.rows.append(row);self.count+=1;if self.count>=20 {self.finish()}
                }
            }
        }
        func finish() {
            timer?.invalidate()
            let d=try! JSONSerialization.data(withJSONObject:["host":"WK","activationAttempts":1,"samples":rows],options:[.prettyPrinted,.sortedKeys])
            try! d.write(to:URL(fileURLWithPath:args[2]));NSApp.terminate(nil)
        }
    }
    let app=NSApplication.shared;app.setActivationPolicy(.regular);let delegate=Focus();app.delegate=delegate;app.run()
}
