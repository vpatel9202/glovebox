// The device side of every protocol method: apps, windows, the accessibility
// tree and screenshots, through a UiAutomation connection opened from shell.
//
// The system-context setup in systemContext() follows scrcpy's Workarounds
// (Copyright (C) 2018 Genymobile, Apache License 2.0; see NOTICE).
package com.glovebox.server;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Point;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import android.util.SparseArray;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

final class Device {
    // UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: keep the user's
    // own accessibility services (TalkBack and others) running while connected.
    private static final int DONT_SUPPRESS_ACCESSIBILITY_SERVICES = 1;
    private static final int DEFAULT_DISPLAY = 0;

    private final Context context;
    private final HandlerThread thread;
    private UiAutomation automation;
    private String connectError;
    final Tree tree = new Tree();
    // Hidden screens by app (package), made on first use.
    private final Map<String, Hidden> hidden = new HashMap<>();
    private HandlerThread frames;

    Device() {
        context = systemContext();
        thread = new HandlerThread("glovebox-uiautomation");
        thread.start();
        try {
            automation = connect(thread.getLooper());
        } catch (Throwable e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            connectError = cause.getClass().getSimpleName() + ": " + cause.getMessage();
        }
    }

    void close() {
        try {
            if (awake != null && awake.isHeld()) awake.release();
        } catch (Throwable ignored) {
            // Exiting anyway; the lock goes with the process.
        }
        synchronized (hidden) {
            for (Hidden h : hidden.values()) {
                try {
                    h.release();
                } catch (Throwable ignored) {
                    // Exiting anyway; the display goes with the process.
                }
            }
            hidden.clear();
        }
        if (automation == null) return;
        try {
            Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
            disconnect.setAccessible(true);
            disconnect.invoke(automation);
        } catch (Throwable ignored) {
            // Exiting anyway.
        }
    }

    Object call(String method, JSONObject p) throws Exception {
        switch (method) {
            case "hello":
            case "ping":
                return hello();
            case "permissions":
                return new JSONObject()
                        .put("accessibility", automation != null)
                        .put("screenRecording", automation != null)
                        .put("inputMonitoring", false)
                        .put("escapeWatcher", false)
                        .putOpt("error", connectError);
            case "listApps":
                return listApps();
            case "resolveApp":
                return resolveApp(p.getString("query"));
            case "isActive": {
                int d = displayFor(p, false);
                if (d > DEFAULT_DISPLAY) return new JSONObject().put("active", onHidden(p.getString("pid"), d));
                return new JSONObject().put("active", d >= 0 && p.optString("pid").equals(topPackage(d)));
            }
            case "activate":
                return activate(p.getString("pid"), displayFor(p, true));
            case "windows":
                return windows(p.getString("pid"), displayOrThrow(p));
            case "axTree":
                return axTree(p, displayOrThrow(p));
            case "elementFrame":
                return new JSONObject().put("frame", Tree.frame(tree.node(p.getInt("index"))));
            case "actionNames":
                return new JSONObject().put("actions", Tree.actions(tree.node(p.getInt("index"))));
            case "hitTest":
                return hitTest(p.getString("pid"), displayOrThrow(p), p.getDouble("x"), p.getDouble("y"));
            case "screenshot":
                return screenshot(p, displayOrThrow(p));
            case "keys":
            case "type":
            case "click":
            case "scroll":
            case "drag":
            case "longPress":
                return input(method, p);
            case "performAction":
                Input.perform(tree.node(p.getInt("index")), p.getString("action"));
                return new JSONObject();
            case "setValue":
                Input.setText(tree.node(p.getInt("index")), p.optString("value"));
                return new JSONObject();
            case "focusElement":
                Input.focus(tree.node(p.getInt("index")));
                return new JSONObject();
            case "selectText": {
                AccessibilityNodeInfo n = tree.node(p.getInt("index"));
                CharSequence text = n.getText();
                int length = text == null ? 0 : text.length();
                int start = p.has("start") ? p.getInt("start") : 0;
                Input.select(n, start, p.has("length") ? p.getInt("length") : length - start);
                return new JSONObject();
            }
            case "inspect":
                return inspect(p);
            case "cursor":
                return new JSONObject().put("enabled", false);
            case "forget":
                tree.clear();
                return new JSONObject();
            // Test-only (Phase 1 Gate A check): a private virtual display and a read of it.
            case "_createDisplay":
                return createDisplay(p);
            case "_displayTree":
                return displayTree(p);
            case "_removeRecents":
                return removeRecents(p.getString("pkg"));
            default:
                throw new Server.Coded("bad_request", "Unknown method " + method + " (not in this server version)");
        }
    }

    private JSONObject hello() throws Exception {
        Point size = displaySize(DEFAULT_DISPLAY);
        return new JSONObject()
                .put("version", Server.VERSION)
                .put("platform", "android")
                .put("sdk", Build.VERSION.SDK_INT)
                .put("release", Build.VERSION.RELEASE)
                .put("model", Build.MODEL)
                .put("manufacturer", Build.MANUFACTURER)
                .put("pid", android.os.Process.myPid())
                .put("display", new JSONArray().put(size.x).put(size.y))
                .put("accessibility", automation != null)
                .putOpt("error", connectError)
                .put("hiddenScreen", Build.VERSION.SDK_INT >= Hidden.MIN_SDK)
                .put("background", new JSONObject());
    }

    // ---- screens

    // The display a request targets: 0 (the phone's screen) unless it asks
    // for the app's hidden screen. -1 if that screen does not exist yet and
    // `create` is false.
    private int displayFor(JSONObject p, boolean create) throws Exception {
        if (!"hidden".equals(p.optString("screen"))) return DEFAULT_DISPLAY;
        if (Build.VERSION.SDK_INT < Hidden.MIN_SDK) {
            throw new Server.Coded("hidden_unavailable", "The hidden screen needs Android 14 (API 34) or later");
        }
        keepAwake();
        String pkg = p.getString("pid");
        synchronized (hidden) {
            Hidden h = hidden.get(pkg);
            if (h != null) return h.id;
            if (!create) return -1;
            if (frames == null) {
                frames = new HandlerThread("glovebox-frames");
                frames.start();
            }
            Point size = displaySize(DEFAULT_DISPLAY);
            int dpi = context.getResources().getDisplayMetrics().densityDpi;
            h = new Hidden(context, pkg, size.x, size.y, dpi, new android.os.Handler(frames.getLooper()));
            hidden.put(pkg, h);
            return h.id;
        }
    }

    private int displayOrThrow(JSONObject p) throws Exception {
        int d = displayFor(p, false);
        if (d < 0) {
            throw new Server.Coded("not_visible", p.optString("pid") + " is not open on its hidden screen yet. Call app.activate() first.");
        }
        return d;
    }

    // While the phone sleeps nothing on a hidden screen runs: launches wait
    // and reads hang. So hidden-screen work wakes the phone (screen dimmed)
    // and keeps it awake until a minute after the last request.
    private android.os.PowerManager.WakeLock awake;

    @SuppressWarnings("deprecation")
    private void keepAwake() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (awake == null) {
                awake = pm.newWakeLock(android.os.PowerManager.SCREEN_DIM_WAKE_LOCK | android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP, "glovebox:hidden-screen");
                awake.setReferenceCounted(false);
            }
            boolean wasAsleep = !pm.isInteractive();
            awake.acquire(60_000);
            for (int i = 0; wasAsleep && i < 20 && !pm.isInteractive(); i++) sleep(100);
            if (wasAsleep) sleep(300); // let the displays resume
        } catch (Throwable e) {
            // No wake lock: the request runs and may stall if the phone sleeps.
        }
    }

    private Hidden hiddenById(int d) {
        synchronized (hidden) {
            for (Hidden h : hidden.values()) if (h.id == d) return h;
        }
        return null;
    }

    // ---- apps

    private List<ResolveInfo> launchables() {
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        return context.getPackageManager().queryIntentActivities(main, 0);
    }

    private JSONObject appInfo(String pkg, String label, String top) throws Exception {
        return new JSONObject()
                .put("name", label)
                .put("bundleId", pkg)
                .put("pid", pkg)
                .put("running", true)
                .put("active", pkg.equals(top));
    }

    private JSONArray listApps() throws Exception {
        PackageManager pm = context.getPackageManager();
        String top = topPackage(DEFAULT_DISPLAY);
        Map<String, String> seen = new HashMap<>();
        for (ResolveInfo r : launchables()) {
            String pkg = r.activityInfo.packageName;
            if (!seen.containsKey(pkg)) seen.put(pkg, String.valueOf(r.loadLabel(pm)));
        }
        List<String> pkgs = new ArrayList<>(seen.keySet());
        Collections.sort(pkgs, (a, b) -> seen.get(a).compareToIgnoreCase(seen.get(b)));
        JSONArray out = new JSONArray();
        for (String pkg : pkgs) out.put(appInfo(pkg, seen.get(pkg), top));
        return out;
    }

    // A query names an app by label ("Clock"), package ("com.example"), or
    // "pid:<package>". Every installed app is a valid handle: on Android the
    // handle is the package, whether or not it is running.
    private JSONObject resolveApp(String query) throws Exception {
        String q = query.startsWith("pid:") ? query.substring(4) : query;
        PackageManager pm = context.getPackageManager();
        String top = topPackage(DEFAULT_DISPLAY);
        String lower = q.toLowerCase(Locale.ROOT);
        ResolveInfo partial = null;
        for (ResolveInfo r : launchables()) {
            String pkg = r.activityInfo.packageName;
            String label = String.valueOf(r.loadLabel(pm));
            if (pkg.equals(q) || label.equalsIgnoreCase(q)) return appInfo(pkg, label, top);
            if (partial == null && label.toLowerCase(Locale.ROOT).contains(lower)) partial = r;
        }
        if (partial != null) return appInfo(partial.activityInfo.packageName, String.valueOf(partial.loadLabel(pm)), top);
        throw new Server.Coded("not_found", "No installed app matches \"" + query + "\"");
    }

    private JSONObject activate(String pkg, int d) throws Exception {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null || launch.getComponent() == null) throw new Server.Coded("not_found", pkg + " has no launcher activity");
        String component = launch.getComponent().flattenToShortString();
        if (d != DEFAULT_DISPLAY) {
            // Already open there: nothing to do (a second launch would add a task).
            if (onHidden(pkg, d)) return screenInfo(d);
            // If the user has the app running, a second copy can take theirs:
            // single-copy apps move their task over, and others (Chrome) close
            // the older one. So a hidden screen opens only apps the user is
            // not running; the phone's own screen is the other choice.
            Map<Integer, Integer> mine = userTasks(pkg);
            if (mine == null || !mine.isEmpty()) {
                throw new Server.Coded("open_on_phone", pkg + " is running on the phone, and opening a second copy on glovebox's hidden screen"
                        + " could close or take over the user's. Ask the user to close it (swipe it away in recent apps), or use"
                        + " getApp(name, {foreground: true}) to work on the phone's screen.");
            }
            Hidden h = hiddenById(d);
            if (h != null) h.onPhoneAtStart = onPhone(pkg);
        }
        if (d == DEFAULT_DISPLAY) unlockScreen();
        // -W waits for the launch to finish, which a cold start needs. Not on a
        // hidden screen: while the phone sleeps -W never returns, though the
        // launch itself goes ahead; the window wait below covers it.
        List<String> cmd = new ArrayList<>(java.util.Arrays.asList("am", "start", "--display", String.valueOf(d)));
        if (d == DEFAULT_DISPLAY) cmd.add(2, "-W");
        // On a hidden screen, a task of its own (NEW_TASK | MULTIPLE_TASK), so
        // a copy the user has open on the phone's screen stays there, kept out
        // of the user's recent apps (EXCLUDE_FROM_RECENTS), even if the server
        // dies before it can clean up.
        if (d != DEFAULT_DISPLAY) cmd.addAll(java.util.Arrays.asList("-f", "0x18800000"));
        cmd.addAll(java.util.Arrays.asList("-n", component));
        Process proc = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        proc.getInputStream().readAllBytes();
        proc.waitFor();
        // The task is on top before its window reaches the accessibility
        // window list; wait for both, so the next read finds the app.
        // A cold start on a fresh hidden screen can take many seconds on a
        // slow device; bound the wait by time, not by tries.
        long deadline = android.os.SystemClock.uptimeMillis() + (d == DEFAULT_DISPLAY ? 5_000 : 25_000);
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            if (pkg.equals(topPackage(d)) || d != DEFAULT_DISPLAY) {
                try {
                    List<AccessibilityWindowInfo> shown = appWindows(pkg, d);
                    if (!shown.isEmpty()) {
                        settleBounds(pkg, d);
                        return screenInfo(d);
                    }
                } catch (Server.Coded notYet) {
                    // not_visible until the window shows up
                }
            }
            Thread.sleep(100);
        }
        throw new Server.Coded("activate_failed", pkg + " did not come to the front");
    }

    // The phone's screen behind a lock screen shows nothing launched there.
    // A swipe-only lock screen guards nothing, so it is dismissed, as a
    // person would swipe it away; a real lock stops with an error.
    private void unlockScreen() throws Exception {
        android.app.KeyguardManager km = (android.app.KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isKeyguardLocked()) return;
        if (km.isDeviceLocked()) {
            throw new Server.Coded("locked", "The phone is locked. Ask the user to unlock it to work on the phone's screen"
                    + " (the hidden screen works while it is locked).");
        }
        keepAwake();
        Process proc = new ProcessBuilder("wm", "dismiss-keyguard").redirectErrorStream(true).start();
        proc.getInputStream().readAllBytes();
        proc.waitFor();
        for (int i = 0; i < 20 && km.isKeyguardLocked(); i++) sleep(100);
    }

    // The open animation scales the window up from its icon (long on
    // Samsung); bounds read during it are wrong. Wait until they hold still.
    private void settleBounds(String pkg, int d) {
        Rect last = null;
        long deadline = android.os.SystemClock.uptimeMillis() + 3_000;
        int still = 0;
        while (still < 3 && android.os.SystemClock.uptimeMillis() < deadline) {
            List<AccessibilityWindowInfo> shown;
            try {
                shown = appWindows(pkg, d);
            } catch (Server.Coded gone) {
                return;
            }
            Rect now = new Rect();
            shown.get(shown.size() - 1).getBoundsInScreen(now);
            still = now.equals(last) ? still + 1 : 0;
            last = now;
            sleep(100);
        }
    }

    // `pkg`'s running tasks outside glovebox's hidden screens, as task id to
    // display id: the user's copies.
    private Map<Integer, Integer> userTasks(String pkg) {
        java.util.Set<Integer> ours = new java.util.HashSet<>();
        synchronized (hidden) {
            for (Hidden h : hidden.values()) ours.add(h.id);
        }
        Map<Integer, Integer> all = tasksOf(pkg);
        if (all == null) return null;
        Map<Integer, Integer> out = new HashMap<>();
        for (Map.Entry<Integer, Integer> e : all.entrySet()) {
            if (!ours.contains(e.getValue())) out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    // Every running task of `pkg`, task id to display id, including tasks
    // kept out of recent apps (Chrome's first-run screen is one). Null if
    // unknown.
    @SuppressWarnings("deprecation")
    private Map<Integer, Integer> tasksOf(String pkg) {
        Map<Integer, Integer> out = new HashMap<>();
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            for (android.app.ActivityManager.RunningTaskInfo info : am.getRunningTasks(200)) {
                if (!taskOf(info, pkg)) continue;
                out.put(info.getClass().getField("taskId").getInt(info), info.getClass().getField("displayId").getInt(info));
            }
            return out;
        } catch (Throwable e) {
            return null;
        }
    }

    private static boolean taskOf(android.app.TaskInfo info, String pkg) {
        return (info.baseActivity != null && pkg.equals(info.baseActivity.getPackageName()))
                || (info.baseIntent != null && info.baseIntent.getComponent() != null && pkg.equals(info.baseIntent.getComponent().getPackageName()));
    }

    private boolean onHidden(String pkg, int d) {
        for (AccessibilityWindowInfo w : displayWindows(d)) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) return true;
        }
        return false;
    }

    private boolean onPhone(String pkg) {
        for (AccessibilityWindowInfo w : displayWindows(DEFAULT_DISPLAY)) {
            if (pkg.equals(windowPackage(w))) return true;
        }
        return false;
    }

    private JSONObject screenInfo(int d) throws Exception {
        if (d == DEFAULT_DISPLAY) return new JSONObject().put("screen", "phone");
        Hidden h = hiddenById(d);
        return new JSONObject().put("screen", "hidden").put("displayId", d).put("imeHidden", h != null && h.imeHidden);
    }

    // ---- windows

    private List<AccessibilityWindowInfo> displayWindows(int displayId) {
        requireAutomation();
        // Right after connecting, the window list can be empty for a moment.
        for (int attempt = 0; attempt < 20; attempt++) {
            List<AccessibilityWindowInfo> list = null;
            if (Build.VERSION.SDK_INT >= 30) {
                SparseArray<List<AccessibilityWindowInfo>> all = automation.getWindowsOnAllDisplays();
                list = all.get(displayId);
            } else if (displayId == DEFAULT_DISPLAY) {
                list = automation.getWindows();
            }
            if (list != null && !list.isEmpty()) {
                List<AccessibilityWindowInfo> sorted = new ArrayList<>(list);
                Collections.sort(sorted, (a, b) -> Integer.compare(b.getLayer(), a.getLayer())); // top first
                return sorted;
            }
            sleep(100);
        }
        return Collections.emptyList();
    }

    private static String windowPackage(AccessibilityWindowInfo w) {
        AccessibilityNodeInfo root = w.getRoot();
        return root == null || root.getPackageName() == null ? null : root.getPackageName().toString();
    }

    // The app in front: the package that started the top task (its base
    // activity), so an app's screens that belong to another package (Settings'
    // search, a share sheet, a sign-in flow) still count as that app.
    private String topPackage(int d) {
        if (d == DEFAULT_DISPLAY) {
            String base = topTaskBase();
            if (base != null) return base;
        }
        return topWindowPackage(d);
    }

    private String topWindowPackage(int d) {
        if (automation == null) return null;
        for (AccessibilityWindowInfo w : displayWindows(d)) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
                String pkg = windowPackage(w);
                if (pkg != null) return pkg;
            }
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private String topTaskBase() {
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            List<android.app.ActivityManager.RunningTaskInfo> tasks = am.getRunningTasks(1);
            if (tasks == null || tasks.isEmpty() || tasks.get(0).baseActivity == null) return null;
            return tasks.get(0).baseActivity.getPackageName();
        } catch (Throwable e) {
            return null; // fall back to the top window's package
        }
    }

    // The windows a read of `pkg` shows: its top application window and every
    // window above it (dialogs, sheets, the keyboard, system prompts), minus the
    // status and navigation bars. Top first. When `pkg`'s task is in front, its
    // top window counts even if another package drew it.
    // On a hidden screen everything is the app's own task, whatever package
    // drew it; if the app is gone from it and showing on the phone's screen
    // instead, that is an error, never a quiet switch to the user's screen.
    List<AccessibilityWindowInfo> appWindows(String pkg, int d) {
        List<AccessibilityWindowInfo> all = displayWindows(d);
        boolean taskInFront = d != DEFAULT_DISPLAY || pkg.equals(topTaskBase());
        int appIndex = -1;
        for (int i = 0; i < all.size(); i++) {
            AccessibilityWindowInfo w = all.get(i);
            if (w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            if (taskInFront || pkg.equals(windowPackage(w))) {
                appIndex = i;
                break;
            }
        }
        if (appIndex < 0 && d != DEFAULT_DISPLAY) {
            Hidden h = hiddenById(d);
            // Moved: on the phone's screen now, and not already there when
            // glovebox opened it (the user's own copy does not count).
            if (h != null && !h.onPhoneAtStart && onPhone(pkg)) {
                throw new Server.Coded("moved_to_phone_screen", pkg + " is showing on the phone's own screen, not on glovebox's hidden screen"
                        + " (it may have opened a sign-in or system screen there). glovebox stopped rather than follow it; check the phone,"
                        + " then call app.activate() to start again on the hidden screen.");
            }
            throw new Server.Coded("not_visible", pkg + " has closed on its hidden screen. Call app.activate() to open it again.");
        }
        if (appIndex < 0) {
            throw new Server.Coded("not_visible", pkg + " is not on the screen. Bring it forward with app.activate(), then read again.");
        }
        Point size = displaySize(d);
        List<AccessibilityWindowInfo> shown = new ArrayList<>();
        for (int i = 0; i <= appIndex; i++) {
            AccessibilityWindowInfo w = all.get(i);
            if (i < appIndex && isBar(w, size)) continue;
            shown.add(w);
        }
        return shown;
    }

    private static boolean isBar(AccessibilityWindowInfo w, Point size) {
        if (w.getType() != AccessibilityWindowInfo.TYPE_SYSTEM) return false;
        Rect b = new Rect();
        w.getBoundsInScreen(b);
        boolean thin = b.height() < size.y * 0.12 || b.width() < size.x * 0.12;
        boolean edge = b.top <= 0 || b.bottom >= size.y || b.left <= 0 || b.right >= size.x;
        return thin && edge;
    }

    private JSONArray windows(String pkg, int d) throws Exception {
        List<AccessibilityWindowInfo> shown = appWindows(pkg, d);
        AccessibilityWindowInfo app = shown.get(shown.size() - 1);
        Point size = displaySize(d);
        CharSequence title = app.getTitle();
        JSONObject w = new JSONObject()
                .put("index", 0)
                .put("windowId", d)
                .put("title", title == null ? pkg : title.toString())
                .put("frame", new JSONArray().put(0).put(0).put(size.x).put(size.y))
                .put("scale", 1)
                .put("focused", app.isFocused() || shown.size() > 1)
                .put("main", true)
                .put("minimized", false);
        return new JSONArray().put(w);
    }

    private JSONObject axTree(JSONObject p, int d) throws Exception {
        String pkg = p.getString("pid");
        List<AccessibilityWindowInfo> shown = appWindows(pkg, d);
        AccessibilityWindowInfo app = shown.get(shown.size() - 1);
        CharSequence title = app.getTitle();
        Tree.Walk walk = tree.walk(shown, p.optInt("maxNodes", 800), p.optInt("maxDepth", 40), p.optInt("maxText", 200), p.optBoolean("keyboard", false));
        return new JSONObject()
                .put("window", new JSONObject().put("windowId", d).put("title", title == null ? pkg : title.toString()))
                .put("nodes", walk.nodes)
                .put("truncated", walk.truncated);
    }

    private JSONObject hitTest(String pkg, int d, double x, double y) throws Exception {
        AccessibilityNodeInfo hit = null;
        for (AccessibilityWindowInfo w : appWindows(pkg, d)) {
            AccessibilityNodeInfo root = w.getRoot();
            if (root == null) continue;
            Rect b = new Rect();
            root.getBoundsInScreen(b);
            if (!b.contains((int) x, (int) y)) continue;
            hit = Tree.deepest(root, (int) x, (int) y);
            if (hit != null) break;
        }
        if (hit == null) return new JSONObject();
        return new JSONObject()
                .put("index", tree.indexOf(hit))
                .put("role", Tree.role(hit))
                .put("actions", Tree.actions(hit))
                .put("frame", Tree.frame(hit));
    }

    // ---- approval support: what an action would act on

    // The package of the window an action lands in (the element's window, the
    // window under the point, or the focused window for keys), and whether
    // the phone is locked.
    private JSONObject inspect(JSONObject p) throws Exception {
        String pkg = null;
        int d = p.optBoolean("lockOnly") ? -1 : displayFor(p, false);
        // Throws moved_to_phone_screen; an activate is what brings the app back.
        if (d >= 0 && d != DEFAULT_DISPLAY && !"activate".equals(p.optString("for"))) appWindows(p.getString("pid"), d);
        if (p.has("index")) {
            try {
                CharSequence c = tree.node(p.getInt("index")).getPackageName();
                pkg = c == null ? null : c.toString();
            } catch (Server.Coded ignored) {
                // A stale index fails later, in the action itself.
            }
        } else if (p.has("x") && automation != null && d >= 0) {
            int x = (int) p.getDouble("x"), y = (int) p.getDouble("y");
            for (AccessibilityWindowInfo w : displayWindows(d)) {
                Rect b = new Rect();
                w.getBoundsInScreen(b);
                if (b.contains(x, y)) {
                    pkg = windowPackage(w);
                    break;
                }
            }
        } else if (automation != null && d >= 0) {
            AccessibilityNodeInfo focus = inputFocus(d);
            if (focus != null && focus.getPackageName() != null) pkg = focus.getPackageName().toString();
            if (pkg == null) pkg = topWindowPackage(d);
        }
        boolean locked = false;
        try {
            android.app.KeyguardManager km = (android.app.KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
            // Locked by a PIN, pattern, password or biometric; a swipe-only
            // lock screen guards nothing, so it does not ask.
            locked = km != null && km.isDeviceLocked();
        } catch (Throwable ignored) {
            // Unknown counts as unlocked; the action shows the lock screen if not.
        }
        JSONObject out = new JSONObject().put("locked", locked);
        if (pkg != null) out.put("windowPackage", pkg).putOpt("windowLabel", label(pkg));
        return out;
    }

    private String label(String pkg) {
        try {
            PackageManager pm = context.getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Throwable e) {
            return null;
        }
    }

    // ---- input (display 0; the virtual-display route comes in Phase 3)

    private Input input;

    private JSONObject input(String method, JSONObject p) throws Exception {
        requireAutomation();
        if ("background".equals(p.optString("mode"))) {
            throw new Server.Coded("background_unavailable", "Android input goes to the app's screen (hidden or the phone's)");
        }
        int d = displayOrThrow(p);
        if (input == null) input = new Input(automation);
        input.display = d;
        switch (method) {
            case "keys": {
                JSONArray chords = p.getJSONArray("chords");
                for (int i = 0; i < chords.length(); i++) {
                    JSONObject c = chords.getJSONObject(i);
                    input.chord(c.getString("key"), c.optJSONArray("mods"));
                }
                return Input.ok("keys");
            }
            case "type":
                return type(p.getString("text"), d);
            case "click": {
                float x = (float) p.getDouble("x"), y = (float) p.getDouble("y");
                if ("right".equals(p.optString("button"))) input.longPress(x, y, 0);
                else input.tap(x, y, Math.max(1, p.optInt("count", 1)));
                return Input.ok("touch");
            }
            case "longPress":
                input.longPress((float) p.getDouble("x"), (float) p.getDouble("y"), p.optLong("ms", 0));
                return Input.ok("touch");
            case "scroll": {
                // dy/dx are lines (positive dy: content moves up, as a wheel
                // scrolls down). One line is 48 dp of finger travel.
                Point size = displaySize(d);
                float line = 48f * context.getResources().getDisplayMetrics().density;
                float x = (float) p.getDouble("x"), y = (float) p.getDouble("y");
                float tx = clamp(x - (float) p.optDouble("dx", 0) * line, 1, size.x - 2);
                float ty = clamp(y - (float) p.optDouble("dy", 0) * line, 1, size.y - 2);
                JSONArray path = new JSONArray().put(new JSONArray().put(x).put(y)).put(new JSONArray().put(tx).put(ty));
                input.path(path, 350, false);
                return Input.ok("touch");
            }
            case "drag":
                input.path(p.getJSONArray("path"), p.optLong("ms", 400), p.optBoolean("hold", false));
                return Input.ok("touch");
            default:
                throw new Server.Coded("bad_request", "Unknown input method " + method);
        }
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    // Text into the focused field. First the field's own set-text action
    // (no keyboard, any characters), spliced at the selection and read back;
    // if the field is not editable or does not keep it, key events.
    // The focused input field on display `d`, found from that display's own
    // windows: the global input focus may be a field on the user's screen.
    private AccessibilityNodeInfo inputFocus(int d) {
        for (AccessibilityWindowInfo w : displayWindows(d)) {
            AccessibilityNodeInfo root = w.getRoot();
            if (root == null) continue;
            AccessibilityNodeInfo focus = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focus != null) return focus;
        }
        return null;
    }

    private JSONObject type(String text, int d) throws Exception {
        AccessibilityNodeInfo field = inputFocus(d);
        if (field != null && field.isEditable()) {
            boolean hint = Build.VERSION.SDK_INT >= 26 && field.isShowingHintText();
            String before = field.getText() == null || hint ? "" : field.getText().toString();
            int start = field.getTextSelectionStart(), end = field.getTextSelectionEnd();
            if (start < 0 || start > before.length()) start = end = before.length();
            if (end < start || end > before.length()) end = start;
            String expected = before.substring(0, start) + text + before.substring(end);
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, expected);
            if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                Bundle sel = new Bundle();
                sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start + text.length());
                sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, start + text.length());
                field.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
                sleep(60);
                field.refresh();
                String now = field.getText() == null ? "" : field.getText().toString();
                if (now.equals(expected)) return Input.ok("set-text");
                if (now.equals(before)) {
                    // The field ignored it: fall through to key events.
                } else {
                    // It took the text and reformatted it (a phone number, a mask).
                    return Input.ok("set-text").put("value", now);
                }
            }
        }
        if (input.typeKeys(text)) return Input.ok("keys");
        throw new Server.Coded("bad_key", "This text has characters with no key on the virtual keyboard, and no focused field took it directly");
    }

    // ---- screenshots

    private JSONObject screenshot(JSONObject p, int d) throws Exception {
        requireAutomation();
        Bitmap full;
        if (d == DEFAULT_DISPLAY) {
            full = automation.takeScreenshot();
            if (full == null) throw new Server.Coded("no_window", "The screen could not be captured (a secure window, or the screen is off)");
        } else {
            Hidden h = hiddenById(d);
            full = h == null ? null : h.frame();
            if (full == null) throw new Server.Coded("no_window", "The hidden screen has not drawn anything yet; try again in a moment");
        }
        int width = p.optInt("width", full.getWidth());
        int height = p.optInt("height", full.getHeight());
        Bitmap scaled = width == full.getWidth() && height == full.getHeight() ? full : Bitmap.createScaledBitmap(full, width, height, true);
        boolean jpeg = "jpeg".equals(p.optString("format", "png"));
        int quality = (int) Math.round(p.optDouble("quality", 0.8) * 100);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        scaled.compress(jpeg ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG, quality, bytes);
        return new JSONObject()
                .put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                .put("width", width)
                .put("height", height)
                .put("mimeType", jpeg ? "image/jpeg" : "image/png");
    }

    // ---- test-only virtual display (removed with the server)

    private final List<Object> keepAlive = new ArrayList<>();

    private JSONObject createDisplay(JSONObject p) throws Exception {
        int width = p.optInt("width", 1080), height = p.optInt("height", 2400), dpi = p.optInt("dpi", 420);
        int flags = p.getInt("flags");
        Constructor<DisplayManager> dmc = DisplayManager.class.getDeclaredConstructor(Context.class);
        dmc.setAccessible(true);
        DisplayManager dm = dmc.newInstance(context);
        android.media.ImageReader reader = android.media.ImageReader.newInstance(width, height, android.graphics.PixelFormat.RGBA_8888, 2);
        android.hardware.display.VirtualDisplay vd = dm.createVirtualDisplay("glovebox-test", width, height, dpi, reader.getSurface(), flags);
        keepAlive.add(reader);
        keepAlive.add(vd);
        return new JSONObject().put("displayId", vd.getDisplay().getDisplayId());
    }

    private JSONObject displayTree(JSONObject p) throws Exception {
        int displayId = p.getInt("displayId");
        List<AccessibilityWindowInfo> windows = displayWindows(displayId);
        Tree.Walk walk = tree.walk(windows, p.optInt("maxNodes", 800), p.optInt("maxDepth", 40), p.optInt("maxText", 200));
        JSONArray packages = new JSONArray();
        for (AccessibilityWindowInfo w : windows) packages.put(windowPackage(w));
        return new JSONObject().put("windows", windows.size()).put("packages", packages).put("nodes", walk.nodes);
    }

    // Test-only: clears an app's entries from recent apps, as swiping them
    // away would, so a probe can start from a phone that never ran it.
    private JSONObject removeRecents(String pkg) throws Exception {
        Object atm = Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null);
        Object slice = atm.getClass().getMethod("getRecentTasks", int.class, int.class, int.class).invoke(atm, 100, 0, 0);
        int removed = 0;
        for (Object t : (List<?>) slice.getClass().getMethod("getList").invoke(slice)) {
            android.app.ActivityManager.RecentTaskInfo info = (android.app.ActivityManager.RecentTaskInfo) t;
            if (!taskOf(info, pkg)) continue;
            int id = info.getClass().getField("taskId").getInt(info);
            if ((Boolean) atm.getClass().getMethod("removeTask", int.class).invoke(atm, id)) removed++;
        }
        return new JSONObject().put("removed", removed);
    }

    // ---- setup

    private void requireAutomation() {
        if (automation == null) {
            throw new Server.Coded("permission", "No accessibility connection from shell"
                    + (connectError == null ? "" : " (" + connectError + ")")
                    + ". Another automation tool (uiautomator, Appium, Maestro) may hold it; stop it and try again.");
        }
    }

    Point displaySize(int d) {
        if (d != DEFAULT_DISPLAY) {
            Hidden h = hiddenById(d);
            if (h != null) return new Point(h.width, h.height);
        }
        Point size = new Point();
        DisplayManager dm = (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
        Display display = dm == null ? null : dm.getDisplay(DEFAULT_DISPLAY);
        if (display != null) display.getRealSize(size);
        return size;
    }

    private static UiAutomation connect(Looper looper) throws Exception {
        Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
        Object connection = connectionClass.getDeclaredConstructor().newInstance();
        Constructor<UiAutomation> ctor = UiAutomation.class.getDeclaredConstructor(
                Looper.class, Class.forName("android.app.IUiAutomationConnection"));
        ctor.setAccessible(true);
        UiAutomation automation = ctor.newInstance(looper, connection);
        Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
        connect.setAccessible(true);
        connect.invoke(automation, DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        automation.setServiceInfo(info);
        return automation;
    }

    private static Context systemContext() {
        try {
            Class<?> at = Class.forName("android.app.ActivityThread");
            Constructor<?> ctor = at.getDeclaredConstructor();
            ctor.setAccessible(true);
            Object thread = ctor.newInstance();
            Field current = at.getDeclaredField("sCurrentActivityThread");
            current.setAccessible(true);
            current.set(null, thread);
            Field system = at.getDeclaredField("mSystemThread");
            system.setAccessible(true);
            system.setBoolean(thread, true);
            // Samsung: building the system context reads the display info,
            // which calls ActivityThread.getConfiguration() and needs a
            // ConfigurationController (absent on stock builds that don't).
            try {
                Class<?> controller = Class.forName("android.app.ConfigurationController");
                Class<?> internal = Class.forName("android.app.ActivityThreadInternal");
                Constructor<?> cc = controller.getDeclaredConstructor(internal);
                cc.setAccessible(true);
                Field field = at.getDeclaredField("mConfigurationController");
                field.setAccessible(true);
                field.set(thread, cc.newInstance(thread));
            } catch (ReflectiveOperationException ignored) {
                // Older or stock releases without the class do not need it.
            }
            Context base = (Context) at.getDeclaredMethod("getSystemContext").invoke(thread);
            return new ContextWrapper(base) {
                @Override public String getPackageName() { return "com.android.shell"; }
                @Override public String getOpPackageName() { return "com.android.shell"; }
            };
        } catch (Exception e) {
            throw new IllegalStateException("Could not build a system context", e);
        }
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
