package dev.centraid.android.kit

import centraid.core.v1.DeleteModelFile
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import java.io.File

internal object ChatEffects {
    fun deleteModelFile(asked: DeleteModelFile): EffectResult {
        val name = asked.file_name
        if (name.isEmpty() || name.contains('/') || name.contains("..")) return EffectResult(failed = EffectFailed(reason = EffectReason.UNWRITABLE))
        val target = File(asked.models_dir, name)
        return if (!target.exists() || target.delete()) EffectResult(done = EffectDone())
        else EffectResult(failed = EffectFailed(reason = EffectReason.UNWRITABLE))
    }

}
