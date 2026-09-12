'use strict';

/*
 * Module partagé — normalisation des textes pour la recherche.
 *
 * Une recherche doit ignorer la casse ET les accents : « Bedarieux »,
 * « bédarieux » et « BÉDARIEUX » désignent la même commune. Les noms
 * d'établissements et de personnes mêlent les deux graphies selon la source
 * (base RH, saisie manuelle, import académique).
 *
 * Source unique de cette règle pour tous les widgets : une recherche qui se
 * comporte différemment d'un widget à l'autre est un défaut en soi.
 *
 * La décomposition NFD sépare la lettre de son signe diacritique, que la plage
 * ̀-ͯ supprime ensuite. Les caractères de contrôle sont retirés, ce
 * qui protège les comparaisons contre des données importées mal formées.
 */

(function (global) {
    const WHITESPACE = /\s+/g;
    const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');
    const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

    /**
     * Forme comparable d'un texte : minuscules, sans accent ni caractère de
     * contrôle, blancs ramenés à une espace simple, bords coupés.
     *
     * Les blancs sont traités AVANT les caractères de contrôle, et remplacés
     * par une espace plutôt que supprimés. Un copier-coller dans Grist
     * convertit parfois une espace en saut de ligne : supprimer ce saut
     * souderait « DUPONT\nDURAND » en « dupontdurand ». Le HTML repliant les
     * blancs, ces valeurs s'affichent à l'identique, et seule la comparaison
     * révélait l'écart.
     *
     * @param {*} value
     * @returns {string}
     */
    function normalize(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(WHITESPACE, ' ')
            .replace(CONTROL_CHARS, '')
            .toLowerCase()
            .normalize('NFD')
            .replace(DIACRITICS, '')
            .trim();
    }

    /**
     * `needle` apparaît-il dans `haystack`, accents et casse ignorés ?
     * Une aiguille vide ne correspond à rien, pour ne pas tout retourner.
     * @returns {boolean}
     */
    function includes(haystack, needle) {
        const query = normalize(needle);
        if (!query) return false;
        return normalize(haystack).indexOf(query) !== -1;
    }

    /**
     * Prédicat de correspondance pour une requête donnée.
     *
     * À préférer à `includes` dans une boucle : la requête n'est normalisée
     * qu'une fois, au lieu d'une fois par valeur testée. Certaines recherches
     * balayent plusieurs dizaines de milliers de lignes à chaque frappe.
     *
     * @param {*} needle requête, brute
     * @returns {(value: *) => boolean} faux partout si la requête est vide
     */
    function matcher(needle) {
        const query = normalize(needle);
        if (!query) return () => false;
        return value => normalize(value).indexOf(query) !== -1;
    }

    /**
     * Distance de Levenshtein : nombre minimal d'insertions, suppressions ou
     * substitutions pour passer d'une chaîne à l'autre.
     *
     * Sert à repérer les fautes de frappe, par exemple entre deux adresses
     * mail ou deux noms de formateurs. Les chaînes comparées sont courtes ;
     * la matrice complète est donc suffisante.
     *
     * @returns {number}
     */
    function levenshtein(a, b) {
        const s = String(a === null || a === undefined ? '' : a);
        const t = String(b === null || b === undefined ? '' : b);
        if (s === t) return 0;
        if (!s.length) return t.length;
        if (!t.length) return s.length;

        // Une seule ligne de la matrice suffit : chaque cellule ne dépend que
        // de la ligne précédente et de la cellule de gauche.
        let previous = new Array(s.length + 1);
        for (let j = 0; j <= s.length; j++) previous[j] = j;

        for (let i = 1; i <= t.length; i++) {
            const current = new Array(s.length + 1);
            current[0] = i;
            for (let j = 1; j <= s.length; j++) {
                const cost = t.charAt(i - 1) === s.charAt(j - 1) ? 0 : 1;
                current[j] = Math.min(
                    previous[j - 1] + cost,  // substitution
                    current[j - 1] + 1,      // insertion
                    previous[j] + 1          // suppression
                );
            }
            previous = current;
        }

        return previous[s.length];
    }

    global.SearchText = { normalize, includes, matcher, levenshtein };

})(typeof window !== 'undefined' ? window : this);
