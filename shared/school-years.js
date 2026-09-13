'use strict';

/*
 * Module partagé — écoles par année scolaire.
 *
 * La table Ecoles porte une ligne par école ET par année (colonne Annee), pour
 * conserver les effectifs d'une année sur l'autre. Les projets référencent la
 * ligne de leur année : leurs colonnes d'effectifs ($UAI.TPS…) restent ainsi
 * figées sur l'année du projet.
 *
 * Une école est identifiée d'une année à l'autre par son code UAI.
 *
 * Deux services :
 *
 *  - ensureYear() : si l'année scolaire en cours n'a encore aucune ligne, duplique
 *    celles de l'année précédente, effectifs vidés. Les ouvertures et fermetures
 *    d'écoles se corrigent ensuite à la main dans Grist.
 *
 *  - buildIndex() : regroupe les lignes par école et retrouve la ligne à utiliser
 *    pour une année donnée.
 */

(function (global) {
    const TABLE_SCHOOLS = 'Ecoles';
    const TABLE_PROJECTS = 'Projets_par_ecole';
    const COL_UAI = 'UAI';
    const COL_YEAR = 'Annee';
    const COUNT_COLUMNS = ['TPS', 'PS', 'MS', 'GS', 'CP', 'CE1', 'CE2', 'CM1', 'CM2'];
    const YEAR_PATTERN = /^\d{4}-\d{4}$/;
    const ALL_YEARS = '__all__';

    function text(value) {
        return typeof value === 'string' ? value.trim() : (value === null || value === undefined ? '' : String(value));
    }

    function column(data, colId) {
        const values = data ? data[colId] : null;
        return Array.isArray(values) ? values : [];
    }

    function currentSchoolYear(date) {
        const now = date || new Date();
        const year = now.getFullYear();
        return now.getMonth() + 1 <= 7 ? `${year - 1}-${year}` : `${year}-${year + 1}`;
    }

    // Clé d'une école d'une année à l'autre. Sans UAI, la ligne reste isolée :
    // mieux vaut une école sans historique qu'un rapprochement erroné.
    function schoolKey(uai, rowId) {
        const code = text(uai).toUpperCase();
        return code ? `uai:${code}` : `row:${rowId}`;
    }

    /* ------------------------------------------------------------------
     * Duplication de l'année précédente
     * ---------------------------------------------------------------- */

    // Ajoute l'année aux choix des colonnes Annee qui ne la proposent pas.
    // Séparé de la duplication : un utilisateur sans droit de modifier la
    // structure doit quand même obtenir les lignes.
    async function addYearChoice(year) {
        const actions = [];

        for (const tableId of [TABLE_SCHOOLS, TABLE_PROJECTS]) {
            const defs = await global.GristColumns.fetchColumnDefs(tableId, [COL_YEAR]);
            const def = defs && defs[COL_YEAR];
            if (!def || def.type !== 'Choice' || def.choices.length === 0 || def.choices.includes(year)) {
                continue;
            }
            const options = Object.assign({}, def.widgetOptions, { choices: def.choices.concat(year) });
            actions.push(['ModifyColumn', tableId, COL_YEAR, { widgetOptions: JSON.stringify(options) }]);
        }

        if (actions.length > 0) {
            await grist.docApi.applyUserActions(actions);
        }
    }

    // Deux widgets ouverts en même temps peuvent dupliquer chacun l'année.
    // Chacun relit la table après son ajout et ne garde, par école, que la
    // ligne de plus petit identifiant : la règle étant la même pour tous, les
    // widgets suppriment les mêmes lignes et le résultat converge.
    async function removeDuplicates(year) {
        const data = await grist.docApi.fetchTable(TABLE_SCHOOLS);
        const ids = column(data, 'id');
        const uais = column(data, COL_UAI);
        const years = column(data, COL_YEAR);
        const keep = new Map();
        const extras = [];

        ids.map((id, i) => ({ id: Number(id), i }))
            .sort((a, b) => a.id - b.id)
            .forEach(({ id, i }) => {
                if (text(years[i]) !== year || !text(uais[i])) {
                    return;
                }
                const key = schoolKey(uais[i], id);
                if (keep.has(key)) {
                    extras.push(id);
                } else {
                    keep.set(key, id);
                }
            });

        if (extras.length === 0) {
            return;
        }
        try {
            await grist.docApi.applyUserActions([['BulkRemoveRecord', TABLE_SCHOOLS, extras]]);
        } catch (error) {
            // L'autre widget les a sans doute déjà supprimées.
            console.info('[Années] Doublons déjà retirés :', (error && error.message) ? error.message : error);
        }
    }

    /**
     * Crée les lignes de l'année scolaire en cours si elle n'en a aucune.
     * @param {Object} [options]
     * @param {string} [options.year] année à garantir, par défaut l'année en cours
     * @returns {Promise<{created: number, year: string, sourceYear: string|null}>}
     */
    async function ensureYear(options) {
        const year = (options && options.year) || currentSchoolYear();
        const data = await grist.docApi.fetchTable(TABLE_SCHOOLS);
        const ids = column(data, 'id');
        const years = column(data, COL_YEAR).map(text);

        if (!(COL_YEAR in data)) {
            throw new Error(`La colonne « ${COL_YEAR} » est absente de la table ${TABLE_SCHOOLS}.`);
        }
        if (years.includes(year)) {
            return { created: 0, year, sourceYear: null };
        }

        const sourceYear = [...new Set(years)]
            .filter((value) => YEAR_PATTERN.test(value) && value < year)
            .sort()
            .pop() || null;

        if (!sourceYear) {
            return { created: 0, year, sourceYear: null };
        }

        const writable = await global.GristColumns.fetchDataColumnIds(TABLE_SCHOOLS);
        if (!writable) {
            throw new Error(`Colonnes de la table ${TABLE_SCHOOLS} illisibles.`);
        }

        const counts = new Set(COUNT_COLUMNS);
        const copied = writable.filter((colId) => colId !== COL_YEAR && !counts.has(colId) && colId in data);
        const emptied = writable.filter((colId) => counts.has(colId));
        const rows = ids.map((_, i) => i).filter((i) => years[i] === sourceYear);

        const values = {};
        for (const colId of copied) {
            values[colId] = rows.map((i) => data[colId][i]);
        }
        for (const colId of emptied) {
            values[colId] = rows.map(() => null);
        }
        values[COL_YEAR] = rows.map(() => year);

        try {
            await addYearChoice(year);
        } catch (error) {
            console.warn(`[Années] Impossible d'ajouter ${year} aux choix de ${COL_YEAR}.`, error);
        }

        await grist.docApi.applyUserActions([
            ['BulkAddRecord', TABLE_SCHOOLS, rows.map(() => null), values]
        ]);
        await removeDuplicates(year);

        return { created: rows.length, year, sourceYear };
    }

    /* ------------------------------------------------------------------
     * Index des écoles par année
     * ---------------------------------------------------------------- */

    /**
     * @param {Array<{id: number, uai: string, year: string}>} records lignes de
     *        la table Ecoles, enrichies librement par le widget
     * @returns {{
     *   byId: Map<number, Object>,
     *   years: string[],
     *   resolve: function(string, string): Object|null,
     *   schoolsFor: function(string): Object[]
     * }}
     */
    function buildIndex(records) {
        const byId = new Map();
        const byKey = new Map();
        const yearSet = new Set();

        for (const record of records) {
            record.key = schoolKey(record.uai, record.id);
            record.year = text(record.year);
            byId.set(record.id, record);
            if (record.year) {
                yearSet.add(record.year);
            }
            if (!byKey.has(record.key)) {
                byKey.set(record.key, []);
            }
            byKey.get(record.key).push(record);
        }

        for (const list of byKey.values()) {
            list.sort((a, b) => a.year.localeCompare(b.year) || a.id - b.id);
        }

        // Ligne d'une école pour une année :
        //  - la ligne de cette année si elle existe ;
        //  - aucune si l'année existe dans la table sans cette école (fermée,
        //    pas encore ouverte) ;
        //  - sinon, pour une année que la table ne connaît pas (antérieure à
        //    la colonne Annee, par exemple), la dernière ligne qui la précède,
        //    à défaut la plus ancienne.
        function resolve(key, year) {
            const list = byKey.get(key);
            if (!list) {
                return null;
            }
            if (!year || year === ALL_YEARS) {
                return list[list.length - 1];
            }
            const exact = list.find((record) => record.year === year);
            if (exact) {
                return exact;
            }
            if (yearSet.has(year)) {
                return null;
            }
            const before = list.filter((record) => record.year < year);
            return before.length > 0 ? before[before.length - 1] : list[0];
        }

        function schoolsFor(year) {
            const result = [];
            for (const key of byKey.keys()) {
                const record = resolve(key, year);
                if (record) {
                    result.push(record);
                }
            }
            return result;
        }

        return { byId, years: [...yearSet].sort(), resolve, schoolsFor };
    }

    global.SchoolYears = {
        ALL_YEARS,
        COUNT_COLUMNS,
        TABLE_SCHOOLS,
        currentSchoolYear,
        ensureYear,
        buildIndex
    };

})(typeof window !== 'undefined' ? window : this);
