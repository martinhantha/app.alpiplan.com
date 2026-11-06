# AlpiplanDevicePlugin.getPushToken reaches Firebase Cloud Messaging via reflection so the
# plugin compiles without a Firebase dependency. R8 cannot see those references; without
# these rules a minified release build strips or renames the classes and no token is issued.
-keep class com.google.firebase.messaging.FirebaseMessaging { *; }
-keep class com.google.firebase.messaging.FirebaseMessagingService { *; }
-keep class com.google.android.gms.tasks.Task { *; }
-keep class com.google.android.gms.tasks.OnCompleteListener { *; }
-keep class com.google.firebase.FirebaseApp { *; }
