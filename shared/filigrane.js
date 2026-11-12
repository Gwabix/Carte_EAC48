'use strict';

/*
 * Filigrane des widgets : auteur, licence et version publiée, à l'écran
 * seulement (masqué à l'impression ; absent des PDF, qui ne capturent pas le
 * bas de page).
 *
 *   Widget conçu par Gabriel RUQUET · Licence PolyForm Noncommercial 1.0.0
 *   · version du 12/11/2026 15:30 (9168329)
 *
 * La version sert à vérifier d'un coup d'œil que le dernier commit est publié.
 * Elle n'est JAMAIS écrite à la main : le repère ci-dessous est remplacé au
 * déploiement (CI GitLab de la Forge, ou workflow GitHub Pages) par la date et
 * le hash court du commit publié. Non remplacé (fichiers ouverts en local),
 * le filigrane affiche « version de développement ».
 *
 * Deux présentations, choisies par la page avec data-position sur la balise
 * <script> :
 *   - par défaut : ligne centrée à la fin du contenu (pages qui défilent) ;
 *   - data-position="fixe" : petite étiquette dans le coin inférieur gauche,
 *     pour les pages en pleine hauteur (carte, applications sans défilement),
 *     où une ligne ajoutée à la fin serait invisible. Elle ne bloque pas les
 *     clics, sauf sur le lien de la licence.
 *
 * Même fichier dans chaque dépôt de widgets : le corriger partout à la fois.
 */

(function () {
    const VERSION = '__VERSION_WIDGET__';
    const LICENCE = 'https://polyformproject.org/licenses/noncommercial/1.0.0/';
    const script = document.currentScript;
    const fixe = !!script && script.dataset.position === 'fixe';

    const STYLE = `
.filigrane-widget {
    flex: none;
    margin: 0;
    padding: 14px 8px 10px;
    font: 11px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #7f8c8d;
    text-align: center;
    background: transparent;
}
.filigrane-widget a { color: inherit; text-decoration: underline; }
.filigrane-widget a:hover { color: #2c3e50; }
.filigrane-widget--fixe {
    position: fixed;
    left: 0;
    bottom: 0;
    z-index: 5;
    max-width: calc(100% - 16px);
    padding: 2px 8px;
    border-top-right-radius: 6px;
    background: rgba(255, 255, 255, 0.85);
    text-align: left;
    pointer-events: none;
}
.filigrane-widget--fixe a { pointer-events: auto; }
@media print { .filigrane-widget { display: none !important; } }`;

    function ajouter() {
        if (document.querySelector('.filigrane-widget')) return;
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);

        const pied = document.createElement('footer');
        pied.className = 'filigrane-widget' + (fixe ? ' filigrane-widget--fixe' : '');
        const lien = document.createElement('a');
        lien.href = LICENCE;
        lien.target = '_blank';
        lien.rel = 'noopener noreferrer';
        lien.textContent = 'Licence PolyForm Noncommercial 1.0.0';
        const version = VERSION.startsWith('__') ? 'version de développement' : `version du ${VERSION}`;
        pied.append('Widget conçu par Gabriel RUQUET · ', lien, ` · ${version}`);
        document.body.appendChild(pied);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ajouter);
    else ajouter();
})();
