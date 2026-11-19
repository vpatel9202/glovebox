// A hidden screen: a private virtual display that one app runs on, so the
// agent works without touching what the user sees. It never takes top focus
// (STEAL_TOP_FOCUS_DISABLED), has its own focused window (OWN_FOCUS), hides
// the keyboard, and destroys its content when released or when the server
// dies. Frames land in an ImageReader; the latest one is kept for screenshots.
//
// The flags and the IME policy call follow scrcpy's NewDisplayCapture and
// WindowManager wrappers (Copyright (C) 2018 Genymobile, Apache License 2.0;
// see NOTICE), plus STEAL_TOP_FOCUS_DISABLED, which scrcpy does not set.
package com.glovebox.server;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import java.lang.reflect.Constructor;
import java.nio.ByteBuffer;

final class Hidden {
    // PUBLIC | PRESENTATION | OWN_CONTENT_ONLY | SUPPORTS_TOUCH | ROTATES_WITH_CONTENT
    // | DESTROY_CONTENT_ON_REMOVAL | TRUSTED | OWN_DISPLAY_GROUP | ALWAYS_UNLOCKED
    // | TOUCH_FEEDBACK_DISABLED | OWN_FOCUS | DEVICE_DISPLAY_GROUP, plus
    // STEAL_TOP_FOCUS_DISABLED (1 << 16, hidden, API 34+).
    static final int FLAGS = 0x1fdcb;
    static final int MIN_SDK = 34;
    private static final int IME_POLICY_HIDE = 2; // WindowManager.DISPLAY_IME_POLICY_HIDE

    final String owner;
    final int id;
    final int width;
    final int height;
    final int dpi;
    final boolean imeHidden;
    // Whether the app had a window on the phone's screen when glovebox
    // opened it here, so the user's own copy is not mistaken for a move.
    volatile boolean onPhoneAtStart;
    private final VirtualDisplay display;
    private final ImageReader reader;
    private Image latest;

    Hidden(Context context, String owner, int width, int height, int dpi, Handler frames) throws Exception {
        this.owner = owner;
        this.width = width;
        this.height = height;
        this.dpi = dpi;
        Constructor<DisplayManager> ctor = DisplayManager.class.getDeclaredConstructor(Context.class);
        ctor.setAccessible(true);
        DisplayManager dm = ctor.newInstance(context);
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        reader.setOnImageAvailableListener(r -> {
            Image image;
            try {
                image = r.acquireLatestImage();
            } catch (IllegalStateException full) {
                return; // all buffers held; the next frame retries
            }
            if (image == null) return;
            synchronized (this) {
                if (latest != null) latest.close();
                latest = image;
            }
        }, frames);
        display = dm.createVirtualDisplay("glovebox:" + owner, width, height, dpi, reader.getSurface(), FLAGS);
        if (display == null) throw new Server.Coded("failed", "The phone would not create a hidden screen");
        id = display.getDisplay().getDisplayId();
        imeHidden = setImePolicy(id, IME_POLICY_HIDE);
    }

    // The latest frame, or null before anything has drawn.
    synchronized Bitmap frame() {
        if (latest == null) return null;
        Image.Plane plane = latest.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        buffer.rewind();
        int pixelStride = plane.getPixelStride();
        int rowWidth = plane.getRowStride() / pixelStride;
        Bitmap padded = Bitmap.createBitmap(rowWidth, height, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        return rowWidth == width ? padded : Bitmap.createBitmap(padded, 0, 0, width, height);
    }

    // Removes the display's tasks first, so none outlives it (a task in the
    // back of a removed display can linger for a moment, and a launch of the
    // same app on the phone's screen in that moment would pick it up).
    void release() {
        try {
            Object atm = Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null);
            java.util.List<?> roots = (java.util.List<?>) atm.getClass().getMethod("getAllRootTaskInfosOnDisplay", int.class).invoke(atm, id);
            java.lang.reflect.Method remove = atm.getClass().getMethod("removeTask", int.class);
            for (Object root : roots) remove.invoke(atm, root.getClass().getField("taskId").getInt(root));
        } catch (Throwable ignored) {
            // DESTROY_CONTENT_ON_REMOVAL still closes them with the display.
        }
        display.release();
        synchronized (this) {
            if (latest != null) latest.close();
            latest = null;
        }
        reader.close();
    }

    // Keeps the keyboard off the user's screen: without it a virtual display
    // without system decorations shows its IME on the default display.
    private static boolean setImePolicy(int displayId, int policy) {
        try {
            Class<?> sm = Class.forName("android.os.ServiceManager");
            IBinder binder = (IBinder) sm.getMethod("getService", String.class).invoke(null, "window");
            Object wm = Class.forName("android.view.IWindowManager$Stub").getMethod("asInterface", IBinder.class).invoke(null, binder);
            if (Build.VERSION.SDK_INT >= 31) {
                wm.getClass().getMethod("setDisplayImePolicy", int.class, int.class).invoke(wm, displayId, policy);
            } else {
                wm.getClass().getMethod("setShouldShowIme", int.class, boolean.class).invoke(wm, displayId, false);
            }
            return true;
        } catch (Throwable e) {
            return false;
        }
    }
}
