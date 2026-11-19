// Web content inside an app: a WebView with a heading, a link, a text input
// and a button that writes what was typed into the page.
package com.glovebox.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

public class Web extends Activity {
    private static final String PAGE = "<!doctype html><html><head><meta name=viewport content='width=device-width'>"
            + "<title>Fixture page</title></head><body>"
            + "<h1>Web fixture</h1>"
            + "<p><a href='#more' id=more onclick=\"document.getElementById('out').textContent='link tapped'\">More details</a></p>"
            + "<label for=name>Name</label> <input id=name type=text placeholder='Your name'>"
            + "<p><button id=go onclick=\"document.getElementById('out').textContent='hello '+document.getElementById('name').value\">Greet</button></p>"
            + "<p id=out>nothing yet</p>"
            + "</body></html>";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.loadDataWithBaseURL("https://fixture.invalid/", PAGE, "text/html", "utf-8", null);
        setContentView(web);
    }
}
