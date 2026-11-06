package at.alpiplan.plugins.callhints;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.provider.ContactsContract.CommonDataKinds.Note;
import android.provider.ContactsContract.CommonDataKinds.Organization;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import android.provider.ContactsContract.CommonDataKinds.StructuredName;
import android.provider.ContactsContract.RawContacts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.HashSet;

@CapacitorPlugin(
    name = "AlpiplanDevice",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class AlpiplanDevicePlugin extends Plugin {

    private static final String DEFAULT_ORGANIZATION = "Alpiplan";
    private static final String GOOGLE_ACCOUNT_PREFIX = "com.google";
    private static final String[] LOCAL_PHONE_ACCOUNT_TYPES = new String[] {
        "vnd.sec.contact.phone",
        "com.android.huawei.phone",
        "com.android.localphone",
        "Local Phone Account",
    };
    private static final String NOTIFICATION_CHANNEL_ID = "alpiplan_appointments";
    private static final long SPEECH_RESTART_DELAY_MS = 120L;
    private static final long SPEECH_RECREATE_DELAY_MS = 220L;

    private SpeechRecognizer speechRecognizer;
    private boolean speechListening;
    private int speechGeneration;
    private int speechFailCount;
    private String lastPartial = "";
    private String speechLanguage = "de-DE";
    private ArrayList<String> speechHints = new ArrayList<>();
    private final Handler speechHandler = new Handler(Looper.getMainLooper());

    private boolean microphoneGranted() {
        return hasPermission(Manifest.permission.RECORD_AUDIO);
    }

    private boolean contactsGranted() {
        return hasPermission(Manifest.permission.READ_CONTACTS) && hasPermission(Manifest.permission.WRITE_CONTACTS);
    }

    private String jsPermissionState(String alias, boolean granted) {
        if (granted) {
            return PermissionState.GRANTED.toString();
        }
        try {
            PermissionState state = getPermissionState(alias);
            if (state != null) {
                return state.toString();
            }
        } catch (Exception ignored) {
            // Capacitor alias lookup can be null before the first prompt.
        }
        return PermissionState.PROMPT.toString();
    }

    @PluginMethod
    @Override
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        result.put("microphone", jsPermissionState("microphone", microphoneGranted()));
        result.put("contacts", jsPermissionState("contacts", contactsGranted()));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.put("notifications", PermissionState.GRANTED.toString());
        } else {
            result.put(
                "notifications",
                jsPermissionState("notifications", hasPermission(Manifest.permission.POST_NOTIFICATIONS))
            );
        }
        call.resolve(result);
    }

    @PluginMethod
    @Override
    public void requestPermissions(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null || alias.isEmpty()) {
            try {
                if (call.getData() != null && call.getData().has("permissions")) {
                    alias = call.getData().getJSONArray("permissions").optString(0, "");
                }
            } catch (Exception ignored) {
                alias = "";
            }
        }
        if (alias == null || alias.isEmpty()) {
            requestAllPermissions(call);
            return;
        }
        if ("contacts".equals(alias)) {
            if (contactsGranted()) {
                checkPermissions(call);
                return;
            }
            requestPermissionForAlias("contacts", call, "permissionsCallback");
            return;
        }
        if ("notifications".equals(alias)) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    || hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
                checkPermissions(call);
                return;
            }
            requestPermissionForAlias("notifications", call, "permissionsCallback");
            return;
        }
        if (microphoneGranted()) {
            checkPermissions(call);
            return;
        }
        requestPermissionForAlias("microphone", call, "permissionsCallback");
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        ArrayList<String> aliases = new ArrayList<>();
        if (!microphoneGranted()) {
            aliases.add("microphone");
        }
        if (!contactsGranted()) {
            aliases.add("contacts");
        }
        if (aliases.isEmpty()) {
            checkPermissions(call);
            return;
        }
        requestPermissionForAliases(aliases.toArray(new String[0]), call, "permissionsCallback");
    }

    @PluginMethod
    public void requestMicrophone(PluginCall call) {
        if (microphoneGranted()) {
            checkPermissions(call);
            return;
        }
        requestPermissionForAlias("microphone", call, "permissionsCallback");
    }

    @Override
    public void load() {
        ensureNotificationChannel();
    }

    @PluginMethod
    public void getPushToken(PluginCall call) {
        ensureNotificationChannel();
        try {
            Class<?> messagingClass = Class.forName("com.google.firebase.messaging.FirebaseMessaging");
            Object messaging = messagingClass.getMethod("getInstance").invoke(null);
            Object task = messagingClass.getMethod("getToken").invoke(messaging);
            Class<?> taskClass = Class.forName("com.google.android.gms.tasks.Task");
            java.lang.reflect.Method addListener = taskClass.getMethod(
                "addOnCompleteListener",
                Class.forName("com.google.android.gms.tasks.OnCompleteListener")
            );
            Object listener = java.lang.reflect.Proxy.newProxyInstance(
                taskClass.getClassLoader(),
                new Class<?>[] { Class.forName("com.google.android.gms.tasks.OnCompleteListener") },
                (proxy, method, args) -> {
                    if (!"onComplete".equals(method.getName()) || args == null || args.length < 1) {
                        return null;
                    }
                    Object completed = args[0];
                    JSObject result = new JSObject();
                    try {
                        boolean success = Boolean.TRUE.equals(taskClass.getMethod("isSuccessful").invoke(completed));
                        Object token = success ? taskClass.getMethod("getResult").invoke(completed) : null;
                        if (token != null) {
                            result.put("token", String.valueOf(token));
                        } else {
                            // Surface why FCM gave no token (SERVICE_NOT_AVAILABLE, FIS_AUTH_ERROR, ...).
                            Object exception = taskClass.getMethod("getException").invoke(completed);
                            String reason = exception == null ? "no token" : String.valueOf(exception);
                            android.util.Log.w("AlpiplanPush", "FCM token unavailable: " + reason);
                            result.put("error", reason);
                        }
                    } catch (Exception failure) {
                        // Resolve with the reason so the web layer can show it; in-app alerts keep working.
                        android.util.Log.w("AlpiplanPush", "FCM token lookup failed: " + failure);
                        result.put("error", String.valueOf(failure));
                    }
                    call.resolve(result);
                    return null;
                }
            );
            addListener.invoke(task, listener);
        } catch (Throwable failure) {
            // Typical in minified builds without keep rules: the reflected classes were renamed or removed.
            android.util.Log.w("AlpiplanPush", "Firebase Messaging not reachable via reflection: " + failure);
            JSObject result = new JSObject();
            result.put("error", "Firebase Messaging not available: " + failure);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void showLocalNotification(PluginCall call) {
        ensureNotificationChannel();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            call.resolve();
            return;
        }

        String title = call.getString("title", "Alpiplan");
        String body = call.getString("body", "");
        String id = call.getString("id");
        int notificationId = id != null && !id.isEmpty() ? id.hashCode() : (int) System.currentTimeMillis();

        Context context = getContext();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            call.resolve();
            return;
        }

        int icon = context.getApplicationInfo().icon;
        if (icon == 0) {
            icon = android.R.drawable.ic_popup_reminder;
        }

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(context, NOTIFICATION_CHANNEL_ID);
        } else {
            builder = new Notification.Builder(context);
        }

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
            }
            builder.setContentIntent(PendingIntent.getActivity(context, 0, launch, pendingFlags));
        }

        builder.setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setCategory(Notification.CATEGORY_EVENT);
        }
        manager.notify(notificationId, builder.build());
        call.resolve();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Termine",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Neue Termine in Alpiplan");
        manager.createNotificationChannel(channel);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openWhatsApp(PluginCall call) {
        String phone = call.getString("phone", "");
        String app = call.getString("app", "whatsapp");
        String digits = normalizeWhatsAppDigits(phone);
        if (digits.isEmpty()) {
            call.reject("Keine Telefonnummer");
            return;
        }
        String pkg = "business".equals(app) ? "com.whatsapp.w4b" : "com.whatsapp";
        Uri[] uris = new Uri[] {
            Uri.parse("whatsapp://send?phone=" + digits),
            Uri.parse("https://api.whatsapp.com/send?phone=" + digits),
            Uri.parse("https://wa.me/" + digits)
        };
        for (Uri uri : uris) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                intent.setPackage(pkg);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
                return;
            } catch (Exception ignored) {
                // Try the next URI.
            }
        }
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.setPackage(pkg);
            send.putExtra("jid", digits + "@s.whatsapp.net");
            send.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(send);
            call.resolve();
            return;
        } catch (Exception ignored) {
            // App missing or OEM blocked the intent.
        }
        String label = "business".equals(app) ? "WhatsApp Business" : "WhatsApp";
        call.reject(label + " ist nicht installiert");
    }

    private static String normalizeWhatsAppDigits(String phone) {
        if (phone == null) {
            return "";
        }
        String digits = phone.trim();
        if (digits.startsWith("00")) {
            digits = digits.substring(2);
        } else if (digits.startsWith("+")) {
            digits = digits.substring(1);
        }
        digits = digits.replaceAll("\\D", "");
        if (digits.startsWith("0") && digits.length() > 1) {
            digits = "43" + digits.substring(1);
        }
        return digits;
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        checkPermissions(call);
    }

    @PluginMethod
    public void saveLocalContact(PluginCall call) {
        if (!contactsGranted()) {
            requestPermissionForAlias("contacts", call, "saveContactAfterPermission");
            return;
        }
        insertLocalContact(call);
    }

    @PermissionCallback
    private void saveContactAfterPermission(PluginCall call) {
        if (!contactsGranted()) {
            call.reject("WRITE_CONTACTS permission denied");
            return;
        }
        insertLocalContact(call);
    }

    private void insertLocalContact(PluginCall call) {
        String displayName = call.getString("displayName", "").trim();
        if (displayName.isEmpty()) {
            displayName = "Alpiplan Kontakt";
        }
        String phone = emptyToNull(call.getString("phone"));
        String note = emptyToNull(call.getString("note"));
        String organization = emptyToNull(call.getString("organization"));
        if (organization == null) {
            organization = DEFAULT_ORGANIZATION;
        }

        if (phone != null) {
            PhoneContactMatch existing = firstMatchByPhone(phone);
            if (existing != null) {
                JSObject result = toContactResult(existing);
                result.put("existing", true);
                call.resolve(result);
                return;
            }
        }

        ArrayList<String[]> targets = new ArrayList<>();
        String[] localAccount = resolveLocalPhoneAccount();
        if (localAccount != null) {
            targets.add(localAccount);
        }
        targets.add(new String[] { null, null });
        String[] cloudAccount = resolveCloudDefaultAccount();
        if (cloudAccount != null) {
            targets.add(cloudAccount);
        }

        Exception lastError = null;
        for (String[] target : targets) {
            try {
                String contactId = applyInsert(displayName, phone, note, organization, target[0], target[1]);
                if (contactId == null) {
                    continue;
                }
                JSObject result = new JSObject();
                result.put("found", true);
                result.put("existing", false);
                result.put("contactId", contactId);
                result.put("displayName", displayName);
                result.put("accountType", target[1] == null ? "device" : target[1]);
                call.resolve(result);
                return;
            } catch (Exception exception) {
                lastError = exception;
            }
        }
        if (lastError != null) {
            call.reject("Failed to save local contact", lastError);
        } else {
            call.reject("Contact could not be saved locally");
        }
    }

    @PluginMethod
    public void findContactByPhone(PluginCall call) {
        if (!contactsGranted()) {
            JSObject result = new JSObject();
            result.put("found", false);
            call.resolve(result);
            return;
        }
        String phone = emptyToNull(call.getString("phone"));
        PhoneContactMatch match = phone == null ? null : firstMatchByPhone(phone);
        if (match == null) {
            JSObject result = new JSObject();
            result.put("found", false);
            call.resolve(result);
            return;
        }
        call.resolve(toContactResult(match));
    }

    @PluginMethod
    public void deleteContactByPhone(PluginCall call) {
        if (!contactsGranted()) {
            requestPermissionForAlias("contacts", call, "deleteContactAfterPermission");
            return;
        }
        performDeleteByPhone(call);
    }

    @PermissionCallback
    private void deleteContactAfterPermission(PluginCall call) {
        if (!contactsGranted()) {
            call.reject("WRITE_CONTACTS permission denied");
            return;
        }
        performDeleteByPhone(call);
    }

    private void performDeleteByPhone(PluginCall call) {
        String phone = emptyToNull(call.getString("phone"));
        if (phone == null) {
            call.reject("Keine Telefonnummer");
            return;
        }
        ArrayList<PhoneContactMatch> matches = lookupAllByPhone(phone);
        ContentResolver resolver = getContext().getContentResolver();
        int deleted = 0;
        for (PhoneContactMatch match : matches) {
            try {
                Uri contactUri = ContentUris.withAppendedId(
                    ContactsContract.Contacts.CONTENT_URI,
                    Long.parseLong(match.contactId)
                );
                deleted += resolver.delete(contactUri, null, null);
            } catch (Exception ignored) {
                // Skip rows the OEM refuses to delete.
            }
        }
        JSObject result = new JSObject();
        result.put("deleted", deleted);
        call.resolve(result);
    }

    private static class PhoneContactMatch {
        String contactId;
        String displayName;
        boolean googleSynced;
    }

    private JSObject toContactResult(PhoneContactMatch match) {
        JSObject result = new JSObject();
        result.put("found", true);
        result.put("contactId", match.contactId);
        if (match.displayName != null && !match.displayName.isEmpty()) {
            result.put("displayName", match.displayName);
        }
        result.put("googleSynced", match.googleSynced);
        return result;
    }

    private PhoneContactMatch firstMatchByPhone(String phone) {
        ArrayList<PhoneContactMatch> matches = lookupAllByPhone(phone);
        return matches.isEmpty() ? null : matches.get(0);
    }

    private ArrayList<PhoneContactMatch> lookupAllByPhone(String phone) {
        ArrayList<PhoneContactMatch> matches = new ArrayList<>();
        if (phone == null || phone.trim().isEmpty()) {
            return matches;
        }
        Uri uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(phone.trim())
        );
        String[] projection = new String[] {
            ContactsContract.PhoneLookup._ID,
            ContactsContract.PhoneLookup.DISPLAY_NAME
        };
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor cursor = resolver.query(uri, projection, null, null, null)) {
            if (cursor == null) {
                return matches;
            }
            HashSet<String> seen = new HashSet<>();
            int idIdx = cursor.getColumnIndex(ContactsContract.PhoneLookup._ID);
            int nameIdx = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME);
            while (cursor.moveToNext()) {
                if (idIdx < 0) {
                    continue;
                }
                String contactId = cursor.getString(idIdx);
                if (contactId == null || !seen.add(contactId)) {
                    continue;
                }
                PhoneContactMatch match = new PhoneContactMatch();
                match.contactId = contactId;
                match.displayName = nameIdx >= 0 ? cursor.getString(nameIdx) : null;
                match.googleSynced = isGoogleSynced(resolver, contactId);
                matches.add(match);
            }
        } catch (Exception ignored) {
            // Missing permission or OEM lookup quirks — treat as not found.
        }
        return matches;
    }

    private boolean isGoogleSynced(ContentResolver resolver, String contactId) {
        try (Cursor cursor = resolver.query(
            RawContacts.CONTENT_URI,
            new String[] { RawContacts.ACCOUNT_TYPE },
            RawContacts.CONTACT_ID + "=?",
            new String[] { contactId },
            null
        )) {
            if (cursor == null) {
                return false;
            }
            int typeIdx = cursor.getColumnIndex(RawContacts.ACCOUNT_TYPE);
            while (cursor.moveToNext()) {
                String type = typeIdx >= 0 ? cursor.getString(typeIdx) : null;
                if (type != null && type.startsWith(GOOGLE_ACCOUNT_PREFIX)) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            return false;
        }
        return false;
    }

    private String applyInsert(
        String displayName,
        String phone,
        String note,
        String organization,
        String accountName,
        String accountType
    ) throws Exception {
        ArrayList<ContentProviderOperation> ops = new ArrayList<>();
        // A null account means "device only"; some OEMs still remap it to their default account.
        ops.add(
            ContentProviderOperation.newInsert(RawContacts.CONTENT_URI)
                .withValue(RawContacts.ACCOUNT_NAME, accountName)
                .withValue(RawContacts.ACCOUNT_TYPE, accountType)
                .build()
        );

        ops.add(
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
                .withValue(StructuredName.GIVEN_NAME, displayName)
                .build()
        );

        ops.add(
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, Organization.CONTENT_ITEM_TYPE)
                .withValue(Organization.COMPANY, organization)
                .withValue(Organization.TITLE, "Alpiplan-App")
                .build()
        );

        if (note != null) {
            ops.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, Note.CONTENT_ITEM_TYPE)
                    .withValue(Note.NOTE, note)
                    .build()
            );
        }

        if (phone != null) {
            ops.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
                    .withValue(Phone.TYPE, Phone.TYPE_MOBILE)
                    .withValue(Phone.NUMBER, phone)
                    .withValue(Phone.IS_PRIMARY, 1)
                    .build()
            );
        }

        ContentResolver resolver = getContext().getContentResolver();
        ContentProviderResult[] result = resolver.applyBatch(ContactsContract.AUTHORITY, ops);
        if (result == null || result.length == 0 || result[0] == null || result[0].uri == null) {
            return null;
        }
        return result[0].uri.getLastPathSegment();
    }

    /**
     * Returns the OEM "phone" account (e.g. Samsung "Telefon") if the contacts provider
     * already holds contacts in it. Accounts without a registered authenticator or with
     * foreign sync adapters get wiped or hidden, so only known device-local types qualify.
     */
    private String[] resolveLocalPhoneAccount() {
        ContentResolver resolver = getContext().getContentResolver();
        for (String type : LOCAL_PHONE_ACCOUNT_TYPES) {
            try (Cursor cursor = resolver.query(
                RawContacts.CONTENT_URI,
                new String[] { RawContacts.ACCOUNT_NAME },
                RawContacts.ACCOUNT_TYPE + "=? AND " + RawContacts.DELETED + "=0",
                new String[] { type },
                null
            )) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    return new String[] { name, type };
                }
            } catch (Exception ignored) {
                // Try the next known type.
            }
        }
        return null;
    }

    /**
     * Android 16+ rejects inserts into local/SIM accounts while the user's default contacts
     * account is a cloud account, so that account is the only remaining target.
     */
    private String[] resolveCloudDefaultAccount() {
        if (Build.VERSION.SDK_INT < 36) {
            return null;
        }
        try {
            RawContacts.DefaultAccount.DefaultAccountAndState state =
                RawContacts.DefaultAccount.getDefaultAccountForNewContacts(getContext().getContentResolver());
            if (state == null
                    || state.getState() != RawContacts.DefaultAccount.DefaultAccountAndState.DEFAULT_ACCOUNT_STATE_CLOUD
                    || state.getAccount() == null) {
                return null;
            }
            return new String[] { state.getAccount().name, state.getAccount().type };
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String emptyToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    @PluginMethod
    public void startSpeechRecognition(PluginCall call) {
        String lang = call.getString("lang", "de-DE");
        if (lang != null && !lang.isEmpty()) {
            speechLanguage = lang;
        }
        speechHints = new ArrayList<>();
        JSArray hints = call.getArray("hints");
        if (hints != null) {
            for (int i = 0; i < hints.length(); i += 1) {
                try {
                    String hint = hints.getString(i);
                    if (hint != null && !hint.trim().isEmpty()) {
                        speechHints.add(hint.trim());
                    }
                } catch (Exception ignored) {
                    // Skip malformed entries.
                }
            }
        }
        getActivity().runOnUiThread(() -> {
            try {
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    call.reject("Spracherkennung ist auf diesem Gerät nicht verfügbar");
                    return;
                }
                speechListening = true;
                speechFailCount = 0;
                startSpeechListening();
                call.resolve();
            } catch (Exception exception) {
                speechListening = false;
                call.reject("Spracherkennung konnte nicht gestartet werden", exception);
            }
        });
    }

    @PluginMethod
    public void stopSpeechRecognition(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            stopSpeechInternal();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        speechHandler.post(this::stopSpeechInternal);
        super.handleOnDestroy();
    }

    private void startSpeechListening() {
        if (!speechListening) {
            return;
        }
        lastPartial = "";
        if (speechRecognizer == null) {
            speechGeneration += 1;
            final int generation = speechGeneration;
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            speechRecognizer.setRecognitionListener(createSpeechListener(generation));
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, speechLanguage);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, speechLanguage);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !speechHints.isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, speechHints);
        }
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        try {
            speechRecognizer.startListening(intent);
        } catch (Exception exception) {
            scheduleSpeechRestart(true);
        }
    }

    private void scheduleSpeechRestart() {
        scheduleSpeechRestart(false);
    }

    private void scheduleSpeechRestart(boolean recreate) {
        speechHandler.removeCallbacksAndMessages(null);
        long delay = recreate ? SPEECH_RECREATE_DELAY_MS : SPEECH_RESTART_DELAY_MS;
        speechHandler.postDelayed(() -> {
            if (!speechListening) {
                return;
            }
            if (recreate) {
                destroyRecognizerQuietly();
            }
            startSpeechListening();
        }, delay);
    }

    private void stopSpeechInternal() {
        speechListening = false;
        speechGeneration += 1;
        speechHandler.removeCallbacksAndMessages(null);
        lastPartial = "";
        destroyRecognizerQuietly();
    }

    private void destroyRecognizerQuietly() {
        if (speechRecognizer == null) {
            return;
        }
        try {
            speechRecognizer.setRecognitionListener(null);
        } catch (Exception ignored) {
            // ignore
        }
        try {
            speechRecognizer.cancel();
        } catch (Exception ignored) {
            // ignore
        }
        try {
            speechRecognizer.destroy();
        } catch (Exception ignored) {
            // ignore
        }
        speechRecognizer = null;
    }

    private void emitTranscript(String transcript, boolean isFinal) {
        emitTranscript(transcript, null, isFinal);
    }

    private void emitTranscript(String transcript, ArrayList<String> alternatives, boolean isFinal) {
        if (transcript == null) {
            return;
        }
        String trimmed = transcript.trim();
        if (trimmed.isEmpty()) {
            return;
        }
        JSObject payload = new JSObject();
        payload.put("transcript", trimmed);
        if (alternatives != null && alternatives.size() > 1) {
            JSArray list = new JSArray();
            for (String alternative : alternatives) {
                if (alternative != null && !alternative.trim().isEmpty()) {
                    list.put(alternative.trim());
                }
            }
            payload.put("alternatives", list);
        }
        payload.put("isFinal", isFinal);
        notifyListeners("speechTranscript", payload);
    }

    private void emitSessionEnd() {
        notifyListeners("speechSessionEnd", new JSObject());
    }

    private static String bestTranscript(ArrayList<String> matches) {
        if (matches == null || matches.isEmpty() || matches.get(0) == null) {
            return "";
        }
        return matches.get(0).trim();
    }

    private RecognitionListener createSpeechListener(int generation) {
        return new RecognitionListener() {
            private boolean alive() {
                return speechListening && generation == speechGeneration;
            }

            @Override
            public void onReadyForSpeech(Bundle params) {}

            @Override
            public void onBeginningOfSpeech() {}

            @Override
            public void onRmsChanged(float rmsdB) {}

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {}

            @Override
            public void onError(int error) {
                if (!alive()) {
                    return;
                }
                if (!lastPartial.isEmpty()) {
                    emitTranscript(lastPartial, true);
                    lastPartial = "";
                }
                emitSessionEnd();
                boolean permissionDenied = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS;
                boolean staleService =
                    error == SpeechRecognizer.ERROR_CLIENT
                        || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY
                        || error == SpeechRecognizer.ERROR_SERVER
                        || error == SpeechRecognizer.ERROR_NETWORK
                        || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT;
                if (error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) {
                    staleService = true;
                }
                boolean recoverable =
                    staleService
                        || error == SpeechRecognizer.ERROR_NO_MATCH
                        || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
                if (permissionDenied) {
                    JSObject payload = new JSObject();
                    payload.put("message", speechErrorMessage(error));
                    notifyListeners("speechError", payload);
                    return;
                }
                if (recoverable) {
                    speechFailCount = 0;
                } else {
                    speechFailCount += 1;
                    if (speechFailCount >= 3) {
                        JSObject payload = new JSObject();
                        payload.put("message", speechErrorMessage(error));
                        notifyListeners("speechError", payload);
                    }
                }
                scheduleSpeechRestart(staleService);
            }

            @Override
            public void onResults(Bundle results) {
                if (!alive()) {
                    return;
                }
                speechFailCount = 0;
                ArrayList<String> matches =
                    results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String transcript = bestTranscript(matches);
                lastPartial = "";
                emitTranscript(transcript, matches, true);
                emitSessionEnd();
                if (speechListening) {
                    scheduleSpeechRestart();
                }
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                if (!alive()) {
                    return;
                }
                ArrayList<String> matches =
                    partialResults == null
                        ? null
                        : partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String transcript = bestTranscript(matches);
                if (transcript.isEmpty()) {
                    return;
                }
                lastPartial = transcript;
                emitTranscript(transcript, false);
            }

            @Override
            public void onEvent(int eventType, Bundle params) {}
        };
    }

    private static String speechErrorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "Mikrofonfehler bei der Spracherkennung.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "Mikrofon-Zugriff verweigert – bitte in den App-Einstellungen erlauben.";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "Spracherkennung braucht eine Internetverbindung.";
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "Sprachdienst nicht erreichbar.";
            default:
                return "Spracherkennung fehlgeschlagen.";
        }
    }
}
