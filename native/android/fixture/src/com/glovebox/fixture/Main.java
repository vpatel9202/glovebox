// The smoke-test screen. Every control reports what happened to it in a
// label next to it, so a read after each action shows whether it landed.
package com.glovebox.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.ViewGroup.LayoutParams;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.SeekBar;
import android.widget.TextView;

public class Main extends Activity {
    private int taps;
    private int longPresses;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 96, 32, 32);
        root.setFitsSystemWindows(true);

        TextView title = new TextView(this);
        title.setText("glovebox fixture");
        title.setTextSize(22);
        root.addView(title);

        EditText field = new EditText(this);
        field.setHint("Type here");
        field.setSingleLine(true);
        root.addView(field);
        TextView echo = new TextView(this);
        echo.setText("echo: ");
        root.addView(echo);
        field.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            public void onTextChanged(CharSequence s, int a, int b, int c) {}
            public void afterTextChanged(Editable s) {
                echo.setText("echo: " + s);
            }
        });

        Button button = new Button(this);
        button.setText("Tap me");
        button.setAllCaps(false); // some themes capitalize button labels
        root.addView(button);
        TextView counts = new TextView(this);
        counts.setText("taps: 0, long presses: 0");
        root.addView(counts);
        button.setOnClickListener(v -> {
            taps++;
            counts.setText("taps: " + taps + ", long presses: " + longPresses);
        });
        button.setOnLongClickListener(v -> {
            longPresses++;
            counts.setText("taps: " + taps + ", long presses: " + longPresses);
            return true;
        });

        Button codeScreen = new Button(this);
        codeScreen.setText("Code screen");
        codeScreen.setAllCaps(false);
        codeScreen.setOnClickListener(v -> startActivity(new android.content.Intent(this, Code.class)));
        root.addView(codeScreen);

        SeekBar slider = new SeekBar(this);
        slider.setMax(100);
        slider.setContentDescription("Slider");
        slider.setPadding(48, 32, 48, 32);
        root.addView(slider);
        TextView sliderValue = new TextView(this);
        sliderValue.setText("slider: 0");
        root.addView(sliderValue);
        slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar s, int progress, boolean fromUser) {
                sliderValue.setText("slider: " + progress);
            }
            public void onStartTrackingTouch(SeekBar s) {}
            public void onStopTrackingTouch(SeekBar s) {}
        });

        String[] rows = new String[200];
        for (int i = 0; i < rows.length; i++) rows[i] = "Row " + i;
        ListView list = new ListView(this);
        list.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, rows));
        root.addView(list, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1));

        setContentView(root);
    }
}
