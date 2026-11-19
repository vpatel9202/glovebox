// A one-time-code screen as many apps build it: six one-digit boxes that move
// focus to the next box as each digit lands, and a label with the code so far.
package com.nostrings.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public class Code extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        TextView title = new TextView(this);
        title.setText("Enter code");
        title.setTextSize(22);
        root.addView(title);
        LinearLayout row = new LinearLayout(this);
        TextView code = new TextView(this);
        code.setText("code: ");
        EditText[] boxes = new EditText[6];
        for (int i = 0; i < boxes.length; i++) {
            EditText box = new EditText(this);
            box.setFilters(new InputFilter[] {new InputFilter.LengthFilter(1)});
            box.setInputType(InputType.TYPE_CLASS_NUMBER);
            box.setContentDescription("Digit " + (i + 1));
            boxes[i] = box;
            row.addView(box, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        }
        for (int i = 0; i < boxes.length; i++) {
            final int next = i + 1;
            boxes[i].addTextChangedListener(new TextWatcher() {
                public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
                public void onTextChanged(CharSequence s, int a, int b, int c) {}
                public void afterTextChanged(Editable s) {
                    StringBuilder all = new StringBuilder();
                    for (EditText b : boxes) all.append(b.getText());
                    code.setText("code: " + all);
                    if (s.length() == 1 && next < boxes.length) boxes[next].requestFocus();
                }
            });
        }
        root.addView(row);
        root.addView(code);
        setContentView(root);
    }
}
