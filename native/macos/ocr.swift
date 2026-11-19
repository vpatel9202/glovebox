// glovebox-ocr: text in an image, through macOS Vision. Reads a PNG or JPEG
// on stdin and prints one JSON array: [{text, confidence, frame: [x, y, w, h]}]
// with the frame in image pixels, (0, 0) at the top left. Works on image
// data only, so it needs no privacy permission.
import Foundation
import ImageIO
import Vision

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write("glovebox-ocr: not an image\n".data(using: .utf8)!)
    exit(1)
}
let width = Double(image.width), height = Double(image.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
let languages = CommandLine.arguments.dropFirst()
if !languages.isEmpty { request.recognitionLanguages = Array(languages) }
do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("glovebox-ocr: \(error)\n".data(using: .utf8)!)
    exit(1)
}
var out: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let best = observation.topCandidates(1).first else { continue }
    let b = observation.boundingBox // normalized, origin at the bottom left
    out.append([
        "text": best.string,
        "confidence": Double(best.confidence),
        "frame": [b.minX * width, (1 - b.maxY) * height, b.width * width, b.height * height].map { $0.rounded() },
    ])
}
let json = try JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
