/* Классический (не модульный) скрипт-страж. Запускается даже там, где модули не работают.
   Если страницу открыли как файл (file://) или основной модуль не загрузился, формы не должны
   «молча» перезагружать страницу — вместо этого показываем понятную подсказку. */
(function () {
  var started = false;
  window.__aquaStarted = function () { started = true; };

  function banner(text) {
    if (document.getElementById('boot-banner')) return;
    var b = document.createElement('div');
    b.id = 'boot-banner';
    b.className = 'boot-banner';
    b.setAttribute('role', 'alert');
    b.textContent = text;
    document.body.appendChild(b);
  }

  // Пока приложение не стартовало, отправка любой формы не должна обновлять страницу
  document.addEventListener('submit', function (e) {
    if (!started) { e.preventDefault(); check(true); }
  }, true);

  function check(force) {
    if (started) return;
    if (location.protocol === 'file:') {
      banner('Aqua нельзя открыть двойным кликом по файлу. Запустите сервер (uvicorn app.main:app) и откройте http://127.0.0.1:8000 — подробности в README.');
    } else if (force) {
      banner('Приложение не загрузилось. Проверьте, что папка frontend/js на месте, и обновите страницу (Ctrl+F5).');
    }
  }
  window.addEventListener('load', function () { setTimeout(function () { check(false); }, 600); });
})();
