package at.alpiplan.plugins.widget;

import android.webkit.CookieManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import org.json.JSONArray;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppointmentsWidget")
public class AppointmentsWidgetPlugin extends Plugin {

    @PluginMethod
    public void sync(PluginCall call) {
        String tenantId = call.getString("tenantId");
        String apiBaseUrl = call.getString("apiBaseUrl");
        JSArray appointments = call.getArray("appointments");
        if (tenantId == null || tenantId.isEmpty() || apiBaseUrl == null || apiBaseUrl.isEmpty() || appointments == null) {
            call.reject("tenantId, apiBaseUrl and appointments are required");
            return;
        }
        String base = apiBaseUrl.replaceAll("/+$", "");
        CookieManager.getInstance().flush();
        String cookies = CookieManager.getInstance().getCookie(base);
        JSONArray serialized = new JSONArray();
        for (int i = 0; i < appointments.length(); i++) {
            serialized.put(appointments.opt(i));
        }
        boolean darkMode = call.getBoolean("darkMode", false);
        String whatsAppApp = call.getString("whatsAppApp", "whatsapp");
        String uiScale = call.getString("uiScale", "small");
        boolean showTeachers = call.getBoolean("showTeachers", false);
        WidgetStore.save(
            getContext(), tenantId, base, cookies, serialized.toString(), darkMode, whatsAppApp, uiScale, showTeachers);
        AppointmentsWidgetProvider.requestUpdateAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        WidgetStore.clear(getContext());
        AppointmentsWidgetProvider.requestUpdateAll(getContext());
        call.resolve();
    }
}
