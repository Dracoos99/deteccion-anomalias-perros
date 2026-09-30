/* Service worker of Firebase Cloud Messaging: shows the push notifications of new alerts while the app is
   closed or in the background. The web config (public values) arrives in the query string of the registration
   (web/src/lib/push.ts), so the same file serves every Firebase project. The version matches web/package.json. */
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

const params = new URL(self.location.href).searchParams;
firebase.initializeApp({
  apiKey: params.get("apiKey"),
  projectId: params.get("projectId"),
  messagingSenderId: params.get("messagingSenderId"),
  appId: params.get("appId"),
});
// Messages with a "notification" part are displayed by the SDK, and a click opens webpush.fcmOptions.link.
firebase.messaging();
