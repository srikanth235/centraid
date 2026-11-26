package dev.centraid.android.kit

import android.content.Context
import centraid.core.v1.DeleteModelFile
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectRequest
import centraid.core.v1.EffectResult
import centraid.core.v1.ModelDownload
import dev.centraid.core.Screens
import java.io.File
import java.util.concurrent.ConcurrentHashMap

internal object ChatEffects {
    private val allowed = ConcurrentHashMap<String, Boolean>()

    fun deleteModelFile(asked: DeleteModelFile): EffectResult {
        val name = asked.file_name
        if (name.isEmpty() || name.contains('/') || name.contains("..")) return EffectResult(done = EffectDone())
        File(asked.models_dir, name).delete()
        return EffectResult(done = EffectDone())
    }

    fun download(context: Context, screens: Screens, request: EffectRequest, asked: ModelDownload): EffectResult {
        val target = File(asked.models_dir, asked.file_name)
        allowed[target.path] = asked.allow_cellular
        if (asked.sha256.isEmpty() && !asked.vision) return EffectResult(done = EffectDone())
        return EffectResult(done = EffectDone())
    }
}
