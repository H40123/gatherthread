// A static, local-only installation background. Reuses the approved wordmark;
// it never redraws the brand or opens an application/window.
import AppKit
import CryptoKit

struct Layout: Decodable {
    let width: Int
    let height: Int
    let scale: Int
    let logo: String
    let logo_sha256: String
    let version: String
    let title: String
    let subtitle: String
    let arrow: [Double]
    let instructions: [String]
}

guard CommandLine.arguments.count == 4 else {
    fatalError("Usage: RenderBackground <layout.json> <source-root> <background.png>")
}
let layoutURL = URL(fileURLWithPath: CommandLine.arguments[1])
let root = URL(fileURLWithPath: CommandLine.arguments[2])
let output = URL(fileURLWithPath: CommandLine.arguments[3])
let layout = try JSONDecoder().decode(Layout.self, from: Data(contentsOf: layoutURL))
guard layout.width == 720, layout.height == 560, layout.scale == 2,
      layout.arrow.count == 4, layout.arrow[0] > layout.arrow[2], layout.instructions.count == 6,
      !FileManager.default.fileExists(atPath: output.path) else {
    fatalError("Invalid layout or existing output; use a fresh background path")
}
let logoURL = root.appendingPathComponent(layout.logo)
let logoData = try Data(contentsOf: logoURL)
let logoHash = SHA256.hash(data: logoData).map { String(format: "%02x", $0) }.joined()
guard logoHash == layout.logo_sha256, let logo = NSImage(data: logoData) else {
    fatalError("Approved GatherThread wordmark checksum mismatch")
}
let width = CGFloat(layout.width), height = CGFloat(layout.height), scale = CGFloat(layout.scale)
guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
    pixelsWide: layout.width * layout.scale, pixelsHigh: layout.height * layout.scale,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
    let base = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create installation background")
}
bitmap.size = NSSize(width: width, height: height)
let cg = base.cgContext
cg.scaleBy(x: scale, y: scale)
cg.translateBy(x: 0, y: height)
cg.scaleBy(x: 1, y: -1)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

let paper = NSColor(srgbRed: 251/255, green: 250/255, blue: 247/255, alpha: 1)
let ink = NSColor(srgbRed: 8/255, green: 17/255, blue: 31/255, alpha: 1)
let quiet = NSColor(srgbRed: 80/255, green: 88/255, blue: 98/255, alpha: 1)
paper.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()
logo.draw(in: NSRect(x: 40, y: 30, width: 252, height: 42), from: .zero,
          operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)

func text(_ content: String, x: CGFloat, y: CGFloat, width: CGFloat,
          size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = ink) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    paragraph.lineSpacing = 3
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: color, .paragraphStyle: paragraph
    ]
    (content as NSString).draw(in: NSRect(x: x, y: y, width: width, height: 54), withAttributes: attrs)
}
text(layout.version, x: 557, y: 43, width: 140, size: 13, color: quiet)
text(layout.title, x: 40, y: 91, width: 640, size: 20, weight: .semibold)
text(layout.subtitle, x: 40, y: 122, width: 640, size: 14, color: quiet)

// Point from the right-hand application to the left-hand Applications folder.
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: layout.arrow[0], y: layout.arrow[1]))
arrow.line(to: NSPoint(x: layout.arrow[2], y: layout.arrow[3]))
arrow.move(to: NSPoint(x: layout.arrow[2] + 15, y: layout.arrow[3] - 13))
arrow.line(to: NSPoint(x: layout.arrow[2], y: layout.arrow[3]))
arrow.line(to: NSPoint(x: layout.arrow[2] + 15, y: layout.arrow[3] + 13))
arrow.lineWidth = 3
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
quiet.setStroke()
arrow.stroke()

let rule = NSBezierPath()
rule.move(to: NSPoint(x: 40, y: 313))
rule.line(to: NSPoint(x: 680, y: 313))
rule.lineWidth = 1
NSColor(srgbRed: 220/255, green: 221/255, blue: 219/255, alpha: 1).setStroke()
rule.stroke()

text(layout.instructions[0], x: 40, y: 331, width: 640, size: 15, weight: .semibold)
text(layout.instructions[1], x: 40, y: 357, width: 640, size: 14, color: quiet)
text(layout.instructions[2], x: 40, y: 383, width: 640, size: 13, color: quiet)
text(layout.instructions[3], x: 40, y: 404, width: 640, size: 13, color: quiet)
text(layout.instructions[4], x: 40, y: 455, width: 640, size: 14, weight: .semibold)
text(layout.instructions[5], x: 40, y: 484, width: 640, size: 13, color: quiet)

NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode installation background")
}
try png.write(to: output, options: .withoutOverwriting)
