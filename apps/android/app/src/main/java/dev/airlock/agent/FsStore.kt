package dev.airlock.agent

import android.content.Context
import android.os.Build
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * Scoped file access. Without "all files" access the root is the app's shared
 * external folder (visible over USB/MTP). With MANAGE_EXTERNAL_STORAGE granted
 * the root becomes /storage/emulated/0 so the dashboard browses the real
 * downloads, DCIM and so on.
 */
class FsStore(private val context: Context) {

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
        val entries = (dir.listFiles() ?: emptyArray())
            .sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))
            .take(1000)
            .map { entry(it) }
        return JSONObject()
            .put("path", wirePath(dir))
            .put("entries", JSONArray(entries))
    }

    fun entry(file: File): JSONObject {
        val dir = file.isDirectory
        return JSONObject()
            .put("name", file.name)
            .put("path", wirePath(file))
            .put("dir", dir)
            .put("size", if (dir) 0L else file.length())
            .put("mtime", file.lastModified())
            .put("kind", if (dir) "folder" else kindOf(file.name))
            .put("mime", if (dir) "inode/directory" else Protocol.mimeFor(file.name))
    }

    fun open(wirePath: String?): InputStream = FileInputStream(resolve(wirePath))

    fun mkdir(parent: String?, name: String): JSONObject {
        val dir = File(resolve(parent), safeName(name))
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("could not create folder")
        return JSONObject().put("created", wirePath(dir))
    }

    fun rename(parent: String?, name: String, newName: String): JSONObject {
        val from = File(resolve(parent), safeName(name))
        val to = File(resolve(parent), safeName(newName))
        if (!from.exists()) throw IllegalArgumentException("no such file")
        if (to.exists()) throw IllegalArgumentException("a file with that name already exists")
        if (!from.renameTo(to)) throw IllegalStateException("rename failed")
        return JSONObject().put("path", wirePath(to))
    }

    fun delete(paths: List<String>): JSONObject {
        var count = 0
        for (p in paths) {
            val f = resolve(p)
            if (f == root) throw IllegalArgumentException("refusing to delete the root")
            if (f.deleteRecursively()) count++
        }
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
}
