package dev.centraid.android.screens.chat

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * DICTATION, ON THIS PHONE ONLY (#1188 NC6). The recogniser is Android's on-device one
 * (`createOnDeviceSpeechRecognizer`, Android 13 and later): a phone without it has no key, so a
 * dictated word is never sent to a service. The microphone is asked for at the first tap on the key.
 */
internal class ChatDictation(private val context: Context) {
    enum class Phase { Idle, Listening, Refused }

    var phase by mutableStateOf(Phase.Idle)
        private set

    private var recognizer: SpeechRecognizer? = null

    /** Whether this phone can recognise speech without a network. */
    val available: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    fun refuse() {
        phase = Phase.Refused
    }

    /** Start listening; `onWords` gets everything heard so far each time it grows. */
    fun start(onWords: (String) -> Unit) {
        if (!available || phase == Phase.Listening || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val engine = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        recognizer = engine
        engine.setRecognitionListener(object : RecognitionListener {
            override fun onPartialResults(partialResults: Bundle?) = heard(partialResults, onWords)
            override fun onResults(results: Bundle?) {
                heard(results, onWords)
                stop()
            }
            override fun onError(error: Int) {
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) phase = Phase.Refused
                stop()
            }
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        phase = Phase.Listening
        engine.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true),
        )
    }

    fun stop() {
        recognizer?.run {
            stopListening()
            destroy()
        }
        recognizer = null
        if (phase == Phase.Listening) phase = Phase.Idle
    }

    private fun heard(bundle: Bundle?, onWords: (String) -> Unit) {
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let(onWords)
    }
}
