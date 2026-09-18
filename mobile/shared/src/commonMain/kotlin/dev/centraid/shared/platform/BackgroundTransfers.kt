package dev.centraid.shared.platform

/**
 * THE BYTES THE OS MOVES WHILE THE APP IS NOT RUNNING (#1029 §3, W5B-2).
 *
 * `commonMain` cannot upload in the background and neither can Rust: on iOS the
 * only thing that keeps moving after the member leaves the app is an
 * `NSURLSession` background task the **system** owns, and on Android it is
 * `WorkManager`. So this is a seam, and what crosses it is what
 * `centraid_gateway_client` already produced — a path, a file and four signed
 * header values. Nothing here signs anything and nothing here decides what to
 * send.
 *
 * ## FILE-BASED, ALWAYS
 *
 * [Upload.spoolPath] is a file and never a `ByteArray`. iOS will not accept a
 * data-bodied upload task in a background session at all — it silently becomes
 * a foreground one — and a 16 MiB object held in memory to hand to a door whose
 * whole point is that it never holds one is the same mistake `MediaLibrary`
 * already refuses to make.
 *
 * It is signable because an object's name IS the BLAKE3 of its sealed bytes, so
 * the digest the signature covers is already in the path
 * (`centraid_gateway_client::signer::DeviceSigner::sign_object_put`). Nothing
 * reads the file to sign it.
 *
 * ## THE TWO PLATFORM TRUTHS A MEMBER HAS TO BE TOLD
 *
 * Both are copy on this interface rather than in a shell, because a sentence
 * spelled in each shell is a sentence one shell gets wrong:
 *
 * * **[FORCE_QUIT_SENTENCE]** — on iOS, swiping the app away out of the app
 *   switcher CANCELS every background upload in flight. The system terminating
 *   the app for memory does not. A member who force-quits and comes back to a
 *   stalled backup has not hit a bug, and telling them so is the difference
 *   between a product they trust and one they do not.
 * * **[ANDROID_UNMETERED_SENTENCE]** — Android's work constraints are the
 *   floor, and a member's own [dev.centraid.shared.sync.TransferRule] is judged
 *   per item on top of it.
 */
public interface BackgroundTransfers {

    /**
     * Hand the platform a batch and answer with what it accepted.
     *
     * **Never throws for a refusal.** "Background App Refresh is off" is a
     * sentence a member reads, the same shape [BackgroundTasks.register]
     * already uses, because a silent absence of passes is the failure mode this
     * whole seam was built to make visible.
     */
    public suspend fun enqueue(uploads: List<Upload>): Enqueued

    /**
     * What is already in flight, so a pass does not enqueue a second copy.
     *
     * A background session OUTLIVES the process: a phone that relaunched while
     * three uploads were in flight will be handed them again by the OS, and a
     * pass that enqueued them once more would spend a member's data twice.
     */
    public suspend fun inFlight(): List<String>

    /**
     * Stop everything. What a member's "stop backing up" switch calls, and what
     * a vault that has frozen on `VAULT_MOVED` calls for its own uploads.
     */
    public suspend fun cancelAll()

    /**
     * One object, ready for the OS to carry.
     *
     * Every field comes from the gateway client. A shell that assembled one
     * itself would be assembling a signature.
     */
    public data class Upload(
        /** The object's name, hex. Also its content digest. */
        public val objectName: String,
        /** The absolute URL to PUT to: this gateway's proxy, or a presigned one. */
        public val url: String,
        /** The sealed object on disk. **Never opened by this layer.** */
        public val spoolPath: String,
        /** The signed headers, in the order the client produced them. */
        public val headers: List<Pair<String, String>>,
        /**
         * When the target stops being usable, on the SERVER's clock.
         *
         * The platform half does not judge it — `Batch::usable_for` already
         * refused any target that could expire inside the longest deferral the
         * OS may impose — but it is carried so a completion handler can tell an
         * expiry apart from a refusal.
         */
        public val expiresAtMs: Long,
    )

    /** What the platform said about a batch. */
    public data class Enqueued(
        /** How many the platform took. */
        public val accepted: Int,
        /** The platform's verdict, in words a member can read. */
        public val sentence: String,
        /** Why it refused, when it did. Empty when it did not. */
        public val refusal: String = "",
    )

    public companion object {
        /**
         * **iOS: force-quitting cancels background uploads; the system
         * terminating the app does not.**
         *
         * `URLSession`'s own documentation is explicit that a user-initiated
         * termination from the app switcher cancels all outstanding tasks in a
         * background session, while a system termination leaves them to be
         * resumed. A member who force-quits nightly would otherwise find a
         * backup that never completes and no reason given.
         */
        public const val FORCE_QUIT_SENTENCE: String =
            "If you swipe Centraid away from the app switcher, uploads in progress stop. " +
                "Open Centraid again to carry on. Uploads keep going if iOS closes the app itself."

        /** Android's floor, before the member's own download rule is applied. */
        public const val ANDROID_UNMETERED_SENTENCE: String =
            "Centraid uploads in the background when this phone has a network. " +
                "Your Downloads setting still decides what crosses cellular."

        /** What a member reads while the OS has the batch. */
        public const val IN_FLIGHT_TITLE: String = "Uploading"
    }
}
