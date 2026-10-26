package at.alpiplan.plugins.widget;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

final class WidgetUiBinder {
    private WidgetUiBinder() {}

    static void bindRows(
        Context context, RemoteViews views, int appWidgetId, JSONArray appointments, WidgetSizeProfile size) {
        int maxRows = Math.min(size.visibleRows, WidgetConfig.VISIBLE_ROWS);
        int count = Math.min(appointments.length(), maxRows);
        String callLabel =
            size.compactLabels ? context.getString(R.string.widget_call_compact) : context.getString(R.string.widget_call);
        for (int index = 0; index < WidgetRowIds.ROWS.length; index++) {
            WidgetRowIds ids = WidgetRowIds.ROWS[index];
            if (index >= count) {
                views.setViewVisibility(ids.row, View.GONE);
                continue;
            }
            JSONObject item = appointments.optJSONObject(index);
            if (item == null) {
                views.setViewVisibility(ids.row, View.GONE);
                continue;
            }
            views.setViewVisibility(ids.row, View.VISIBLE);
            String timeLabel = item.optString("timeLabel", "");
            String teachers = item.optString("teachers", "").trim();
            views.setTextViewText(ids.time, teachers.isEmpty() ? timeLabel : timeLabel + " · " + teachers);
            views.setTextViewText(ids.title, item.optString("title", "Termin"));
            views.setTextViewText(ids.call, callLabel);

            String appointmentId = item.optString("id");
            String phone = item.optString("phone", "").trim();
            String status = item.optString("status", "");
            boolean hasPhone = !phone.isEmpty();
            boolean canComplete = !"completed".equals(status) && !"cancelled".equals(status);

            views.setViewVisibility(ids.call, hasPhone ? View.VISIBLE : View.GONE);
            views.setViewVisibility(ids.whatsapp, hasPhone ? View.VISIBLE : View.GONE);
            views.setViewVisibility(ids.complete, canComplete ? View.VISIBLE : View.GONE);

            if (hasPhone) {
                views.setOnClickPendingIntent(
                    ids.call,
                    actionPendingIntent(context, appWidgetId, appointmentId, WidgetActionReceiver.ACTION_CALL, index * 3));
                views.setOnClickPendingIntent(
                    ids.whatsapp,
                    actionPendingIntent(context, appWidgetId, appointmentId, WidgetActionReceiver.ACTION_WHATSAPP, index * 3 + 1));
            }
            if (canComplete) {
                views.setOnClickPendingIntent(
                    ids.complete,
                    actionPendingIntent(context, appWidgetId, appointmentId, WidgetActionReceiver.ACTION_COMPLETE, index * 3 + 2));
            }
        }
    }

    private static PendingIntent actionPendingIntent(
        Context context, int appWidgetId, String appointmentId, String action, int requestCode) {
        Intent intent = new Intent(context, WidgetActionReceiver.class);
        intent.setAction(WidgetActionReceiver.ACTION_ITEM);
        intent.putExtra(WidgetActionReceiver.EXTRA_APPOINTMENT_ID, appointmentId);
        intent.putExtra(WidgetActionReceiver.EXTRA_ACTION, action);
        return PendingIntent.getBroadcast(
            context,
            appWidgetId * 100 + requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
