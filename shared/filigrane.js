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
 *   - par défaut : ligne centrée à la fin du contenu, mais jamais plus haut
 *     que le bord inférieur de la fenêtre : si la page tient dans la fenêtre
 *     filigrane compris, il est collé en bas (classe filigrane-widget--bas) ;
 *     sinon il suit le contenu. Le test se fait toujours filigrane remis à sa
 *     place dans le flux, sinon la décision oscillerait. Piège : un conteneur
 *     en min-height: 100vh repousse le filigrane hors de la fenêtre ; lui
 *     donner calc(100vh - var(--filigrane-hauteur, 0px)), hauteur publiée ici
 *     sur :root. Un body en min-height: 100vh n'en a pas besoin (le filigrane
 *     est dedans) ;
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
.filigrane-widget--bas {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
}
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
        if (!fixe) suivreLaHauteur(pied);
    }

    /** Colle le filigrane en bas de la fenêtre tant que la page y tient. */
    function suivreLaHauteur(pied) {
        const racine = document.documentElement;
        function placer() {
            pied.classList.remove('filigrane-widget--bas');
            racine.style.setProperty('--filigrane-hauteur', `${pied.offsetHeight}px`);
            // 1 px de marge pour les arrondis des hauteurs fractionnaires.
            const tient = racine.scrollHeight <= racine.clientHeight + 1;
            pied.classList.toggle('filigrane-widget--bas', tient);
        }
        placer();
        window.addEventListener('resize', placer);
        // Différé d'une image : placer() change lui-même la taille du body,
        // ce qui, en direct, ferait signaler une boucle par le navigateur.
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => requestAnimationFrame(placer)).observe(document.body);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ajouter);
    else ajouter();
})();
