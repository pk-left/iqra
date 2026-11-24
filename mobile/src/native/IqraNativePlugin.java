package com.pkleft.iqra;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.RandomAccessFile;

// Small native helpers for Iqra: "All files" access (so it can find books in Download, Documents,
// etc. like the laptop version does) and byte-range reads of book files.
@CapacitorPlugin(name = "IqraNative")
public class IqraNativePlugin extends Plugin {

    private boolean granted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return getContext().checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void checkAllFiles(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted());
        r.put("root", Environment.getExternalStorageDirectory().getAbsolutePath());
        call.resolve(r);
    }

    @PluginMethod
    public void requestAllFiles(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                try { getActivity().startActivity(i); }
                catch (Exception e) { getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)); }
            } else {
                getActivity().requestPermissions(new String[] {
                        android.Manifest.permission.READ_EXTERNAL_STORAGE,
                        android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, 4711);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void readRange(PluginCall call) {
        String path = call.getString("path");
        long offset = call.getLong("offset", 0L);
        int length = call.getInt("length", 0);
        try (RandomAccessFile f = new RandomAccessFile(new File(path), "r")) {
            long size = f.length();
            if (offset >= size) length = 0;
            else length = (int) Math.min((long) length, size - offset);
            byte[] buf = new byte[Math.max(0, length)];
            f.seek(offset);
            f.readFully(buf);
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            r.put("size", size);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), "READ_FAILED");
        }
    }
}
