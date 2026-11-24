package com.pkleft.iqra;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;

// The phone's own local network addresses (Wi-Fi, or its hotspot), so sync can look for the laptop.
@CapacitorPlugin(name = "PkNet")
public class PkNetPlugin extends Plugin {
    @PluginMethod
    public void lanInfo(PluginCall call) {
        JSArray out = new JSArray();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName();
                if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("dummy") || name.startsWith("tun")) continue; // mobile data, VPN
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    JSObject o = new JSObject();
                    o.put("ip", a.getHostAddress());
                    o.put("prefix", ia.getNetworkPrefixLength());
                    o.put("iface", name);
                    out.put(o);
                }
            }
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("addresses", out);
        call.resolve(r);
    }
}
