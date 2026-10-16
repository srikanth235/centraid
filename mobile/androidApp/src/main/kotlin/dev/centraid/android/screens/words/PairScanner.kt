package dev.centraid.android.screens.words

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import dev.centraid.shared.custody.CustodyCopy
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import dev.centraid.android.kit.OutlineButton

/**
 * THE SQUARE, READ BY THE CAMERA (#1047 E6) — the Android twin of iOS
 * `PairScanner`. A CameraX preview and an `ImageAnalysis` that hands each
 * frame's luminance plane to ZXing's QR reader, answering the first code it
 * reads once: a scan is a deliberate act and pairs at once (`Scanned`).
 *
 * ZXING, NOT ML KIT OR THE PLAY SERVICES SCANNER: the reader is a small pure-
 * Java Apache-2.0 library that runs on a phone with no Play Services, ships no
 * model and downloads nothing; `ALSO_INVERTED` reads the laptop's square when a
 * dark terminal draws it light-on-dark.
 *
 * The CAMERA grant is `WordsSheets`' to ask for, at the moment the member
 * tapped Scan and never before; this dialog is drawn only once it is held.
 * [onPhoto] closes it for the photo picker; [onCancel] closes it; the paste
 * field is still there.
 */
@Composable
internal fun PairScanner(
    photoLabel: String,
    onRead: (String) -> Unit,
    onPhoto: () -> Unit,
    onCancel: () -> Unit,
) {
    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("pair-scanner")) {
            CameraPreview(onRead)
            OutlineButton(
                label = CustodyCopy.CANCEL,
                testTag = "pair-scan-close",
                ink = "onAccent",
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .safeDrawingPadding()
                    .padding(16.dp),
                onPress = onCancel,
            )
            // A SCREENSHOT OF THE SQUARE, from the camera screen.
            if (photoLabel.isNotEmpty()) {
                OutlineButton(
                    label = photoLabel,
                    testTag = "pair-scan-photo",
                    ink = "onAccent",
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .safeDrawingPadding()
                        .padding(24.dp),
                    onPress = onPhoto,
                )
            }
        }
    }
}

@Composable
private fun CameraPreview(onRead: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val read by rememberUpdatedState(onRead)
    val view = remember { PreviewView(context) }
    DisposableEffect(owner) {
        val answered = AtomicBoolean(false)
        val main = Handler(Looper.getMainLooper())
        val worker = Executors.newSingleThreadExecutor()
        val reader = MultiFormatReader().apply {
            setHints(
                mapOf(
                    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                    DecodeHintType.TRY_HARDER to true,
                    DecodeHintType.ALSO_INVERTED to true,
                ),
            )
        }
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(worker) { image ->
            val code = if (answered.get()) null else decode(reader, image)
            image.close()
            if (code != null && answered.compareAndSet(false, true)) main.post { read(code) }
        }
        var provider: ProcessCameraProvider? = null
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
            {
                val cameras = runCatching { future.get() }.getOrNull() ?: return@addListener
                provider = cameras
                val selector = when {
                    runCatching { cameras.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) }.getOrDefault(false) ->
                        CameraSelector.DEFAULT_BACK_CAMERA
                    else -> CameraSelector.DEFAULT_FRONT_CAMERA
                }
                runCatching {
                    cameras.unbindAll()
                    cameras.bindToLifecycle(owner, selector, preview, analysis)
                }
            },
            ContextCompat.getMainExecutor(context),
        )
        onDispose {
            answered.set(true)
            runCatching { provider?.unbind(preview, analysis) }
            analysis.clearAnalyzer()
            worker.shutdown()
        }
    }
    AndroidView(factory = { view }, modifier = Modifier.fillMaxSize())
}

/** One frame's Y plane, as ZXing reads it; null when it holds no QR code. */
private fun decode(reader: MultiFormatReader, image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer.duplicate().apply { rewind() }
    val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
    val stride = plane.rowStride
    if (bytes.size < stride * (image.height - 1) + image.width) return null
    val source = PlanarYUVLuminanceSource(bytes, stride, image.height, 0, 0, image.width, image.height, false)
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: ReaderException) {
        null
    } finally {
        reader.reset()
    }
}

/**
 * THE SQUARE, READ OUT OF A PHOTO — the camera-less scan (`PhotoTapped`). The
 * system photo picker hands back one image the member chose (no storage grant:
 * the picker is the grant), and the same ZXing reader decodes it. Null when the
 * image holds no QR code, or will not decode. Large photos are sampled down to
 * about 2048 px on the long side first: a QR read needs the module grid, not
 * every pixel, and a full-size bitmap is tens of megabytes. Call off the main
 * thread.
 */
internal fun readSquare(context: Context, uri: Uri): String? {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2048) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    val source = RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
    bitmap.recycle()
    val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
                DecodeHintType.ALSO_INVERTED to true,
            ),
        )
    }
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
    } catch (_: ReaderException) {
        null
    }
}
