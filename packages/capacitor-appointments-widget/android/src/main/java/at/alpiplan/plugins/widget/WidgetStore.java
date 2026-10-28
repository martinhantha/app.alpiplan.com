package at.alpiplan.plugins.widget;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

final class WidgetStore {
    private static final String PREFS = "alpiplan_appointments_widget";
    private static final String KEY_TENANT = "tenantId";
    private static final String KEY_BASE = "apiBaseUrl";
    private static final String KEY_COOKIES = "cookies";
    private static final String KEY_APPOINTMENTS = "appointments";
    private static final String KEY_DARK_MODE = "darkMode";
    private static final String KEY_WHATSAPP_APP = "whatsAppApp";
    private static final String KEY_UI_SCALE = "uiScale";
    private static final String KEY_SHOW_TEACHERS = "showTeachers";

    private WidgetStore() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void save(
        Context context,
        String tenantId,
        String apiBaseUrl,
        String cookies,
        String appointmentsJson,
        boolean darkMode,
        String whatsAppApp,
        String uiScale,
        boolean showTeachers) {
        prefs(context)
            .edit()
            .putString(KEY_TENANT, tenantId)
            .putString(KEY_BASE, apiBaseUrl)
            .putString(KEY_COOKIES, cookies == null ? "" : cookies)
            .putString(KEY_APPOINTMENTS, trimAppointmentsJson(appointmentsJson))
            .putBoolean(KEY_DARK_MODE, darkMode)
            .putString(KEY_WHATSAPP_APP, "business".equals(whatsAppApp) ? "business" : "whatsapp")
            .putString(KEY_UI_SCALE, normalizeUiScale(uiScale))
            .putBoolean(KEY_SHOW_TEACHERS, showTeachers)
            .apply();
    }

    static boolean showTeachers(Context context) {
        return prefs(context).getBoolean(KEY_SHOW_TEACHERS, false);
    }

    static String uiScale(Context context) {
        return normalizeUiScale(prefs(context).getString(KEY_UI_SCALE, "small"));
    }

    private static String normalizeUiScale(String value) {
        if ("medium".equals(value) || "large".equals(value)) {
            return value;
        }
        return "small";
    }

    static boolean hasDarkModePreference(Context context) {
        return prefs(context).contains(KEY_DARK_MODE);
    }

    static boolean darkMode(Context context) {
        return prefs(context).getBoolean(KEY_DARK_MODE, false);
    }

    static String whatsAppApp(Context context) {
        return prefs(context).getString(KEY_WHATSAPP_APP, "whatsapp");
    }

    private static String trimAppointmentsJson(String appointmentsJson) {
        try {
            JSONArray list = new JSONArray(appointmentsJson);
            JSONArray trimmed = new JSONArray();
            for (int i = 0; i < list.length() && trimmed.length() < WidgetConfig.MAX_APPOINTMENTS; i++) {
                trimmed.put(list.get(i));
            }
            return trimmed.toString();
        } catch (Exception ignored) {
            return "[]";
        }
    }

    static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    static boolean isConfigured(Context context) {
        String tenant = prefs(context).getString(KEY_TENANT, "");
        String base = prefs(context).getString(KEY_BASE, "");
        return tenant != null && !tenant.isEmpty() && base != null && !base.isEmpty();
    }

    static String tenantId(Context context) {
        return prefs(context).getString(KEY_TENANT, "");
    }

    static String apiBaseUrl(Context context) {
        return prefs(context).getString(KEY_BASE, "");
    }

    static String cookies(Context context) {
        return prefs(context).getString(KEY_COOKIES, "");
    }

    static JSONArray appointments(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_APPOINTMENTS, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    static JSONObject appointmentById(Context context, String id) {
        JSONArray list = appointments(context);
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && id.equals(item.optString("id"))) {
                return item;
            }
        }
        return null;
    }

    static void removeAppointment(Context context, String id) {
        JSONArray list = appointments(context);
        JSONArray next = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item == null || id.equals(item.optString("id"))) {
                continue;
            }
            next.put(item);
        }
        prefs(context).edit().putString(KEY_APPOINTMENTS, next.toString()).apply();
    }

    static void replaceAppointments(Context context, JSONArray appointments) {
        prefs(context).edit().putString(KEY_APPOINTMENTS, appointments.toString()).apply();
    }
}
