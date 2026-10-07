package id.anatta.pos;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.regex.Pattern;

/**
 * Jembatan perangkat keras untuk Anatta POS. Lapisan ini sengaja tipis: pengiriman byte ke printer, postur
 * keamanan perangkat, mode kios, tanda tangan dengan Android Keystore, dan layar customer kedua.
 * Logika (ESC/POS, kunci void, rantai hash) tetap di JavaScript agar diuji di satu tempat.
 */
@CapacitorPlugin(name = "PosHardware")
public class PosHardwarePlugin extends Plugin {
    private static final String KEY_ALIAS = "pos_guard_device_key";
    private static final String ACTION_USB_PERMISSION = "id.anatta.pos.USB_PERMISSION";
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.-]{1,253}$");
    private static final int MAX_PAYLOAD = 64 * 1024;

    private CustomerDisplay display;

    // ---------------------------------------------------------------- jaringan (printer LAN)

    private static byte[] decode(String b64) {
        return Base64.decode(b64, Base64.NO_WRAP);
    }

    private boolean validTarget(PluginCall call, String host, Integer port, String data) {
        if (host == null || !HOST.matcher(host).matches() || port == null || port < 1 || port > 65535 || data == null || data.length() > MAX_PAYLOAD * 2) {
            call.reject("host, port, atau data tidak valid");
            return false;
        }
        return true;
    }

    @PluginMethod
    public void tcpWrite(final PluginCall call) {
        final String host = call.getString("host");
        final Integer port = call.getInt("port", 9100);
        final String data = call.getString("data");
        final int timeout = call.getInt("timeoutMs", 3000);
        if (!validTarget(call, host, port, data)) return;
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), timeout);
            s.setSoTimeout(timeout);
            OutputStream out = s.getOutputStream();
            out.write(decode(data));
            out.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject("tcp: " + e.getMessage());
        }
    }

    @PluginMethod
    public void tcpQuery(final PluginCall call) {
        final String host = call.getString("host");
        final Integer port = call.getInt("port", 9100);
        final String data = call.getString("data");
        final int expect = Math.max(1, Math.min(call.getInt("expect", 1), 64));
        final int timeout = call.getInt("timeoutMs", 1500);
        if (!validTarget(call, host, port, data)) return;
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), timeout);
            s.setSoTimeout(timeout);
            OutputStream out = s.getOutputStream();
            out.write(decode(data));
            out.flush();
            InputStream in = s.getInputStream();
            byte[] buf = new byte[expect];
            int n = 0;
            try {
                while (n < expect) {
                    int r = in.read(buf, n, expect - n);
                    if (r < 0) break;
                    n += r;
                }
            } catch (SocketTimeoutException ignored) {
                // jawaban sebagian dikembalikan; tanpa jawaban sama sekali dianggap waktu habis
            }
            if (n == 0) {
                call.reject("tcp: waktu habis menunggu jawaban printer");
                return;
            }
            JSObject res = new JSObject();
            res.put("data", Base64.encodeToString(Arrays.copyOf(buf, n), Base64.NO_WRAP));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("tcp: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- USB (printer kelas 7)

    private UsbManager usb() {
        return (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    private static UsbInterface printerInterface(UsbDevice d) {
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return d.getInterface(i);
        }
        return null;
    }

    @PluginMethod
    public void usbList(PluginCall call) {
        JSArray list = new JSArray();
        for (UsbDevice d : usb().getDeviceList().values()) {
            if (printerInterface(d) == null) continue;
            JSObject o = new JSObject();
            o.put("name", d.getDeviceName());
            o.put("vendorId", d.getVendorId());
            o.put("productId", d.getProductId());
            o.put("hasPermission", usb().hasPermission(d));
            list.put(o);
        }
        JSObject res = new JSObject();
        res.put("devices", list);
        call.resolve(res);
    }

    /** Meminta izin USB. Pengguna menyetujui di dialog sistem; panggilan berikutnya akan berhasil. */
    private void requestUsbPermission(UsbDevice d) {
        Context ctx = getContext();
        Intent intent = new Intent(ACTION_USB_PERMISSION).setPackage(ctx.getPackageName());
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, intent, flags);
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                c.unregisterReceiver(this);
            }
        };
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else ctx.registerReceiver(receiver, filter);
        usb().requestPermission(d, pi);
    }

    private UsbDevice pickPrinter(PluginCall call) {
        String name = call.getString("name");
        for (UsbDevice d : usb().getDeviceList().values()) {
            if (printerInterface(d) == null) continue;
            if (name == null || name.equals(d.getDeviceName())) return d;
        }
        return null;
    }

    /** Menulis ke printer USB. Bila ada `expect`, juga membaca jawaban (status) dari endpoint masuk. */
    private void usbTransfer(PluginCall call, boolean query) {
        String data = call.getString("data");
        if (data == null || data.length() > MAX_PAYLOAD * 2) {
            call.reject("data tidak valid");
            return;
        }
        UsbDevice d = pickPrinter(call);
        if (d == null) {
            call.reject("USB: printer tidak ditemukan");
            return;
        }
        if (!usb().hasPermission(d)) {
            requestUsbPermission(d);
            call.reject("USB_PERMISSION");
            return;
        }
        UsbInterface intf = printerInterface(d);
        UsbEndpoint out = null, in = null;
        for (int i = 0; i < intf.getEndpointCount(); i++) {
            UsbEndpoint e = intf.getEndpoint(i);
            if (e.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
            if (e.getDirection() == UsbConstants.USB_DIR_OUT) out = e;
            else in = e;
        }
        if (out == null) {
            call.reject("USB: endpoint keluar tidak ada");
            return;
        }
        UsbDeviceConnection c = usb().openDevice(d);
        if (c == null) {
            call.reject("USB: gagal membuka perangkat");
            return;
        }
        try {
            if (!c.claimInterface(intf, true)) {
                call.reject("USB: gagal mengklaim antarmuka");
                return;
            }
            byte[] bytes = decode(data);
            int timeout = call.getInt("timeoutMs", 3000);
            for (int off = 0; off < bytes.length; off += 16384) {
                int len = Math.min(16384, bytes.length - off);
                byte[] chunk = Arrays.copyOfRange(bytes, off, off + len);
                if (c.bulkTransfer(out, chunk, len, timeout) < 0) {
                    call.reject("USB: pengiriman gagal");
                    return;
                }
            }
            if (!query) {
                call.resolve();
                return;
            }
            if (in == null) {
                call.reject("USB: endpoint masuk tidak ada");
                return;
            }
            byte[] buf = new byte[64];
            int n = c.bulkTransfer(in, buf, buf.length, call.getInt("timeoutMs", 1500));
            if (n <= 0) {
                call.reject("USB: waktu habis menunggu jawaban printer");
                return;
            }
            JSObject res = new JSObject();
            res.put("data", Base64.encodeToString(Arrays.copyOf(buf, n), Base64.NO_WRAP));
            call.resolve(res);
        } finally {
            c.releaseInterface(intf);
            c.close();
        }
    }

    @PluginMethod
    public void usbWrite(PluginCall call) {
        usbTransfer(call, false);
    }

    @PluginMethod
    public void usbQuery(PluginCall call) {
        usbTransfer(call, true);
    }

    // ---------------------------------------------------------------- postur keamanan dan kios

    private boolean globalFlag(String name) {
        try {
            return Settings.Global.getInt(getContext().getContentResolver(), name, 0) == 1;
        } catch (Exception e) {
            return false;
        }
    }

    /** Heuristik sederhana, bukan bukti: root yang disembunyikan tidak terdeteksi. */
    private static boolean looksRooted() {
        String[] paths = {"/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/app/Superuser.apk", "/data/local/bin/su", "/data/local/xbin/su"};
        for (String p : paths) if (new File(p).exists()) return true;
        return Build.TAGS != null && Build.TAGS.contains("test-keys");
    }

    private boolean inLockTask() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        return am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }

    @PluginMethod
    public void getPosture(PluginCall call) {
        JSObject o = new JSObject();
        o.put("autoTime", globalFlag(Settings.Global.AUTO_TIME));
        o.put("adb", globalFlag(Settings.Global.ADB_ENABLED));
        o.put("devOptions", globalFlag(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED));
        o.put("kiosk", inLockTask());
        o.put("rooted", looksRooted());
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            o.put("appVersion", pi.versionName == null ? "0" : pi.versionName);
        } catch (Exception e) {
            o.put("appVersion", "0");
        }
        call.resolve(o);
    }

    @PluginMethod
    public void enterKiosk(final PluginCall call) {
        final Activity a = getActivity();
        a.runOnUiThread(() -> {
            try {
                Window w = a.getWindow();
                w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                WindowCompat.setDecorFitsSystemWindows(w, false);
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
                c.hide(WindowInsetsCompat.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                a.startLockTask(); // tanpa device owner, sistem meminta persetujuan penyematan layar sekali
                call.resolve();
            } catch (Exception e) {
                call.reject("kios: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void exitKiosk(final PluginCall call) {
        final Activity a = getActivity();
        a.runOnUiThread(() -> {
            try {
                a.stopLockTask();
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView());
                c.show(WindowInsetsCompat.Type.systemBars());
                call.resolve();
            } catch (Exception e) {
                call.reject("kios: " + e.getMessage());
            }
        });
    }

    // ---------------------------------------------------------------- kunci perangkat (Android Keystore)

    private KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private void ensureKey(KeyStore ks) throws Exception {
        if (ks.containsAlias(KEY_ALIAS)) return;
        for (boolean strongBox : new boolean[] {true, false}) {
            if (strongBox && Build.VERSION.SDK_INT < 28) continue;
            try {
                KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                        .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setUserAuthenticationRequired(false);
                if (strongBox) b.setIsStrongBoxBacked(true);
                KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
                g.initialize(b.build());
                g.generateKeyPair();
                return;
            } catch (Exception e) {
                if (!strongBox) throw e; // StrongBox tidak ada: ulangi tanpa StrongBox
            }
        }
    }

    private boolean hardwareBacked(PrivateKey key) {
        try {
            KeyInfo info = KeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore").getKeySpec(key, KeyInfo.class);
            return info.isInsideSecureHardware();
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void signerPublicKey(PluginCall call) {
        try {
            KeyStore ks = keyStore();
            ensureKey(ks);
            JSObject res = new JSObject();
            res.put("publicKey", Base64.encodeToString(ks.getCertificate(KEY_ALIAS).getPublicKey().getEncoded(), Base64.NO_WRAP));
            res.put("hardwareBacked", hardwareBacked((PrivateKey) ks.getKey(KEY_ALIAS, null)));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("keystore: " + e.getMessage());
        }
    }

    @PluginMethod
    public void signerSign(PluginCall call) {
        String message = call.getString("message");
        if (message == null || message.length() > 512) {
            call.reject("message tidak valid");
            return;
        }
        try {
            KeyStore ks = keyStore();
            ensureKey(ks);
            Signature sig = Signature.getInstance("SHA256withECDSA");
            sig.initSign((PrivateKey) ks.getKey(KEY_ALIAS, null));
            sig.update(message.getBytes(StandardCharsets.UTF_8));
            byte[] raw = Der.toRaw(sig.sign(), 32);
            JSObject res = new JSObject();
            res.put("signature", Base64.encodeToString(raw, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("keystore: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- layar customer kedua

    @PluginMethod
    public void displayAvailable(PluginCall call) {
        JSObject res = new JSObject();
        res.put("available", CustomerDisplay.find(getContext()) != null);
        call.resolve(res);
    }

    @PluginMethod
    public void displayShow(final PluginCall call) {
        final String view = call.getString("view");
        getActivity().runOnUiThread(() -> {
            if (display == null) display = new CustomerDisplay(getActivity());
            JSObject res = new JSObject();
            res.put("shown", display.show(view));
            call.resolve(res);
        });
    }

    @PluginMethod
    public void displayHide(final PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (display != null) display.dismiss();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (display != null) display.dismiss();
    }
}
