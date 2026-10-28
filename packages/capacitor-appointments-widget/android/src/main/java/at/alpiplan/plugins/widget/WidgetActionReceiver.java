package at.alpiplan.plugins.widget;

import android.appwidget.AppWidgetManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;
import org.json.JSONObject;

public class WidgetActionReceiver extends BroadcastReceiver {
    static final String ACTION_ITEM = "at.alpiplan.widget.ACTION_ITEM";
    static final String ACTION_REFRESH = "at.alpiplan.widget.ACTION_REFRESH";
    static final String EXTRA_APPOINTMENT_ID = "appointmentId";
    static final String EXTRA_ACTION = "widgetAction";
    static final String ACTION_CALL = "call";
    static final String ACTION_COMPLETE = "complete";
    static final String ACTION_WHATSAPP = "whatsapp";

    static Intent refreshIntent(Context context) {
        Intent intent = new Intent(context, WidgetActionReceiver.class);
        intent.setAction(ACTION_REFRESH);
        return intent;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        String action = intent.getAction();
        if (ACTION_REFRESH.equals(action)) {
            refreshAsync(context);
            return;
        }
        if (!ACTION_ITEM.equals(action)) {
            return;
        }
        String appointmentId = intent.getStringExtra(EXTRA_APPOINTMENT_ID);
        String widgetAction = intent.getStringExtra(EXTRA_ACTION);
        if (appointmentId == null || widgetAction == null) {
            return;
        }
        if (ACTION_CALL.equals(widgetAction)) {
            handleCall(context, appointmentId);
            return;
        }
        if (ACTION_WHATSAPP.equals(widgetAction)) {
            handleWhatsApp(context, appointmentId);
            return;
        }
        if (ACTION_COMPLETE.equals(widgetAction)) {
            completeAsync(context, appointmentId);
        }
    }

    private void handleWhatsApp(Context context, String appointmentId) {
        JSONObject item = WidgetStore.appointmentById(context, appointmentId);
        if (item == null) {
            return;
        }
        String phone = item.optString("phone", "").trim();
        if (phone.isEmpty()) {
            return;
        }
        WhatsAppIntents.open(context.getApplicationContext(), phone, WidgetStore.whatsAppApp(context));
    }

    private void handleCall(Context context, String appointmentId) {
        JSONObject item = WidgetStore.appointmentById(context, appointmentId);
        if (item == null) {
            return;
        }
        String phone = item.optString("phone", "").trim();
        if (phone.isEmpty()) {
            return;
        }
        String dial = phone.replaceAll("[^\\d+]", "");
        Intent dialIntent = new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", dial, null));
        dialIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(dialIntent);
    }

    private void completeAsync(Context context, String appointmentId) {
        Context app = context.getApplicationContext();
        new Thread(
                () -> {
                    JSONObject item = WidgetStore.appointmentById(app, appointmentId);
                    if (item == null) {
                        return;
                    }
                    int version = item.optInt("version", 1);
                    boolean ok = WidgetApiClient.markCompleted(app, appointmentId, version);
                    if (ok) {
                        WidgetStore.removeAppointment(app, appointmentId);
                    } else {
                        WidgetApiClient.fetchUpcoming(app);
                    }
                    AppointmentsWidgetProvider.requestUpdateAll(app);
                    if (!ok) {
                        Toast.makeText(app, "Termin konnte nicht abgehakt werden", Toast.LENGTH_SHORT).show();
                    }
                })
            .start();
    }

    private void refreshAsync(Context context) {
        Context app = context.getApplicationContext();
        PendingResult pendingResult = goAsync();
        new Thread(
                () -> {
                    try {
                        if (WidgetStore.isConfigured(app)) {
                            WidgetApiClient.fetchUpcoming(app);
                        }
                        AppWidgetManager manager = AppWidgetManager.getInstance(app);
                        ComponentName component = new ComponentName(app, AppointmentsWidgetProvider.class);
                        int[] ids = manager.getAppWidgetIds(component);
                        for (int id : ids) {
                            AppointmentsWidgetProvider.updateWidget(app, manager, id);
                        }
                    } finally {
                        pendingResult.finish();
                    }
                })
            .start();
    }
}
