// Accessibility nodes as the backend protocol's flat node list: AX role names,
// stable element indices, and nameless layout containers folded away.
package com.glovebox.server;

import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

final class Tree {
    // Index table. A node keeps its index while the same view (same window id
    // and node id) shows the same kind of thing; if a list recycles the view
    // for a different class or id, it gets a new index, so an old index fails
    // with stale_index instead of hitting the wrong row.
    private final Map<AccessibilityNodeInfo, Integer> indexOf = new HashMap<>();
    private final Map<Integer, Entry> byIndex = new HashMap<>();
    private int next = 1;

    private static final class Entry {
        final AccessibilityNodeInfo node;
        final String fingerprint;

        Entry(AccessibilityNodeInfo node, String fingerprint) {
            this.node = node;
            this.fingerprint = fingerprint;
        }
    }

    static final class Walk {
        final JSONArray nodes = new JSONArray();
        boolean truncated;
    }

    void clear() {
        indexOf.clear();
        byIndex.clear();
    }

    // What must stay the same for an index to still mean the same element. A
    // list row's position is part of it: lists reuse row views for other
    // rows as they scroll, so an index read before a scroll would otherwise
    // land on whatever row the view shows now.
    private static String fingerprint(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo.CollectionItemInfo item = n.getCollectionItemInfo();
        String row = item == null ? "" : "|" + item.getRowIndex() + ":" + item.getColumnIndex();
        return n.getClassName() + "|" + n.getViewIdResourceName() + row;
    }

    int indexOf(AccessibilityNodeInfo n) {
        String fp = fingerprint(n);
        Integer known = indexOf.get(n);
        if (known != null) {
            Entry entry = byIndex.get(known);
            if (entry != null && entry.fingerprint.equals(fp)) {
                byIndex.put(known, new Entry(n, fp)); // keep the freshest copy
                return known;
            }
            byIndex.remove(known);
        }
        int index = next++;
        indexOf.put(n, index);
        byIndex.put(index, new Entry(n, fp));
        return index;
    }

    AccessibilityNodeInfo node(int index) {
        Entry entry = byIndex.get(index);
        if (entry == null) throw new Server.Coded("stale_index", "Element " + index + " is not in the table; read the tree again");
        AccessibilityNodeInfo n = entry.node;
        if (!n.refresh() || !fingerprint(n).equals(entry.fingerprint)) {
            byIndex.remove(index);
            throw new Server.Coded("stale_index", "Element " + index + " is gone or now shows something else; read the tree again");
        }
        return n;
    }

    // Windows top first. Each window is one AXWindow node at depth 0.
    Walk walk(List<AccessibilityWindowInfo> windows, int maxNodes, int maxDepth, int maxText) throws Exception {
        return walk(windows, maxNodes, maxDepth, maxText, false);
    }

    // The on-screen keyboard prints as one window line unless `keyboard` is
    // set: its keys are dozens of buttons that typeText never needs.
    Walk walk(List<AccessibilityWindowInfo> windows, int maxNodes, int maxDepth, int maxText, boolean keyboard) throws Exception {
        Walk walk = new Walk();
        for (AccessibilityWindowInfo w : windows) {
            AccessibilityNodeInfo root = w.getRoot();
            if (root == null) continue;
            if (walk.nodes.length() >= maxNodes) {
                walk.truncated = true;
                break;
            }
            JSONObject win = new JSONObject()
                    .put("i", indexOf(root))
                    .put("d", 0)
                    .put("role", "AXWindow")
                    .put("frame", frame(root));
            String subrole = windowSubrole(w);
            if (subrole != null) win.put("subrole", subrole);
            CharSequence title = w.getTitle();
            if (title != null && title.length() > 0) win.put("title", clip(title, maxText));
            walk.nodes.put(win);
            if (w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD && !keyboard) {
                win.put("title", "keyboard (pass {keyboard: true} to list its keys)");
                continue;
            }
            for (int i = 0; i < root.getChildCount(); i++) visit(root.getChild(i), 1, walk, maxNodes, maxDepth, maxText);
        }
        return walk;
    }

    private static String windowSubrole(AccessibilityWindowInfo w) {
        switch (w.getType()) {
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD:
                return "AXKeyboard";
            case AccessibilityWindowInfo.TYPE_SYSTEM:
                return "AXSystemDialog";
            case AccessibilityWindowInfo.TYPE_APPLICATION:
                return null;
            default:
                return "AXFloatingWindow";
        }
    }

    private void visit(AccessibilityNodeInfo n, int depth, Walk walk, int maxNodes, int maxDepth, int maxText) throws Exception {
        visit(n, depth, walk, maxNodes, maxDepth, maxText, null);
    }

    private void visit(AccessibilityNodeInfo n, int depth, Walk walk, int maxNodes, int maxDepth, int maxText, String parentLabel) throws Exception {
        if (n == null || !n.isVisibleToUser()) return;
        // A plain text that only repeats its parent's label (the text inside
        // a link or button) adds nothing.
        if (parentLabel != null && n.getChildCount() == 0 && !n.isClickable() && !n.isEditable()
                && n.getText() != null && parentLabel.contentEquals(n.getText())) {
            return;
        }
        if (walk.nodes.length() >= maxNodes) {
            walk.truncated = true;
            return;
        }
        // A container with nothing to say and nothing to do is folded: its
        // children print one level up.
        boolean emit = meaningful(n) || depth >= maxDepth;
        int childDepth = depth;
        if (emit) {
            walk.nodes.put(describe(n, depth, maxText));
            childDepth = depth + 1;
        }
        if (depth >= maxDepth) return;
        String label = n.getText() != null && n.getText().length() > 0 ? n.getText().toString()
                : n.getContentDescription() != null && n.getContentDescription().length() > 0 ? n.getContentDescription().toString() : null;
        for (int i = 0; i < n.getChildCount(); i++) visit(n.getChild(i), childDepth, walk, maxNodes, maxDepth, maxText, emit ? label : parentLabel);
    }

    // Web content (WebView, Chrome) names each node's HTML role in an extra;
    // its class names are generic.
    static boolean isWeb(AccessibilityNodeInfo n) {
        android.os.Bundle extras = n.getExtras();
        return extras != null && extras.getString("AccessibilityNodeInfo.chromeRole") != null;
    }

    private static String webRole(AccessibilityNodeInfo n) {
        android.os.Bundle extras = n.getExtras();
        String chrome = extras == null ? null : extras.getString("AccessibilityNodeInfo.chromeRole");
        if (chrome == null) return null;
        switch (chrome) {
            case "link": return "AXLink";
            case "heading": return "AXHeading";
            case "button": case "toggleButton": return "AXButton";
            case "checkBox": case "switch": return "AXCheckBox";
            case "radioButton": return "AXRadioButton";
            case "comboBoxSelect": case "popUpButton": case "comboBoxMenuButton": return "AXPopUpButton";
            case "image": case "img": return "AXImage";
            case "list": case "listBox": return "AXList";
            case "rootWebArea": return "AXWebArea";
            case "staticText": case "inlineTextBox": return "AXStaticText";
            default: return null;
        }
    }

    private static boolean meaningful(AccessibilityNodeInfo n) {
        if (n.getText() != null && n.getText().length() > 0) return true;
        if (n.getContentDescription() != null && n.getContentDescription().length() > 0) return true;
        if (n.isClickable() || n.isLongClickable() || n.isCheckable() || n.isEditable() || n.isScrollable()) return true;
        if (Build.VERSION.SDK_INT >= 28 && n.isHeading()) return true;
        // Unlabeled groups and decorative images say nothing a read needs.
        String role = role(n);
        return !role.equals("AXGroup") && !role.equals("AXImage");
    }

    private JSONObject describe(AccessibilityNodeInfo n, int depth, int maxText) throws Exception {
        String role = role(n);
        JSONObject o = new JSONObject().put("i", indexOf(n)).put("d", depth).put("role", role);
        String subrole = subrole(n);
        if (subrole != null) o.put("subrole", subrole);
        CharSequence text = n.getText();
        CharSequence desc = n.getContentDescription();
        boolean hint = Build.VERSION.SDK_INT >= 26 && n.isShowingHintText();
        if (n.isEditable()) {
            if (text != null && !hint) o.put("value", clip(text, maxText));
            else o.put("value", "");
            CharSequence placeholder = Build.VERSION.SDK_INT >= 26 ? n.getHintText() : null;
            if (placeholder == null && hint) placeholder = text;
            if (placeholder != null && placeholder.length() > 0) o.put("placeholder", clip(placeholder, maxText));
            if (desc != null && desc.length() > 0) o.put("desc", clip(desc, maxText));
        } else {
            if (text != null && text.length() > 0) o.put("title", clip(text, maxText));
            if (desc != null && desc.length() > 0) o.put("desc", clip(desc, maxText));
        }
        if (n.isCheckable()) o.put("value", n.isChecked() ? "1" : "0");
        String id = n.getViewIdResourceName();
        if (id != null) o.put("id", id.contains(":id/") ? id.substring(id.indexOf(":id/") + 4) : id);
        o.put("frame", frame(n));
        JSONArray actions = actions(n);
        if (actions.length() > 0) o.put("actions", actions);
        if (n.isFocused()) o.put("focused", true);
        if (n.isSelected() || (n.isCheckable() && n.isChecked())) o.put("selected", true);
        if (!n.isEnabled()) o.put("disabled", true);
        if (n.isEditable()) o.put("settable", true);
        return o;
    }

    static JSONArray frame(AccessibilityNodeInfo n) {
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        return new JSONArray().put(b.left).put(b.top).put(b.width()).put(b.height());
    }

    static JSONArray actions(AccessibilityNodeInfo n) {
        JSONArray out = new JSONArray();
        for (AccessibilityAction a : n.getActionList()) {
            int id = a.getId();
            if (id == AccessibilityNodeInfo.ACTION_CLICK) out.put("AXPress");
            else if (id == AccessibilityNodeInfo.ACTION_LONG_CLICK) out.put("AXShowMenu");
            else if (id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) out.put("AXScrollDownByPage");
            else if (id == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) out.put("AXScrollUpByPage");
            else if (id == AccessibilityNodeInfo.ACTION_EXPAND) out.put("AXExpand");
            else if (id == AccessibilityNodeInfo.ACTION_COLLAPSE) out.put("AXCollapse");
            else if (id == AccessibilityNodeInfo.ACTION_DISMISS) out.put("AXCancel");
            else if (a.getLabel() != null && a.getLabel().length() > 0 && !isStandard(id)) out.put(a.getLabel().toString());
        }
        return out;
    }

    // Standard action ids are small bit flags; custom actions use resource ids.
    private static boolean isStandard(int id) {
        return id > 0 && id < 0x01000000;
    }

    static String role(AccessibilityNodeInfo n) {
        String cls = n.getClassName() == null ? "" : n.getClassName().toString();
        String simple = cls.substring(cls.lastIndexOf('.') + 1);
        if (n.isEditable() || simple.endsWith("EditText") || simple.equals("AutoCompleteTextView")) {
            return n.isPassword() ? "AXSecureTextField" : "AXTextField";
        }
        if (simple.equals("WebView")) return "AXWebArea";
        String web = webRole(n);
        if (web != null) return web;
        if (simple.equals("CheckBox") || simple.equals("CheckedTextView")) return "AXCheckBox";
        if (simple.contains("Switch") || simple.equals("ToggleButton")) return "AXCheckBox";
        if (simple.equals("RadioButton")) return "AXRadioButton";
        if (simple.equals("Spinner")) return "AXPopUpButton";
        if (simple.equals("SeekBar") || simple.equals("RatingBar")) return "AXSlider";
        if (simple.equals("ProgressBar")) return n.getRangeInfo() != null && n.isFocusable() ? "AXSlider" : "AXProgressIndicator";
        if (simple.endsWith("Button") || simple.equals("Chip")) return "AXButton";
        if (simple.equals("TabWidget") || simple.equals("TabLayout")) return "AXTabGroup";
        if (simple.equals("Toolbar") || simple.equals("ActionBar")) return "AXToolbar";
        if (simple.equals("ListView") || simple.equals("RecyclerView") || simple.equals("GridView") || n.getCollectionInfo() != null) {
            return "AXList";
        }
        if (simple.contains("ScrollView") || simple.equals("ViewPager") || n.isScrollable()) return "AXScrollArea";
        if (simple.equals("ImageView")) return n.isClickable() ? "AXButton" : "AXImage";
        if (Build.VERSION.SDK_INT >= 28 && n.isHeading()) return "AXHeading";
        if (simple.equals("TextView")) return n.isClickable() ? "AXButton" : "AXStaticText";
        if (n.isCheckable()) return "AXCheckBox";
        if (n.isClickable()) return "AXButton";
        CharSequence text = n.getText();
        if (text != null && text.length() > 0) return "AXStaticText";
        return "AXGroup";
    }

    private static String subrole(AccessibilityNodeInfo n) {
        String cls = n.getClassName() == null ? "" : n.getClassName().toString();
        if (cls.contains("Switch") || cls.endsWith("ToggleButton")) return "AXSwitch";
        if (n.isEditable() && cls.contains("Search")) return "AXSearchField";
        return null;
    }

    // The deepest visible node whose bounds contain the point.
    static AccessibilityNodeInfo deepest(AccessibilityNodeInfo n, int x, int y) {
        if (n == null || !n.isVisibleToUser()) return null;
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        if (!b.contains(x, y)) return null;
        for (int i = n.getChildCount() - 1; i >= 0; i--) {
            AccessibilityNodeInfo hit = deepest(n.getChild(i), x, y);
            if (hit != null) return hit;
        }
        return n;
    }

    private static String clip(CharSequence text, int max) {
        String s = text.toString();
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
