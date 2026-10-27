import Foundation
import CoreGraphics
import Vision


// Local OCR only. Usage: ocr source.pdf output-directory first-page last-page
let args = CommandLine.arguments
if args.count != 5 { fatalError("Usage: ocr source.pdf output-directory first-page last-page") }
let source = args[1], output = args[2]
let first = Int(args[3])!, last = Int(args[4])!
let queue = OperationQueue()
queue.maxConcurrentOperationCount = 4
for number in first...last {
    queue.addOperation {
        autoreleasepool {
            let dest = URL(fileURLWithPath: output).appendingPathComponent(String(format: "%04d.json", number))
            if FileManager.default.fileExists(atPath: dest.path) { return }
            do {
                guard let doc = CGPDFDocument(URL(fileURLWithPath: source) as CFURL), let page = doc.page(at: number) else { throw NSError(domain:"PDF",code:1) }
                let bounds = page.getBoxRect(.mediaBox)
                let width = 2016, height = Int(2016 * bounds.height / bounds.width)
                guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw NSError(domain:"image",code:2) }
                context.setFillColor(CGColor(gray: 1, alpha: 1))
                context.fill(CGRect(x: 0, y: 0, width: width, height: height))
                context.scaleBy(x: CGFloat(width) / bounds.width, y: CGFloat(height) / bounds.height)
                context.drawPDFPage(page)
                guard let cgImage = context.makeImage() else { throw NSError(domain:"image",code:3) }
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.recognitionLanguages = ["zh-Hans", "en-US"]
                request.usesLanguageCorrection = true
                try VNImageRequestHandler(cgImage: cgImage).perform([request])
                let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
                    guard let candidate = observation.topCandidates(1).first else { return nil }
                    let box = observation.boundingBox
                    return ["text": candidate.string, "confidence": candidate.confidence, "bbox": [box.minX, box.minY, box.width, box.height]]
                }
                let record: [String: Any] = ["pdf_page":number, "engine":"Apple Vision VNRecognizeTextRequest", "languages":["zh-Hans","en-US"], "image_width":cgImage.width, "image_height":cgImage.height, "lines":lines, "text":lines.map { $0["text"] as! String }.joined(separator:"\n")]
                try JSONSerialization.data(withJSONObject:record, options:[.prettyPrinted,.sortedKeys,.withoutEscapingSlashes]).write(to:dest, options:.atomic)
                print("OCR \(number): \(lines.count) lines")
            } catch { fputs("ERROR page \(number): \(error)\n", stderr) }
        }
    }
}
queue.waitUntilAllOperationsAreFinished()
