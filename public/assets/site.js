// Página de apresentação: endereço real do servidor, botões "Copiar" e
// indicador de status. Arquivo externo porque a CSP não permite script inline.
(function () {
  'use strict';

  var endpoint = window.location.origin + '/mcp';

  // Troca o "<este-site>" dos exemplos pelo endereço de onde a página foi aberta.
  document.querySelectorAll('[data-endpoint]').forEach(function (el) {
    el.textContent = endpoint;
  });

  function markCopied(button) {
    button.setAttribute('data-done', '');
    button.textContent = 'Copiado!';
    window.setTimeout(function () {
      button.removeAttribute('data-done');
      button.textContent = 'Copiar';
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

  // Status do serviço (rota pública /health, sem token).
  var status = document.getElementById('status');
  if (status && window.fetch) {
    fetch('/health', { cache: 'no-store' })
      .then(function (res) {
        status.setAttribute('data-state', res.ok ? 'ok' : 'down');
        status.textContent = res.ok ? '● serviço no ar' : '● serviço indisponível';
      })
      .catch(function () {
        status.setAttribute('data-state', 'down');
        status.textContent = '● serviço indisponível';
      });
  }
})();
