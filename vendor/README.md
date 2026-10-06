# vendor/

Pacotes npm já compilados de duas dependências que só existem no GitHub
(forks de datakurre, sem versão publicada no npm — os pacotes de mesmo nome no
registro npm são outros projetos):

| Pacote                       | Origem (commit fixado)                                                             | sha256                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `bpmn-to-image-0.1.0.tgz`    | github.com/datakurre/bpmn-to-image @ `9b26c0ff384ef3bb37109e4e41eb4ee4e1d75ea1`    | `28fe4c993b803cb8f5352d1722fff13aa1b67457f7c351532c3f44bee7b0b11d` |
| `bpmn-auto-layout-0.1.0.tgz` | github.com/datakurre/bpmn-auto-layout @ `139cc5803679651417a1dcd06107b6af761c5ffb` | `28a2c80af353a6313053f289c31a98a92e42e464f31557eb85829e1b3ebb2ff6` |

Ambos MIT (o `LICENSE` vai dentro de cada pacote).

**Por quê:** como dependência Git, cada uma só funciona se o npm rodar o script
`prepare` (compilação) na instalação. O npm novo recusa dependências Git por
padrão e bloqueia scripts de instalação — na Vercel o pacote chegava sem o
`dist/` e a função quebrava ao carregar (`FUNCTION_INVOCATION_FAILED`). Com o
pacote pronto, a instalação não precisa de Git, de acesso ao GitHub nem de
scripts.

**Atualizar** (trocar `<repo>` e `<commit>`; em Linux com Node 22 e git):

```bash
git clone https://github.com/datakurre/<repo>.git /tmp/<repo>
cd /tmp/<repo> && git checkout <commit> && npm ci && npm pack --pack-destination <este-repo>/vendor
cd <este-repo> && npm install && sha256sum vendor/*.tgz   # atualizar a tabela acima
```
