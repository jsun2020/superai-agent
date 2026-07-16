// The product default locale is zh (settingsStore.getStoredLocale), but the
// component tests assert English UI strings. Pin the locale before any test
// imports the settings store, which reads localStorage at module init.
localStorage.setItem('superai-agent-locale', 'en')
