(function () {
  var theme = 'dark';
  try {
    var stored = localStorage.getItem('bluetalk-theme');
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch (_) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  if (theme === 'light') {
    document.documentElement.style.background = '#fafafa';
    document.documentElement.style.color = '#171717';
    if (document.body) {
      document.body.style.background = '#fafafa';
      document.body.style.color = '#171717';
    }
  }
})();
