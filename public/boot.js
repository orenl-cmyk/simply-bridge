(function () {
  function report(message) {
    const status = document.getElementById('bootStatus');
    if (!status || status.hidden) return;
    status.textContent = 'האתחול נכשל: ' + message;
    status.classList.add('error');
  }
  window.addEventListener('error', (event) => report(event.message || 'שגיאת JavaScript'));
  window.addEventListener('unhandledrejection', (event) => report(event.reason?.message || String(event.reason || 'שגיאת JavaScript')));
  window.setTimeout(() => {
    const status = document.getElementById('bootStatus');
    if (status && !status.hidden && status.textContent.trim() === 'טוען…') {
      report('קובץ היישום לא הופעל. רעננו את הדף עם Ctrl+F5.');
    }
  }, 5000);
})();
