package dev.centraid.android.screens.words

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
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import dev.centraid.android.kit.QuietButton
import dev.centraid.shared.custody.CustodyCopy
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

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
 * [onCancel] closes it; the paste field is still there.
 */
@Composable
internal fun PairScanner(onRead: (String) -> Unit, onCancel: () -> Unit) {
    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("pair-scanner")) {
            CameraPreview(onRead)
            QuietButton(
                label = CustodyCopy.CANCEL,
                testTag = "pair-scan-close",
                ink = "onAccent",
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .safeDrawingPadding()
                    .padding(16.dp),
                onPress = onCancel,
            )
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
