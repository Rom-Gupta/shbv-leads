// Firebase Cloud Messaging service worker — handles push notifications that
// arrive while the app isn't open (tab closed, phone screen off, etc). This
// file must live at the site root (not a subfolder) so its default scope
// covers the whole app. Registered from index.html's enablePushNotifications().
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

// Same config as index.html's firebaseConfig — these are public client
// identifiers (not secrets), same as any Firebase web app's config.
firebase.initializeApp({
  apiKey: "AIzaSyBowXNjtUY2d4ZfWROhNicRp17n8QIDCOU",
  authDomain: "shbv-leads.firebaseapp.com",
  projectId: "shbv-leads",
  storageBucket: "shbv-leads.firebasestorage.app",
  messagingSenderId: "1098083784943",
  appId: "1:1098083784943:web:2ff1da8ec50a2b9bae231a"
});

const messaging = firebase.messaging();

// Fires when a push arrives while no tab has focus. (A push that arrives
// while the app IS in focus is instead handled in-page, same as the
// existing new Notification(...) calls elsewhere in index.html.)
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'SHBV Leads';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

// Tapping the notification focuses an existing SHBV Leads tab if one's open,
// otherwise opens a new one, instead of just dismissing silently.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
