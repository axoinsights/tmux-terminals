document.querySelectorAll('button[data-copy]').forEach(function (b) {
  b.addEventListener('click', function () {
    var text = b.getAttribute('data-copy');
    var done = function (ok) {
      b.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      var s = document.getElementById('copy-status');
      if (s) s.textContent = ok ? 'Command copied' : 'Copy failed';
      setTimeout(function () { b.textContent = 'Copy'; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  });
});
