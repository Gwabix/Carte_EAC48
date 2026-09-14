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
 * Services :
 *
 *  - ensureYear() : si l'année scolaire en cours n'a encore aucune ligne, duplique
 *    celles de l'année précédente, effectifs vidés. Les ouvertures et fermetures
 *    d'écoles se corrigent ensuite à la main dans Grist.
 *
 *  - findDuplicates() / mergeDuplicates() : repère et fusionne les lignes d'une
 *    même école (même UAI) pour une même année.
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

    /* ------------------------------------------------------------------
     * Doublons : même UAI, même année
     * ---------------------------------------------------------------- */

    function isFilled(value) {
        return value !== null && value !== undefined && value !== '';
    }

    // Groupes de lignes en double, relus dans la table. La ligne conservée est
    // celle de plus petit identifiant : deux widgets qui fusionnent en même
    // temps retiennent la même et convergent.
    //
    // Pour chaque effectif : une seule valeur renseignée (ou plusieurs
    // identiques) est retenue d'office ; des valeurs différentes forment un
    // conflit, à trancher par l'utilisateur. Les autres colonnes gardent la
    // valeur de la ligne conservée, complétée si elle est vide.
    function duplicateGroups(data, writable, onlyYear) {
        const ids = column(data, 'id');
        const uais = column(data, COL_UAI);
        const years = column(data, COL_YEAR);
        const byKey = new Map();

        ids.map((id, i) => ({ id: Number(id), i }))
            .sort((a, b) => a.id - b.id)
            .forEach(({ id, i }) => {
                const year = text(years[i]);
                if (!text(uais[i]) || (onlyYear && year !== onlyYear)) {
                    return;
                }
                const key = `${year}|${schoolKey(uais[i], id)}`;
                if (!byKey.has(key)) {
                    byKey.set(key, []);
                }
                byKey.get(key).push({ id, i });
            });

        const counts = new Set(COUNT_COLUMNS);
        const others = writable.filter((colId) => !counts.has(colId) && colId !== COL_UAI && colId !== COL_YEAR && colId in data);
        const groups = [];

        for (const [key, rows] of byKey) {
            if (rows.length < 2) {
                continue;
            }
            const [kept, ...removed] = rows;
            const resolved = {};
            const conflicts = [];

            for (const colId of COUNT_COLUMNS.filter((c) => c in data)) {
                const options = [];
                for (const { id, i } of rows) {
                    const value = data[colId][i];
                    if (isFilled(value) && !options.some((o) => o.value === value)) {
                        options.push({ rowId: id, value });
                    }
                }
                if (options.length === 1) {
                    resolved[colId] = options[0].value;
                } else if (options.length > 1) {
                    conflicts.push({ colId, options });
                }
            }

            for (const colId of others) {
                if (isFilled(data[colId][kept.i])) {
                    continue;
                }
                const donor = removed.find(({ i }) => isFilled(data[colId][i]));
                if (donor) {
                    resolved[colId] = data[colId][donor.i];
                }
            }

            groups.push({
                key,
                year: text(years[kept.i]),
                uai: text(uais[kept.i]),
                keepId: kept.id,
                removeIds: removed.map((r) => r.id),
                current: Object.fromEntries(Object.keys(resolved).concat(conflicts.map((c) => c.colId))
                    .map((colId) => [colId, data[colId][kept.i]])),
                resolved,
                conflicts
            });
        }
        return groups;
    }

    async function readDuplicates(onlyYear) {
        const data = await grist.docApi.fetchTable(TABLE_SCHOOLS);
        const writable = await global.GristColumns.fetchDataColumnIds(TABLE_SCHOOLS);
        return duplicateGroups(data, writable || [], onlyYear);
    }

    /**
     * Doublons de la table Ecoles (même UAI, même année), sans rien modifier.
     * @param {Object} [options]
     * @param {string} [options.year] limiter à une année
     * @returns {Promise<Array<{key: string, year: string, uai: string, keepId: number,
     *   removeIds: number[], conflicts: Array<{colId: string, options: Array<{rowId: number, value: *}>}>}>>}
     */
    async function findDuplicates(options) {
        return readDuplicates(options && options.year);
    }

    /**
     * Fusionne les doublons : effectifs retenus écrits sur la ligne conservée,
     * projets des lignes retirées rattachés à elle, lignes retirées supprimées.
     * Le tout en une seule action Grist.
     *
     * La table est relue au moment de fusionner : un groupe dont un conflit
     * n'a pas de choix valide (nouveau conflit, valeur modifiée entre-temps)
     * est laissé de côté et renvoyé dans `skipped`.
     *
     * @param {Object} [options]
     * @param {string} [options.year] limiter à une année
     * @param {Object<string, Object<string, *>>} [options.choices] par clé de
     *        groupe, la valeur retenue pour chaque effectif en conflit
     * @returns {Promise<{merged: number, removed: number, skipped: Array}>}
     */
    async function mergeDuplicates(options) {
        const choices = (options && options.choices) || {};
        const groups = await readDuplicates(options && options.year);
        const ready = [];
        const skipped = [];

        for (const group of groups) {
            const chosen = choices[group.key] || {};
            const unresolved = group.conflicts.filter((conflict) =>
                !Object.prototype.hasOwnProperty.call(chosen, conflict.colId)
                || !conflict.options.some((o) => o.value === chosen[conflict.colId]));
            if (unresolved.length > 0) {
                skipped.push(group);
                continue;
            }
            const fields = Object.assign({}, group.resolved);
            for (const conflict of group.conflicts) {
                fields[conflict.colId] = chosen[conflict.colId];
            }
            for (const colId of Object.keys(fields)) {
                if (fields[colId] === group.current[colId]) {
                    delete fields[colId];
                }
            }
            ready.push({ group, fields });
        }

        if (ready.length === 0) {
            return { merged: 0, removed: 0, skipped };
        }

        const target = new Map();
        for (const { group } of ready) {
            for (const id of group.removeIds) {
                target.set(id, group.keepId);
            }
        }

        const projects = await grist.docApi.fetchTable(TABLE_PROJECTS);
        const projectIds = [];
        const newRefs = [];
        column(projects, 'id').forEach((id, i) => {
            const ref = Number(column(projects, COL_UAI)[i]);
            if (target.has(ref)) {
                projectIds.push(Number(id));
                newRefs.push(target.get(ref));
            }
        });

        const actions = ready
            .filter(({ fields }) => Object.keys(fields).length > 0)
            .map(({ group, fields }) => ['UpdateRecord', TABLE_SCHOOLS, group.keepId, fields]);
        if (projectIds.length > 0) {
            actions.push(['BulkUpdateRecord', TABLE_PROJECTS, projectIds, { [COL_UAI]: newRefs }]);
        }
        actions.push(['BulkRemoveRecord', TABLE_SCHOOLS, [...target.keys()]]);

        await grist.docApi.applyUserActions(actions);
        return { merged: ready.length, removed: target.size, skipped };
    }

    // Deux widgets ouverts en même temps peuvent dupliquer chacun l'année.
    // Chacun fusionne ensuite les doublons de cette année ; les lignes créées
    // n'ayant aucun effectif, il n'y a jamais de conflit.
    async function removeDuplicates(year) {
        try {
            await mergeDuplicates({ year });
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
        buildIndex,
        findDuplicates,
        mergeDuplicates
    };

})(typeof window !== 'undefined' ? window : this);
