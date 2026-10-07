package id.anatta.pos;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PosHardwarePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
