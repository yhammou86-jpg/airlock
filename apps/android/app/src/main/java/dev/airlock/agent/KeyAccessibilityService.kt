package dev.airlock.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Gesture injection without root. This is the accessibility-service equivalent
 * of AirDroid's /dev/uinput and RemoteInputMethodService paths; no hidden APIs.
 */
class KeyAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun tap(x: Float, y: Float): Boolean = gesture(singlePoint(x, y), 0, 60)

    fun longPress(x: Float, y: Float, ms: Long): Boolean =
        gesture(singlePoint(x, y), 0, ms.coerceIn(120, 10_000))

    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        return gesture(path, 0, ms.coerceIn(60, 5_000))
    }

    fun global(action: Int): Boolean = performGlobalAction(action)

    /**
     * True when the platform will let this service grab frames silently. This
     * reflects the `canTakeScreenshot` flag in accessibility_service_config.xml;
     * some OEM builds ignore it, so callers still fall back to MediaProjection.
     */
    val supportsScreenshot: Boolean
        get() = if (Build.VERSION.SDK_INT >= 30) {
            val capabilities = serviceInfo?.capabilities ?: 0
            capabilities and AccessibilityServiceInfo.CAPABILITY_CAN_TAKE_SCREENSHOT != 0
        } else {
            false
        }

    /** Replace the focused field's contents (works with any IME). */
    fun type(text: String): Boolean {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    /** Backspace / enter on the focused field. */
    fun key(name: String): Boolean {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        return when (name) {
            "backspace" -> {
                val current = node.text?.toString().orEmpty()
                if (current.isEmpty()) return false
                val args = Bundle().apply {
                    putCharSequence(
                        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                        current.dropLast(1),
                    )
                }
                node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            }
            "enter" -> {
                // Most IMEs expose ACTION_IME_ENTER on the focused field
                // (an AccessibilityAction, not an int constant). API 30+.
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                } else {
                    false
                }
            }
            else -> false
        }
    }

    private fun singlePoint(x: Float, y: Float): Path = Path().apply { moveTo(x, y) }

    private fun gesture(path: Path, start: Long, duration: Long): Boolean {
        val stroke = GestureDescription.StrokeDescription(path, start, duration.coerceAtLeast(1))
        val description = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(description, null, null)
    }

    companion object {
        @Volatile
        var instance: KeyAccessibilityService? = null
            private set

        /** True when the user has enabled Airlock in Accessibility settings. */
        fun isEnabled(context: Context): Boolean {
            val expected = ComponentName(context, KeyAccessibilityService::class.java)
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
        }
    }
}
