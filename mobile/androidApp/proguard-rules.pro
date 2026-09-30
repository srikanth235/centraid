# R8 keep rules for the release build (`build.gradle.kts`, `buildTypes.release`).
#
# Only what a library cannot say for itself. Compose, AndroidX, CameraX, Media3,
# WorkManager and coroutines ship their own consumer rules.

# JNA. `libjnidispatch.so` calls back into these classes and fields by name, so
# none of them may be renamed or removed; `java.awt` is the desktop half JNA
# references and Android does not have.
-keep class com.sun.jna.** { *; }
-dontwarn java.awt.**

# THE ABI BINDING (`mobile/core`, `JnaCentraidAbi.kt`). JNA maps each method of
# a `Library` interface to the exported C symbol of the same NAME through a
# proxy, so a renamed method is a symbol lookup that fails on the first call.
-keep interface * extends com.sun.jna.Library { *; }
