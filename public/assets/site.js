// Guia do MCP de BPMN: botões "Copiar", endereço do servidor na nuvem e
// destaque da seção atual no índice. Arquivo externo porque a CSP não
// permite script inline.
(function () {
  'use strict';

  // Troca o "<este-site>" do exemplo da nuvem pelo endereço de onde a página foi aberta.
  var endpoint = window.location.origin + '/mcp';
  document.querySelectorAll('[data-endpoint]').forEach(function (el) {
    el.textContent = endpoint;
  });

  // ── Copiar ──────────────────────────────────────────────────────────────

  function markCopied(button) {
    var original = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', original);
    button.setAttribute('data-done', '');
    button.textContent = 'Copiado!';
    window.setTimeout(function () {
      button.removeAttribute('data-done');
      button.textContent = original;
    }, 1800);
  }

  // Cópia sem a Clipboard API (página sem HTTPS ou navegador antigo).
  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  document.querySelectorAll('button[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var source = document.getElementById(button.getAttribute('data-copy'));
      if (!source) return;
      var text = source.textContent.trim();
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
          function () {
            markCopied(button);
          },
          function () {
            if (fallbackCopy(text)) markCopied(button);
          }
        );
      } else if (fallbackCopy(text)) {
        markCopied(button);
      }
    });
  });

  // ── Índice: marca a seção que está na tela ──────────────────────────────

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;

  var byId = {};
  links.forEach(function (a) {
    byId[a.getAttribute('href').slice(1)] = a;
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          a.removeAttribute('aria-current');
        });
        var link = byId[entry.target.id];
        if (link) link.setAttribute('aria-current', 'true');
      });
    },
    { rootMargin: '-45% 0px -50% 0px' }
  );

  Object.keys(byId).forEach(function (id) {
    var section = document.getElementById(id);
    if (section) observer.observe(section);
  });
})();
