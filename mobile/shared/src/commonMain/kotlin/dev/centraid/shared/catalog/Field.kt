package dev.centraid.shared.catalog

/**
 * ONE OPTIONAL INPUT THE MANIFEST LETS BE `null` (an `edit`'s `due`, an
 * `organize`'s `project_id`): three different things a caller can mean.
 *
 * The core's rule is the manifest's: a key that is present is set (`null`
 * clears it), a key that is absent is left alone. A plain `T?` could say only
 * two of those three, which is how a "clear the due day" once became "leave it".
 */
public sealed interface Field<out T> {
    /** Send nothing: the field keeps what it has. */
    public data object Keep : Field<Nothing>

    /** Send `null`: the field is cleared. */
    public data object Clear : Field<Nothing>

    /** Send [value]: the field is set. */
    public data class Is<out T>(val value: T) : Field<T>
}
