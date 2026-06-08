self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Brake Knights', {
      body: data.body || '',
      icon: '/images/favicon.png',
      badge: '/images/favicon.png',
      data: { url: data.url || '/admin' },
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(wins) {
      for (var i = 0; i < wins.length; i++) {
        if (wins[i].url.indexOf('/admin') !== -1 && 'focus' in wins[i]) {
          wins[i].navigate(url);
          return wins[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
