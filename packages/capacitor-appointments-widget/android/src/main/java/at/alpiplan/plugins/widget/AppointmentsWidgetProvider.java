package at.alpiplan.plugins.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;

public class AppointmentsWidgetProvider extends AppWidgetProvider {

    static void requestUpdateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, AppointmentsWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(component);
        if (ids.length == 0) {
            return;
        }
        Intent intent = new Intent(context, AppointmentsWidgetProvider.class);
        intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        context.sendBroadcast(intent);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int appWidgetId, Bundle newOptions) {
        updateWidget(context, manager, appWidgetId);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        if (WidgetStore.isConfigured(context)) {
            PendingResult pendingResult = goAsync();
            new Thread(
                    () -> {
                        try {
                            WidgetApiClient.fetchUpcoming(context);
                            for (int appWidgetId : appWidgetIds) {
                                updateWidget(context, manager, appWidgetId);
                            }
                        } finally {
                            pendingResult.finish();
                        }
                    })
                .start();
            return;
        }
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, manager, appWidgetId);
        }
    }

    static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_appointments);
        WidgetSizeProfile size = WidgetSizeProfile.forWidget(context, manager, appWidgetId);
        WidgetTheme.apply(context, views);
        size.applyTextSizes(views);
        size.applyRootPadding(context, views);
        if (size.compactLabels) {
            views.setTextViewText(R.id.widget_refresh, context.getString(R.string.widget_refresh_compact));
        } else {
            views.setTextViewText(R.id.widget_refresh, context.getString(R.string.widget_refresh));
        }
        JSONArray appointments = WidgetStore.appointments(context);
        boolean configured = WidgetStore.isConfigured(context);

        if (!configured) {
            views.setTextViewText(R.id.widget_empty, context.getString(R.string.widget_login));
            views.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            views.setViewVisibility(R.id.widget_rows, View.GONE);
        } else if (appointments.length() == 0) {
            views.setTextViewText(R.id.widget_empty, context.getString(R.string.widget_empty));
            views.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            views.setViewVisibility(R.id.widget_rows, View.GONE);
        } else {
            views.setViewVisibility(R.id.widget_empty, View.GONE);
            views.setViewVisibility(R.id.widget_rows, View.VISIBLE);
            WidgetUiBinder.bindRows(context, views, appWidgetId, appointments, size);
        }

        PendingIntent refreshPendingIntent =
            PendingIntent.getBroadcast(
                context,
                appWidgetId + 10_000,
                WidgetActionReceiver.refreshIntent(context),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_refresh, refreshPendingIntent);

        PendingIntent openAppPendingIntent =
            PendingIntent.getActivity(
                context,
                appWidgetId + 20_000,
                context.getPackageManager().getLaunchIntentForPackage(context.getPackageName()),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_title, openAppPendingIntent);

        manager.updateAppWidget(appWidgetId, views);
    }
}
