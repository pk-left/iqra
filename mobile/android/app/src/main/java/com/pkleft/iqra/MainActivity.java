package com.pkleft.iqra;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IqraNativePlugin.class);
        registerPlugin(PkNetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
