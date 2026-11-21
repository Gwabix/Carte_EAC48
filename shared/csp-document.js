'use strict';

// Resserre la CSP de la page sur l'API du seul document qui affiche le widget.
//
// Règle : la balise <meta> CSP de la page autorise tout grist.numerique.gouv.fr
// en connect-src (le widget ne sait pas encore dans quel document il tourne).
// Dès que Grist donne l'adresse de l'API du document (baseUrl de getAccessToken :
// /o/<espace d'équipe>/api/docs/<id>), une seconde politique est ajoutée :
//   connect-src 'self' <baseUrl>/
// Le navigateur applique les deux politiques à la fois : une requête n'est
// permise que si les deux l'acceptent. Le widget ne peut plus joindre que son
// propre document, quel que soit l'espace d'équipe qui l'héberge. Une CSP ne
// peut ainsi que se resserrer, jamais s'assouplir.
//
// Pièges :
// - charger ce module juste après grist-plugin-api.js, avant les scripts du
//   widget : le resserrement doit précéder l'affichage des données Grist ;
// - l'adresse vient de Grist, mais elle est vérifiée (http ou https, caractères
//   d'URL sans espace, guillemet, virgule ni « ; ») : sinon elle pourrait
//   ajouter une source ou une directive à la politique ;
// - en cas d'échec (accès non complet, jeton refusé), la CSP de la page reste
//   seule en place : le widget fonctionne, sans resserrement ;
// - même fichier dans PilotageFormAcad-Forge, Carte_EAC48, Gabarit DRANE et les
//   deux dépôts Suivi EBEP : le corriger partout.
(function () {
    var HOTE_SUR = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
    var CHEMIN_SUR = /^\/[A-Za-z0-9._~%\/-]*$/;

    function restreindre() {
        if (typeof grist === 'undefined' || !grist.docApi || typeof grist.docApi.getAccessToken !== 'function') {
            return Promise.resolve(false);
        }
        return Promise.resolve()
            .then(function () { return grist.docApi.getAccessToken({ readOnly: true }); })
            .then(function (info) {
                var u = new URL(info.baseUrl);
                if (u.protocol !== 'https:' && u.protocol !== 'http:') { return false; }
                if (!HOTE_SUR.test(u.host) || !CHEMIN_SUR.test(u.pathname)) { return false; }
                var chemin = u.origin + u.pathname + (u.pathname.slice(-1) === '/' ? '' : '/');
                var meta = document.createElement('meta');
                meta.httpEquiv = 'Content-Security-Policy';
                meta.content = "connect-src 'self' " + chemin;
                document.head.appendChild(meta);
                return true;
            })
            .catch(function () { return false; });
    }

    window.CspDocument = { pret: restreindre() };
})();
