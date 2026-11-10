# Plan — Navigateur réel dans la barre de droite de DSH (agent + humain sur le même navigateur)

> **Statut : implémenté (M0 → M4), web uniquement.** Les mesures, l'écart au plan
> et les leçons sont en fin de document (§12).
> Cible : DSH `0.2.2-alpha.3`, plugin hors arborescence (dépôt `dsh-browser`).
> Auteur : agent, 2026-11-10.

---

## 1. Le problème, et pourquoi l'existant ne suffit pas

Trois briques existent déjà, aucune ne couvre le besoin :

| Brique existante | Ce qu'elle fait | Pourquoi ça ne suffit pas |
|---|---|---|
| `dsh-client-ui-sidebar-browser` (onglet `browser`) | iframe HTTP(S) dans la barre de droite, historique applicatif, mode Desktop `<webview>` | une iframe n'est **pas** un vrai navigateur : `X-Frame-Options`/`frame-ancestors` refusent la plupart des sites de connexion, les cookies tiers sont bloqués, et l'agent ne peut pas piloter la page. Aucun outil modèle n'est exposé. |
| `dsh-browser-use` + `browser-use-playwright-mcp` / `chrome-devtools-mcp` | outils navigateur pour le modèle, Chromium headless par Session, mode `attach` sur un endpoint CDP | purement agent : l'humain ne voit rien, ne peut rien faire, et il n'y a pas de notion de « qui tient le volant ». Rendu headless. |
| `dsh-experimental-inspector` | relaye un WebSocket CDP authentifié vers DevTools dans le bas de page | c'est exactement la **technique de transport** dont on a besoin (upgrade authentifié + pipe vers CDP), mais c'est pour le debug de DSH, pas pour un navigateur. |

Le besoin réel : **un seul navigateur Chromium, réel, visible dans la barre latérale, pilotable par l'agent quand l'agent travaille, et pilotable par l'humain dès qu'il faut saisir un mot de passe ou faire une action humaine** — sans que les secrets traversent jamais le contexte du modèle.

---

## 2. L'idée directrice

> **Un Chromium lancé par l'hôte DSH, et *deux* clients branchés sur le même CDP : l'agent et l'humain.**

```
                        ┌──────────────────────────────────────────────┐
   modèle ── outils ──▶ │  Host DSH (plugin dsh-browser)               │
                        │                                              │
                        │  BrowserSession (1 par Session)              │
                        │   ├─ Chromium lancé avec                   │
                        │   │   --remote-debugging-port=<loopback>     │
                        │   │   --user-data-dir=<profil persistant>    │
                        │   ├─ CdpClient  ── plan AGENT                │
                        │   │    navigate/snapshot/click/type/…        │
                        │   └─ Relay      ── plan HUMAIN               │
                        │        Page.startScreencast (JPEG) ─────┐    │
                        │        Input.dispatchMouse/KeyEvent ◀───┤    │
                        └─────────────────────────────────────────┼────┘
                                                                  │ WS /api/dsh-browser/ws
                                                                  ▼
                                              ┌───────────────────────────────┐
                                              │ Onglet "Navigateur" (client)  │
                                              │ canvas + barre d'URL +        │
                                              │ badge Agent/Humain + bouton   │
                                              │ « Prendre le contrôle »       │
                                              └───────────────────────────────┘
```

Conséquences structurantes :

1. **Le même navigateur, le même profil, le même état de connexion** pour l'agent et l'humain. C'est ce qui rend la passation crédible : l'agent remplit un formulaire, bute sur le 2FA, passe la main ; l'humain tape le code ; l'agent continue **dans la page déjà authentifiée**.
2. **Les mots de passe ne transitent jamais côté modèle** : ils sont tapés dans le miroir de l'onglet et envoyés par CDP `Input.dispatchKeyEvent`/`Input.insertText` directement au moteur Chromium. Aucun log, aucune capture persistée pendant la prise de contrôle.
3. **Un seul propriétaire du focus à la fois** : machine à états explicite `agent | human | idle` + verrou d'outils (guard) + lease avec TTL. Pas de course « l'agent clique pendant que tu tapes ton mot de passe ».

---

## 3. Décisions d'architecture (avec justifications)

| # | Décision | Justification / alternative écartée |
|---|---|---|
| D1 | **Un Chromium par Session DSH**, lancé par l'hôte avec `--remote-debugging-port=0` sur `127.0.0.1` | isole cookies/pages entre Sessions ; le port aléatoire évite d'exposer un CDP fixe. Alternative « un navigateur global partagé » : fuite d'état entre Sessions, rejetée. |
| D2 | **Profil persistant** dans `$DSH_HOME/browser-profiles/<hash(cwd)>` | c'est l'intérêt : les connexions survivent au redémarrage. Un profil par workspace évite de mélanger les identités de deux projets. Option « profil éphémère » par config pour les démos/CI. |
| D3 | **Transport humain = WebSocket dédié** `/api/dsh-browser/ws` via `ctx.webServer.registerUpgrade`, authentifié par le cookie DSH via `ctx.connection.requestRejection(req)` | précédent validé : `experimental-inspector` (`registerUpgrade` + `requestRejection`, puis pipe brut). Le Remote stream Typert est **indisponible hors arborescence** (voir D7) et n'accepte pas de binaire descendant de toute façon. SSE + POST marcherait mais coûte 2 connexions, un RTT de plus par frappe et un ack de trame plus compliqué. |
| D4 | **Screencast CDP** `Page.startScreencast` (JPEG q≈60, `maxWidth`/`maxHeight` calés sur le panneau) + `Page.screencastFrameAck` | c'est le seul moyen de rendre un Chromium « réel » dans une page web sans reverse-proxy du site (rejeté : casse l'auth, les en-têtes, le TLS). Override `Emulation.setDeviceMetricsOverride` pour que les coordonnées canvas == coordonnées page. |
| D5 | **Entrées : prototype complet souris + clavier + molette + IME/paste** (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, `Input.dispatchMouseEvent type=wheel`) | `insertText` contourne les key events : indispensable pour le collage et l'IME. Le clavier doit envoyer `code`, `key`, `windowsVirtualKeyCode`, `text` — sinon les sites à validation JS cassent. |
| D6 | **Outils agent natifs** (petit jeu d'outils sur CDP) plutôt que Playwright MCP en v1 | Playwright MCP est plus riche, mais : (a) il crée son propre contexte et ne garantit pas l'isolation multi-Session sur un navigateur partagé, (b) on ne peut pas l'intercaler dans notre verrou de prise de contrôle, (c) `mountSessionMcp` prend une config **statique** alors que le port CDP est par Session. Les outils natifs nous donnent le guard, les captures et le handover. **Phase 2** : brancher Playwright MCP en `--cdp-endpoint` pour les cas « exploration riche », derrière un flag. |
| D7 | **Aucune API `@Remote` Typert** ; échanges hôte↔client par **routes Fetch exactes** (`ctx.connection.fetch.register`) + WebSocket | vérifié : le générateur Typert ne découvre que `<racine>/packages` et `findWorkspaceRoot` exige `tsconfig.host.json` + `packages/` ; le client DSH refuse même les descripteurs non générés. Les routes Fetch exactes sont authentifiées (cookie) et n'acceptent que le Peer *owner*. |
| D8 | **Package unique en bundle hors arborescence** : moitié Host (Cordis) + moitié Client (`dsh.client`), un seul `dsh.bundle` | c'est le format supporté par `dsh plugin add` et par le scan des modules client (`platform: 'web'`, `exports["./client"]`, enregistrement `window.__ModuleLoader__.load({id, factory})`). |
| D9 | **Pas de changement de format de Session en v1** | l'état de contrôle vit côté hôte (store + WS) ; quand l'humain prend la main, on prévient le modèle par un `agent.inject(...)` au tour suivant. Un événement durable `browser/control` pourra être ajouté ensuite (il faudra alors la procédure *session-format version* + ack de type). |

---

## 4. Arborescence du plugin

```
dsh-browser/
├─ package.json            # dsh.bundle + dsh.client {platform:'web'}, exports "." et "./client"
├─ cordis.patch.yml        # un seul row : name: dsh-browser
├─ icon.svg  └─ locale/{en,fr,de,es,it,ja,pt,ru,zh}.json
├─ tsdown.config.ts        # 2 builds : host (node) + client (closure-factory)
├─ src/
│  ├─ shared/              # types JSON purs partagés par les deux moitiés
│  │  ├─ protocol.ts       # union des messages WS (client→host, host→client)
│  │  ├─ routes.ts         # chemins (/api/dsh-browser/…, /api/dsh-browser/ws)
│  │  ├─ state.ts          # machine à états pure (agent|human|idle) — testable seule
│  │  └─ geometry.ts       # mapping canvas → pixels page
│  ├─ host/
│  │  ├─ index.ts          # plugin : services, routes, outils, guard, dispose
│  │  ├─ browser/
│  │  │  ├─ chromium.ts    # découverte de l'exécutable + spawn + close gracieux
│  │  │  ├─ profile.ts     # chemins de profil, verrou d'instance, purge
│  │  │  ├─ session.ts     # cycle de vie par Agent (acquisition/teardown, file d'opérations)
│  │  │  ├─ cdp.ts         # client CDP minimal (Target session, commandes, événements)
│  │  │  ├─ screencast.ts   # pompe de trames + backpressure + ack
│  │  │  └─ input.ts       # souris/clavier/molette/texte → Input.*
│  │  ├─ control.ts        # leases, TTL, guard d'outils, audit, notices agent
│  │  ├─ tools/
│  │  │  ├─ index.ts       # browser_open, browser_snapshot, browser_click, …
│  │  │  ├─ snapshot.ts    # arbre d'accessibilité → texte compact pour le modèle
│  │  │  ├─ screenshot.ts  # PNG → ctx.attachments.saveImage (résultat image)
│  │  │  └─ handover.ts    # browser_request_human (bloque jusqu'à reprise)
│  │  └─ relay/
│  │     ├─ upgrade.ts     # WS authentifié, un seul spectateur par onglet
│  │     └─ status.ts      # route Fetch : état, capacité, version du protocole
│  └─ client/
│     ├─ index.ts          # type d'onglet + slots + raccourci clavier
│     ├─ definition.tsx    # kind 'dshbrowser', guide entry, patterns
│     ├─ body/BrowserBody.tsx   # toolbar + viewport + badge + overlays
│     ├─ body/Viewport.tsx      # <canvas tabindex=0>, capture clavier/souris
│     ├─ body/Toolbar.tsx       # URL, back/fwd/reload, device, plein écran
│     ├─ transport.ts      # WS client : reconnexion, ack, file d'entrées
│     └─ store.ts          # état local (URL, titre, contrôle, latence)
└─ tests/                  # machine à états, protocole, intégration CDP headless
```

### Build du client hors arborescence

Le preset `packages/client/tsdown.client.ts` n'est **pas publié** (pas de `package.json` dans `packages/client`, et la doc le dit explicitement). Il faut donc reproduire le contrat, qui tient en 4 lignes utiles :

```ts
// tsdown.config.ts (moitié client)
banner: 'window.__ModuleLoader__.load({ id: "dsh-browser", factory: (require) => {',
footer: 'return module.exports; } });',
intro:  'var module = { exports: {} }; var exports = module.exports;',
format: 'cjs',
entryFileNames: 'client.js', chunkFileNames: 'client.[name].js',
```

Règles associées (vérifiées dans le code) :
- `id` doit être **exactement** le nom du package (ligne du graphe de boot) ;
- externals = `PLATFORM_MODULES` (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`) + `dsh.client.external` ; tout le reste est inliné ;
- **aucun `require` de valeur `@deepseek-ai/*` hors baseline** (sinon échec de pureté / throw à l'exécution) ; les imports du package sidebar sont **type-only** ;
- les chunks ne s'obtiennent que par `require.async` ;
- le CSS est injecté par le bundle (on peut se contenter de CSS inline dans le preset ou de classes CSS-modules maison).

---

## 5. Contrats hôte

### 5.1 Cycle de vie du navigateur

```ts
interface BrowserSessionService {
  /** Navigateur de l'Agent exact, créé à la demande ; file d'opérations sérialisée. */
  acquire(agent: Agent): Promise<BrowserHandle>
  /** Ferme le Chromium possédé par cet Agent ; idempotent. */
  dispose(agent: Agent): Promise<void>
  /** Onglets ouverts (vues) pour cet Agent. */
  list(agent: Agent): BrowserView[]
}
```

- Spawn : `chromium.launch({ executablePath, headless: false, args: ['--remote-debugging-port=0', '--user-data-dir=…', '--no-first-run', '--no-default-browser-check'] })` puis lecture du port réel dans `DevToolsActivePort` du profil (fiable, contrairement au parsing de stderr).
- Découverte de l'exécutable : `DSH_BROWSER_EXECUTABLE` → `playwright-core` `chromium.executablePath()` → chemins système. **Piège vérifié** : `playwright-core@1.61.1` attend la révision 1228, `1.63.0-alpha` la 1243, et le cache local contient 1208/1217/1248 → fixer la version de `playwright-core` **et** exécuter `playwright install chromium`, ou épingler `executablePath`.
- Fermeture : `Browser.close` via CDP, attente de quiescence, kill du groupe après grâce. Disposal de la Session DSH ⇒ teardown (même discipline que `browser-use-runtime` : l'Agent est la clé d'appropriation, pas l'id de Session durable).
- Limite : N navigateurs max par hôte (config, défaut 2), sinon refus explicite.

### 5.2 CDP minimal

On n'a pas besoin de Playwright pour l'humain ; pour l'agent, `playwright-core.connectOverCDP` donnerait gratuitement `snapshot`/`click`. Deux options, à trancher en M0 :

- **A (recommandée v1)** : client CDP maison (~250 lignes : `ws`, `Target.attachToTarget {flatten:true}`, `Runtime.evaluate`, `Accessibility.getFullAXTree`, `Page.navigate`, `Input.*`), zéro dépendance lourde, contrôle total du verrou.
- **B** : `playwright-core` en dépendance, `connectOverCDP(endpoint)`, on garde la main sur le verrou et les captures. Plus rapide à écrire, mais alourdit l'install (et le binaire).

### 5.3 Outils exposés au modèle (v1)

| Outil | Rôle | Retour |
|---|---|---|
| `browser_open` | ouvre/active un onglet sur une URL (http/https seulement) | `{ viewId, url, title }` |
| `browser_snapshot` | arbre d'accessibilité compressé + liste de refs `[e12]` | texte structuré (borné) |
| `browser_click` | clic sur une ref `[eN]` ou coordonnées | `{ ok, url, title }` |
| `browser_type` | texte dans une ref (ou focus courant) ; option `submit` | `{ ok }` |
| `browser_press` | touche nommée (`Enter`, `Tab`, `Escape`, raccourcis) | `{ ok }` |
| `browser_screenshot` | capture PNG → `ctx.attachments.saveImage` (résultat image) | image durable |
| `browser_read_text` | `innerText` borné de la page | texte |
| `browser_tabs` | liste/crée/ferme/active une vue | `{ views }` |
| `browser_request_human` | demande une action humaine (connexion, 2FA, captcha) et **bloque** | `{ outcome: 'released' | 'timeout' | 'cancelled' }` |

Tous refusent avec un message actionnable si l'état n'est pas `agent` :
`"the human is controlling the browser (view v3); ask them to release control with browser_request_human"`.

Les captures et le snapshot passent par les mêmes bornes que `read_image` (taille, pixels, route image-capable) et **jamais** pendant `human`.

### 5.4 Passation de contrôle

```ts
type ControlState = 'idle' | 'agent' | 'human'

interface ControlLease {
  state: ControlState
  holder: 'agent' | 'human'
  viewId: string
  acquiredAt: number
  /** libération automatique si aucune entrée humaine pendant N ms (défaut 10 min) */
  expiresAt: number
}
```

Transitions et effets :

| Transition | Effets |
|---|---|
| `idle → agent` | premier appel d'outil de l'agent ; l'UI affiche « Agent actif ». |
| `agent → human` (bouton « Prendre le contrôle ») | lease humain ; **guard** : `ctx.tools.guard()` refuse tout outil `browser_*` ; `agent.inject` au tour suivant : « L'humain a pris le contrôle du navigateur ; attends. » ; l'UI passe en saisie active. |
| `human → agent` (« Rendre la main ») | lease agent ; guard levé ; `agent.inject` : « L'humain a rendu le contrôle ; la page est peut-être authentifiée. » ; si un `browser_request_human` attend, il se résout `released`. |
| `human → idle` | déconnexion WS > 30 s ou TTL écoulé ; même effet que `→ agent` mais sans claim. |
| `* → human` par `browser_request_human` | l'outil bloque (avec `exec.signal`), l'UI clignote + bannière « L'agent demande votre aide : <raison> », l'humain clique « J'ai terminé ». |

Le guard est **monotone** (impossible à annuler par un listener ultérieur) et ne s'applique qu'aux outils `browser_*` : le reste de la Session continue de fonctionner (bash, fichiers…).

### 5.5 Routes et protocole

```
GET  /api/dsh-browser/status?viewId=…      → { protocol, state, url, title, viewport, capability }
GET  /api/dsh-browser/views                → [{ viewId, url, title, state }]
WS   /api/dsh-browser/ws?viewId=…&v=1      → trames binaires + JSON
```

Les deux routes HTTP passent par `ctx.connection.fetch.register` (auth cookie, owner-only, 403 sinon). L'upgrade passe par `ctx.webServer.registerUpgrade` + `ctx.connection.requestRejection(req)` : 401/403 renvoyés **avant** toute négociation.

Messages (JSON, un par frame texte) :

```ts
// client → host
| { t: 'hello', viewId, proto: 1 }
| { t: 'mouse', type: 'down'|'up'|'move', x, y, button: 0|1|2, clickCount }
| { t: 'wheel', x, y, dx, dy }
| { t: 'key', type: 'down'|'up', key, code, vk, text?, modifiers }
| { t: 'text', text }                       // IME / collage → Input.insertText
| { t: 'resize', cssWidth, cssHeight, dpr }
| { t: 'navigate', url } | { t: 'back' } | { t: 'forward' } | { t: 'reload' }
| { t: 'control', action: 'take'|'release' }
| { t: 'ack', frameId }

// host → client
| { t: 'ready', proto: 1, url, title, viewport, controls: { canTakeControl: boolean } }
| { t: 'url', url, title, canGoBack, canGoForward, loading }
| { t: 'state', state: ControlState, holder, expiresAt }
| { t: 'request', reason, timeoutMs }        // l'agent demande de l'aide
| { t: 'error', code, message }
// + binaire : [0x01][frameId u32][JPEG]
```

Règles : une seule session de screencast par target (un seul spectateur ; le second reçoit `error: 'viewer-taken'`) ; ack obligatoire sinon Chromium cesse d'émettre (c'est le mécanisme de backpressure) ; `everyNthFrame: 1` + `maxWidth` du panneau ; en cas de WS lent on baisse la qualité avant de jeter des trames.

### 5.6 Sécurité (à traiter comme un livrable, pas une note de bas de page)

1. **Auth** : cookie DSH + contrôle `Host`/`Origin` déjà fournis par `requestRejection`. Aucun port CDP exposé au réseau (bind loopback, port aléatoire, jamais annoncé).
2. **Propriété** : le navigateur appartient à l'Agent exact ; l'identité d'un onglet est `(sessionId, viewId)` ; un WS pour une autre Session est refusé (403), même avec le cookie.
3. **Secrets** : aucune frappe journalisée ; pendant `human`, aucun outil de capture ; les paramètres d'URL (tokens OAuth) sont caviardés dans les logs ; un `browser_snapshot` refuse les champs `type=password` (valeur jamais relue, seulement l'existence du champ).
4. **Contournement du sandbox** : le navigateur a un accès réseau libre, **indépendant** du sandbox DSH. À documenter + `browser.allowHosts`/`denyHosts` optionnel (Phase 3), et un mode `loopbackOnly` pour la CI.
5. **Profil** : dossier sensible (cookies de session, jetons). Permissions 0700, bouton « Effacer le profil », et une entrée README qui dit où c'est et ce que ça contient.
6. **Isolation multi-utilisateur** : hors périmètre v1 (DSH est mono-utilisateur pour l'instant) ; à noter dans les limites.

---

## 6. Contrats client (UI)

- Type d'onglet enregistré via `ctx.sidebarRightTabs.register({ id: 'dsh-browser', kind: 'dshbrowser', priority: 'extension', title, guide, keepMounted: true })` + corps dans le slot `sidebar.right.pane.tab` (clé = `id`) + titre vivant dans `sidebar.right.pane.tab.title`.
- `keepMounted: true` pour conserver le canvas et le WS quand on change d'onglet/de Session (le précédent Desktop Browser le fait).
- Guide **Start** : carte « Navigateur » avec icône globe bleu (visuel de la capture) et raccourci affiché.
- Barre d'outils : `←  →  ⟳`, champ d'URL, sélecteur viewport (1280×800 / 1440×900 / fit), bouton **Prendre le contrôle / Rendre la main**, badge `Agent actif` / `Vous avez le contrôle` / `En attente`, menu « Ouvrir dans le navigateur système », « Capturer », « Effacer le profil ».
- `<canvas tabindex="0">` : capture `keydown/keyup/wheel/pointerdown|move|up` avec `preventDefault()` ; curseur CSS selon `cursor` renvoyé par CDP (`Overlay`/évaluation `getComputedStyle`) en Phase 2.
- Le service de raccourcis doit considérer cette région comme `terminal` (comme `ui-sidebar-terminal`) : DSH ne doit pas intercepter Ctrl/Cmd+C, Ctrl+W, etc. **Limite** : les combos réservés par le navigateur (`Cmd+Q`, `Ctrl+N` selon OS) restent inatteignables — documenté.
- Reconnexion : backoff exponentiel, overlay « Connexion perdue — reconnecter », reprise sur `ready`, jamais de rejeu d'entrées non acquittées.
- `prefers-reduced-motion` / onglet en arrière-plan : on baisse la cadence (`everyNthFrame: 4`) ou on met le screencast en pause.

---

## 7. Jalons

### M0 — Spike de risque (0,5–1 j)
**But : tuer les inconnues avant d'écrire le plugin.**
- [ ] spawn Chromium (binaire trouvé localement) + lecture du port via `DevToolsActivePort`
- [ ] WS `ws` côté Node ↔ page HTML bidon : screencast JPEG + ack, souris + clavier
- [ ] mesurer : fps, taille de trame, latence clic→pixel, charge CPU
- [ ] **critère de sortie** : > 12 fps en 1280×800 sur la machine cible, frappe sans perte
- [ ] vérifier `PLATFORM_MODULES` réel + un bundle client "hello sidebar tab" chargé hors arborescence

### M1 — Squelette du plugin + navigateur + miroir (4–6 j)
- package complet (`dsh.bundle`, `dsh.client`, patch, locales, icône), installable par `dsh plugin add ./dsh-browser`
- `BrowserSessionService` + spawn/teardown, profil persistant, `/api/dsh-browser/ws` authentifié
- onglet client : canvas + screencast + molette + clic + clavier simple
- **AC** : je navigue à la main dans un site, je scrolle, je clique, je tape ; fermer l'onglet libère le navigateur.

### M2 — Fidélité d'entrée et confort (3–4 j)
- clavier complet (`code`/`key`/`vk`/`modifiers`), IME/composition, collage (`insertText`), sélection, `Enter`/`Tab`
- override de viewport, DPR, plein écran, resize propre, curseur
- reconnexion, pause en arrière-plan, indicateur de latence
- **AC** : connexion à un vrai site (Google/GitHub) au clavier avec 2FA, sans quitter la barre latérale.

### M3 — Plan agent (4–5 j)
- client CDP + arbre d'accessibilité + refs stables, 8 outils de la §5.3
- captures via `ctx.attachments` (résultat image), bornes et refus sur route non-image
- **AC** : « ouvre example.com, clique le lien, lis le titre » fonctionne ; une capture s'affiche dans le chat.

### M4 — Passation de contrôle (3 j)
- leases + TTL + guard monotone + notices `agent.inject` + `browser_request_human`
- UI : bouton, badge, bannière de demande, compte à rebours, reprise
- **AC** : l'agent bute sur un login → demande → l'humain tape le mot de passe → rend la main → l'agent poursuit dans la session authentifiée. Aucun secret dans la Session durable (vérifiable par grep sur le log).

### M5 — Durcissement et livraison (4 j)
- tests unitaires (machine à états, protocole, mapping géométrique) + intégration Chromium headless + e2e web
- doc utilisateur (où sont les profils, ce que voit l'agent, limites de sécurité), README package, `engines.dsh`
- perf : objectif < 8 % CPU hôte au repos, < 25 % en scroll
- publication (npm ou index Discover) + icône/locales complètes (`check:i18n` équivalent hors arborescence)

**Total ≈ 19–23 j** pour une personne, plus la phase Desktop.

### M6 — Desktop (optionnel, 5–8 j)
Sur Electron, l'onglet Browser existant est un `<webview>` : son `webContents.debugger` **est** un CDP. On peut y attacher le plan agent sans aucun screencast (rendu natif, latence nulle) et garder exactement la même API d'outils et la même machine à états. Le plugin détecte `window.dshDesktop` et bascule de transport. C'est la meilleure expérience, mais elle dépend du pont Desktop existant (leases, permissions) — à traiter après la version Web.

---

## 8. Risques et parades

| Risque | Impact | Parade |
|---|---|---|
| Perf/latence du screencast (JPEG par frame) | UI molle, CPU | JPEG q 50–70, `maxWidth` = 1–1,5× le panneau, pause si masqué, ack pilote la cadence, dégradation qualité avant perte de trames |
| Fidélité clavier (composants JS, IME, raccourcis) | sites cassés | envoyer `code`+`key`+`vk`+`text`, `insertText` pour l'IME, tests sur 5 sites réels, fallback « coller dans le champ » |
| Version `playwright-core` ↔ binaire Chromium | `connectOverCDP` échoue | épingler la version **et** `playwright install chromium`, ou `executablePath` configuré ; message d'erreur actionnable |
| Preset de build client non publié | bundle refusé au boot | M0 valide la réplique du contrat avant tout le reste ; test « tab visible » dans la CI |
| Concurrence agent/humain | clics croisés | lease exclusif + guard monotone + TTL + refus explicites |
| Fuite de secrets (logs, captures, snapshots) | critique | aucun log de frappe, captures interdites en mode humain, champs `password` jamais relus, revue dédiée |
| Accès réseau hors sandbox | exfiltration | documentation + allowlist de domaines optionnelle + mode `loopbackOnly` |
| Multi-navigateurs (RAM) | machine saturée | plafond configurable, teardown sur disposal, recyclage après inactivité |
| CDP instable / Chromium mis à jour | régressions | client CDP tolérant (ignore les domaines inconnus), tests sur versions épinglées |

---

## 9. Questions à trancher (elles changent le plan)

1. **Cible initiale : Web ou Desktop ?** Recommandation : Web d'abord (le screencast marche partout), Desktop ensuite (natif, sans screencast).
2. **Profil persistant par défaut ?** Recommandation : oui (c'est l'intérêt des connexions), avec bouton d'effacement et option éphémère.
3. **Agent : outils natifs (recommandé) ou Playwright MCP ?** Le MCP apporte plus de surface mais complique le verrou et l'isolation ; on peut le proposer en option en Phase 2.
4. **Un navigateur par Session, ou un seul partagé ?** Recommandation : par Session (isolation), plafond 2.
5. **Politique réseau** : l'agent peut-il aller sur *n'importe* quel domaine, ou faut-il une allowlist/approbation par domaine ? (Sujet sécurité, pas seulement confort.)
6. **Distribution** : `npm` public + index Discover, ou dépôt privé ? Impacte la doc, les locales et `engines.dsh`.
7. **Co-drive simultané** (l'humain regarde et l'agent agit en même temps) : hors v1, mais faut-il prévoir l'UI dès maintenant ?

---

## 10. Ce qu'on ne fait pas (v1)

- Pas d'iframe, pas de reverse-proxy de sites (casse l'authentification).
- Pas de Firefox/WebKit.
- Pas de synchronisation multi-fenêtres/multi-appareils du navigateur.
- Pas de gestionnaire de mots de passe intégré (l'humain tape ; le profil Chromium retient les cookies, éventuellement les mots de passe si l'utilisateur l'autorise dans Chromium).
- Pas de reprise de l'onglet après redémarrage du Host (le profil revient, pas les onglets) — sauf M6 Desktop.
- Pas de changement du format de Session en v1.

---

## 11. Prochaine action concrète

Lancer **M0** (spike d'une demi-journée) à la racine du dépôt : un `spike/` jetable, deux fichiers (`host.mjs`, `page.html`), qui prouve *screencast + input + auth WS* avant d'écrire une ligne du plugin. Si M0 passe ses critères, M1 démarre sur l'arborescence de la §4.

---

## 12. Ce qui a été fait, et ce que ça a appris

### Mesures réelles (M0)

Benchmark brut CDP, page animée en 1280×800 :

| Configuration | Débit | Poids par trame |
|---|---|---|
| Screencast headless, q40/60/80 | 60 fps | 7 KiB |
| Screencast fenêtré (Xvfb), q40/60/80 | 90 fps | 7 KiB |
| Relais complet (WS + ack) | 60 fps | 7 KiB |
| Scroll réel (Wikipédia, 11 220 px) | 48 fps | **111 KiB** |
| Frappe → première trame visible | **p50 30 ms**, p90 35 ms | — |

Conclusion : le screencast tient la charge. Le coût est le **volume** pendant le
scroll (≈5 Mo/s en pointe), pas la latence ; d'où le JPEG q62 et l'ack par trame.

### Écarts au plan, et pourquoi

| Plan | Réalisé | Raison |
|---|---|---|
| Outils `browser_snapshot` + refs `[eN]` | `browser_read` (texte) + `browser_click(selector)` | l'arbre d'accessibilité coûte cher à sérialiser et les refs dérivent entre deux appels ; un sélecteur CSS est stable et vérifiable. L'AX tree reste la piste d'amélioration n°1. |
| Viewport émulé à la taille du panneau, mis à l'échelle | **1:1** : la page est émulée exactement à la taille du panneau | le rendu mis à l'échelle donnait un canvas de 719×448 pour une page de 1280×800 : illisible. |
| Un seul navigateur par Session | idem, plafonné par `maxSessions` (2) | — |
| Reclaims « plus tard » | **implémenté** (`idleTimeoutMs`, 5 min) | voir ci-dessous. |

### Le bug qui t'a fait voir des fenêtres s'ouvrir en boucle

Ma première version ne fermait un Chromium que sur disposal de l'Agent. Or un
onglet fermé, une fenêtre de navigateur fermée ou un client qui se déconnecte
laissent le navigateur **sans spectateur mais vivant** — c'était même l'intention
de départ (« le navigateur survit à la fermeture de l'onglet »). Résultat : chaque
passage de test e2e empilait un Chromium de plus sur ton écran `:0`.

Correctif (et test de non-régression `tests/idle-reclaim.ts`) :

1. un chien de garde ferme le navigateur après `idleTimeoutMs` **sans spectateur
   et sans activité** (une action de l'agent ou de l'humain remet le compteur à
   zéro) ;
2. un travail en cours (`busy`) empêche la récupération ;
3. le profil éphémère est supprimé, y compris ses `Singleton*` ;
4. la fermeture du Host ferme tous les navigateurs via un `ctx.effect` de
   nettoyage ;
5. une session en échec n'est plus mise en cache (elle était réutilisée à
   l'infini comme « déjà disposée »).

Deux autres bugs trouvés par les tests et corrigés :

- `Page.startScreencast` sur une cible qui n'a pas fini de committer → 20
  tentatives au lieu d'un échec ;
- `DevToolsActivePort` d'un run précédent relu trop tôt → suppression du fichier
  avant lancement + attente que l'endpoint réponde.

### État

| Jalon | État |
|---|---|
| M0 spike + mesures | fait |
| M1 package, hôte, onglet, build | fait |
| M2 fidélité d'entrée, viewport, reconnexion | fait |
| M3 outils agent | fait |
| M4 passation de contrôle | fait |
| M5 tests + doc | fait (19 tests unitaires, 2 tests Chromium réel, e2e UI) |
| M6 Desktop | **non commencé** (hors périmètre « web only ») |