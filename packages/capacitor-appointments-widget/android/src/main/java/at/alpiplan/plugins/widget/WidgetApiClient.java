package at.alpiplan.plugins.widget;

import android.content.Context;
import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

final class WidgetApiClient {
    private static final String TAG = "AlpiplanWidget";

    private WidgetApiClient() {}

    static JSONArray fetchUpcoming(Context context) {
        if (!WidgetStore.isConfigured(context)) {
            return new JSONArray();
        }
        String tenantId = WidgetStore.tenantId(context);
        String base = WidgetStore.apiBaseUrl(context).replaceAll("/+$", "");
        String cookies = WidgetStore.cookies(context);
        if (tenantId.isEmpty() || base.isEmpty()) {
            return new JSONArray();
        }
        long now = System.currentTimeMillis();
        long window = WidgetConfig.APPOINTMENT_WINDOW_DAYS * 24L * 60 * 60 * 1000;
        long from = now - window;
        long horizon = now + window;
        String query =
            base
                + "/api/v1/tenants/"
                + tenantId
                + "/appointments?from="
                + java.net.URLEncoder.encode(isoUtc(from), StandardCharsets.UTF_8)
                + "&to="
                + java.net.URLEncoder.encode(isoUtc(horizon), StandardCharsets.UTF_8)
                + "&status=draft,confirmed&pageSize=200&sort=asc";
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(query).openConnection();
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(12_000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            if (cookies != null && !cookies.isEmpty()) {
                connection.setRequestProperty("Cookie", cookies);
            }
            int code = connection.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
            String body = readStream(stream);
            connection.disconnect();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "fetch failed HTTP " + code);
                return WidgetStore.appointments(context);
            }
            JSONObject json = new JSONObject(body);
            JSONArray data = json.optJSONArray("data");
            if (data == null) {
                return WidgetStore.appointments(context);
            }
            boolean showTeachers = WidgetStore.showTeachers(context);
            JSONArray widgetRows = new JSONArray();
            for (int i = 0; i < data.length() && widgetRows.length() < WidgetConfig.MAX_APPOINTMENTS; i++) {
                JSONObject item = data.optJSONObject(i);
                if (item == null || !isVisibleAppointment(item, now)) {
                    continue;
                }
                widgetRows.put(toWidgetRow(item, showTeachers));
            }
            WidgetStore.replaceAppointments(context, widgetRows);
            return widgetRows;
        } catch (Exception exception) {
            Log.w(TAG, "fetch upcoming failed", exception);
            return WidgetStore.appointments(context);
        }
    }

    private static boolean isVisibleAppointment(JSONObject item, long now) {
        String status = item.optString("status", "");
        if (!"draft".equals(status) && !"confirmed".equals(status)) {
            return false;
        }
        if ("confirmed".equals(status)) {
            return true;
        }
        try {
            return java.time.Instant.parse(item.optString("startsAt")).toEpochMilli() >= now;
        } catch (java.time.format.DateTimeParseException exception) {
            Log.w(TAG, "skipping appointment with invalid start time");
            return false;
        }
    }

    static boolean markCompleted(Context context, String appointmentId, int version) {
        if (!WidgetStore.isConfigured(context)) {
            return false;
        }
        String tenantId = WidgetStore.tenantId(context);
        String base = WidgetStore.apiBaseUrl(context).replaceAll("/+$", "");
        String cookies = WidgetStore.cookies(context);
        String url = base + "/api/v1/tenants/" + tenantId + "/appointments/" + appointmentId;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(12_000);
            connection.setRequestMethod("PATCH");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("If-Match", String.valueOf(version));
            if (cookies != null && !cookies.isEmpty()) {
                connection.setRequestProperty("Cookie", cookies);
            }
            byte[] payload = "{\"status\":\"completed\"}".getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload);
            }
            int code = connection.getResponseCode();
            connection.disconnect();
            return code >= 200 && code < 300;
        } catch (Exception exception) {
            Log.w(TAG, "mark completed failed", exception);
            return false;
        }
    }

    private static JSONObject toWidgetRow(JSONObject item, boolean showTeachers) throws org.json.JSONException {
        JSONObject row = new JSONObject();
        row.put("id", item.optString("id"));
        row.put("version", item.optInt("version", 1));
        row.put("status", item.optString("status"));
        row.put("startsAt", item.optString("startsAt"));
        row.put("title", resolveTitle(item));
        row.put("phone", resolvePhone(item));
        row.put("timeLabel", formatTimeLabel(item.optString("startsAt")));
        if (showTeachers) {
            row.put("teachers", resolveTeachers(item));
        }
        return row;
    }

    private static String resolveTeachers(JSONObject item) {
        StringBuilder names = new StringBuilder();
        JSONArray teachers = item.optJSONArray("teachers");
        if (teachers != null) {
            for (int i = 0; i < teachers.length(); i++) {
                JSONObject teacher = teachers.optJSONObject(i);
                String name = teacher == null ? "" : teacher.optString("displayName", "").trim();
                if (name.isEmpty()) {
                    continue;
                }
                if (names.length() > 0) {
                    names.append(", ");
                }
                names.append(name);
            }
        }
        if (names.length() == 0) {
            JSONObject teacher = item.optJSONObject("teacher");
            if (teacher != null) {
                names.append(teacher.optString("displayName", "").trim());
            }
        }
        return names.toString();
    }

    private static String resolveTitle(JSONObject item) {
        JSONObject customer = item.optJSONObject("customer");
        if (customer != null) {
            String name = customer.optString("displayName", "").trim();
            if (!name.isEmpty()) {
                return name;
            }
        }
        String contact = item.optString("appointmentContactText", "").trim();
        if (!contact.isEmpty()) {
            return contact;
        }
        return "Termin";
    }

    private static String resolvePhone(JSONObject item) {
        String e164 = item.optString("appointmentPhoneE164", "").trim();
        if (!e164.isEmpty()) {
            return e164;
        }
        String raw = item.optString("appointmentPhoneRaw", "").trim();
        if (!raw.isEmpty()) {
            return raw;
        }
        JSONObject customer = item.optJSONObject("customer");
        if (customer == null) {
            return null;
        }
        JSONArray phones = customer.optJSONArray("phones");
        if (phones == null) {
            return null;
        }
        for (int i = 0; i < phones.length(); i++) {
            JSONObject phone = phones.optJSONObject(i);
            if (phone == null) {
                continue;
            }
            String primaryE164 = phone.optString("e164", "").trim();
            if (!primaryE164.isEmpty()) {
                return primaryE164;
            }
        }
        for (int i = 0; i < phones.length(); i++) {
            JSONObject phone = phones.optJSONObject(i);
            if (phone == null) {
                continue;
            }
            String primaryRaw = phone.optString("raw", "").trim();
            if (!primaryRaw.isEmpty()) {
                return primaryRaw;
            }
        }
        return null;
    }

    private static String formatTimeLabel(String startsAt) {
        try {
            java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            String normalized = startsAt.replace("Z", "").replaceAll("\\.\\d+", "");
            java.util.Date date = iso.parse(normalized.substring(0, Math.min(normalized.length(), 19)));
            if (date == null) {
                return startsAt;
            }
            java.text.SimpleDateFormat out =
                new java.text.SimpleDateFormat("EEE dd.MM. HH:mm", new java.util.Locale("de", "DE"));
            out.setTimeZone(java.util.TimeZone.getDefault());
            return out.format(date);
        } catch (Exception ignored) {
            return startsAt;
        }
    }

    private static String isoUtc(long millis) {
        java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return iso.format(new java.util.Date(millis));
    }

    private static String readStream(InputStream stream) throws java.io.IOException {
        if (stream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }
}
