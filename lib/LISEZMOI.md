# Bibliothèques tierces hébergées dans le dépôt

Copiées ici pour qu'aucun CDN ne reçoive l'adresse IP des utilisateurs (RGPD).
Chaque fichier est **identique à l'original**, octet pour octet : ne jamais le
reformater, le minifier ou le corriger. Les pages le chargent avec son
empreinte (`integrity`) : un fichier modifié est refusé par le navigateur.

| Fichier | Version | Origine | Empreinte |
|---|---|---|---|
| `leaflet-1.9.4/leaflet.js` | Leaflet 1.9.4 | paquet npm `leaflet-1.9.4.tgz`, dossier `dist/` | `sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=` |
| `leaflet-1.9.4/leaflet.css` | Leaflet 1.9.4 | idem | `sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=` |
| `leaflet-1.9.4/images/*.png` | Leaflet 1.9.4 | idem (images référencées par `leaflet.css`) | — |
| `leaflet-1.9.4/LICENSE` | — | idem (licence BSD 2 clauses, à conserver avec les fichiers) | — |

Vérifié le 19/11/2026 : l'empreinte de l'archive npm correspond à celle publiée
par le registre npm, et les empreintes de `leaflet.js` et `leaflet.css`
correspondent à celles publiées sur leafletjs.com.

**Mettre à jour une bibliothèque** : télécharger la nouvelle version, comparer
son empreinte à celle publiée par le projet, la copier ici dans un dossier
portant la version, puis mettre à jour ce tableau et l'attribut `integrity`
des pages qui la chargent.
