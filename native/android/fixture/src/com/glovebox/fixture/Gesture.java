// Two-finger gestures: a pad that reports the pinch scale and the twist
// angle it received, as a map or photo view would act on them.
package com.glovebox.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

public class Gesture extends Activity {
    private float scale = 1f, angle = 0f;
    private float startSpan, startAngle, baseScale, baseAngle;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        TextView label = new TextView(this);
        label.setText("scale: 1.00, angle: 0");
        label.setTextSize(20);
        root.addView(label);
        View pad = new View(this);
        pad.setBackgroundColor(0xFFDDE6F0);
        pad.setContentDescription("Gesture pad");
        pad.setOnTouchListener((v, e) -> {
            if (e.getPointerCount() < 2) return true;
            float dx = e.getX(1) - e.getX(0), dy = e.getY(1) - e.getY(0);
            float span = (float) Math.hypot(dx, dy);
            float a = (float) Math.toDegrees(Math.atan2(dy, dx));
            int action = e.getActionMasked();
            if (action == MotionEvent.ACTION_POINTER_DOWN) {
                startSpan = span;
                startAngle = a;
                baseScale = scale;
                baseAngle = angle;
            } else if (action == MotionEvent.ACTION_MOVE && startSpan > 0) {
                scale = baseScale * span / startSpan;
                float turn = a - startAngle;
                if (turn > 180) turn -= 360;
                if (turn < -180) turn += 360;
                angle = baseAngle + turn;
                label.setText(String.format(java.util.Locale.ROOT, "scale: %.2f, angle: %.0f", scale, angle));
            }
            return true;
        });
        root.addView(pad, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }
}
