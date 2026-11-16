package dev.airlock.agent

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private val Bg = Color(0xFF07090C)
private val Panel = Color(0xFF0D1319)
private val Border = Color(0xFF1C2733)
private val Accent = Color(0xFF5EEAD4)
private val TextMain = Color(0xFFE6EDF3)
private val TextDim = Color(0xFF8B9BB0)
private val Ok = Color(0xFF34D399)
private val Bad = Color(0xFFF87171)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            Box(Modifier.fillMaxSize().background(Bg)) {
                AgentScreen()
            }
        }
    }
}

@Composable
private fun AgentScreen() {
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    val scope = rememberCoroutineScope()
    val state by DeviceService.state.collectAsState()

    var tick by remember { mutableIntStateOf(0) }
    var relay by remember { mutableStateOf(prefs.relayUrl) }
    var roomCode by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) tick++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { tick++ }

    fun refresh() {
        tick++
    }

    val notifications = remember(tick) { notificationsEnabled(context) }
    val accessibility = remember(tick) { KeyAccessibilityService.isEnabled(context) }
    val listeners = remember(tick) { notificationAccessEnabled(context) }
    val camera = remember(tick) { granted(context, Manifest.permission.CAMERA) }
    val sms = remember(tick) { granted(context, Manifest.permission.READ_SMS) && granted(context, Manifest.permission.SEND_SMS) }
    val files = remember(tick) { allFilesAccess(context) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // ------------------------------------------------------------ header
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(42.dp).background(Accent.copy(alpha = 0.12f), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text("Λ", color = Accent, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Airlock", color = TextMain, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
                Text("device agent · no telemetry", color = TextDim, fontSize = 12.sp)
            }
        }

        // ------------------------------------------------------------ status
        PanelCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(8.dp).background(if (state.running) Ok else Bad, CircleShape)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    if (state.running) "Listening" else "Stopped",
                    color = TextMain,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.weight(1f))
                Text("${state.clients} client(s)", color = TextDim, fontSize = 12.sp)
            }
            Spacer(Modifier.height(12.dp))
            Text("LAN address", color = TextDim, fontSize = 11.sp)
            Text(
                state.lanUrl.ifEmpty { "start the agent to listen" },
                color = Accent,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
            )
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Pairing code", color = TextDim, fontSize = 11.sp)
                    Text(
                        state.code.ifEmpty { "------" },
                        color = TextMain,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 30.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 6.sp,
                    )
                }
                TextButton(onClick = {
                    DeviceService.instance?.rotateCode() ?: run { prefs.rotateCode(); refresh() }
                }) { Text("rotate", color = Accent) }
            }
            Spacer(Modifier.height(6.dp))
            Button(
                onClick = {
                    if (state.running) DeviceService.stop(context) else DeviceService.start(context)
                    refresh()
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (state.running) Border else Accent,
                    contentColor = if (state.running) TextMain else Bg,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (state.running) "Stop agent" else "Start agent")
            }
            (state.error ?: error)?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = Bad, fontSize = 12.sp)
            }
        }

        // ------------------------------------------------------------ mirror
        PanelCard {
            SectionTitle("Screen mirroring")
            Text(
                "Capture needs a one-time system approval per session. The dialog appears on this phone.",
                color = TextDim,
                fontSize = 12.sp,
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        if (!state.running) DeviceService.start(context)
                        context.startActivity(Intent(context, ProjectionActivity::class.java))
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Bg),
                ) { Text("Allow capture") }
                TextButton(onClick = { DeviceService.start(context); refresh() }) {
                    Text("Restart agent", color = TextDim)
                }
            }
            if (state.mirrored) {
                Spacer(Modifier.height(8.dp))
                Text("projection active", color = Ok, fontSize = 12.sp)
            }
        }

        // ------------------------------------------------------------ cloud
        PanelCard {
            SectionTitle("Cloud relay")
            Text(
                "Create a room, then enter the six digit code in the dashboard. The relay only forwards encrypted-in-transit frames; it never stores files.",
                color = TextDim,
                fontSize = 12.sp,
            )
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = relay,
                onValueChange = { relay = it },
                label = { Text("Relay URL") },
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = TextMain,
                    unfocusedTextColor = TextMain,
                    focusedBorderColor = Accent,
                    unfocusedBorderColor = Border,
                    focusedLabelColor = Accent,
                    unfocusedLabelColor = TextDim,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            try {
                                val info = withContext(Dispatchers.IO) { createRoom(relay, prefs.deviceName) }
                                prefs.relayUrl = relay
                                prefs.room = info.optString("room")
                                prefs.token = info.optString("token")
                                roomCode = info.optString("code")
                                DeviceService.start(context)
                            } catch (e: Exception) {
                                error = e.message ?: "could not create room"
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy,
                    colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Bg),
                ) { Text(if (busy) "Creating…" else "Create room") }
                TextButton(onClick = {
                    prefs.room = null
                    prefs.token = null
                    roomCode = null
                    DeviceService.stop(context)
                    refresh()
                }) { Text("Leave room", color = TextDim) }
            }
            val code = roomCode
            if (code != null) {
                Spacer(Modifier.height(10.dp))
                Text("Room code", color = TextDim, fontSize = 11.sp)
                Text(code, color = Accent, fontFamily = FontFamily.Monospace, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            } else if (state.cloudRoom != null) {
                Spacer(Modifier.height(10.dp))
                Text("connected to room ${state.cloudRoom}", color = Ok, fontSize = 12.sp)
            }
        }

        // ------------------------------------------------------------ permissions
        PanelCard {
            SectionTitle("Permissions")
            PermissionRow("Notifications", notifications) {
                if (Build.VERSION.SDK_INT >= 33) {
                    permissionLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                } else {
                    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                    })
                }
            }
            PermissionRow("Accessibility (touch + keys)", accessibility) {
                context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            PermissionRow("Notification access", listeners) {
                context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
            PermissionRow("Camera snapshots", camera) {
                permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA))
            }
            PermissionRow("SMS read + send", sms) {
                permissionLauncher.launch(
                    arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.READ_PHONE_STATE)
                )
            }
            PermissionRow("Browse all storage", files) {
                if (Build.VERSION.SDK_INT >= 30) {
                    context.startActivity(
                        Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                            .setData(Uri.parse("package:${context.packageName}"))
                    )
                }
            }
        }

        Text(
            "Sideloaded build: SMS and full-storage access use restricted permissions that Google Play does not grant. " +
                "Pairing codes are single use; sessions are capped at three controllers.",
            color = TextDim,
            fontSize = 11.sp,
            modifier = Modifier.padding(bottom = 18.dp),
        )
    }
}

@Composable
private fun PanelCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Panel),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), content = content)
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(title, color = TextMain, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
}

@Composable
private fun PermissionRow(label: String, granted: Boolean, action: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(if (granted) Ok else Border, CircleShape))
        Spacer(Modifier.width(10.dp))
        Text(label, color = TextMain, fontSize = 13.sp, modifier = Modifier.weight(1f))
        TextButton(onClick = action) {
            Text(if (granted) "granted" else "grant", color = if (granted) Ok else Accent, fontSize = 12.sp)
        }
    }
}

// ---------------------------------------------------------------- helpers
private fun granted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

private fun notificationsEnabled(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled()

private fun notificationAccessEnabled(context: Context): Boolean {
    val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
    return flat.split(':').any { ComponentName.unflattenFromString(it)?.packageName == context.packageName }
}

private fun allFilesAccess(context: Context): Boolean =
    if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else true

/** POST /api/pair on the relay. Runs on Dispatchers.IO. */
private fun createRoom(relay: String, name: String): JSONObject {
    val base = relay.trim().trimEnd('/')
    require(base.startsWith("http")) { "relay URL must start with http(s)://" }
    val connection = (URL("$base/api/pair").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 15_000
        readTimeout = 20_000
        doOutput = true
        setRequestProperty("content-type", "application/json")
    }
    try {
        connection.outputStream.use { out ->
            out.write(JSONObject().put("name", name).toString().toByteArray())
        }
        val body = connection.inputStream.bufferedReader().readText()
        return JSONObject(body)
    } finally {
        connection.disconnect()
    }
}
