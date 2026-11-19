// Input for the backend protocol's keys, type, click, scroll and drag, injected
// with UiAutomation (shell may inject events), plus element actions.
package com.glovebox.server;

import android.accessibilityservice.AccessibilityService;
import android.app.UiAutomation;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ViewConfiguration;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

final class Input {
    private final UiAutomation automation;
    // The display events go to: 0 is the phone's screen, anything else a
    // hidden screen. Set before each request.
    int display;

    Input(UiAutomation automation) {
        this.automation = automation;
    }

    // ---- touch

    void tap(float x, float y, int count) {
        for (int i = 0; i < count; i++) {
            long down = SystemClock.uptimeMillis();
            touch(MotionEvent.ACTION_DOWN, down, down, x, y);
            touch(MotionEvent.ACTION_UP, down, down + 40, x, y);
            if (i + 1 < count) Device.sleep(70);
        }
    }

    void longPress(float x, float y, long ms) {
        long down = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, down, down, x, y);
        long hold = Math.max(ms, ViewConfiguration.getLongPressTimeout() + 200);
        // Report the finger as still there while held, as a real touch does.
        for (long t = 100; t < hold; t += 100) {
            Device.sleep(100);
            touch(MotionEvent.ACTION_MOVE, down, down + t, x, y);
        }
        touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x, y);
    }

    // A finger along `path` ([[x, y], ...]) over `ms`, ending with a short
    // rest so the content stops where the finger stops instead of flinging.
    void path(JSONArray path, long ms, boolean holdFirst) throws Exception {
        long down = SystemClock.uptimeMillis();
        float x0 = (float) path.getJSONArray(0).getDouble(0), y0 = (float) path.getJSONArray(0).getDouble(1);
        touch(MotionEvent.ACTION_DOWN, down, down, x0, y0);
        if (holdFirst) {
            // A drag of an icon or list row needs a long press to pick it up.
            for (long t = 100; t <= ViewConfiguration.getLongPressTimeout() + 200; t += 100) {
                Device.sleep(100);
                touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), x0, y0);
            }
        }
        int segments = path.length() - 1;
        int steps = Math.max(8, (int) (ms / 12));
        float lx = x0, ly = y0;
        for (int s = 0; s < segments; s++) {
            JSONArray a = path.getJSONArray(s), b = path.getJSONArray(s + 1);
            int per = Math.max(2, steps / Math.max(1, segments));
            for (int k = 1; k <= per; k++) {
                float f = (float) k / per;
                lx = (float) (a.getDouble(0) + (b.getDouble(0) - a.getDouble(0)) * f);
                ly = (float) (a.getDouble(1) + (b.getDouble(1) - a.getDouble(1)) * f);
                Device.sleep(Math.max(1, ms / Math.max(1, steps)));
                touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), lx, ly);
            }
        }
        for (int i = 0; i < 4; i++) {
            Device.sleep(30);
            touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), lx, ly);
        }
        touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), lx, ly);
    }

    // Several fingers at once: `paths` is one [[x, y], ...] per finger, all
    // with the same number of points, moved together over `ms`. The fingers
    // go down one after another and lift in reverse, as a hand does.
    void touches(JSONArray paths, long ms) throws Exception {
        int fingers = paths.length();
        if (fingers < 1 || fingers > 5) throw new Server.Coded("bad_request", "touches takes 1 to 5 finger paths");
        int points = paths.getJSONArray(0).length();
        for (int f = 1; f < fingers; f++) {
            if (paths.getJSONArray(f).length() != points) throw new Server.Coded("bad_request", "Every finger path needs the same number of points");
        }
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[fingers];
        for (int f = 0; f < fingers; f++) {
            props[f] = new MotionEvent.PointerProperties();
            props[f].id = f;
            props[f].toolType = MotionEvent.TOOL_TYPE_FINGER;
        }
        long down = SystemClock.uptimeMillis();
        // Interpolated steps between the given points, so movement is smooth.
        int steps = Math.max(points - 1, (int) (ms / 12));
        for (int f = 1; f <= fingers; f++) {
            int action = f == 1 ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_POINTER_DOWN | ((f - 1) << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
            multi(action, down, f, props, coordsAt(paths, f, 0));
        }
        for (int k = 1; k <= steps; k++) {
            Device.sleep(Math.max(1, ms / Math.max(1, steps)));
            multi(MotionEvent.ACTION_MOVE, down, fingers, props, coordsAt(paths, fingers, (double) k / steps));
        }
        for (int i = 0; i < 3; i++) {
            Device.sleep(30); // rest, so the gesture ends where it stops
            multi(MotionEvent.ACTION_MOVE, down, fingers, props, coordsAt(paths, fingers, 1));
        }
        for (int f = fingers; f >= 1; f--) {
            int action = f == 1 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_POINTER_UP | ((f - 1) << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
            multi(action, down, f, props, coordsAt(paths, f, 1));
        }
    }

    private static MotionEvent.PointerCoords[] coordsAt(JSONArray paths, int fingers, double t) throws Exception {
        MotionEvent.PointerCoords[] out = new MotionEvent.PointerCoords[fingers];
        for (int f = 0; f < fingers; f++) {
            JSONArray path = paths.getJSONArray(f);
            double pos = t * (path.length() - 1);
            int i = Math.min((int) Math.floor(pos), path.length() - 2 < 0 ? 0 : path.length() - 2);
            double frac = path.length() == 1 ? 0 : pos - i;
            JSONArray a = path.getJSONArray(i), b = path.getJSONArray(Math.min(i + 1, path.length() - 1));
            out[f] = new MotionEvent.PointerCoords();
            out[f].x = (float) (a.getDouble(0) + (b.getDouble(0) - a.getDouble(0)) * frac);
            out[f].y = (float) (a.getDouble(1) + (b.getDouble(1) - a.getDouble(1)) * frac);
            out[f].pressure = 1;
            out[f].size = 1;
        }
        return out;
    }

    private void multi(int action, long downTime, int count, MotionEvent.PointerProperties[] props, MotionEvent.PointerCoords[] coords) {
        MotionEvent.PointerProperties[] p = java.util.Arrays.copyOf(props, count);
        MotionEvent.PointerCoords[] c = java.util.Arrays.copyOf(coords, count);
        MotionEvent e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, count, p, c, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        inject(e);
        e.recycle();
    }

    private void touch(int action, long downTime, long eventTime, float x, float y) {
        MotionEvent e = MotionEvent.obtain(downTime, eventTime, action, x, y, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        inject(e);
        e.recycle();
    }

    // ---- keys

    private static final Map<String, Integer> KEYS = new HashMap<>();
    private static final Map<String, Integer> GLOBAL = new HashMap<>();

    static {
        KEYS.put("Return", KeyEvent.KEYCODE_ENTER);
        KEYS.put("KP_Enter", KeyEvent.KEYCODE_NUMPAD_ENTER);
        KEYS.put("Tab", KeyEvent.KEYCODE_TAB);
        KEYS.put("Escape", KeyEvent.KEYCODE_ESCAPE);
        KEYS.put("space", KeyEvent.KEYCODE_SPACE);
        KEYS.put("BackSpace", KeyEvent.KEYCODE_DEL);
        KEYS.put("Delete", KeyEvent.KEYCODE_FORWARD_DEL);
        KEYS.put("Insert", KeyEvent.KEYCODE_INSERT);
        KEYS.put("Home", KeyEvent.KEYCODE_MOVE_HOME);
        KEYS.put("End", KeyEvent.KEYCODE_MOVE_END);
        KEYS.put("Page_Up", KeyEvent.KEYCODE_PAGE_UP);
        KEYS.put("Page_Down", KeyEvent.KEYCODE_PAGE_DOWN);
        KEYS.put("Up", KeyEvent.KEYCODE_DPAD_UP);
        KEYS.put("Down", KeyEvent.KEYCODE_DPAD_DOWN);
        KEYS.put("Left", KeyEvent.KEYCODE_DPAD_LEFT);
        KEYS.put("Right", KeyEvent.KEYCODE_DPAD_RIGHT);
        KEYS.put("minus", KeyEvent.KEYCODE_MINUS);
        KEYS.put("plus", KeyEvent.KEYCODE_PLUS);
        KEYS.put("equal", KeyEvent.KEYCODE_EQUALS);
        KEYS.put("comma", KeyEvent.KEYCODE_COMMA);
        KEYS.put("period", KeyEvent.KEYCODE_PERIOD);
        KEYS.put("slash", KeyEvent.KEYCODE_SLASH);
        KEYS.put("backslash", KeyEvent.KEYCODE_BACKSLASH);
        KEYS.put("semicolon", KeyEvent.KEYCODE_SEMICOLON);
        KEYS.put("apostrophe", KeyEvent.KEYCODE_APOSTROPHE);
        KEYS.put("grave", KeyEvent.KEYCODE_GRAVE);
        KEYS.put("bracketleft", KeyEvent.KEYCODE_LEFT_BRACKET);
        KEYS.put("bracketright", KeyEvent.KEYCODE_RIGHT_BRACKET);
        KEYS.put("Caps_Lock", KeyEvent.KEYCODE_CAPS_LOCK);
        KEYS.put("VolumeUp", KeyEvent.KEYCODE_VOLUME_UP);
        KEYS.put("VolumeDown", KeyEvent.KEYCODE_VOLUME_DOWN);
        KEYS.put("Menu", KeyEvent.KEYCODE_MENU);
        for (int n = 1; n <= 12; n++) KEYS.put("F" + n, KeyEvent.KEYCODE_F1 + n - 1);
        GLOBAL.put("Back", AccessibilityService.GLOBAL_ACTION_BACK);
        GLOBAL.put("HomeScreen", AccessibilityService.GLOBAL_ACTION_HOME);
        GLOBAL.put("Recents", AccessibilityService.GLOBAL_ACTION_RECENTS);
        GLOBAL.put("Notifications", AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS);
        GLOBAL.put("QuickSettings", AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS);
    }

    void chord(String key, JSONArray mods) throws Exception {
        Integer global = GLOBAL.get(key);
        if (global != null && display != 0 && (mods == null || mods.length() == 0)) {
            // Global actions act on the phone's screen. Back is a key the
            // hidden screen's app can take; the rest belong to the user's screen.
            if (!"Back".equals(key)) {
                throw new Server.Coded("phone_screen_only", key + " acts on the phone's own screen, and this app is on glovebox's hidden screen."
                        + " Use Back inside the app, or getApp(name, {foreground: true}) to work on the phone's screen.");
            }
            long now = SystemClock.uptimeMillis();
            inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
            inject(new KeyEvent(now, now + 20, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
            return;
        }
        if (global != null && (mods == null || mods.length() == 0)) {
            if (!automation.performGlobalAction(global)) throw new Server.Coded("action_failed", key + " did not run");
            return;
        }
        int meta = 0;
        if (mods != null) {
            for (int i = 0; i < mods.length(); i++) {
                switch (mods.getString(i)) {
                    case "ctrl": meta |= KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON; break;
                    case "shift": meta |= KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON; break;
                    case "alt": meta |= KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON; break;
                    case "super": meta |= KeyEvent.META_META_ON | KeyEvent.META_META_LEFT_ON; break;
                    default: break;
                }
            }
        }
        Integer code = KEYS.get(key);
        if (code == null && key.length() == 1) {
            KeyEvent[] events = charMap().getEvents(new char[] {key.charAt(0)});
            if (events == null) throw new Server.Coded("bad_key", "No key code for \"" + key + "\"");
            long now = SystemClock.uptimeMillis();
            for (KeyEvent e : events) {
                inject(new KeyEvent(now, now, e.getAction(), e.getKeyCode(), 0, e.getMetaState() | meta,
                        KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
            }
            return;
        }
        if (code == null) throw new Server.Coded("bad_key", "No Android key for \"" + key + "\"");
        long now = SystemClock.uptimeMillis();
        inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
        inject(new KeyEvent(now, now + 20, KeyEvent.ACTION_UP, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
    }

    // Key events for text the virtual keyboard map can produce, or false.
    boolean typeKeys(String text) {
        KeyEvent[] events = charMap().getEvents(text.toCharArray());
        if (events == null) return false;
        for (KeyEvent e : events) inject(KeyEvent.changeTimeRepeat(e, SystemClock.uptimeMillis(), 0));
        return true;
    }

    private static KeyCharacterMap charMap() {
        return KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
    }

    private static java.lang.reflect.Method setDisplayId;

    private void inject(android.view.InputEvent e) {
        if (display != 0) {
            // A hidden screen's events must say so, or they land on the
            // user's screen. No way to set it means no input at all.
            try {
                if (setDisplayId == null) setDisplayId = android.view.InputEvent.class.getMethod("setDisplayId", int.class);
                setDisplayId.invoke(e, display);
            } catch (ReflectiveOperationException failed) {
                throw new Server.Coded("failed", "Could not address input to the hidden screen on this Android version");
            }
        }
        if (!automation.injectInputEvent(e, true)) throw new Server.Coded("failed", "The system rejected an injected input event");
    }

    // ---- element actions

    static void perform(AccessibilityNodeInfo n, String action) {
        int id;
        switch (action) {
            case "AXPress": id = AccessibilityNodeInfo.ACTION_CLICK; break;
            case "AXShowMenu": id = AccessibilityNodeInfo.ACTION_LONG_CLICK; break;
            case "AXScrollDownByPage": id = AccessibilityNodeInfo.ACTION_SCROLL_FORWARD; break;
            case "AXScrollUpByPage": id = AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD; break;
            case "AXExpand": id = AccessibilityNodeInfo.ACTION_EXPAND; break;
            case "AXCollapse": id = AccessibilityNodeInfo.ACTION_COLLAPSE; break;
            case "AXCancel": id = AccessibilityNodeInfo.ACTION_DISMISS; break;
            default:
                id = -1;
                for (AccessibilityAction a : n.getActionList()) {
                    if (a.getLabel() != null && a.getLabel().toString().equalsIgnoreCase(action)) {
                        id = a.getId();
                        break;
                    }
                }
                if (id < 0) throw new Server.Coded("action_failed", "The element has no action \"" + action + "\"");
        }
        if (!n.performAction(id)) throw new Server.Coded("action_failed", action + " failed on the element");
    }

    static void setText(AccessibilityNodeInfo n, String value) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            throw new Server.Coded("action_failed", "The element did not take the text (not editable?)");
        }
    }

    static void focus(AccessibilityNodeInfo n) {
        boolean ok = n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        if (!ok && n.isEditable()) ok = n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        if (!ok) throw new Server.Coded("action_failed", "The element would not take focus");
    }

    static void select(AccessibilityNodeInfo n, int start, int length) {
        Bundle args = new Bundle();
        args.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start);
        args.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, start + length);
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, args)) {
            throw new Server.Coded("action_failed", "The selection could not be set");
        }
    }

    static JSONObject ok(String route) throws Exception {
        return new JSONObject().put("route", route);
    }
}
