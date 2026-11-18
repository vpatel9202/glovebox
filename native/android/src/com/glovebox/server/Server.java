// glovebox server for Android. Started by the host over ADB with shell
// privileges (app_process), it speaks the backend protocol as JSON lines on
// stdin and stdout and exits when stdin closes. See docs/backend-protocol.md.
package com.glovebox.server;

import android.os.Looper;
import android.system.Os;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import org.json.JSONObject;

public final class Server {
    static final String VERSION = "0.1.0";

    private final PrintStream protocol;
    private final Device device;

    private Server(PrintStream protocol, Device device) {
        this.protocol = protocol;
        this.device = device;
    }

    public static void main(String[] args) throws Exception {
        // Protocol lines go to a private copy of stdout. File descriptor 1 then
        // points at stderr, so anything else that prints (native graphics code
        // included) cannot corrupt the stream.
        FileDescriptor out = Os.dup(FileDescriptor.out);
        Os.dup2(FileDescriptor.err, 1);
        PrintStream protocol = new PrintStream(new FileOutputStream(out), true, "UTF-8");
        System.setOut(System.err);

        Looper.prepareMainLooper();
        Server server = new Server(protocol, new Device());
        server.run();
    }

    private void run() throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            handle(line);
        }
        device.close();
        System.exit(0);
    }

    private void handle(String line) {
        JSONObject reply = new JSONObject();
        Object id = null;
        try {
            JSONObject request = new JSONObject(line);
            id = request.opt("id");
            reply.put("id", id);
            String method = request.getString("method");
            JSONObject params = request.optJSONObject("params");
            if (params == null) params = new JSONObject();
            reply.put("result", device.call(method, params));
        } catch (Coded e) {
            putError(reply, id, e.getMessage(), e.code);
        } catch (Throwable e) {
            String message = e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
            putError(reply, id, message, "failed");
        }
        synchronized (protocol) {
            protocol.println(reply.toString());
        }
    }

    private static void putError(JSONObject reply, Object id, String message, String code) {
        try {
            reply.put("id", id);
            reply.remove("result");
            reply.put("error", new JSONObject().put("message", message).put("code", code));
        } catch (Exception ignored) {
            // JSONObject.put only throws on non-finite numbers.
        }
    }

    // An error with a protocol code (see backend-protocol.md "Errors").
    static final class Coded extends RuntimeException {
        final String code;

        Coded(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
