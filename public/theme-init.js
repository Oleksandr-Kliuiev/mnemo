// Apply the saved theme before first paint to avoid a flash of the wrong theme.
try {
  var t = localStorage.getItem('mnemo-theme')
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
} catch (e) {}
