# Finanças & Rotina — PWA

Aplicativo pessoal **offline-first** que junta finanças, rotina e metas num único painel.
Funciona como app no celular (iOS e Android) via PWA. Sem servidor, sem login — os dados ficam no seu aparelho.

## Estrutura

```
financas-app/
├── index.html          # markup do app
├── styles.css          # tema claro e escuro, cards, anéis, heatmap
├── db.js               # camada de storage (IndexedDB)
├── app.js              # lógica completa
├── manifest.webmanifest  # metadados do PWA
├── sw.js               # service worker (cache offline)
└── icons/
    ├── icon-192.svg
    ├── icon-512.svg
    └── icon-maskable.svg
```

## Passo 1 — Subir no GitHub Pages

1. Acesse [github.com/new](https://github.com/new) e crie um repositório **público** com o nome que quiser (ex.: `financas`). Deixe sem README inicial.
2. No seu computador, abra esta pasta (`financas-app`) e use uma das duas opções abaixo.

### Opção A — GitHub Desktop (mais simples)

1. Instale [GitHub Desktop](https://desktop.github.com/).
2. `File → Add Local Repository` e aponte pra esta pasta.
3. Será pedido pra "publicar" — confirme e use o nome do repositório criado no passo 1.

### Opção B — Linha de comando

Dentro da pasta `financas-app`:

```bash
git init
git add .
git commit -m "Primeira versão do app"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/financas.git
git push -u origin main
```

### Ativar o Pages

1. No GitHub, abra o repositório → **Settings** → **Pages** (menu lateral esquerdo).
2. Em **Source**, selecione **Deploy from a branch** → **main** → **/(root)** → **Save**.
3. Aguarde 30-60 segundos. A URL ficará: `https://SEU_USUARIO.github.io/financas/`.

## Passo 2 — Instalar como app no celular

### Android (Chrome / Edge)

1. Abra a URL do Pages no navegador.
2. Aparecerá um banner "Instalar app" — clique. Ou: menu (⋮) → **Adicionar à tela inicial** / **Instalar app**.
3. O ícone vai pra tela inicial e abre em tela cheia, sem barra de navegador.

### iPhone / iPad (Safari)

1. Abra a URL no Safari (não funciona no Chrome do iOS).
2. Toque no botão **Compartilhar** (□↑) → **Adicionar à Tela de Início**.
3. Pronto — vira ícone como qualquer outro app.

Depois da primeira visita, o app funciona offline (service worker armazena tudo).

## Passo 3 — Migrar dados da versão antiga (HTML solto)

Os dados do app antigo (`financas_revisado_melhorado.html`) ficaram no `localStorage`
do arquivo local — uma origem diferente. Pra trazer pra cá:

1. Abra o HTML antigo no mesmo navegador/caminho onde sempre usou.
2. Vá na aba **Contas** → botão **Exportar backup** → salve o JSON.
3. Abra o novo app (Pages ou local) → aba **Backup** → **Importar backup (.json)** → escolha o arquivo. Pronto.

Obs.: na 1ª abertura do novo app, ele tenta automaticamente puxar dados do `localStorage`
do antigo — mas isso só funciona se você abrir o `index.html` **na mesma pasta** onde o
HTML antigo rodava. Hospedado no Pages, a importação manual é o caminho.

## Passo 4 — Configurar pasta de backup automática (Drive / Dropbox)

Em **Chrome/Edge no desktop** e **Chrome no Android recente**:

1. Crie uma pasta dentro do **Google Drive local** (`G:\Meu Drive\financas-backup`) ou **Dropbox local** (`C:\Users\...\Dropbox\financas-backup`).
2. No app, vá em **Backup** → **Escolher pasta de backup** → selecione a pasta criada.
3. Conceda permissão de escrita.
4. A partir de agora, toda alteração no app gera um `backup-financas.json` nessa pasta, que sincroniza sozinho.

No **iPhone (Safari)** essa API não existe ainda — use **Exportar backup** manual e salve
o arquivo no Drive / Dropbox via app deles.

## Como funciona / mecânicas

- **Hoje**: dashboard com 4 métricas (score hábitos, contas em dia, streak combinado, saldo) + 3 colunas (hábitos, contas urgentes, próximos marcos).
- **Rotina**: cadastro de hábitos com meta diária, anel SVG, botão +1, **streak** (sequência) e **heatmap** mensal.
- **Conquistas**: marcos automáticos. Financeiros (mês no azul, cartão sob controle, meta cumprida...) e de rotina (7/30/100 dias por hábito). Sem punição — só ganhos.
- **Painel / Mês a mês / Contas / Parcelas / Cartão / Metas / Prioridades / IA Anti-Sufoco**: tudo do app original, intacto.
- **Backup**: pasta sincronizada (auto) + export/import JSON (manual).

## Tema escuro

Botão no canto direito do header. Na 1ª visita, respeita a preferência do sistema (modo escuro do celular/PC).

## Troubleshooting

**O app não aparece pra instalar no Chrome Android.**
PWAs precisam de HTTPS — GitHub Pages já entrega isso. Se a URL começar com `https://`, deve aparecer. Limpe o cache, recarregue e tente o menu (⋮).

**No iPhone não tem "Instalar app".**
iOS chama de "Adicionar à Tela de Início". É no botão Compartilhar, não no menu.

**Dados sumiram.**
Provavelmente abriu em outro navegador/origem. Verifica:
- Mesma URL? (Pages é fixa, file:// muda por caminho)
- Mesmo navegador? (Chrome ≠ Edge ≠ Safari)
- Modo anônimo apaga ao fechar.
- Restaure com **Importar backup** se você tem o JSON.

**Não consegui escolher pasta no celular.**
Funciona só em Chrome Android (não Safari iOS). Use export manual e suba pro Drive/Dropbox via app deles.

## Próximas ideias (não implementadas ainda)

- Notificações nativas pra vencimentos próximos
- Gráficos de linha histórico (saldo mês-a-mês)
- Sync via Google Drive API direto (sem precisar pasta local)
- Categorização automática de gastos do cartão
