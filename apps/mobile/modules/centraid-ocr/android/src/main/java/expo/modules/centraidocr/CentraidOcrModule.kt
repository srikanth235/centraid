package expo.modules.centraidocr

import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

private const val MAX_BYTES = 25L * 1024L * 1024L
private const val MAX_PIXELS = 20_000_000L

class CentraidOcrModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CentraidOcr")

    AsyncFunction("recognizeText") { rawUri: String, promise: Promise ->
      try {
        val uri = Uri.parse(rawUri)
        require(uri.scheme == "file") { "OCR accepts local file URLs only." }
        val file = File(requireNotNull(uri.path))
        require(file.length() <= MAX_BYTES) {
          "Scan exceeds the 25 MB on-device OCR limit."
        }
        val context = requireNotNull(appContext.reactContext)
        val image = InputImage.fromFilePath(context, uri)
        require(image.width.toLong() * image.height.toLong() <= MAX_PIXELS) {
          "Scan exceeds the 20 megapixel on-device OCR limit."
        }
        val recognizer =
          TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        recognizer.process(image)
          .addOnSuccessListener { result ->
            val lines = result.textBlocks.flatMap { block ->
              block.lines.map { line ->
                mapOf(
                  "text" to line.text,
                  // The bundled Latin recognizer does not expose a stable
                  // per-line confidence, so report extraction confidence as
                  // present/absent and keep every field reviewable.
                  "confidence" to if (line.text.isBlank()) 0.0 else 1.0
                )
              }
            }
            val confidence =
              if (lines.isEmpty()) 0.0
              else lines.map { it["confidence"] as Double }.average()
            promise.resolve(
              mapOf(
                "text" to result.text,
                "confidence" to confidence,
                "lines" to lines,
                "engine" to "ml-kit"
              )
            )
            recognizer.close()
          }
          .addOnFailureListener { error ->
            recognizer.close()
            promise.reject("ERR_OCR", error.message, error)
          }
      } catch (error: Throwable) {
        promise.reject("ERR_OCR", error.message, error)
      }
    }
  }
}
