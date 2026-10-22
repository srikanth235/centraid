package dev.centraid.shared.catalog

import centraid.core.v1.ActRequest
import centraid.core.v1.LoadRequest
import centraid.core.v1.NullValue
import centraid.core.v1.Value
import dev.centraid.shared.kit.InvokeKeys

/**
 * THE HAND-WRITTEN HALF OF THE GENERATED CATALOGUE (`ActionCatalog.kt`): how an
 * input becomes a core `Value`, and how an `ActRequest` gets its key.
 *
 * Nothing here names an app, an action or a query; those are the manifests',
 * and only the generated file spells them.
 */
internal fun text(value: String): Value = Value(text = value)

internal fun whole(value: Long): Value = Value(integer = value)

internal fun real(value: Double): Value = Value(real = value)

/** A boolean travels as 0 or 1; the core types it by the manifest's schema. */
internal fun flag(value: Boolean): Value = Value(integer = if (value) 1L else 0L)

/** One input map, filled by [fill]. */
internal inline fun act(app: String, action: String, fill: MutableMap<String, Value>.() -> Unit = {}): ActRequest =
    ActRequest(app = app, action = action, input = buildMap(fill))

internal inline fun load(
    app: String,
    query: String,
    limit: Int = 0,
    fill: MutableMap<String, Value>.() -> Unit = {},
): LoadRequest = LoadRequest(app = app, query = query, limit = limit, params = buildMap(fill))

/** A nullable property: [Field.Keep] adds nothing, [Field.Clear] adds `null`, [Field.Is] the value. */
internal inline fun <T> MutableMap<String, Value>.field(name: String, field: Field<T>, encode: (T) -> Value) {
    when (field) {
        Field.Keep -> Unit
        Field.Clear -> put(name, Value(null_ = NullValue()))
        is Field.Is -> put(name, encode(field.value))
    }
}

/**
 * The request, under the key that tells this tap from another and pairs its
 * answer to it: `app.action:subject:intent…` (the kit's [InvokeKeys], content-
 * derived — the same intent on the same subject is the same key). The core runs
 * one key once, so a gesture that may be repeated adds a counter to [intent].
 */
public fun ActRequest.keyed(subject: String, vararg intent: String): ActRequest =
    copy(invoke_key = InvokeKeys.of("$app.$action", subject, *intent))
