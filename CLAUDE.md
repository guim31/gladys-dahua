# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
It started from the official JavaScript template. Runtime dependencies: the SDK
and `jpeg-js` (pure JavaScript, to shrink camera pictures).

It brings Dahua cameras, recorders (NVR, XVR) and doorbells (VTO), and the
white-label brands that keep the Dahua firmware (Amcrest, Lorex…), into Gladys
over their local CGI HTTP API (digest authentication), as the Home Assistant
integration `rroller/dahua` does.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/hub.test.js              # one file
node --test --test-name-pattern "ring"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
DAHUA_PASSWORD=… node scripts/probe.mjs <ip> [user]   # real device, read-only
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/app.js registers the handlers before connect()
src/app.js                        every SDK handler -> the hub (also used by the tests)
src/hub.js                        all devices: reads, timers, event streams, states, images, triggers, commands, logs
src/devices.js                    Gladys devices (one per channel), feature names (4 languages), values
src/dahua/client.js               CGI client of one device: digest, queue (2 in flight), lockout guard, reads, writes
src/dahua/digest.js               HTTP Digest (MD5, SHA-256, qop auth), Basic
src/dahua/http.js                 the HTTP seam (node:http/https, streaming), replaced by the fake device in tests
src/dahua/parse.js                key=value answers, refusals in a 200, multipart event stream, event blocks
src/dahua/events.js               the event stream of one device: reconnection, backoff, hourly recycle
src/dahua/model.js                kind, channels, capabilities from the tables; what an event means
src/dahua/device.js               one configured device: describe, read settings, commands
src/image.js, image-worker.js,    snapshot -> camera image <= 150 KB (worker, scaled decoder)
  jpeg-scaled.js
src/scenes.js                     scene action handlers (manifest `scene_actions`)
src/widgets.js                    dashboard widget `dahua` (manifest `widgets`)
src/texts.js                      status, error, report and action texts (4 languages)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/store.js                      /data/dahua-state.json (descriptions of the devices, learned detections)
scripts/probe.mjs                 read-only probe of a real device (not in the image)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/{en,fr,de,es}.md             user documentation, re-hosted by Gladys (en and fr mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
                                  and helpers/fakeDahua.js (built from test/fixtures/dahua)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** exists in English, French, German and Spanish: action
  messages, widget content, feature names, manifest texts, and
  `docs/en.md`, `docs/fr.md`, `docs/de.md`, `docs/es.md`, kept in sync
  (`test/i18n.test.js` checks the languages and the doc sections).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

---

# Notes du mainteneur (guim31)

Ce qui suit complète les règles du template ci-dessus. Ce sont des faits vérifiés dans le code du
cœur Gladys ou payés sur les intégrations déjà publiées par guim31. Ils ne se lisent pas dans le
code de ce dépôt. Compléter ce fichier quand un nouveau piège est découvert.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test`. Prettier contrôle **aussi le Markdown** : lancer `npm run format` après avoir
  modifié ce fichier, le README ou la documentation, sinon la CI tombe.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel se fait ailleurs.
  Le dire, plutôt que de conclure que « ça marche ».
- **Tout le code de démonstration du template disparaît** : station météo, prise, lampe, caméra,
  capteur de mouvement, `src/weather.js`, leurs tests, leurs entrées du manifeste et de la
  documentation. Il ne reste que ce que l'intégration fait vraiment.
- **Publier n'est jamais le travail d'une session de code** : ni Release, ni tag, ni topic, ni
  version modifiée à la main. L'orchestrateur s'en charge une fois la PR fusionnée. Les workflows
  sont ceux du template : ne pas les modifier.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe, **en millisecondes** (1000, 2000, 10000,
  15000, 30000, 60000). Le template publie `poll_frequency: 300` sans `should_poll` : c'est faux,
  le cœur répond 400 à la découverte. Pour une cadence hors liste, publier `should_poll: false` et
  pousser les états depuis le conteneur, en gardant un `onPoll` de repli.
  **Piège du 5.2.0** (GladysAssistant/Gladys#3198, correctif #3199, relevé sur gladys-ping-wol) :
  un appareil **créé sans `should_poll`** n'est jamais sondé, même après correction du cœur (valeur
  stockée à la création), et la 5.2.1 du 13/10/2026 ne le corrige pas. **Le conteneur sonde donc
  lui-même** par un minuteur, qui saute un appareil sondé il y a moins d'une demi-période, en gardant
  `onPoll` comme repli ; seuls les appareils ajoutés (`gladys.devices`) sont lus. Un test le prouve
  sans appeler `onPoll`.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- Un état publié sur une fonctionnalité **pas encore ajoutée** dans Gladys reçoit un 200 puis est
  jeté (simple ligne de log) : republier les états dans `onDeviceCreated`.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- **Détecteur d'ouverture (`opening-sensor`) : 0 = ouvert, 1 = fermé** (`OPENING_SENSOR_STATE`), à
  l'inverse de l'intuition et des autres détecteurs (mouvement, fuite, fumée : 1 = détecté). Une
  porte ouverte publiée à 1 s'affiche « Fermé » et fausse scènes et historique. Le figer par un test.
- **Un `external_id` de fonctionnalité ne change jamais d'appareil** d'une version à l'autre. UniFi
  1.5.2 avait sorti les ports PoE dans un appareil dédié, la 1.6.0 les a remis dans la passerelle avec
  les mêmes identifiants : ceux qui avaient ajouté l'appareil dédié ne peuvent plus « Mettre à jour » la
  passerelle (409 `external_id must be unique`). Pour regrouper, garder l'appareil existant
  (`gladys.getDevices()`) ou changer d'identifiant.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié.
- **Aucune commande d'appareil ne permet un choix multiple** : un `text/select` n'a qu'un choix
  actif.
- Un changement de structure fait proposer « Mettre à jour » dans l'onglet Découverte
  (`structure_changed`). Un changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language` si des textes partent du
  conteneur. Le superviseur injecte `TZ`, le fuseau de Gladys. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus **sans `step`** : le navigateur n'accepte alors que `min + k`.
  Min et défaut **entiers** seulement ; une valeur décimale passe par un `select` ou par un
  `string` parsé (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir, et une action
  n'applique **aucun `default`** tout en exigeant les champs `required` (422). Issues
  GladysAssistant/Gladys#3154 et #3155.

**SDK 0.15 et journaux**

- SDK `@gladysassistant/integration-sdk` **^0.15.0** (12/10/2026) : `DEVICE_POLL_FREQUENCIES`, faux
  Gladys de test (`@gladysassistant/integration-sdk/testing`, à préférer à un faux maison),
  déduplication des états, `parseMdnsTxt`. Lire son README et son CHANGELOG.
- **Journaux calmes** (demande de Guilhem, 13/10/2026) : rien au niveau info pour un cycle normal de
  lecture, un état publié ou un message reçu. L'info ne garde que le cycle de vie : démarrage,
  connexion, perte et retour d'un appareil ou d'un service, erreurs utiles, une ligne par action de
  l'utilisateur. Le reste passe en debug (`LOG_LEVEL=debug`). Une erreur qui se répète écrit une ligne
  au premier échec et une au rétablissement, pas une par tentative. Jamais de secret ni d'adresse
  avec identifiants. Un test vérifie qu'un cycle normal n'écrit rien en info.
- **Heartbeat** : republier au moins toutes les 12 h une valeur qui ne change pas, sinon le front
  affiche « Pas de valeur récente » au-delà de 48 h.

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- **Cibler la dernière version publiée du cœur, pas `master`** : la spec de `master` décrit des
  fonctions non publiées. Les boutons de widget qui ouvrent un formulaire (#3168, commit 3feb2cf8)
  sont absents de la 5.1.4 mais **livrés dans la 5.2.0** (sortie le 12/10/2026) : `gladys_version`
  `>=5.2.0` si on s'en sert, ou un bouton direct en repli. Vérifier par `git tag --contains`.

- Un réglage de widget ne propose en liste que les **appareils** de l'intégration
  (`source: "devices"`, seule source dynamique).
- Budget du cœur : **8 composants par widget, dont 2 textes au plus**, appliqué **avant** la
  résolution des références ; un contenu amputé reste en cache jusqu'au TTL. Appeler
  `requestWidgetRefresh` à la création d'un appareil. `validateWidgetContent` est exporté pour les
  tests, mais ne vérifie pas que les `external_id` liés existent : les croiser avec `buildDevice`.
- Une ligne de `status` exige un `value` (nombre ou texte ≤ 40).
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées.
- Le vocabulaire des widgets n'a ni liste ni curseur, **par choix** du cœur. Seul un bouton
  `device_feature` numérique a un état actif natif.
- **En mode sombre, le style `primary` d'un bouton de widget ne se voit pas** (#3153) : signaler
  un choix courant par l'icône (`check-circle`), jamais par le style.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s. Un toast d'action est tronqué à 200 caractères.
- Le cœur met le contenu d'un widget en cache par (réglages, langue, unités) : pré-localiser
  d'après `language` est correct.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil reste le travail d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- `gladys_version` `>=5.1.0` dès qu'il y a widgets, déclencheurs ou actions de scène.

## Store

- Validateur officiel, depuis la racine : `npx -y github:GladysAssistant/integration-store .`
  (schéma, `description` **100 caractères au plus par langue**, documentation de 300 caractères
  au moins, image Docker, cover de **150 Ko au plus**). Il demande Node ≥ 24 mais tourne sous
  Node 22 avec un avertissement.
- L'indexeur lit le manifeste de la **dernière release**, pas celui de `main` : une correction du
  manifeste (catégorie, description…) n'atteint le store qu'avec une release.
- L'indexeur rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  `https://integration-store-storage.gladysassistant.com/index.json`.
- **Image de base** : `FROM public.ecr.aws/docker/library/node:…` (miroir officiel ECR Public, même
  empreinte) et non `node:…` de Docker Hub, qui refuse en 429 les pulls anonymes des runners GitHub
  dès qu'il y a plusieurs builds à la fois. Un échec 429 dans le job « Docker build » n'est pas un bug
  du code. Même parade dans `.github/workflows/build.yml` (posée par l'orchestrateur, ne pas la
  retirer) : QEMU et BuildKit tirés de `mirror.gcr.io`.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi.

### Langues (depuis le 11/10/2026)

Tout texte montré à l'utilisateur existe en **`en`, `fr`, `de` et `es`** : manifeste, contenu des widgets, messages,
noms de fonctionnalités. L'allemand **tutoie** (« du »), l'espagnol **vouvoie** (« usted ») : décision de Guilhem,
appliquée à ses 21 intégrations. `test/i18n.test.js` doit échouer sur une langue manquante, un texte vide ou trop
long, et sur un « Sie »/« Ihr… » de politesse en allemand. Le store exige `docs/en.md` et `docs/fr.md`
(`DOCS_LANGUAGES`) et publie aussi `docs/de.md` et `docs/es.md` quand ils existent
(`DOCS_OPTIONAL_LANGUAGES` d'integration-store) : écrire les quatre, avec les mêmes sections.

## Choix par défaut de Guilhem (12/10/2026)

- Langue par défaut des noms de fonctionnalités et des textes produits par le conteneur : **`fr`**.
- Fichier `LICENSE` Apache-2.0 (texte complet) à la racine.
- `transports` : `local` seul quand le cloud n'est qu'une option annexe.
- Docs `en`, `fr`, `de`, `es` avec les mêmes sections.
- Chauffe, ouverture, sécurité : ne rien rendre pilotable « comme un thermostat » ou par un assistant
  vocal quand une erreur serait dangereuse (leçon d'OctoPrint).

## Dahua : l'API et les pièges de cette intégration

Sources : `rroller/dahua` (MIT, commit 3bccdf1 du 14/10/2026) et la doc HTTP API publique de Dahua. Aucun
appareil Dahua n'a été testé : `scripts/probe.mjs` est à lancer par l'orchestrateur sur un vrai appareil.

- **API CGI** : tout est `GET /cgi-bin/…`, réponses en lignes `clé=valeur` (`table.` devant les tables de
  `configManager`). **Un 200 dont le corps commence par `Error` est un refus** ; une table absente répond un 200
  vide, un 400 ou un 500 : une capacité se juge sur la présence de la clé du canal, jamais sur « la requête n'a
  pas échoué ». 403 = compte sans le droit (jamais un mauvais mot de passe), 404/501 = pas d'API CGI.
- **Digest** : signer l'`uri` exactement telle qu'envoyée. Les chemins gardent les crochets en clair
  (`MotionDetect[0].Enable`), signés tels quels ; un `%5B` signé `[` donne un 403 sur certains firmwares. Un
  appareil renvoie un nouveau nonce à chaque requête (deux requêtes par appel).
- **Verrouillage du compte** : 5 mots de passe refusés puis 5 à 30 min de blocage selon le firmware. Un 401 sur
  un défi qu'on vient de recevoir, c'est le mot de passe : le client s'arrête (`blocked`) dès ce premier refus
  et ne reprend qu'avec une nouvelle configuration ou « Tester la connexion » (un seul essai). Le flux
  d'événements ne s'ouvre pas sur un client bloqué. **Ne jamais ajouter de boucle de réessai sur un 401.**
- **Charge** : 2 requêtes en vol au plus par appareil (une douzaine fige le serveur web), tables lues entières,
  20 s de délai. Chaque requête s'écrit dans le journal de l'appareil.
- **Canaux** : base 0 dans les tables et l'`index` des événements, base 1 dans `snapshot.cgi?channel=` et RTSP,
  sauf vieux firmwares qui répondent à `channel=0` (sonde jamais faite sur un portier). Les caméras d'un
  enregistreur sont ses emplacements `RemoteDevice` activés et non ONVIF (un canal ONVIF répond 400) ; **cette
  table contient le mot de passe de chaque caméra en clair** : lue, utilisée, jetée, jamais journalisée ni
  gardée dans `/data` (un test le vérifie).
- **Flux d'événements** : toujours `codes=[All]` filtré ici (une liste longue est refusée en 400/500 ou rend le
  flux muet), `heartbeat=5`, 60 s sans octet = flux mort. Parties multipart irrégulières : 1 à 3 en-têtes, pas de
  ligne vide sur certains heartbeats, `\n` seuls, frontière coupée entre deux paquets, `Content-Length` faux,
  JSON tronqué ou contenant `;` et `=` : `data` = tout ce qui suit `;data=`. Les `Stop` sont perdus pendant une
  coupure : tout est remis à 0 à la fermeture du flux.
- **Personne** : `SmartMotionHuman`, ou une règle `CrossLineDetection` / `CrossRegionDetection` dont
  `data.Object.ObjectType` vaut `Human` (beaucoup de caméras n'envoient que ça ; `Object` peut être `null`).
  **Sonnette** : `BackKeyLight` (VTO) ou `PhoneCallDetect` (Amcrest) avec `State` 1 ou 2 ; 8 = porte ouverte,
  9 = échec. Home Assistant lit les portiers en DHIP (TCP 5000), pas par le flux CGI : la sonnerie par le flux
  CGI n'est pas vérifiée. `AlarmLocal` : son `index` est une entrée d'alarme, pas un canal.
- **Éclairage** : `Lighting[canal][profil].Mode` (`Auto`, `Manual` = allumé, `Off`) pour l'infrarouge ; le
  profil vivant vient de `VideoInMode` (écrire un autre profil est accepté puis ignoré). Lumière blanche : la
  ligne de `Lighting_V2[canal][profil][i]` dont `LightType=WhiteLight` (l'ordre change selon le modèle).
- **Sirène** (`coaxialControlIO.cgi`, Type 2, IO 1/2) : état lu sur le canal 1, commande envoyée sur le canal 0
  pour une caméra directe ; elle s'arrête seule après 10 à 15 s (relecture 20 s après). Présente seulement sur
  les modèles connus (`AS-PV`, `L46N`, `W452ASD`, `TPC-BF1241`) ou si `getStatus` annonce un `Speaker`.
- **Ouverture de porte** : `accessControl.cgi?action=openDoor&channel=N&UserID=101&Type=Remote`. **Jamais
  réessayée**, même après un 400 (une porte s'est déjà ouverte malgré un 400). Désactivée par défaut, action de
  scène seulement, jamais une fonctionnalité d'appareil.
- **Image d'un portier** : 8 octets `dhav…` après la fin du JPEG, coupés.
- Un `text/select` (vision nocturne) se publie `{ text }` ; le faux Gladys rend la chaîne avec `lastState`.
- `audio` n'a pas de catégorie dans le cœur : `input/binary` (On/Off), comme « En ligne ».
- Faux appareil de test (`test/helpers/fakeDahua.js`) : en mode `serve()`, appeler `res.flushHeaders()` pour le
  flux, sinon le client attend les en-têtes jusqu'au premier octet.
- `gladys-hikvision` (autre auteur, cité par la consigne) n'a pas été trouvé depuis la session (clone refusé
  sous les comptes essayés, index du store injoignable).
