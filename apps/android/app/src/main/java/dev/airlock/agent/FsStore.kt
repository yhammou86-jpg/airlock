package dev.airlock.agent

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.util.LruCache
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest
import kotlin.math.max

/**
 * Scoped file access. Without "all files" access the root is the app's shared
 * external folder (visible over USB/MTP). With MANAGE_EXTERNAL_STORAGE granted
 * the root becomes /storage/emulated/0 so the dashboard browses the real
 * downloads, DCIM and so on.
 *
 * Directory listings are cached for a few seconds and capped, because walking
 * DCIM with thousands of photos used to take long enough for the dashboard to
 * show a spinner. Thumbnails are rendered here and sent as small JPEGs, so the
 * browser never has to download a 5 MB original just to show a preview.
 */
class FsStore(private val context: Context) {

    private class Listing(
        val at: Long,
        val entries: JSONArray,
        val total: Int,
        val truncated: Boolean,
    )

    private val listings = HashMap<String, Listing>()

    private val previews = object : LruCache<String, ByteArray>(PREVIEW_CACHE_BYTES) {
        override fun sizeOf(key: String, value: ByteArray): Int = value.size
    }

    val allFiles: Boolean
        get() = Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()

    val root: File
        get() {
            val base = if (allFiles) {
                Environment.getExternalStorageDirectory()
            } else {
                context.getExternalFilesDir(null) ?: context.filesDir
            }
            if (!base.exists()) base.mkdirs()
            return base
        }

    /** Resolve a wire path ("/Documents/x.txt") inside the root, or throw. */
    fun resolve(wirePath: String?): File {
        val raw = (wirePath ?: "/").replace('\\', '/').trim()
        val relative = raw.trimStart('/').let { if (it.isEmpty() || it == ".") "" else it }
        val candidate = File(root, relative)
        val canonicalRoot = root.canonicalFile
        val canonical = candidate.canonicalFile
        if (canonical != canonicalRoot && !canonical.path.startsWith(canonicalRoot.path + File.separator)) {
            throw IllegalArgumentException("path escapes the shared folder")
        }
        return canonical
    }

    fun wirePath(file: File): String {
        val r = root.canonicalFile
        val f = file.canonicalFile
        if (f == r) return "/"
        return "/" + f.relativeTo(r).invariantSeparatorsPath
    }

    fun list(wirePath: String?): JSONObject {
        val dir = resolve(wirePath)
        if (!dir.isDirectory) throw IllegalArgumentException("not a directory")
        val key = dir.path
        val now = SystemClock.elapsedRealtime()
        val cached = synchronized(listings) {
            listings[key]?.takeIf { now - it.at < LIST_TTL_MS }
        }
        val listing = cached ?: build(dir).also { fresh ->
            synchronized(listings) {
                listings.entries.removeAll { now - it.value.at > LIST_TTL_MS * 4 }
                listings[key] = fresh
            }
        }
        return JSONObject()
            .put("path", wirePath(dir))
            .put("entries", listing.entries)
            .put("total", listing.total)
            .put("truncated", listing.truncated)
    }

    /** Drop cached listings after any mutation. Cheap: the TTL is only seconds. */
    fun invalidate() {
        synchronized(listings) { listings.clear() }
    }

    private fun build(dir: File): Listing {
        val found = dir.listFiles() ?: emptyArray()
        val folders = ArrayList<File>()
        val files = ArrayList<File>()
        for (entry in found) {
            if (entry.isDirectory) folders.add(entry) else files.add(entry)
        }
        folders.sortBy { it.name.lowercase() }
        files.sortBy { it.name.lowercase() }

        val total = found.size
        val entries = JSONArray()
        val base = wirePath(dir)
        var added = 0
        for (folder in folders) {
            if (added >= MAX_ENTRIES) break
            entries.put(entryOf(folder, join(base, folder.name), true))
            added++
        }
        for (file in files) {
            if (added >= MAX_ENTRIES) break
            entries.put(entryOf(file, join(base, file.name), false))
            added++
        }
        return Listing(
            at = SystemClock.elapsedRealtime(),
            entries = entries,
            total = total,
            truncated = total > added,
        )
    }

    private fun join(base: String, name: String): String = if (base == "/") "/$name" else "$base/$name"

    fun entry(file: File): JSONObject {
        val dir = file.isDirectory
        return entryOf(file, wirePath(file), dir)
    }

    private fun entryOf(file: File, path: String, isDir: Boolean): JSONObject = JSONObject()
        .put("name", file.name)
        .put("path", path)
        .put("dir", isDir)
        .put("size", if (isDir) 0L else file.length())
        .put("mtime", file.lastModified())
        .put("kind", if (isDir) "folder" else kindOf(file.name))
        .put("mime", if (isDir) "inode/directory" else Protocol.mimeFor(file.name))

    fun open(wirePath: String?): InputStream = FileInputStream(resolve(wirePath))

    /**
     * Downscaled, EXIF-rotated JPEG for the dashboard's preview modal. Capped at
     * [PREVIEW_MAX_EDGE] on the long edge so a preview is tens of KB instead of
     * the original photo. The result is memory-cached by path/size/mtime.
     */
    fun preview(wirePath: String?): ByteArray {
        val file = resolve(wirePath)
        if (!file.isFile) throw IllegalArgumentException("no such file")
        if (!Protocol.mimeFor(file.name).startsWith("image/")) {
            throw IllegalArgumentException("not an image")
        }

        val key = "${file.path}:${file.length()}:${file.lastModified()}"
        previews.get(key)?.let { return it }

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalStateException("could not read the image")
        }

        var sample = 1
        val longEdge = max(bounds.outWidth, bounds.outHeight)
        while (longEdge / sample > PREVIEW_MAX_EDGE * 2) sample *= 2

        val decoded = BitmapFactory.decodeFile(
            file.path,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: throw IllegalStateException("could not decode the image")

        val rotated = rotate(decoded, rotationOf(file))
        if (rotated !== decoded) decoded.recycle()

        val scaled = scaleToFit(rotated, PREVIEW_MAX_EDGE)
        if (scaled !== rotated) rotated.recycle()

        val out = ByteArrayOutputStream()
        try {
            scaled.compress(Bitmap.CompressFormat.JPEG, PREVIEW_QUALITY, out)
        } finally {
            scaled.recycle()
        }
        val bytes = out.toByteArray()
        previews.put(key, bytes)
        return bytes
    }

    private fun rotationOf(file: File): Int = try {
        ExifInterface(file.path).rotationDegrees
    } catch (_: Throwable) {
        0
    }

    private fun rotate(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees % 360 == 0) return bitmap
        val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun scaleToFit(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val longest = max(bitmap.width, bitmap.height)
        if (longest <= maxEdge) return bitmap
        val ratio = maxEdge.toFloat() / longest
        val width = (bitmap.width * ratio).toInt().coerceAtLeast(1)
        val height = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    fun mkdir(parent: String?, name: String): JSONObject {
        val dir = File(resolve(parent), safeName(name))
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("could not create folder")
        invalidate()
        return JSONObject().put("created", wirePath(dir))
    }

    fun rename(parent: String?, name: String, newName: String): JSONObject {
        val from = File(resolve(parent), safeName(name))
        val to = File(resolve(parent), safeName(newName))
        if (!from.exists()) throw IllegalArgumentException("no such file")
        if (to.exists()) throw IllegalArgumentException("a file with that name already exists")
        if (!from.renameTo(to)) throw IllegalStateException("rename failed")
        invalidate()
        return JSONObject().put("path", wirePath(to))
    }

    fun delete(paths: List<String>): JSONObject {
        var count = 0
        for (p in paths) {
            val f = resolve(p)
            if (f == root) throw IllegalArgumentException("refusing to delete the root")
            if (f.deleteRecursively()) count++
        }
        invalidate()
        return JSONObject().put("deleted", count)
    }

    fun safeName(name: String): String {
        val clean = name.replace('/', '_').replace('\\', '_').trim()
        if (clean.isEmpty() || clean == "." || clean == "..") throw IllegalArgumentException("invalid name")
        return clean
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(Protocol.CHUNK_BYTES)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun kindOf(name: String): String = when (Protocol.mimeFor(name).substringBefore('/')) {
        "image" -> "image"
        "video" -> "video"
        "audio" -> "audio"
        "text" -> "text"
        else -> when (name.substringAfterLast('.', "").lowercase()) {
            "zip", "rar", "7z", "tar", "gz" -> "archive"
            "apk", "xapk", "apks" -> "apk"
            else -> "file"
        }
    }

    companion object {
        private const val LIST_TTL_MS = 4_000L

        /** Enough for a phone folder without flooding the browser with JSON. */
        private const val MAX_ENTRIES = 400

        private const val PREVIEW_MAX_EDGE = 1080
        private const val PREVIEW_QUALITY = 78
        private const val PREVIEW_CACHE_BYTES = 12 * 1024 * 1024
    }
}
